const express = require('express');
const cors = require('cors');
const { kv } = require('@vercel/kv'); // Подключаем вечную базу данных Vercel KV / Upstash
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

app.get('/api/clans', async (req, res) => {
    const clans = await getClansFromDB();
    res.json(clans);
});

app.post('/api/clans/create', async (req, res) => {
    const { logo, name, reqLvl, balance, creatorName } = req.body;
    let clans = await getClansFromDB();

    // Проверяем, чтобы не было кланов с одинаковым именем
    if (clans.some(c => c.name.toLowerCase() === name.toLowerCase())) {
        return res.status(400).json({ error: "A clan with that name already exists!" });
    }

    // Создаем структуру нового клана и четко записываем, кто его Лидер (creator)
    const newClan = {
        logo: logo || "🚀",
        name: name,
        req: Number(reqLvl) || 0,
        creator: creatorName || "Space_Pilot", // Фиксируем имя Лидера, чтобы потом распустить клан при его выходе
        members: 1,
        bank: Number(balance) || 0, // Баланс лидера сразу добавляется в общий банк клана
        membersList: [
            { name: creatorName || "Space_Pilot", balance: Number(balance), dogLvl: Number(reqLvl) }
        ],
        messages: [{ sender: "SYSTEM", text: `🚀 Клан "${name}" успешно создан!`, time: "" }]
    };

    clans.unshift(newClan); // Добавляем в начало списка
    await saveClansToDB(clans); // Сохраняем в вечную базу Upstash
    res.json({ success: true, clans: clans });
});

app.post('/api/clans/join', async (req, res) => {
    const { clanName, playerName, playerBalance, playerDogLvl } = req.body;
    let clans = await getClansFromDB();

    let clan = clans.find(c => c.name === clanName);
    if (!clan) return res.status(404).json({ error: "Clan not found" });

    // 🔥 ЗАЩИТА: Проверяем, есть ли уже этот пилот в клане
    const existingMember = clan.membersList.find(m => m.name === playerName);
    
    if (existingMember) {
        // Если он уже в списке, мы НЕ выдаем ошибку, а просто обновляем данные и впускаем его!
        existingMember.balance = Number(playerBalance);
        existingMember.dogLvl = Number(playerDogLvl);
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

app.post('/api/clans/leave', async (req, res) => {
    const { clanName, playerName, playerBalance } = req.body;
    let clans = await getClansFromDB();

    let clanIndex = clans.findIndex(c => c.name === clanName);
    if (clanIndex !== -1) {
        let clan = clans[clanIndex];

        // 🔥 ЕСЛИ ИЗ КЛАНА ВЫХОДИТ ЕГО ЛИДЕР (СОЗДАТЕЛЬ)
        if (clan.creator === playerName) {
            clans.splice(clanIndex, 1); // Клан полностью удаляется с сервера и распускается
        } else {
            // 🔥 ЕСЛИ ВЫХОДИТ ОБЫЧНЫЙ ИГРОК
            // 1. Его баланс строго вычитается из общего банка клана
            clan.bank = Math.max(0, (Number(clan.bank) || 0) - Number(playerBalance));
            clan.members--;
            
            // 2. Игрок полностью удаляется из массива (он сразу исчезнет из вкладки MEMBERS)
            clan.membersList = clan.membersList.filter(m => m.name !== playerName);
            
            clan.messages.push({ sender: "SYSTEM", text: `🚪 Пилот ${playerName} покинул расположение клана.`, time: "" });
        }
    }

    await saveClansToDB(clans); // Записываем обновленные данные в базу
    res.json({ success: true, clans: clans });
});

// Экспортируем приложение для корректной работы Serverless функций Vercel
module.exports = app;

