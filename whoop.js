/**
 * whoop.js
 * Integración con Whoop API v2 (OAuth2)
 * Datos: recovery score, HRV, strain, sueño, SpO2
 */

const axios = require("axios");

const WHOOP_API   = "https://api.prod.whoop.com/developer/v1";
const TOKEN_URL   = "https://api.prod.whoop.com/oauth/oauth2/token";
const AUTH_URL    = "https://api.prod.whoop.com/oauth/oauth2/auth";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const CLIENT_ID    = process.env.WHOOP_CLIENT_ID;
const CLIENT_SECRET = process.env.WHOOP_CLIENT_SECRET;
const REDIRECT_URI  = process.env.WHOOP_REDIRECT_URI; // e.g. https://tobin-health-production.up.railway.app/whoop/callback

// ── Token storage in Supabase ────────────────────────────────────────────────

const SUPA_H = () => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
});

async function saveTokens(tokens) {
  await axios.post(
    `${SUPABASE_URL}/rest/v1/whoop_tokens`,
    { id: 1, ...tokens, updated_at: new Date().toISOString() },
    { headers: { ...SUPA_H(), Prefer: "resolution=merge-duplicates" } }
  );
}

async function loadTokens() {
  const r = await axios.get(
    `${SUPABASE_URL}/rest/v1/whoop_tokens?id=eq.1&limit=1`,
    { headers: SUPA_H() }
  );
  return r.data?.[0] || null;
}

// ── OAuth helpers ─────────────────────────────────────────────────────────────

function getAuthURL() {
  const state = Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "read:recovery read:sleep read:workout read:cycles read:body_measurement offline",
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function exchangeCode(code) {
  const r = await axios.post(TOKEN_URL, new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
  }), { headers: { "Content-Type": "application/x-www-form-urlencoded" } });

  const tokens = {
    access_token:  r.data.access_token,
    refresh_token: r.data.refresh_token,
    expires_at:    Date.now() + r.data.expires_in * 1000,
  };
  await saveTokens(tokens);
  return tokens;
}

async function refreshTokens(refreshToken) {
  const r = await axios.post(TOKEN_URL, new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  }), { headers: { "Content-Type": "application/x-www-form-urlencoded" } });

  const tokens = {
    access_token:  r.data.access_token,
    refresh_token: r.data.refresh_token || refreshToken,
    expires_at:    Date.now() + r.data.expires_in * 1000,
  };
  await saveTokens(tokens);
  return tokens;
}

async function getAccessToken() {
  let tokens = await loadTokens();
  if (!tokens) throw new Error("Whoop no autorizado. Visita /whoop/start para conectar.");

  // Refresh if expires in < 5 min
  if (Date.now() > tokens.expires_at - 5 * 60 * 1000) {
    tokens = await refreshTokens(tokens.refresh_token);
  }
  return tokens.access_token;
}

// ── API calls ─────────────────────────────────────────────────────────────────

async function whoopGet(path, params = {}) {
  const token = await getAccessToken();
  const r = await axios.get(`${WHOOP_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    params,
  });
  return r.data;
}

// Latest recovery (score, HRV, RHR, SpO2)
async function getLatestRecovery() {
  const data = await whoopGet("/recovery", { limit: 1 });
  return data?.records?.[0] || null;
}

// Recovery for last N days
async function getRecoveryHistory(days = 7) {
  const start = new Date();
  start.setDate(start.getDate() - days);
  const data = await whoopGet("/recovery", {
    start: start.toISOString(),
    limit: days + 1,
  });
  return data?.records || [];
}

// Latest sleep
async function getLatestSleep() {
  const data = await whoopGet("/activity/sleep", { limit: 1 });
  return data?.records?.[0] || null;
}

// Latest cycle (strain)
async function getLatestCycle() {
  const data = await whoopGet("/cycle", { limit: 1 });
  return data?.records?.[0] || null;
}

// Today's workouts
async function getTodayWorkouts() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const data = await whoopGet("/activity/workout", {
    start: start.toISOString(),
    limit: 10,
  });
  return data?.records || [];
}

// Check if Whoop is connected
async function isConnected() {
  try {
    await loadTokens();
    return true;
  } catch { return false; }
}

// Summary object for briefing
async function getDailySummary() {
  const [recovery, sleep, cycle] = await Promise.allSettled([
    getLatestRecovery(),
    getLatestSleep(),
    getLatestCycle(),
  ]);

  const val = s => s.status === "fulfilled" ? s.value : null;
  const r = val(recovery);
  const s = val(sleep);
  const c = val(cycle);

  return {
    recovery: r ? {
      score:       r.score?.recovery_score,
      hrv:         r.score?.hrv_rmssd_milli,
      rhr:         r.score?.resting_heart_rate,
      spo2:        r.score?.spo2_percentage,
      skinTemp:    r.score?.skin_temp_celsius,
    } : null,
    sleep: s ? {
      score:       s.score?.sleep_performance_percentage,
      totalHours:  s.score ? (s.score.total_in_bed_time_milli / 3600000).toFixed(1) : null,
      efficiency:  s.score?.sleep_efficiency_percentage,
      deepHours:   s.score ? (s.score.slow_wave_sleep_duration_milli / 3600000).toFixed(1) : null,
      remHours:    s.score ? (s.score.rem_sleep_duration_milli / 3600000).toFixed(1) : null,
      disturbances: s.score?.disturbances_count,
    } : null,
    strain: c ? {
      score:       c.score?.strain,
      avgHR:       c.score?.average_heart_rate,
      maxHR:       c.score?.max_heart_rate,
      kilojoules:  c.score?.kilojoule,
    } : null,
  };
}

module.exports = {
  getAuthURL, exchangeCode,
  getLatestRecovery, getRecoveryHistory,
  getLatestSleep, getLatestCycle,
  getTodayWorkouts, isConnected, getDailySummary,
};
