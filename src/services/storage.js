const fs = require('fs');
const path = require('path');
const debounce = require('lodash.debounce');
const config = require('../config'); // <--- Добавляем импорт конфига

// Константы путей
const DB_PATH = path.join(__dirname, '../../data/db.json');
const INSTRUCTIONS_PATH = path.join(__dirname, '../../data/instructions.json');
const PROFILES_PATH = path.join(__dirname, '../../data/profiles.json');

// Начальные значения по умолчанию
const DEFAULT_PROFILE = {
  realName: null,
  facts: "",
  attitude: "Нейтральное",
  relationship: 80, // Начальный рейтинг кармы 80
  isFirstInteraction: true,
  lastInteraction: null
};

class StorageService {
  constructor() {
    // Инициализация отложенного сохранения
    this.saveDebounced = debounce(this._saveToFile.bind(this), 5000);
    this.saveProfilesDebounced = debounce(this._saveProfilesToFile.bind(this), 5000);
    
    // Инициализация данных
    this.data = { chats: {}, reminders: [] };
    this.profiles = {};
    this.instructions = {};

    // Создаем необходимые файлы, если их нет
    this.ensureFile(DB_PATH, JSON.stringify(this.data));
    this.ensureFile(INSTRUCTIONS_PATH, '{}');
    this.ensureFile(PROFILES_PATH, '{}');

    // Загружаем данные
    this.load();
  }

  // === ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ===

  /**
   * Создает файл, если он не существует
   * @param {string} filePath - Путь к файлу
   * @param {string} defaultContent - Содержимое по умолчанию
   */
  ensureFile(filePath, defaultContent) {
    if (!fs.existsSync(path.dirname(filePath))) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, defaultContent, 'utf8');
    }
  }

  /**
   * Загружает данные из файлов
   */
  load() {
    try {
      this.data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    } catch (e) {
      console.error('Ошибка загрузки данных:', e);
      this.data = { chats: {}, reminders: [] };
    }

    try {
      this.instructions = JSON.parse(fs.readFileSync(INSTRUCTIONS_PATH, 'utf8'));
    } catch (e) {
      console.error('Ошибка загрузки инструкций:', e);
      this.instructions = {};
    }

    try {
      this.profiles = JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8'));
    } catch (e) {
      console.error('Ошибка загрузки профилей:', e);
      this.profiles = {};
    }
  }

  // === СОХРАНЕНИЕ ДАННЫХ ===

  /**
   * Сохраняет данные в файл
   */
  _saveToFile() {
    try {
      fs.writeFileSync(DB_PATH, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (e) {
      console.error('Ошибка сохранения данных:', e);
    }
  }

  /**
   * Сохраняет профили в файл
   */
  _saveProfilesToFile() {
    try {
      fs.writeFileSync(PROFILES_PATH, JSON.stringify(this.profiles, null, 2), 'utf8');
    } catch (e) {
      console.error('Ошибка сохранения профилей:', e);
    }
  }

  /**
   * Сохраняет инструкции в файл
   */
  _saveInstructions() {
    try {
      fs.writeFileSync(INSTRUCTIONS_PATH, JSON.stringify(this.instructions, null, 2), 'utf8');
    } catch (e) {
      console.error('Ошибка сохранения инструкций:', e);
    }
  }

  // === РАБОТА С ЧАТАМИ ===

  /**
   * Получает данные чата
   * @param {string|number} chatId - ID чата
   * @returns {Object} Данные чата
   */
  getChat(chatId) {
    if (!this.data.chats[chatId]) {
      this.data.chats[chatId] = {
        id: chatId,
        title: `Чат ${chatId}`,
        lastActive: new Date().toISOString(),
        settings: {}
      };
      this.saveDebounced();
    }
    return this.data.chats[chatId];
  }

  /**
   * Обновляет данные чата
   * @param {string|number} chatId - ID чата
   * @param {Object} updates - Обновленные данные
   */
  updateChat(chatId, updates) {
    const chat = this.getChat(chatId);
    this.data.chats[chatId] = { ...chat, ...updates };
    this.saveDebounced();
  }

  // === ПРОФИЛИ ПОЛЬЗОВАТЕЛЕЙ ===

  /**
   * Получить профиль пользователя или создать новый, если не существует
   * @param {string|number} chatId - ID чата
   * @param {string|number} userId - ID пользователя
   * @param {boolean} [isFirstMessage=false] - Флаг первого сообщения пользователя
   * @returns {Object} Профиль пользователя
   */
  getProfile(chatId, userId, isFirstMessage = false) {
    // Специальная логика для админа
    if (userId === config.adminId) {
      const adminProfile = { 
        ...DEFAULT_PROFILE, 
        relationship: 100, 
        realName: 'Админ',
        isFirstInteraction: false
      };
      // Возвращаем профиль админа, не сохраняя его в базу, 
      // чтобы не перезаписывать реальные данные, если они есть
      return adminProfile;
    }

    // Инициализация чата, если его нет
    if (!this.profiles[chatId]) {
      this.profiles[chatId] = {};
    }

    // Создаем новый профиль, если его нет
    if (!this.profiles[chatId][userId]) {
      const newProfile = { ...DEFAULT_PROFILE };
      this.profiles[chatId][userId] = newProfile;
      this.saveProfilesDebounced();
      return newProfile;
    }

    const profile = this.profiles[chatId][userId];
    
    // Обновляем флаг первого взаимодействия
    if (isFirstMessage && profile.isFirstInteraction) {
      profile.isFirstInteraction = false;
      profile.lastInteraction = new Date().toISOString();
      this.saveProfilesDebounced();
    }
    
    // Убедимся, что все обязательные поля есть в профиле
    const mergedProfile = { ...DEFAULT_PROFILE, ...profile };
    this.profiles[chatId][userId] = mergedProfile;
    
    return mergedProfile;
  }

  /**
   * Получить несколько профилей пользователей
   * @param {string|number} chatId - ID чата
   * @param {Array<string|number>} userIds - Массив ID пользователей
   * @returns {Object} Объект с профилями пользователей
   */
  getProfilesForUsers(chatId, userIds) {
    const result = {};
    if (!this.profiles[chatId]) {
      this.profiles[chatId] = {};
    }

    // Получаем профиль для каждого пользователя
    for (const userId of userIds) {
      result[userId] = this.getProfile(chatId, userId);
    }
    
    return result;
  }

  /**
   * Массовое обновление профилей
   * @param {string|number} chatId - ID чата
   * @param {Object} updatesMap - Объект с обновлениями профилей
   */
  bulkUpdateProfiles(chatId, updatesMap) {
    if (!this.profiles[chatId]) {
      this.profiles[chatId] = {};
    }

    const updatedProfiles = [];
    
    for (const [userId, data] of Object.entries(updatesMap)) {
      // Получаем текущий профиль или создаем новый
      const current = this.getProfile(chatId, userId);
      
      // Обновляем данные профиля
      if (data.realName && data.realName !== "Неизвестно") {
        current.realName = data.realName;
      }
      
      if (data.facts) {
        current.facts = data.facts;
      }
      
      if (data.attitude) {
        current.attitude = data.attitude;
      }
      
      if (data.relationship !== undefined) {
        const score = parseInt(data.relationship, 10);
        if (!isNaN(score)) {
          // Ограничиваем значение кармы от 0 до 100
          current.relationship = Math.max(0, Math.min(100, score));
        }
      }
      
      // Обновляем время последнего взаимодействия
      current.lastInteraction = new Date().toISOString();
      
      updatedProfiles.push(userId);
    }
    
    // Сохраняем изменения
    if (updatedProfiles.length > 0) {
      this.saveProfilesDebounced();
    }
    
    return updatedProfiles;
  }

  // === НАПОМИНАНИЯ ===

  /**
   * Добавляет новое напоминание
   * @param {Object} task - Объект напоминания
   */
  addReminder(task) {
    this.data.reminders.push(task);
    this.saveDebounced();
  }

  /**
   * Возвращает все просроченные напоминания
   * @returns {Array<Object>} Массив напоминаний
   */
  getPendingReminders() {
    const now = Date.now();
    return this.data.reminders.filter(r => new Date(r.time).getTime() <= now);
  }

  /**
   * Удаляет напоминания по их ID
   * @param {Array<string>} ids - Массив ID для удаления
   */
  removeReminders(ids) {
    this.data.reminders = this.data.reminders.filter(r => !ids.includes(r.id));
    this.saveDebounced();
  }

  // === ИНСТРУКЦИИ ДЛЯ ПОЛЬЗОВАТЕЛЕЙ ===

  /**
   * Получить инструкцию пользователя
   * @param {string|number} userId - ID пользователя
   * @returns {Promise<string>} Инструкция пользователя
   */
  async getUserInstruction(userId) {
    try {
      if (this.instructions[userId]) {
        return this.instructions[userId];
      }
      return "";
    } catch (e) {
      console.error("Ошибка получения инструкции:", e);
      return "";
    }
  }

  /**
   * Установить инструкцию пользователя
   * @param {string|number} userId - ID пользователя
   * @param {string} instruction - Текст инструкции
   */
  setUserInstruction(userId, instruction) {
    this.instructions[userId] = instruction;
    this._saveInstructions();
  }

  /**
   * Добавить сообщение в историю чата
   * @param {string|number} chatId - ID чата
   * @param {Object} message - Объект сообщения
   */
  addChatMessage(chatId, message) {
    const historyPath = path.join(__dirname, '../../data/chat_history');
    
    // Создаем папку, если нет
    if (!fs.existsSync(historyPath)) {
      fs.mkdirSync(historyPath, { recursive: true });
    }
    
    const filePath = path.join(historyPath, `${chatId}.jsonl`);
    
    // Добавляем сообщение в конец файла (JSONL формат - одна строка JSON)
    const messageWithTimestamp = {
      ...message,
      saved_at: new Date().toISOString()
    };
    
    fs.appendFileSync(filePath, JSON.stringify(messageWithTimestamp) + '\n');
  }

  /**
   * Загрузить историю чата
   * @param {string|number} chatId - ID чата
   * @param {number} limit - Лимит сообщений (null = без ограничений)
   * @returns {Array} Массив сообщений
   */
  loadChatHistory(chatId, limit = null) {
    const filePath = path.join(__dirname, '../../data/chat_history', `${chatId}.jsonl`);
    
    try {
      if (!fs.existsSync(filePath)) {
        return [];
      }
      
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.trim().split('\n').filter(line => line);
      
      // Парсим JSON
      const messages = lines.map(line => JSON.parse(line));
      
      // Если лимит не указан, возвращаем все сообщения
      if (limit === null) {
        return messages;
      }
      
      // Иначе берем последние limit сообщений
      return messages.slice(-limit);
      
    } catch (error) {
      console.error(`Error loading chat history for ${chatId}:`, error);
      return [];
    }
  }

  /**
   * Получить статистику истории чата
   * @param {string|number} chatId - ID чата
   * @returns {Object} Статистика
   */
  getChatHistoryStats(chatId) {
    const filePath = path.join(__dirname, '../../data/chat_history', `${chatId}.jsonl`);
    
    try {
      if (!fs.existsSync(filePath)) {
        return { totalMessages: 0, fileSize: 0 };
      }
      
      const stats = fs.statSync(filePath);
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.trim().split('\n').filter(line => line);
      
      return {
        totalMessages: lines.length,
        fileSize: stats.size,
        lastModified: stats.mtime
      };
      
    } catch (error) {
      console.error(`Error getting chat history stats for ${chatId}:`, error);
      return { totalMessages: 0, fileSize: 0 };
    }
  }
}

// Экспортируем синглтон
module.exports = new StorageService();
