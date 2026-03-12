/**
 * health-agent.js
 * Agente de salud usando GPT-4o de OpenAI con datos reales de Garmin + Whoop
 */

const OpenAI = require("openai");
const garmin = require("./garmin");
const whoop  = require("./whoop");

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const GOAL = {
  event: "carrera",
  weeksOut: 6,
  description: "Preparando carrera (5K-42K) en ~6 semanas",
};

const GARMIN_TOOLS = [
  { type: "function", function: { name: "get_sleep", description: "Datos de sueño: duración total, fases (deep/light/REM/awake), score", parameters: { type: "object", properties: { date: { type: "string" } }, required: [] } } },
  { type: "function", function: { name: "get_heart_rate", description: "Frecuencia cardíaca del día: mínima, máxima, promedio", parameters: { type: "object", properties: { date: { type: "string" } }, required: [] } } },
  { type: "function", function: { name: "get_steps", description: "Pasos del día", parameters: { type: "object", properties: { date: { type: "string" } }, required: [] } } },
  { type: "function", function: { name: "get_last_activity", description: "Última actividad registrada con métricas: distancia, tiempo, ritmo, FC promedio", parameters: { type: "object", properties: {}, required: [] } } },
  { type: "function", function: { name: "get_recent_activities", description: "Actividades de los últimos N días con distancias y tiempos REALES. Usar para predicciones de tiempo.", parameters: { type: "object", properties: { days: { type: "number" } }, required: [] } } },
  { type: "function", function: { name: "get_sleep_trend", description: "Tendencia de sueño de los últimos N días", parameters: { type: "object", properties: { days: { type: "number" } }, required: [] } } },
  { type: "function", function: { name: "get_activity_details", description: "Detalles completos de actividad por ID: splits por km, FC por zona", parameters: { type: "object", properties: { activityId: { type: "string" } }, required: ["activityId"] } } },
  { type: "function", function: { name: "get_whoop_recovery", description: "Recovery score Whoop (0-100%), HRV, FC reposo, SpO2", parameters: { type: "object", properties: {}, required: [] } } },
  { type: "function", function: { name: "get_whoop_sleep", description: "Sueño Whoop: score, horas, eficiencia, deep, REM, interrupciones", parameters: { type: "object", properties: {}, required: [] } } },
  { type: "function", function: { name: "get_whoop_strain", description: "Strain del día Whoop (0-21)", parameters: { type: "object", properties: {}, required: [] } } },
  { type: "function", function: { name: "get_whoop_history", description: "Historial recovery y HRV últimos N días", parameters: { type: "object", properties: { days: { type: "number" } }, required: [] } } },
];

async function executeTool(name, input) {
  switch (name) {
    case "get_sleep":              return garmin.getSleepData(input.date);
    case "get_heart_rate":         return garmin.getHeartRate(input.date);
    case "get_steps":              return garmin.getSteps(input.date);
    case "get_last_activity":      return garmin.getLastActivity();
    case "get_recent_activities":  return garmin.getRecentActivities(input.days || 7);
    case "get_sleep_trend":        return garmin.getSleepTrend(input.days || 7);
    case "get_activity_details":   return garmin.getActivityDetails(input.activityId);
    case "get_whoop_recovery":     return whoop.getLatestRecovery();
    case "get_whoop_sleep":        return whoop.getLatestSleep();
    case "get_whoop_strain":       return whoop.getLatestCycle();
    case "get_whoop_history":      return whoop.getRecoveryHistory(input.days || 7);
    default: throw new Error("Tool desconocida: " + name);
  }
}

const SYSTEM_PROMPT = `Eres el entrenador personal de Cristóbal Piñera, triatleta amateur preparando una carrera en ~6 semanas. Entrena running, ciclismo y natación.

REGLA FUNDAMENTAL: Consulta datos reales con las tools ANTES de responder. Nunca inventes métricas.

PREDICCIONES DE TIEMPO:
- Usa SOLO los ritmos reales de sus actividades (get_recent_activities)
- Fórmula Riegel: T2 = T1 x (D2/D1)^1.06
- Muestra el cálculo: "Corriste 10K a 5:30/km → predigo 5K en ~26:10"
- Si no hay datos suficientes, dilo explícitamente
- NUNCA uses tiempos genéricos de corredor promedio

SEMÁFORO Whoop:
- Recovery <33% 🔴 → descanso activo solo
- Recovery 33-66% 🟡 → moderado, sin intervalos
- Recovery >66% 🟢 → puedes entrenar fuerte

SEÑALES DE FATIGA:
- HRV cayendo >15% → acumulación de fatiga
- FC reposo >10% sobre baseline → reducir intensidad
- Sueño <6h o profundo <1h → priorizar recuperación
- Nunca 2+ días duros consecutivos
- Taper últimas 2 semanas: -30-40% volumen

Habla en español, tono directo y motivador. Máximo 300 palabras para Telegram.`;

async function runAgent(userMessage, conversationHistory = []) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...conversationHistory,
    { role: "user", content: userMessage },
  ];

  let iterations = 0;

  while (iterations < 8) {
    iterations++;

    const response = await client.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 1024,
      tools: GARMIN_TOOLS,
      tool_choice: "auto",
      messages,
    });

    const choice = response.choices[0];
    const assistantMsg = { role: "assistant", content: choice.message.content };
    if (choice.message.tool_calls) assistantMsg.tool_calls = choice.message.tool_calls;
    messages.push(assistantMsg);

    if (choice.finish_reason === "stop") {
      return choice.message.content || "No pude obtener una respuesta.";
    }

    if (choice.finish_reason === "tool_calls" && choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        let result;
        try {
          const inp = JSON.parse(tc.function.arguments || "{}");
          result = await executeTool(tc.function.name, inp);
        } catch (e) {
          result = { error: e.message };
        }
        messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
      }
      continue;
    }
    break;
  }

  const last = messages.filter(m => m.role === "assistant").pop();
  return last?.content || "No pude obtener una respuesta.";
}

async function generateDailyBriefing() {
  const tod  = garmin.today();
  const yest = garmin.daysAgo(1);

  const [sleep, hrToday, hrYesterday, recentActivities, whoopData] = await Promise.allSettled([
    garmin.getSleepData(yest),
    garmin.getHeartRate(tod),
    garmin.getHeartRate(yest),
    garmin.getRecentActivities(7),
    whoop.getDailySummary().catch(() => null),
  ]);

  const val = s => s.status === "fulfilled" ? s.value : null;
  const data = {
    date: tod,
    whoop: val(whoopData),
    garminSleep: val(sleep),
    heartRateToday: val(hrToday),
    heartRateYesterday: val(hrYesterday),
    recentActivities: val(recentActivities),
    weeksToRace: GOAL.weeksOut,
  };

  const response = await client.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 600,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: "Genera el briefing del " + tod + ". Estamos a " + GOAL.weeksOut + " semanas de la carrera.\n\nDatos:\n" + JSON.stringify(data, null, 2) + "\n\nIncluye: 1) Sueño/recuperación (prioriza Whoop) 2) Semáforo 🔴🟡🟢 3) Carga semanal con distancias reales 4) Recomendación para hoy. Máximo 200 palabras.",
      },
    ],
  });

  return response.choices[0]?.message?.content || "Error generando briefing.";
}

async function checkAlerts() {
  const alerts = [];

  try {
    const [hrToday, hrYest, hrDayBefore] = await Promise.all([
      garmin.getHeartRate(garmin.today()),
      garmin.getHeartRate(garmin.daysAgo(1)),
      garmin.getHeartRate(garmin.daysAgo(2)),
    ]);
    const restingHR = d => d?.restingHeartRate || d?.minHeartRate;
    const today = restingHR(hrToday);
    const avg = [restingHR(hrYest), restingHR(hrDayBefore)].filter(Boolean);
    if (today && avg.length >= 1) {
      const baseline = avg.reduce((a, b) => a + b, 0) / avg.length;
      if (today > baseline * 1.1) {
        alerts.push("⚠️ *FC de reposo elevada* (" + today + " bpm vs " + Math.round(baseline) + " bpm baseline). Sesión suave o descanso.");
      }
    }
  } catch (e) { console.error("Alert HR:", e.message); }

  try {
    const sleep = await garmin.getSleepData(garmin.daysAgo(1));
    const secs = sleep?.dailySleepDTO?.sleepTimeSeconds || sleep?.sleepTimeSeconds;
    if (secs && secs < 6 * 3600) {
      alerts.push("😴 *Sueño corto* (" + (secs/3600).toFixed(1) + "h). Prioriza recuperación hoy.");
    }
  } catch (e) { console.error("Alert sleep:", e.message); }

  try {
    const ws = await whoop.getDailySummary();
    if (ws?.recovery?.score != null && ws.recovery.score < 33) {
      alerts.push("🔴 *Recovery Whoop muy bajo* (" + ws.recovery.score + "%). Día de descanso recomendado.");
    }
  } catch (e) { console.error("Alert Whoop:", e.message); }

  return alerts;
}

module.exports = { runAgent, generateDailyBriefing, checkAlerts, GOAL };
