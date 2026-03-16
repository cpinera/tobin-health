const cron = require('node-cron');
const surveyState = {};
let _send, _axios, _token, _chatId, _sb;

const STEPS = [
  {id:'alcohol', label:'ALCOHOL', q:'Tomaste alcohol ayer?', ops:[{t:'Nada',v:'nada'},{t:'Poco',v:'poco'},{t:'Medio',v:'medio'},{t:'Harto',v:'alto'}]},
  {id:'meditado', label:'MEDITACION', q:'Meditaste hoy?', ops:[{t:'Si',v:'true'},{t:'No',v:'false'}]},
  {id:'fuerza', label:'FUERZA', q:'Hiciste fuerza hoy?', ops:[{t:'Si',v:'true'},{t:'No',v:'false'}]},
  {id:'energia', label:'ENERGIA', q:'Como esta tu energia? (0-100)', ops:[{t:'20',v:'20'},{t:'40',v:'40'},{t:'60',v:'60'},{t:'80',v:'80'},{t:'100',v:'100'}]},
  {id:'animo', label:'ANIMO', q:'Como esta tu animo?', ops:[{t:'20',v:'20'},{t:'40',v:'40'},{t:'60',v:'60'},{t:'80',v:'80'},{t:'100',v:'100'}]}
];

async function alreadyDone() {
  try {
    const today = new Date().toISOString().split('T')[0];
    const {data} = await _sb.from('daily_habits').select('date').eq('date', today).single();
    return !!data;
  } catch(e) { return false; }
}

async function sendWithButtons(chatId, text, buttons) {
  await _axios.post('https://api.telegram.org/bot' + _token + '/sendMessage', {
    chat_id: chatId, text, parse_mode: 'Markdown',
    reply_markup: {inline_keyboard: buttons}
  });
}

async function editMsg(chatId, msgId, text) {
  try {
    await _axios.post('https://api.telegram.org/bot' + _token + '/editMessageText', {
      chat_id: chatId, message_id: msgId, text, parse_mode: 'Markdown'
    });
  } catch(e) {}
}

async function answerCb(id) {
  try {
    await _axios.post('https://api.telegram.org/bot' + _token + '/answerCallbackQuery', {callback_query_id: id});
  } catch(e) {}
}

async function sendHabitsSurvey(chatId) {
  if (await alreadyDone()) { console.log('[Habits] Ya completado'); return; }
  const day = new Date().toLocaleDateString('es-CL', {weekday:'long', day:'numeric', month:'long'});
  surveyState[chatId] = {step: 0, date: new Date().toISOString().split('T')[0], answers: {}};
  await _send('*Buenos dias! Check-in - ' + day + '*\nResponde las preguntas', chatId);
  await sendNext(chatId);
}

async function sendNext(chatId) {
  const st = surveyState[chatId];
  if (!st || st.step >= STEPS.length) return;
  const s = STEPS[st.step];
  await sendWithButtons(chatId, '*' + s.label + '*\n' + s.q,
    s.ops.map(function(o) { return [{text: o.t, callback_data: 'habit_' + s.id + '_' + o.v}]; })
  );
}

async function handleHabitsCallback(query) {
  if (!query.data || !query.data.startsWith('habit_')) return false;
  const chatId = String(query.message.chat.id);
  const st = surveyState[chatId];
  if (!st) return false;
  await answerCb(query.id);
  const parts = query.data.split('_');
  const field = parts[1];
  const val = parts.slice(2).join('_');
  const step = STEPS[st.step];
  if (!step || step.id !== field) return false;
  if (field === 'meditado' || field === 'fuerza') {
    st.answers[field] = val === 'true';
  } else if (field === 'energia' || field === 'animo') {
    st.answers[field] = parseInt(val);
  } else {
    st.answers[field] = val;
  }
  const sel = step.ops.find(function(o) { return o.v === val; });
  await editMsg(chatId, query.message.message_id, '*' + step.label + '*\n' + step.q + '\n\n* ' + (sel ? sel.t : val));
  st.step++;
  if (st.step < STEPS.length) {
    await sendNext(chatId);
  } else {
    await finish(chatId, st);
  }
  return true;
}

async function finish(chatId, st) {
  const a = st.answers;
  const row = {
    date: st.date,
    agua: a.alcohol || 'nada',
    meditado: a.meditado != null ? a.meditado : false,
    fuerza: a.fuerza != null ? a.fuerza : false,
    energia: a.energia || 50,
    animo: a.animo || 50
  };
  delete surveyState[chatId];
  try {
    const result = await _sb.from('daily_habits').upsert(row, {onConflict: 'date'});
    if (result.error) throw new Error(result.error.message);
    const msg = '*Check-in guardado!*\n\nAlcohol: ' + (a.alcohol || 'nada') +
      '\nMeditacion: ' + (a.meditado ? 'Si' : 'No') +
      '\nFuerza: ' + (a.fuerza ? 'Si' : 'No') +
      '\nEnergia: ' + (a.energia || 50) + '/100' +
      '\nAnimo: ' + (a.animo || 50) + '/100' +
      '\n\n_Visible en tu dashboard_';
    await _send(msg, chatId);
  } catch(e) {
    await _send('Error: ' + e.message, chatId);
  }
}

function initHabitsSurvey(sendFn, axiosInst, token, chatId, sb) {
  _send = sendFn;
  _axios = axiosInst;
  _token = token;
  _chatId = String(chatId);
  _sb = sb;
  cron.schedule('0 10 * * *', async function() {
    console.log('[Habits] Enviando encuesta...');
    try { await sendHabitsSurvey(_chatId); }
    catch(e) { console.error('[Habits]', e.message); }
  }, {timezone: 'America/Santiago'});
  console.log('[Habits] Activada - 10:00am Chile');
}

module.exports = {initHabitsSurvey, sendHabitsSurvey, handleHabitsCallback};
