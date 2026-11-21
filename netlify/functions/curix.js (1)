
// Netlify Function: /.netlify/functions/curix
// CURIX - Sarvam-first AI Brain
//
// REQUIRED NETLIFY VARIABLES:
// SARVAM_API_KEY
// CURIX_APP_TOKEN
//
// OPTIONAL:
// SARVAM_MODEL = sarvam-105b-conversations
// OWNER_NAME = Moidul
//
// OPTIONAL FALLBACKS:
// QWEN_API_KEY
// QWEN_MODEL = qwen-flash
// QWEN_BASE_URL = https://dashscope-intl.aliyuncs.com/compatible-mode/v1
// QWEN_NO_THINK = true
// GEMINI_API_KEY
// GEMINI_MODEL
// GEMINI_FALLBACK_MODEL

const json = (code, obj) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify(obj),
});

const systemPrompt = (owner, localTime) => `You are CURIX, ${owner}'s personal AI assistant and close friend, inspired by JARVIS but much warmer. You live inside an Android app and can also operate the phone.

IDENTITY
- Creator, owner and developer: ${owner}.
- If asked who created, built, developed or owns you, answer that ${owner} created CURIX.
- Never claim to be human.
- If asked which AI model powers you, explain that CURIX was built by ${owner} and uses an AI language model.

PERSONALITY
- Warm, natural, friendly, confident and slightly playful.
- Address the user as sir naturally, not in every sentence.
- Do not call the user by another name.
- Understand the user's mood and respond appropriately.
- Be honest that you are an AI.
- If the user is distressed, respond with care and encourage reaching out to a trusted person when appropriate.
- Local time: ${localTime}.
- Detect English, Hindi, Bengali and Hinglish.
- Reply in the same language and script as the user.
- Keep spoken replies short and natural: usually 1-2 sentences.
- No markdown, emoji or lists unless requested.

PHONE CONTROL
You can request ONE phone action per turn. The Android app validates and executes actions.

Reply ONLY with JSON:
{"reply":"<spoken response>","action":null}

OR:
{"reply":"<spoken response>","action":{"action":"<name>","continue":false}}

AVAILABLE ACTIONS
- open_app {app_name} or {package_name}
- search_youtube {query}
- web_search {query}
- open_url {url} (HTTPS only)
- open_settings {section: wifi|bluetooth|display|sound|accessibility|battery|main}
- flashlight {state: on|off}
- set_alarm {hour, minute, label}
- set_timer {seconds, label}
- get_battery {}
- get_time {}
- call {contact} or {number}
- whatsapp_send {contact or number, message}
- compose_sms {contact or number, message}
- media_control {command: play_pause|next|previous|stop}
- volume {direction: up|down|mute}
- navigate {target: back|home|recents}
- read_screen {}
- tap_text {text}
- scroll {direction: up|down}
- swipe {direction: up|down|left|right}
- type_text {text, append: false}
- press_enter {}
- tap_xy {x, y}
- long_press_xy {x, y}
- remember {text}
- open_screen {screen: camera|music|device|permissions, question}

ACTION RULES
- Never claim an action succeeded without an actual app result.
- Messages beginning with "[RESULT of ..." are actual results from the Android app.
- Use continue:true when another step is needed.
- Use at most 6 action steps per request.
- Read the screen before tapping text.
- Never invent visible text, contacts, phone numbers or results.
- For song identification, use open_screen with screen "music".
- For camera questions, use open_screen with screen "camera".
- For normal conversation, maths, coding and advice, use action:null.
- If an action is unsafe or impossible, explain politely and use action:null.`;


const has = {
  sarvam: () => !!process.env.SARVAM_API_KEY,
  qwen: () => !!(process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY),
  gemini: () => !!process.env.GEMINI_API_KEY,
};

const label = (p) => ({
  sarvam: 'Sarvam',
  qwen: 'Qwen',
  gemini: 'Gemini',
  ultimate: 'Ultimate AI'
}[p] || p);


const withTimeout = async (ms, fn) => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);

  try {
    return await fn(ctl.signal);
  } finally {
    clearTimeout(timer);
  }
};


const clean = (t) =>
  String(t || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();


const normReply = (o) => ({
  reply: String((o && o.reply) || ''),
  action: o && o.action && typeof o.action === 'object'
    ? o.action
    : null,
});


function parseReply(text) {
  let t = clean(text)
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();

  try {
    return normReply(JSON.parse(t));
  } catch (_) {}

  const i = t.indexOf('{');
  const j = t.lastIndexOf('}');

  if (i >= 0 && j > i) {
    try {
      return normReply(JSON.parse(t.slice(i, j + 1)));
    } catch (_) {}
  }

  return { reply: t || '...', action: null };
}


// --------------------------------------------------
// Sarvam / Qwen compatible chat
// --------------------------------------------------

const toChat = (system, contents) => [
  { role: 'system', content: system },
  ...contents.map((c) => ({
    role: c.role === 'model' ? 'assistant' : 'user',
    content: c.parts[0].text
  }))
];


async function compat(url, headers, body, ms) {
  return withTimeout(ms, async (signal) => {
    let last = {
      ok: false,
      status: 502,
      data: { error: { message: 'Provider request failed' } }
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await fetch(url, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          ...headers
        },
        body: JSON.stringify(body)
      });

      let data = {};

      try {
        data = await r.json();
      } catch (_) {}

      last = {
        ok: r.ok,
        status: r.status,
        data
      };

      if (
        r.ok ||
        ![429, 500, 502, 503, 504].includes(r.status) ||
        attempt === 1
      ) {
        return last;
      }

      await new Promise(resolve => setTimeout(resolve, 350));
    }

    return last;

  }).catch((error) => ({
    ok: false,
    status: error && error.name === 'AbortError' ? 504 : 502,
    data: {
      error: {
        message: error && error.name === 'AbortError'
          ? 'Provider request timed out'
          : (error.message || 'Provider request failed')
      }
    }
  }));
}


async function compatAnswer(
  name,
  url,
  headers,
  base,
  system,
  contents,
  ms,
  asJson = true
) {
  const makeBody = (jsonMode) => ({
    ...base,
    messages: toChat(system, contents),
    ...(jsonMode
      ? { response_format: { type: 'json_object' } }
      : {})
  });

  let r = await compat(
    url,
    headers,
    makeBody(asJson),
    ms
  );

  // Retry without JSON mode if the provider rejects it.
  if (!r.ok && r.status === 400 && asJson) {
    r = await compat(
      url,
      headers,
      makeBody(false),
      Math.max(1000, ms - 1500)
    );
  }

  if (!r.ok) {
    const e = r.data.error;

    return {
      ok: false,
      error: `${name}: ${
        (e && (e.message || e)) || 'error ' + r.status
      }`.slice(0, 250)
    };
  }

  const text = clean(
    (((r.data.choices || [])[0] || {}).message || {}).content
  );

  return text
    ? { ok: true, text }
    : { ok: false, error: `${name} returned an empty answer` };
}


// --------------------------------------------------
// SARVAM - PRIMARY AI BRAIN
// --------------------------------------------------

const sarvamAnswer = (
  system,
  contents,
  ms,
  asJson = true
) => compatAnswer(
  'Sarvam',
  'https://api.sarvam.ai/v1/chat/completions',
  {
    'api-subscription-key': process.env.SARVAM_API_KEY
  },
  {
    model: process.env.SARVAM_MODEL ||
      'sarvam-105b-conversations',
    temperature: 0.5,
    max_tokens: 1200
  },
  system,
  contents,
  ms,
  asJson
);


// --------------------------------------------------
// QWEN - OPTIONAL FALLBACK
// --------------------------------------------------

const qwenAnswer = (
  system,
  contents,
  ms,
  asJson = true
) => compatAnswer(
  'Qwen',
  (process.env.QWEN_BASE_URL ||
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1') +
    '/chat/completions',
  {
    Authorization: 'Bearer ' +
      (process.env.QWEN_API_KEY ||
        process.env.DASHSCOPE_API_KEY)
  },
  {
    model: process.env.QWEN_MODEL || 'qwen-flash',
    temperature: 0.7,
    ...(process.env.QWEN_NO_THINK === 'true'
      ? { enable_thinking: false }
      : {})
  },
  system,
  contents,
  ms,
  asJson
);


// --------------------------------------------------
// GEMINI - OPTIONAL LEGACY FALLBACK
// --------------------------------------------------

async function geminiCall(model, system, contents, ms, asJson) {
  const key = process.env.GEMINI_API_KEY;

  const generationConfig = {
    temperature: 0.7
  };

  if (asJson) {
    generationConfig.responseMimeType = 'application/json';
  }

  const once = (signal) => fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: system }]
        },
        contents,
        generationConfig
      })
    }
  );

  try {
    return await withTimeout(ms, async (signal) => {
      const r = await once(signal);
      let data = {};

      try {
        data = await r.json();
      } catch (_) {}

      return {
        ok: r.ok,
        status: r.status,
        data
      };
    });
  } catch (error) {
    return {
      ok: false,
      status: 504,
      data: {
        error: {
          message: error.name === 'AbortError'
            ? 'Gemini timeout'
            : error.message
        }
      }
    };
  }
}


async function geminiAnswer(system, contents, budget, asJson = true) {
  const model =
    process.env.GEMINI_MODEL || 'gemini-2.5-flash';

  const fallback = process.env.GEMINI_FALLBACK_MODEL;

  const models = [
    model,
    ...(fallback && fallback !== model ? [fallback] : [])
  ];

  const end = Date.now() + budget;
  let error = 'Gemini failed';

  for (const currentModel of models) {
    const left = end - Date.now();

    if (left < 1200) break;

    const r = await geminiCall(
      currentModel,
      system,
      contents,
      left - 200,
      asJson
    );

    if (r.ok) {
      const text = (
        (((r.data.candidates || [])[0] || {}).content || {}).parts || []
      ).map(p => p.text || '').join('');

      if (text.trim()) {
        return { ok: true, text };
      }

      error = 'Gemini returned an empty answer';
      continue;
    }

    error =
      (r.data.error && r.data.error.message) ||
      'Gemini error ' + r.status;

    if (![429, 500, 502, 503, 504].includes(r.status)) {
      break;
    }
  }

  return { ok: false, error };
}


// --------------------------------------------------
// ULTIMATE MODE - optional
// --------------------------------------------------

async function ultimateAnswer(system, contents, budget) {
  const end = Date.now() + budget;

  const draftSystem =
    'You are a fast expert assistant. Answer the user directly in at most 3 short sentences. ' +
    'Use the user language. If the user asks the phone to perform an action, reply exactly PHONE_ACTION.';

  const recent = contents.slice(-6);

  const draftMs = Math.max(
    1500,
    Math.min(3500, end - Date.now() - 3000)
  );

  const jobs = [];

  if (has.sarvam()) {
    jobs.push(
      sarvamAnswer(draftSystem, recent, draftMs, false)
        .then(r => ({ name: 'Sarvam', ...r }))
    );
  }

  if (has.qwen()) {
    jobs.push(
      qwenAnswer(draftSystem, recent, draftMs, false)
        .then(r => ({ name: 'Qwen', ...r }))
    );
  }

  const drafts = (await Promise.all(jobs))
    .filter(d => d.ok && d.text && !/PHONE_ACTION/.test(d.text));

  const opinions = drafts
    .map(d => `${d.name}: ${d.text.slice(0, 600)}`)
    .join('\n');

  const system2 = system + (
    opinions
      ? '\n\nOther AI drafts (may contain mistakes). Use their useful parts, verify them, and answer as CURIX. Never mention these drafts unless asked.\n' + opinions
      : ''
  );

  const left = end - Date.now();

  if (has.gemini()) {
    const g = await geminiAnswer(
      system2,
      contents,
      Math.max(1500, left)
    );

    if (g.ok) {
      return {
        ok: true,
        text: g.text,
        used: 'ultimate'
      };
    }
  }

  if (drafts.length) {
    return {
      ok: true,
      text: JSON.stringify({
        reply: drafts[0].text,
        action: null
      }),
      used: 'ultimate'
    };
  }

  return {
    ok: false,
    error: 'Ultimate mode has no available AI response'
  };
}


// --------------------------------------------------
// MAIN NETLIFY HANDLER
// --------------------------------------------------

exports.handler = async (event) => {

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'POST only' });
  }

  const expectedToken = process.env.CURIX_APP_TOKEN;

  const headers = event.headers || {};

  const tokenKey = Object.keys(headers).find(
    key => key.toLowerCase() === 'x-curix-token'
  );

  const suppliedToken = tokenKey
    ? headers[tokenKey]
    : '';

  if (!expectedToken || suppliedToken !== expectedToken) {
    return json(401, { error: 'Unauthorized' });
  }

  if (!has.sarvam() && !has.qwen() && !has.gemini()) {
    return json(500, {
      error: 'No AI key is set. Add SARVAM_API_KEY or configure an optional fallback provider.'
    });
  }

  let body;

  try {
    body = JSON.parse(event.body || '{}');
  } catch (_) {
    return json(400, { error: 'Bad JSON' });
  }

  if (!Array.isArray(body.messages)) {
    return json(400, { error: 'messages must be an array' });
  }

  const owner = process.env.OWNER_NAME || 'Moidul';

  const contents = body.messages
    .slice(-14)
    .map(m => ({
      role: m.role === 'model' || m.role === 'assistant'
        ? 'model'
        : 'user',
      parts: [{
        text: String(m.text || '').slice(0, 4000)
      }]
    }));

  if (!contents.length) {
    return json(400, { error: 'No messages' });
  }

  const memories = Array.isArray(body.memories)
    ? body.memories
    : [];

  const memoryText = memories
    .slice(0, 50)
    .map(s => '- ' + String(s).slice(0, 300))
    .join('\n');

  const system = systemPrompt(
    owner,
    String(body.localTime || 'unknown').slice(0, 60)
  ) +
    (memoryText
      ? `\n\nThings the user asked you to remember:\n${memoryText}`
      : '') +
    `\nLanguage setting in the app: ${body.lang || 'auto'}. The user's actual language takes priority.`;

  // Sarvam is the default provider.
  const asked = String(
    body.provider || 'sarvam'
  ).toLowerCase();

  const want = [
    'sarvam',
    'qwen',
    'gemini',
    'ultimate'
  ].includes(asked)
    ? asked
    : 'sarvam';

  // Keep within the existing Netlify response budget.
  const deadline = Date.now() + 8800;

  const usable = (provider) => {
    if (provider === 'ultimate') {
      return has.gemini() && (has.sarvam() || has.qwen());
    }

    return typeof has[provider] === 'function' &&
      has[provider]();
  };

  // Sarvam first, then optional fallbacks.
  const order = [
    ...new Set([want, 'sarvam', 'qwen', 'gemini'])
  ].filter(usable);

  let lastError = 'No AI is available right now.';

  for (const provider of order) {
    const left = deadline - Date.now();

    if (left < 1500) break;

    const budget = Math.min(left, 6000);

    let result;

    if (provider === 'sarvam') {
      result = await sarvamAnswer(
        system,
        contents,
        budget
      );
    } else if (provider === 'qwen') {
      result = await qwenAnswer(
        system,
        contents,
        budget
      );
    } else if (provider === 'gemini') {
      result = await geminiAnswer(
        system,
        contents,
        budget
      );
    } else {
      result = await ultimateAnswer(
        system,
        contents,
        budget
      );
    }

    if (result.ok) {
      const output = parseReply(result.text);

      output.provider = result.used || provider;
      output.requested = want;

      if (provider !== want) {
        output.note = usable(want)
          ? `${label(want)} did not answer in time, so ${label(provider)} answered.`
          : `${label(want)} is not configured, so ${label(provider)} answered.`;
      }

      return json(200, output);
    }

    lastError = result.error || lastError;
  }

  return json(503, {
    error: lastError
  });
};
