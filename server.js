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
const GOOGLE_TTS_API_KEY = process.env.GOOGLE_TTS_API_KEY || GOOGLE_TRANSLATE_API_KEY; // Can reuse same Google Cloud API key

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
  const { youtubeUrl, targetLang = "en", sourceLang = "auto", callbackUrl, enableSubtitles = false, voiceId = null, mode = "translate", dubbingConcurrency = 1 } = req.body;
  if (!youtubeUrl) return res.status(400).json({ error: "youtubeUrl required" });

  const safeTargetLang = typeof targetLang === "string" && targetLang.trim() ? targetLang.trim() : "en";
  const safeSourceLang = typeof sourceLang === "string" && sourceLang.trim() ? sourceLang.trim() : "auto";
  const safeConcurrency = Math.max(1, Math.min(6, Number(dubbingConcurrency) || 1));

  const jobId = uuidv4();
  JOBS[jobId] = { status: "queued", progress: 0, createdAt: new Date().toISOString(), youtubeUrl, sourceLang: safeSourceLang, targetLang: safeTargetLang, callbackUrl, enableSubtitles, voiceId, mode, dubbingConcurrency: safeConcurrency };
  res.json({ jobId, status: "accepted" });

  processVideo(jobId, youtubeUrl, safeSourceLang, safeTargetLang, callbackUrl, enableSubtitles, voiceId, mode);
});

// Retry a failed job from where it left off (reuses existing intermediate files)
// Accepts job params in body since JOBS is in-memory and lost on restart
app.post("/api/retry/:jobId", auth, (req, res) => {
  const { jobId } = req.params;
  const { youtubeUrl, sourceLang = "auto", targetLang = "en", callbackUrl, enableSubtitles = false, voiceId = null, mode = "translate" } = req.body || {};
  
  const workDir = path.join(__dirname, "jobs", jobId);
  if (!fs.existsSync(workDir)) {
    return res.status(400).json({ error: "No intermediate files found. Please start a new job." });
  }
  
  const existingFiles = fs.readdirSync(workDir);
  const dubbedChunks = existingFiles.filter(f => f.startsWith("dubbed_") && f.endsWith(".mp3"));
  const hasVideo = existingFiles.includes("video.mp4");
  const hasTtsAudio = existingFiles.includes("tts_audio.mp3");
  
  console.log(`[${jobId}] ♻️ Retry requested. Files: video=${hasVideo}, ttsAudio=${hasTtsAudio}, dubbedChunks=${dubbedChunks.length}`);
  
  JOBS[jobId] = { status: "queued", progress: 0, error: null, detail: "Retrying from last checkpoint...", createdAt: new Date().toISOString(), youtubeUrl, sourceLang, targetLang, mode };
  res.json({ jobId, status: "retrying", cached: { hasVideo, hasTtsAudio, dubbedChunks: dubbedChunks.length } });
  
  processVideo(jobId, youtubeUrl || "", sourceLang, targetLang, callbackUrl, enableSubtitles, voiceId, mode);
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

// Re-burn subtitles on an existing completed job with updated style
app.post("/api/reburn/:jobId", auth, async (req, res) => {
  const { jobId } = req.params;
  const workDir = path.join(__dirname, "jobs", jobId);

  if (!fs.existsSync(workDir)) {
    return res.status(400).json({ error: "No job files found for this job." });
  }

  const videoPath = `${workDir}/video.mp4`;
  const ttsAudioPath = `${workDir}/tts_audio.mp3`;
  const srtPath = `${workDir}/subtitles.srt`;

  if (!fs.existsSync(videoPath)) {
    return res.status(400).json({ error: "video.mp4 not found in job directory." });
  }
  if (!fs.existsSync(ttsAudioPath)) {
    return res.status(400).json({ error: "tts_audio.mp3 not found in job directory." });
  }
  if (!fs.existsSync(srtPath)) {
    return res.status(400).json({ error: "subtitles.srt not found in job directory." });
  }

  JOBS[jobId] = { ...(JOBS[jobId] || {}), status: "merging", progress: 90, detail: "Re-burning subtitles..." };
  res.json({ jobId, status: "reburning" });

  try {
    const absSrtPath = path.resolve(srtPath).replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "'\\''");
    await run(`ffmpeg -y -i "${videoPath}" -i "${ttsAudioPath}" -vf "subtitles='${absSrtPath}':force_style='FontName=Noto Sans CJK SC,FontSize=22,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H000080FF,BackColour=&H80000000,BorderStyle=3,Outline=4,Shadow=0,MarginV=25,MarginL=30,MarginR=30,Alignment=2'" -c:v libx264 -preset fast -crf 23 -map 0:v:0 -map 1:a:0 -shortest "${workDir}/output.mp4"`);

    const outputFile = `${jobId}.mp4`;
    fs.copyFileSync(`${workDir}/output.mp4`, path.join(__dirname, "output", outputFile));

    JOBS[jobId] = {
      ...(JOBS[jobId] || {}),
      status: "done",
      progress: 100,
      outputUrl: `/output/${outputFile}`,
      detail: "Subtitles re-burned successfully",
      completedAt: new Date().toISOString(),
    };
    console.log(`[${jobId}] ✅ Subtitles re-burned`);
  } catch (err) {
    console.error(`[${jobId}] ❌ Reburn error:`, err.message);
    JOBS[jobId] = { ...(JOBS[jobId] || {}), status: "error", error: err.message };
  }
});

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
  const headers = {
    ...(options.headers || {}),
    "xi-api-key": AI33PRO_API_KEY,
  };
  const resp = await fetch(`${AI33PRO_BASE_URL}${endpoint}`, {
    ...options,
    headers,
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

// Transcribe a single audio chunk with AI33PRO (must be <20MB and <5min)
async function transcribeAudioChunk(filePath, jobId = null, chunkLabel = "") {
  const { Blob } = require("buffer");
  const fileBuffer = fs.readFileSync(filePath);
  const fileSizeMB = (fileBuffer.length / (1024 * 1024)).toFixed(1);
  const blob = new Blob([fileBuffer], { type: "audio/wav" });

  console.log(`  📝 STT chunk ${chunkLabel} (${fileSizeMB} MB)...`);

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

  const taskResult = await pollAI33ProTask(result.task_id, 7200000);

  if (taskResult.metadata?.json_url) {
    const jsonResp = await fetch(taskResult.metadata.json_url);
    const jsonData = await jsonResp.json();
    const rawSegments = jsonData.segments || jsonData.chunks || null;
    const fullText = jsonData.text || extractTextFromJson(jsonData);
    const segments = rawSegments && rawSegments.length > 0
      ? rawSegments
      : generateSegmentsFromText(fullText);
    return { text: fullText, language: jsonData.language || "auto", segments };
  }

  if (taskResult.metadata?.srt_url) {
    const srtResp = await fetch(taskResult.metadata.srt_url);
    const srtText = await srtResp.text();
    return { text: parseSrtToText(srtText), language: "auto", segments: parseSrtToSegments(srtText) };
  }

  throw new Error("AI33PRO STT: no transcript in result");
}

async function transcribeAudio(filePath, jobId = null) {
  if (!AI33PRO_API_KEY) {
    throw new Error("AI33PRO_API_KEY is not configured");
  }

  console.log("  📝 Transcribing with AI33PRO STT...");
  if (jobId) updateJob(jobId, "transcribing", 32, "Checking audio duration...");

  // Check audio duration and file size
  const audioDuration = await getMediaDuration(filePath);
  const fileSize = fs.statSync(filePath).size;
  const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(1);
  const MAX_DURATION = 270; // 4.5 minutes (safety margin under 5min limit)
  const MAX_SIZE = 18 * 1024 * 1024; // 18MB (safety margin under 20MB limit)

  console.log(`  📊 Audio: ${audioDuration.toFixed(1)}s, ${fileSizeMB} MB`);

  // If audio is small enough, transcribe directly
  if (audioDuration <= MAX_DURATION && fileSize <= MAX_SIZE) {
    if (jobId) updateJob(jobId, "transcribing", 35, `Uploading audio (${fileSizeMB} MB)...`);
    const result = await transcribeAudioChunk(filePath, jobId, "1/1");
    console.log("  ✅ AI33PRO STT success");
    if (jobId) updateJob(jobId, "transcribing", 50, "Transcript ready!");
    return result;
  }

  // Audio exceeds limits — split into chunks
  const numChunks = Math.max(
    Math.ceil(audioDuration / MAX_DURATION),
    Math.ceil(fileSize / MAX_SIZE)
  );
  const chunkDuration = Math.floor(audioDuration / numChunks);
  console.log(`  ✂️ Audio too large, splitting into ${numChunks} chunks (~${chunkDuration}s each)...`);
  if (jobId) updateJob(jobId, "transcribing", 33, `Splitting audio into ${numChunks} chunks...`);

  const workDir = path.dirname(filePath);
  const chunkFiles = [];

  // Split audio using ffmpeg
  for (let i = 0; i < numChunks; i++) {
    const startSec = i * chunkDuration;
    const chunkPath = path.join(workDir, `audio_chunk_${i}.wav`);
    // Last chunk: no duration limit (take remainder)
    if (i === numChunks - 1) {
      await run(`ffmpeg -y -i "${filePath}" -ss ${startSec} -acodec pcm_s16le -ar 16000 -ac 1 "${chunkPath}"`);
    } else {
      await run(`ffmpeg -y -i "${filePath}" -ss ${startSec} -t ${chunkDuration} -acodec pcm_s16le -ar 16000 -ac 1 "${chunkPath}"`);
    }
    chunkFiles.push(chunkPath);
  }

  // Transcribe each chunk sequentially (to preserve order and manage credits)
  const allSegments = [];
  let fullText = "";
  let detectedLang = "auto";
  let timeOffset = 0;

  for (let i = 0; i < chunkFiles.length; i++) {
    if (jobId) {
      const pct = 35 + Math.floor((i / chunkFiles.length) * 13);
      updateJob(jobId, "transcribing", pct, `Transcribing chunk ${i + 1}/${chunkFiles.length}...`);
    }

    const chunkResult = await transcribeAudioChunk(chunkFiles[i], null, `${i + 1}/${chunkFiles.length}`);

    if (chunkResult.language && chunkResult.language !== "auto") {
      detectedLang = chunkResult.language;
    }

    fullText += (fullText ? " " : "") + chunkResult.text;

    // Offset segment timestamps by the chunk's start time
    const chunkStartTime = i * chunkDuration;
    if (chunkResult.segments) {
      for (const seg of chunkResult.segments) {
        allSegments.push({
          start: seg.start + chunkStartTime,
          end: seg.end + chunkStartTime,
          text: seg.text,
        });
      }
    }

    // Cleanup chunk file
    try { fs.unlinkSync(chunkFiles[i]); } catch (_) {}
  }

  console.log(`  ✅ AI33PRO STT success (${chunkFiles.length} chunks merged, ${allSegments.length} segments)`);
  if (jobId) updateJob(jobId, "transcribing", 50, "Transcript ready!");

  return {
    text: fullText,
    language: detectedLang,
    segments: allSegments,
  };
}

function extractTextFromJson(data) {
  if (typeof data === "string") return data;
  if (data.text) return data.text;
  if (Array.isArray(data)) return data.map((s) => s.text || s).join(" ");
  if (data.words) return data.words.map((w) => w.text || w.word || w).join(" ");
  return JSON.stringify(data);
}
// Generate pseudo-segments from plain text when STT doesn't provide timestamps
// Splits by sentences first, then further splits long sentences into ~80 char chunks
function generateSegmentsFromText(text) {
  if (!text || text.trim().length === 0) return [];
  
  const MAX_CHARS = 80; // Max chars per subtitle line
  
  // Split by sentence-ending punctuation (including comma/semicolon for long texts)
  const rawSentences = text.match(/[^.!?。！？;；]+[.!?。！？;；]+|[^.!?。！？;；]+$/g) || [text];
  
  // Further split long sentences into smaller chunks
  const chunks = [];
  for (const sentence of rawSentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    if (trimmed.length <= MAX_CHARS) {
      chunks.push(trimmed);
    } else {
      // Split by comma, colon, or natural break points
      const parts = trimmed.match(/[^,，:：]+[,，:：]?/g) || [trimmed];
      let buffer = "";
      for (const part of parts) {
        if (buffer.length + part.length > MAX_CHARS && buffer.length > 0) {
          chunks.push(buffer.trim());
          buffer = part;
        } else {
          buffer += part;
        }
      }
      if (buffer.trim()) {
        // If still too long, force split by word boundaries
        const remaining = buffer.trim();
        if (remaining.length > MAX_CHARS) {
          const words = remaining.split(/\s+/);
          let wordBuffer = "";
          for (const word of words) {
            if (wordBuffer.length + word.length + 1 > MAX_CHARS && wordBuffer.length > 0) {
              chunks.push(wordBuffer.trim());
              wordBuffer = word;
            } else {
              wordBuffer += (wordBuffer ? " " : "") + word;
            }
          }
          if (wordBuffer.trim()) chunks.push(wordBuffer.trim());
        } else {
          chunks.push(remaining);
        }
      }
    }
  }
  
  const segments = [];
  let currentTime = 0;
  for (const chunk of chunks) {
    // Estimate duration: ~2.5 words/sec or ~8 chars/sec for CJK
    const isCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(chunk);
    const duration = isCJK
      ? Math.max(1, chunk.length * 0.15)
      : Math.max(1, chunk.split(/\s+/).length / 2.5);
    segments.push({ start: currentTime, end: currentTime + duration, text: chunk });
    currentTime += duration;
  }
  console.log(`  📝 Generated ${segments.length} pseudo-segments from text (total: ${currentTime.toFixed(1)}s estimated)`);
  return segments;
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

// ── TTS: Google Cloud Text-to-Speech (Standard voices) ──

// Google TTS Standard voice mapping per language
const GOOGLE_VOICE_MAP = {
  vi: { languageCode: "vi-VN", name: "vi-VN-Standard-A", ssmlGender: "FEMALE" },
  en: { languageCode: "en-US", name: "en-US-Standard-C", ssmlGender: "FEMALE" },
  zh: { languageCode: "cmn-CN", name: "cmn-CN-Standard-A", ssmlGender: "FEMALE" },
  ja: { languageCode: "ja-JP", name: "ja-JP-Standard-A", ssmlGender: "FEMALE" },
  ko: { languageCode: "ko-KR", name: "ko-KR-Standard-A", ssmlGender: "FEMALE" },
  fr: { languageCode: "fr-FR", name: "fr-FR-Standard-A", ssmlGender: "FEMALE" },
  es: { languageCode: "es-ES", name: "es-ES-Standard-A", ssmlGender: "FEMALE" },
  de: { languageCode: "de-DE", name: "de-DE-Standard-A", ssmlGender: "FEMALE" },
  th: { languageCode: "th-TH", name: "th-TH-Standard-A", ssmlGender: "FEMALE" },
  id: { languageCode: "id-ID", name: "id-ID-Standard-A", ssmlGender: "FEMALE" },
};

// Google TTS has a 5000 byte limit per request
const GOOGLE_TTS_MAX_BYTES = 4800;

function shouldRetryTtsError(err) {
  const msg = String(err?.message || err);
  return !(
    msg.includes("Google TTS error 400") ||
    msg.includes("Google TTS error 401") ||
    msg.includes("Google TTS error 403")
  );
}

async function googleTTSSynthesize(text, targetLang, customVoiceName = null) {
  if (!GOOGLE_TTS_API_KEY) {
    throw new Error("GOOGLE_TTS_API_KEY is not configured (set GOOGLE_TTS_API_KEY or GOOGLE_TRANSLATE_API_KEY)");
  }

  const defaultVoice = GOOGLE_VOICE_MAP[targetLang] || GOOGLE_VOICE_MAP["en"];
  
  // If customVoiceName looks like a Google voice name (e.g. "vi-VN-Standard-A"), use it
  let voiceName = defaultVoice.name;
  let languageCode = defaultVoice.languageCode;
  if (customVoiceName && customVoiceName.includes("-Standard-")) {
    voiceName = customVoiceName;
    // Extract language code from voice name (e.g. "vi-VN-Standard-A" → "vi-VN")
    const parts = customVoiceName.split("-Standard-");
    if (parts[0]) languageCode = parts[0];
  }

  const resp = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { text },
        voice: {
          languageCode,
          name: voiceName,
        },
        audioConfig: {
          audioEncoding: "MP3",
          sampleRateHertz: 24000,
          speakingRate: 1.0,
          pitch: 0,
        },
      }),
    }
  );

  if (!resp.ok) {
    const errText = await resp.text();
    if (resp.status === 403) {
      throw new Error(
        `Google TTS error 403: API key chưa có quyền dùng Cloud Text-to-Speech hoặc API chưa được bật. Details: ${errText}`
      );
    }
    throw new Error(`Google TTS error ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  if (!data.audioContent) {
    throw new Error("Google TTS: no audioContent in response");
  }

  return Buffer.from(data.audioContent, "base64");
}

async function generateTTS(text, outputPath, targetLang, customVoiceId = null) {
  console.log(`  🔊 Generating TTS with Google Cloud TTS (lang: ${targetLang}, voice: ${GOOGLE_VOICE_MAP[targetLang]?.name || 'en-US-Standard-C'})...`);

  // Split long text into chunks respecting Google's byte limit
  const chunks = splitText(text, GOOGLE_TTS_MAX_BYTES);
  const chunkFiles = [];

  const TTS_CONCURRENCY = 20; // Google TTS allows ~1000 req/min for Standard

  const processChunk = async (i, retries = 5) => {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const chunkPath = outputPath.replace(".mp3", `_chunk${i}.mp3`);
        const audioBuffer = await googleTTSSynthesize(chunks[i], targetLang, customVoiceId);
        fs.writeFileSync(chunkPath, audioBuffer);
        return chunkPath;
      } catch (err) {
        if (attempt < retries && shouldRetryTtsError(err)) {
          const delay = Math.pow(2, attempt) * 500 + Math.random() * 500;
          console.log(`  🔄 Chunk ${i} failed (attempt ${attempt}/${retries}), retrying in ${(delay / 1000).toFixed(1)}s: ${String(err).slice(0, 120)}`);
          await new Promise(r => setTimeout(r, delay));
        } else {
          throw err;
        }
      }
    }
  };

  console.log(`  🚀 Processing ${chunks.length} TTS chunks (concurrency: ${Math.min(TTS_CONCURRENCY, chunks.length)})...`);
  for (let batchStart = 0; batchStart < chunks.length; batchStart += TTS_CONCURRENCY) {
    const batchEnd = Math.min(batchStart + TTS_CONCURRENCY, chunks.length);
    const batchIndices = Array.from({ length: batchEnd - batchStart }, (_, k) => batchStart + k);
    const results = await Promise.all(batchIndices.map(i => processChunk(i)));
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

  console.log("  ✅ Google Cloud TTS success");
}

// Generate TTS for a single segment using Google Cloud TTS
// Handles segments longer than Google's 5000 byte limit by splitting and concatenating
async function generateTTSSegment(text, outputPath, voiceId, targetLang, previousText, nextText) {
  const byteLength = Buffer.byteLength(text, "utf-8");
  if (byteLength <= GOOGLE_TTS_MAX_BYTES) {
    const audioBuffer = await googleTTSSynthesize(text, targetLang, voiceId);
    fs.writeFileSync(outputPath, audioBuffer);
    return;
  }

  // Text exceeds limit — split into sub-chunks
  const subChunks = splitText(text, GOOGLE_TTS_MAX_BYTES);
  console.log(`  ⚠️ Segment too long (${byteLength} bytes), splitting into ${subChunks.length} sub-chunks`);
  const subFiles = [];
  for (let j = 0; j < subChunks.length; j++) {
    const subPath = outputPath.replace(".mp3", `_sub${j}.mp3`);
    const audioBuffer = await googleTTSSynthesize(subChunks[j], targetLang, voiceId);
    fs.writeFileSync(subPath, audioBuffer);
    subFiles.push(subPath);
  }
  if (subFiles.length === 1) {
    fs.renameSync(subFiles[0], outputPath);
  } else {
    const listFile = outputPath.replace(".mp3", "_sublist.txt");
    fs.writeFileSync(listFile, subFiles.map((f) => `file '${f}'`).join("\n"));
    await run(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${outputPath}"`);
    subFiles.forEach((f) => { try { fs.unlinkSync(f); } catch (_) {} });
    try { fs.unlinkSync(listFile); } catch (_) {}
  }
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

async function processVideo(jobId, url, sourceLang, targetLang, callbackUrl, enableSubtitles = false, customVoiceId = null, mode = "translate") {
  const workDir = path.join(__dirname, "jobs", jobId);
  fs.mkdirSync(workDir, { recursive: true });

  const isYouTube = /(?:youtube\.com|youtu\.be)/i.test(url);
  const safeTargetLang = typeof targetLang === "string" && targetLang.trim() ? targetLang.trim() : "en";
  const safeSourceLang = typeof sourceLang === "string" && sourceLang.trim() ? sourceLang.trim() : "auto";
  const ai33ReceiveUrl =
    (typeof process.env.AI33PRO_RECEIVE_URL === "string" && process.env.AI33PRO_RECEIVE_URL.trim()) ||
    (typeof callbackUrl === "string" && callbackUrl.trim()) ||
    "https://example.com/ai33pro-webhook";

  try {
    // Download video (skip if already exists from previous attempt)
    if (fs.existsSync(`${workDir}/video.mp4`) && fs.statSync(`${workDir}/video.mp4`).size > 10000) {
      console.log(`[${jobId}] ♻️ Reusing existing video.mp4`);
      updateJob(jobId, "downloading", 15, "Video already downloaded (cached)");
    } else if (isYouTube) {
      updateJob(jobId, "downloading", 10, "Downloading YouTube video...");
      await run(`yt-dlp -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" --merge-output-format mp4 -o "${workDir}/video.mp4" "${url}"`);
    } else {
      updateJob(jobId, "downloading", 5, "Downloading video from URL...");
      await run(`curl -L -o "${workDir}/video.mp4" --max-filesize 2147483648 --connect-timeout 30 --max-time 3600 "${url}"`);
      updateJob(jobId, "downloading", 15, "Video downloaded");
    }

    var transcript = null;

    // In dubbing mode, AI33PRO handles STT + translation + voice internally
    // We only need transcript for translate mode
    if (mode !== "dubbing") {
      if (isYouTube) {
        updateJob(jobId, "downloading", 5, "Checking YouTube subtitles...");
        const ytSubs = await tryYouTubeSubtitles(workDir, url, sourceLang);
        if (ytSubs) {
          updateJob(jobId, "transcribing", 30, "Using YouTube subtitles (fast mode)");
          transcript = ytSubs;
          console.log(`  ⚡ Skipping STT - using YouTube subtitles (${ytSubs.segments.length} segments)`);
        }
      }

      if (!transcript) {
        updateJob(jobId, "extracting_audio", 20);
        await run(`ffmpeg -y -i "${workDir}/video.mp4" -vn -acodec pcm_s16le -ar 16000 -ac 1 "${workDir}/audio.wav"`);
        updateJob(jobId, "transcribing", 30, "Uploading audio to STT service...");
        transcript = await transcribeAudio(`${workDir}/audio.wav`, jobId);
      }
      fs.writeFileSync(`${workDir}/transcript.json`, JSON.stringify(transcript, null, 2));
    }

    // ── TTS Generation ──
    const isDubbing = mode === "dubbing";
    let translatedText;
    let srtPath = null;

    if (isDubbing) {
      // Dubbing mode: AI33PRO handles translation + voice cloning internally
      // Skip separate translate + TTS steps
      updateJob(jobId, "translating", 55, "Dubbing mode — AI33PRO handles translation & voice...");
    } else {
      // Translate mode: manual translate + Google TTS
      updateJob(jobId, "translating", 50);

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
      fs.writeFileSync(`${workDir}/translated.txt`, translatedText || "");
    }
    
    if (isDubbing) {
      // === DUBBING MODE: Send audio to AI33PRO /v1/task/dubbing ===
      // AI33PRO dubbing accepts audio file (max 20MB / 5min), dubs it with voice cloning
      
      // Extract audio as mp3 for dubbing
      updateJob(jobId, "generating_voice", 68, "Extracting audio for dubbing...");
      const rawAudioPath = `${workDir}/dub_input.mp3`;
      await run(`ffmpeg -y -i "${workDir}/video.mp4" -vn -acodec libmp3lame -ar 44100 -ac 1 -b:a 128k "${rawAudioPath}"`);
      
      let audioDuration = await getMediaDuration(rawAudioPath);
      let audioSize = fs.statSync(rawAudioPath).size;
      const MAX_DUB_DURATION = 270; // 4.5 min safety margin
      const MAX_DUB_SIZE = 18 * 1024 * 1024; // 18MB safety margin
      
      console.log(`  📊 Dubbing input: ${audioDuration.toFixed(1)}s, ${(audioSize / 1024 / 1024).toFixed(1)} MB`);
      
      // Case 2: Duration < 5min but size > 20MB → compress instead of chunking
      if (audioDuration <= MAX_DUB_DURATION && audioSize > MAX_DUB_SIZE) {
        console.log(`  🗜️ Audio under ${MAX_DUB_DURATION}s but ${(audioSize / 1024 / 1024).toFixed(1)}MB > limit. Compressing...`);
        updateJob(jobId, "generating_voice", 69, "Compressing audio for dubbing...");
        const compressedPath = `${workDir}/dub_input_compressed.mp3`;
        // Try 64kbps mono first, if still too big try 48kbps, then 32kbps
        const bitrates = ["64k", "48k", "32k"];
        let compressed = false;
        for (const br of bitrates) {
          await run(`ffmpeg -y -i "${rawAudioPath}" -acodec libmp3lame -ar 22050 -ac 1 -b:a ${br} "${compressedPath}"`);
          const compSize = fs.statSync(compressedPath).size;
          console.log(`    Compressed @${br}: ${(compSize / 1024 / 1024).toFixed(1)} MB`);
          if (compSize <= MAX_DUB_SIZE) {
            compressed = true;
            // Replace raw audio with compressed version
            fs.copyFileSync(compressedPath, rawAudioPath);
            audioSize = compSize;
            break;
          }
        }
        if (!compressed) {
          console.log(`    ⚠️ Compression insufficient, will chunk anyway`);
        }
        // Re-check size after compression
        audioSize = fs.statSync(rawAudioPath).size;
      }
      
      // Determine if we need to chunk
      const needsChunking = audioDuration > MAX_DUB_DURATION || audioSize > MAX_DUB_SIZE;
      const numChunks = needsChunking
        ? Math.max(Math.ceil(audioDuration / MAX_DUB_DURATION), Math.ceil(audioSize / MAX_DUB_SIZE))
        : 1;
      const chunkDuration = Math.floor(audioDuration / numChunks);
      
      if (needsChunking) {
        console.log(`  ✂️ Audio too large for dubbing, splitting into ${numChunks} chunks (~${chunkDuration}s each)...`);
      } else if (audioDuration <= MAX_DUB_DURATION) {
        console.log(`  ✅ Audio fits in single request (${audioDuration.toFixed(1)}s, ${(audioSize / 1024 / 1024).toFixed(1)}MB)`);
      }
      
      const dubbedChunkPaths = new Array(numChunks).fill(null);
      const dubbedSrtSegments = [];
      
      // Get concurrency from job settings
      const dubConcurrency = Math.max(1, Math.min(6, JOBS[jobId]?.dubbingConcurrency || 1));
      console.log(`  🔀 Dubbing concurrency: ${dubConcurrency}`);
      
      // Process a single dubbing chunk
      const processDubChunk = async (ci) => {
        const chunkLabel = `${ci + 1}/${numChunks}`;
        const pctBase = 70 + Math.floor((ci / numChunks) * 18);
        
        const dubbedPath = `${workDir}/dubbed_${ci}.mp3`;
        
        // === RETRY OPTIMIZATION: Skip chunks that already have dubbed output ===
        if (fs.existsSync(dubbedPath)) {
          const existingSize = fs.statSync(dubbedPath).size;
          if (existingSize > 1000) {
            console.log(`  ♻️ Reusing existing dubbed chunk ${chunkLabel} (${(existingSize / 1024).toFixed(0)}KB)`);
            dubbedChunkPaths[ci] = dubbedPath;
            updateJob(jobId, "generating_voice", pctBase + 15, `Chunk ${chunkLabel} cached, skipping...`);
            return;
          }
        }
        
        updateJob(jobId, "generating_voice", pctBase, `Dubbing chunk ${chunkLabel}...`);
        
        let chunkPath = rawAudioPath;
        if (needsChunking) {
          chunkPath = `${workDir}/dub_chunk_${ci}.mp3`;
          const startSec = ci * chunkDuration;
          if (ci === numChunks - 1) {
            await run(`ffmpeg -y -i "${rawAudioPath}" -ss ${startSec} -acodec libmp3lame -ar 44100 -ac 1 -b:a 128k "${chunkPath}"`);
          } else {
            await run(`ffmpeg -y -i "${rawAudioPath}" -ss ${startSec} -t ${chunkDuration} -acodec libmp3lame -ar 44100 -ac 1 -b:a 128k "${chunkPath}"`);
          }
        }
        
        // Upload chunk to AI33PRO dubbing
        const { Blob: BlobClass } = require("buffer");
        const chunkBuffer = fs.readFileSync(chunkPath);
        const chunkBlob = new BlobClass([chunkBuffer], { type: "audio/mp3" });
        
        const dubFormData = new globalThis.FormData();
        dubFormData.append("file", chunkBlob, "audio.mp3");
        dubFormData.append("num_speakers", "0");
        dubFormData.append("disable_voice_cloning", "false");
        dubFormData.append("source_lang", safeSourceLang === "auto" ? "auto" : safeSourceLang);
        dubFormData.append("target_lang", String(safeTargetLang));
        dubFormData.append("receive_url", String(ai33ReceiveUrl));
        
        const dubResp = await ai33proRequest("/v1/task/dubbing", {
          method: "POST",
          body: dubFormData,
        });
        
        if (!dubResp.ok) {
          const errText = await dubResp.text();
          throw new Error(`AI33PRO dubbing error ${dubResp.status}: ${errText}`);
        }
        
        const dubResult = await dubResp.json();
        if (!dubResult.success || !dubResult.task_id) {
          throw new Error(`AI33PRO dubbing rejected: ${JSON.stringify(dubResult)}`);
        }
        
        if (dubResult.ec_remain_credits !== undefined && dubResult.ec_remain_credits <= 0) {
          throw new Error("AI33PRO out of credits");
        }
        
        console.log(`  🎤 Dubbing chunk ${chunkLabel} submitted (task: ${dubResult.task_id})`);
        
        // Poll for result
        const taskResult = await pollAI33ProTask(dubResult.task_id, 7200000, (elapsed) => {
          const secs = Math.round(elapsed / 1000);
          updateJob(jobId, "generating_voice", Math.min(pctBase + 15, 88), `Dubbing chunk ${chunkLabel} (${secs}s)...`);
        });
        
        // Download dubbed audio
        if (!taskResult.metadata?.audio_url) {
          throw new Error(`AI33PRO dubbing chunk ${chunkLabel}: no audio in result`);
        }
        
        const audioResp = await fetch(taskResult.metadata.audio_url);
        const audioArrayBuf = await audioResp.arrayBuffer();
        fs.writeFileSync(dubbedPath, Buffer.from(audioArrayBuf));
        dubbedChunkPaths[ci] = dubbedPath;
        console.log(`  ✅ Dubbing chunk ${chunkLabel} done`);
        
        // Download SRT if available (for subtitles) — stored with index for ordering later
        if (enableSubtitles && taskResult.metadata?.srt_url) {
          try {
            const srtResp = await fetch(taskResult.metadata.srt_url);
            const srtText = await srtResp.text();
            const chunkSegments = parseSrtToSegments(srtText);
            dubbedSrtSegments.push({ ci, segments: chunkSegments });
          } catch (_e) {
            console.log(`  ⚠️ Could not download SRT for chunk ${chunkLabel}`);
          }
        }
        
        // Cleanup chunk input
        if (needsChunking) {
          try { fs.unlinkSync(chunkPath); } catch (_) {}
        }
      };
      
      // Process chunks in batches of dubConcurrency
      for (let batchStart = 0; batchStart < numChunks; batchStart += dubConcurrency) {
        const batchEnd = Math.min(batchStart + dubConcurrency, numChunks);
        const batchIndices = Array.from({ length: batchEnd - batchStart }, (_, k) => batchStart + k);
        updateJob(jobId, "generating_voice", 70 + Math.floor((batchStart / numChunks) * 18),
          `Dubbing chunks ${batchStart + 1}-${batchEnd}/${numChunks} (×${batchIndices.length})...`);
        await Promise.all(batchIndices.map(i => processDubChunk(i)));
      }
      
      // Rebuild SRT with correct time offsets (sequential order)
      if (enableSubtitles && dubbedSrtSegments.length > 0) {
        dubbedSrtSegments.sort((a, b) => a.ci - b.ci);
        let srtTimeOffset = 0;
        const finalSrtSegments = [];
        for (const { ci, segments } of dubbedSrtSegments) {
          const chunkDubbedDuration = await getMediaDuration(dubbedChunkPaths[ci]);
          for (const seg of segments) {
            finalSrtSegments.push({ start: seg.start + srtTimeOffset, end: seg.end + srtTimeOffset, text: seg.text });
          }
          srtTimeOffset += chunkDubbedDuration;
        }
        // Replace dubbedSrtSegments content for downstream use
        dubbedSrtSegments.length = 0;
        dubbedSrtSegments.push(...finalSrtSegments);
      }
      
      // Filter out any null entries (shouldn't happen but safety)
      const validChunkPaths = dubbedChunkPaths.filter(Boolean);
      
      // Merge dubbed audio chunks (AI33PRO may return AAC, so re-encode to mp3)
      if (validChunkPaths.length === 1) {
        // Single chunk: re-encode to ensure mp3 format
        await run(`ffmpeg -y -i "${validChunkPaths[0]}" -acodec libmp3lame -ar 44100 -ac 1 -b:a 128k "${workDir}/tts_audio.mp3"`);
      } else {
        updateJob(jobId, "generating_voice", 89, "Merging dubbed audio chunks...");
        const listFile = `${workDir}/dub_list.txt`;
        fs.writeFileSync(listFile, validChunkPaths.map((f) => `file '${f}'`).join("\n"));
        // Re-encode to mp3 since AI33PRO returns AAC/m4a format
        await run(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -acodec libmp3lame -ar 44100 -ac 1 -b:a 128k "${workDir}/tts_audio.mp3"`);
        try { fs.unlinkSync(listFile); } catch (_) {}
      }
      
      // Cleanup dubbed chunk files
      validChunkPaths.forEach((f) => { try { fs.unlinkSync(f); } catch (_) {} });
      try { fs.unlinkSync(rawAudioPath); } catch (_) {}
      
      console.log(`  ✅ AI33PRO dubbing complete (${numChunks} chunks)`);
      
      // Write SRT from dubbing result if subtitles enabled
      if (enableSubtitles && dubbedSrtSegments.length > 0) {
        srtPath = `${workDir}/subtitles.srt`;
        let srtContent = "";
        for (let i = 0; i < dubbedSrtSegments.length; i++) {
          const seg = dubbedSrtSegments[i];
          srtContent += `${i + 1}\n${secondsToSrtTime(seg.start)} --> ${secondsToSrtTime(seg.end)}\n${seg.text}\n\n`;
        }
        fs.writeFileSync(srtPath, srtContent, "utf-8");
        console.log(`  📄 Dubbing SRT: ${dubbedSrtSegments.length} segments`);
      }
    } else if (enableSubtitles && srtPath && transcript.segments && transcript.segments.length > 0) {
      // === Per-segment TTS: generate audio for each subtitle segment individually ===
      updateJob(jobId, "generating_voice", 70, "Generating voice per segment...");
      const translatedSegments = parseSrtToSegments(fs.readFileSync(srtPath, "utf-8"));
      const voiceId = customVoiceId || GOOGLE_VOICE_MAP[targetLang]?.name || GOOGLE_VOICE_MAP.en.name;
      const segAudioFiles = [];
      let currentTime = 0;
      let newSrt = "";

      const SEG_TTS_CONCURRENCY = 5; // Reduced to avoid 429 rate limits
      const segDurations = new Array(translatedSegments.length);
      const segPaths = translatedSegments.map((_, i) => `${workDir}/seg_${i}.mp3`);

      // Process segment TTS with retry + exponential backoff + jitter
      const processSegTTS = async (i, retries = 5) => {
        for (let attempt = 1; attempt <= retries; attempt++) {
          try {
            const prevText = i > 0 ? translatedSegments[i - 1].text : null;
            const nextTextCtx = i < translatedSegments.length - 1 ? translatedSegments[i + 1].text : null;
            await generateTTSSegment(translatedSegments[i].text, segPaths[i], voiceId, targetLang, prevText, nextTextCtx);
            segDurations[i] = await getMediaDuration(segPaths[i]);
            console.log(`  🎙️ Seg ${i + 1}/${translatedSegments.length}: "${translatedSegments[i].text.substring(0, 30)}..." → ${segDurations[i].toFixed(2)}s`);
            return;
          } catch (err) {
            const msg = String(err);
            if (attempt < retries && shouldRetryTtsError(err)) {
              const delay = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
              console.log(`  🔄 Seg ${i + 1} failed (attempt ${attempt}/${retries}), retrying in ${(delay / 1000).toFixed(1)}s: ${msg.slice(0, 120)}`);
              await new Promise(r => setTimeout(r, delay));
            } else {
              throw err;
            }
          }
        }
      };

      // Parallel batches of SEG_TTS_CONCURRENCY
      console.log(`  🚀 Processing ${translatedSegments.length} TTS segments (concurrency: ${Math.min(SEG_TTS_CONCURRENCY, translatedSegments.length)})...`);
      const failedSegs = [];
      for (let batchStart = 0; batchStart < translatedSegments.length; batchStart += SEG_TTS_CONCURRENCY) {
        const batchEnd = Math.min(batchStart + SEG_TTS_CONCURRENCY, translatedSegments.length);
        updateJob(jobId, "generating_voice", 70 + Math.floor((batchStart / translatedSegments.length) * 15),
          `TTS segments ${batchStart + 1}-${batchEnd}/${translatedSegments.length}...`);
        const batchIndices = Array.from({ length: batchEnd - batchStart }, (_, k) => batchStart + k);
        const results = await Promise.allSettled(batchIndices.map(i => processSegTTS(i)));
        for (let k = 0; k < results.length; k++) {
          if (results[k].status === "rejected") {
            const segIdx = batchIndices[k];
            console.error(`  ❌ Seg ${segIdx + 1} FAILED permanently: ${results[k].reason}`);
            failedSegs.push(segIdx);
          }
        }
      }

      if (failedSegs.length > 0) {
        throw new Error(`TTS failed for ${failedSegs.length} segments: [${failedSegs.map(i => i + 1).join(", ")}]. Vui lòng kiểm tra GOOGLE_TTS_API_KEY, API Cloud Text-to-Speech đã bật, và API restrictions của key.`);
      }

      // Verify all segment files exist before proceeding
      const missingFiles = segPaths.filter((f, i) => !fs.existsSync(f));
      if (missingFiles.length > 0) {
        throw new Error(`TTS completed but ${missingFiles.length} audio files are missing. Google TTS API có thể chưa được bật hoặc API key không hợp lệ.`);
      }

      // Build SRT and audio list sequentially from results
      for (let i = 0; i < translatedSegments.length; i++) {
        const segStart = currentTime;
        const segEnd = currentTime + segDurations[i];
        newSrt += `${i + 1}\n${secondsToSrtTime(segStart)} --> ${secondsToSrtTime(segEnd)}\n${translatedSegments[i].text}\n\n`;
        segAudioFiles.push(segPaths[i]);
        currentTime = segEnd;
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
      // Subtitle style: orange background box, white bold text
      await run(`ffmpeg -y -i "${workDir}/video.mp4" -i "${workDir}/tts_audio.mp3" -vf "subtitles='${absSrtPath}':force_style='FontName=Noto Sans CJK SC,FontSize=22,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H000080FF,BackColour=&H80000000,BorderStyle=3,Outline=4,Shadow=0,MarginV=25,MarginL=30,MarginR=30,Alignment=2'" -c:v libx264 -preset fast -crf 23 -map 0:v:0 -map 1:a:0 -shortest "${workDir}/output.mp4"`);
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

function splitText(text, maxBytes) {
  const chunks = [];
  let remaining = text;
  while (Buffer.byteLength(remaining, "utf-8") > maxBytes) {
    // Find a split point that keeps the chunk under maxBytes
    let splitAt = -1;
    // Try splitting at sentence boundaries first
    for (let i = Math.min(remaining.length, maxBytes); i > 0; i--) {
      if (remaining[i] === "." || remaining[i] === "。" || remaining[i] === "!" || remaining[i] === "?" || remaining[i] === "\n") {
        const candidate = remaining.substring(0, i + 1);
        if (Buffer.byteLength(candidate, "utf-8") <= maxBytes) {
          splitAt = i + 1;
          break;
        }
      }
    }
    // Fallback: binary search for max chars that fit in maxBytes
    if (splitAt === -1) {
      let lo = 1, hi = Math.min(remaining.length, maxBytes);
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (Buffer.byteLength(remaining.substring(0, mid), "utf-8") <= maxBytes) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      splitAt = lo;
    }
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
