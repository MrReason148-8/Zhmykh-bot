const telegram = require('node-telegram-bot-api');
const storage = require('../services/storage');
const ai = require('../services/ai');
const config = require('../config');
const axios = require('axios');
const { exec } = require('child_process');
const chatHistory = {};
const analysisBuffers = {};
const messageCounter = {}; // Счетчик сообщений для спонтанных мыслей
const BUFFER_SIZE = 20;

// Кэш для хранения временных данных
const tempCache = {
  // Кэш для хранения количества сообщений от пользователей (для антиспама)
  messageCounts: {},
  // Время последнего сообщения от пользователя (для антифлуда)
  lastMessageTimes: {},
  // Кэш для хранения последних действий пользователей
  userActions: {}
};

// Утилиты для работы с кармой
const karmaUtils = {
  // Получение уровня кармы
  getKarmaLevel: (score) => {
    if (score <= 20) return 'enemy';
    if (score <= 40) return 'cold';
    if (score <= 60) return 'neutral';
    if (score <= 80) return 'friendly';
    return 'brother';
  },

  // Получение настроек кармы
  getKarmaSettings: (level) => {
    return config.karma.levels[level] || config.karma.levels.neutral;
  },

  // Обновление кармы пользователя
  updateKarma: (chatId, userId, change, reason = '') => {
    try {
      const profile = storage.getProfile(chatId, userId);
      const oldLevel = karmaUtils.getKarmaLevel(profile.relationship);
      
      // Применяем изменение с учетом модификаторов
      let karmaChange = change;
      if (profile.relationship >= 80) {
        karmaChange = Math.round(change * config.karma.changes.modifiers.highKarma);
      } else if (profile.relationship <= 20) {
        karmaChange = Math.round(change * config.karma.changes.modifiers.lowKarma);
      }
      
      // Обновляем рейтинг с ограничениями min/max
      profile.relationship = Math.max(
        config.karma.min,
        Math.min(config.karma.max, profile.relationship + karmaChange)
      );
      
      // Проверяем, изменился ли уровень кармы
      const newLevel = karmaUtils.getKarmaLevel(profile.relationship);
      
      // Сохраняем изменения
      storage.bulkUpdateProfiles(chatId, { [userId]: { relationship: profile.relationship } });
      
      // Логируем изменение
      console.log(`[KARMA] User ${userId} in chat ${chatId}: ${change > 0 ? '+' : ''}${change} (${reason}) -> ${profile.relationship} (${newLevel})`);
      
      return { oldLevel, newLevel, newScore: profile.relationship };
    } catch (error) {
      console.error('[KARMA ERROR] Failed to update karma:', error);
      return null;
    }
  },

  // Проверка лимита сообщений
  checkMessageLimit: (chatId, userId) => {
    const today = new Date().toDateString();
    const userKey = `${chatId}:${userId}:${today}`;
    
    if (!tempCache.messageCounts[userKey]) {
      tempCache.messageCounts[userKey] = 0;
    }
    
    tempCache.messageCounts[userKey]++;
    
    // Если превышен дневной лимит, проверяем карму
    if (tempCache.messageCounts[userKey] > config.karma.dailyMessageLimit) {
      const profile = storage.getProfile(chatId, userId);
      // Для пользователей с низкой кармой снижаем лимит
      if (profile.relationship < 50) {
        return false;
      }
    }
    
    return true;
  },

  // Обработка первого взаимодействия
  handleFirstInteraction: async (chatId, userId, bot, msg) => {
    const profile = storage.getProfile(chatId, userId, true);
    
    if (profile.isFirstInteraction) {
      // Начисляем бонус за первое взаимодействие
      karmaUtils.updateKarma(
        chatId, 
        userId, 
        config.karma.changes.positive.firstInteraction, 
        'first_interaction'
      );
      
      // Отправляем приветственное сообщение
      const welcomeMessage = `👋 Привет! Я Жмых-бот. Давай дружить!`;
      await bot.sendMessage(chatId, welcomeMessage, { reply_to_message_id: msg.message_id });
      
      return true;
    }
    return false;
  }
};

// Функция для задержки ответа в зависимости от кармы
const delayResponse = (profile) => {
  const level = karmaUtils.getKarmaLevel(profile.relationship);
  const delayMap = {
    'enemy': 5000,    // 5 секунд
    'cold': 3000,     // 3 секунды
    'neutral': 1000,  // 1 секунда
    'friendly': 500,  // 0.5 секунды
    'brother': 0      // Без задержки
  };
  
  return new Promise(resolve => setTimeout(resolve, delayMap[level] || 1000));
};

// Функция для проверки на анти-флуд
const checkFlood = (chatId, userId) => {
  const userKey = `${chatId}:${userId}`;
  const now = Date.now();
  const lastTime = tempCache.lastMessageTimes[userKey] || 0;
  const minDelay = 1000; // Минимальная задержка между сообщениями (1 секунда)
  
  if (now - lastTime < minDelay) {
    return false; // Слишком частые сообщения
  }
  
  tempCache.lastMessageTimes[userKey] = now;
  return true;
};

// Функция для анализа сообщения и обновления кармы
const analyzeAndUpdateKarma = (text, chatId, userId) => {
  const lowerText = text.toLowerCase();
  
  // Проверяем на благодарность
  if (/спасибо|благодарю|спс|пасиб|thx|thanks/i.test(lowerText)) {
    karmaUtils.updateKarma(chatId, userId, config.karma.changes.positive.gratitude, 'gratitude');
  }
  
  // Проверяем на похвалу
  if (/круто|классно|молодец|умничка|красавчик|лучший/i.test(lowerText)) {
    karmaUtils.updateKarma(chatId, userId, config.karma.changes.positive.praise, 'praise');
  }
  
  // Проверяем на оскорбления
  if (/дурак|идиот|лох|тупой|отстой/i.test(lowerText)) {
    karmaUtils.updateKarma(chatId, userId, config.karma.changes.negative.insult, 'insult');
  }
};

// Функция для загрузки истории чата при старте
const loadChatHistory = async (bot, chatId) => {
  try {
    console.log(`[HISTORY] Loading history for chat ${chatId}...`);
    
    if (!chatHistory[chatId]) {
      chatHistory[chatId] = [];
    }
    
    // Загружаем накопительную историю из файла (последние 2000 сообщений для памяти)
    const fileHistory = storage.loadChatHistory(chatId, 2000);
    
    // Загружаем последние сообщения из Telegram API (если есть)
    try {
      const updates = await bot.getUpdates({
        offset: -100,
        limit: 100,
        timeout: 0
      });
      
      const telegramMessages = updates
        .filter(update => update.message && update.message.chat.id === chatId)
        .map(update => update.message)
        .reverse();
      
      for (const msg of telegramMessages) {
        if (msg.text && msg.from) {
          const isBotMessage = msg.from.username === bot.options.username || msg.from.is_bot;
          
          const message = {
            role: isBotMessage ? 'assistant' : 'user',
            text: msg.text,
            userId: msg.from.id,
            sender: msg.from.first_name || 'Пользователь',
            timestamp: new Date(msg.date * 1000).toISOString()
          };
          
          // Добавляем только если нет в файловой истории
          const exists = fileHistory.some(h => 
            h.text === message.text && 
            Math.abs(new Date(h.timestamp) - new Date(message.timestamp)) < 5000
          );
          
          if (!exists) {
            fileHistory.push(message);
            // Сохраняем новые сообщения в файл
            storage.addChatMessage(chatId, message);
          }
        }
      }
    } catch (apiError) {
      console.warn(`[HISTORY] Could not load from Telegram API: ${apiError.message}`);
    }
    
    // Устанавливаем историю в памяти (последние 200 сообщений)
    chatHistory[chatId] = fileHistory.slice(-200);
    
    const stats = storage.getChatHistoryStats(chatId);
    console.log(`[HISTORY] Loaded ${chatHistory[chatId].length} messages to memory, ${stats.totalMessages} total in file for chat ${chatId}`);
    
  } catch (error) {
    console.error(`[HISTORY] Error loading history for chat ${chatId}:`, error.message);
  }
};

// Функция для проверки наличия админа в чате
const isAdminInChat = async (bot, chatId) => {
  try {
    const chatMembers = await bot.getChatAdministrators(chatId);
    return chatMembers.some(member => member.user.id === config.adminId);
  } catch (error) {
    console.error('[ADMIN CHECK ERROR]:', error.message);
    return false;
  }
};

// Функция для определения, нужно ли отвечать на сообщение
const shouldAnswerToMessage = async (text, chatId, userId) => {
  const lowerText = text.toLowerCase();
  
  // 1. Проверяем прямое обращение к боту
  const botTriggers = ['жмых', 'zhmykh', 'бот', 'бота', 'боту'];
  const hasDirectTrigger = botTriggers.some(trigger => lowerText.includes(trigger));
  
  // 2. Проверяем, является ли это ответом на сообщение бота
  const history = chatHistory[chatId] || [];
  const lastBotMessage = history.length > 0 ? history[history.length - 1] : null;
  const isReplyToBot = lastBotMessage && lastBotMessage.role === 'assistant';
  
  // 3. Проверяем команды
  const isCommand = text.startsWith('/');
  
  // 4. Проверяем первое взаимодействие
  const profile = storage.getProfile(chatId, userId);
  const isFirstInteraction = profile.isFirstInteraction;
  
  // ВСЕГДА отвечаем при прямом обращении, команде или первом взаимодействии
  if (hasDirectTrigger || isCommand || isFirstInteraction || isReplyToBot) {
    console.log(`[RESPONSE DECISION] Always respond: trigger=${hasDirectTrigger}, command=${isCommand}, first=${isFirstInteraction}, reply=${isReplyToBot}`);
    return true;
  }
  
  // 5. Спонтанные ответы с вероятностью 2-4%
  const spontaneousChance = 0.02 + Math.random() * 0.02; // 2-4%
  const shouldRespondSpontaneously = Math.random() < spontaneousChance;
  
  console.log(`[RESPONSE DECISION] Spontaneous: ${shouldRespondSpontaneously} (chance: ${(spontaneousChance * 100).toFixed(1)}%)`);
  
  return shouldRespondSpontaneously;
};

// Обработка сообщения
const processMessage = async (bot, msg) => {
  try {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text || '';
    
    // Пропускаем служебные сообщения
    if (!text || !msg.from) return;
    
    // Проверяем анти-флуд
    if (!checkFlood(chatId, userId)) return;
    
    // Проверяем лимит сообщений
    if (!karmaUtils.checkMessageLimit(chatId, userId)) {
      try {
        await bot.sendMessage(chatId, "Ты достиг лимит сообщений на сегодня. Попробуй завтра.", {
          reply_to_message_id: msg.message_id
        });
      } catch (e) {
        console.error("Не удалось отправить сообщение о лимите:", e);
      }
      return;
    }
    
    // === СОХРАНЕНИЕ СООБЩЕНИЯ В ИСТОРИЮ ===
    // Сохраняем ВСЕ сообщения пользователей в историю и в файл
    if (!chatHistory[chatId]) {
      chatHistory[chatId] = [];
    }
    
    const userMessage = {
      role: 'user',
      text: text,
      userId: userId,
      sender: msg.from.first_name || 'Пользователь',
      timestamp: new Date().toISOString()
    };
    
    chatHistory[chatId].push(userMessage);
    
    // Сохраняем в файл для накопительной истории
    storage.addChatMessage(chatId, userMessage);
    
    console.log(`[HISTORY] Saved message for chat ${chatId}. Total: ${chatHistory[chatId].length}`);
    
    // Ограничиваем размер истории в памяти (последние 200 сообщений)
    if (chatHistory[chatId].length > 200) {
      chatHistory[chatId] = chatHistory[chatId].slice(-200);
    }
    
    // Анализируем сообщение на предмет изменения кармы
    analyzeAndUpdateKarma(text, chatId, userId);
    
    // Получаем профиль пользователя
    const profile = storage.getProfile(chatId, userId);
    const isFirstInteraction = profile.isFirstInteraction;
    
    // Задержка ответа в зависимости от кармы
    await delayResponse(profile);
    
    // Проверяем, нужно ли отвечать на сообщение
    const shouldRespond = await shouldAnswerToMessage(text, chatId, userId);
    
    // Получаем ответ от ИИ, только если есть текст и нужно ответить
    if (text && shouldRespond) {
      let aiResponse;
      try {
        // Проверяем, есть ли админ в чате
        const adminInChat = await isAdminInChat(bot, chatId);
        
        // Формируем объект currentMessage для передачи в getResponse
        const currentMessage = {
          text: text,
          sender: msg.from.first_name || 'Пользователь',
          replyText: msg.reply_to_message?.text || null
        };

        // Получаем историю чата
        const history = chatHistory[chatId] || [];

        // Добавляем информацию о наличии админа в userInstruction
        const adminInstruction = adminInChat ? "В ЧАТЕ ЕСТЬ АДМИН - будь более сдержанным" : "";

        // Правильный вызов getResponse (profile на 6-й позиции)
        aiResponse = await ai.getResponse(history, currentMessage, null, null, adminInstruction, profile);
      
      // === ФОРМАТИРОВАНИЕ И ОТПРАВКА ===
      
      // Создаем копию текста для обработки
      let formattedResponse = aiResponse;

      try {
        // --- 1. ФОРМАТИРОВАНИЕ ---
        
        // Заголовки (### Текст -> *ТЕКСТ*)
        formattedResponse = formattedResponse.replace(/^#{1,6}\s+(.*?)$/gm, (match, title) => {
          return `\n*${title.toUpperCase()}*`;
        });

        // Жирный шрифт (**текст** -> *текст*)
        formattedResponse = formattedResponse.replace(/\*\*([\s\S]+?)\*\*/g, '*$1*');
        formattedResponse = formattedResponse.replace(/__([\s\S]+?)__/g, '*$1*');

        // Списки (* пункт -> • пункт)
        formattedResponse = formattedResponse.replace(/^(\s*)[\*\-]\s+/gm, '$1• ');

        // Убираем лишние переносы
        formattedResponse = formattedResponse.replace(/\n{3,}/g, '\n\n');

      } catch (fmtErr) {
        console.error("[FORMAT ERROR] Ошибка форматирования:", fmtErr.message);
        // В случае ошибки форматирования используем оригинальный ответ
        formattedResponse = aiResponse;
      }

      // --- 2. ОТПРАВКА ---
      
      // Защита от спама (обрезаем, если больше 8500 символов)
      if (formattedResponse.length > 8500) {
        formattedResponse = formattedResponse.substring(0, 8500) + "\n\n...[сообщение слишком длинное, обрезано]...";
      }

      // Разбиваем на куски по 4000 символов
      const chunks = formattedResponse.match(/[\s\S]{1,4000}/g) || [formattedResponse];

      // Отправляем каждый кусок сообщения
      for (const chunk of chunks) {
        await bot.sendMessage(chatId, chunk, { 
          reply_to_message_id: msg.message_id
        });
      }

      // Добавляем в историю чата и в файл
      if (!chatHistory[chatId]) {
        chatHistory[chatId] = [];
      }
      
      const botMessage = {
        role: 'assistant',
        text: aiResponse,
        timestamp: new Date().toISOString()
      };
      
      chatHistory[chatId].push(botMessage);
      
      // Сохраняем в файл для накопительной истории
      storage.addChatMessage(chatId, botMessage);
      
      console.log(`[HISTORY] Saved bot response for chat ${chatId}. Total: ${chatHistory[chatId].length}`);

      // Определяем вероятность реакции
      const hasExistingReactions = msg.reactions && msg.reactions.length > 0;
      const reactionChance = hasExistingReactions ? 0.7 : 0.2;

      // Пытаемся поставить реакцию с учетом вероятности
      if (Math.random() < reactionChance) {
        try {
          // Анализируем текст пользователя, а не ответ бота
          const reaction = await ai.determineReaction(text);
          if (reaction) {
            await bot.setMessageReaction(chatId, msg.message_id, { reaction: reaction, is_big: false });
          }
        } catch (reactErr) {
          console.error("[REACTION ERROR]", reactErr.message);
        }
      }

      } catch (err) {
      console.error("[CRITICAL AI ERROR]:", err);
      
      // Отправляем уведомление админу
      const errorMsg = `🔥 **Ошибка ИИ!**\n\nЧат: ${msg.chat?.title || 'ЛС'}\nОшибка: \`${err.message}\``;
      await bot.sendMessage(config.adminId, errorMsg).catch(console.error);
      
      // Отправляем пользователю сообщение об ошибке (ЗАКОММЕНТИРОВАНО - только админу)
      // try {
      //   await bot.sendMessage(chatId, "Что-то пошло не так. Давай попробуем ещё раз?", {
      //     reply_to_message_id: msg.message_id
      //   });
      // } catch (e) {
      //   console.error("Не удалось отправить сообщение об ошибке пользователю:", e);
      // }
    }
  } // <--- Вот здесь закрывается блок if (text)

    // === СПОНТАННАЯ МЫСЛЬ ===
    if (!messageCounter[chatId]) messageCounter[chatId] = 0;
    messageCounter[chatId]++;

    // Проверяем, не пора ли вставить свое слово (раз в 100-150 сообщений)
    if (messageCounter[chatId] > (100 + Math.random() * 50)) {
      try {
        const history = chatHistory[chatId] || [];
        const thought = await ai.getSpontaneousThought(history);
        if (thought) {
          await bot.sendMessage(chatId, thought);
          chatHistory[chatId].push({ role: 'assistant', text: thought, type: 'spontaneous_thought' });
        }
      } catch (thoughtErr) {
        console.error("[SPONTANEOUS THOUGHT ERROR]", thoughtErr.message);
      }
      messageCounter[chatId] = 0; // Сбрасываем счетчик
    }

    // === ПАССИВНЫЙ АНАЛИЗАТОР (Observer) ===
    // Собираем сообщения в буфер для пакетного анализа (раз в 20 сообщений)
    if (!analysisBuffers[chatId]) {
      analysisBuffers[chatId] = [];
    }

    // Не анализируем команды и совсем короткие сообщения
    if (text.length > 5 && !text.startsWith('/')) {
      analysisBuffers[chatId].push({
        userId: userId,
        name: msg.from.first_name || 'Пользователь',
        text: text,
        role: 'user',
        timestamp: new Date().toISOString()
      });

      // Если накопилось достаточно — запускаем анализ
      if (analysisBuffers[chatId].length >= BUFFER_SIZE) {
        // Обработка буфера в фоновом режиме
        processBuffer(chatId).catch(err => {
          console.error("[BUFFER PROCESSING ERROR]:", err);
        });
      }
    }

  } catch (error) {
    console.error("[PROCESS MESSAGE ERROR]:", error);
    
    // Пытаемся отправить сообщение об ошибке в чат (ЗАКОММЕНТИРОВАНО - только админу)
    // try {
    //   await bot.sendMessage(msg.chat.id, "Произошла ошибка при обработке сообщения. Пожалуйста, попробуйте ещё раз.", {
    //     reply_to_message_id: msg.message_id
    //   });
    // } catch (e) {
    //   console.error("Не удалось отправить сообщение об ошибке:", e);
    // }
    
    // Отправляем уведомление админу
    try {
      await bot.sendMessage(
        config.adminId,
        `⚠️ **Ошибка в processMessage**\n` +
        `Чат: ${msg.chat?.title || 'ЛС'}\n` +
        `Ошибка: \`${error.message}\``
      );
    } catch (e) {
      console.error("Не удалось отправить уведомление админу:", e);
    }
  }
};

// Функция для обработки буфера сообщений
async function processBuffer(chatId) {
  if (!analysisBuffers[chatId] || analysisBuffers[chatId].length === 0) {
    return;
  }
  
  const messages = [...analysisBuffers[chatId]];
  analysisBuffers[chatId] = [];
  
  try {
    // Здесь можно добавить анализ накопленных сообщений
    // Например, анализ тональности, тематики и т.д.
    console.log(`[ANALYSIS] Processing ${messages.length} messages for chat ${chatId}`);
    
    // Пример: анализ тональности сообщений
    const sentimentAnalysis = await analyzeSentiment(messages);
    
    // Логируем результаты анализа
    if (sentimentAnalysis) {
      console.log(`[SENTIMENT] Chat ${chatId}:`, sentimentAnalysis);
    }
    
  } catch (error) {
    console.error(`[BUFFER PROCESSING ERROR] Chat ${chatId}:`, error);
    // В случае ошибки возвращаем сообщения обратно в буфер
    analysisBuffers[chatId] = [...messages, ...(analysisBuffers[chatId] || [])];
  }
}

// Вспомогательная функция для анализа тональности (заглушка)
async function analyzeSentiment(messages) {
  // Здесь должна быть реализация анализа тональности
  // Возвращаем заглушку для примера
  return {
    totalMessages: messages.length,
    positive: Math.floor(Math.random() * 100),
    negative: Math.floor(Math.random() * 100),
    neutral: Math.floor(Math.random() * 100)
  };
}

// Экспортируем функции
module.exports = { 
  processMessage,
  chatHistory, // Экспортируем историю чата
  loadChatHistory, // Экспортируем функцию загрузки истории
  karmaUtils, // Экспортируем для тестирования
  processBuffer, // Экспортируем для тестирования
  analyzeSentiment // Экспортируем для тестирования
};