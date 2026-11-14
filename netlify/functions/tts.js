// Netlify Function: /.netlify/functions/tts   (ElevenLabs voice)
// Put this file next to curix.js in netlify/functions/.
// Env vars:
//   ELEVENLABS_API_KEY   required (stays on the server, never in the app)
//   ELEVENLABS_VOICE_ID  required (the Voice ID of the voice you want)
//   ELEVENLABS_MODEL     optional, default eleven_flash_v2_5 (fast; English, Hindi and 30 more languages)
//   ELEVENLABS_MODEL_BN  optional, default eleven_v3 (used when the text is Bengali)
//   CURIX_APP_TOKEN      same token as the brain function

const err = (code, message) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ error: message }),
});

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return err(405, 'POST only');

  const needToken = process.env.CURIX_APP_TOKEN;
  const got = event.headers['x-curix-token'] || event.headers['X-Curix-Token'];
  if (!needToken || got !== needToken) return err(401, 'Unauthorized');

  const key = process.env.ELEVENLABS_API_KEY;
  const voice = process.env.ELEVENLABS_VOICE_ID;
  if (!key || !voice) return err(500, 'ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID is not set');

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return err(400, 'Bad JSON'); }
  const text = String(body.text || '').replace(/[*_`#]/g, '').trim().slice(0, 800);  // cap = cost control
  if (!text) return err(400, 'No text');

  const bengali = /[\u0980-\u09FF]/.test(text);
  const model = bengali
    ? (process.env.ELEVENLABS_MODEL_BN || 'eleven_v3')
    : (process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5');

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_64`,
      {
        method: 'POST',
        signal: ctl.signal,
        headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({ text, model_id: model }),
      }
    );
    if (!r.ok) {
      let msg = 'ElevenLabs error ' + r.status;
      try { const j = await r.json(); msg = (j.detail && (j.detail.message || j.detail)) || msg; } catch { /* ignore */ }
      return err(502, String(msg).slice(0, 300));
    }
    const buf = Buffer.from(await r.arrayBuffer());
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'audio/mpeg' },
      body: buf.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (e) {
    return err(502, 'TTS failed: ' + (e.name === 'AbortError' ? 'timeout' : e.message));
  } finally {
    clearTimeout(timer);
  }
};
