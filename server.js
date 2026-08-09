const express = require('express');
const cors = require('cors');
const { kv } = require('@vercel/kv'); // Подключаем базу данных Vercel KV / Upstash
const app = express();
const userReferrals = {}; // Кто кого пригласил { 'ID_нового_игрока': 'ID_пригласителя' }
const chatCooldowns = {}; // Время последнего сообщения игрока
const playerSpamCounts = {}; // Счетчик быстрых кликов игрока подряд
const playerMuteTimers = {}; // Время, до которого у игрока действует мут



app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));


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



// 3. Вступление игрока в клан (С жесткой защитой от создания призраков)
app.post('/api/clans/join', async (req, res) => {
    const { clanName, playerName, playerBalance, playerDogLvl } = req.body;
    let clans = await getClansFromDB();

    let clan = clans.find(c => c.name === clanName);
    
    // ЖЕСТКАЯ ЗАЩИТА: Если Лидер распустил клан, этого клана НЕТ в базе.
    // Мы возвращаем 404 ошибку и НЕ разрешаем коду создавать этот клан заново!
    if (!clan) {
        return res.status(404).json({ error: "Clan not found. It might have been disbanded by the leader." });
    }

    // Проверяем, есть ли уже этот пилот в списке участников
    const existingIndex = clan.membersList.findIndex(m => m.name === playerName);
    
    if (existingIndex !== -1) {
        // Если игрок уже числится, обновляем его параметры
        const oldBalance = Number(clan.membersList[existingIndex].balance) || 0;
        clan.bank = Math.max(0, (Number(clan.bank) || 0) - oldBalance + Number(playerBalance));
        
        clan.membersList[existingIndex].balance = Number(playerBalance);
        clan.membersList[existingIndex].dogLvl = Number(playerDogLvl);
        
        await saveClansToDB(clans);
        return res.json({ success: true, clans: clans });
    }

    if (clan.members >= 50) return res.status(400).json({ error: "The clan is full" });

    // Если игрока нет в клане — добавляем как нового пилота
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


// 4. Полный и гарантированный роспуск клана Лидером под ноль
app.post('/api/clans/leave', async (req, res) => {
    const { clanName, playerName, playerBalance } = req.body;
    let clans = await getClansFromDB();

    let clanIndex = clans.findIndex(c => c.name === clanName);
    if (clanIndex !== -1) {
        let clan = clans[clanIndex];

        const cleanPlayerName = String(playerName).trim().toLowerCase();
        const cleanCreatorName = String(clan.creator).trim().toLowerCase();

        // Если выходит Создатель ИЛИ если это последний человек в клане — СТИРАЕМ КЛАН ПОД НОЛЬ
        if (cleanPlayerName === cleanCreatorName || clan.members <= 1 || clan.membersList.length <= 1) {
            clans.splice(clanIndex, 1);
        } else {
            // Если выходит обычный пилот (клан не удаляется)
            if (clan.membersList && Array.isArray(clan.membersList)) {
                clan.membersList = clan.membersList.filter(m => String(m.name).trim().toLowerCase() !== cleanPlayerName);
            }
            clan.members = clan.membersList.length;
            clan.bank = Math.max(0, (Number(clan.bank) || 0) - (Number(playerBalance) || 0));
        }
    }

    await saveClansToDB(clans); // Записываем очищенную базу в Vercel KV / Upstash
    res.json({ success: true, clans: clans });
});



// 5. Отправка сообщений в чат с жесткой блокировкой ссылок (Ваш оригинальный код сервера)
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

    // --- ЖЕСТКАЯ ПРОВЕРКА НА ЛЮБЫЕ ССЫЛКИ И РЕКЛАМУ САЙТОВ/ТЕЛЕГРАМА ---
    const urlRegex = /(https?:\/\/[^\s]+)|(www\.[^\s]+)|([a-zA-Z0-9-]+\.[a-zA-Z]{2,}\b([-a-zA-Z0-9@:%_\+.~#?&//=]*))|(t\.me\/[^\s]+)/gi;
    if (urlRegex.test(text)) {
        return res.status(400).json({ error: "Sending links or website URLs is strictly prohibited!" });
    }

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



// Эндпоинт для генерации платежной ссылки Telegram Stars
app.post('/api/create-stars-invoice', async (req, res) => {
    const { type, cost, initData } = req.body;

    // Переменная окружения для токена вашего бота (задается в панели хостинга Vercel)
    const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN; 

    // Если игра открыта в обычном браузере на ПК для теста (нет данных initData от Telegram)
    if (!initData) {
        return res.json({
            success: true,
            isTestBrowser: true
        });
    }

    try {
        const title = type === 'dog' ? "Space Dogs: Dog Case" : "Space Dogs: Rocket Case";
        const description = `Opening 1x random ${type} upgrade chest.`;
        const payload = JSON.stringify({ type, timestamp: Date.now() }); 
        const provider_token = ""; // Для Telegram Stars этот параметр ОБЯЗАТЕЛЬНО должен быть пустой строкой
        const currency = "XTR"; // Официальный код валюты Telegram Stars

        const prices = [{ label: title, amount: Number(cost) }]; // Стоимость (250 или 500)

        // Делаем официальный запрос к серверам Telegram для создания ссылки на оплату
        const tgResponse = await fetch(`https://telegram.org{TELEGRAM_BOT_TOKEN}/createInvoiceLink`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title, description, payload, provider_token, currency, prices
            })
        });

        const tgData = await tgResponse.json();

        if (!tgData.ok) {
            console.error("Ошибка Telegram Bot API:", tgData);
            return res.status(500).json({ error: "Failed to create Telegram Stars invoice link." });
        }

        // Возвращаем готовую платежную ссылку обратно на фронтенд
        res.json({
            success: true,
            invoiceLink: tgData.result // Ссылка формата https://t.me...
        });

    } catch (e) {
        console.error("Ошибка генерации инвойса:", e);
        res.status(500).json({ error: "Internal server error during payment checkout." });
    }
});

// Фоновая синхронизация баланса игрока в реальном времени (игра/магазин)
app.post('/api/clans/sync-balance', async (req, res) => {
    const { clanName, playerName, playerBalance, playerDogLvl } = req.body;
    let clans = await getClansFromDB();

    let clan = clans.find(c => c.name === clanName);
    if (!clan) {
        return res.status(404).json({ error: "Clan not found" });
    }

    // Ищем игрока в списке участников клана
    const memberIndex = clan.membersList.findIndex(m => m.name === playerName);

    if (memberIndex !== -1) {
        // Запоминаем старый баланс игрока, чтобы правильно пересчитать общий банк клана
        const oldBalance = Number(clan.membersList[memberIndex].balance) || 0;
        
        // Обновляем банк клана: вычитаем старый баланс и прибавляем новый
        clan.bank = Math.max(0, (Number(clan.bank) || 0) - oldBalance + Number(playerBalance));

        // Обновляем данные самого игрока в списке
        clan.membersList[memberIndex].balance = Number(playerBalance);
        clan.membersList[memberIndex].dogLvl = Number(playerDogLvl);

        // Сохраняем обновленные данные в базу Vercel KV
        await saveClansToDB(clans);
    }

    res.json({ success: true, clans: clans });
});
// ========================================================
//   БЭКЕНД: ОБРАБОТКА ОДНОРАЗОВЫХ ЗАДАНИЙ (EARN TASKS)
// ========================================================

// 1. Валидация подписки на Telegram-канал через Bot API
app.post('/api/tasks/check-telegram', async (req, res) => {
    const { initData } = req.body;
    const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    
    // Сюда впишите ID вашего Telegram-канала (обязательно с минусом, например: -100123456789)
    // Либо его публичный юзернейм в формате "@имя_канала"
    const CHANNEL_ID = "@spacedogoff"; 

    if (!TELEGRAM_BOT_TOKEN) {
        return res.status(500).json({ error: "Bot token not configured on server." });
    }

    try {
        // Парсим initData, чтобы узнать реальный Telegram ID игрока
        const params = new URLSearchParams(initData);
        const userParam = params.get('user');
        if (!userParam) return res.status(400).json({ error: "Invalid Telegram user data." });

        const userData = JSON.parse(userParam);
        const userId = userData.id; // Получили чистый ID пользователя в Telegram

        // Делаем официальный запрос к Telegram, чтобы узнать статус юзера в канале
        const tgRes = await fetch(`https://telegram.org{TELEGRAM_BOT_TOKEN}/getChatMember`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: CHANNEL_ID,
                user_id: userId
            })
        });

        const tgData = await tgRes.json();

        if (!tgData.ok) {
            console.error("Ошибка проверки канала:", tgData);
            return res.json({ isMember: false, error: "Channel or bot setup issue." });
        }

        // Допустимые статусы, при которых человек считается подписанным
        const validStatuses = ['member', 'administrator', 'creator'];
        const userStatus = tgData.result.status;

        if (validStatuses.includes(userStatus)) {
            return res.json({ isMember: true });
        } else {
            return res.json({ isMember: false });
        }

    } catch (e) {
        console.error("Ошибка в роуте проверки канала:", e);
        res.status(500).json({ error: "Internal server verification error." });
    }
});

// 2. Безопасная сверка секретного слова (Daily Video Code)
app.post('/api/tasks/verify-code', async (req, res) => {
    const { code } = req.body;

    // Сюда вы вписываете правильное секретное слово текущего дня (обязательно КАПСОМ!)
    const REAL_DAILY_CODE = "SPACE"; 

    if (!code) {
        return res.status(400).json({ error: "Code is required" });
    }

    // Сверяем то, что ввел юзер, с правильным ответом
    if (code.trim().toUpperCase() === REAL_DAILY_CODE) {
        return res.json({ success: true });
    } else {
        return res.status(400).json({ success: false, error: "Incorrect secret code! Watch the video carefully." });
    }
});
// Роут, который должен вызываться при самом первом старте игры пользователем
app.post('/api/user/init', async (req, res) => {
    const { initData } = req.body;
    try {
        const params = new URLSearchParams(initData);
        const userParam = params.get('user');
        const startAppParam = params.get('start_param'); // Telegram передает сюда ref_ID из ссылки
        
        if (!userParam) return res.status(400).json({ error: "Invalid data" });
        
        const userData = JSON.parse(userParam);
        const currentUserId = String(userData.id);

        // ПРОВЕРКА РЕФЕРАЛА: Если игрок зашел по ссылке друга и его еще нет в нашей базе рефералов
        if (startAppParam && startAppParam.startsWith('ref_') && !userReferrals[currentUserId]) {
            const inviterId = startAppParam.replace('ref_', ''); // Извлекаем ID того, кто пригласил
            
            // Защита от самоприглашения
            if (inviterId !== currentUserId) {
                userReferrals[currentUserId] = inviterId; // Записываем, что этот юзер — реферал друга
                console.log(`Игрок ${currentUserId} стал рефералом пользователя ${inviterId}`);
            }
        }

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Эндпоинт проверки количества приглашенных друзей
app.post('/api/tasks/check-friends', async (req, res) => {
    const { initData } = req.body;
    try {
        const params = new URLSearchParams(initData);
        const userParam = params.get('user');
        if (!userParam) return res.status(400).json({ error: "Invalid data" });

        const userData = JSON.parse(userParam);
        const myUserId = String(userData.id);

        // Считаем, сколько раз наш ID встречается в роли пригласителя
        let count = 0;
        for (let key in userReferrals) {
            if (userReferrals[key] === myUserId) {
                count++;
            }
        }

        res.json({ friendsCount: count });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Эндпоинт фиксации выдачи награды за 3-х друзей
app.post('/api/tasks/claim-friends-reward', async (req, res) => {
    const { initData } = req.body;
    // Здесь вы можете привязать начисление кейса в базу данных Vercel KV, 
    // аналогично тому, как мы делали это на клиенте.
    res.json({ success: true });
});
// ====== ИНТЕГРАЦИЯ ТЕЛЕГРАМ-БОТА С АВТО-ВЕБХУКОМ ======
const { Telegraf, Markup } = require('telegraf');

const BOT_TOKEN = '8922456816:AAF5aQWspqjYyvxXJd8k94KCUzds_x-4qE4'; 
const bot = new Telegraf(BOT_TOKEN);

const GAME_URL = 'https://space-dogs-two.vercel.app/'; 
const CHANNEL_URL = 'https://t.me/spacedogoff'; 

bot.start((ctx) => {
    const welcomeText = 
        `Welcome to Space Dogs! 🚀🐾\n\n` +
        `Launch rockets, upgrade your dogs, open cases, and build the ultimate Space Clan.\n\n` +
        `Tap "start flight" to start your journey! 👇`;

    ctx.reply(welcomeText, 
        Markup.inlineKeyboard([
            [Markup.button.webApp('🚀Space Dogs🚀', GAME_URL)],
            [Markup.button.url('Subscribe to official channel', CHANNEL_URL)]
        ])
    );
});

// Настройка вебхука для Vercel Serverless
app.use(bot.webhookCallback('/api/telegram-bot'));

// СЕКРЕТНЫЙ АВТО-ПИНОК: Сервер Vercel сам свяжется с Telegram без твоего браузера
const BACKEND_URL = 'https://vercel.app';
fetch(`https://telegram.org{BOT_TOKEN}/setWebhook?url=${BACKEND_URL}/api/telegram-bot`)
    .then(() => console.log("Вебхук бота успешно настроен сервером!"))
    .catch((err) => console.error("Ошибка авто-вебхука:", err.message));
// ======================================================

// Экспортируем приложение для корректной работы Serverless функций Vercel
module.exports = app;
