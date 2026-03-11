/**
 * garmin.js
 * Acceso directo a Garmin Connect usando la librería garmin-connect
 * Evita depender del proceso MCP via npx
 */

const { GarminConnect } = require("garmin-connect");

let client = null;
let lastAuth = null;
const AUTH_TTL = 60 * 60 * 1000; // re-auth every hour

async function getClient() {
  const now = Date.now();
  if (client && lastAuth && now - lastAuth < AUTH_TTL) return client;

  client = new GarminConnect({
    username: process.env.GARMIN_EMAIL,
    password: process.env.GARMIN_PASSWORD,
  });

  await client.login(process.env.GARMIN_EMAIL, process.env.GARMIN_PASSWORD);
  lastAuth = now;
  console.log("[Garmin] Authenticated successfully");
  return client;
}

const today = () => new Date().toISOString().split("T")[0];
const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0];
};

async function getDailySummary(date = today()) {
  const gc = await getClient();
  return gc.getDailySummary(gc.userHash, date);
}

async function getSleepData(date = today()) {
  const gc = await getClient();
  return gc.getSleepData(gc.userHash, date);
}

async function getHRV(date = today()) {
  const gc = await getClient();
  try { return await gc.getHrvData(gc.userHash, date); }
  catch { return null; }
}

async function getBodyBattery(startDate = daysAgo(1), endDate = today()) {
  const gc = await getClient();
  return gc.getBodyBattery(gc.userHash, [startDate, endDate]);
}

async function getTrainingReadiness(date = today()) {
  const gc = await getClient();
  try { return await gc.getTrainingReadiness(gc.userHash, date); }
  catch { return null; }
}

async function getTrainingStatus() {
  const gc = await getClient();
  try { return await gc.getTrainingStatus(gc.userHash); }
  catch { return null; }
}

async function getStress(date = today()) {
  const gc = await getClient();
  return gc.getStressData(gc.userHash, date);
}

async function getHeartRate(date = today()) {
  const gc = await getClient();
  return gc.getHeartRate(gc.userHash, date);
}

async function getRestingHeartRate(date = today()) {
  const gc = await getClient();
  return gc.getRestingHeartRate(gc.userHash, date);
}

async function getLastActivity() {
  const gc = await getClient();
  const activities = await gc.getActivities(0, 1);
  return activities[0] || null;
}

async function getActivitiesByDate(startDate, endDate = today()) {
  const gc = await getClient();
  return gc.getActivities(0, 20, startDate, endDate);
}

async function getActivityDetails(activityId) {
  const gc = await getClient();
  return gc.getActivity({ activityId });
}

async function getVO2Max() {
  const gc = await getClient();
  try { return await gc.getVO2MaxTracking(gc.userHash); }
  catch { return null; }
}

async function getRacePredictions() {
  const gc = await getClient();
  try { return await gc.getRacePredictions(); }
  catch { return null; }
}

async function getPersonalRecords() {
  const gc = await getClient();
  return gc.getPersonalRecord();
}

async function getBodyComposition(startDate = daysAgo(30), endDate = today()) {
  const gc = await getClient();
  return gc.getBodyComposition(gc.userHash, startDate, endDate);
}

async function getWeeklyIntensityMinutes(date = today()) {
  const gc = await getClient();
  try { return await gc.getIntensityMinutes(gc.userHash, date); }
  catch { return null; }
}

async function getHRVTrend(days = 7) {
  const results = [];
  for (let i = days - 1; i >= 0; i--) {
    try {
      const hrv = await getHRV(daysAgo(i));
      results.push({ date: daysAgo(i), hrv });
    } catch {
      results.push({ date: daysAgo(i), hrv: null });
    }
  }
  return results;
}

module.exports = {
  getClient, today, daysAgo,
  getDailySummary, getSleepData, getHRV, getBodyBattery,
  getTrainingReadiness, getTrainingStatus, getStress,
  getHeartRate, getRestingHeartRate, getLastActivity,
  getActivitiesByDate, getActivityDetails, getVO2Max,
  getRacePredictions, getPersonalRecords, getBodyComposition,
  getWeeklyIntensityMinutes, getHRVTrend,
};
