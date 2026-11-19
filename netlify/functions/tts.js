// Netlify Function: /.netlify/functions/tts   (the voice)
// Put this file next to curix.js in netlify/functions/.
// Voice engines, pick with TTS_PROVIDER = "google", "gemini" or "elevenlabs".
// If TTS_PROVIDER is not set the Gemini voice is used. The app can choose any of the 30 Gemini voices
// (female and male) and sends the name in the request.
//
//  Google Cloud   : GOOGLE_CLOUD_API_KEY  (Cloud Text-to-Speech API enabled, billing on)
//                   GOOGLE_TTS_VOICE      optional, default Aoede. Female Chirp 3 HD voices: Achernar, Aoede,
//                                         Autonoe, Callirrhoe, Despina, Erinome, Gacrux, Kore, Laomedeia, Leda,
//                                         Pulcherrima, Sulafat, Vindemiatrix, Zephyr
//                   GOOGLE_TTS_VOICE_EN / _HI / _BN  optional full voice names, e.g. en-IN-Chirp3-HD-Leda
//                   GOOGLE_TTS_RATE       optional speaking rate, e.g. 1.05
//
//  Gemini voice   : GEMINI_API_KEY (you already have it)
//                   GEMINI_TTS_MODEL  optional, default gemini-3.1-flash-tts-preview
//                   GEMINI_TTS_VOICE  optional, default Aoede (breezy, female). Other female voices:
//                                     Sulafat (warm), Leda (youthful), Zephyr (bright), Kore (firm), Achernar (soft),
//                                     Vindemiatrix (gentle), Despina (smooth), Gacrux (mature), Callirrhoe (easy-going)
//                   GEMINI_TTS_STYLE  optional, how she should speak (default: warm, friendly and natural)
//  ElevenLabs     : ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID
//                   ELEVENLABS_MODEL (default eleven_flash_v2_5), ELEVENLABS_MODEL_BN (default eleven_v3)
//  Both           : CURIX_APP_TOKEN (same token as the brain function)

const FEMALE = ['Achernar','Aoede','Autonoe','Callirrhoe','Despina','Erinome','Gacrux','Kore','Laomedeia','Leda','Pulcherrima','Sulafat','Vindemiatrix','Zephyr'];
const MALE = ['Achird','Algenib','Algieba','Alnilam','Charon','Enceladus','Fenrir','Iapetus','Orus','Puck','Rasalgethi','Sadachbia','Sadaltager','Schedar','Umbriel','Zubenelgenubi'];
const pickVoice = (v) => [...FEMALE, ...MALE].find((x) => x.toLowerCase() === String(v || '').toLowerCase()) || null;

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


async function googleVoice(text, signal, chosen) {
  const key = process.env.GOOGLE_CLOUD_API_KEY;
  if (!key) return err(500, 'GOOGLE_CLOUD_API_KEY is not set');
  const bn = /[\u0980-\u09FF]/.test(text);
  const hi = /[\u0900-\u097F]/.test(text);
  const lang = bn ? 'bn-IN' : hi ? 'hi-IN' : 'en-IN';
  const short = lang.slice(0, 2).toUpperCase();
  const name = process.env['GOOGLE_TTS_VOICE_' + short]
    || `${lang}-Chirp3-HD-${chosen || process.env.GOOGLE_TTS_VOICE || 'Aoede'}`;
  const audioConfig = { audioEncoding: 'MP3' };
  if (process.env.GOOGLE_TTS_RATE) audioConfig.speakingRate = parseFloat(process.env.GOOGLE_TTS_RATE);
  const r = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize?key=' + encodeURIComponent(key), {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: { text }, voice: { languageCode: lang, name }, audioConfig }),
  });
  let data = {};
  try { data = await r.json(); } catch { /* ignore */ }
  if (!r.ok) return err(502, ((data.error && data.error.message) || 'Google TTS error ' + r.status).slice(0, 300));
  if (!data.audioContent) return err(502, 'Google TTS returned no audio');
  return audio(Buffer.from(data.audioContent, 'base64'), 'audio/mpeg');
}

async function geminiVoice(text, signal, chosen) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return err(500, 'GEMINI_API_KEY is not set');
  const model = process.env.GEMINI_TTS_MODEL || 'gemini-3.1-flash-tts-preview';
  const voice = process.env.GEMINI_TTS_VOICE || 'Aoede';
  const style = process.env.GEMINI_TTS_STYLE || 'a warm, friendly and natural female voice';
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `Say in ${style}: ${text}` }] }],
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

  // Default engine is Gemini voice (uses your GEMINI_API_KEY). Set TTS_PROVIDER to google or elevenlabs to change.
  const provider = (process.env.TTS_PROVIDER || 'gemini').toLowerCase();
  const chosen = pickVoice(body.voice);

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8500);
  try {
    if (provider === 'google') return await googleVoice(text, ctl.signal, chosen);
    return provider === 'gemini' ? await geminiVoice(text, ctl.signal, chosen) : await elevenVoice(text, ctl.signal);
  } catch (e) {
    return err(502, 'TTS failed: ' + (e.name === 'AbortError' ? 'timeout' : e.message));
  } finally {
    clearTimeout(timer);
  }
};
