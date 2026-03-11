/**
 * garmin.js
 * Acceso a Garmin Connect via garmin-connect 1.6.2
 * Maneja 403 en endpoints premium con fallback graceful
 */

const { GarminConnect } = require("garmin-connect");

let client = null;
let lastAuth = null;
const AUTH_TTL = 55 * 60 * 1000; // re-auth every 55 min

async function getClient() {
  const now = Date.now();
  if (client && lastAuth && now - lastAuth < AUTH_TTL) return client;

  const gc = new GarminConnect({
    username: process.env.GARMIN_EMAIL,
    password: process.env.GARMIN_PASSWORD,
  });
  await gc.login(process.env.GARMIN_EMAIL, process.env.GARMIN_PASSWORD);
  client = gc;
  lastAuth = now;
  console.log("[Garmin] Authenticated successfully");
  return client;
}

// Safe wrapper — returns null on 403/404 instead of throwing
async function safe(fn) {
  try {
    return await fn();
  } catch (e) {
    const code = e?.statusCode || e?.response?.status;
    if (code === 403 || code === 404) {
      console.log(`[Garmin] Endpoint not available (${code}): ${e.message}`);
      return null;
    }
    throw e;
  }
}

const today = () => new Date().toISOString().split("T")[0];
const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0];
};

// ── Endpoints que generalmente SÍ funcionan ──────────────────────────────────

async function getDailySummary(date = today()) {
  const gc = await getClient();
  return safe(() => gc.getDailySummary(gc.userHash, date));
}

async function getSleepData(date = today()) {
  const gc = await getClient();
  return safe(() => gc.getSleepData(gc.userHash, date));
}

async function getStress(date = today()) {
  const gc = await getClient();
  return safe(() => gc.getStressData(gc.userHash, date));
}

async function getHeartRate(date = today()) {
  const gc = await getClient();
  return safe(() => gc.getHeartRate(gc.userHash, date));
}

async function getRestingHeartRate(date = today()) {
  const gc = await getClient();
  return safe(() => gc.getRestingHeartRate(gc.userHash, date));
}

async function getLastActivity() {
  const gc = await getClient();
  return safe(async () => {
    const activities = await gc.getActivities(0, 1);
    return activities[0] || null;
  });
}

async function getActivitiesByDate(startDate, endDate = today()) {
  const gc = await getClient();
  return safe(() => gc.getActivities(0, 20, startDate, endDate));
}

async function getActivityDetails(activityId) {
  const gc = await getClient();
  return safe(() => gc.getActivity({ activityId }));
}

async function getPersonalRecords() {
  const gc = await getClient();
  return safe(() => gc.getPersonalRecord());
}

async function getBodyComposition(startDate = daysAgo(30), endDate = today()) {
  const gc = await getClient();
  return safe(() => gc.getBodyComposition(gc.userHash, startDate, endDate));
}

// ── Endpoints premium (pueden dar 403 según dispositivo/plan) ────────────────

async function getHRV(date = today()) {
  const gc = await getClient();
  return safe(() => gc.getHrvData(gc.userHash, date));
}

async function getBodyBattery(startDate = daysAgo(1), endDate = today()) {
  const gc = await getClient();
  return safe(() => gc.getBodyBattery(gc.userHash, [startDate, endDate]));
}

async function getTrainingReadiness(date = today()) {
  const gc = await getClient();
  return safe(() => gc.getTrainingReadiness(gc.userHash, date));
}

async function getTrainingStatus() {
  const gc = await getClient();
  return safe(() => gc.getTrainingStatus(gc.userHash));
}

async function getVO2Max() {
  const gc = await getClient();
  return safe(() => gc.getVO2MaxTracking(gc.userHash));
}

async function getRacePredictions() {
  const gc = await getClient();
  return safe(() => gc.getRacePredictions());
}

async function getWeeklyIntensityMinutes(date = today()) {
  const gc = await getClient();
  return safe(() => gc.getIntensityMinutes(gc.userHash, date));
}

async function getHRVTrend(days = 7) {
  const results = [];
  for (let i = days - 1; i >= 0; i--) {
    const hrv = await getHRV(daysAgo(i));
    results.push({ date: daysAgo(i), hrv });
  }
  return results;
}

// ── Diagnostic: test which endpoints work ────────────────────────────────────
async function testEndpoints() {
  const tests = {
    dailySummary:      () => getDailySummary(),
    sleep:             () => getSleepData(),
    stress:            () => getStress(),
    heartRate:         () => getHeartRate(),
    restingHeartRate:  () => getRestingHeartRate(),
    lastActivity:      () => getLastActivity(),
    hrv:               () => getHRV(),
    bodyBattery:       () => getBodyBattery(),
    trainingReadiness: () => getTrainingReadiness(),
    trainingStatus:    () => getTrainingStatus(),
    vo2max:            () => getVO2Max(),
    racePredictions:   () => getRacePredictions(),
    personalRecords:   () => getPersonalRecords(),
  };

  const results = {};
  for (const [name, fn] of Object.entries(tests)) {
    try {
      const data = await fn();
      results[name] = data !== null ? "✅ OK" : "⚠️ null (403/404)";
    } catch (e) {
      results[name] = `❌ Error: ${e.message}`;
    }
  }
  return results;
}

module.exports = {
  getClient, today, daysAgo, safe,
  getDailySummary, getSleepData, getStress,
  getHeartRate, getRestingHeartRate,
  getLastActivity, getActivitiesByDate, getActivityDetails,
  getPersonalRecords, getBodyComposition,
  getHRV, getBodyBattery, getTrainingReadiness, getTrainingStatus,
  getVO2Max, getRacePredictions, getWeeklyIntensityMinutes,
  getHRVTrend, testEndpoints,
};
