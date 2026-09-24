// ─── server/auth.js ───────────────────────────────────────────────────────────
// Authenticates against Mintsoft; sessions stored in-memory.

const https  = require('https');
const crypto = require('crypto');
const { mintsoftGet } = require('./mintsoft');
const { runIncrementalSync } = require('./sync');
const { queryOne } = require('./db');
const { DEMO_WAREHOUSE, DEMO_CLIENTS } = require('./demo/constants');

// In-memory session store: { sessionToken: { apiKey, clientId, username, ... } }
const sessions = {};
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

// Secure cookies in production (Render sets RENDER; NODE_ENV may not be set there).
const SECURE_COOKIE = process.env.NODE_ENV === 'production' || !!process.env.RENDER;

function sessionCookie(token, maxAgeSec) {
  return `session=${token}; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}; Path=/${SECURE_COOKIE ? '; Secure' : ''}`;
}

// ── Login rate limit (in-memory, per IP): 10 attempts per 10 minutes ──────────
const LOGIN_WINDOW_MS    = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const loginAttempts = new Map(); // ip → [timestamps]

function clientIp(req) {
  // Cloudflare sets cf-connecting-ip; Render's proxy sets x-forwarded-for.
  return req.headers['cf-connecting-ip']
    || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress || 'unknown';
}

// Records an attempt; returns seconds to wait if the IP is over the limit, else 0.
function loginRateLimited(req) {
  const now = Date.now();
  const ip  = clientIp(req);
  const recent = (loginAttempts.get(ip) || []).filter(t => now - t < LOGIN_WINDOW_MS);
  if (recent.length >= LOGIN_MAX_ATTEMPTS) {
    loginAttempts.set(ip, recent);
    return Math.ceil((recent[0] + LOGIN_WINDOW_MS - now) / 1000);
  }
  recent.push(now);
  loginAttempts.set(ip, recent);
  if (loginAttempts.size > 10000) {
    for (const [k, ts] of loginAttempts) if (!ts.some(t => now - t < LOGIN_WINDOW_MS)) loginAttempts.delete(k);
  }
  return 0;
}

// ── Mintsoft Auth ─────────────────────────────────────────────────────────────

function mintsoftAuth(username, password) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ Username: username, Password: password });
    const options = {
      hostname: 'api.mintsoft.co.uk',
      path:     '/api/Auth',
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent':     'PFForecaster/2.0'
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Mintsoft auth failed: ${res.statusCode} — ${data}`));
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const apiKey = typeof parsed === 'string'
            ? parsed
            : (parsed.ApiKey || parsed.apiKey || parsed.Token || parsed.token || parsed);
          if (!apiKey) { reject(new Error('No API key in Mintsoft response')); return; }
          resolve(String(apiKey).trim());
        } catch(e) {
          reject(new Error(`Failed to parse Mintsoft auth response: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function fetchWarehouses(apiKey) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.mintsoft.co.uk',
      path:     '/api/Warehouse',
      method:   'GET',
      headers:  { 'ms-apikey': apiKey, 'User-Agent': 'PFForecaster/2.0' }
    };
    console.log('  fetchWarehouses: GET /api/Warehouse');
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log(`  fetchWarehouses: status=${res.statusCode} body=${data.substring(0, 150)}`);
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode === 200 && Array.isArray(parsed)) {
            const warehouses = parsed.map(w => ({
              ID:   w.ID   || w.Id   || w.WarehouseId,
              Name: w.Name || w.WarehouseName || w.ShortName || String(w.ID || w.Id)
            })).filter(w => w.ID);
            console.log(`  ✓ ${warehouses.length} warehouse(s) found`);
            resolve(warehouses);
          } else {
            resolve([]);
          }
        } catch(e) { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.end();
  });
}

// 200 on /api/Client = warehouse user; 401/403 = client user
function detectUserType(apiKey) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.mintsoft.co.uk',
      path:     '/api/Client?limit=100',
      method:   'GET',
      headers:  { 'ms-apikey': apiKey, 'User-Agent': 'PFForecaster/2.0' }
    };
    console.log('  detectUserType: GET /api/Client?limit=100');
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log(`  detectUserType: status=${res.statusCode} body=${data.substring(0, 150)}`);
        if (res.statusCode === 200) {
          try {
            const parsed     = JSON.parse(data);
            const clientArr  = Array.isArray(parsed) ? parsed : [];
            console.log(`  ✓ Warehouse user — ${clientArr.length} clients`);
            resolve({ isWarehouse: true, clients: clientArr });
          } catch(e) {
            resolve({ isWarehouse: true, clients: [] });
          }
        } else {
          console.log(`  Client user detected (status ${res.statusCode})`);
          resolve({ isWarehouse: false, clients: [] });
        }
      });
    });
    req.on('error', (e) => {
      console.log(`  detectUserType error: ${e.message}`);
      resolve({ isWarehouse: false, clients: [] });
    });
    req.end();
  });
}

function fetchClientProfile(apiKey) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.mintsoft.co.uk',
      path:     '/api/ClientUser/Current',
      method:   'GET',
      headers:  { 'ms-apikey': apiKey, 'User-Agent': 'PFForecaster/2.0' }
    };
    console.log('  fetchClientProfile: GET /api/ClientUser/Current');
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log(`  fetchClientProfile: status=${res.statusCode}`);
        if (res.statusCode !== 200) { resolve(null); return; }
        try { resolve(JSON.parse(data)); } catch(e) { resolve(null); }
      });
    });
    req.on('error', (e) => { console.log(`  fetchClientProfile error: ${e.message}`); resolve(null); });
    req.end();
  });
}

async function inferClientIdFromStock(apiKey, warehouseId) {
  try {
    const result = await mintsoftGet(
      `/api/Product/StockLevels?WarehouseId=${encodeURIComponent(warehouseId)}&Limit=1`,
      apiKey
    );
    if (result.status === 200 && Array.isArray(result.body) && result.body.length > 0) {
      return result.body[0].ClientId || result.body[0].clientId || null;
    }
  } catch (e) {
    console.log(`  inferClientIdFromStock failed: ${e.message}`);
  }
  return null;
}

// ── Session helpers ───────────────────────────────────────────────────────────

function createSession(apiKey, clientId, username, isWarehouse = false, clients = [], warehouses = [], demo = false) {
  pruneExpiredSessions();
  const token = crypto.randomBytes(32).toString('hex');
  sessions[token] = {
    apiKey, clientId, username, isWarehouse, demo,
    clients,    // [{ ID, Name }] for warehouse users
    warehouses, // [{ ID, Name }] for all users
    expiresAt: Date.now() + SESSION_TTL_MS
  };
  return token;
}

function getSessionFromToken(token) {
  if (!token) return null;
  const session = sessions[token];
  if (!session) return null;
  if (Date.now() > session.expiresAt) { delete sessions[token]; return null; }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

function pruneExpiredSessions() {
  const now = Date.now();
  for (const token in sessions) {
    if (now > sessions[token].expiresAt) delete sessions[token];
  }
}

function getTokenFromRequest(req) {
  const cookie = req.headers.cookie || '';
  const match  = cookie.match(/session=([a-f0-9]+)/);
  return match ? match[1] : null;
}

// ── Exported middleware + route handlers ──────────────────────────────────────

function getSession(req) {
  return getSessionFromToken(getTokenFromRequest(req));
}

function requireSession(req, res) {
  const session = getSession(req);
  if (!session) { res.json(401, { error: 'Not authenticated' }); return null; }
  return session;
}

// POST /api/login
async function login(req, res) {
  const retryAfter = loginRateLimited(req);
  if (retryAfter) {
    res.setHeader('Retry-After', String(retryAfter));
    return res.json(429, { error: 'Too many login attempts — please wait a few minutes and try again' });
  }
  try {
    const { username, password } = await req.json();
    if (!username || !password) return res.json(400, { error: 'Username and password required' });

    console.log(`Login attempt: ${username}`);
    const apiKey = await mintsoftAuth(username, password);
    console.log(`✓ Mintsoft auth successful for ${username}`);

    const { isWarehouse, clients } = await detectUserType(apiKey);
    const warehouses = await fetchWarehouses(apiKey);

    let clientId = null;
    if (!isWarehouse) {
      const profile = await fetchClientProfile(apiKey);
      if (profile && typeof profile === 'object') {
        clientId = profile.ClientId || profile.clientId || profile.ClientID
          || profile.client_id || profile.Client?.ID || profile.Client?.Id || null;
        console.log(`  Profile keys: ${Object.keys(profile).join(', ')}, ClientId: ${clientId}`);
      }
      if (!clientId && warehouses.length > 0) {
        clientId = await inferClientIdFromStock(apiKey, warehouses[0].ID);
        if (clientId) console.log(`  ClientId inferred from stock: ${clientId}`);
      }
      if (!clientId) console.log('  WARNING: could not determine ClientId for client user');
    }

    const token = createSession(apiKey, clientId, username, isWarehouse, clients, warehouses);

    setImmediate(() => triggerBackgroundSync({ apiKey, username, isWarehouse }));

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie':   sessionCookie(token, SESSION_TTL_MS / 1000)
    });
    res.end(JSON.stringify({
      success:    true,
      username,
      clientId,
      isWarehouse,
      clients:    isWarehouse ? clients.map(c => ({ ID: c.ID || c.Id, Name: c.Name || c.ClientName || c.ShortName })) : [],
      warehouses,
    }));
  } catch (err) {
    console.error('Login error:', err.message);
    if (err.message.includes('401') || err.message.includes('auth failed')) {
      return res.json(401, { error: 'Invalid username or password' });
    }
    res.json(500, { error: 'Login failed — please try again' });
  }
}

// POST /api/demo-login
// Creates a read-only demo session — no Mintsoft credentials, no API key.
// Only available when DEMO_MODE is enabled on the deployment.
function demoLogin(req, res) {
  if (!process.env.DEMO_MODE) return res.json(404, { error: 'Not found' });

  // Warehouse persona: sees every demo client + the client picker.
  const token = createSession(
    null,                 // apiKey — none; demo never calls Mintsoft
    null,                 // clientId — warehouse user is not locked to one client
    'Demo User',
    true,                 // isWarehouse
    DEMO_CLIENTS,         // clients [{ ID, Name }]
    [DEMO_WAREHOUSE],     // warehouses [{ ID, Name }]
    true,                 // demo
  );

  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Set-Cookie':   sessionCookie(token, SESSION_TTL_MS / 1000)
  });
  res.end(JSON.stringify({
    success:     true,
    demo:        true,
    username:    'Demo User',
    clientId:    null,
    isWarehouse: true,
    clients:     DEMO_CLIENTS,
    warehouses:  [DEMO_WAREHOUSE],
  }));
}

// Only warehouse logins may start a sync, and only an incremental one when no
// job has started in the last 6 h and none is currently running (a 'running'
// row older than 3 h is a zombie, see sync.abandonStaleJobs). Client logins
// never sync: client keys must not write into the shared tables.
async function triggerBackgroundSync({ apiKey, username, isWarehouse }) {
  if (!isWarehouse) return;
  try {
    const recent = await queryOne(
      `SELECT id, status, started_at FROM sync_jobs
       WHERE started_at > NOW() - INTERVAL '6 hours'
          OR (status = 'running' AND started_at > NOW() - INTERVAL '3 hours')
       ORDER BY started_at DESC LIMIT 1`
    );
    if (recent) {
      console.log(`[sync] Login by ${username} — skipping sync (job ${recent.id} ${recent.status} started ${recent.started_at.toISOString()})`);
      return;
    }
    console.log(`[sync] Login by ${username} — running incremental`);
    await runIncrementalSync({ apiKey, triggeredBy: 'login' });
  } catch (err) {
    console.error('[sync] Background sync error:', err.message);
  }
}

// POST /api/logout
function logout(req, res) {
  const token = getTokenFromRequest(req);
  if (token) delete sessions[token];
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Set-Cookie':   sessionCookie('', 0)
  });
  res.end(JSON.stringify({ success: true }));
}

// GET /api/me
function me(req, res) {
  const session = getSession(req);
  if (!session) return res.json(401, { error: 'Not authenticated' });
  res.json(200, {
    username:    session.username,
    clientId:    session.clientId,
    isWarehouse: session.isWarehouse || false,
    demo:        session.demo        || false,
    clients:     session.clients     || [],
    warehouses:  session.warehouses  || []
  });
}

module.exports = { login, demoLogin, logout, me, getSession, requireSession };
