
/**
 * CURIX - Sarvam AI Speech-to-Text
 * Netlify Function: /.netlify/functions/stt
 *
 * Input: base64 audio from Android (16 kHz, 16-bit PCM)
 *
 * Required:
 * SARVAM_API_KEY
 * CURIX_APP_TOKEN
 *
 * Optional:
 * SARVAM_STT_MODEL=saaras:v4
 * SARVAM_STT_MODE=transcribe
 * SARVAM_STT_TIMEOUT_MS=15000
 */

const API_URL = "https://api.sarvam.ai/speech-to-text";

const MAX_AUDIO_BYTES = 960000 + 44;

const json = (statusCode, data) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  },
  body: JSON.stringify(data)
});

const KEYTERMS = [
  "CURIX",
  "Hey CURIX",
  "Moidul",
  "WhatsApp",
  "YouTube",
  "Arijit Singh",
  "flashlight",
  "Bluetooth"
];

const LANGUAGES = new Set([
  "unknown",
  "en-IN", "hi-IN", "bn-IN", "as-IN", "gu-IN",
  "kn-IN", "ml-IN", "mr-IN", "od-IN", "pa-IN",
  "ta-IN", "te-IN", "ur-IN", "ne-IN", "kok-IN",
  "ks-IN", "sd-IN", "sa-IN", "sat-IN", "mni-IN",
  "brx-IN", "mai-IN", "doi-IN"
]);

const MODES = new Set([
  "transcribe",
  "translate",
  "verbatim",
  "translit",
  "codemix"
]);

// Convert raw PCM into a valid WAV file.
function pcmToWav(pcm) {
  const rate = 16000;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

function getHeader(headers, name) {
  const key = Object.keys(headers || {}).find(
    k => k.toLowerCase() === name.toLowerCase()
  );

  return key ? headers[key] : "";
}

// Decode Android audio.
function decodeAudio(value) {
  let encoded = String(value || "").trim();

  if (encoded.startsWith("data:")) {
    const comma = encoded.indexOf(",");
    if (comma < 0) throw new Error("Invalid audio data URL");
    encoded = encoded.slice(comma + 1);
  }

  encoded = encoded.replace(/\s/g, "");

  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error("Invalid base64 audio");
  }

  const audio = Buffer.from(encoded, "base64");

  if (!audio.length) {
    throw new Error("Audio is empty");
  }

  if (audio.length > MAX_AUDIO_BYTES) {
    throw new Error("Audio exceeds the approximately 30-second REST limit");
  }

  // Already WAV?
  const isWav =
    audio.length >= 44 &&
    audio.toString("ascii", 0, 4) === "RIFF" &&
    audio.toString("ascii", 8, 12) === "WAVE";

  if (isWav) return audio;

  // Original CURIX recording format: 16-bit PCM.
  if (audio.length % 2 !== 0) {
    throw new Error("Invalid 16-bit PCM audio length");
  }

  return pcmToWav(audio);
}

function getTimeout() {
  const n = Number(
    process.env.SARVAM_STT_TIMEOUT_MS || 15000
  );

  if (!Number.isFinite(n)) return 15000;

  return Math.min(25000, Math.max(3000, n));
}

async function getError(response) {
  const raw = await response.text().catch(() => "");

  if (!raw) return `Sarvam HTTP ${response.status}`;

  try {
    const data = JSON.parse(raw);

    return (
      data.error?.message ||
      data.message ||
      data.detail ||
      data.error ||
      raw
    );
  } catch (_) {
    return raw;
  }
}

// Call Sarvam STT API.
async function sarvamSTT(audioBuffer, language, mode, signal) {
  const apiKey = process.env.SARVAM_API_KEY;

  if (!apiKey) {
    return {
      ok: false,
      status: 500,
      message: "SARVAM_API_KEY is missing"
    };
  }

  const model =
    process.env.SARVAM_STT_MODEL || "saaras:v4";

  const form = new FormData();

  form.append(
    "file",
    new Blob([audioBuffer], { type: "audio/wav" }),
    "curix-audio.wav"
  );

  form.append("model", model);
  form.append("language_code", language);
  form.append("mode", mode);

  // Keyterm prompting is supported by Saaras v4.
  if (model === "saaras:v4") {
    form.append("keyterms", JSON.stringify(KEYTERMS));
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await fetch(API_URL, {
      method: "POST",
      signal,
      headers: {
        "api-subscription-key": apiKey,
        "Accept": "application/json"
      },
      body: form
    });

    if (response.ok) {
      let data;

      try {
        data = await response.json();
      } catch (_) {
        return {
          ok: false,
          status: 502,
          message: "Invalid Sarvam response"
        };
      }

      return {
        ok: true,
        transcript: String(data.transcript || "").trim(),
        languageCode: data.language_code || null,
        requestId: data.request_id || null
      };
    }

    const message = await getError(response);

    if (
      [429, 500, 502, 503, 504].includes(response.status) &&
      attempt === 1
    ) {
      await new Promise(resolve => setTimeout(resolve, 500));
      continue;
    }

    return {
      ok: false,
      status: response.status,
      message: String(message).slice(0, 350)
    };
  }

  return {
    ok: false,
    status: 502,
    message: "Sarvam STT failed after retry"
  };
}

// Main Netlify handler.
exports.handler = async (event) => {

  if (event.httpMethod !== "POST") {
    return json(405, { error: "POST method required" });
  }

  // CURIX authentication.
  const expectedToken = process.env.CURIX_APP_TOKEN;

  const suppliedToken = getHeader(
    event.headers,
    "x-curix-token"
  );

  if (!expectedToken || suppliedToken !== expectedToken) {
    return json(401, { error: "Unauthorized" });
  }

  if (!process.env.SARVAM_API_KEY) {
    return json(500, {
      error: "SARVAM_API_KEY is missing in Netlify"
    });
  }

  // Parse request.
  let body;

  try {
    body = JSON.parse(event.body || "{}");
  } catch (_) {
    return json(400, { error: "Invalid JSON" });
  }

  let audioBuffer;

  try {
    audioBuffer = decodeAudio(body.audio);
  } catch (error) {
    return json(400, { error: error.message });
  }

  // Language selection.
  const requestedLanguage =
    body.language_code ||
    body.languageCode ||
    body.lang ||
    "unknown";

  const language = LANGUAGES.has(requestedLanguage)
    ? requestedLanguage
    : "unknown";

  // Transcription mode.
  const requestedMode = String(
    body.mode ||
    process.env.SARVAM_STT_MODE ||
    "transcribe"
  ).toLowerCase();

  const mode = MODES.has(requestedMode)
    ? requestedMode
    : "transcribe";

  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    getTimeout()
  );

  try {
    const result = await sarvamSTT(
      audioBuffer,
      language,
      mode,
      controller.signal
    );

    if (!result.ok) {
      return json(
        result.status === 429 ? 429 : 502,
        { error: result.message }
      );
    }

    // Keep the original Android response contract.
    return json(200, {
      text: result.transcript,
      language_code: result.languageCode,
      request_id: result.requestId
    });

  } catch (error) {

    if (error.name === "AbortError") {
      return json(504, {
        error: "Sarvam STT request timed out"
      });
    }

    return json(502, {
      error: "Sarvam STT failed: " +
        String(error.message || error).slice(0, 250)
    });

  } finally {
    clearTimeout(timer);
  }
};
