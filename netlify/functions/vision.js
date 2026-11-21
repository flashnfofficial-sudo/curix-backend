// Netlify Function: /.netlify/functions/vision   (camera vision: objects, documents, text, scenes)
// The app sends ONE small JPEG photo plus a question. Gemini looks at it and answers.
// Env vars: GEMINI_API_KEY, CURIX_APP_TOKEN (already set).
//           GEMINI_VISION_MODEL optional (default = GEMINI_MODEL).  GEMINI_FALLBACK_MODEL is used if busy.

const json = (code, obj) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify(obj),
});

const prompts = (mode, lang) => {
  const base = `You are CURIX, a friendly personal AI assistant looking through the user's phone camera. Address the user as "sir" naturally. `
    + `Answer in the user's language (English, Hindi, Bengali or Hinglish; the app language hint is ${lang || 'auto'}). `
    + `Never invent details you cannot see: if something is unclear or too small, say so and suggest how to hold the camera. `;
  if (mode === 'read') {
    return base + 'The user wants the text in the photo. Read ALL visible text accurately in reading order. If it is a document, give the text, then a one-sentence summary. No markdown.';
  }
  if (mode === 'live') {
    return base + 'This is a continuous live-vision check. Reply with ONE short sentence (max 20 words). No markdown.';
  }
  return base + 'Your answer is spoken aloud: keep it short (1 to 3 sentences) unless the user asks for detail. '
    + 'For objects, products, animals, plants or landmarks, name them and add one useful fact; say when you are not sure. '
    + 'For diagrams or documents, explain the key point. No markdown, no lists.';
};

async function ask(model, system, question, image, ms) {
  const key = process.env.GEMINI_API_KEY;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: question }, { inlineData: { mimeType: 'image/jpeg', data: image } }] }],
    generationConfig: { temperature: 0.4 },
  };
  if (process.env.GEMINI_THINKING_LEVEL) body.generationConfig.thinkingConfig = { thinkingLevel: process.env.GEMINI_THINKING_LEVEL };
  const call = async (b) => {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(b),
    });
    let data = {};
    try { data = await r.json(); } catch { /* ignore */ }
    return { ok: r.ok, status: r.status, data };
  };
  try {
    let r = await call(body);
    if (!r.ok && r.status === 400 && body.generationConfig.thinkingConfig) {
      delete body.generationConfig.thinkingConfig; // this model does not accept the thinking option
      r = await call(body);
    }
    return r;
  } catch (e) {
    return { ok: false, status: 504, data: { error: { message: 'timeout' } } };
  } finally {
    clearTimeout(timer);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  const needToken = process.env.CURIX_APP_TOKEN;
  const got = event.headers['x-curix-token'] || event.headers['X-Curix-Token'];
  if (!needToken || got !== needToken) return json(401, { error: 'Unauthorized' });
  if (!process.env.GEMINI_API_KEY) return json(500, { error: 'GEMINI_API_KEY is not set on the server' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad JSON' }); }
  const image = String(body.image || '');
  if (!image || image.length > 4500000) return json(400, { error: 'Photo missing or too large' });
  const mode = ['ask', 'read', 'live'].includes(body.mode) ? body.mode : 'ask';
  const question = String(body.question || 'What is this? Describe it briefly.').slice(0, 600);
  const system = prompts(mode, body.lang);

  const main = process.env.GEMINI_VISION_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const fb = process.env.GEMINI_FALLBACK_MODEL;
  const models = [main, fb && fb !== main ? fb : main];
  const deadline = Date.now() + 9000;
  let err = 'Vision failed';
  for (let i = 0; i < models.length; i++) {
    const left = deadline - Date.now();
    if (left < 1500) break;
    const r = await ask(models[i], system, question, image, i === 0 ? Math.min(6500, left - 200) : left - 200);
    if (r.ok) {
      const text = ((((r.data.candidates || [])[0] || {}).content || {}).parts || []).map((p) => p.text || '').join('').trim();
      if (text) return json(200, { text });
      err = 'The AI could not describe this photo (it may have been blocked). Try again.';
      continue;
    }
    err = (r.data.error && r.data.error.message) || 'Vision error ' + r.status;
    if (![429, 500, 503, 504].includes(r.status)) break;
  }
  return json(502, { error: String(err).slice(0, 300) });
};
