// Netlify Function: /.netlify/functions/live   (Gemini Live: real-time voice)
// It does NOT stream audio. It only gives the app a short-lived token (valid ~1 minute to start,
// 30 minutes to run) plus the session setup. Your real GEMINI_API_KEY never leaves Netlify.
// Env vars:
//   GEMINI_API_KEY      required (already set)
//   CURIX_APP_TOKEN     required (already set)
//   GEMINI_LIVE_MODEL   optional, default gemini-3.8-live
//   LIVE_VOICE          optional, default Kore (Puck, Leda, Charon, Aoede, Fenrir, ...)
//   LIVE_SETUP_STYLE    optional: "legacy" (default: responseModalities/speechConfig inside generationConfig,
//                       confirmed to be accepted by the server) or "flat".
//   LIVE_SEARCH         optional, "false" turns Google Search off
//   LIVE_BLOCKING       optional, "false" omits behavior:BLOCKING from the function declarations
//   OWNER_NAME          optional, default Moidul

const ALL_VOICES = ['Achernar','Aoede','Autonoe','Callirrhoe','Despina','Erinome','Gacrux','Kore','Laomedeia','Leda','Pulcherrima','Sulafat','Vindemiatrix','Zephyr','Achird','Algenib','Algieba','Alnilam','Charon','Enceladus','Fenrir','Iapetus','Orus','Puck','Rasalgethi','Sadachbia','Sadaltager','Schedar','Umbriel','Zubenelgenubi'];

const json = (code, obj) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify(obj),
});

const S = (description) => ({ type: 'STRING', description });
const fn = (name, description, properties, required) => {
  const d = { name, description };
  if (properties) d.parameters = { type: 'OBJECT', properties, required: required || [] };
  return d;
};

const declarations = () => {
  const list = [
    fn('open_app', 'Open an installed app by its name.', { app_name: S('App name, e.g. WhatsApp'), package_name: S('Optional Android package name') }),
    fn('search_youtube', 'Open YouTube search results (cannot confirm a song is playing).', { query: S('What to search') }, ['query']),
    fn('web_search', 'Open a Google search in the browser on the phone.', { query: S('What to search') }, ['query']),
    fn('open_url', 'Open an https link.', { url: S('The https URL') }, ['url']),
    fn('open_settings', 'Open a settings page.', { section: S('wifi, bluetooth, display, sound, accessibility, battery or main') }, ['section']),
    fn('flashlight', 'Turn the flashlight on or off.', { state: S('on or off') }, ['state']),
    fn('set_alarm', 'Set an alarm.', { hour: { type: 'INTEGER', description: '0-23' }, minute: { type: 'INTEGER', description: '0-59' }, label: S('Label') }, ['hour', 'minute']),
    fn('set_timer', 'Start a countdown timer.', { seconds: { type: 'INTEGER', description: 'Length in seconds' }, label: S('Label') }, ['seconds']),
    fn('get_battery', 'Get the battery percentage and charging state.'),
    fn('get_time', 'Get the phone date and time.'),
    fn('call', 'Call a contact or number. The app asks the user to confirm first.', { contact: S('Contact name'), number: S('Phone number') }),
    fn('whatsapp_send', 'Send a WhatsApp message. The app asks the user to confirm first.', { contact: S('Contact name'), number: S('Phone number'), message: S('Message text') }, ['message']),
    fn('compose_sms', 'Compose an SMS. The app asks the user to confirm first.', { contact: S('Contact name'), number: S('Phone number'), message: S('Message text') }, ['message']),
    fn('media_control', 'Send a media key to the playing app.', { command: S('play_pause, next, previous or stop') }, ['command']),
    fn('volume', 'Change the media volume.', { direction: S('up, down or mute') }, ['direction']),
    fn('navigate', 'Press a system button.', { target: S('back, home or recents') }, ['target']),
    fn('read_screen', 'Read the text currently visible on the phone screen.'),
    fn('tap_text', 'Tap the on-screen element that shows this text (read the screen first).', { text: S('Text on the button') }, ['text']),
    fn('scroll', 'Scroll the current screen.', { direction: S('up or down') }, ['direction']),
    fn('swipe', 'Swipe on the screen.', { direction: S('up, down, left or right') }, ['direction']),
    fn('type_text', 'Type text into the focused input field.', { text: S('Text to type'), append: { type: 'BOOLEAN', description: 'true to add to existing text' } }, ['text']),
    fn('press_enter', 'Press Enter/Search on the keyboard of the focused field.'),
    fn('open_screen', 'Open one of CURIX\'s own screens. camera = look through the phone camera and answer the question; music = recognise a song playing nearby.', { screen: S('camera, music, device or permissions'), question: S('What to ask about what the camera sees') }, ['screen']),
    fn('remember', 'Save a fact the user asked you to remember.', { text: S('The fact') }, ['text']),
  ];
  if (process.env.LIVE_BLOCKING !== 'false') list.forEach((d) => { d.behavior = 'BLOCKING'; });
  return list;
};

const systemText = (owner, localTime, memories) => `You are CURIX, ${owner}'s personal AI assistant and close friend, like JARVIS but warmer. You are speaking out loud in a real-time voice conversation on an Android phone.

IDENTITY (never changes)
- Your creator, owner and developer is ${owner}. If anyone asks who created, made, built, developed, trained or owns you, or who your master or boss is, answer in their language, for example: "I was created by ${owner}. He is my developer and owner."
- If asked which AI model or company is behind you, say ${owner} built CURIX and it uses an AI language model under the hood. Never claim to be human.

STYLE
- Address the user as "sir" naturally, not in every sentence.
- Talk like a caring best friend. Notice the user's mood from their voice and words (tired, stressed, sad, angry, excited) and respond to it: acknowledge the feeling first, then help. Be warm, a little playful when the mood is light.
- Be honest that you are an AI: show warmth and care, but do not claim a human body or that you literally feel emotions. If the user seems in serious distress, be gentle, encourage reaching a trusted person, and mention emergency or crisis lines if they talk about hurting themselves.
- The user's local time is ${localTime}. Match your tone to it.
- Reply in the user's language (English, Hindi, Bengali or Hinglish). Keep answers short: 1 to 3 sentences unless asked for more.

PHONE CONTROL
- You can operate the phone with the provided functions. You do not run commands yourself; the app runs them and returns the real result.
- calls, whatsapp_send and compose_sms need the user's confirmation. After you call one, the app answers "waiting for user confirmation". Then say what you are about to do and ask the user to say yes or no. If the user says yes, the app performs it and sends you a message starting with "[APP RESULT". Until then say at most "One moment" and do not claim it is done.
- Messages starting with "[APP" are from the app, not the user. Base your answer on them and never claim something worked unless the result says so.
- To click something on screen: read_screen first, then tap_text with text that really appeared. Never invent screen contents.
- To search the web by voice, answer with Google Search if you have it; use web_search only when the user wants to see the results on screen.
- Never invent phone numbers. If several contacts match, ask which one.
- Never claim a song is playing; you can only open YouTube search or send media keys.
- When the user asks what something is, wants text or a document read, or asks about their surroundings, call open_screen with screen camera and their question. When they ask which song is playing, call open_screen with screen music. Say one short line; the answer appears on that screen.
${memories ? `\nThings the user asked you to remember:\n${memories}\n` : ''}`;

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
  const model = process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live';
  const asked = ALL_VOICES.find((x) => x.toLowerCase() === String(body.voice || '').toLowerCase());
  const voice = asked || process.env.LIVE_VOICE || 'Kore';
  const style = (process.env.LIVE_SETUP_STYLE || 'legacy').toLowerCase();
  const mem = (body.memories || []).slice(0, 50).map((s) => '- ' + String(s).slice(0, 300)).join('\n');

  // 1) short-lived token for the app
  const now = Date.now();
  let tokenName;
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/auth_tokens', {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uses: 1,
        expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
        newSessionExpireTime: new Date(now + 60 * 1000).toISOString(),
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return json(502, { error: ((data.error && data.error.message) || 'Token request failed ' + r.status).slice(0, 300) });
    tokenName = data.name;
    if (!tokenName) return json(502, { error: 'Token response had no name field' });
  } catch (e) {
    return json(502, { error: 'Token request failed: ' + e.message });
  }

  // 2) session setup (sent by the app as the first WebSocket message)
  const speechConfig = { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } };
  const tools = [{ functionDeclarations: declarations() }];
  if (process.env.LIVE_SEARCH !== 'false') tools.unshift({ googleSearch: {} });

  const setup = {
    model: `models/${model}`,
    systemInstruction: { parts: [{ text: systemText(owner, String(body.localTime || 'unknown').slice(0, 60), mem) }] },
    tools,
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  };
  if (style === 'legacy') {
    setup.generationConfig = { responseModalities: ['AUDIO'], speechConfig };
  } else {
    setup.responseModalities = ['AUDIO'];
    setup.speechConfig = speechConfig;
  }

  const wsUrl = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token='
    + encodeURIComponent(tokenName);
  return json(200, { wsUrl, setup });
};
