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

// Get cycles (each cycle contains strain; recovery/sleep linked via cycle_id)
async function getCycles(limit = 3) {
  const data = await whoopGet("/cycle", { limit });
  return data?.records || [];
}

async function getLatestCycle() {
  const cycles = await getCycles(1);
  return cycles[0] || null;
}

// Recovery lives at /cycle/{cycle_id}/recovery
async function getLatestRecovery() {
  const cycle = await getLatestCycle();
  if (!cycle) return null;
  try {
    const data = await whoopGet(`/cycle/${cycle.id}/recovery`);
    return data;
  } catch { return null; }
}

// Recovery history — fetch last N cycles and their recovery
async function getRecoveryHistory(days = 7) {
  const cycles = await getCycles(days);
  const results = [];
  for (const cycle of cycles) {
    try {
      const rec = await whoopGet(`/cycle/${cycle.id}/recovery`);
      results.push({ cycle_id: cycle.id, start: cycle.start, recovery: rec });
    } catch {
      results.push({ cycle_id: cycle.id, start: cycle.start, recovery: null });
    }
  }
  return results;
}

// Sleep lives at /cycle/{cycle_id}/sleep
async function getLatestSleep() {
  const cycle = await getLatestCycle();
  if (!cycle) return null;
  try {
    const data = await whoopGet(`/cycle/${cycle.id}/sleep`);
    return data;
  } catch { return null; }
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
    const tokens = await loadTokens();
    return !!tokens;
  } catch { return false; }
}

// Summary object for briefing
async function getDailySummary() {
  // Get last 2 cycles (today + yesterday)
  const cycles = await getCycles(2);
  const latest = cycles[0];
  const prev   = cycles[1];

  let recovery = null;
  let sleep    = null;

  // Try recovery and sleep on latest cycle, fall back to previous
  for (const cycle of cycles) {
    if (!recovery) {
      try { recovery = await whoopGet(`/cycle/${cycle.id}/recovery`); } catch {}
    }
    if (!sleep) {
      try { sleep = await whoopGet(`/cycle/${cycle.id}/sleep`); } catch {}
    }
    if (recovery && sleep) break;
  }

  return {
    recovery: recovery ? {
      score:    recovery.score?.recovery_score,
      hrv:      recovery.score?.hrv_rmssd_milli,
      rhr:      recovery.score?.resting_heart_rate,
      spo2:     recovery.score?.spo2_percentage,
      skinTemp: recovery.score?.skin_temp_celsius,
    } : null,
    sleep: sleep ? {
      score:       sleep.score?.sleep_performance_percentage,
      totalHours:  sleep.score ? (sleep.score.total_in_bed_time_milli / 3600000).toFixed(1) : null,
      efficiency:  sleep.score?.sleep_efficiency_percentage,
      deepHours:   sleep.score ? (sleep.score.slow_wave_sleep_duration_milli / 3600000).toFixed(1) : null,
      remHours:    sleep.score ? (sleep.score.rem_sleep_duration_milli / 3600000).toFixed(1) : null,
      disturbances: sleep.score?.disturbances_count,
    } : null,
    strain: latest ? {
      score:      latest.score?.strain,
      avgHR:      latest.score?.average_heart_rate,
      maxHR:      latest.score?.max_heart_rate,
      kilojoules: latest.score?.kilojoule,
    } : null,
    prevStrain: prev ? {
      score:      prev.score?.strain,
      kilojoules: prev.score?.kilojoule,
    } : null,
  };
}

module.exports = {
  getAuthURL, exchangeCode, whoopGet,
  getLatestRecovery, getRecoveryHistory,
  getLatestSleep, getLatestCycle,
  getTodayWorkouts, isConnected, getDailySummary,
};
