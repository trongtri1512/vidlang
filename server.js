const express = require("express");
const cors = require("cors");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(cors());
app.use(express.json());

const API_SECRET = process.env.API_SECRET || "change-me";
const AI33PRO_API_KEY = process.env.AI33PRO_API_KEY || "";
const AI33PRO_BASE_URL = "https://api.ai33.pro";
const DEFAULT_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "pFZP5JQG7iQjIQuC4Bku";

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
  const { youtubeUrl, targetLang = "en", sourceLang = "auto", voiceId, callbackUrl } = req.body;
  if (!youtubeUrl) return res.status(400).json({ error: "youtubeUrl required" });

  const jobId = uuidv4();
  JOBS[jobId] = { status: "queued", progress: 0, createdAt: new Date().toISOString() };
  res.json({ jobId, status: "accepted" });

  processVideo(jobId, youtubeUrl, sourceLang, targetLang, voiceId || DEFAULT_VOICE_ID, callbackUrl);
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

async function pollAI33ProTask(taskId, maxWaitMs = 600000, onProgress = null) {
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

  const taskResult = await pollAI33ProTask(result.task_id, 300000, (elapsed) => {
    if (jobId) {
      const secs = Math.round(elapsed / 1000);
      updateJob(jobId, "transcribing", Math.min(45, 40 + Math.floor(secs / 6)), `Processing speech recognition (${secs}s)...`);
    }
  });

  if (jobId) updateJob(jobId, "transcribing", 48, "Downloading transcript...");

  if (taskResult.metadata?.json_url) {
    const jsonResp = await fetch(taskResult.metadata.json_url);
    const jsonData = await jsonResp.json();
    console.log("  ✅ AI33PRO STT success");
    if (jobId) updateJob(jobId, "transcribing", 50, "Transcript ready!");
    return { text: jsonData.text || extractTextFromJson(jsonData), language: jsonData.language || "auto" };
  }

  if (taskResult.metadata?.srt_url) {
    const srtResp = await fetch(taskResult.metadata.srt_url);
    const srtText = await srtResp.text();
    console.log("  ✅ AI33PRO STT success (SRT)");
    if (jobId) updateJob(jobId, "transcribing", 50, "Transcript ready!");
    return { text: parseSrtToText(srtText), language: "auto" };
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

// ── TTS: AI33PRO only ──

async function generateTTS(text, outputPath, targetLang, voiceId) {
  if (!AI33PRO_API_KEY) {
    throw new Error("AI33PRO_API_KEY is not configured");
  }

  console.log(`  🔊 Generating TTS with AI33PRO (voice: ${voiceId})...`);
  const vid = voiceId || DEFAULT_VOICE_ID;

  // Split long text into chunks
  const chunks = splitText(text, 4500);
  const chunkFiles = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunkPath = outputPath.replace(".mp3", `_chunk${i}.mp3`);

    const resp = await ai33proRequest(`/v1/text-to-speech/${vid}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: chunks[i],
        model_id: "eleven_multilingual_v2",
      }),
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

    const taskResult = await pollAI33ProTask(result.task_id);

    if (!taskResult.metadata?.audio_url) {
      throw new Error("AI33PRO TTS: no audio_url in result");
    }

    const audioResp = await fetch(taskResult.metadata.audio_url);
    if (!audioResp.ok) throw new Error(`Failed to download AI33PRO audio: ${audioResp.status}`);

    const buffer = Buffer.from(await audioResp.arrayBuffer());
    fs.writeFileSync(chunkPath, buffer);
    chunkFiles.push(chunkPath);
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

// ── Translation ──

async function translateText(text, sourceLang, targetLang) {
  try {
    const sl = sourceLang === "auto" ? "auto" : sourceLang;
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;
    const resp = await fetch(url);
    const data = await resp.json();
    return data[0].map((s) => s[0]).join("");
  } catch (err) {
    console.warn("Translation fallback: returning original text. Error:", err.message);
    return text;
  }
}

// ── Processing pipeline ──

async function processVideo(jobId, url, sourceLang, targetLang, voiceId, callbackUrl) {
  const workDir = path.join(__dirname, "jobs", jobId);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    updateJob(jobId, "downloading", 10);
    await run(`yt-dlp --extractor-args "youtube:player_client=ios,web_creator" -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" --merge-output-format mp4 -o "${workDir}/video.mp4" "${url}"`);

    updateJob(jobId, "extracting_audio", 20);
    await run(`ffmpeg -y -i "${workDir}/video.mp4" -vn -acodec pcm_s16le -ar 16000 -ac 1 "${workDir}/audio.wav"`);

    updateJob(jobId, "transcribing", 30, "Uploading audio to STT service...");
    const transcript = await transcribeAudio(`${workDir}/audio.wav`, jobId);
    fs.writeFileSync(`${workDir}/transcript.json`, JSON.stringify(transcript, null, 2));

    updateJob(jobId, "translating", 50);
    const translatedText = await translateText(transcript.text, sourceLang, targetLang);
    fs.writeFileSync(`${workDir}/translated.txt`, translatedText);

    updateJob(jobId, "generating_voice", 70);
    await generateTTS(translatedText, `${workDir}/tts_audio.mp3`, targetLang, voiceId);

    updateJob(jobId, "merging", 90);
    await run(`ffmpeg -y -i "${workDir}/video.mp4" -i "${workDir}/tts_audio.mp3" -c:v copy -map 0:v:0 -map 1:a:0 -shortest "${workDir}/output.mp4"`);

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
