const express = require('express');
const cors = require('cors');
const { kv } = require('@vercel/kv'); // Подключаем базу данных Vercel KV / Upstash
const app = express();
const chatCooldowns = {}; // Время последнего сообщения игрока
const playerSpamCounts = {}; // Счетчик быстрых кликов игрока подряд
const playerMuteTimers = {}; // Время, до которого у игрока действует мут



app.use(cors({ origin: '*' }));
app.use(express.json());

async function getClansFromDB() {
    try {
        const clans = await kv.get('space_dogs_clans');
        return clans && Array.isArray(clans) ? clans : [];
    } catch (e) {
        console.error("Ошибка чтения из базы данных:", e);
        return [];
    }
}

async function saveClansToDB(clans) {
    try {
        await kv.set('space_dogs_clans', clans);
    } catch (e) {
        console.error("Ошибка записи в базу данных:", e);
    }
}

// 1. Получение списка всех кланов
app.get('/api/clans', async (req, res) => {
    const clans = await getClansFromDB();
    res.json(clans);
});

// 2. Создание нового клана с международным фильтром мата и свастик
app.post('/api/clans/create', async (req, res) => {
    const { logo, name, reqLvl, balance, creatorName } = req.body;
    let clans = await getClansFromDB();

    const normalName = name.trim();
    const leaderName = creatorName || "Space_Pilot";

    // Сверхжесткий список запрещенных слов, нацизма и расизма
    const forbiddenSymbols = [
        "негр", "хохол", "жид", "чурка", "хач", "нацист", "фашист", "nigger", "nigga", "chink", "retard",
        "卐", "卍", "ss", "сс", "нацизм", "гитлер", "hitler", "swastika", "свастика", "卐", "卍", "🖾", "✠", "✙"
    ];

    // База международных матов (Английский, Хинди, Испанский, Немецкий)
    const foreignBadWords = [
        "fuck", "fucking", "fucker", "bitch", "shit", "asshole", "cunt", "dick", "pussy", "whore", "slut", "faggot", "bastard",
        "bhenchod", "benchod", "madarchod", "gand", "gandu", "chutiya", "mierda", "puta", "puto", "maricon", "cabron", "joder",
        "scheisse", "fotze", "schlampe"
    ];

    // Мощное регулярное выражение для проверки РУССКИХ матерных корней
    const customRussianRegex = /([а-яё]*хуй[а-яё]*|[а-яё]*хуи[а-яё]*|[а-яё]*хуе[а-яё]*|[а-яё]*хул[а-яё]*|[а-яё]*пизд[а-яё]*|[а-яё]*еб[а-яё]*|[а-яё]*ёб[а-яё]*|[а-яё]*бл[яе]д[а-яё]*|[а-яё]*бл[яе]т[а-яё]*|[а-яё]*пид[оа]р[а-яё]*|[а-яё]*гондо[а-яё]*|[а-яё]*ганд[оа]н[а-яё]*|[а-яё]*манда[а-яё]*|[а-яё]*шалав[а-яё]*|[а-яё]*шлюх[а-яё]*)/gi;

    const lowerText = normalName.toLowerCase();

    // 1. Проверка на русский мат
    let hasBad = customRussianRegex.test(lowerText);
    
    // 2. Проверка на нацистские символы и оскорбления
    if (!hasBad) {
        hasBad = forbiddenSymbols.some(word => lowerText.includes(word));
    }
    
    // 3. Проверка на иностранный мат
    if (!hasBad) {
        hasBad = foreignBadWords.some(word => {
            const regex = new RegExp(`\\b${word}\\b`, 'gi');
            return regex.test(lowerText);
        });
    }

    // Если нашли хоть одно совпадение — жестко блокируем создание клана
    if (hasBad) {
        return res.status(400).json({ error: "Inappropriate language or symbols in the clan name are not allowed!" });
    }

    if (clans.some(c => c.name.toLowerCase() === normalName.toLowerCase())) {
        return res.status(400).json({ error: "A clan with that name already exists!" });
    }

    const newClan = {
        logo: logo || "🚀",
        name: normalName,
        req: Number(reqLvl) || 0,
        creator: leaderName,
        members: 1,
        bank: Number(balance) || 0,
        membersList: [
            { name: leaderName, balance: Number(balance), dogLvl: Number(reqLvl) }
        ],
        messages: [{ sender: "SYSTEM", text: `🚀 Клан "${normalName}" успешно создан!`, time: "" }]
    };

    clans.unshift(newClan);
    await saveClansToDB(clans);
    res.json({ success: true, clans: clans });
});



// 3. Вступление игрока в клан
app.post('/api/clans/join', async (req, res) => {
    const { clanName, playerName, playerBalance, playerDogLvl } = req.body;
    let clans = await getClansFromDB();

    let clan = clans.find(c => c.name === clanName);
    if (!clan) return res.status(404).json({ error: "Clan not found" });

    // Проверяем, есть ли уже этот пилот в списке участников
    const existingIndex = clan.membersList.findIndex(m => m.name === playerName);
    
    if (existingIndex !== -1) {
        // Если игрок уже числится, пересчитываем разницу в банке и обновляем его параметры
        const oldBalance = Number(clan.membersList[existingIndex].balance) || 0;
        clan.bank = Math.max(0, (Number(clan.bank) || 0) - oldBalance + Number(playerBalance));
        
        clan.membersList[existingIndex].balance = Number(playerBalance);
        clan.membersList[existingIndex].dogLvl = Number(playerDogLvl);
        
        await saveClansToDB(clans);
        return res.json({ success: true, clans: clans });
    }

    if (clan.members >= 50) return res.status(400).json({ error: "The clan is full" });

    // Если игрока нет в клане — добавляем как нового пилота и плюсуем банк
    clan.bank = (Number(clan.bank) || 0) + Number(playerBalance);
    clan.members++;
    
    clan.membersList.push({
        name: playerName,
        balance: Number(playerBalance),
        dogLvl: Number(playerDogLvl)
    });
    
    clan.messages.push({ sender: "SYSTEM", text: `🚪 Пилот ${playerName} присоединился к клану.`, time: "" });

    await saveClansToDB(clans);
    res.json({ success: true, clans: clans });
});

// 4. Выход игрока / удаление клана Лидером
app.post('/api/clans/leave', async (req, res) => {
    const { clanName, playerName, playerBalance } = req.body;
    let clans = await getClansFromDB();

    let clanIndex = clans.findIndex(c => c.name === clanName);
    if (clanIndex !== -1) {
        let clan = clans[clanIndex];

        // ЕСЛИ ИЗ КЛАНА ВЫХОДИТ ЕГО СЕО/ЛИДЕР (СОЗДАТЕЛЬ) — клан полностью распускается и удаляется
        if (clan.creator === playerName) {
            clans.splice(clanIndex, 1);
        } else {
            // ЕСЛИ ВЫХОДИТ ОБЫЧНЫЙ ИГРОК
            // 1. Его баланс строго вычитается из общего банка клана
            clan.bank = Math.max(0, (Number(clan.bank) || 0) - (Number(playerBalance) || 0));
            clan.members--;
            
            // 2. Игрок полностью удаляется из массива, чтобы исчезнуть из вкладки MEMBERS
            clan.membersList = clan.membersList.filter(m => m.name !== playerName);
            
            clan.messages.push({ sender: "SYSTEM", text: `🚪 Пилот ${playerName} покинул расположение клана.`, time: "" });
        }
    }

    await saveClansToDB(clans); // Записываем обновленные данные в базу KV
    res.json({ success: true, clans: clans });
});

// 5. Отправка сообщений в чат с прогрессивной защитой от флуда и мутом на 5 минут
app.post('/api/clans/message', async (req, res) => {
    const { clanName, sender, text, time } = req.body;
    let clans = await getClansFromDB();

    let clan = clans.find(c => c.name === clanName);
    if (!clan) return res.status(404).json({ error: "Clan not found" });

    const now = Date.now();
    const playerKey = `${clanName}_${sender}`;

    // --- 1. ПРОВЕРКА ДЕЙСТВУЮЩЕГО МУТА ---
    if (playerMuteTimers[playerKey] && now < playerMuteTimers[playerKey]) {
        const remainingMs = playerMuteTimers[playerKey] - now;
        const remainingMin = Math.ceil(remainingMs / 60000); // Округляем до минут в большую сторону
        return res.status(423).json({ error: `You are muted for spamming! Try again in ${remainingMin} min.` });
    }
    // --------------------------------------

    // --- 2. КОНТРОЛЬ СКОРОСТИ И СЧЕТЧИК СПАМА ---
    if (!playerSpamCounts[playerKey]) playerSpamCounts[playerKey] = 0;

    if (chatCooldowns[playerKey] && (now - chatCooldowns[playerKey] < 2000)) {
        // Игрок кликнул быстрее чем через 2 секунды — плюсуем нарушение
        playerSpamCounts[playerKey]++;
        chatCooldowns[playerKey] = now; // Сбрасываем таймер на текущий момент

        // Если это 3-е быстрое сообщение подряд — вешаем мут на 5 минут
        if (playerSpamCounts[playerKey] >= 3) {
            playerMuteTimers[playerKey] = now + (5 * 60 * 1000); // Текущее время + 5 минут
            playerSpamCounts[playerKey] = 0; // Сбрасываем счетчик кликов
            return res.status(423).json({ error: "You have been muted for 5 minutes for aggressive spamming!" });
        }

        // Если кликов меньше трех — выдаем обычное предупреждение
        return res.status(429).json({ error: "Slow down! Don't spam the chat." });
    }

    // Если игрок отправил сообщение вовремя (с паузой > 2 сек) — обнуляем его счетчик нарушений
    playerSpamCounts[playerKey] = 0;
    chatCooldowns[playerKey] = now;
    // ------------------------------------------

    if (!clan.messages) clan.messages = [];

    let filteredText = text;

    // Сверхжесткий список нацистских символов и оскорблений
    const forbiddenSymbols = [
        "негр", "хохол", "жид", "чурка", "хач", "нацист", "фашист", "nigger", "nigga", "chink", "retard",
        "卐", "卍", "🖾", "✠", "✙", "ss", "сс", "нацизм", "гитлер", "hitler", "swastika", "свастика"
    ];

    // Список международных матов
    const foreignBadWords = [
        "fuck", "fucking", "fucker", "bitch", "shit", "asshole", "cunt", "dick", "pussy", "whore", "slut", "faggot", "bastard",
        "bhenchod", "benchod", "madarchod", "gand", "gandu", "chutiya", "mierda", "puta", "puto", "maricon", "cabron", "joder"
    ];

    // Регулярное выражение для русского мата
    const customRussianRegex = /([а-яё]*хуй[а-яё]*|[а-яё]*хуи[а-яё]*|[а-яё]*хуе[а-яё]*|[а-яё]*хул[а-яё]*|[а-яё]*пизд[а-яё]*|[а-яё]*еб[а-яё]*|[а-яё]*ёб[а-яё]*|[а-яё]*бл[яе]д[а-яё]*|[а-яё]*бл[яе]т[а-яё]*|[а-яё]*пид[оа]р[а-яё]*|[а-яё]*гондо[а-яё]*|[а-яё]*ганд[оа]н[а-яё]*|[а-яё]*манда[а-яё]*|[а-яё]*шалав[а-яё]*|[а-яё]*шлюх[а-яё]*)/gi;

    filteredText = filteredText.replace(customRussianRegex, (match) => '*'.repeat(match.length));

    forbiddenSymbols.forEach(word => {
        const regex = new RegExp(word, 'gi');
        filteredText = filteredText.replace(regex, (match) => '*'.repeat(match.length));
    });

    foreignBadWords.forEach(word => {
        const regex = new RegExp(`\\b${word}\\b`, 'gi');
        filteredText = filteredText.replace(regex, (match) => '*'.repeat(match.length));
    });

    clan.messages.push({ sender, text: filteredText, time });
    
    if (clan.messages.length > 40) {
        clan.messages.shift();
    }
    
    await saveClansToDB(clans);
    res.json({ success: true, clans: clans });
});




// Экспортируем приложение для корректной работы Serverless функций Vercel
module.exports = app;
