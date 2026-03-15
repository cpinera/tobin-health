/**
 * habits-survey.js
 * Encuesta diaria de habitos via Telegram
 * 
 * Uso en index.js:
 *   const { initHabitsSurvey } = require('./habits-survey');
 *   initHabitsSurvey(bot, process.env.TELEGRAM_CHAT_ID, supabase);
 */

const cron = require('node-cron');
const surveyState = {};

const STEPS = [
  { id:'alcohol', label:'ALCOHOL', q:'Tomaste alcohol ayer?',
    ops:[{t:'Nada',v:'nada'},{t:'Poco (1-2)',v:'poco'},{t:'Medio (3-4)',v:'medio'},{t:'Harto (+4)',v:'alto'}] },
  { id:'meditado', label:'MEDITACION', q:'Meditaste hoy?',
    ops:[{t:'Si',v:'true'},{t:'No',v:'false'}] },
  { id:'fuerza', label:'FUERZA', q:'Hiciste entrenamiento de fuerza hoy?',
    ops:[{t:'Si',v:'true'},{t:'No',v:'false'}] },
  { id:'energia', label:'ENERGIA', q:'Como esta tu energia hoy? (0-100)',
    ops:[{t:'20',v:'20'},{t:'40',v:'40'},{t:'60',v:'60'},{t:'80',v:'80'},{t:'100',v:'100'}] },
  { id:'animo', label:'ANIMO', q:'Como esta tu animo? (0-100)',
    ops:[{t:'20',v:'20'},{t:'40',v:'40'},{t:'60',v:'60'},{t:'80',v:'80'},{t:'100',v:'100'}] }
];

let sb = null; // set by initHabitsSurvey

async function alreadyDone() {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data } = await sb.from('daily_habits').select('date').eq('date', today).single();
    return !!data;
  } catch(e) { return false; }
}

async function sendHabitsSurvey(bot, chatId) {
  if (await alreadyDone()) {
    console.log('[Habits] Ya completado hoy');
    return;
  }
  const day = new Date().toLocaleDateString('es-CL', {weekday:'long',day:'numeric',month:'long'});
  surveyState[chatId] = { step: 0, date: new Date().toISOString().split('T')[0], answers: {} };
  await bot.sendMessage(chatId,
    '*Buenos dias! Check-in diario ' + day + '*\n\nResponde las preguntas de hoy',
    { parse_mode: 'Markdown' }
  );
  await sendNext(bot, chatId);
}

async function sendNext(bot, chatId) {
  const st = surveyState[chatId];
  if (!st || st.step >= STEPS.length) return;
  const s = STEPS[st.step];
  await bot.sendMessage(chatId, '*' + s.label + '*\n' + s.q, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: s.ops.map(o => ([{ text: o.t, callback_data: 'habit_' + s.id + '_' + o.v }])) }
  });
}

async function handleHabitsCallback(bot, query) {
  if (!query.data || !query.data.startsWith('habit_')) return false;
  const chatId = query.message.chat.id;
  const st = surveyState[chatId];
  if (!st) return false;
  await bot.answerCallbackQuery(query.id);
  const parts = query.data.split('_');
  const field = parts[1];
  const val = parts.slice(2).join('_');
  const step = STEPS[st.step];
  if (step.id !== field) return false;
  if (field === 'meditado' || field === 'fuerza') {
    st.answers[field] = val === 'true';
  } else if (field === 'energia' || field === 'animo') {
    st.answers[field] = parseInt(val);
  } else {
    st.answers[field] = val;
  }
  const sel = step.ops.find(o => o.v === val);
  try {
    await bot.editMessageText('*' + step.label + '*\n' + step.q + '\n\n* ' + (sel ? sel.t : val), {
      chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown'
    });
  } catch(e) {}
  st.step++;
  if (st.step < STEPS.length) {
    await sendNext(bot, chatId);
  } else {
    await finish(bot, chatId, st);
  }
  return true;
}

async function finish(bot, chatId, st) {
  const a = st.answers;
  const row = {
    date: st.date,
    agua: a.alcohol || 'nada',
    meditado: a.meditado ?? false,
    fuerza: a.fuerza ?? false,
    energia: a.energia || 50,
    animo: a.animo || 50
  };
  delete surveyState[chatId];
  try {
    const { error } = await sb.from('daily_habits').upsert(row, { onConflict: 'date' });
    if (error) throw new Error(error.message);
    await bot.sendMessage(chatId,
      '*Check-in guardado!*\n\n' +
      'Alcohol: ' + (a.alcohol || 'nada') + '\n' +
      'Meditacion: ' + (a.meditado ? 'Si' : 'No') + '\n' +
      'Fuerza: ' + (a.fuerza ? 'Si' : 'No') + '\n' +
      'Energia: ' + (a.energia || 50) + '/100\n' +
      'Animo: ' + (a.animo || 50) + '/100\n\n' +
      '_Visible en tu dashboard -> Habitos_',
      { parse_mode: 'Markdown' }
    );
  } catch(e) {
    await bot.sendMessage(chatId, 'Error guardando: ' + e.message);
  }
}

function initHabitsSurvey(bot, chatId, supabaseClient) {
  sb = supabaseClient; // use the shared client from index.js

  cron.schedule('0 10 * * *', async () => {
    console.log('[Habits] Enviando encuesta...');
    try { await sendHabitsSurvey(bot, chatId); }
    catch(e) { console.error('[Habits]', e.message); }
  }, { timezone: 'America/Santiago' });

  bot.on('callback_query', async (q) => {
    try { await handleHabitsCallback(bot, q); }
    catch(e) { console.error('[Habits callback]', e.message); }
  });

  console.log('[Habits] Activada - 10:00am Chile');
}

module.exports = { initHabitsSurvey, sendHabitsSurvey, handleHabitsCallback };
