/**
 * health-agent.js — GPT-4o + Garmin + Whoop
 * Compacta datos antes de enviar al LLM para evitar rate limits de tokens
 */

const OpenAI = require("openai");
const garmin = require("./garmin");
const whoop  = require("./whoop");

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const GOAL = { event: "maratón 26 abril", weeksOut: 6 };

// ── Compactadores (reducen tokens drasticamente) ─────────────────────────────

function formatPace(secPerKm) {
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60).toString().padStart(2, "0");
  return m + ":" + s + "/km";
}

function compactActivity(a) {
  if (!a) return null;
  const distKm = a.distance ? a.distance / 1000 : null;
  return {
    id:      a.activityId,
    type:    a.activityType?.typeKey,
    date:    (a.startTimeLocal || "").substring(0, 10),
    distKm:  distKm ? distKm.toFixed(2) : null,
    durMin:  a.duration ? (a.duration / 60).toFixed(1) : null,
    pace:    (distKm && a.duration) ? formatPace(a.duration / distKm) : null,
    avgHR:   a.averageHR,
    elev:    a.elevationGain,
  };
}

function compactSleep(s) {
  if (!s) return null;
  const d = s.dailySleepDTO || s;
  return {
    date:      d.calendarDate,
    totalH:    d.sleepTimeSeconds ? (d.sleepTimeSeconds / 3600).toFixed(1) : null,
    deepH:     d.deepSleepSeconds ? (d.deepSleepSeconds / 3600).toFixed(1) : null,
    remH:      d.remSleepSeconds  ? (d.remSleepSeconds  / 3600).toFixed(1) : null,
    score:     d.sleepScores?.overall?.value || d.sleepScore,
  };
}

function compactHR(h) {
  if (!h) return null;
  return { resting: h.restingHeartRate || h.minHeartRate, max: h.maxHeartRate };
}

function compactWhoopSummary(w) {
  if (!w) return null;
  return {
    recovery: w.recovery ? { score: w.recovery.score, hrv: w.recovery.hrv ? Math.round(w.recovery.hrv) : null, rhr: w.recovery.rhr } : null,
    sleep:    w.sleep    ? { score: w.sleep.score, totalH: w.sleep.totalHours, deepH: w.sleep.deepHours, remH: w.sleep.remHours } : null,
    strain:   w.strain   ? { score: w.strain.score ? parseFloat(w.strain.score).toFixed(1) : null } : null,
  };
}

// ── Tools ────────────────────────────────────────────────────────────────────

const TOOLS = [
  { type: "function", function: { name: "get_sleep",            description: "Sueño: horas, deep, REM, score",                            parameters: { type: "object", properties: { date: { type: "string" } }, required: [] } } },
  { type: "function", function: { name: "get_heart_rate",       description: "FC reposo y máxima del día",                                parameters: { type: "object", properties: { date: { type: "string" } }, required: [] } } },
  { type: "function", function: { name: "get_last_activity",    description: "Última actividad: distancia, ritmo, FC",                    parameters: { type: "object", properties: {}, required: [] } } },
  { type: "function", function: { name: "get_recent_activities",description: "Actividades recientes con ritmos REALES. Usar para predicciones de tiempo.", parameters: { type: "object", properties: { days: { type: "number" } }, required: [] } } },
  { type: "function", function: { name: "get_whoop_summary",    description: "Resumen Whoop: recovery score, HRV, sueño, strain",         parameters: { type: "object", properties: {}, required: [] } } },
  { type: "function", function: { name: "get_activities_history", description: "Historial completo de actividades (hasta 100). Usar cuando se pide ver más de 30 días atrás o toda la historia de entrenamientos.", parameters: { type: "object", properties: { limit: { type: "number", description: "Número de actividades, default 50" } }, required: [] } } },
];

async function executeTool(name, input) {
  switch (name) {
    case "get_sleep":
      return garmin.getSleepData(input.date).then(compactSleep);
    case "get_heart_rate":
      return garmin.getHeartRate(input.date).then(compactHR);
    case "get_last_activity":
      return garmin.getLastActivity().then(compactActivity);
    case "get_recent_activities": {
      const raw = await garmin.getRecentActivities(input.days || 30);
      const list = Array.isArray(raw) ? raw : (raw?.activityList || []);
      return list.map(compactActivity);
    }
    case "get_activities_history": {
      const raw = await garmin.getActivitiesHistory(input.limit || 50);
      const list = Array.isArray(raw) ? raw : (raw?.activityList || []);
      return list.map(compactActivity);
    }
    case "get_whoop_summary":
      return whoop.getDailySummary().then(compactWhoopSummary);
    default:
      throw new Error("Tool desconocida: " + name);
  }
}

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Eres el entrenador de Cristóbal Piñera, triatleta amateur. Carrera objetivo: maratón 26 de abril (~6 semanas). También hace ciclismo y natación.

REGLA: Consulta datos reales con tools. Nunca inventes métricas.

PREDICCIONES: Usa ritmos reales de get_recent_activities. Fórmula Riegel: T2 = T1×(D2/D1)^1.06. Muestra el cálculo. Nunca uses tiempos de "corredor promedio".

SEMÁFORO (Whoop recovery): <33% 🔴 descanso | 33-66% 🟡 moderado | >66% 🟢 fuerte

FATIGA: HRV -15%, FC reposo +10%, sueño <6h → reducir carga. Taper últimas 2 semanas: -30-40% volumen.

Español, directo. Máx 300 palabras.`;

// ── Agente ────────────────────────────────────────────────────────────────────

async function runAgent(userMessage, conversationHistory = []) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...conversationHistory,
    { role: "user", content: userMessage },
  ];

  for (let i = 0; i < 8; i++) {
    const resp = await client.chat.completions.create({
      model: "gpt-4o", max_tokens: 800,
      tools: TOOLS, tool_choice: "auto", messages,
    });
    const choice = resp.choices[0];
    const msg = { role: "assistant", content: choice.message.content };
    if (choice.message.tool_calls) msg.tool_calls = choice.message.tool_calls;
    messages.push(msg);

    if (choice.finish_reason === "stop") return choice.message.content || "Sin respuesta.";

    if (choice.finish_reason === "tool_calls") {
      for (const tc of choice.message.tool_calls) {
        let result;
        try   { result = await executeTool(tc.function.name, JSON.parse(tc.function.arguments || "{}")); }
        catch (e) { result = { error: e.message }; }
        messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
      }
    }
  }
  return messages.filter(m => m.role === "assistant").pop()?.content || "Sin respuesta.";
}

// ── Briefing ──────────────────────────────────────────────────────────────────

async function generateDailyBriefing() {
  const tod = garmin.today(), yest = garmin.daysAgo(1);
  const [sleep, hr, acts, whp] = await Promise.allSettled([
    garmin.getSleepData(yest).then(compactSleep),
    garmin.getHeartRate(yest).then(compactHR),
    garmin.getRecentActivities(7).then(r => (Array.isArray(r) ? r : r?.activityList || []).slice(0,7).map(compactActivity)),
    whoop.getDailySummary().then(compactWhoopSummary).catch(() => null),
  ]);
  const v = s => s.status === "fulfilled" ? s.value : null;
  const data = { date: tod, weeksToRace: GOAL.weeksOut, whoop: v(whp), sleep: v(sleep), hr: v(hr), activities: v(acts) };

  const resp = await client.chat.completions.create({
    model: "gpt-4o", max_tokens: 450,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: "Briefing " + tod + ". " + GOAL.weeksOut + " semanas para la maratón.\n" + JSON.stringify(data) + "\n1) Sueño/recuperación 2) Semáforo 🔴🟡🟢 3) Carga semanal 4) Recomendación hoy. Máx 180 palabras." },
    ],
  });
  return resp.choices[0]?.message?.content || "Error briefing.";
}

// ── Alertas ───────────────────────────────────────────────────────────────────

async function checkAlerts() {
  const alerts = [];
  try {
    const [h0, h1, h2] = await Promise.all([
      garmin.getHeartRate(garmin.today()).then(compactHR),
      garmin.getHeartRate(garmin.daysAgo(1)).then(compactHR),
      garmin.getHeartRate(garmin.daysAgo(2)).then(compactHR),
    ]);
    const today = h0?.resting, baseline = [h1?.resting, h2?.resting].filter(Boolean);
    if (today && baseline.length) {
      const avg = baseline.reduce((a, b) => a + b, 0) / baseline.length;
      if (today > avg * 1.1) alerts.push("⚠️ *FC reposo elevada* (" + today + " vs " + Math.round(avg) + " bpm). Entrena suave.");
    }
  } catch(e) {}
  try {
    const s = await garmin.getSleepData(garmin.daysAgo(1)).then(compactSleep);
    if (s?.totalH && parseFloat(s.totalH) < 6) alerts.push("😴 *Sueño corto* (" + s.totalH + "h). Descansa.");
  } catch(e) {}
  try {
    const w = await whoop.getDailySummary().then(compactWhoopSummary);
    if (w?.recovery?.score != null && w.recovery.score < 33) alerts.push("🔴 *Recovery Whoop bajo* (" + w.recovery.score + "%). Descanso recomendado.");
  } catch(e) {}
  return alerts;
}

module.exports = { runAgent, generateDailyBriefing, checkAlerts, GOAL };
