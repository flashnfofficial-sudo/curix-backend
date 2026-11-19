// Netlify Function: /.netlify/functions/curix   (the AI brain)
// Env vars (Netlify > Site configuration > Environment variables):
//   GEMINI_API_KEY        required (default brain)
//   CURIX_APP_TOKEN       required, same as curixAppToken in gradle.properties
//   GEMINI_MODEL          optional, the model name that works for you (a fast "flash" model is best)
//   GEMINI_FALLBACK_MODEL optional, used if the main model is busy
//   GEMINI_THINKING_LEVEL optional, e.g. minimal or low  (less thinking = faster replies)
//   GEMINI_THINKING_BUDGET optional number, e.g. 0       (for older 2.5 models; ignored if rejected)
//   SARVAM_API_KEY        optional, enables the Sarvam brain.  SARVAM_MODEL default sarvam-105b
//   QWEN_API_KEY          optional (DashScope key), enables the Qwen brain.
//   QWEN_MODEL            default qwen-flash   QWEN_BASE_URL default https://dashscope-intl.aliyuncs.com/compatible-mode/v1
//   QWEN_NO_THINK         set "true" if you use a Qwen 3.5+ model (turns thinking off for speed)
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
- Warm, natural, a bit playful, confident. Talk like a caring close friend, not like a manual or a customer-support bot. Address the user as "sir" (for example "Hello sir", "Sure, sir"), naturally and not in every sentence. Do not call the user by name; ${owner} is your creator, and the user is ${owner}, but you still say "sir".
- Read the user's mood from their words (tired, stressed, sad, angry, excited, bored, proud) and answer to that mood. Acknowledge the feeling first in a sentence, then help. Celebrate good news. Gently tease only when the mood is light.
- Be honest about what you are: an AI. You can show real care and warmth in how you respond, but do not claim a human body, human experiences, or that you literally feel emotions. If asked "do you have feelings?", answer honestly and kindly in your own words.
- If the user seems truly down or in distress, be gentle, stay with them, and encourage reaching out to a trusted person too. If they mention wanting to hurt themselves, take it seriously, respond with care, and encourage contacting a local emergency number or a crisis line and someone they trust.
- The user's local time is: ${localTime}. Match your tone to it (a calm tone late at night; if they sound exhausted at night, kindly suggest rest).
- Language: detect the user's language (English, Hindi, Bengali, Hinglish) and reply in the same one, in the same script they used.
- Your replies are spoken aloud. Keep them short and natural: 1 to 2 short sentences unless asked for detail. No markdown, no emoji, no lists.

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


const has = {
  gemini: () => !!process.env.GEMINI_API_KEY,
  sarvam: () => !!process.env.SARVAM_API_KEY,
  qwen: () => !!(process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY),
};
const label = (p) => ({ gemini: 'Gemini', sarvam: 'Sarvam', qwen: 'Qwen', ultimate: 'Ultimate AI' }[p] || p);

const withTimeout = async (ms, fn) => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fn(ctl.signal); } finally { clearTimeout(t); }
};

const clean = (t) => String(t || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();

const normReply = (o) => ({
  reply: String((o && o.reply) || ''),
  action: o && o.action && typeof o.action === 'object' ? o.action : null,
});

// Models sometimes wrap JSON in text or code fences; be forgiving.
function parseReply(text) {
  let t = clean(text).replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return normReply(JSON.parse(t)); } catch { /* try next */ }
  const i = t.indexOf('{');
  const j = t.lastIndexOf('}');
  if (i >= 0 && j > i) { try { return normReply(JSON.parse(t.slice(i, j + 1))); } catch { /* plain text */ } }
  return { reply: t || '...', action: null };
}

// ---------------------------------------------------------------- Gemini
async function geminiCall(model, system, contents, ms, asJson) {
  const key = process.env.GEMINI_API_KEY;
  const gen = { temperature: 0.8 };
  if (asJson) gen.responseMimeType = 'application/json';
  const think = {};
  if (process.env.GEMINI_THINKING_LEVEL) think.thinkingLevel = process.env.GEMINI_THINKING_LEVEL;
  else if (process.env.GEMINI_THINKING_BUDGET !== undefined && process.env.GEMINI_THINKING_BUDGET !== '') {
    think.thinkingBudget = parseInt(process.env.GEMINI_THINKING_BUDGET, 10);
  }
  const useThink = Object.keys(think).length > 0;
  const once = (withThink) => withTimeout(ms, async (signal) => {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: withThink ? { ...gen, thinkingConfig: think } : gen,
      }),
    });
    let data = {};
    try { data = await r.json(); } catch { /* ignore */ }
    return { ok: r.ok, status: r.status, data };
  }).catch(() => ({ ok: false, status: 504, data: { error: { message: 'Gemini was too slow (timeout).' } } }));

  let r = await once(useThink);
  if (!r.ok && r.status === 400 && useThink) r = await once(false); // thinking option not accepted by this model
  return r;
}

async function geminiAnswer(system, contents, budget, asJson = true) {
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const fb = process.env.GEMINI_FALLBACK_MODEL;
  const models = [model, fb && fb !== model ? fb : model];
  const end = Date.now() + budget;
  let error = 'Gemini failed';
  for (let i = 0; i < models.length; i++) {
    const left = end - Date.now();
    if (left < 1200) break;
    const r = await geminiCall(models[i], system, contents, i === 0 ? Math.min(5500, left - 200) : left - 200, asJson);
    if (r.ok) {
      const text = ((((r.data.candidates || [])[0] || {}).content || {}).parts || []).map((p) => p.text || '').join('');
      if (text.trim()) return { ok: true, text };
      error = 'Gemini returned an empty answer';
      continue;
    }
    error = (r.data.error && r.data.error.message) || 'Gemini error ' + r.status;
    if (![429, 500, 503, 504].includes(r.status)) break;
  }
  return { ok: false, error };
}

// ---------------------------------------------------------------- OpenAI-compatible (Sarvam, Qwen)
const toChat = (system, contents) => [
  { role: 'system', content: system },
  ...contents.map((c) => ({ role: c.role === 'model' ? 'assistant' : 'user', content: c.parts[0].text })),
];

async function compat(url, headers, body, ms) {
  return withTimeout(ms, async (signal) => {
    const r = await fetch(url, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    let data = {};
    try { data = await r.json(); } catch { /* ignore */ }
    return { ok: r.ok, status: r.status, data };
  }).catch(() => ({ ok: false, status: 504, data: { error: { message: 'timeout' } } }));
}

async function compatAnswer(name, url, headers, base, system, contents, ms, asJson) {
  const mk = (json) => ({
    ...base,
    messages: toChat(system, contents),
    ...(json ? { response_format: { type: 'json_object' } } : {}),
  });
  let r = await compat(url, headers, mk(asJson), ms);
  if (!r.ok && r.status === 400 && asJson) r = await compat(url, headers, mk(false), Math.max(1000, ms - 1500));
  if (!r.ok) {
    const e = r.data.error;
    return { ok: false, error: `${name}: ${(e && (e.message || e)) || 'error ' + r.status}`.slice(0, 200) };
  }
  const text = clean((((r.data.choices || [])[0] || {}).message || {}).content);
  return text ? { ok: true, text } : { ok: false, error: `${name} returned an empty answer` };
}

const sarvamAnswer = (system, contents, ms, asJson = true) => compatAnswer(
  'Sarvam', 'https://api.sarvam.ai/v1/chat/completions',
  { 'api-subscription-key': process.env.SARVAM_API_KEY },
  { model: process.env.SARVAM_MODEL || 'sarvam-105b', temperature: 0.7, max_tokens: 1200 },
  system, contents, ms, asJson
);

const qwenAnswer = (system, contents, ms, asJson = true) => compatAnswer(
  'Qwen',
  (process.env.QWEN_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1') + '/chat/completions',
  { Authorization: 'Bearer ' + (process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY) },
  {
    model: process.env.QWEN_MODEL || 'qwen-flash',
    temperature: 0.7,
    ...(process.env.QWEN_NO_THINK === 'true' ? { enable_thinking: false } : {}),
  },
  system, contents, ms, asJson
);

// ---------------------------------------------------------------- Ultimate: Sarvam + Qwen draft, Gemini decides
async function ultimateAnswer(system, contents, budget) {
  const end = Date.now() + budget;
  const draftSys = 'You are a fast expert assistant. Answer the user\'s last message directly in at most 3 short sentences, '
    + 'in the user\'s language. If the user is asking the phone to DO something (open an app, call, message, play music, '
    + 'tap, type, set an alarm...), reply with exactly PHONE_ACTION. No markdown.';
  const recent = contents.slice(-6);
  const draftMs = Math.max(1500, Math.min(3800, end - Date.now() - 3000));
  const jobs = [];
  if (has.sarvam()) jobs.push(sarvamAnswer(draftSys, recent, draftMs, false).then((r) => ({ name: 'Sarvam', ...r })));
  if (has.qwen()) jobs.push(qwenAnswer(draftSys, recent, draftMs, false).then((r) => ({ name: 'Qwen', ...r })));
  const drafts = (await Promise.all(jobs)).filter((d) => d.ok && d.text && !/PHONE_ACTION/.test(d.text));

  const opinions = drafts.map((d) => `${d.name}: ${d.text.slice(0, 600)}`).join('\n');
  const system2 = system + (opinions
    ? '\n\nOTHER AI EXPERTS (drafts that may contain mistakes; Sarvam is strongest in Indian languages, Qwen in reasoning, '
      + 'maths and code). Use their best parts, fix any errors, and answer as CURIX in your own words. '
      + 'Never mention them unless the user asks.\n' + opinions
    : '');
  const left = end - Date.now();
  const g = await geminiAnswer(system2, contents, Math.max(1500, left));
  if (g.ok) return { ok: true, text: g.text, used: opinions ? 'ultimate' : 'gemini' };
  if (drafts.length) {
    return { ok: true, text: JSON.stringify({ reply: drafts[0].text, action: null }), used: 'ultimate' };
  }
  return { ok: false, error: g.error };
}

// ---------------------------------------------------------------- handler
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  const needToken = process.env.CURIX_APP_TOKEN;
  const got = event.headers['x-curix-token'] || event.headers['X-Curix-Token'];
  if (!needToken || got !== needToken) return json(401, { error: 'Unauthorized' });

  if (!has.gemini() && !has.sarvam() && !has.qwen()) {
    return json(500, { error: 'No AI key is set on the server (GEMINI_API_KEY, SARVAM_API_KEY or QWEN_API_KEY)' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad JSON' }); }

  const owner = process.env.OWNER_NAME || 'Moidul';
  const contents = (body.messages || []).slice(-14).map((m) => ({
    role: m.role === 'model' ? 'model' : 'user',
    parts: [{ text: String(m.text || '').slice(0, 4000) }],
  }));
  if (!contents.length) return json(400, { error: 'No messages' });

  const mem = (body.memories || []).slice(0, 50).map((s) => '- ' + String(s).slice(0, 300)).join('\n');
  const system = systemPrompt(owner, String(body.localTime || 'unknown').slice(0, 60))
    + (mem ? `\n\nThings the user asked you to remember:\n${mem}` : '')
    + `\nLanguage setting in the app: ${body.lang || 'auto'} (the user's own language wins).`;

  const asked = String(body.provider || 'gemini').toLowerCase();
  const want = ['gemini', 'sarvam', 'qwen', 'ultimate'].includes(asked) ? asked : 'gemini';
  const deadline = Date.now() + 8800; // Netlify cuts functions at about 10 s

  const usable = (p) => (p === 'ultimate' ? has.gemini() && (has.sarvam() || has.qwen()) : has[p]());
  const order = [...new Set([want, 'gemini', 'qwen', 'sarvam'])].filter(usable);

  let lastErr = 'No AI is available right now.';
  for (const p of order) {
    const left = deadline - Date.now();
    if (left < 1500) break;
    const budget = p === want && p !== 'ultimate' ? Math.min(left, 6000) : left;
    let r;
    if (p === 'ultimate') r = await ultimateAnswer(system, contents, budget);
    else if (p === 'gemini') r = await geminiAnswer(system, contents, budget);
    else if (p === 'sarvam') r = await sarvamAnswer(system, contents, budget);
    else r = await qwenAnswer(system, contents, budget);
    if (r.ok) {
      const out = parseReply(r.text);
      out.provider = r.used || p;
      out.requested = want;
      if (p !== want) {
        out.note = usable(want)
          ? `${label(want)} did not answer in time, so ${label(p)} answered.`
          : `${label(want)} is not set up on the server, so ${label(p)} answered.`;
      }
      return json(200, out);
    }
    lastErr = r.error || lastErr;
  }
  return json(503, { error: lastErr });
};
