const ALLOWED_ORIGIN = 'https://ai-recipe-chef-iota.vercel.app';
const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 10;
const SHORT_WINDOW_MS = 60 * 1000;
const SHORT_MAX_REQUESTS = 3;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_PROMPT_LENGTH = 4000;

const rateBuckets = globalThis.__recipeRateBuckets || new Map();
globalThis.__recipeRateBuckets = rateBuckets;

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  return (forwarded ? forwarded.split(',')[0] : req.socket?.remoteAddress || 'unknown').trim();
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

function rateLimit(ip) {
  const now = Date.now();
  const current = rateBuckets.get(ip) || { windowStart: now, count: 0, shortStart: now, shortCount: 0 };
  if (now - current.windowStart >= WINDOW_MS) { current.windowStart = now; current.count = 0; }
  if (now - current.shortStart >= SHORT_WINDOW_MS) { current.shortStart = now; current.shortCount = 0; }
  current.count += 1; current.shortCount += 1; rateBuckets.set(ip, current);
  return current.count <= MAX_REQUESTS && current.shortCount <= SHORT_MAX_REQUESTS;
}

function validateRequest(body) {
  if (!body || !Array.isArray(body.contents) || body.contents.length < 1 || body.contents.length > 2) return 'Invalid request structure';
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_BODY_BYTES) return 'Request too large';
  const text = body.contents.map(item => Array.isArray(item?.parts) ? item.parts.map(part => typeof part?.text === 'string' ? part.text : '').join(' ') : '').join(' ');
  if (!text || text.length > MAX_PROMPT_LENGTH) return 'Prompt is invalid';
  return null;
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  if (!rateLimit(getClientIp(req))) return res.status(429).json({ error: 'Too many requests' });
  const validationError = validateRequest(req.body);
  if (validationError) return res.status(400).json({ error: validationError });
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Service configuration error' });

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body) }
    );
    const body = await response.text();
    if (!response.ok) return res.status(response.status).json({ error: 'Recipe service request failed' });
    let parsed;
    try { parsed = JSON.parse(body); } catch { return res.status(502).json({ error: 'Invalid recipe service response' }); }
    if (!parsed?.candidates?.[0]?.content?.parts?.[0]?.text) return res.status(502).json({ error: 'Invalid recipe service response' });
    return res.status(200).json(parsed);
  } catch {
    return res.status(502).json({ error: 'Recipe service unavailable' });
  }
};
