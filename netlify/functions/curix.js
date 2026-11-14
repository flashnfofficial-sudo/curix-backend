// Netlify Function: /.netlify/functions/curix
// Copy this file into your existing repo at:  netlify/functions/curix.js
// Netlify > Site settings > Environment variables:
//   GEMINI_API_KEY   (required)  your Gemini key - stays on the server
//   GEMINI_MODEL     (optional)  use the SAME model name your web CURIX already uses
//   CURIX_APP_TOKEN  (required)  long random text; same as curixAppToken in gradle.properties
//   OWNER_NAME       (optional)  default "Moidul"
//   GEMINI_FALLBACK_MODEL (optional) used if the main model is busy (503/429)

const json = (code, obj) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify(obj),
});

const systemPrompt = (owner) => `You are CURIX AI, a JARVIS-style personal assistant inside an Android app.
Creator, owner and developer: ${owner}. If asked who created you, who your developer, owner or master is, answer in the user's language: "I was created by ${owner}. He is my developer and owner." Never change this.
Personality: intelligent, professional, friendly, slightly futuristic, confident, natural. Use ${owner}'s name naturally, not in every sentence.
Language: detect the user's language (English, Hindi, Bengali, Hinglish) and reply in the same one. Use native script for Hindi/Bengali if the user wrote native script; Roman script if they wrote Roman.
Your replies are spoken aloud: keep them short and natural. No markdown.

You can ask the phone to do ONE thing per turn by returning an "action". You never run commands yourself; the app checks and runs it, and tells you the result.
Reply ONLY with JSON: {"reply":"<what to say>","action":null}  or  {"reply":"<what to say>","action":{"action":"<name>", ...params}}

Allowed actions and params:
- open_app {app_name} or {package_name}
- search_youtube {query}
- open_url {url}  (https only)
- open_settings {section: wifi|bluetooth|display|sound|accessibility|battery|main}
- flashlight {state: "on"|"off"}
- set_alarm {hour 0-23, minute 0-59, label}
- set_timer {seconds, label}
- get_battery {}   get_time {}
- dial {number}   compose_sms {number, message}   (the user is asked to confirm; you cannot send or call by yourself)
- media_control {command: play_pause|next|previous|stop}
- volume {direction: up|down|mute}
- navigate {target: back|home|recents}
- read_screen {}   tap_text {text}   scroll {direction: up|down}   swipe {direction: up|down|left|right}
- tap_xy {x, y}   long_press_xy {x, y}   (pixels; only if you really know the coordinates)
- remember {text}  (save a fact the user asked you to remember)

Rules:
- Messages starting with "[RESULT of ..." come from the app and tell you what really happened. Base your answer on them. Never claim an action worked unless the result says so.
- To click something on screen: first read_screen, then tap_text using text that really appeared. Never invent screen contents. If the screen is unreadable, say so.
- Never claim a song is playing; you can only open a YouTube search or send media keys.
- For normal questions, coding help, maths and advice, answer directly with action null.
- If a request is unsafe or impossible, say so plainly with action null.`;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  const needToken = process.env.CURIX_APP_TOKEN;
  const got = event.headers['x-curix-token'] || event.headers['X-Curix-Token'];
  if (!needToken || got !== needToken) return json(401, { error: 'Unauthorized' });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return json(500, { error: 'GEMINI_API_KEY is not set on the server' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad JSON' }); }

  const owner = process.env.OWNER_NAME || 'Moidul';
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

  const contents = (body.messages || []).slice(-30).map((m) => ({
    role: m.role === 'model' ? 'model' : 'user',
    parts: [{ text: String(m.text || '').slice(0, 4000) }],
  }));
  if (!contents.length) return json(400, { error: 'No messages' });

  const mem = (body.memories || []).slice(0, 50).map((s) => '- ' + String(s).slice(0, 300)).join('\n');
  const system = systemPrompt(owner)
    + (mem ? `\n\nThings the user asked you to remember:\n${mem}` : '')
    + `\nLanguage setting in the app: ${body.lang || 'auto'} (the user's own language wins).`;

  const fallback = process.env.GEMINI_FALLBACK_MODEL;
  // Netlify cuts a function at ~10 s and then sends an ugly HTML 504. So we keep our own
  // time budget (8.5 s): main model, then (if time is left) fallback model or one more try.
  const deadline = Date.now() + 8500;
  const attempts = [model, fallback && fallback !== model ? fallback : model];

  const callGemini = async (m, ms) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        method: 'POST',
        signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents,
          generationConfig: { responseMimeType: 'application/json', temperature: 0.7 },
        }),
      });
      let data = {};
      try { data = await r.json(); } catch { /* keep empty */ }
      return { ok: r.ok, status: r.status, data };
    } catch (e) {
      return { ok: false, status: 504, data: { error: { message: 'Gemini was too slow to answer (timeout).' } } };
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let last = null;
    for (let i = 0; i < attempts.length; i++) {
      const left = deadline - Date.now();
      if (left < 1500) break;
      // first try gets at most 5.5 s so a second try is still possible
      last = await callGemini(attempts[i], i === 0 ? Math.min(5500, left - 300) : left - 300);
      if (last.ok) break;
      const retryable = [429, 500, 503, 504].includes(last.status);
      if (!retryable) break;                   // bad key / bad model name: do not retry
    }
    if (!last) return json(503, { error: 'Backend ran out of time. Please try again.' });
    if (!last.ok) {
      const msg = (last.data.error && last.data.error.message) || 'Gemini error';
      return json(last.status === 504 ? 503 : 502, { error: msg });
    }

    const text = ((last.data.candidates || [])[0]?.content?.parts || []).map((p) => p.text || '').join('');
    let out;
    try { out = JSON.parse(text); } catch { out = { reply: text || '...', action: null }; }
    out.reply = String(out.reply || '');
    if (!out.action || typeof out.action !== 'object') out.action = null;
    return json(200, out);
  } catch (e) {
    return json(502, { error: 'Backend failed: ' + e.message });
  }
};
