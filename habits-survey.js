/**
 * habits-survey.js
 * Encuesta diaria de habitos via Telegram
 * Compatible con el agente tobin-health (usa axios, no node-telegram-bot-api)
 *
 * Uso en index.js:
 *   const { initHabitsSurvey } = require('./habits-survey');
 *   // Despues de definir sendTelegram y supabase:
 *   initHabitsSurvey(sendTelegram, axios, process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID, supabase);
 *
 *   // En el webhook handler, agregar antes del switch/if existente:
 *   if (msg.callback_query && await handleHabitsCallback(msg.callback_query)) return;
 */

const cron = require('node-cron');
const surveyState = {};

let _sendTelegram, _axios, _token, _chatId, _sb;

const STEPS = [
  { id: 'alcohol',  label: 'ALCOHOL',    q: 'Tomaste alcohol ayer?',
    ops: [{t:'Nada',v:'nada'},{t:'Poco (1-2)',v:'poco'},{t:'Medio (3-4)',v:'medio'},{t:'Harto (+4)',v:'alto'}] },
  { id: 'meditado', label: 'MEDITACION', q: 'Meditaste hoy?',
    ops: [{t:'Si',v:'true'},{t:'No',v:'false'}] },
  { id: 'fuerza',   label: 'FUERZA',     q: 'Hiciste entrenamiento de fuerza hoy?',
    ops: [{t:'Si',v:'true'},{t:'No',v:'false'}] },
  { id: 'energia',  label: 'ENERGIA',    q: 'Como esta tu energia hoy? (0=bajo, 100=alto)',
    ops: [{t:'20',v:'20'},{t:'40',v:'40'},{t:'60',v:'60'},{t:'80',v:'80'},{t:'100',v:'100'}] },
  { id: 'animo',    label: 'ANIMO',      q: 'Como esta tu animo?',
    ops: [{t:'20',v:'20'},{t:'40',v:'40'},{t:'60',v:'60'},{t:'80',v:'80'},{t:'100',v:'100'}] }
];

async function alreadyDone() {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data } = await _sb.from('daily_habits').select('date').eq('date', today).single();
    return !!data;
  } catch(e) { return false; }
}

async function sendWithButtons(chatId, text, buttons) {
  await _axios.post(`https://api.telegram.org/bot${_token}/sendMessage`, {
    chat_id: chatId, text, parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons }
  });
}

async function editMessage(chatId, messageId, text) {
  try {
    await _axios.post(`https://api.telegram.org/bot${_token}/editMessageText`, {
      chat_id: chatId, message_id: messageId, text, parse_mode: 'Markdown'
    });
  } catch(e) {}
}

async function answerCallback(callbackQueryId) {
  try {
    await _axios.post(`https://api.telegram.org/bot${_token}/answerCallbackQuery`, { callback_query_id: callbackQueryId });
  } catch(e) {}
}

async function sendHabitsSurvey(chatId) {
  if (await alreadyDone()) { console.log('[Habits] Ya completado hoy'); return; }
  const day = new Date().toLocaleDateString('es-CL', {weekday:'long', day:'numeric', month:'long'});
  surveyState[chatId] = { step: 0, date: new Date().toISOString().split('T')[0], answers: {} };
  await _sendTelegram(`*Buenos dias! Check-in diario - ${day}*\nResponde las preguntas de hoy`, chatId);
  await sendNextStep(chatId);
}

async function sendNextStep(chatId) {
  const st = surveyState[chatId];
  if (!st || st.step >= STEPS.length) return;
  const s = STEPS[ st.step];
  await sendWithButtons(chatId, `*${s.label}*\n${s.q}`, s.ops.map(o => ([{ text: o.t, callback_data: `habit_${s.id}_${o.}` }])));
}

async function handleHabitsCallback(query) {
  if (!query.data?.startsWith('habit_')) return false;
  const chatId = String(query.message.chat.id);
  const st = surveyState[chatId];
  if (!st) return false;
  await answerCallback(query.id);
  const [,field,...vp] = query.data.split('_');
  const val = vp.join('_');
  const step = STEPS[st.step];
  if (!step || step.id !== field) return false;
  st.answers[field] = (field==='meditado'||field==='fuerza')?(val==='true'):(field==='energia'||field==='animo')?parseInt(val):val;
  const sel = step.ops.find(o=>o.v===val);
  await editMessage(chatId, query.message.message_id, `*${step.label}*\n${step.q}\n\n* ${sel?.t||val}`);
  st.step++;
  if (st.step < STEPS.length) { await sendNextStep(chatId); }
  else { await finishSurvey(chatId, st); }
  return true;
}

async function finishSurvey(chatId, st) {
  const a = st.answers;
  const row = { date: st.date, agua: a.alcohol||'nada', meditado:a.meditado??false, fuerza:a.fuerza??false, energia:a.energia||50, animo:a.animo||50 };
  delete surveyState[chatId];
  try {
    const {error} = await _sb.from('daily_habits').upsert(row,{onConflict:'date'});
    if (error) throw new Error(error.message);
    const ee = a.energia>=80?'Alto':a.energia>=50?'Medio':'Bajo';
    const me = a.animo>=80?'Bueno':a.animo>=50?'Ok':'Bajo';
    await _sendTelegram(`*Check-in guardado!*\n\nAlcohol: ${a.alcohol||'nada'}\nMeditacion: ${a.meditado?'Si':'No'}\nFuerza: ${a.fuerza?'Si':'No'}\nEnergia: ${ee} (${a.energia}/100)\nAnimo: ${me} (${a.animo}/100)\n\n_Visible en tu dashboard -> Habitos_`,chatId);
  } catch(e) { await _sendTelegram(`Error: ${e.message}`,chatId); }
}

function initHabitsSurvey(sendTelegramFn, axiosInstance, token, chatId, supabaseClient) {
  _sendTelegram = sendTelegramFn; _axios = axiosInstance; _token = token; _chatId = String(chatId); _sb = supabaseClient;
  cron.schedule('0 10 * * *', async () => {
    console.log('[Habits] Enviando encuesta...');
    try { await sendHabitsSurvey(_chatId); } catch(e) { console.error('[Habits]',e.message); }
  }, { timezone: 'America/Santiago' });
  console.log('[Habits] Activada - 10:00am Chile');
}

module.exports = { initHabitsSurvey, sendHabitsSurvey, handleHabitsCallback };
