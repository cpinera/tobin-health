/**
 * habits-telegram.js
 * Encuesta de hábitos diaria por Telegram a las 10am
 * 
 * INTEGRAR EN index.js:
 * 
 * 1. const { sendHabitsSurvey, handleHabitsReply } = require('./habits-telegram');
 * 
 * 2. En el cron de las mañanas (10am):
 *    cron.schedule('0 10 * * *', () => sendHabitsSurvey(bot, CHAT_ID));
 * 
 * 3. En el webhook handler, antes del agente general:
 *    if (await handleHabitsReply(bot, msg)) return; // handled
 */

const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Estado de conversación por usuario (en memoria)
const surveyState = {};

// ── Enviar encuesta matutina ──────────────────────────────────────────────────
async function sendHabitsSurvey(bot, chatId) {
  const today = new Date().toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' });

  // Verificar si ya completó hoy
  const todayStr = new Date().toISOString().split('T')[0];
  const { data } = await sb.from('daily_habits').select('date').eq('date', todayStr).single();
  if (data) {
    console.log('[Habits] Ya completado hoy, no se envía encuesta');
    return;
  }

  surveyState[chatId] = { step: 'agua', date: todayStr };

  await bot.sendMessage(chatId,
    `☀️ *Buenos días! Check-in de hábitos — ${today}*\n\n` +
    `💧 ¿Cómo estuvo tu hidratación ayer?`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '🔴 Poco', callback_data: 'habit_agua_poco' },
          { text: '🟡 Medio', callback_data: 'habit_agua_medio' },
          { text: '🟢 Bien', callback_data: 'habit_agua_alto' },
        ]]
      }
    }
  );
}

// ── Manejar respuestas de la encuesta ─────────────────────────────────────────
async function handleHabitsReply(bot, msg) {
  // Handle callback queries (inline buttons)
  if (msg.callback_query) {
    const query = msg.callback_query;
    const chatId = query.message.chat.id;
    const data = query.data;

    if (!data.startsWith('habit_')) return false;

    const state = surveyState[chatId];
    if (!state) return false;

    await bot.answerCallbackQuery(query.id);

    const [, field, value] = data.split('_');

    if (field === 'agua') {
      state.agua = value;
      state.step = 'meditado';

      await bot.sendMessage(chatId,
        `🧘 ¿Meditaste hoy?`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Sí', callback_data: 'habit_meditado_true' },
              { text: '❌ No', callback_data: 'habit_meditado_false' },
            ]]
          }
        }
      );
      return true;
    }

    if (field === 'meditado') {
      state.meditado = value === 'true';
      state.step = 'energia';

      await bot.sendMessage(chatId,
        `⚡ ¿Cómo está tu *energía* hoy? (0 = sin energía, 100 = máxima)`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '20', callback_data: 'habit_energia_20' },
              { text: '40', callback_data: 'habit_energia_40' },
              { text: '60', callback_data: 'habit_energia_60' },
              { text: '80', callback_data: 'habit_energia_80' },
              { text: '100', callback_data: 'habit_energia_100' },
            ]]
          }
        }
      );
      return true;
    }

    if (field === 'energia') {
      state.energia = parseInt(value);
      state.step = 'animo';

      await bot.sendMessage(chatId,
        `😊 ¿Cómo está tu *ánimo*? (0 = muy bajo, 100 = excelente)`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '20', callback_data: 'habit_animo_20' },
              { text: '40', callback_data: 'habit_animo_40' },
              { text: '60', callback_data: 'habit_animo_60' },
              { text: '80', callback_data: 'habit_animo_80' },
              { text: '100', callback_data: 'habit_animo_100' },
            ]]
          }
        }
      );
      return true;
    }

    if (field === 'animo') {
      state.animo = parseInt(value);
      state.step = 'done';

      // Save to Supabase
      const row = {
        date: state.date,
        agua: state.agua,
        meditado: state.meditado,
        energia: state.energia,
        animo: state.animo
      };

      const { error } = await sb
        .from('daily_habits')
        .upsert(row, { onConflict: 'date' });

      delete surveyState[chatId];

      if (error) {
        await bot.sendMessage(chatId, `❌ Error guardando hábitos: ${error.message}`);
        return true;
      }

      // Send summary + coaching note
      const emoji_agua = { poco: '🔴', medio: '🟡', alto: '🟢' }[state.agua];
      const emoji_med = state.meditado ? '✅' : '❌';
      const emoji_e = state.energia >= 70 ? '🟢' : state.energia >= 40 ? '🟡' : '🔴';
      const emoji_a = state.animo >= 70 ? '😄' : state.animo >= 40 ? '😐' : '😔';

      await bot.sendMessage(chatId,
        `✅ *Check-in guardado!*\n\n` +
        `💧 Hidratación: ${emoji_agua} ${state.agua}\n` +
        `🧘 Meditación: ${emoji_med}\n` +
        `⚡ Energía: ${emoji_e} ${state.energia}/100\n` +
        `😊 Ánimo: ${emoji_a} ${state.animo}/100\n\n` +
        `_Visible en tu dashboard en la pestaña Hábitos_`,
        { parse_mode: 'Markdown' }
      );
      return true;
    }

    return false;
  }

  return false;
}

// ── Integración con index.js ──────────────────────────────────────────────────
// Ejemplo de uso completo en index.js:
/*

const cron = require('node-cron');
const { sendHabitsSurvey, handleHabitsReply } = require('./habits-telegram');

const CHAT_ID = process.env.TELEGRAM_CHAT_ID; // tu chat ID personal

// Cron 10am todos los días
cron.schedule('0 10 * * *', async () => {
  await sendHabitsSurvey(bot, CHAT_ID);
}, { timezone: 'America/Santiago' });

// En el webhook handler (bot.on('callback_query') y bot.on('message')):
bot.on('callback_query', async (query) => {
  const handled = await handleHabitsReply(bot, { callback_query: query });
  if (!handled) {
    // tu lógica existente...
  }
});

*/

module.exports = { sendHabitsSurvey, handleHabitsReply };
