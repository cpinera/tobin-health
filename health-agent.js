/**
 * health-agent.js
 * Agente de salud y entrenamiento para Cristóbal
 * - Briefing diario
 * - Alertas automáticas
 * - Agente conversacional con acceso a datos Garmin
 */

const Anthropic = require("@anthropic-ai/sdk");
const garmin = require("./garmin");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });

const GOAL = {
  event: "carrera",
  weeksOut: 6, // approximate, update manually or via Telegram command
  description: "Preparando carrera (5K/10K/21K/42K) en ~6 semanas",
};

// ─── TOOLS que Claude puede usar para consultar Garmin ───────────────────────

const GARMIN_TOOLS = [
  {
    name: "get_daily_summary",
    description: "Resumen diario: pasos, calorías, distancia, minutos activos",
    input_schema: {
      type: "object",
      properties: { date: { type: "string", description: "Fecha YYYY-MM-DD (default: hoy)" } },
      required: [],
    },
  },
  {
    name: "get_sleep",
    description: "Datos de sueño: duración, fases, score, hora de despertar",
    input_schema: {
      type: "object",
      properties: { date: { type: "string", description: "Fecha YYYY-MM-DD" } },
      required: [],
    },
  },
  {
    name: "get_hrv",
    description: "Heart Rate Variability — indicador clave de recuperación",
    input_schema: {
      type: "object",
      properties: { date: { type: "string", description: "Fecha YYYY-MM-DD" } },
      required: [],
    },
  },
  {
    name: "get_body_battery",
    description: "Body Battery: nivel de energía actual y tendencia",
    input_schema: {
      type: "object",
      properties: {
        startDate: { type: "string" },
        endDate: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "get_training_readiness",
    description: "Score de preparación para entrenar hoy (0-100)",
    input_schema: {
      type: "object",
      properties: { date: { type: "string" } },
      required: [],
    },
  },
  {
    name: "get_training_status",
    description: "Estado de entrenamiento: carga, tendencia, si hay sobreentrenamiento",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_last_activity",
    description: "Última actividad registrada (carrera, ciclismo, nado, etc.)",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_activities_by_date",
    description: "Actividades en un rango de fechas",
    input_schema: {
      type: "object",
      properties: {
        startDate: { type: "string", description: "Fecha inicio YYYY-MM-DD" },
        endDate: { type: "string", description: "Fecha fin YYYY-MM-DD" },
      },
      required: ["startDate"],
    },
  },
  {
    name: "get_activity_details",
    description: "Detalles de una actividad específica: HR, ritmo, elevación",
    input_schema: {
      type: "object",
      properties: { activityId: { type: "string" } },
      required: ["activityId"],
    },
  },
  {
    name: "get_vo2max",
    description: "VO2 Max estimado (running y cycling)",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_race_predictions",
    description: "Predicciones de tiempo en 5K, 10K, media y maratón",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_hrv_trend",
    description: "Tendencia de HRV de los últimos N días",
    input_schema: {
      type: "object",
      properties: { days: { type: "number", description: "Número de días (default: 7)" } },
      required: [],
    },
  },
  {
    name: "get_stress",
    description: "Niveles de estrés del día",
    input_schema: {
      type: "object",
      properties: { date: { type: "string" } },
      required: [],
    },
  },
  {
    name: "get_personal_records",
    description: "Records personales en todas las disciplinas",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_body_composition",
    description: "Peso, masa muscular, % grasa corporal en un rango",
    input_schema: {
      type: "object",
      properties: {
        startDate: { type: "string" },
        endDate: { type: "string" },
      },
      required: [],
    },
  },
];

// Map tool calls from Claude to actual Garmin functions
async function executeTool(toolName, toolInput) {
  const t = garmin.today;
  const d = garmin.daysAgo;
  switch (toolName) {
    case "get_daily_summary":   return garmin.getDailySummary(toolInput.date);
    case "get_sleep":           return garmin.getSleepData(toolInput.date);
    case "get_hrv":             return garmin.getHRV(toolInput.date);
    case "get_body_battery":    return garmin.getBodyBattery(toolInput.startDate, toolInput.endDate);
    case "get_training_readiness": return garmin.getTrainingReadiness(toolInput.date);
    case "get_training_status": return garmin.getTrainingStatus();
    case "get_last_activity":   return garmin.getLastActivity();
    case "get_activities_by_date": return garmin.getActivitiesByDate(toolInput.startDate, toolInput.endDate);
    case "get_activity_details": return garmin.getActivityDetails(toolInput.activityId);
    case "get_vo2max":          return garmin.getVO2Max();
    case "get_race_predictions": return garmin.getRacePredictions();
    case "get_hrv_trend":       return garmin.getHRVTrend(toolInput.days || 7);
    case "get_stress":          return garmin.getStress(toolInput.date);
    case "get_personal_records": return garmin.getPersonalRecords();
    case "get_body_composition": return garmin.getBodyComposition(toolInput.startDate, toolInput.endDate);
    default: throw new Error(`Tool desconocida: ${toolName}`);
  }
}

// ─── AGENTE CONVERSACIONAL ───────────────────────────────────────────────────

const SYSTEM_PROMPT = `Eres el entrenador personal y asesor de salud de Cristóbal Piñera, un triatleta amateur que se está preparando para una carrera en las próximas 6 semanas. También entrena ciclismo y natación regularmente.

Tu rol:
- Analizar sus datos de Garmin y dar feedback concreto y personalizado
- Ayudarle a planificar su semana de entrenamiento balanceando carga y recuperación
- Alertarle cuando los datos indiquen fatiga, sobreentrenamiento o necesidad de descanso
- Celebrar sus logros y PRs
- Hablar siempre en español, con tono directo y motivador (como un buen coach)

Principios de entrenamiento que sigues:
- Periodicidad: alternar cargas altas y bajas semana a semana
- HRV bajo (<60% del promedio personal) = señal de descanso o intensidad baja
- Body Battery < 30 al inicio del día = priorizar recuperación
- Training Readiness < 40 = sesión suave o descanso
- Nunca planificar más de 2 días duros consecutivos
- En las últimas 2 semanas antes de carrera: reducir volumen 30-40% (taper)

Cuando el usuario pregunte algo, usa las tools de Garmin para obtener datos reales antes de responder. No inventes métricas.

Responde siempre de forma concisa para Telegram (máximo 300 palabras, usa emojis con moderación).`;

async function runAgent(userMessage, conversationHistory = []) {
  const messages = [
    ...conversationHistory,
    { role: "user", content: userMessage },
  ];

  let response;
  let iterations = 0;
  const MAX_ITER = 8;

  while (iterations < MAX_ITER) {
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
      // Execute all tool calls
      const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
      messages.push({ role: "assistant", content: response.content });

      const toolResults = [];
      for (const toolUse of toolUseBlocks) {
        let result;
        try {
          result = await executeTool(toolUse.name, toolUse.input);
        } catch (e) {
          result = { error: e.message };
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        });
      }
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    break;
  }

  const textBlock = response.content.find((b) => b.type === "text");
  return textBlock ? textBlock.text : "No pude obtener una respuesta.";
}

// ─── BRIEFING DIARIO ─────────────────────────────────────────────────────────

async function generateDailyBriefing() {
  const today = garmin.today();
  const yesterday = garmin.daysAgo(1);

  // Fetch key metrics in parallel
  const [sleep, hrv, bodyBattery, trainingReadiness, trainingStatus, dailySummary] =
    await Promise.allSettled([
      garmin.getSleepData(yesterday),  // sleep is from previous night
      garmin.getHRV(today),
      garmin.getBodyBattery(yesterday, today),
      garmin.getTrainingReadiness(today),
      garmin.getTrainingStatus(),
      garmin.getDailySummary(today),
    ]);

  const getValue = (settled) => settled.status === "fulfilled" ? settled.value : null;

  const data = {
    sleep: getValue(sleep),
    hrv: getValue(hrv),
    bodyBattery: getValue(bodyBattery),
    readiness: getValue(trainingReadiness),
    trainingStatus: getValue(trainingStatus),
    summary: getValue(dailySummary),
  };

  // Ask Claude to generate the briefing
  const prompt = `Es la mañana del ${today}. Genera el briefing diario de salud y entrenamiento de Cristóbal basándote en estos datos de Garmin:

${JSON.stringify(data, null, 2)}

El briefing debe incluir:
1. 🌅 Resumen del sueño y recuperación (HRV, Body Battery)
2. 💪 Estado de forma actual (Training Readiness + Training Status)
3. 🎯 Recomendación para hoy: descanso / entrenamiento suave / sesión normal / sesión fuerte
4. 📅 Contexto: estamos a ~${GOAL.weeksOut} semanas de la carrera

Sé directo y concreto. Máximo 200 palabras. Usa emojis con moderación.`;

  const messages = [{ role: "user", content: prompt }];
  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages,
  });

  return response.content[0]?.text || "Error generando briefing.";
}

// ─── ALERTAS AUTOMÁTICAS ─────────────────────────────────────────────────────

async function checkAlerts() {
  const alerts = [];

  try {
    // Check HRV trend
    const hrvTrend = await garmin.getHRVTrend(8);
    const validHRV = hrvTrend.filter((d) => d.hrv && d.hrv.lastNight);
    if (validHRV.length >= 5) {
      const avg = validHRV.slice(0, -1).reduce((s, d) => s + d.hrv.lastNight, 0) / (validHRV.length - 1);
      const todayHRV = validHRV[validHRV.length - 1]?.hrv?.lastNight;
      if (todayHRV && todayHRV < avg * 0.75) {
        alerts.push(`⚠️ *HRV bajo hoy* (${Math.round(todayHRV)} vs promedio ${Math.round(avg)}). Considera una sesión suave o descanso.`);
      }
    }
  } catch (e) {
    console.error("Error checking HRV alerts:", e.message);
  }

  try {
    // Check body battery
    const bb = await garmin.getBodyBattery(garmin.daysAgo(1), garmin.today());
    const currentBB = Array.isArray(bb) ? bb[bb.length - 1]?.charged : bb?.charged;
    if (currentBB && currentBB < 25) {
      alerts.push(`🔋 *Body Battery muy bajo* (${currentBB}%). Prioriza recuperación hoy.`);
    }
  } catch (e) {
    console.error("Error checking battery alerts:", e.message);
  }

  try {
    // Check training status
    const status = await garmin.getTrainingStatus();
    const load = status?.trainingLoadBalance?.weeklyTrainingLoadBalance;
    if (load && load > 1.5) {
      alerts.push(`🚨 *Carga de entrenamiento alta*. Tu carga actual está un ${Math.round((load - 1) * 100)}% sobre lo óptimo. Considera un día de recuperación.`);
    }
  } catch (e) {
    console.error("Error checking training load alerts:", e.message);
  }

  return alerts;
}

module.exports = { runAgent, generateDailyBriefing, checkAlerts, GOAL };
