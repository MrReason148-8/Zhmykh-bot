const fs = require('fs');
const path = require('path');
const storage = require('../src/services/storage');

// ID чата из файла экспорта
const CHAT_ID = "-1001858106649"; // Добавляем -100 для супергрупп

// Имя бота для определения его сообщений
const BOT_USERNAME = "zhmykh_bot"; // Укажите правильный username бота

function convertTelegramExport() {
  console.log("Начинаю конвертацию истории чата...");
  
  try {
    // Читаем экспортированный файл
    const exportPath = path.join(__dirname, '../result.json');
    const exportData = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
    
    console.log(`Загружено ${exportData.messages.length} сообщений из экспорта`);
    
    // Создаем папку для истории, если нет
    const historyPath = path.join(__dirname, '../data/chat_history');
    if (!fs.existsSync(historyPath)) {
      fs.mkdirSync(historyPath, { recursive: true });
    }
    
    // Очищаем существующий файл истории
    const filePath = path.join(historyPath, `${CHAT_ID}.jsonl`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log("Существующий файл истории очищен");
    }
    
    let processedMessages = 0;
    let skippedMessages = 0;
    let botMessages = 0;
    let userMessages = 0;
    
    // Обрабатываем сообщения
    exportData.messages.forEach((msg, index) => {
      // Пропускаем служебные сообщения без текста
      let text = msg.text;
      if (Array.isArray(text)) {
        // Если text - массив (text_entities), собираем из plain текстов
        text = text.map(entity => entity.text || '').join('');
      }
      
      if (msg.type !== 'message' || !text || text.trim() === '') {
        skippedMessages++;
        return;
      }
      
      // Определяем роль (бот или пользователь)
      let role = 'user';
      let sender = msg.from || 'Unknown';
      
      // Проверяем, является ли сообщение от бота
      if (msg.from_id && (
        msg.from_id.includes('bot') || 
        msg.from === BOT_USERNAME ||
        (msg.from && msg.from.toLowerCase().includes('жмых')) ||
        (msg.from && msg.from.toLowerCase().includes('zhmykh'))
      )) {
        role = 'assistant';
        botMessages++;
      } else {
        userMessages++;
      }
      
      // Конвертируем в формат бота
      const botMessage = {
        role: role,
        text: text,
        userId: msg.from_id || 'unknown',
        sender: sender,
        timestamp: new Date(msg.date).toISOString()
      };
      
      // Добавляем в файл
      fs.appendFileSync(filePath, JSON.stringify(botMessage) + '\n');
      processedMessages++;
      
      // Показываем прогресс каждые 1000 сообщений
      if (processedMessages % 1000 === 0) {
        console.log(`Обработано ${processedMessages} сообщений...`);
      }
    });
    
    console.log("\n=== Конвертация завершена ===");
    console.log(`Всего сообщений в экспорте: ${exportData.messages.length}`);
    console.log(`Обработано сообщений: ${processedMessages}`);
    console.log(`Пропущено (без текста): ${skippedMessages}`);
    console.log(`Сообщений от бота: ${botMessages}`);
    console.log(`Сообщений от пользователей: ${userMessages}`);
    console.log(`Файл истории создан: ${filePath}`);
    
    // Показываем статистику
    const stats = fs.statSync(filePath);
    console.log(`Размер файла: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
    
    // Проверяем загрузку
    const loadedHistory = storage.loadChatHistory(CHAT_ID, 10);
    console.log(`\nПроверка загрузки: последние 10 сообщений:`);
    loadedHistory.forEach((msg, i) => {
      console.log(`${i+1}. [${msg.role}] ${msg.sender}: ${msg.text.substring(0, 50)}...`);
    });
    
  } catch (error) {
    console.error("Ошибка при конвертации:", error);
  }
}

// Запускаем конвертацию
convertTelegramExport();
