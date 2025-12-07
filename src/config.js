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
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  botId: parseInt(process.env.TELEGRAM_BOT_TOKEN.split(':')[0], 10),
  adminId: parseInt(process.env.ADMIN_USER_ID, 10),

  geminiKeys: geminiKeys,

  modelName: 'gemini-2.5-flash',
  contextSize: 200,
  spontaneousChance: 0.02, // Шанс вмешательства (2%)
  triggerRegex: /(?<![а-яёa-z])(жмых|zhmykh)(?![а-яёa-z])/i,

};


