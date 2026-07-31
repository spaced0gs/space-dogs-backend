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

// 2. Создание нового клана
app.post('/api/clans/create', async (req, res) => {
    const { logo, name, reqLvl, balance, creatorName } = req.body;
    let clans = await getClansFromDB();

    const normalName = name.trim();
    const leaderName = creatorName || "Space_Pilot";

    // Проверяем, чтобы не было кланов с одинаковым именем
    if (clans.some(c => c.name.toLowerCase() === normalName.toLowerCase())) {
        return res.status(400).json({ error: "A clan with that name already exists!" });
    }

    // Создаем структуру нового клана и четко записываем, кто его Лидер (creator)
    const newClan = {
        logo: logo || "🚀",
        name: normalName,
        req: Number(reqLvl) || 0,
        creator: leaderName, // Фиксируем имя Лидера, чтобы потом распустить клан при его выходе
        members: 1,
        bank: Number(balance) || 0, // Баланс лидера сразу добавляется в общий банк клана
        membersList: [
            { name: leaderName, balance: Number(balance), dogLvl: Number(reqLvl) }
        ],
        messages: [{ sender: "SYSTEM", text: `🚀 Клан "${normalName}" успешно создан!`, time: "" }]
    };

    clans.unshift(newClan); // Добавляем в начало списка
    await saveClansToDB(clans); // Сохраняем в базу
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

// 5. Отправка сообщений в клановый чат с продвинутым фильтром всех матов и символики
app.post('/api/clans/message', async (req, res) => {
    const { clanName, sender, text, time } = req.body;
    let clans = await getClansFromDB();

    let clan = clans.find(c => c.name === clanName);
    if (clan) {
        if (!clan.messages) clan.messages = [];

        let filteredText = text;

        // 1. Усиленный фильтр нацистской и расистской символики / оскорблений
        const badWords = [
            "негр", "хохол", "жид", "чурка", "хач", "нацист", "фашист",
            "卐", "卍", "ss", "сс"
        ];

        badWords.forEach(word => {
            const regex = new RegExp(word, 'gi');
            filteredText = filteredText.replace(regex, (match) => '*'.repeat(match.length));
        });

        // 2. Мощное регулярное выражение (Regex), которое ловит ВСЕ формы основных матерных корней
        // Ловит: хуй, хули, пизда, пиздец, блядь, блять, ебать, еблан, охуел, нихуя, пидор, уебок и т.д.
        // со всеми возможными приставками (по-, на-, при-, вы-, о-, за-) и любыми окончаниями (-ами, -ешь, -ому)
        const cenzorRegex = /([а-яё]*хуй[а-яё]*|[а-яё]*хуи[а-яё]*|[а-яё]*хуе[а-яё]*|[а-яё]*хул[а-яё]*|[а-яё]*пизд[а-яё]*|[а-яё]*еб[а-яё]*|[а-яё]*ёб[а-яё]*|[а-яё]*бл[яе]д[а-яё]*|[а-яё]*бл[яе]т[а-яё]*|[а-яё]*пид[оа]р[а-яё]*|[а-яё]*гондо[а-яё]*|[а-яё]*ганд[оа]н[а-яё]*|[а-яё]*манда[а-яё]*|[а-яё]*шалав[а-яё]*|[а-яё]*шлюх[а-яё]*)/gi;

        filteredText = filteredText.replace(cenzorRegex, (match) => '*'.repeat(match.length));

        // Записываем очищенный текст в базу данных
        clan.messages.push({ sender, text: filteredText, time });
        
        // Лимит истории чата — храним только последние 40 сообщений
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
