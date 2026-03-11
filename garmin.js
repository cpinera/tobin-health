/**
 * garmin.js
 * Wrapper para llamar herramientas del MCP @nicolasvegam/garmin-connect-mcp
 * El MCP corre como proceso hijo via npx y se comunica por stdio (JSON-RPC)
 */

const { spawn } = require("child_process");

let mcpProcess = null;
let requestId = 1;
const pending = new Map();
let initialized = false;
let initPromise = null;

function startMCP() {
  if (mcpProcess) return;

  mcpProcess = spawn("npx", ["-y", "@nicolasvegam/garmin-connect-mcp"], {
    env: {
      ...process.env,
      GARMIN_EMAIL: process.env.GARMIN_EMAIL,
      GARMIN_PASSWORD: process.env.GARMIN_PASSWORD,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buffer = "";

  mcpProcess.stdout.on("data", (data) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep incomplete line
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && pending.has(msg.id)) {
          const { resolve, reject } = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || "MCP error"));
          else resolve(msg.result);
        }
      } catch (e) {
        // ignore non-JSON lines (startup logs, etc.)
      }
    }
  });

  mcpProcess.stderr.on("data", (data) => {
    const msg = data.toString();
    // Only log real errors, not info messages
    if (msg.includes("Error") || msg.includes("error")) {
      console.error("[Garmin MCP stderr]", msg);
    }
  });

  mcpProcess.on("exit", (code) => {
    console.log(`[Garmin MCP] process exited with code ${code}`);
    mcpProcess = null;
    initialized = false;
    initPromise = null;
    // Reject all pending requests
    for (const [, { reject }] of pending) {
      reject(new Error("MCP process exited"));
    }
    pending.clear();
  });
}

function sendRPC(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!mcpProcess) {
      return reject(new Error("MCP process not running"));
    }
    const id = requestId++;
    pending.set(id, { resolve, reject });
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    mcpProcess.stdin.write(msg);
    // Timeout after 30s
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`MCP timeout for ${method}`));
      }
    }, 30000);
  });
}

async function initMCP() {
  if (initialized) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    startMCP();
    // Send initialize handshake
    await sendRPC("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "tobin-health", version: "1.0.0" },
    });
    await sendRPC("notifications/initialized");
    initialized = true;
  })();

  return initPromise;
}

/**
 * Call a Garmin MCP tool by name with arguments
 * @param {string} toolName - e.g. "get_sleep_data"
 * @param {object} args - tool arguments
 * @returns {Promise<any>} - parsed tool result
 */
async function callTool(toolName, args = {}) {
  await initMCP();
  const result = await sendRPC("tools/call", {
    name: toolName,
    arguments: args,
  });
  // MCP returns { content: [{ type: "text", text: "..." }] }
  if (result && result.content && result.content[0]) {
    try {
      return JSON.parse(result.content[0].text);
    } catch {
      return result.content[0].text;
    }
  }
  return result;
}

// ─── Convenience wrappers ────────────────────────────────────────────────────

const today = () => new Date().toISOString().split("T")[0];
const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0];
};

async function getDailySummary(date = today()) {
  return callTool("get_daily_summary", { date });
}

async function getSleepData(date = today()) {
  return callTool("get_sleep_data", { date });
}

async function getHRV(date = today()) {
  return callTool("get_hrv", { date });
}

async function getBodyBattery(startDate = daysAgo(1), endDate = today()) {
  return callTool("get_body_battery", { startDate, endDate });
}

async function getTrainingReadiness(date = today()) {
  return callTool("get_training_readiness", { date });
}

async function getTrainingStatus() {
  return callTool("get_training_status", {});
}

async function getStress(date = today()) {
  return callTool("get_stress", { date });
}

async function getHeartRate(date = today()) {
  return callTool("get_heart_rate", { date });
}

async function getRestingHeartRate(date = today()) {
  return callTool("get_resting_heart_rate", { date });
}

async function getLastActivity() {
  return callTool("get_last_activity", {});
}

async function getActivitiesByDate(startDate, endDate = today()) {
  return callTool("get_activities_by_date", { startDate, endDate });
}

async function getActivityDetails(activityId) {
  return callTool("get_activity_details", { activityId });
}

async function getVO2Max() {
  return callTool("get_vo2max", {});
}

async function getRacePredictions() {
  return callTool("get_race_predictions", {});
}

async function getPersonalRecords() {
  return callTool("get_personal_records", {});
}

async function getBodyComposition(startDate = daysAgo(30), endDate = today()) {
  return callTool("get_body_composition", { startDate, endDate });
}

async function getProgressSummary(startDate, endDate = today(), activityType = "running") {
  return callTool("get_progress_summary", { startDate, endDate, activityType });
}

async function getWeeklyIntensityMinutes(date = today()) {
  return callTool("get_weekly_intensity_minutes", { date });
}

async function getHRVTrend(days = 7) {
  // Get HRV for last N days
  const results = [];
  for (let i = days - 1; i >= 0; i--) {
    try {
      const hrv = await callTool("get_hrv", { date: daysAgo(i) });
      results.push({ date: daysAgo(i), hrv });
    } catch {
      results.push({ date: daysAgo(i), hrv: null });
    }
  }
  return results;
}

module.exports = {
  callTool,
  today,
  daysAgo,
  getDailySummary,
  getSleepData,
  getHRV,
  getBodyBattery,
  getTrainingReadiness,
  getTrainingStatus,
  getStress,
  getHeartRate,
  getRestingHeartRate,
  getLastActivity,
  getActivitiesByDate,
  getActivityDetails,
  getVO2Max,
  getRacePredictions,
  getPersonalRecords,
  getBodyComposition,
  getProgressSummary,
  getWeeklyIntensityMinutes,
  getHRVTrend,
};
