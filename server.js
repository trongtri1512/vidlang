const express = require("express");
const cors = require("cors");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const multer = require("multer");

const app = express();
app.use(cors());
app.use(express.json());

// Multer config for video uploads (max 2GB)
const uploadDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB
});

const API_SECRET = process.env.API_SECRET || "change-me";
const AI33PRO_API_KEY = process.env.AI33PRO_API_KEY || "";
const AI33PRO_BASE_URL = "https://api.ai33.pro";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";
const GOOGLE_TRANSLATE_API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY || "";

const JOBS = {};

// ── Auth middleware ──
function auth(req, res, next) {
  if (req.headers["x-api-key"] !== API_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ── Routes ──

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.post("/api/process", auth, (req, res) => {
  const { youtubeUrl, targetLang = "en", sourceLang = "auto", callbackUrl, enableSubtitles = false, voiceId = null } = req.body;
  if (!youtubeUrl) return res.status(400).json({ error: "youtubeUrl required" });

  const jobId = uuidv4();
  JOBS[jobId] = { status: "queued", progress: 0, createdAt: new Date().toISOString() };
  res.json({ jobId, status: "accepted" });

  processVideo(jobId, youtubeUrl, sourceLang, targetLang, callbackUrl, enableSubtitles, voiceId);
});

app.get("/api/status/:jobId", auth, (req, res) => {
  const job = JOBS[req.params.jobId];
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({ jobId: req.params.jobId, ...job });
});

app.get("/api/jobs", auth, (_req, res) => {
  const list = Object.entries(JOBS).map(([id, data]) => ({ jobId: id, ...data }));
  res.json(list);
});

app.use("/output", express.static(path.join(__dirname, "output")));
app.use("/uploads", express.static(uploadDir));

// Upload video file endpoint
app.post("/api/upload", auth, upload.single("video"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No video file provided" });
  
  const ext = path.extname(req.file.originalname) || ".mp4";
  const newName = `${req.file.filename}${ext}`;
  const newPath = path.join(uploadDir, newName);
  fs.renameSync(req.file.path, newPath);
  
  const fileUrl = `/uploads/${newName}`;
  console.log(`📁 File uploaded: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(1)}MB) → ${fileUrl}`);
  res.json({ url: fileUrl, filename: req.file.originalname, size: req.file.size });
});

// ── AI33PRO helpers ──

async function ai33proRequest(endpoint, options) {
  const resp = await fetch(`${AI33PRO_BASE_URL}${endpoint}`, {
    ...options,
    headers: {
      ...options.headers,
      "xi-api-key": AI33PRO_API_KEY,
    },
  });
  return resp;
}

async function pollAI33ProTask(taskId, maxWaitMs = 7200000, onProgress = null) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const resp = await ai33proRequest(`/v1/task/${taskId}`, { method: "GET", headers: {} });
    if (!resp.ok) throw new Error(`AI33PRO poll error ${resp.status}`);
    const data = await resp.json();

    if (data.status === "done") return data;
    if (data.status === "error" || data.status === "failed") {
      throw new Error(`AI33PRO task failed: ${data.error_message || "unknown error"}`);
    }

    if (data.ec_remain_credits !== undefined && data.ec_remain_credits <= 0) {
      throw new Error("AI33PRO out of credits");
    }

    if (onProgress) onProgress(Date.now() - start);

    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("AI33PRO task timeout");
}

// ── STT: AI33PRO only ──

async function transcribeAudio(filePath, jobId = null) {
  if (!AI33PRO_API_KEY) {
    throw new Error("AI33PRO_API_KEY is not configured");
  }

  console.log("  📝 Transcribing with AI33PRO STT...");
  if (jobId) updateJob(jobId, "transcribing", 32, "Reading audio file...");

  const { Blob } = require("buffer");
  const fileBuffer = fs.readFileSync(filePath);
  const fileSizeMB = (fileBuffer.length / (1024 * 1024)).toFixed(1);
  const blob = new Blob([fileBuffer], { type: "audio/wav" });

  if (jobId) updateJob(jobId, "transcribing", 35, `Uploading audio (${fileSizeMB} MB)...`);

  const formData = new globalThis.FormData();
  formData.append("file", blob, "audio.wav");

  const resp = await ai33proRequest("/v1/task/speech-to-text", {
    method: "POST",
    headers: {},
    body: formData,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`AI33PRO STT error ${resp.status}: ${errText}`);
  }

  const result = await resp.json();

  if (!result.success || !result.task_id) {
    throw new Error(`AI33PRO STT rejected: ${JSON.stringify(result)}`);
  }

  if (result.ec_remain_credits !== undefined && result.ec_remain_credits <= 0) {
    throw new Error("AI33PRO out of credits");
  }

  if (jobId) updateJob(jobId, "transcribing", 40, "Waiting for speech recognition...");

  const taskResult = await pollAI33ProTask(result.task_id, 7200000, (elapsed) => {
    if (jobId) {
      const secs = Math.round(elapsed / 1000);
      updateJob(jobId, "transcribing", Math.min(45, 40 + Math.floor(secs / 6)), `Processing speech recognition (${secs}s)...`);
    }
  });

  if (jobId) updateJob(jobId, "transcribing", 48, "Downloading transcript...");

  // Try to get segmented data (with timestamps) for subtitles
  if (taskResult.metadata?.json_url) {
    const jsonResp = await fetch(taskResult.metadata.json_url);
    const jsonData = await jsonResp.json();
    console.log("  ✅ AI33PRO STT success");
    if (jobId) updateJob(jobId, "transcribing", 50, "Transcript ready!");
    return {
      text: jsonData.text || extractTextFromJson(jsonData),
      language: jsonData.language || "auto",
      segments: jsonData.segments || jsonData.chunks || null,
    };
  }

  if (taskResult.metadata?.srt_url) {
    const srtResp = await fetch(taskResult.metadata.srt_url);
    const srtText = await srtResp.text();
    console.log("  ✅ AI33PRO STT success (SRT)");
    if (jobId) updateJob(jobId, "transcribing", 50, "Transcript ready!");
    return {
      text: parseSrtToText(srtText),
      language: "auto",
      segments: parseSrtToSegments(srtText),
    };
  }

  throw new Error("AI33PRO STT: no transcript in result");
}

function extractTextFromJson(data) {
  if (typeof data === "string") return data;
  if (data.text) return data.text;
  if (Array.isArray(data)) return data.map((s) => s.text || s).join(" ");
  if (data.words) return data.words.map((w) => w.text || w.word || w).join(" ");
  return JSON.stringify(data);
}

function parseSrtToText(srt) {
  return srt
    .split("\n")
    .filter((line) => line.trim() && !/^\d+$/.test(line.trim()) && !line.includes("-->"))
    .join(" ")
    .trim();
}

function parseSrtToSegments(srt) {
  const segments = [];
  const blocks = srt.trim().split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim());
    if (lines.length < 2) continue;
    const timeLine = lines.find((l) => l.includes("-->"));
    if (!timeLine) continue;
    const [startStr, endStr] = timeLine.split("-->").map((s) => s.trim());
    const text = lines
      .filter((l) => !l.includes("-->") && !/^\d+$/.test(l.trim()))
      .join(" ")
      .trim();
    if (text) {
      segments.push({
        start: srtTimeToSeconds(startStr),
        end: srtTimeToSeconds(endStr),
        text,
      });
    }
  }
  return segments;
}

function srtTimeToSeconds(timeStr) {
  const [h, m, rest] = timeStr.replace(",", ".").split(":");
  return parseFloat(h) * 3600 + parseFloat(m) * 60 + parseFloat(rest);
}

function secondsToSrtTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const ms = Math.round((s - Math.floor(s)) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(Math.floor(s)).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

// ── TTS: AI33PRO only ──

// Voice mapping per target language for best quality
const VOICE_MAP = {
  vi: "FGY2WhTYpPnrIDTdsKH5",   // Laura - good multilingual support
  en: "JBFqnCBsd6RMkjVDRZzb",   // George
  zh: "onwK4e9ZLuTAKqWW03F9",   // Daniel
  ja: "Xb7hH8MSUJpSbSDYk0k2",   // Alice
  ko: "EXAVITQu4vr4xnSDxMaL",   // Sarah
  fr: "TX3LPaxmHKxFdv7VOQHJ",   // Liam
  es: "cgSgspJ2msm6clMCkdW9",   // Jessica
  de: "cjVigY5qzO86Huf0OWal",   // Eric
  th: "SAz9YHcvj6GT2YYXdXww",   // River
  id: "CwhRBWXzGAHq8TQ4Fs17",   // Roger
  km: "N2lVS1w4EtoT3dr4eOWO",   // Callum
};

// Languages that require Flash v2.5 (not supported by multilingual v2)
const FLASH_ONLY_LANGS = ["hu", "no"];

// Languages that use ElevenLabs v3 model
const V3_LANGS = ["vi"];

// ElevenLabs language codes for explicit language hints
const LANG_CODE_MAP = {
  vi: "vi", en: "en", zh: "zh", ja: "ja", ko: "ko",
  fr: "fr", es: "es", de: "de", th: "th", id: "id",
  km: "km", hu: "hu", no: "no",
};

function getTTSModel(targetLang) {
  if (V3_LANGS.includes(targetLang)) {
    return "eleven_v3";
  }
  if (FLASH_ONLY_LANGS.includes(targetLang)) {
    return "eleven_flash_v2_5";
  }
  return "eleven_multilingual_v2";
}

// Voice settings for more natural-sounding speech
const VOICE_SETTINGS = {
  stability: 0.4,           // Lower = more expressive, natural variation
  similarity_boost: 0.75,   // Keep voice characteristics
  style: 0.35,              // Moderate style for natural intonation
  use_speaker_boost: true,  // Enhanced clarity
  speed: 1.0,
};

// Voice settings for eleven_v3 (simpler params to avoid invalid_ttd_stability)
const VOICE_SETTINGS_V3 = {
  stability: 0.5,
  similarity_boost: 0.75,
};

async function generateTTS(text, outputPath, targetLang, customVoiceId = null) {
  if (!AI33PRO_API_KEY) {
    throw new Error("AI33PRO_API_KEY is not configured");
  }

  const modelId = getTTSModel(targetLang);
  const langCode = LANG_CODE_MAP[targetLang] || null;
  console.log(`  🔊 Generating TTS with AI33PRO (model: ${modelId}, lang: ${langCode || 'auto'})...`);
  const voiceId = customVoiceId || VOICE_MAP[targetLang] || ELEVENLABS_VOICE_ID;

  // Split long text into chunks
  const chunks = splitText(text, 4500);
  const chunkFiles = [];

  const TTS_CONCURRENCY = 20; // Process up to 20 chunks in parallel

  // Helper: process a single chunk with retry on rate limit / transient errors
  const processChunk = async (i, retries = 3) => {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await _processChunkOnce(i);
      } catch (err) {
        const msg = String(err);
        const isRetryable = msg.includes("429") || msg.includes("rate") || msg.includes("too many") || msg.includes("503") || msg.includes("timeout");
        if (isRetryable && attempt < retries) {
          const delay = attempt * 3000; // 3s, 6s backoff
          console.log(`  🔄 Chunk ${i} failed (attempt ${attempt}/${retries}), retrying in ${delay / 1000}s: ${msg.slice(0, 100)}`);
          await new Promise(r => setTimeout(r, delay));
        } else {
          throw err;
        }
      }
    }
  };

  const _processChunkOnce = async (i) => {
    const chunkPath = outputPath.replace(".mp3", `_chunk${i}.mp3`);

    const bodyPayload = {
      text: chunks[i],
      model_id: modelId,
      voice_settings: modelId === "eleven_v3" ? VOICE_SETTINGS_V3 : VOICE_SETTINGS,
      ...(langCode ? { language_code: langCode } : {}),
      ...(i > 0 ? { previous_text: chunks[i - 1].slice(-200) } : {}),
      ...(i < chunks.length - 1 ? { next_text: chunks[i + 1].slice(0, 200) } : {}),
    };

    const resp = await ai33proRequest(`/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bodyPayload),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`AI33PRO TTS error ${resp.status}: ${errText}`);
    }

    const result = await resp.json();
    if (!result.success || !result.task_id) {
      throw new Error(`AI33PRO TTS rejected: ${JSON.stringify(result)}`);
    }
    if (result.ec_remain_credits !== undefined && result.ec_remain_credits <= 0) {
      throw new Error("AI33PRO out of credits");
    }

    let taskResult;
    try {
      taskResult = await pollAI33ProTask(result.task_id);
    } catch (taskErr) {
      if (modelId === "eleven_v3" && String(taskErr).includes("invalid_ttd_stability")) {
        const fallbackModel = "eleven_flash_v2_5";
        console.log(`  ⚠️ eleven_v3 failed, retrying chunk ${i} with ${fallbackModel}...`);
        const retryResp = await ai33proRequest(`/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...bodyPayload, model_id: fallbackModel, voice_settings: VOICE_SETTINGS }),
        });
        if (!retryResp.ok) throw new Error(`AI33PRO TTS fallback error ${retryResp.status}: ${await retryResp.text()}`);
        const retryResult = await retryResp.json();
        if (!retryResult.success || !retryResult.task_id) throw new Error(`AI33PRO TTS fallback rejected: ${JSON.stringify(retryResult)}`);
        taskResult = await pollAI33ProTask(retryResult.task_id);
      } else {
        throw taskErr;
      }
    }

    if (!taskResult.metadata?.audio_url) {
      throw new Error("AI33PRO TTS: no audio_url in result");
    }

    const audioResp = await fetch(taskResult.metadata.audio_url);
    if (!audioResp.ok) throw new Error(`Failed to download AI33PRO audio: ${audioResp.status}`);
    const buffer = Buffer.from(await audioResp.arrayBuffer());
    fs.writeFileSync(chunkPath, buffer);
    return chunkPath;
  };

  // Process chunks in parallel batches of TTS_CONCURRENCY
  console.log(`  🚀 Processing ${chunks.length} TTS chunks (concurrency: ${Math.min(TTS_CONCURRENCY, chunks.length)})...`);
  for (let batchStart = 0; batchStart < chunks.length; batchStart += TTS_CONCURRENCY) {
    const batchEnd = Math.min(batchStart + TTS_CONCURRENCY, chunks.length);
    const batchIndices = Array.from({ length: batchEnd - batchStart }, (_, k) => batchStart + k);
    const results = await Promise.all(batchIndices.map(processChunk));
    chunkFiles.push(...results);
  }

  // Concat chunks if multiple
  if (chunkFiles.length === 1) {
    fs.renameSync(chunkFiles[0], outputPath);
  } else {
    const listFile = outputPath.replace(".mp3", "_list.txt");
    fs.writeFileSync(listFile, chunkFiles.map((f) => `file '${f}'`).join("\n"));
    await run(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${outputPath}"`);
    chunkFiles.forEach((f) => fs.unlinkSync(f));
    fs.unlinkSync(listFile);
  }

  console.log("  ✅ AI33PRO TTS success");
}

// Generate TTS for a single segment (with optional stitching context)
async function generateTTSSegment(text, outputPath, voiceId, targetLang, previousText, nextText) {
  const modelId = getTTSModel(targetLang);
  const langCode = LANG_CODE_MAP[targetLang] || null;
  const resp = await ai33proRequest(`/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      model_id: modelId,
      voice_settings: VOICE_SETTINGS,
      ...(langCode ? { language_code: langCode } : {}),
      // Request stitching: provide context from adjacent segments
      ...(previousText ? { previous_text: previousText } : {}),
      ...(nextText ? { next_text: nextText } : {}),
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`AI33PRO TTS segment error ${resp.status}: ${errText}`);
  }

  const result = await resp.json();
  if (!result.success || !result.task_id) {
    throw new Error(`AI33PRO TTS segment rejected: ${JSON.stringify(result)}`);
  }
  if (result.ec_remain_credits !== undefined && result.ec_remain_credits <= 0) {
    throw new Error("AI33PRO out of credits");
  }

  const taskResult = await pollAI33ProTask(result.task_id);
  if (!taskResult.metadata?.audio_url) {
    throw new Error("AI33PRO TTS segment: no audio_url in result");
  }

  const audioResp = await fetch(taskResult.metadata.audio_url);
  if (!audioResp.ok) throw new Error(`Failed to download segment audio: ${audioResp.status}`);

  const buffer = Buffer.from(await audioResp.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);
}

// ── Translation ──

async function translateText(text, sourceLang, targetLang) {
  // Split long text into chunks
  const MAX_CHUNK = 4000;
  if (text.length > MAX_CHUNK) {
    const chunks = splitText(text, MAX_CHUNK);
    const translated = [];
    for (const chunk of chunks) {
      translated.push(await translateText(chunk, sourceLang, targetLang));
    }
    return translated.join(" ");
  }

  // Use official Google Cloud Translation API if key is available
  if (GOOGLE_TRANSLATE_API_KEY) {
    for (let retry = 0; retry < 3; retry++) {
      try {
        const body = {
          q: text,
          target: targetLang,
          format: "text",
        };
        if (sourceLang && sourceLang !== "auto") {
          body.source = sourceLang;
        }

        const resp = await fetch(
          `https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_TRANSLATE_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        );

        if (!resp.ok) {
          const errText = await resp.text();
          console.warn(`  ⚠️ Google Translate API error (status ${resp.status}, retry ${retry + 1}/3): ${errText.substring(0, 200)}`);
          await new Promise((r) => setTimeout(r, 1000 * (retry + 1)));
          continue;
        }

        const data = await resp.json();
        const translated = data.data?.translations?.[0]?.translatedText;
        if (translated) {
          console.log(`  ✅ Google Cloud Translation API success (${sourceLang} → ${targetLang})`);
          return translated;
        }

        console.warn("  ⚠️ Unexpected Google Translate API response:", JSON.stringify(data).substring(0, 200));
        return text;
      } catch (err) {
        console.warn(`  ⚠️ Google Translate API error (retry ${retry + 1}/3):`, err.message);
        await new Promise((r) => setTimeout(r, 1000 * (retry + 1)));
      }
    }
    console.error("  ❌ Google Cloud Translation API failed after 3 retries, returning original text");
    return text;
  }

  // Fallback: free Google Translate endpoints
  const sl = sourceLang === "auto" ? "auto" : sourceLang;
  const endpoints = [
    `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`,
    `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=${sl}&tl=${targetLang}&q=${encodeURIComponent(text)}`,
  ];

  for (let i = 0; i < endpoints.length; i++) {
    for (let retry = 0; retry < 3; retry++) {
      try {
        const resp = await fetch(endpoints[i], {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        });
        const contentType = resp.headers.get("content-type") || "";
        const bodyText = await resp.text();
        if (!resp.ok || bodyText.trim().startsWith("<!") || bodyText.includes("<html")) {
          console.warn(`  ⚠️ Translation endpoint ${i} returned HTML/error (status ${resp.status}), retry ${retry + 1}/3`);
          await new Promise((r) => setTimeout(r, 1000 * (retry + 1)));
          continue;
        }
        const data = JSON.parse(bodyText);
        if (Array.isArray(data) && Array.isArray(data[0])) {
          return data[0].map((s) => (Array.isArray(s) ? s[0] : s)).join("");
        }
        if (Array.isArray(data)) {
          if (typeof data[0] === "string") return data[0];
          if (Array.isArray(data[0]) && typeof data[0][0] === "string") return data[0][0];
        }
        if (data.sentences) {
          return data.sentences.map((s) => s.trans).join("");
        }
        console.warn("  ⚠️ Unexpected translation format:", JSON.stringify(data).substring(0, 200));
        return text;
      } catch (err) {
        console.warn(`  ⚠️ Translation error (endpoint ${i}, retry ${retry + 1}/3):`, err.message);
        await new Promise((r) => setTimeout(r, 1000 * (retry + 1)));
      }
    }
  }

  console.error("  ❌ All translation attempts failed, returning original text");
  return text;
}

// ── YouTube subtitle extraction ──

async function tryYouTubeSubtitles(workDir, url, sourceLang) {
  try {
    // Strategy: try source language manual subs → source auto subs → any available
    const langCodes = [];
    if (sourceLang && sourceLang !== "auto") {
      langCodes.push(sourceLang);
    }

    // Build sub-lang argument: prefer specific language, fallback to all available
    const subLangArg = langCodes.length > 0 ? `--sub-lang "${langCodes.join(",")}"` : "";

    // First try: manual subtitles for source language
    if (subLangArg) {
      try {
        await run(`yt-dlp --skip-download --write-sub ${subLangArg} --sub-format srt -o "${workDir}/ytsub" "${url}"`);
        const result = parseYouTubeSubFile(workDir, sourceLang);
        if (result) {
          console.log(`  ✅ Using manual YouTube subtitle (${result.language})`);
          return result;
        }
      } catch (_e) { /* no manual subs */ }
    }

    // Second try: auto-generated subtitles for source language
    if (subLangArg) {
      try {
        await run(`yt-dlp --skip-download --write-auto-sub ${subLangArg} --sub-format srt -o "${workDir}/ytsub" "${url}"`);
        const result = parseYouTubeSubFile(workDir, sourceLang);
        if (result) {
          console.log(`  ✅ Using auto-generated YouTube subtitle (${result.language})`);
          return result;
        }
      } catch (_e) { /* no auto subs */ }
    }

    // Third try: any available subtitle
    try {
      await run(`yt-dlp --skip-download --write-sub --write-auto-sub --sub-format srt -o "${workDir}/ytsub" "${url}"`);
      const result = parseYouTubeSubFile(workDir, sourceLang);
      if (result) {
        console.log(`  ✅ Using available YouTube subtitle (${result.language})`);
        return result;
      }
    } catch (_e) { /* no subs at all */ }

    console.log("  ℹ️ No YouTube subtitles found");
    return null;
  } catch (err) {
    console.log(`  ℹ️ YouTube subtitle extraction failed: ${err.message}`);
    return null;
  }
}

function parseYouTubeSubFile(workDir, sourceLang) {
  const files = fs.readdirSync(workDir);
  const subFile = files.find((f) => f.startsWith("ytsub") && (f.endsWith(".srt") || f.endsWith(".json3")));

  if (!subFile) return null;

  console.log(`  📄 Found YouTube subtitle: ${subFile}`);
  const filePath = path.join(workDir, subFile);
  const content = fs.readFileSync(filePath, "utf-8");

  let segments;
  if (subFile.endsWith(".json3")) {
    // Legacy json3 parsing
    const subData = JSON.parse(content);
    segments = [];
    const events = subData.events || [];
    for (const event of events) {
      if (!event.segs || event.tStartMs === undefined) continue;
      const text = event.segs.map((s) => s.utf8 || "").join("").trim();
      if (!text || text === "\n") continue;
      const startSec = event.tStartMs / 1000;
      const durationMs = event.dDurationMs || 3000;
      const endSec = (event.tStartMs + durationMs) / 1000;
      segments.push({ start: startSec, end: endSec, text });
    }
  } else {
    // SRT parsing
    segments = parseSrtToSegments(content);
  }

  if (!segments || segments.length === 0) return null;

  // Clean up the file to avoid re-detection
  fs.unlinkSync(filePath);

  const fullText = segments.map((s) => s.text).join(" ");
  const detectedLang = subFile.match(/\.([a-z]{2}(-[A-Z]{2})?)\./)?.[1] || sourceLang;

  return {
    text: fullText,
    language: detectedLang,
    segments,
    source: "youtube",
  };
}

// ── Processing pipeline ──

async function processVideo(jobId, url, sourceLang, targetLang, callbackUrl, enableSubtitles = false, customVoiceId = null) {
  const workDir = path.join(__dirname, "jobs", jobId);
  fs.mkdirSync(workDir, { recursive: true });

  const isYouTube = /(?:youtube\.com|youtu\.be)/i.test(url);

  try {
    if (isYouTube) {
      updateJob(jobId, "downloading", 5, "Checking YouTube subtitles...");

      // Step 1: Try to get YouTube subtitles first (fast, free, accurate)
      const ytSubs = await tryYouTubeSubtitles(workDir, url, sourceLang);

      updateJob(jobId, "downloading", 10, "Downloading YouTube video...");
      await run(`yt-dlp -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" --merge-output-format mp4 -o "${workDir}/video.mp4" "${url}"`);

      var transcript;
      if (ytSubs) {
        updateJob(jobId, "transcribing", 30, "Using YouTube subtitles (fast mode)");
        transcript = ytSubs;
        console.log(`  ⚡ Skipping STT - using YouTube subtitles (${ytSubs.segments.length} segments)`);
      }
    } else {
      // Direct video URL: download with curl
      updateJob(jobId, "downloading", 5, "Downloading video from URL...");
      await run(`curl -L -o "${workDir}/video.mp4" --max-filesize 2147483648 --connect-timeout 30 --max-time 3600 "${url}"`);
      updateJob(jobId, "downloading", 15, "Video downloaded");
      var transcript;
    }

    if (!transcript) {
      // Fallback: extract audio and use STT (for direct URLs or YouTube without subs)
      updateJob(jobId, "extracting_audio", 20);
      await run(`ffmpeg -y -i "${workDir}/video.mp4" -vn -acodec pcm_s16le -ar 16000 -ac 1 "${workDir}/audio.wav"`);

      updateJob(jobId, "transcribing", 30, "Uploading audio to STT service...");
      transcript = await transcribeAudio(`${workDir}/audio.wav`, jobId);
    }
    fs.writeFileSync(`${workDir}/transcript.json`, JSON.stringify(transcript, null, 2));

    updateJob(jobId, "translating", 50);
    let translatedText;

    // If subtitles enabled and we have segments, translate per segment
    let srtPath = null;
    if (enableSubtitles && transcript.segments && transcript.segments.length > 0) {
      updateJob(jobId, "translating", 52, "Translating segments for subtitles...");
      const translatedSegments = [];
      for (let i = 0; i < transcript.segments.length; i++) {
        const seg = transcript.segments[i];
        const translated = await translateText(seg.text, sourceLang, targetLang);
        translatedSegments.push({ ...seg, text: translated });
        if (i % 5 === 0) {
          updateJob(jobId, "translating", 52 + Math.floor((i / transcript.segments.length) * 15), `Translating segment ${i + 1}/${transcript.segments.length}...`);
        }
      }
      translatedText = translatedSegments.map((s) => s.text).join(" ");

      // Generate SRT file
      srtPath = `${workDir}/subtitles.srt`;
      let srtContent = "";
      for (let i = 0; i < translatedSegments.length; i++) {
        const seg = translatedSegments[i];
        srtContent += `${i + 1}\n${secondsToSrtTime(seg.start)} --> ${secondsToSrtTime(seg.end)}\n${seg.text}\n\n`;
      }
      fs.writeFileSync(srtPath, srtContent, "utf-8");
      console.log(`  📄 Generated SRT with ${translatedSegments.length} segments`);
    } else {
      translatedText = await translateText(transcript.text, sourceLang, targetLang);
    }
    fs.writeFileSync(`${workDir}/translated.txt`, translatedText);

    // ── TTS Generation ──
    if (enableSubtitles && srtPath && transcript.segments && transcript.segments.length > 0) {
      // === Per-segment TTS: generate audio for each subtitle segment individually ===
      updateJob(jobId, "generating_voice", 70, "Generating voice per segment...");
      const translatedSegments = parseSrtToSegments(fs.readFileSync(srtPath, "utf-8"));
      const voiceId = customVoiceId || VOICE_MAP[targetLang] || ELEVENLABS_VOICE_ID;
      const segAudioFiles = [];
      let currentTime = 0;
      let newSrt = "";

      for (let i = 0; i < translatedSegments.length; i++) {
        const seg = translatedSegments[i];
        const segAudioPath = `${workDir}/seg_${i}.mp3`;

        updateJob(jobId, "generating_voice", 70 + Math.floor((i / translatedSegments.length) * 15),
          `TTS segment ${i + 1}/${translatedSegments.length}...`);

        // Generate TTS for this single segment with stitching context
        const prevText = i > 0 ? translatedSegments[i - 1].text : null;
        const nextTextCtx = i < translatedSegments.length - 1 ? translatedSegments[i + 1].text : null;
        await generateTTSSegment(seg.text, segAudioPath, voiceId, targetLang, prevText, nextTextCtx);

        // Measure actual duration of this segment's audio
        const segDuration = await getMediaDuration(segAudioPath);
        const segStart = currentTime;
        const segEnd = currentTime + segDuration;

        // Build SRT entry with real timing
        newSrt += `${i + 1}\n${secondsToSrtTime(segStart)} --> ${secondsToSrtTime(segEnd)}\n${seg.text}\n\n`;
        segAudioFiles.push(segAudioPath);
        currentTime = segEnd;

        console.log(`  🎙️ Seg ${i + 1}/${translatedSegments.length}: "${seg.text.substring(0, 30)}..." → ${segDuration.toFixed(2)}s`);
      }

      // Write re-timed SRT
      fs.writeFileSync(srtPath, newSrt, "utf-8");
      console.log(`  ✅ SRT re-timed from actual TTS durations (total: ${currentTime.toFixed(1)}s)`);

      // Concatenate all segment audio files into one
      updateJob(jobId, "generating_voice", 86, "Concatenating audio segments...");
      const listFile = `${workDir}/seg_list.txt`;
      fs.writeFileSync(listFile, segAudioFiles.map((f) => `file '${f}'`).join("\n"));
      await run(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${workDir}/tts_audio.mp3"`);

      // Cleanup segment files
      segAudioFiles.forEach((f) => { try { fs.unlinkSync(f); } catch (_) {} });
      try { fs.unlinkSync(listFile); } catch (_) {}
    } else {
      // No subtitles: single TTS for entire text
      updateJob(jobId, "generating_voice", 70);
      await generateTTS(translatedText, `${workDir}/tts_audio.mp3`, targetLang, customVoiceId);
    }

    updateJob(jobId, "merging", 90);
    if (srtPath) {
      // Burn subtitles into video + replace audio
      updateJob(jobId, "merging", 90, "Merging audio & burning subtitles...");
      // Use absolute path and proper escaping for ffmpeg subtitles filter
      const absSrtPath = path.resolve(srtPath).replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "'\\''");
      // HeyGen-style: orange/amber background box, white bold text, centered bottom
      await run(`ffmpeg -y -i "${workDir}/video.mp4" -i "${workDir}/tts_audio.mp3" -vf "subtitles='${absSrtPath}':force_style='FontName=Noto Sans CJK SC,FontSize=28,Bold=1,PrimaryColour=&H00FFFFFF,BackColour=&H00009BF0,BorderStyle=4,Outline=0,Shadow=0,MarginV=25,Alignment=2'" -c:v libx264 -preset fast -crf 23 -map 0:v:0 -map 1:a:0 -shortest "${workDir}/output.mp4"`);
    } else {
      await run(`ffmpeg -y -i "${workDir}/video.mp4" -i "${workDir}/tts_audio.mp3" -c:v copy -map 0:v:0 -map 1:a:0 -shortest "${workDir}/output.mp4"`);
    }

    const outputFile = `${jobId}.mp4`;
    fs.copyFileSync(`${workDir}/output.mp4`, path.join(__dirname, "output", outputFile));

    JOBS[jobId] = {
      ...JOBS[jobId],
      status: "done",
      progress: 100,
      outputUrl: `/output/${outputFile}`,
      completedAt: new Date().toISOString(),
    };

    if (callbackUrl) {
      fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, status: "done", outputUrl: `/output/${outputFile}` }),
      }).catch(console.error);
    }

    console.log(`[${jobId}] ✅ Done`);
  } catch (err) {
    console.error(`[${jobId}] ❌ Error:`, err.message);
    JOBS[jobId] = { ...JOBS[jobId], status: "error", error: err.message };

    if (callbackUrl) {
      fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, status: "error", error: err.message }),
      }).catch(() => {});
    }
  }
}

function splitText(text, maxLen) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf(". ", maxLen);
    if (splitAt === -1) splitAt = maxLen;
    else splitAt += 1;
    chunks.push(remaining.substring(0, splitAt).trim());
    remaining = remaining.substring(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function updateJob(jobId, status, progress, detail = null) {
  JOBS[jobId] = { ...JOBS[jobId], status, progress, detail };
  console.log(`[${jobId}] ${status} (${progress}%)${detail ? ` - ${detail}` : ""}`);
}

function getMediaDuration(filePath) {
  return new Promise((resolve) => {
    exec(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${filePath}"`, (err, stdout) => {
      if (err) {
        console.error(`  ⚠️ ffprobe error for ${filePath}:`, err.message);
        resolve(0);
      } else {
        resolve(parseFloat(stdout.trim()) || 0);
      }
    });
  });
}

function run(cmd) {
  return new Promise((resolve, reject) => {
    console.log(`> ${cmd.substring(0, 100)}...`);
    exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

// ── Start ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 VidLang API running on port ${PORT}`);
  console.log(`   AI33PRO: ${AI33PRO_API_KEY ? "✅ configured" : "❌ NOT SET - required!"}`);
});
