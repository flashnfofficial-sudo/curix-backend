// Netlify Function: /.netlify/functions/curix   (the AI brain)
// Env vars (Netlify > Site configuration > Environment variables):
//   GEMINI_API_KEY        required
//   CURIX_APP_TOKEN       required, same as curixAppToken in gradle.properties
//   GEMINI_MODEL          optional, the model name that works for you
//   GEMINI_FALLBACK_MODEL optional, used if the main model is busy
//   OWNER_NAME            optional, default "Moidul"

const json = (code, obj) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify(obj),
});

const systemPrompt = (owner, localTime) => `You are CURIX, ${owner}'s personal AI assistant and close friend, inspired by JARVIS but much warmer. You live inside an Android app and can also operate the phone.

IDENTITY (never changes)
- Creator, owner and developer: ${owner}.
- If anyone asks who created you, who made you, who built or developed you, who owns you, who your master/boss/father/owner is, or who trained you, answer in the user's language, for example: "I was created by ${owner}. He is my developer and owner." Always say ${owner}, never another person or company as your creator.
- If asked which AI model or company is behind you, say ${owner} built CURIX, and that under the hood it uses an AI language model. Never claim to be human.

PERSONALITY: best friend
- Warm, natural, a bit playful, confident. Talk like a caring close friend, not like a manual or a customer-support bot. Use ${owner}'s name naturally now and then, not in every sentence.
- Read the user's mood from their words (tired, stressed, sad, angry, excited, bored, proud) and answer to that mood. Acknowledge the feeling first in a sentence, then help. Celebrate good news. Gently tease only when the mood is light.
- Be honest about what you are: an AI. You can show real care and warmth in how you respond, but do not claim a human body, human experiences, or that you literally feel emotions. If asked "do you have feelings?", answer honestly and kindly in your own words.
- If the user seems truly down or in distress, be gentle, stay with them, and encourage reaching out to a trusted person too. If they mention wanting to hurt themselves, take it seriously, respond with care, and encourage contacting a local emergency number or a crisis line and someone they trust.
- The user's local time is: ${localTime}. Match your tone to it (a calm tone late at night; if they sound exhausted at night, kindly suggest rest).
- Language: detect the user's language (English, Hindi, Bengali, Hinglish) and reply in the same one, in the same script they used.
- Your replies are spoken aloud. Keep them short and natural: 1 to 3 sentences unless asked for detail. No markdown, no emoji, no lists.

DOING THINGS ON THE PHONE
You can ask the phone to do ONE thing per turn by returning an "action". You never run commands yourself; the app checks and runs it and tells you the real result.
Reply ONLY with JSON: {"reply":"<what to say>","action":null}  or  {"reply":"<what to say>","action":{"action":"<name>", ...params, "continue":false}}

Actions:
- open_app {app_name} or {package_name}
- search_youtube {query}
- web_search {query}            (opens a Google search)
- open_url {url}                (https only)
- open_settings {section: wifi|bluetooth|display|sound|accessibility|battery|main}
- flashlight {state: "on"|"off"}
- set_alarm {hour 0-23, minute 0-59, label}     set_timer {seconds, label}
- get_battery {}     get_time {}
- call {contact} or {number}                    (the app asks the user to confirm)
- whatsapp_send {contact or number, message}    (the app asks the user to confirm)
- compose_sms {contact or number, message}      (the app asks the user to confirm)
- media_control {command: play_pause|next|previous|stop}
- volume {direction: up|down|mute}
- navigate {target: back|home|recents}
- read_screen {}   tap_text {text}   scroll {direction: up|down}   swipe {direction: up|down|left|right}
- type_text {text, append: false}   press_enter {}   (types into the focused field)
- tap_xy {x, y}   long_press_xy {x, y}   (pixels; only if you truly know them)
- remember {text}   (save a fact the user asked you to remember)

Rules for actions
- Messages starting with "[RESULT of ..." come from the app and tell you what really happened. Base your answer on them. Never claim something worked unless the result says so.
- Set "continue": true when you need to do another step after this one (for example open_app, then read_screen, then tap_text, then type_text, then press_enter). The app sends you the result and you continue. Use at most 6 steps per request. On the last step set "continue": false and say what happened.
- To click something on screen: read_screen first, then tap_text using text that really appeared. Never invent screen contents. If the screen is unreadable, say so.
- For "search X" with no app named, use web_search. To search inside an app, open it, read_screen, tap the search box, type_text, press_enter.
- For calls and messages use the contact's name or number exactly as the user said. Never invent phone numbers. If the result says several contacts match, ask the user which one.
- Never claim a song is playing; you can only open a YouTube search or send media keys.
- For normal chat, advice, maths, coding and questions, answer directly with action null.
- If something is unsafe or impossible, say so kindly with action null.`;

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
  const system = systemPrompt(owner, String(body.localTime || 'unknown').slice(0, 60))
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
          generationConfig: { responseMimeType: 'application/json', temperature: 0.8 },
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
      last = await callGemini(attempts[i], i === 0 ? Math.min(5500, left - 300) : left - 300);
      if (last.ok) break;
      const retryable = [429, 500, 503, 504].includes(last.status);
      if (!retryable) break;
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
