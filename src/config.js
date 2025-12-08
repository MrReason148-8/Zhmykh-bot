require('dotenv').config();

// Собираем все ключи Gemini в массив
const geminiKeys = [];
if (process.env.GOOGLE_GEMINI_API_KEY) geminiKeys.push(process.env.GOOGLE_GEMINI_API_KEY);

// Ищем ключи с суффиксами _2, _3 и т.д.
let i = 2;
while (process.env[`GOOGLE_GEMINI_API_KEY_${i}`]) {
  geminiKeys.push(process.env[`GOOGLE_GEMINI_API_KEY_${i}`]);
  i++;
}

console.log(`[CONFIG] Загружено ключей Gemini: ${geminiKeys.length}`);

module.exports = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || process.env.TG_KEY,
  botId: parseInt((process.env.TELEGRAM_BOT_TOKEN || process.env.TG_KEY || "").split(':')[0], 10),
  adminId: parseInt(process.env.ADMIN_USER_ID, 10),

  geminiKeys: geminiKeys,

  // === НАСТРОЙКИ МОДЕЛЕЙ ===
  
  // Ротация моделей (в порядке приоритета)
  modelRotation: [
    {
      name: 'gemini-2.0-flash-exp',
      provider: 'gemini',
      priority: 'high',
      generationConfig: {
        maxOutputTokens: 2000,
        temperature: 0.7,
        topP: 0.95,
        topK: 40
      },
      tools: [{ googleSearch: {}}]
    },
    {
      name: 'deepseek-ai/deepseek-chat',
      provider: 'openrouter',
      priority: 'default',
      generationConfig: {
        max_tokens: 2000,
        temperature: 0.8,
        top_p: 0.9
      }
    },
    {
      name: 'gemini-2.0-flash',
      provider: 'gemini',
      priority: 'low',
      generationConfig: {
        maxOutputTokens: 1500,
        temperature: 0.5,
        topP: 0.9,
        topK: 30
      },
      tools: []
    }
  ],
  
  // === ОСНОВНЫЕ НАСТРОЙКИ ===
  defaultModel: 'gemini-2.0-flash-exp',
  contextSize: 200,
  spontaneousChance: 0.02, // Шанс спонтанного сообщения (2%)
  triggerRegex: /(?<![а-яёa-z])(жмых|zhmykh)(?![а-яёa-z])/i,
  geminiBaseUrl: process.env.GEMINI_BASE_URL || undefined,
  openRouterKey: process.env.OPENROUTER_API_KEY || null,
  
  // === НАСТРОЙКИ КАРМЫ ===
  karma: {
    default: 80,                    // Начальный рейтинг кармы
    max: 100,                      // Максимальный рейтинг
    min: 0,                        // Минимальный рейтинг
    firstInteractionBonus: 10,     // Бонус за первое взаимодействие
    dailyMessageLimit: 50,         // Лимит сообщений в день
    
    // Изменения рейтинга за действия
    changes: {
      positive: {
        greeting: 2,               // Приветствие
        gratitude: 3,              // Благодарность
        praise: 5,                 // Похвала
        defense: 7,                // Защита бота
        firstInteraction: 10        // Первое взаимодействие
      },
      negative: {
        insult: -15,               // Оскорбление
        rudeJoke: -10,             // Грубая шутка
        complaint: -5,             // Жалоба
        ignore: -3,                // Игнорирование
        spam: -20                  // Спам
      },
      // Модификаторы на основе текущего рейтинга
      modifiers: {
        highKarma: 0.5,            // Уменьшение наград при высоком рейтинге
        lowKarma: 1.5,             // Увеличение наказаний при низком рейтинге
        adminProtection: 100       // Рейтинг админа (нельзя понизить)
      }
    },
    
    // Уровни рейтинга и соответствующие настройки
    levels: {
      enemy: { max: 20, attitude: 'ВРАГ', tone: 'грубый, с сарказмом' },
      cold: { max: 40, attitude: 'ХОЛОД', tone: 'сдержанный, подозрительный' },
      neutral: { max: 60, attitude: 'НЕЙТРАЛ', tone: 'нейтральный' },
      friendly: { max: 80, attitude: 'ДРУЖЕЛЮБНЫЙ', tone: 'дружелюбный, с юмором' },
      brother: { min: 80, attitude: 'БРАТАН', tone: 'дружеский, с шутками' }
    }
  },
  
  // === НАСТРОЙКИ ПОИСКА ===
  search: {
    enabled: false,                 // Поиск отключен по умолчанию
    onlyWhenUncertain: true,       // Искать только при неуверенности
    maxResults: 3,                 // Максимальное количество результатов
    minConfidence: 0.7,            // Минимальная уверенность для ответа
    
    // Триггеры для включения поиска
    triggers: [
      'найди', 'поищи', 'гугл', 'загугли', 'в интернете', 'в гугле',
      'кто такой', 'что такое', 'когда', 'где найти', 'как сделать',
      'найди в интернете', 'поищи в гугле', 'что говорит википедия'
    ],
    
    // Исключения (когда не нужно искать)
    blacklist: [
      'как дела', 'привет', 'пока', 'спасибо', 'пожалуйста', 'извини',
      'жмых', 'zhmykh', 'бот', 'помощь', 'команды'
    ]
  },

};
