const OpenAI = require('openai');
const prompts = require('../core/prompts');
const config = require('../config');

class AiService {
  constructor() {
    this.modelIndex = 0;
    this.models = config.modelRotation;
    this.currentModel = this.models[0];

    // Инициализация OpenAI клиента для DeepSeek
    this.openai = new OpenAI({
      apiKey: config.deepseekApiKey,
      baseURL: 'https://api.deepseek.com/v1'
    });

    console.log('[AI] Initialized with DeepSeek API');
  }

  rotateModel() {
    this.modelIndex = (this.modelIndex + 1) % this.models.length;
    this.currentModel = this.models[this.modelIndex];
    console.log(`[AI] Switched to model: ${this.currentModel.name}`);
  }

  async callDeepseekAPI(params) {
    try {
      const response = await this.openai.chat.completions.create({
        model: 'deepseek-chat',
        messages: params.messages,
        temperature: params.temperature || 0.8,
        max_tokens: params.max_tokens || 1000
      });

      return response;
    } catch (error) {
      console.error('[DEEPSEEK API ERROR]:', error.message);
      throw error;
    }
  }

  async executeWithRetry(apiCallFn, fallbackText = null, context = {}) {
    const maxAttempts = 3;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await apiCallFn();
      } catch (error) {
        console.error(`[AI ERROR] Attempt ${attempt + 1}:`, error.message);

        if (attempt === maxAttempts - 1) {
          console.error('[AI] All attempts failed');
          return fallbackText || "Что-то пошло не так, попробуй позже.";
        }

        // Небольшая задержка между попытками
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  async getResponse(history, currentMessage, imageBuffer = null, mimeType = "image/jpeg", userInstruction = "", userProfile = null, isSpontaneous = false) {
    try {
      // Формируем контекст для промпта
      const context = {
        time: new Date().toLocaleString('ru-RU', {
          timezone: 'Europe/Moscow',
          day: 'numeric',
          month: 'long',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        }),
        senderName: currentMessage.sender || 'Пользователь',
        userMessage: currentMessage.text,
        isSpontaneous: isSpontaneous,
        personalInfo: userProfile ? `Карма: ${userProfile.relationship} (${userProfile.karmaLevel})` : '',
        replyContext: currentMessage.replyText ? `Ответ на: "${currentMessage.replyText}"` : ''
      };

      // Формируем сообщения для API
      const messages = [
        { role: 'system', content: prompts.system() },
        { role: 'user', content: prompts.mainChat(context) }
      ];

      // Добавляем историю
      if (history && history.length > 0) {
        const historyMessages = history.slice(-10).map(msg => ({
          role: msg.role,
          content: msg.text
        }));
        messages.splice(1, 0, ...historyMessages);
      }

      // Добавляем пользовательскую инструкцию
      if (userInstruction) {
        messages.push({ role: 'system', content: userInstruction });
      }

      const response = await this.executeWithRetry(async () => {
        const result = await this.callDeepseekAPI({ messages });
        return result.choices[0].message.content;
      });

      return response || "Я в ахуе, что-то не могу сообразить.";

    } catch (error) {
      console.error('[GET RESPONSE ERROR]:', error);
      return "Блин, что-то сломалось в моей нейронке.";
    }
  }

  async getSpontaneousThought(history) {
    try {
      const messages = [
        { role: 'system', content: prompts.system() },
        { role: 'user', content: prompts.spontaneousThought(history ? history.slice(-10).map(h => `${h.sender || h.role}: ${h.text}`).join('\n') : '') }
      ];

      const response = await this.executeWithRetry(async () => {
        const result = await this.callDeepseekAPI({ messages, temperature: 0.9 });
        return result.choices[0].message.content.trim();
      });

      return response && response !== 'NULL' ? response : null;

    } catch (error) {
      console.error('[SPONTANEOUS THOUGHT ERROR]:', error);
      return null;
    }
  }

  async getDailySummary(history) {
    try {
      // Фильтруем сообщения за текущий день
      const today = new Date();
      today.setHours(0, 0, 0, 0); // Начало дня

      const todayMessages = history ? history.filter(h => {
        const messageDate = new Date(h.timestamp);
        messageDate.setHours(0, 0, 0, 0);
        return messageDate.getTime() === today.getTime();
      }) : [];

      const historyText = todayMessages.map(h => `${h.sender || h.role}: ${h.text}`).join('\n');

      const messages = [
        { role: 'system', content: prompts.system() },
        { role: 'user', content: prompts.dailySummary(historyText) }
      ];

      const response = await this.executeWithRetry(async () => {
        const result = await this.callDeepseekAPI({ messages, temperature: 0.8 });
        return result.choices[0].message.content;
      });

      return response || "Сегодня было так скучно, что даже я заскучал.";

    } catch (error) {
      console.error('[DAILY SUMMARY ERROR]:', error);
      return "Не смогу подвести итоги, мой мозг вскипел.";
    }
  }

  async getJudgeDebate(history) {
    try {
      const historyText = history ? history.slice(-20).map(h => `${h.sender || h.role}: ${h.text}`).join('\n') : '';

      const messages = [
        { role: 'system', content: prompts.system() },
        { role: 'user', content: prompts.judgeDebate(historyText) }
      ];

      const response = await this.executeWithRetry(async () => {
        const result = await this.callDeepseekAPI({ messages, temperature: 0.9 });
        return result.choices[0].message.content;
      });

      return response || "Я не вижу тут спора, вы просто дружите.";

    } catch (error) {
      console.error('[JUDGE DEBATE ERROR]:', error);
      return "Не могу рассудить, у меня сегодня судейский день.";
    }
  }

  async determineReaction(text) {
    try {
      const messages = [
        { role: 'system', content: prompts.system() },
        { role: 'user', content: prompts.reaction(text) }
      ];

      const response = await this.executeWithRetry(async () => {
        const result = await this.callDeepseekAPI({ messages, temperature: 0.8 });
        return result.choices[0].message.content.trim();
      });

      return response && response !== 'NULL' ? response : null;

    } catch (error) {
      console.error('[DETERMINE REACTION ERROR]:', error);
      return null;
    }
  }

  async analyzeBatch(batchData) {
    try {
      const messages = [
        { role: 'system', content: prompts.system() },
        { role: 'user', content: prompts.analyzeBatch(batchData) }
      ];

      const response = await this.executeWithRetry(async () => {
        const result = await this.callDeepseekAPI({ messages, temperature: 0.3 });
        return result.choices[0].message.content;
      });

      return response || "{}";

    } catch (error) {
      console.error('[ANALYZE BATCH ERROR]:', error);
      return "{}";
    }
  }

  async getUserDossier(profile) {
    try {
      const messages = [
        { role: 'system', content: prompts.system() },
        {
          role: 'user',
          content: prompts.userDossier(
            profile.realName || "Аноним",
            profile.facts,
            profile.attitude,
            profile.relationship
          )
        }
      ];

      const response = await this.executeWithRetry(async () => {
        const result = await this.callDeepseekAPI({ messages, temperature: 0.9 });
        return result.choices[0].message.content;
      });

      return response || "Ничего не скажу, лень.";

    } catch (error) {
      console.error('[GET USER DOSSIER ERROR]:', error);
      return "Мои файлы на этого типа сгорели.";
    }
  }
}

module.exports = new AiService();