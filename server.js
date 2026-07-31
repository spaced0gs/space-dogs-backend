const express = require('express');
const cors = require('cors');
const { kv } = require('@vercel/kv'); // Подключаем базу данных Vercel KV / Upstash
const app = express();

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

// 2. Создание нового клана с международным фильтром мата в названии
app.post('/api/clans/create', async (req, res) => {
    const { logo, name, reqLvl, balance, creatorName } = req.body;
    let clans = await getClansFromDB();

    const normalName = name.trim();
    const leaderName = creatorName || "Space_Pilot";

    // Базовый список запрещенных терминов и символов
    const forbiddenSymbols = ["[censored_term_1]", "[censored_term_2]", "[censored_symbol_1]"];

    // Список международных матов (Английский, Испанский, Хинди, Немецкий и др.)
    const foreignBadWords = [
        "[profanity_en_1]", "[profanity_en_2]", "[profanity_hi_1]", "[profanity_es_1]", "[profanity_de_1]"
    ];

    // Регулярное выражение для фильтрации нецензурной лексики
    const customRussianRegex = /([а-яё]*[корень_мата_1][а-яё]*|[а-яё]*[корень_мата_2][а-яё]*)/gi;

    const lowerText = normalName.toLowerCase();

    // Проверка на наличие мата
    let hasBad = customRussianRegex.test(lowerText);
    
    // Проверка запрещенных символов
    if (!hasBad) {
        hasBad = forbiddenSymbols.some(word => lowerText.includes(word));
    }
    
    // Проверка иностранных матов строго по границам слов
    if (!hasBad) {
        hasBad = foreignBadWords.some(word => {
            const regex = new RegExp(`\\b${word}\\b`, 'gi');
            return regex.test(lowerText);
        });
    }

    if (hasBad) {
        return res.status(400).json({ error: "Inappropriate language in the clan name is not allowed!" });
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

// 5. Отправка сообщений в клановый чат с фильтром
app.post('/api/clans/message', async (req, res) => {
    const { clanName, sender, text, time } = req.body;
    let clans = await getClansFromDB();

    let clan = clans.find(c => c.name === clanName);
    if (clan) {
        if (!clan.messages) clan.messages = [];

        let filteredText = text;

        const forbiddenSymbols = ["[censored_term_1]", "[censored_term_2]"];
        const foreignBadWords = ["[profanity_1]", "[profanity_2]"];
        const customRussianRegex = /([а-яё]*[корень_мата_1][а-яё]*)/gi;

        // Запикиваем мат
        filteredText = filteredText.replace(customRussianRegex, (match) => '*'.repeat(match.length));

        // Запикиваем запрещенные символы
        forbiddenSymbols.forEach(word => {
            const regex = new RegExp(word, 'gi');
            filteredText = filteredText.replace(regex, (match) => '*'.repeat(match.length));
        });

        // Запикиваем международные маты строго по границам слов
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
    } else {
        res.status(404).json({ error: "Clan not found" });
    }
});



// Экспортируем приложение для корректной работы Serverless функций Vercel
module.exports = app;
