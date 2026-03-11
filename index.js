/**
 * tobin-health/index.js
 * Servidor principal del agente de salud y entrenamiento
 */

const express = require("express");
const axios = require("axios");
const cron = require("node-cron");
const { runAgent, generateDailyBriefing, checkAlerts } = require("./health-agent");

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN_HEALTH;
const CHAT_ID        = process.env.CHAT_ID || "7783704824";
const API_SECRET     = process.env.API_SECRET || "tobin2024";
const PORT           = process.env.PORT || 3001;

// Per-user conversation history (in-memory, last 10 turns)
const conversationHistory = new Map();
const MAX_HISTORY = 10;

// ─── Auth middleware ──────────────────────────────────────────────────────────

function auth(req, res, next) {
  const key = req.headers["x-api-key"] || req.query.key;
  if (key !== API_SECRET) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ─── Telegram helpers ─────────────────────────────────────────────────────────

async function sendTelegram(text, chatId = CHAT_ID) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
    });
  } catch (e) {
    console.error("Telegram error:", e.response?.data || e.message);
  }
}

async function sendTyping(chatId = CHAT_ID) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendChatAction`, {
      chat_id: chatId,
      action: "typing",
    });
  } catch {}
}

// ─── Telegram webhook ────────────────────────────────────────────────────────

app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // respond immediately to Telegram

  const update = req.body;
  const msg = update.message || update.edited_message;
  if (!msg) return;

  const chatId = String(msg.chat.id);
  const text   = msg.text || "";

  // Only respond to Cristóbal
  if (chatId !== String(CHAT_ID)) {
    await sendTelegram("No autorizado.", chatId);
    return;
  }

  await sendTyping(chatId);

  // ── Special commands ──────────────────────────────────────────────────────

  // /briefing — force daily briefing
  if (text === "/briefing" || text === "/salud") {
    try {
      const briefing = await generateDailyBriefing();
      await sendTelegram(briefing, chatId);
    } catch (e) {
      await sendTelegram(`❌ Error generando briefing: ${e.message}`, chatId);
    }
    return;
  }

  // /alertas — check alerts now
  if (text === "/alertas") {
    try {
      const alerts = await checkAlerts();
      if (alerts.length === 0) {
        await sendTelegram("✅ Todo está bien. Sin alertas por ahora.", chatId);
      } else {
        await sendTelegram(alerts.join("\n\n"), chatId);
      }
    } catch (e) {
      await sendTelegram(`❌ Error: ${e.message}`, chatId);
    }
    return;
  }

  // /semana — plan the training week
  if (text === "/semana") {
    try {
      const reply = await runAgent(
        "Planifícame la semana de entrenamiento. Revisa mi estado actual (HRV, carga, training readiness) y crea un plan diario equilibrado para los próximos 7 días considerando la carrera que tengo en ~6 semanas.",
        []
      );
      await sendTelegram(reply, chatId);
    } catch (e) {
      await sendTelegram(`❌ Error: ${e.message}`, chatId);
    }
    return;
  }

  // /ultima — analyze last activity
  if (text === "/ultima") {
    try {
      const reply = await runAgent(
        "Analiza mi última actividad registrada. ¿Cómo estuvo? Dame feedback sobre el rendimiento, zonas de frecuencia cardíaca y si fue adecuada para mis objetivos.",
        []
      );
      await sendTelegram(reply, chatId);
    } catch (e) {
      await sendTelegram(`❌ Error: ${e.message}`, chatId);
    }
    return;
  }

  // /records — personal records
  if (text === "/records" || text === "/prs") {
    try {
      const reply = await runAgent("Muéstrame mis records personales actuales y si he mejorado recientemente.", []);
      await sendTelegram(reply, chatId);
    } catch (e) {
      await sendTelegram(`❌ Error: ${e.message}`, chatId);
    }
    return;
  }

  // /ayuda — help
  if (text === "/ayuda" || text === "/start" || text === "/help") {
    const help = `🏃 *Tobin Health* — Tu entrenador personal

*Comandos rápidos:*
/briefing — Resumen de salud de hoy
/semana — Plan de entrenamiento semanal
/ultima — Análisis de última actividad
/alertas — Ver alertas actuales
/records — Tus records personales

*O simplemente escríbeme:*
• "¿Puedo entrenar hoy?"
• "¿Cómo dormí esta semana?"
• "¿Cuál es mi VO2 max?"
• "¿Cuánto tiempo tengo para el 10K?"
• "Planifícame los próximos 3 días"`;
    await sendTelegram(help, chatId);
    return;
  }

  // ── Conversational agent ──────────────────────────────────────────────────
  try {
    // Get or init conversation history
    if (!conversationHistory.has(chatId)) {
      conversationHistory.set(chatId, []);
    }
    const history = conversationHistory.get(chatId);

    const reply = await runAgent(text, history);

    // Update history (keep last MAX_HISTORY messages)
    history.push({ role: "user", content: text });
    history.push({ role: "assistant", content: reply });
    if (history.length > MAX_HISTORY * 2) {
      history.splice(0, 2); // remove oldest turn
    }

    await sendTelegram(reply, chatId);
  } catch (e) {
    console.error("Agent error:", e);
    await sendTelegram(`❌ Error: ${e.message}`, chatId);
  }
});

// ─── REST endpoints ───────────────────────────────────────────────────────────

app.get("/health", (req, res) => res.json({ ok: true, service: "tobin-health" }));

// Diagnostic: test which Garmin endpoints are available
app.get("/garmin/test", auth, async (req, res) => {
  try {
    const { testEndpoints } = require("./garmin");
    const results = await testEndpoints();
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Inspect: list all methods on GarminConnect client
app.get("/garmin/methods", auth, async (req, res) => {
  try {
    const { getClient } = require("./garmin");
    const gc = await getClient();
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(gc))
      .filter(m => typeof gc[m] === "function" && m !== "constructor")
      .sort();
    res.json({ count: methods.length, methods });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Force briefing
app.get("/send-briefing", auth, async (req, res) => {
  try {
    const briefing = await generateDailyBriefing();
    await sendTelegram(briefing);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Force alerts check
app.get("/check-alerts", auth, async (req, res) => {
  try {
    const alerts = await checkAlerts();
    if (alerts.length > 0) await sendTelegram(alerts.join("\n\n"));
    res.json({ ok: true, alerts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Scheduled jobs ───────────────────────────────────────────────────────────

// Daily briefing at 7:00 AM Chile time (UTC-3 = 10:00 UTC)
cron.schedule("0 10 * * *", async () => {
  console.log("[CRON] Sending daily health briefing...");
  try {
    const briefing = await generateDailyBriefing();
    await sendTelegram(briefing);
  } catch (e) {
    console.error("[CRON] Briefing error:", e.message);
  }
});

// Alerts check at 12:00 PM Chile time (15:00 UTC) — midday check
cron.schedule("0 15 * * *", async () => {
  console.log("[CRON] Checking health alerts...");
  try {
    const alerts = await checkAlerts();
    if (alerts.length > 0) {
      await sendTelegram("🔔 *Alertas de salud:*\n\n" + alerts.join("\n\n"));
    }
  } catch (e) {
    console.error("[CRON] Alerts error:", e.message);
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`✅ tobin-health running on port ${PORT}`);
});
