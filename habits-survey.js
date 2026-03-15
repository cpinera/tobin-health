/**
 * habits-survey.js
 * Cuestionario diario de hábitos via Telegram
 * 
 * INTEGRACIÓN EN index.js (3 pasos):
 * 
 * 1. Al inicio del archivo:
 *    const { initHabitsSurvey } = require('./habits-survey');
 * 
 * 2. Después de crear el bot (donde ya tienes bot = new TelegramBot(...)):
 *    initHabitsSurvey(bot, process.env.TELEGRAM_CHAT_ID);
 * 
 * 3. Ya está. El cron de 10am enviará la encuesta automáticamente.
 *    Si ya tienes un cron a las 10am, elimínalo o comenta esa línea.
 */

const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Estado de encuesta en memoria por chat
const surveyState = {};

// ── Configuración de la encuesta ──────────────────────────────────────────────
const SURVEY_STEPS = [
  {
    id: 'alcohol',
    label: '🍺 ALCOHOL',
    question: '¿Tomaste alcohol ayer?',
    options: [
      { text: '🙌 Nada', value: 'nada' },
      { text: '🍺 Poco (1-2)', value: 'poco' },
      { text: '🍻 Medio (3-4)', value: 'medio' },
      { text: '🥴 Harto (+4)', value: 'alto' },
    ]
  },
  {
    id: 'meditado',
    label: '🧘 MEDITACIÓN',
    question: '¿Meditaste hoy?',
    options: [
      { text: '✅ Sí', value: 'true' },
      { text: '❌ No', value: 'false' },
    ]
  },
  {
    id: 'fuerza',
    label: '🏋️ FUERZA',
    question: '¿Hiciste entrenamiento de fuerza hoy?',
    options: [
      { text: '💪 Sí', value: 'true' },
      { text: '❌ No', value: 'false' },
    ]
  },
  {
    id: 'energia',
    label: '⚡ ENERGÍA',
    question: '¿Cómo está tu energía hoy?',
    options: [
      { text: '😴 20', value: '20' },
      { text: '😐 40', value: '40' },
      { text: '🙂 60', value: '60' },
      { text: '😊 80', value: '80' },
      { text: '🚀 100', value: '100' },
    ]
  },
  {
    id: 'animo',
    label: '😊 ÁNIMO',
    question: '¿Cómo está tu ánimo?',
    options: [
      { text: '😔 20', value: '20' },
      { text: '😐 40', value: '40' },
      { text: '🙂 60', value: '60' },
      { text: '😄 80', value: '80' },
      { text: '🤩 100', value: '100' },
    ]
  }
];

// ── Verificar si ya completó hoy ─────────────────────────────────────────────
async function alreadyCompletedToday() {
  const today = new Date().toISOString().split('T')[0];
  try {
    const { data } = await sb
      .from('daily_habits')
      .select('date')
      .eq('date', today)
      .single();
    return !!data;
  } catch(e) {
    return false;
  }
}

// ── Enviar encuesta ───────────────────────────────────────────────────────────
async function sendHabitsSurvey(bot, chatId) {
  if (await alreadyCompletedToday()) {
    console.log('[Habits] Ya completado hoy, saltando encuesta');
    return;
  }

  const today = new Date().toLocaleDateString('es-CL', {
    weekday: 'long', day: 'numeric', month: 'long'
  });

  surveyState[chatId] = {
    step: 0,
    date: new Date().toISOString().split('T')[0],
    answers: {}
  };

  await bot.sendMessage(chatId,
    `☀️ *Buenos días! Check-in diario — ${today}*\n\nResponde las preguntas de hoy 👇`,
    { parse_mode: 'Markdown' }
  );

  await sendNextQuestion(bot, chatId);
}

// ── Enviar siguiente pregunta ─────────────────────────────────────────────────
async function sendNextQuestion(bot, chatId) {
  const state = surveyState[chatId];
  if (!state || state.step >= SURVEY_STEPS.length) return;

  const step = SURVEY_STEPS[state.step];
  const keyboard = step.options.map(opt => ([{
    text: opt.text,
    callback_data: `habit_${step.id}_${opt.value}`
  }]));

  await bot.sendMessage(chatId,
    `*${step.label}*\n${step.question}`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    }
  );
}

// ── Manejar respuesta ─────────────────────────────────────────────────────────
async function handleHabitsCallback(bot, query) {
  const data = query.data;
  if (!data || !data.startsWith('habit_')) return false;

  const chatId = query.message.chat.id;
  const state = surveyState[chatId];
  if (!state) return false;

  await bot.answerCallbackQuery(query.id);

  // Parse: habit_campo_valor
  const parts = data.split('_');
  const field = parts[1];
  const value = parts.slice(2).join('_');

  // Validate it's the current step
  const currentStep = SURVEY_STEPS[state.step];
  if (currentStep.id !== field) return false;

  // Store answer
  if (field === 'meditado' || field === 'fuerza') {
    state.answers[field] = value === 'true';
  } else if (field === 'energia' || field === 'animo') {
    state.answers[field] = parseInt(value);
  } else {
    state.answers[field] = value;
  }

  // Edit message to show selected
  const selectedOption = currentStep.options.find(o => o.value === value);
  try {
    await bot.editMessageText(
      `*${currentStep.label}*\n${currentStep.question}\n\n✅ ${selectedOption?.text || value}`,
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown'
      }
    );
  } catch(e) {}

  state.step++;

  if (state.step < SURVEY_STEPS.length) {
    // Next question
    await sendNextQuestion(bot, chatId);
  } else {
    // All done — save to Supabase
    await finishSurvey(bot, chatId, state);
  }

  return true;
}

// ── Guardar en Supabase y mostrar resumen ─────────────────────────────────────
async function finishSurvey(bot, chatId, state) {
  const row = {
    date: state.date,
    agua: state.answers.alcohol || 'nada', // campo agua = alcohol en la tabla
    meditado: state.answers.meditado ?? false,
    fuerza: state.answers.fuerza ?? false,
    energia: state.answers.energia || 50,
    animo: state.answers.animo || 50,
  };

  delete surveyState[chatId];

  try {
    const { error } = await sb
      .from('daily_habits')
      .upsert(row, { onConflict: 'date' });

    if (error) throw new Error(error.message);

    // Summary
    const a = state.answers;
    const e_emoji = a.energia >= 80 ? '🟢' : a.energia >= 50 ? '🟡' : '🔴';
    const m_emoji = a.animo >= 80 ? '😄' : a.animo >= 50 ? '🙂' : '😔';
    const alc_emoji = { nada: '🙌', poco: '🍺', medio: '🍻', alto: '🥴' }[a.alcohol] || '🙌';

    await bot.sendMessage(chatId,
      `✅ *Check-in guardado!*\n\n` +
      `🍺 Alcohol: ${alc_emoji} ${a.alcohol || 'nada'}\n` +
      `🧘 Meditación: ${a.meditado ? '✅ Sí' : '❌ No'}\n` +
      `🏋️ Fuerza: ${a.fuerza ? '💪 Sí' : '❌ No'}\n` +
      `⚡ Energía: ${e_emoji} ${a.energia}/100\n` +
      `😊 Ánimo: ${m_emoji} ${a.animo}/100\n\n` +
      `_Visible en tu dashboard → Hábitos_`,
      { parse_mode: 'Markdown' }
    );
  } catch(e) {
    await bot.sendMessage(chatId, `❌ Error guardando: ${e.message}`);
  }
}

// ── Inicializar — llamar desde index.js ───────────────────────────────────────
function initHabitsSurvey(bot, chatId) {
  // Cron diario 10:00am hora Chile
  cron.schedule('0 10 * * *', async () => {
    console.log('[Habits] Enviando encuesta matutina...');
    try {
      await sendHabitsSurvey(bot, chatId);
    } catch(e) {
      console.error('[Habits] Error:', e.message);
    }
  }, { timezone: 'America/Santiago' });

  // Handler de respuestas — registrar en el bot
  bot.on('callback_query', async (query) => {
    try {
      await handleHabitsCallback(bot, query);
    } catch(e) {
      console.error('[Habits callback] Error:', e.message);
    }
  });

  console.log('[Habits] Encuesta diaria activada — 10:00am Chile');
}

// También exportar funciones individuales para uso manual
module.exports = {
  initHabitsSurvey,
  sendHabitsSurvey,
  handleHabitsCallback
};
