
/**
 * CURIX - Sarvam AI Text-to-Speech
 * Netlify Function: /.netlify/functions/tts
 *
 * Required environment variables:
 * SARVAM_API_KEY
 * CURIX_APP_TOKEN
 *
 * Optional:
 * SARVAM_TTS_MODEL
 * SARVAM_TTS_SPEAKER
 * SARVAM_TTS_PACE
 * SARVAM_TTS_TIMEOUT_MS
 */

const SARVAM_URL = "https://api.sarvam.ai/text-to-speech";

const jsonError = (statusCode, message) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  },
  body: JSON.stringify({ error: message })
});

const audioResponse = (buffer) => ({
  statusCode: 200,
  headers: {
    "Content-Type": "audio/wav",
    "Cache-Control": "no-store"
  },
  body: buffer.toString("base64"),
  isBase64Encoded: true
});

// Detect language automatically
function detectLanguage(text, supplied) {
  const supported = [
    "en-IN", "hi-IN", "bn-IN", "ta-IN",
    "te-IN", "kn-IN", "ml-IN", "mr-IN",
    "gu-IN", "pa-IN", "od-IN"
  ];

  if (supported.includes(supplied)) {
    return supplied;
  }

  if (/[\u0980-\u09FF]/.test(text)) {
    return "bn-IN";
  }

  if (/[\u0900-\u097F]/.test(text)) {
    return "hi-IN";
  }

  return "en-IN";
}

// Model-compatible default female voices
function getDefaultVoice(language, model, text) {
  if (model === "bulbul:v3") {
    if (language === "bn-IN") return "roopa";
    if (language === "hi-IN") return "priya";
    return "simran";
  }

  if (language === "hi-IN") {
    // Natural Hinglish voice
    if (/[a-zA-Z]/.test(text)) {
      return "simran_enhi_customer";
    }

    return "aparna_hi_customer";
  }

  if (language === "en-IN") {
    return "simran_en_customer";
  }

  return null;
}

const V3_VOICES = new Set([
  "aditya", "ritu", "ashutosh", "priya",
  "neha", "rahul", "pooja", "rohan",
  "simran", "kavya", "amit", "dev",
  "ishita", "shreya", "ratan", "varun",
  "manan", "sumit", "roopa", "kabir",
  "aayan", "shubh", "advait", "anand",
  "tanya", "tarun", "sunny", "mani",
  "gokul", "vijay", "shruti", "suhani",
  "mohit", "kavitha", "rehan", "soham",
  "rupali"
]);

function validPace() {
  const pace = Number(process.env.SARVAM_TTS_PACE || 1);

  if (!Number.isFinite(pace)) return 1;

  return Math.min(2, Math.max(0.5, pace));
}

async function generateSpeech({
  text,
  language,
  speaker,
  model,
  signal
}) {
  const apiKey = process.env.SARVAM_API_KEY;

  if (!apiKey) {
    return jsonError(
      500,
      "SARVAM_API_KEY is missing in Netlify environment variables"
    );
  }

  const payload = {
    text,
    language_code: language,
    model,
    speaker,
    output_audio_codec: "wav",
    speech_sample_rate: 24000,
    pace: validPace()
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await fetch(SARVAM_URL, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        "api-subscription-key": apiKey,
        "Accept": "application/json"
      },
      body: JSON.stringify(payload)
    });

    let data = {};

    try {
      data = await response.json();
    } catch (_) {
      // Handle invalid API responses below
    }

    if (response.ok) {
      const encoded = Array.isArray(data.audios)
        ? data.audios.filter(Boolean).join("")
        : "";

      if (!encoded) {
        return jsonError(
          502,
          "Sarvam returned empty audio"
        );
      }

      const wav = Buffer.from(encoded, "base64");

      if (
        wav.length < 44 ||
        wav.toString("ascii", 0, 4) !== "RIFF"
      ) {
        return jsonError(
          502,
          "Sarvam returned invalid WAV audio"
        );
      }

      return audioResponse(wav);
    }

    const message =
      data.error?.message ||
      data.message ||
      data.detail ||
      `HTTP ${response.status}`;

    // Retry temporary server errors and rate limits
    if (
      [429, 500, 502, 503, 504].includes(response.status) &&
      attempt < 2
    ) {
      await new Promise(resolve =>
        setTimeout(resolve, 400)
      );

      continue;
    }

    return jsonError(
      response.status === 429 ? 429 : 502,
      `Sarvam TTS error: ${String(message).slice(0, 250)}`
    );
  }

  return jsonError(502, "Sarvam TTS failed");
}

// Netlify handler
exports.handler = async (event) => {

  if (event.httpMethod !== "POST") {
    return jsonError(405, "POST method required");
  }

  // Secure CURIX authentication
  const headers = event.headers || {};

  const tokenHeader = Object.keys(headers).find(
    key => key.toLowerCase() === "x-curix-token"
  );

  const suppliedToken = tokenHeader
    ? headers[tokenHeader]
    : "";

  const expectedToken = process.env.CURIX_APP_TOKEN;

  if (!expectedToken || suppliedToken !== expectedToken) {
    return jsonError(401, "Unauthorized");
  }

  // Parse request
  let body;

  try {
    body = JSON.parse(event.body || "{}");
  } catch (_) {
    return jsonError(400, "Invalid JSON");
  }

  const text = String(body.text || "")
    .replace(/[*_`#]/g, "")
    .trim()
    .slice(0, 2500);

  if (!text) {
    return jsonError(400, "No text provided");
  }

  if (!process.env.SARVAM_API_KEY) {
    return jsonError(500, "SARVAM_API_KEY is missing");
  }

  // Language detection
  const language = detectLanguage(
    text,
    body.language_code || body.languageCode
  );

  // Bengali uses v3 by default because its
  // classic Bengali voice ID is supported there.
  const configuredModel = process.env.SARVAM_TTS_MODEL;

  const model = configuredModel
    ? configuredModel
    : language === "bn-IN"
      ? "bulbul:v3"
      : "bulbul:v4-flash";

  if (!["bulbul:v3", "bulbul:v4-flash"].includes(model)) {
    return jsonError(400, "Unsupported Sarvam TTS model");
  }

  const requestedVoice = String(body.voice || "")
    .trim()
    .toLowerCase();

  const envVoice = String(
    process.env.SARVAM_TTS_SPEAKER || ""
  ).trim().toLowerCase();

  // Ignore old Gemini voices such as Kore, Leda and Aoede.
  let speaker = null;

  if (model === "bulbul:v3") {
    if (V3_VOICES.has(requestedVoice)) {
      speaker = requestedVoice;
    }

    if (!speaker && V3_VOICES.has(envVoice)) {
      speaker = envVoice;
    }
  } else {
    const isV4Speaker = voice =>
      /^[a-z0-9]+_(en|hi|bn|gu|kn|mr|pa|ta|te|enhi)_[a-z0-9_]+$/.test(voice);

    if (isV4Speaker(requestedVoice)) {
      speaker = requestedVoice;
    }

    if (!speaker && isV4Speaker(envVoice)) {
      speaker = envVoice;
    }
  }

  if (!speaker) {
    speaker = getDefaultVoice(language, model, text);
  }

  // A Bengali v4 voice must be explicitly configured
  // because the classic v3 voice IDs cannot be used on v4.
  if (!speaker) {
    return jsonError(
      400,
      "Set SARVAM_TTS_SPEAKER to a valid speaker for this language and model"
    );
  }

  // Request timeout
  const timeout = Math.min(
    9500,
    Math.max(
      3000,
      Number(process.env.SARVAM_TTS_TIMEOUT_MS || 9000)
    )
  );

  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    timeout
  );

  try {
    return await generateSpeech({
      text,
      language,
      speaker,
      model,
      signal: controller.signal
    });

  } catch (error) {

    if (error.name === "AbortError") {
      return jsonError(504, "Sarvam TTS request timed out");
    }

    return jsonError(
      502,
      `TTS failed: ${String(error.message || error).slice(0, 250)}`
    );

  } finally {
    clearTimeout(timer);
  }
};
