// Netlify Function: /.netlify/functions/stt   (speech to text, Google Cloud Speech-to-Text)
// The app records one sentence (16 kHz, 16-bit PCM), sends it here, and gets the text back.
// Two engines:
//   - Gemini (default when GOOGLE_CLOUD_API_KEY is not set): uses your existing GEMINI_API_KEY, no extra account.
//   - Google Cloud Speech-to-Text (when GOOGLE_CLOUD_API_KEY is set). Force one with STT_PROVIDER=gemini|google.
// Env vars:
//   GEMINI_API_KEY        needed for the Gemini engine (you already have it)
//   GEMINI_STT_MODEL      optional (default: your GEMINI_MODEL); GEMINI_FALLBACK_MODEL is tried if the first is busy
//   GOOGLE_CLOUD_API_KEY  only for the Google Cloud engine (Speech-to-Text API enabled)
//   CURIX_APP_TOKEN       required (same token as the other functions)
//   STT_MODEL             optional (e.g. latest_short); empty = Google's default model
//   STT_LANGS             optional, default "en-IN,hi-IN,bn-IN" (the languages CURIX understands)

const json = (code, obj) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify(obj),
});

const PHRASES = ['CURIX', 'Hey CURIX', 'Moidul', 'WhatsApp', 'YouTube', 'Arijit Singh', 'flashlight', 'Bluetooth'];


function pcmToWav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const GEMINI_PROMPT = 'Transcribe this short voice recording exactly as spoken, nothing else. '
  + 'Write each language in its own script: English in Latin letters, Hindi in Devanagari, Bengali in Bengali script. '
  + 'The assistant is called CURIX (said "kyoo-riks") and its owner is Moidul. '
  + 'Do not answer, translate, explain or add quotes. If there is no clear human speech, output nothing at all.';

async function geminiTranscribe(audioB64, signal) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { ok: false, status: 500, message: 'GEMINI_API_KEY is not set on the server' };
  const wav = pcmToWav(Buffer.from(audioB64, 'base64'), 16000).toString('base64');
  const models = [process.env.GEMINI_STT_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash'];
  if (process.env.GEMINI_FALLBACK_MODEL && process.env.GEMINI_FALLBACK_MODEL !== models[0]) models.push(process.env.GEMINI_FALLBACK_MODEL);
  let last = { ok: false, status: 502, message: 'No answer from Gemini' };
  for (let i = 0; i < models.length; i++) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${models[i]}:generateContent`, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: GEMINI_PROMPT }, { inlineData: { mimeType: 'audio/wav', data: wav } }] }],
        generationConfig: { temperature: 0 },
      }),
    });
    let data = {};
    try { data = await r.json(); } catch { /* ignore */ }
    if (r.ok) {
      let text = (((data.candidates || [])[0] || {}).content || {}).parts;
      text = (text || []).map((p) => p.text || '').join(' ').trim();
      if (/^\[?\(?(no (clear )?(human )?speech|silence|inaudible|nothing)[^a-z]*\)?\]?\.?$/i.test(text)) text = '';
      text = text.replace(/^["“‘]+|["”’]+$/g, '').trim();
      return { ok: true, text };
    }
    last = { ok: false, status: r.status, message: ((data.error && data.error.message) || 'Gemini error ' + r.status) };
    if (![429, 500, 503].includes(r.status)) break;
  }
  return last;
}

async function recognize(key, audioB64, primary, alts, model, signal) {
  const config = {
    encoding: 'LINEAR16',
    sampleRateHertz: 16000,
    languageCode: primary,
    enableAutomaticPunctuation: true,
    maxAlternatives: 1,
    speechContexts: [{ phrases: PHRASES, boost: 15 }],
  };
  if (alts.length) config.alternativeLanguageCodes = alts;
  if (model) config.model = model;
  const r = await fetch('https://speech.googleapis.com/v1/speech:recognize?key=' + encodeURIComponent(key), {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config, audio: { content: audioB64 } }),
  });
  let data = {};
  try { data = await r.json(); } catch { /* ignore */ }
  return { ok: r.ok, status: r.status, data };
}


exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  const needToken = process.env.CURIX_APP_TOKEN;
  const got = event.headers['x-curix-token'] || event.headers['X-Curix-Token'];
  if (!needToken || got !== needToken) return json(401, { error: 'Unauthorized' });

  const key = process.env.GOOGLE_CLOUD_API_KEY;
  const provider = (process.env.STT_PROVIDER || (key ? 'google' : 'gemini')).toLowerCase();
  if (provider === 'google' && !key) return json(500, { error: 'GOOGLE_CLOUD_API_KEY is not set on the server' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad JSON' }); }
  const audio = String(body.audio || '');
  if (!audio || audio.length > 1500000) return json(400, { error: 'Audio missing or too long' });

  const all = (process.env.STT_LANGS || 'en-IN,hi-IN,bn-IN').split(',').map((x) => x.trim()).filter(Boolean);
  const primary = all.includes(body.lang) ? body.lang : all[0];
  const alts = all.filter((x) => x !== primary).slice(0, 3);
  const model = process.env.STT_MODEL || '';

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 9000);
  try {
    if (provider === 'gemini') {
      const g = await geminiTranscribe(audio, ctl.signal);
      if (!g.ok) return json(502, { error: String(g.message).slice(0, 300) });
      return json(200, { text: g.text });
    }
    let res = await recognize(key, audio, primary, alts, model, ctl.signal);
    // some models do not accept alternative languages: retry with the main language only
    if (!res.ok && res.status === 400 && alts.length) {
      res = await recognize(key, audio, primary, [], model, ctl.signal);
    }
    if (!res.ok) {
      const msg = (res.data.error && res.data.error.message) || 'Speech-to-Text error ' + res.status;
      return json(502, { error: String(msg).slice(0, 300) });
    }
    const text = (res.data.results || [])
      .map((x) => ((x.alternatives || [])[0] || {}).transcript || '')
      .join(' ')
      .trim();
    return json(200, { text });
  } catch (e) {
    return json(502, { error: 'STT failed: ' + (e.name === 'AbortError' ? 'timeout' : e.message) });
  } finally {
    clearTimeout(timer);
  }
};
