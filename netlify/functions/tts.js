// Netlify Function: /.netlify/functions/tts   (the voice)
// Put this file next to curix.js in netlify/functions/.
// Two voice engines, pick with TTS_PROVIDER = "gemini" or "elevenlabs".
// If TTS_PROVIDER is not set: ElevenLabs when its two variables exist, otherwise Gemini.
//
//  Gemini voice   : GEMINI_API_KEY (you already have it)
//                   GEMINI_TTS_MODEL  optional, default gemini-3.1-flash-tts-preview
//                   GEMINI_TTS_VOICE  optional, default Kore (others: Puck, Leda, Charon, Aoede, Fenrir ...)
//  ElevenLabs     : ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID
//                   ELEVENLABS_MODEL (default eleven_flash_v2_5), ELEVENLABS_MODEL_BN (default eleven_v3)
//  Both           : CURIX_APP_TOKEN (same token as the brain function)

const err = (code, message) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ error: message }),
});

const audio = (buf, type) => ({
  statusCode: 200,
  headers: { 'Content-Type': type },
  body: buf.toString('base64'),
  isBase64Encoded: true,
});

// Gemini returns raw 16-bit PCM; Android's player needs a WAV header in front of it.
function pcmToWav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

async function geminiVoice(text, signal) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return err(500, 'GEMINI_API_KEY is not set');
  const model = process.env.GEMINI_TTS_MODEL || 'gemini-3.1-flash-tts-preview';
  const voice = process.env.GEMINI_TTS_VOICE || 'Kore';
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `Say in a warm, friendly, natural voice: ${text}` }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      },
    }),
  });
  let data = {};
  try { data = await r.json(); } catch { /* ignore */ }
  if (!r.ok) return err(502, ((data.error && data.error.message) || 'Gemini TTS error ' + r.status).slice(0, 300));
  const part = (((data.candidates || [])[0] || {}).content || {}).parts;
  const inline = part && part[0] && (part[0].inlineData || part[0].inline_data);
  if (!inline || !inline.data) return err(502, 'Gemini TTS returned no audio (model name may be wrong).');
  const m = /rate=(\d+)/.exec(inline.mimeType || inline.mime_type || '');
  const rate = m ? parseInt(m[1], 10) : 24000;
  return audio(pcmToWav(Buffer.from(inline.data, 'base64'), rate), 'audio/wav');
}

async function elevenVoice(text, signal) {
  const key = process.env.ELEVENLABS_API_KEY;
  const voice = process.env.ELEVENLABS_VOICE_ID;
  if (!key || !voice) return err(500, 'ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID is not set');
  const bengali = /[\u0980-\u09FF]/.test(text);
  const model = bengali
    ? (process.env.ELEVENLABS_MODEL_BN || 'eleven_v3')
    : (process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5');
  const r = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_64`,
    {
      method: 'POST',
      signal,
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: model }),
    }
  );
  if (!r.ok) {
    let msg = 'ElevenLabs error ' + r.status;
    try { const j = await r.json(); msg = (j.detail && (j.detail.message || j.detail)) || msg; } catch { /* ignore */ }
    return err(502, String(msg).slice(0, 300));
  }
  return audio(Buffer.from(await r.arrayBuffer()), 'audio/mpeg');
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return err(405, 'POST only');

  const needToken = process.env.CURIX_APP_TOKEN;
  const got = event.headers['x-curix-token'] || event.headers['X-Curix-Token'];
  if (!needToken || got !== needToken) return err(401, 'Unauthorized');

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return err(400, 'Bad JSON'); }
  const text = String(body.text || '').replace(/[*_`#]/g, '').trim().slice(0, 800);  // cap = cost control
  if (!text) return err(400, 'No text');

  const provider = (process.env.TTS_PROVIDER
    || (process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID ? 'elevenlabs' : 'gemini')).toLowerCase();

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8500);
  try {
    return provider === 'gemini' ? await geminiVoice(text, ctl.signal) : await elevenVoice(text, ctl.signal);
  } catch (e) {
    return err(502, 'TTS failed: ' + (e.name === 'AbortError' ? 'timeout' : e.message));
  } finally {
    clearTimeout(timer);
  }
};
