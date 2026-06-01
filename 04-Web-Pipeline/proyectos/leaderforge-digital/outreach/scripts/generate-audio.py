"""
Generate personalized audio via ElevenLabs API.

Creates a short voice message for each lead's demo page.
Uses a predefined male Mexican voice. Script is auto-generated
with subtle sarcasm and urgency.

Usage:
    python scripts/generate-audio.py --input data/leads-welders-ca.csv
    python scripts/generate-audio.py --input data/leads-welders-ca.csv --count 5
    python scripts/generate-audio.py --input data/leads-welders-ca.csv --voice-id VOICE_ID

Requirements:
    ELEVENLABS_API_KEY in .env
"""

import os
import sys
import csv
import argparse
import time
from pathlib import Path
from datetime import datetime

import requests
from dotenv import load_dotenv

load_dotenv()

ELEVENLABS_KEY = os.getenv("ELEVENLABS_API_KEY", "")
ELEVENLABS_VOICE = os.getenv("ELEVENLABS_VOICE_ID", "pNInz6obpgDQGcFmaJgB")  # Adam — deep male
AUDIO_DIR = Path("audio")
LOG_PATH = Path("data/audio-generations.csv")

# Voice settings
VOICE_SETTINGS = {
    "stability": 0.45,
    "similarity_boost": 0.72,
    "style": 0.30,
    "use_speaker_boost": True,
}


def generate_script(lead: dict, lang: str = "en") -> str:
    """Generate personalized pitch script with light sarcasm edge."""
    name = lead.get("business_name", "your shop")
    first = name.split()[0] if name else "there"
    city = lead.get("city", "your area").replace(" CA", "").replace(" ca", "")
    trade = lead.get("website_quality", "welding") or "welding"

    if lang == "es":
        return (
            f"Hola {first}, soy Daniel. Te arme este demo para que veas como se veria "
            f"{name} en internet — pagina profesional, redes sociales, todo desde tu celular. "
            f"No es la version final, solo un punto de partida. "
            f"Si te gusta el rumbo, llamame al (858) 465-8919. Hablamos pronto."
        )
    else:
        return (
            f"Hey {first}, Daniel here. I put this demo together so you can see "
            f"what {name} could look like online — a professional website, social media, "
            f"everything you control from your phone. Not the final version, just a starting point. "
            f"If you like the direction, call me at (858) 465-8919. Talk soon."
        )


def generate_audio(text: str, output_path: Path) -> bool:
    """Call ElevenLabs TTS API and save MP3."""
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE}"

    headers = {
        "xi-api-key": ELEVENLABS_KEY,
        "Content-Type": "application/json",
    }

    payload = {
        "text": text,
        "model_id": "eleven_multilingual_v2",
        "voice_settings": VOICE_SETTINGS,
    }

    try:
        resp = requests.post(url, headers=headers, json=payload, timeout=30)
        if resp.status_code == 200:
            output_path.write_bytes(resp.content)
            return True
        else:
            print(f"    ElevenLabs error {resp.status_code}: {resp.text[:200]}")
            return False
    except Exception as e:
        print(f"    Request error: {e}")
        return False


def log_generation(lead: dict, audio_path: str, lang: str):
    """Log to CSV."""
    new_file = not LOG_PATH.exists()
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(LOG_PATH, "a", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        if new_file:
            writer.writerow(["business_name", "city", "audio_path", "lang", "generated_at"])
        writer.writerow([
            lead.get("business_name", ""),
            lead.get("city", ""),
            audio_path,
            lang,
            datetime.now().isoformat(),
        ])


def main():
    parser = argparse.ArgumentParser(description="Generate audio via ElevenLabs")
    parser.add_argument("--input", default="data/lead-queue.csv")
    parser.add_argument("--start", type=int, default=0)
    parser.add_argument("--count", type=int, default=0)
    parser.add_argument("--lang", choices=["en", "es"], default="en")
    parser.add_argument("--voice-id", help="Override default voice ID")
    args = parser.parse_args()

    if not ELEVENLABS_KEY:
        print("ERROR: ELEVENLABS_API_KEY not set in .env")
        sys.exit(1)

    if args.voice_id:
        global ELEVENLABS_VOICE
        ELEVENLABS_VOICE = args.voice_id

    input_path = Path(args.input)
    if not input_path.exists():
        print(f"ERROR: {input_path} not found.")
        sys.exit(1)

    with open(input_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        leads = list(reader)

    target = leads[args.start:]
    if args.count > 0:
        target = target[:args.count]

    AUDIO_DIR.mkdir(parents=True, exist_ok=True)

    print(f"ElevenLabs Audio Generator")
    print(f"  Voice: {ELEVENLABS_VOICE}")
    print(f"  Language: {args.lang}")
    print(f"  Leads: {len(target)}\n")

    generated = 0
    for i, lead in enumerate(target):
        name = lead.get("business_name", "Unknown")
        slug = name.lower().strip().replace(" ", "-").replace("'", "")[:40]
        audio_path = AUDIO_DIR / f"{slug}.mp3"

        print(f"[{i + 1}/{len(target)}] {name}")

        script = generate_script(lead, args.lang)
        print(f"  Script: {script[:100]}...")

        success = generate_audio(script, audio_path)
        if success:
            log_generation(lead, str(audio_path), args.lang)
            print(f"  -> {audio_path}")
            generated += 1
        else:
            print(f"  FAILED")

        time.sleep(1.5)  # Rate limit

    print(f"\n{'='*60}")
    print(f"Generated: {generated}/{len(target)}")
    print(f"Audio dir: {AUDIO_DIR}")


if __name__ == "__main__":
    main()
