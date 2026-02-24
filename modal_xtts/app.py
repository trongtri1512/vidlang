"""
Modal.com endpoint for XTTS v2 voice cloning.
Deploy with: modal deploy app.py
"""
import modal
import io
import base64

app = modal.App("vidlang-xtts")

# Build image with XTTS v2 dependencies
xtts_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "libsndfile1")
    .pip_install(
        "TTS==0.22.0",
        "torch==2.1.2",
        "torchaudio==2.1.2",
        "numpy<2",
        "scipy",
        "pydub",
    )
    .run_commands(
        # Pre-download XTTS v2 model on build
        "python3 -c \"from TTS.api import TTS; TTS('tts_models/multilingual/multi-dataset/xtts_v2')\""
    )
)


@app.function(
    image=xtts_image,
    gpu="T4",  # Cheapest GPU, enough for XTTS v2
    timeout=300,
    memory=8192,
    secrets=[modal.Secret.from_name("vidlang-api-secret")],
)
@modal.web_endpoint(method="POST")
def synthesize(item: dict):
    """
    Voice cloning TTS endpoint.
    
    Request body:
    {
        "text": "Text to synthesize",
        "speaker_audio_base64": "base64-encoded reference audio (6+ seconds)",
        "language": "vi",  # Target language code
    }
    
    Returns:
    {
        "audio_base64": "base64-encoded WAV audio",
        "duration": 3.5
    }
    """
    import os
    import tempfile
    from TTS.api import TTS
    from pydub import AudioSegment

    # Verify API secret
    api_secret = os.environ.get("API_SECRET", "")
    req_secret = item.get("api_secret", "")
    if api_secret and req_secret != api_secret:
        return {"error": "Unauthorized"}, 401

    text = item.get("text", "")
    speaker_audio_b64 = item.get("speaker_audio_base64", "")
    language = item.get("language", "en")

    if not text:
        return {"error": "text is required"}
    if not speaker_audio_b64:
        return {"error": "speaker_audio_base64 is required"}

    # Map language codes to XTTS supported codes
    lang_map = {
        "vi": "vi",
        "en": "en",
        "zh": "zh-cn",
        "ja": "ja",
        "ko": "ko",
        "fr": "fr",
        "es": "es",
        "de": "de",
        "it": "it",
        "pt": "pt",
        "pl": "pl",
        "tr": "tr",
        "ru": "ru",
        "nl": "nl",
        "cs": "cs",
        "ar": "ar",
        "hu": "hu",
        "hi": "hi",
    }
    xtts_lang = lang_map.get(language, "en")

    with tempfile.TemporaryDirectory() as tmpdir:
        # Save reference audio
        ref_path = os.path.join(tmpdir, "reference.wav")
        ref_bytes = base64.b64decode(speaker_audio_b64)
        with open(ref_path, "wb") as f:
            f.write(ref_bytes)

        # Ensure reference audio is proper WAV format
        try:
            ref_audio = AudioSegment.from_file(ref_path)
            ref_audio = ref_audio.set_frame_rate(22050).set_channels(1)
            ref_path_clean = os.path.join(tmpdir, "reference_clean.wav")
            ref_audio.export(ref_path_clean, format="wav")
            ref_path = ref_path_clean
        except Exception as e:
            print(f"Warning: Could not process reference audio: {e}")

        # Initialize XTTS v2
        tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2")
        tts.to("cuda")

        # Generate speech with voice cloning
        out_path = os.path.join(tmpdir, "output.wav")
        tts.tts_to_file(
            text=text,
            file_path=out_path,
            speaker_wav=ref_path,
            language=xtts_lang,
        )

        # Read output and calculate duration
        output_audio = AudioSegment.from_wav(out_path)
        duration = len(output_audio) / 1000.0  # in seconds

        with open(out_path, "rb") as f:
            audio_bytes = f.read()

        return {
            "audio_base64": base64.b64encode(audio_bytes).decode("utf-8"),
            "duration": duration,
        }


@app.function(
    image=xtts_image,
    gpu="T4",
    timeout=600,
    memory=8192,
    secrets=[modal.Secret.from_name("vidlang-api-secret")],
)
@modal.web_endpoint(method="POST")
def synthesize_batch(item: dict):
    """
    Batch voice cloning - process multiple text segments at once.
    
    Request body:
    {
        "segments": [{"text": "...", "index": 0}, ...],
        "speaker_audio_base64": "base64-encoded reference audio",
        "language": "vi",
    }
    
    Returns:
    {
        "results": [{"index": 0, "audio_base64": "...", "duration": 3.5}, ...]
    }
    """
    import os
    import tempfile
    from TTS.api import TTS
    from pydub import AudioSegment

    api_secret = os.environ.get("API_SECRET", "")
    req_secret = item.get("api_secret", "")
    if api_secret and req_secret != api_secret:
        return {"error": "Unauthorized"}, 401

    segments = item.get("segments", [])
    speaker_audio_b64 = item.get("speaker_audio_base64", "")
    language = item.get("language", "en")

    if not segments:
        return {"error": "segments is required"}
    if not speaker_audio_b64:
        return {"error": "speaker_audio_base64 is required"}

    lang_map = {
        "vi": "vi", "en": "en", "zh": "zh-cn", "ja": "ja", "ko": "ko",
        "fr": "fr", "es": "es", "de": "de", "it": "it", "pt": "pt",
        "pl": "pl", "tr": "tr", "ru": "ru", "nl": "nl", "cs": "cs",
        "ar": "ar", "hu": "hu", "hi": "hi",
    }
    xtts_lang = lang_map.get(language, "en")

    with tempfile.TemporaryDirectory() as tmpdir:
        ref_path = os.path.join(tmpdir, "reference.wav")
        ref_bytes = base64.b64decode(speaker_audio_b64)
        with open(ref_path, "wb") as f:
            f.write(ref_bytes)

        try:
            ref_audio = AudioSegment.from_file(ref_path)
            ref_audio = ref_audio.set_frame_rate(22050).set_channels(1)
            ref_path_clean = os.path.join(tmpdir, "reference_clean.wav")
            ref_audio.export(ref_path_clean, format="wav")
            ref_path = ref_path_clean
        except Exception:
            pass

        tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2")
        tts.to("cuda")

        results = []
        for seg in segments:
            text = seg.get("text", "")
            idx = seg.get("index", 0)
            if not text.strip():
                results.append({"index": idx, "audio_base64": "", "duration": 0})
                continue

            out_path = os.path.join(tmpdir, f"out_{idx}.wav")
            try:
                tts.tts_to_file(
                    text=text,
                    file_path=out_path,
                    speaker_wav=ref_path,
                    language=xtts_lang,
                )
                output_audio = AudioSegment.from_wav(out_path)
                duration = len(output_audio) / 1000.0
                with open(out_path, "rb") as f:
                    audio_bytes = f.read()
                results.append({
                    "index": idx,
                    "audio_base64": base64.b64encode(audio_bytes).decode("utf-8"),
                    "duration": duration,
                })
            except Exception as e:
                print(f"Error on segment {idx}: {e}")
                results.append({"index": idx, "error": str(e), "duration": 0})

        return {"results": results}