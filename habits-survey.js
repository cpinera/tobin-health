/**
 * habits-survey.js
 * Encuesta diaria de habitos via Telegram (usa axios como index.js)
 *
 * En index.js agregar:
 *   const { initHabitsSurvey } = require('./habits-survey');
 *   initHabitsSurvey(axios, process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID, supabase);
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

let _axios, _token, _chatId, _sb;

async function tgPost(method, data) {
  return _axios.post('https://api.telegram.org/bot' + _token + '/' + method, data);
}

async function sendMsg(chatId, text, extra) {
  return tgPost('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown', ...extra });
}

async function alreadyDone() {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data } = await _sb.from('daily_habits').select('date').eq('date', today).single();
    return !!data;
  } catch(e) { return false; }
}

async function sendHabitsSurvey(chatId) {
  chatId = chatId || _chatId;
  if (await alreadyDone()) {
    console.log('[Habits] Ya completado hoy');
    return;
  }
  const day = new Date().toLocaleDateString('es-CL', {weekday:'long',day:'numeric',month:'long'});
  surveyState[chatId] = { step: 0, date: new Date().toISOString().split('T')[0], answers: {} };
  await sendMsg(chatId, '*Buenos dias! Check-in diario ' + day + '*\nResponde las preguntas de hoy');
  await sendNextStep(chatId);
}

async function sendNextStep(chatId) {
  const st = surveyState[chatId];
  if (!st || st.step >= STEPS.length) return;
  const s = STEPS[st.step];
  await sendMsg(chatId, '*' + s.label + '*\n' + s.q, {
    reply_markup: {
      inline_keyboard: s.ops.map(o => ([{ text: o.t, callback_data: 'habit_' + s.id + '_' + o.v }]))
    }
  });
}

async function handleCallback(query) {
  if (!query.data || !query.data.startsWith('habit_')) return false;
  const chatId = query.message.chat.id;
  const st = surveyState[chatId];
  if (!st) return false;

  await tgPost('answerCallbackQuery', { callback_query_id: query.id });

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
    await tgPost('editMessageText', {
      chat_id: chatId,
      message_id: query.message.message_id,
      text: '*' + step.label + '*\n' + step.q + '\n\nOK: ' + (sel ? sel.t : val),
      parse_mode: 'Markdown'
    });
  } catch(e) {}

  st.step++;
  if (st.step < STEPS.length) {
    await sendNextStep(chatId);
  } else {
    await finishSurvey(chatId, st);
  }
  return true;
}

async function finishSurvey(chatId, st) {
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
    const { error } = await _sb.from('daily_habits').upsert(row, { onConflict: 'date' });
    if (error) throw new Error(error.message);
    await sendMsg(chatId,
      '*Check-in guardado!*\n\n' +
      'Alcohol: ' + (a.alcohol || 'nada') + '\n' +
      'Meditacion: ' + (a.meditado ? 'Si' : 'No') + '\n' +
      'Fuerza: ' + (a.fuerza ? 'Si' : 'No') + '\n' +
      'Energia: ' + (a.energia || 50) + '/100\n' +
      'Animo: ' + (a.animo || 50) + '/100\n\n' +
      '_Visible en tu dashboard -> Habitos_'
    );
  } catch(e) {
    await sendMsg(chatId, 'Error guardando: ' + e.message);
  }
}

function initHabitsSurvey(axiosInstance, token, chatId, supabaseClient) {
  _axios = axiosInstance;
  _token = token;
  _chatId = chatId;
  _sb = supabaseClient;

  cron.schedule('0 10 * * *', async () => {
    console.log('[Habits] Enviando encuesta...');
    try { await sendHabitsSurvey(chatId); }
    catch(e) { console.error('[Habits]', e.message); }
  }, { timezone: 'America/Santiago' });

  console.log('[Habits] Activada - 10:00am Chile');
}

module.exports = { initHabitsSurvey, sendHabitsSurvey, handleCallback };
