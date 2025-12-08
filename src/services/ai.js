const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const config = require('../config');
const prompts = require('../core/prompts');
const storage = require('./storage');
const axios = require('axios');

class AiService {
  constructor() {
    this.keyIndex = 0;
    this.modelIndex = 0; // Индекс текущей модели
    this.keys = config.geminiKeys;
    this.models = config.modelRotation; // Массив моделей для ротации
    this.currentModel = this.models[0]; // Текущая модель
    
    if (this.keys.length === 0) {
      console.error("CRITICAL: Нет ключей Gemini в .env!");
    }
    
    this.initModel();
  }

  /**
   * Инициализирует модель с текущими настройками
   * @param {string} [modelName] - Имя модели для инициализации (если не указано, берется текущая модель)
   */
  initModel(modelName = null) {
    const currentKey = this.keys[this.keyIndex];
    const genAI = new GoogleGenerativeAI(currentKey);

    const safetySettings = [
      { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    ];

    const generationConfig = {
      maxOutputTokens: 8000,
      temperature: 0.9,
    };

    const requestOptions = config.geminiBaseUrl ? { baseUrl: config.geminiBaseUrl } : {};
    
    // Обновляем текущую модель, если не указана конкретная
    if (!modelName) {
      this.currentModel = this.models[this.modelIndex];
      modelName = this.currentModel.name;
    }

    try {
      this.model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: prompts.system(),
        safetySettings: safetySettings,
        generationConfig: {
          ...generationConfig,
          ...(this.currentModel.generationConfig || {})
        },
        tools: this.currentModel.tools || [{ googleSearch: {} }]
      }, requestOptions);
      
      console.log(`[AI] Инициализирована модель: ${modelName}`);
    } catch (error) {
      console.error(`[AI ERROR] Ошибка инициализации модели ${modelName}:`, error);
      this.rotateModel(); // Пробуем следующую модель в случае ошибки
    }
  }

  /**
   * Переключается на следующий API ключ
   */
  rotateKey() {
    this.keyIndex = (this.keyIndex + 1) % this.keys.length;
    console.log(`[AI WARNING] Лимит ключа исчерпан! Переключаюсь на ключ #${this.keyIndex + 1}...`);
    this.initModel();
  }
  
  /**
   * Переключается на следующую модель в ротации
   */
  rotateModel() {
    this.modelIndex = (this.modelIndex + 1) % this.models.length;
    console.log(`[AI] Переключаюсь на модель: ${this.models[this.modelIndex].name}`);
    this.initModel();
  }
  
  /**
   * Выбирает модель на основе контекста и рейтинга кармы пользователя
   * @param {Object} context - Контекст запроса
   * @returns {string} Имя выбранной модели
   */
  selectModelByContext(context = {}) {
    const { chatId, userId } = context;
    let modelName = this.models[0].name; // По умолчанию первая модель
    
    try {
      // Получаем профиль пользователя
      const profile = storage.getProfile(chatId, userId);
      
      // Если это первое взаимодействие или высокий рейтинг кармы - используем более мощную модель
      if (profile.isFirstInteraction || (profile.relationship >= 80)) {
        modelName = this.models.find(m => m.priority === 'high')?.name || modelName;
      } 
      // Если низкий рейтинг кармы - используем более простую модель
      else if (profile.relationship < 50) {
        modelName = this.models.find(m => m.priority === 'low')?.name || modelName;
      }
      // Иначе используем модель по умолчанию
      else {
        modelName = this.models.find(m => m.priority === 'default')?.name || modelName;
      }
    } catch (error) {
      console.error('Ошибка при выборе модели:', error);
    }
    
    return modelName;
  }

  /**
   * Выполняет запрос к API с повторными попытками
   * @param {Function} apiCallFn - Функция для вызова API
   * @param {string} [fallbackText] - Текст для возврата в случае ошибки
   * @param {Object} [context] - Контекст запроса (chatId, userId и т.д.)
   * @returns {Promise<string>} Ответ от API
   */
  async executeWithRetry(apiCallFn, fallbackText = null, context = {}) {
    const maxAttempts = this.keys.length * this.models.length * 2; // Максимальное количество попыток
    let lastError = null;
    const startTime = Date.now();

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        // Просто выполняем переданную функцию
        return await apiCallFn();
      } catch (error) {
        console.error(`[AI ERROR] Ошибка API (попытка ${attempt + 1}):`, error.message);
        lastError = error;
        
        // Проверяем, является ли ошибка связанной с квотой
        const isQuotaError = error.status === 429 || 
                           (error.message && error.message.includes('quota')) ||
                           (error.response?.data?.error?.message?.includes('quota'));
        
        if (isQuotaError || error.message.includes('404')) {
          console.log(`[AI] Обнаружена ошибка для модели ${this.currentModel?.name || 'unknown'}, пробуем следующую модель...`);
          this.rotateModel();
          this.keyIndex = 0; // Сбрасываем индекс ключа при смене модели
          continue;
        }
        
        // Если это не ошибка квоты, пробуем следующий ключ
        if (attempt < maxAttempts - 1) {
          if (this.models.length > 1 && (attempt + 1) % this.models.length === 0) {
            this.rotateModel();
            this.keyIndex = 0; // Сбрасываем индекс ключа при смене модели
          } else {
            this.rotateKey();
          }
          
          // Экспоненциальная задержка между попытками
          const delayMs = Math.min(1000 * Math.pow(2, attempt), 10000);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    }
    
    // Если дошли сюда, значит все попытки исчерпаны
    console.error(`[AI CRITICAL] Все попытки исчерпаны за ${(Date.now() - startTime) / 1000} сек`);
    
    // Если у нас есть OpenRouter ключ, пробуем его как последнее средство
    if (config.openRouterKey && !lastError?.message?.includes('OpenRouter')) {
      console.log('[AI] Пробуем использовать OpenRouter как запасной вариант...');
      try {
        const fallbackResponse = fallbackText || 'К сожалению, все модели в данный момент перегружены. Пожалуйста, попробуйте позже.';
        const response = await this.callOpenRouter({
          model: 'tngtech/deepseek-r1t2-chimera:free',
          messages: [
            { role: 'system', content: 'Ты - Жмых, остроумный и саркастичный бот.' },
            { role: 'user', content: fallbackResponse }
          ],
          temperature: 0.7,
          max_tokens: 100
        });
        return { response: { text: () => response.choices[0].message.content } };
      } catch (orError) {
        console.error('[OPENROUTER ERROR]:', orError.message);
        throw new Error("Все ключи и модели исчерпали лимит!");
      }
    }

    throw lastError || new Error("Все ключи и модели исчерпали лимит!");
  }

  async callOpenRouter(requestData) {
    if (!config.openRouterKey) {
      throw new Error('OPENROUTER_API_KEY не задан в конфигурации!');
    }

    try {
      const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: requestData.model,
          messages: requestData.messages,
          temperature: requestData.temperature,
          max_tokens: requestData.max_tokens,
          // Добавляем дополнительные параметры для лучшей совместимости
          top_p: 0.9,
          frequency_penalty: 0,
          presence_penalty: 0,
          stop: null
        },
        {
          headers: {
            'Authorization': `Bearer ${config.openRouterKey}`,
            'HTTP-Referer': 'https://github.com/MrReason148-8/Zhmykh-bot',
            'X-Title': 'Zhmykh Bot',
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          timeout: 30000 // 30 секунд таймаут
        }
      );
      return response.data;
    } catch (error) {
      const errorMessage = error.response?.data?.error?.message || error.message;
      console.error('OpenRouter API Error:', errorMessage);
      
      // Создаем более информативное сообщение об ошибке
      const enhancedError = new Error(`Ошибка OpenRouter: ${errorMessage}`);
      enhancedError.status = error.response?.status;
      enhancedError.response = error.response?.data;
      
      throw enhancedError;
    }
  }

  getCurrentTime() {
    return new Date().toLocaleString("ru-RU", {
      timeZone: "Asia/Yekaterinburg",
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  // === ОСНОВНОЙ ОТВЕТ ===
  async getResponse(history, currentMessage = {}, imageBuffer = null, mimeType = "image/jpeg", userInstruction = "", userProfile = null, isSpontaneous = false) {
    const messageText = currentMessage?.text || '';
    console.log(`[DEBUG AI] getResponse вызван. Текст: ${messageText ? messageText.slice(0, 20) + '...' : 'нет текста'}`);
    const requestLogic = async () => {
      let promptParts = [];

      if (imageBuffer) {
        promptParts.push({ inlineData: { mimeType: mimeType, data: imageBuffer.toString("base64") } });
        promptParts.push({ text: "Проанализируй этот файл. Опиши, что там, или ответь на вопрос по нему." });
      }

      // Проверяем, что history является массивом, иначе используем пустой массив
      const safeHistory = Array.isArray(history) ? history : [];
      const relevantHistory = safeHistory.slice(-20);
      const contextStr = relevantHistory.map(m => `${m?.role || 'user'}: ${m?.text || ''}`).filter(Boolean).join('\n');

      let personalInfo = "";
      let replyContext = "";

      if (currentMessage.replyText) {
        replyContext = `!!! ПОЛЬЗОВАТЕЛЬ ОТВЕТИЛ НА СООБЩЕНИЕ:\n"${currentMessage.replyText}"`;
      }

      if (userInstruction) personalInfo += `\n!!! СПЕЦ-ИНСТРУКЦИЯ !!!\n${userInstruction}\n`;

      if (userProfile) {
        const score = userProfile.relationship || 50;
        let relationText = "";
        if (score <= 20) relationText = `СТАТУС: ВРАГ (${score}/100). Отвечай грубо, с сарказмом.`;
        else if (score <= 40) relationText = `СТАТУС: ХОЛОД (${score}/100). Язви, не доверяй.`;
        else if (score >= 80) relationText = `СТАТУС: БРАТАН (${score}/100). Поддерживай, шути по-доброму.`;

        personalInfo += `\n--- ДОСЬЕ ---\nФакты: ${userProfile.facts || "Нет"}\n${relationText}\n-----------------\n`;
      }

      // Проверяем, не просят ли объяснить предыдущую спонтанную реакцию
      const lastBotMessage = history.length > 0 ? history[history.length - 1] : null;
      const isAskingToExplain = /что смешного|почему смешно|объясни/i.test(currentMessage.text) && lastBotMessage?.type === 'spontaneous_reaction';

      let fullPromptText;
      if (isAskingToExplain) {
        fullPromptText = prompts.explainJoke({ 
          history: contextStr, 
          joke: lastBotMessage.text 
        });
      } else {
        fullPromptText =
          prompts.mainChat({
            time: this.getCurrentTime(),
            isSpontaneous: isSpontaneous,
            userMessage: currentMessage.text,
            replyContext: replyContext,
            history: contextStr,
            personalInfo: personalInfo,
            senderName: currentMessage.sender
          });
      }

      promptParts.push({ text: fullPromptText });

      console.log(`[DEBUG AI] Отправляю запрос...`);

      let text = '';
      let response = {}; // Инициализируем response для доступа к метаданным

      // Проверяем, используем ли мы OpenRouter
      if (this.currentModel.provider === 'openrouter') {
        const openRouterResponse = await this.callOpenRouter({
          model: this.currentModel.name,
          messages: [
            {
              role: 'system',
              content: 'Ты - Жмых, остроумный и саркастичный бот. Отвечай кратко и с юмором.'
            },
            {
              role: 'user',
              content: fullPromptText // Для OpenRouter передаем весь промпт как текст
            }
          ],
          temperature: this.currentModel.generationConfig?.temperature || 0.8,
          max_tokens: this.currentModel.generationConfig?.max_tokens || 1000
        });
        text = openRouterResponse.choices[0].message.content;
        // У OpenRouter нет метаданных для источников, поэтому создаем пустой массив
        response.candidates = [];
      } else {
        // Используем Gemini API для других провайдеров
        const result = await this.model.generateContent({ contents: [{ role: 'user', parts: promptParts }] });
        response = result.response;
        text = response.text();
      }

      // === CLEANUP (ОБЯЗАТЕЛЬНО!) ===
      // Убираем только технический мусор, не трогая текст сообщения
      text = text.replace(/^toolcode[\s\S]*?print\(.*?\)\s*/i, ''); // Следы от поиска
      text = text.replace(/^thought[\s\S]*?\n\n/i, ''); // Технический блок мыслей (если API его вернет явно)
      text = text.replace(/```json/g, '').replace(/```/g, '').trim(); // Маркдаун обертки
      // ==============================

      // --- ИСТОЧНИКИ (только для Gemini) ---
      if (this.currentModel.provider !== 'openrouter' && response.candidates && response.candidates[0]?.groundingMetadata) {
        const metadata = response.candidates[0].groundingMetadata;
        if (metadata.groundingChunks) {
          const links = [];
          metadata.groundingChunks.forEach(chunk => {
            if (chunk.web && chunk.web.uri) {
              let siteName = "Источник";
              try { siteName = chunk.web.title || "Источник"; } catch (e) { }
              links.push(`[${siteName}](${chunk.web.uri})`);
            }
          });
          const uniqueLinks = [...new Set(links)].slice(0, 3);
          if (uniqueLinks.length > 0) text += "\n\nНашел тут: " + uniqueLinks.join(" • ");
        }
      }
      return text;
    };

    try {
      // executeWithRetry теперь всегда возвращает строку
      return await this.executeWithRetry(requestLogic, "Не знаю, что сказать.");
    } catch (e) {
      console.error(`[CRITICAL AI ERROR]: ${e.message}`);
      return "У меня что-то сломалось в башке. Попробуй позже.";
    }
  }

  // === СПОНТАННАЯ МЫСЛЬ ===
  async getSpontaneousThought(history) {
    const requestLogic = async () => {
      const historyText = history.map(m => `${m.role}: ${m.text}`).join('\n');
      const result = await this.model.generateContent(prompts.spontaneousThought(historyText));
      let text = result.response.text().trim();
      if (text.toUpperCase() === 'NULL') return null;
      return text;
    };
    try { return await this.executeWithRetry(requestLogic); } catch (e) { return null; }
  }

  // === СПОНТАННАЯ РЕАКЦИЯ ===
  async getSpontaneousReaction(history) {
    const requestLogic = async () => {
      const historyText = history.map(m => `${m.role}: ${m.text}`).join('\n');
      const result = await this.model.generateContent(prompts.spontaneousReaction(historyText));
      let text = result.response.text().trim();
      const match = text.match(/(\p{Emoji_Presentation}|\p{Extended_Pictographic})/u);
      if (match && text.toUpperCase().includes('YES')) return match[0];
      return null;
    };
    try { return await this.executeWithRetry(requestLogic); } catch (e) { return null; }
  }

  // === РЕАКЦИЯ ===
  async determineReaction(contextText) {
    const allowed = ["👍", "👎", "❤", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢", "🎉", "🤩", "🤮", "💩", "🙏", "👌", "🕊", "🤡", "🥱", "🥴", "😍", "🐳", "❤‍🔥", "🌚", "🌭", "💯", "🤣", "⚡", "🍌", "🏆", "💔", "🤨", "😐", "🍓", "🍾", "💋", "🖕", "😈", "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈", "😇", "😨", "🤝", "✍", "🤗", "🫡", "🎅", "🎄", "☃", "💅", "🤪", "🗿", "🆒", "💘", "🙉", "🦄", "😘", "💊", "🙊", "😎", "👾", "🤷‍♂", "🤷", "🤷‍♀", "😡"];
    const requestLogic = async () => {
      const result = await this.model.generateContent(prompts.reaction(contextText, allowed.join(" ")));
      let text = result.response.text().trim();
      const match = text.match(/(\p{Emoji_Presentation}|\p{Extended_Pictographic})/u);
      if (match && allowed.includes(match[0])) return match[0];
      return null;
    };
    try { return await this.executeWithRetry(requestLogic); } catch (e) { return null; }
  }

  // === БЫСТРЫЙ АНАЛИЗ (С НОРМАЛЬНОЙ ЧИСТКОЙ) ===
  async analyzeUserImmediate(lastMessages, currentProfile) {
    const requestLogic = async () => {
      const result = await this.model.generateContent(prompts.analyzeImmediate(currentProfile, lastMessages));
      let text = result.response.text();

      // 1. Чистим Markdown-обертку (```json ... ```)
      text = text.replace(/```json/g, '').replace(/```/g, '').trim();

      // 2. Ищем границы JSON (на всякий случай, если бот написал вступление)
      const firstBrace = text.indexOf('{');
      const lastBrace = text.lastIndexOf('}');

      if (firstBrace !== -1 && lastBrace !== -1) {
        text = text.substring(firstBrace, lastBrace + 1);
      }

      // 3. Пробуем парсить
      return JSON.parse(text);
    };

    try {
      return await this.executeWithRetry(requestLogic);
    } catch (e) {
      console.error(`[AI ANALYSIS ERROR]: ${e.message}`);
      // Возвращаем null, чтобы бот не падал, а просто пропускал этот шаг
      return null;
    }
  }

  // === МАССОВЫЙ АНАЛИЗ ===
  async analyzeBatch(messagesBatch, currentProfiles) {
    const requestLogic = async () => {
      const chatLog = messagesBatch.map(m => `[ID:${m.userId}] ${m.name}: ${m.text}`).join('\n');
      const knownInfo = Object.entries(currentProfiles).map(([uid, p]) => `ID:${uid} -> ${p.realName}, ${p.facts}, ${p.attitude}`).join('\n');

      const result = await this.model.generateContent(prompts.analyzeBatch(knownInfo, chatLog));
      let text = result.response.text();
      text = text.replace(/```json/g, '').replace(/```/g, '').trim();
      const firstBrace = text.indexOf('{');
      const lastBrace = text.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1) text = text.substring(firstBrace, lastBrace + 1);
      return JSON.parse(text);
    };
    try { return await this.executeWithRetry(requestLogic); } catch (e) { return null; }
  }

  async generateProfileDescription(profileData, targetName) {
    const requestLogic = async () => {
      const res = await this.model.generateContent(prompts.profileDescription(targetName, profileData));
      return res.response.text();
    };
    try { return await this.executeWithRetry(requestLogic); } catch (e) { return "Не знаю такого."; }
  }

  async generateFlavorText(task, result) {
    const requestLogic = async () => {
      const res = await this.model.generateContent(prompts.flavor(task, result));
      return res.response.text().trim().replace(/^["']|["']$/g, '');
    };
    try { return await this.executeWithRetry(requestLogic); } catch (e) { return `${result}`; }
  }

  async shouldAnswer(lastMessages) {
    const requestLogic = async () => {
      const res = await this.model.generateContent(prompts.shouldAnswer(lastMessages));
      return res.response.text().toUpperCase().includes('YES');
    };
    try { return await this.executeWithRetry(requestLogic); } catch (e) { return false; }
  }

  // === ТРАНСКРИБАЦИЯ ===
  async transcribeAudio(audioBuffer, userName = "Пользователь", mimeType = "audio/ogg") {
    const requestLogic = async () => {
      const parts = [
        { inlineData: { mimeType: mimeType, data: audioBuffer.toString("base64") } },
        { text: prompts.transcription(userName) }
      ];
      const result = await this.model.generateContent({ contents: [{ role: 'user', parts }] });
      let text = result.response.text();
      text = text.replace(/```json/g, '').replace(/```/g, '').trim();
      const firstBrace = text.indexOf('{');
      const lastBrace = text.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1) text = text.substring(firstBrace, lastBrace + 1);
      return JSON.parse(text);
    };
    try { return await this.executeWithRetry(requestLogic); } catch (e) { return null; }
  }

  // === ИТОГИ ДНЯ ===
  async getDailySummary(history) {
    const requestLogic = async () => {
      const historyText = history.map(m => `${m.role}: ${m.text}`).join('\n');
      const res = await this.model.generateContent(prompts.dailySummary(historyText));
      return res.response.text();
    };
    try { return await this.executeWithRetry(requestLogic); } catch (e) { return "Не могу подвести итоги, я слишком устал."; }
  }

  // === ТРЕНДЫ ===
  async getTrendSummary(query) {
    const requestLogic = async () => {
      const res = await this.model.generateContent(prompts.explainTrend(query));
      return res.response.text();
    };
    try { return await this.executeWithRetry(requestLogic); } catch (e) { return "Гугл сломался, я хз че там."; }
  }

  // === ПАРСИНГ НАПОМИНАНИЯ ===
  async parseReminder(userText, contextText = "") {
    const requestLogic = async () => {
      const now = this.getCurrentTime();
      const prompt = prompts.parseReminder(now, userText, contextText);
      const result = await this.model.generateContent(prompt);
      let text = result.response.text();
      text = text.replace(/```json/g, '').replace(/```/g, '').trim();
      const firstBrace = text.indexOf('{');
      const lastBrace = text.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1) text = text.substring(firstBrace, lastBrace + 1);
      return JSON.parse(text);
    };
    try { return await this.executeWithRetry(requestLogic); } catch (e) { return null; }
  }

  // === СУДЬЯ СРАЧЕЙ ===
  async judgeDebate(history) {
    const requestLogic = async () => {
      const historyText = history.map(m => `${m.role}: ${m.text}`).join('\n');
      const res = await this.model.generateContent(prompts.judgeDebate(historyText));
      const text = res.response.text();
      try {
        return JSON.parse(text.replace(/```json|```/g, '').trim());
      } catch (e) {
        console.error("Failed to parse debate JSON", text);
        return null;
      }
    };
    try { return await this.executeWithRetry(requestLogic); } catch (e) { return null; }
  }
}

module.exports = new AiService();