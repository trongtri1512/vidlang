const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const API_SECRET = process.env.API_SECRET || 'change-me';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';
const PORT = process.env.PORT || 3000;

// Simple auth middleware
function auth(req, res, next) {
  const token = req.headers['x-api-key'];
  if (token !== API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// In-memory job store
const JOBS = {};

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Submit a new job
app.post('/api/process', auth, async (req, res) => {
  const { youtubeUrl, targetLang = 'en', callbackUrl } = req.body;

  if (!youtubeUrl) {
    return res.status(400).json({ error: 'youtubeUrl is required' });
  }

  const jobId = uuidv4();
  JOBS[jobId] = {
    id: jobId,
    status: 'queued',
    youtubeUrl,
    targetLang,
    createdAt: new Date().toISOString(),
    steps: [],
    error: null,
    outputUrl: null,
  };

  res.json({ jobId, status: 'queued' });

  // Process in background
  processVideo(jobId, youtubeUrl, targetLang, callbackUrl);
});

// Get job status
app.get('/api/status/:jobId', auth, (req, res) => {
  const job = JOBS[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// List all jobs
app.get('/api/jobs', auth, (req, res) => {
  const jobs = Object.values(JOBS).sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );
  res.json(jobs);
});

// Cancel a job
app.delete('/api/jobs/:jobId', auth, (req, res) => {
  const job = JOBS[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  job.status = 'cancelled';
  res.json({ jobId: req.params.jobId, status: 'cancelled' });
});

// Serve output files
app.use('/output', express.static(path.join(__dirname, 'output')));

// ── Processing Pipeline ──

async function processVideo(jobId, url, targetLang, callbackUrl) {
  const workDir = path.join(__dirname, 'jobs', jobId);
  fs.mkdirSync(workDir, { recursive: true });

  const updateStatus = (status, stepName) => {
    JOBS[jobId].status = status;
    JOBS[jobId].steps.push({
      name: stepName,
      startedAt: new Date().toISOString(),
    });
    console.log(`[${jobId}] ${status}: ${stepName}`);
  };

  try {
    // Step 1: Download video
    updateStatus('downloading', 'Download video from YouTube');
    await run(
      `yt-dlp -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" ` +
      `--merge-output-format mp4 ` +
      `-o "${workDir}/video.mp4" "${url}"`
    );

    // Step 2: Extract audio
    updateStatus('extracting_audio', 'Extract audio track');
    await run(
      `ffmpeg -i "${workDir}/video.mp4" -vn -acodec pcm_s16le -ar 16000 -ac 1 "${workDir}/audio.wav" -y`
    );

    // Step 3: Speech-to-Text (ElevenLabs Scribe)
    updateStatus('transcribing', 'Speech recognition (auto-detect language)');
    const transcript = await speechToText(workDir);
    fs.writeFileSync(`${workDir}/transcript.json`, JSON.stringify(transcript, null, 2));

    // Step 4: Translate to target language
    updateStatus('translating', `Translate to ${targetLang}`);
    const translatedText = await translateText(transcript.text, targetLang);
    fs.writeFileSync(`${workDir}/translated.txt`, translatedText);

    // Step 5: Text-to-Speech
    updateStatus('generating_voice', 'Generate English voiceover');
    await textToSpeech(translatedText, `${workDir}/tts_audio.mp3`);

    // Step 6: Merge video + new audio
    updateStatus('merging', 'Replace original audio with English');
    await run(
      `ffmpeg -i "${workDir}/video.mp4" -i "${workDir}/tts_audio.mp3" ` +
      `-c:v copy -map 0:v:0 -map 1:a:0 -shortest "${workDir}/output.mp4" -y`
    );

    // Step 7: Move to output
    const outputFile = `${jobId}.mp4`;
    fs.copyFileSync(`${workDir}/output.mp4`, path.join(__dirname, 'output', outputFile));

    JOBS[jobId].status = 'done';
    JOBS[jobId].outputUrl = `/output/${outputFile}`;
    console.log(`[${jobId}] ✅ Done!`);

    // Callback
    if (callbackUrl) {
      notifyCallback(callbackUrl, jobId, 'done', `/output/${outputFile}`);
    }
  } catch (err) {
    console.error(`[${jobId}] ❌ Error:`, err.message);
    JOBS[jobId].status = 'error';
    JOBS[jobId].error = err.message;

    if (callbackUrl) {
      notifyCallback(callbackUrl, jobId, 'error', null, err.message);
    }
  }
}

// ── Helper Functions ──

async function speechToText(workDir) {
  if (!ELEVENLABS_API_KEY) {
    // Fallback: return placeholder if no API key
    console.warn('No ELEVENLABS_API_KEY set, using placeholder transcript');
    return { text: 'Transcript placeholder - set ELEVENLABS_API_KEY for real STT' };
  }

  const audioFile = fs.readFileSync(`${workDir}/audio.wav`);
  const formData = new FormData();
  formData.append('file', new Blob([audioFile]), 'audio.wav');
  formData.append('model_id', 'scribe_v2');
  formData.append('tag_audio_events', 'false');
  formData.append('diarize', 'false');

  const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': ELEVENLABS_API_KEY },
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`ElevenLabs STT failed: ${response.status} ${await response.text()}`);
  }

  return response.json();
}

async function translateText(text, targetLang) {
  // TODO: Integrate with your preferred translation API
  // Options: Google Translate API, DeepL, or Lovable AI
  // For now, returns original text as placeholder
  console.warn('Translation not configured - returning original text');
  return text;
}

async function textToSpeech(text, outputPath) {
  if (!ELEVENLABS_API_KEY) {
    console.warn('No ELEVENLABS_API_KEY set, skipping TTS');
    // Create silent audio as fallback
    await run(`ffmpeg -f lavfi -i anullsrc=r=44100:cl=mono -t 5 "${outputPath}" -y`);
    return;
  }

  const voiceId = 'JBFqnCBsd6RMkjVDRZzb'; // George - clear English voice
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.6,
          similarity_boost: 0.75,
          speed: 1.0,
        },
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`ElevenLabs TTS failed: ${response.status} ${await response.text()}`);
  }

  const buffer = await response.arrayBuffer();
  fs.writeFileSync(outputPath, Buffer.from(buffer));
}

function notifyCallback(url, jobId, status, outputUrl, error) {
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId, status, outputUrl, error }),
  }).catch((err) => console.error('Callback failed:', err.message));
}

function run(cmd) {
  return new Promise((resolve, reject) => {
    console.log(`> ${cmd}`);
    exec(cmd, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

app.listen(PORT, () => {
  console.log(`🚀 VidLang API running on port ${PORT}`);
  console.log(`   ElevenLabs: ${ELEVENLABS_API_KEY ? '✅ configured' : '⚠️ not set'}`);
});
