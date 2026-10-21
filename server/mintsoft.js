// ─── server/mintsoft.js ───────────────────────────────────────────────────────
// Shared HTTP client for all Mintsoft API calls.
// All modules import this rather than making raw https calls directly.
//
// Every call has a timeout and is retried with exponential backoff on network
// errors (ECONNRESET, timeouts, DNS blips), 429 (honouring Retry-After) and 5xx.
// Callers still receive { status, body } and handle non-200 themselves.

const https = require('https');

const MINTSOFT_BASE = 'https://api.mintsoft.co.uk';
const agent = new https.Agent({ keepAlive: true, maxSockets: 4 });

const RETRYABLE_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'ESOCKETTIMEDOUT', 'ECONNABORTED',
]);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const backoffMs = attempt => Math.min(30_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);

function requestOnce(path, apiKey, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(`${MINTSOFT_BASE}${path}`, {
      agent,
      timeout: timeoutMs,
      headers: {
        'ms-apikey': apiKey,
        'Content-Type': 'application/json',
        'User-Agent': 'PFHub/3.0',
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('error', reject);
      res.on('end', () => {
        let body;
        try { body = JSON.parse(data); } catch { body = data; }
        resolve({ status: res.statusCode, body, headers: res.headers });
      });
    });
    req.on('timeout', () => {
      const err = new Error(`Mintsoft request timed out after ${timeoutMs} ms`);
      err.code = 'ETIMEDOUT';
      req.destroy(err);
    });
    req.on('error', reject);
  });
}

async function mintsoftGet(path, apiKey, { timeoutMs = 30_000, retries = 4 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await requestOnce(path, apiKey, timeoutMs);
    } catch (err) {
      if (attempt >= retries || !RETRYABLE_CODES.has(err.code)) throw err;
      await sleep(backoffMs(attempt));
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const retryAfter = parseInt(res.headers['retry-after'], 10);
      await sleep(Number.isFinite(retryAfter) ? Math.min(retryAfter, 120) * 1000 : backoffMs(attempt));
      continue;
    }
    return { status: res.status, body: res.body };
  }
}

module.exports = { mintsoftGet, MINTSOFT_BASE };
