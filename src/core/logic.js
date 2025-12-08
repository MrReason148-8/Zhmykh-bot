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
      console.log(`[ANTI-SPAM] User ${userId} in chat ${chatId} exceeded daily message limit`);
      return;
    }
    
    // Обрабатываем первое взаимодействие
    const isFirstInteraction = await karmaUtils.handleFirstInteraction(chatId, userId, bot, msg);
    
    // Анализируем сообщение и обновляем карму
    analyzeAndUpdateKarma(text, chatId, userId);
    
    // Получаем профиль пользователя для контекста
    const profile = storage.getProfile(chatId, userId);
    const context = {
      chatId,
      userId,
      isFirstInteraction,
      relationship: profile.relationship,
      karmaLevel: karmaUtils.getKarmaLevel(profile.relationship)
    };
    
    // Задержка ответа в зависимости от кармы
    await delayResponse(profile);
    
    // Получаем ответ от ИИ, только если есть текст
    if (text) {
      let aiResponse;
      try {
        // Формируем объект currentMessage для передачи в getResponse
        const currentMessage = {
          text: text,
          sender: msg.from.first_name || 'Пользователь',
          replyText: msg.reply_to_message?.text || null
        };

        // Получаем историю чата
        const history = chatHistory[chatId] || [];

        // Правильный вызов getResponse (profile на 6-й позиции)
        aiResponse = await ai.getResponse(history, currentMessage, null, null, "", profile);
      
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
          reply_to_message_id: msg.message_id,
          parse_mode: 'Markdown'
        });
      }

      // Добавляем в историю чата
      if (!chatHistory[chatId]) {
        chatHistory[chatId] = [];
      }
      chatHistory[chatId].push({
        role: 'assistant',
        text: aiResponse,
        timestamp: new Date().toISOString()
      });

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
      await bot.sendMessage(config.adminId, errorMsg, { parse_mode: 'Markdown' }).catch(console.error);
      
      // Отправляем пользователю сообщение об ошибке
      try {
        await bot.sendMessage(chatId, "Что-то пошло не так. Давай попробуем ещё раз?", {
          reply_to_message_id: msg.message_id
        });
      } catch (e) {
        console.error("Не удалось отправить сообщение об ошибке пользователю:", e);
      }
    }
  } // <--- Вот здесь закрывается блок if (text)

    // === СПОНТАННАЯ РЕАКЦИЯ (с вероятностью 10%) ===
    if (Math.random() < 0.1) {
      try {
        const history = chatHistory[chatId] || [];
        const reaction = await ai.getSpontaneousReaction(history);
        if (reaction) {
          await bot.sendMessage(chatId, reaction);
          // Запоминаем, что последним действием была спонтанная реакция
          if (!chatHistory[chatId]) chatHistory[chatId] = [];
          chatHistory[chatId].push({ role: 'assistant', text: reaction, type: 'spontaneous_reaction' });
        }
      } catch (spontErr) {
        console.error("[SPONTANEOUS REACTION ERROR]", spontErr.message);
      }
    }

    // === СПОНТАННАЯ МЫСЛЬ ===
    if (!messageCounter[chatId]) messageCounter[chatId] = 0;
    messageCounter[chatId]++;

    // Проверяем, не пора ли вставить свое слово (раз в 30-50 сообщений)
    if (messageCounter[chatId] > (30 + Math.random() * 20)) {
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
    
    // Пытаемся отправить сообщение об ошибке в чат
    try {
      await bot.sendMessage(msg.chat.id, "Произошла ошибка при обработке сообщения. Пожалуйста, попробуйте ещё раз.", {
        reply_to_message_id: msg.message_id
      });
    } catch (e) {
      console.error("Не удалось отправить сообщение об ошибке:", e);
    }
    
    // Отправляем уведомление админу
    try {
      await bot.sendMessage(
        config.adminId,
        `⚠️ **Ошибка в processMessage**\n` +
        `Чат: ${msg.chat?.title || 'ЛС'}\n` +
        `Ошибка: \`${error.message}\``,
        { parse_mode: 'Markdown' }
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
  karmaUtils, // Экспортируем для тестирования
  processBuffer, // Экспортируем для тестирования
  analyzeSentiment // Экспортируем для тестирования
};