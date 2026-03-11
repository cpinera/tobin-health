/**
 * garmin.js — métodos confirmados de garmin-connect@1.6.2
 */
const { GarminConnect } = require("garmin-connect");

let client = null;
let lastAuth = null;
const AUTH_TTL = 55 * 60 * 1000;

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

async function safe(fn) {
  try { return await fn(); }
  catch (e) {
    const code = e?.statusCode || e?.response?.status;
    if (code === 403 || code === 404) { console.log(`[Garmin] ${code}: ${e.message}`); return null; }
    throw e;
  }
}

const today = () => new Date().toISOString().split("T")[0];
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate()-n); return d.toISOString().split("T")[0]; };

// ── Métodos confirmados ──────────────────────────────────────────────────────

async function getSleepData(date = today()) {
  const gc = await getClient();
  return safe(() => gc.getSleepData(new Date(date)));
}

async function getHeartRate(date = today()) {
  const gc = await getClient();
  return safe(() => gc.getHeartRate(new Date(date)));
}

async function getSteps(date = today()) {
  const gc = await getClient();
  return safe(async () => {
    // Try with userHash first, fall back to date only
    try { return await gc.getSteps(gc.userHash, new Date(date)); }
    catch { return await gc.getSteps(new Date(date)); }
  });
}

async function getActivities(start = 0, limit = 10) {
  const gc = await getClient();
  return safe(() => gc.getActivities(start, limit));
}

async function getLastActivity() {
  const gc = await getClient();
  return safe(async () => {
    const acts = await gc.getActivities(0, 1);
    return acts?.[0] || null;
  });
}

async function getActivityDetails(activityId) {
  const gc = await getClient();
  return safe(() => gc.getActivity({ activityId }));
}

async function getRecentActivities(days = 7) {
  const acts = await getActivities(0, 20);
  if (!acts) return [];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return acts.filter(a => new Date(a.startTimeLocal) >= cutoff);
}

async function getUserProfile() {
  const gc = await getClient();
  return safe(() => gc.getUserProfile());
}

async function getWeight(date = today()) {
  const gc = await getClient();
  return safe(() => gc.getDailyWeightData(new Date(date)));
}

async function getSleepTrend(days = 7) {
  const results = [];
  for (let i = days - 1; i >= 0; i--) {
    const sleep = await getSleepData(daysAgo(i));
    results.push({ date: daysAgo(i), sleep });
  }
  return results;
}

async function testEndpoints() {
  const tests = {
    sleep:        () => getSleepData(),
    heartRate:    () => getHeartRate(),
    steps:        () => getSteps(),
    lastActivity: () => getLastActivity(),
    userProfile:  () => getUserProfile(),
    weight:       () => getWeight(),
  };
  const results = {};
  for (const [name, fn] of Object.entries(tests)) {
    try {
      const data = await fn();
      results[name] = data !== null ? "✅ OK" : "⚠️ null";
    } catch (e) {
      results[name] = `❌ ${e.message}`;
    }
  }
  return results;
}

module.exports = {
  getClient, today, daysAgo, safe,
  getSleepData, getHeartRate, getSteps,
  getActivities, getLastActivity, getActivityDetails,
  getRecentActivities, getUserProfile, getWeight,
  getSleepTrend, testEndpoints,
};
