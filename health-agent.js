/**
 * health-agent.js
 * Agente de salud usando datos reales disponibles en garmin-connect@1.6.2:
 * sueño, frecuencia cardíaca, pasos, actividades
 */

const Anthropic = require("@anthropic-ai/sdk");
const garmin = require("./garmin");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });

const GOAL = {
  event: "carrera",
  weeksOut: 6,
  description: "Preparando carrera (5K-42K) en ~6 semanas",
};

// ── Tools disponibles para el agente ────────────────────────────────────────

const GARMIN_TOOLS = [
  {
    name: "get_sleep",
    description: "Datos de sueño: duración total, fases (deep/light/REM/awake), score",
    input_schema: {
      type: "object",
      properties: { date: { type: "string", description: "Fecha YYYY-MM-DD, default hoy" } },
      required: [],
    },
  },
  {
    name: "get_heart_rate",
    description: "Frecuencia cardíaca del día: mínima, máxima, promedio y series temporales",
    input_schema: {
      type: "object",
      properties: { date: { type: "string", description: "Fecha YYYY-MM-DD, default hoy" } },
      required: [],
    },
  },
  {
    name: "get_steps",
    description: "Pasos del día",
    input_schema: {
      type: "object",
      properties: { date: { type: "string", description: "Fecha YYYY-MM-DD, default hoy" } },
      required: [],
    },
  },
  {
    name: "get_last_activity",
    description: "Última actividad registrada con métricas: distancia, tiempo, ritmo, FC promedio",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_recent_activities",
    description: "Actividades de los últimos N días (carreras, ciclismo, nado, etc.)",
    input_schema: {
      type: "object",
      properties: { days: { type: "number", description: "Días hacia atrás, default 7" } },
      required: [],
    },
  },
  {
    name: "get_sleep_trend",
    description: "Tendencia de sueño de los últimos N días: duración y calidad por noche",
    input_schema: {
      type: "object",
      properties: { days: { type: "number", description: "Número de días, default 7" } },
      required: [],
    },
  },
  {
    name: "get_activity_details",
    description: "Detalles completos de una actividad específica por ID",
    input_schema: {
      type: "object",
      properties: { activityId: { type: "string" } },
      required: ["activityId"],
    },
  },
];

async function executeTool(name, input) {
  switch (name) {
    case "get_sleep":           return garmin.getSleepData(input.date);
    case "get_heart_rate":      return garmin.getHeartRate(input.date);
    case "get_steps":           return garmin.getSteps(input.date);
    case "get_last_activity":   return garmin.getLastActivity();
    case "get_recent_activities": return garmin.getRecentActivities(input.days || 7);
    case "get_sleep_trend":     return garmin.getSleepTrend(input.days || 7);
    case "get_activity_details": return garmin.getActivityDetails(input.activityId);
    default: throw new Error(`Tool desconocida: ${name}`);
  }
}

// ── Sistema prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Eres el entrenador personal y asesor de salud de Cristóbal Piñera, triatleta amateur preparando una carrera en ~6 semanas. Entrena running, ciclismo y natación.

Tienes acceso a sus datos reales de Garmin: sueño, frecuencia cardíaca, pasos y actividades.

Tu rol:
- Analizar los datos disponibles y dar feedback concreto y personalizado
- Planificar semanas de entrenamiento equilibrando carga y recuperación
- Usar la FC de reposo como proxy de recuperación (FC reposo alta = más fatiga)
- Usar calidad de sueño (horas + fases deep/REM) para evaluar recuperación
- Celebrar PRs y logros

Principios que sigues:
- FC reposo elevada >10% sobre baseline → señal de fatiga, reducir intensidad
- Sueño <6h o poco sueño profundo → priorizar recuperación ese día
- No más de 2 días duros consecutivos
- En últimas 2 semanas antes de carrera: reducir volumen 30-40% (taper)
- Para calcular carga semanal: suma las actividades de los últimos 7 días

Usa las tools para obtener datos reales ANTES de responder. No inventes métricas.
Habla en español, tono directo y motivador. Máximo 300 palabras para Telegram.`;

// ── Agente conversacional ─────────────────────────────────────────────────────

async function runAgent(userMessage, conversationHistory = []) {
  const messages = [...conversationHistory, { role: "user", content: userMessage }];
  let response;
  let iterations = 0;

  while (iterations < 8) {
    iterations++;
    response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: GARMIN_TOOLS,
      messages,
    });

    if (response.stop_reason === "end_turn") break;

    if (response.stop_reason === "tool_use") {
      const toolUseBlocks = response.content.filter(b => b.type === "tool_use");
      messages.push({ role: "assistant", content: response.content });

      const toolResults = [];
      for (const tu of toolUseBlocks) {
        let result;
        try { result = await executeTool(tu.name, tu.input); }
        catch (e) { result = { error: e.message }; }
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result) });
      }
      messages.push({ role: "user", content: toolResults });
      continue;
    }
    break;
  }

  const textBlock = response.content.find(b => b.type === "text");
  return textBlock ? textBlock.text : "No pude obtener una respuesta.";
}

// ── Briefing diario ───────────────────────────────────────────────────────────

async function generateDailyBriefing() {
  const tod = garmin.today();
  const yest = garmin.daysAgo(1);

  const [sleep, hrToday, hrYesterday, steps, recentActivities] = await Promise.allSettled([
    garmin.getSleepData(yest),       // sueño de anoche
    garmin.getHeartRate(tod),        // FC de hoy
    garmin.getHeartRate(yest),       // FC de ayer para comparar
    garmin.getSteps(tod),
    garmin.getRecentActivities(7),
  ]);

  const val = s => s.status === "fulfilled" ? s.value : null;

  const data = {
    date: tod,
    sleep: val(sleep),
    heartRateToday: val(hrToday),
    heartRateYesterday: val(hrYesterday),
    steps: val(steps),
    recentActivities: val(recentActivities),
    weeksToRace: GOAL.weeksOut,
  };

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 600,
    system: SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: `Genera el briefing diario del ${tod}. Datos de Garmin:\n\n${JSON.stringify(data, null, 2)}\n\nIncluye: 1) Resumen sueño y recuperación 2) Estado de forma basado en FC de reposo 3) Carga semanal (actividades últimos 7 días) 4) Recomendación para hoy: descanso/suave/normal/fuerte. Estamos a ${GOAL.weeksOut} semanas de la carrera. Máximo 200 palabras.`,
    }],
  });

  return response.content[0]?.text || "Error generando briefing.";
}

// ── Alertas ───────────────────────────────────────────────────────────────────

async function checkAlerts() {
  const alerts = [];

  try {
    // FC reposo elevada = señal de fatiga
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
        alerts.push(`⚠️ *FC de reposo elevada* (${today} bpm vs baseline ${Math.round(baseline)} bpm). Señal de fatiga — considera sesión suave o descanso hoy.`);
      }
    }
  } catch (e) { console.error("Alert HR error:", e.message); }

  try {
    // Sueño insuficiente
    const sleep = await garmin.getSleepData(garmin.daysAgo(1));
    const sleepSeconds = sleep?.dailySleepDTO?.sleepTimeSeconds || sleep?.sleepTimeSeconds;
    if (sleepSeconds && sleepSeconds < 6 * 3600) {
      const hours = (sleepSeconds / 3600).toFixed(1);
      alerts.push(`😴 *Sueño corto anoche* (${hours}h). Prioriza recuperación hoy.`);
    }
  } catch (e) { console.error("Alert sleep error:", e.message); }

  return alerts;
}

module.exports = { runAgent, generateDailyBriefing, checkAlerts, GOAL };
