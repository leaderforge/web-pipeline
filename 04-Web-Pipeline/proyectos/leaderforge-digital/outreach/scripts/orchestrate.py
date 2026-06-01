"""
Orchestrate the full deploy pipeline: audio -> build -> deploy -> screenshot -> update CSVs.

Usage:
    cd outreach
    python scripts/orchestrate.py --count 5
    python scripts/orchestrate.py --count 5 --mode email   # Email leads only
    python scripts/orchestrate.py --count 5 --mode phone   # Phone-only only
    python scripts/orchestrate.py --count 5 --mode all     # Both (default)
    python scripts/orchestrate.py --dry-run

Requirements:
    ELEVENLABS_API_KEY in .env
    NETLIFY_ACCOUNT_SLUG in .env
    npm i -g netlify-cli
    pip install playwright
"""
import csv
import os
import re
import sys
import time
import shutil
import tempfile
import argparse
import subprocess
import urllib.parse
from pathlib import Path
from datetime import datetime

import requests
from dotenv import load_dotenv

load_dotenv()

ROOT = Path.cwd()
LEAD_CSV = ROOT / "data" / "lead-queue.csv"
DEPLOY_LOG = ROOT / "data" / "demo-deploys-20.csv"
TEMPLATE_DIR = ROOT / "demo-template"
AUDIO_DIR = ROOT / "audio"
SCREENSHOT_DIR = ROOT / "screenshots"

ELEVENLABS_KEY = os.getenv("ELEVENLABS_API_KEY", "")
ELEVENLABS_VOICE = os.getenv("ELEVENLABS_VOICE_ID", "pNInz6obpgDQGcFmaJgB")
NETLIFY_ACCOUNT = os.getenv("NETLIFY_ACCOUNT_SLUG", "")

VIEWPORT = {"width": 1280, "height": 800}


def slugify(name: str) -> str:
    return name.lower().strip().replace(" & ", " ").replace(" ", "-").replace("'", "").replace(".", "").replace("&", "")[:40]


# ─── Audio ───────────────────────────────────────────────────────────────

def generate_script(lead: dict, lang: str = "en") -> str:
    name = lead.get("business_name", "your shop")
    first = name.split()[0] if name else "there"
    city = lead.get("city", "your area").replace(" CA", "").replace(" ca", "")
    if lang == "es":
        return (
            f"Hola {first}, soy Daniel. Te arme este demo para que veas como se veria "
            f"{name} en internet — pagina profesional, todo desde tu celular. "
            f"No es la version final, solo un punto de partida. "
            f"Si te gusta el rumbo, llamame al (858) 465-8919. Hablamos pronto."
        )
    else:
        return (
            f"Hey {first}, Daniel here. I put this demo together so you can see "
            f"what {name} could look like online — a professional website, "
            f"everything you control from your phone. Not the final version, just a starting point. "
            f"If you like the direction, call me at 8584658919 "
            f"or send me an email to daniel@leaderforgeai.com. Talk to you soon."
        )


def generate_audio(text: str, output_path: Path) -> bool:
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE}"
    headers = {"xi-api-key": ELEVENLABS_KEY, "Content-Type": "application/json"}
    payload = {
        "text": text,
        "model_id": "eleven_multilingual_v2",
        "voice_settings": {"stability": 0.45, "similarity_boost": 0.72, "style": 0.30, "use_speaker_boost": True},
    }
    try:
        resp = requests.post(url, headers=headers, json=payload, timeout=30)
        if resp.status_code == 200:
            output_path.write_bytes(resp.content)
            return True
        print(f"  ElevenLabs error {resp.status_code}: {resp.text[:150]}")
        return False
    except Exception as e:
        print(f"  Audio request error: {e}")
        return False


# ─── Build ────────────────────────────────────────────────────────────────

def build_demo(lead: dict, audio_path: Path | None = None) -> Path:
    name = lead.get("business_name", "Your Business")
    city = lead.get("city", "your area")
    phone = lead.get("phone", "").strip()
    lead_id = lead.get("lead_id", slugify(name))
    if not phone:
        phone = "(858) 465-8919"
    city_clean = city.replace(" CA", "").replace(" ca", "")

    template_html = (TEMPLATE_DIR / "index.html").read_text(encoding="utf-8")

    audio_url = "./audio.mp3" if (audio_path and audio_path.exists()) else ""

    html = template_html
    html = html.replace("{{BUSINESS_NAME}}", name)
    html = html.replace("{{BUSINESS_NAME_SHORT}}", name.split()[0] if name else "Business")
    html = html.replace("{{BUSINESS_NAME_ENCODED}}", urllib.parse.quote(name))
    html = html.replace("{{TRADE}}", "Welding")
    html = html.replace("{{CITY}}", city_clean)
    html = html.replace("{{CITY_ENCODED}}", urllib.parse.quote(city_clean))
    html = html.replace("{{PHONE}}", re.sub(r'\D', '', phone))
    html = html.replace("{{PHONE_DISPLAY}}", phone)
    html = html.replace("{{LEAD_ID}}", lead_id)
    html = html.replace("{{AUDIO_URL}}", audio_url)

    build_dir = Path(tempfile.mkdtemp(prefix="demo-"))
    (build_dir / "index.html").write_text(html, encoding="utf-8")

    if audio_path and audio_path.exists():
        shutil.copy2(audio_path, build_dir / "audio.mp3")
        print(f"  Audio: bundled ({audio_path.name})")

    # Copy static assets from template
    for asset in TEMPLATE_DIR.glob("*"):
        if asset.is_file() and asset.name != "index.html":
            shutil.copy2(asset, build_dir / asset.name)

    return build_dir


# ─── Deploy ───────────────────────────────────────────────────────────────

def _find_site_id(site_name: str) -> str | None:
    """Find a Netlify site UUID by name."""
    env = {**os.environ, "NO_COLOR": "1"}
    result = subprocess.run(
        ["netlify.cmd", "api", "listSites", "--data", '{"name":"' + site_name + '"}'],
        capture_output=True, text=True, timeout=15,
        encoding="utf-8", errors="ignore", env=env,
    )
    try:
        import json
        data = json.loads(result.stdout)
        for site in data if isinstance(data, list) else [data]:
            if site.get("name") == site_name:
                return site.get("id")
    except (json.JSONDecodeError, KeyError):
        pass
    return None


def _create_site(site_name: str) -> str | None:
    """Create a Netlify site, return site UUID or None."""
    env = {**os.environ, "NO_COLOR": "1"}
    cmd = ["netlify.cmd", "sites:create", "--name", site_name]
    if NETLIFY_ACCOUNT:
        cmd.extend(["--account-slug", NETLIFY_ACCOUNT])
    result = subprocess.run(
        cmd, capture_output=True, text=True, timeout=30,
        encoding="utf-8", errors="ignore", env=env,
    )
    combined = result.stdout + result.stderr
    # Clean ANSI codes before parsing
    combined = re.sub(r'\x1b\[[0-9;]*m', '', combined)
    # Also clean unicode box-drawing chars that netlify uses
    combined = re.sub(r'[─-╿]', '', combined)

    id_match = re.search(r'Project\s*ID:\s*([a-f0-9-]{36})', combined)
    if id_match:
        return id_match.group(1)

    # Site might already exist — try finding it
    return _find_site_id(site_name)


def deploy_to_netlify(build_dir: Path, site_name: str) -> str | None:
    env = {**os.environ, "NO_COLOR": "1"}

    # Step 1: Get or create site ID
    site_id = _create_site(site_name)
    if not site_id:
        print(f"  Deploy error: Could not create or find site {site_name}")
        return None

    site_url = f"https://{site_name}.netlify.app"

    # Step 2: Deploy using site UUID
    result = subprocess.run(
        ["netlify.cmd", "deploy", "--dir", str(build_dir), "--site", site_id, "--prod"],
        capture_output=True, text=True, timeout=120,
        encoding="utf-8", errors="ignore", env=env,
    )

    if result.returncode != 0:
        combined_err = result.stdout + result.stderr
        print(f"  Deploy error: {combined_err[:200]}")
        return None

    combined = re.sub(r'\x1b\[[0-9;]*m', '', result.stdout + result.stderr)
    # Parse deploy URL
    url_match = re.search(r'Production URL:\s*(https://[^\s]+)', combined)
    if url_match:
        return url_match.group(1)
    url_match = re.search(r'(https://[a-zA-Z0-9-]+\.netlify\.app)', combined)
    if url_match:
        return url_match.group(1)

    # Fallback: assume site_name URL
    return site_url


# ─── Screenshot ───────────────────────────────────────────────────────────

def capture_screenshot(name: str, url: str) -> Path | None:
    slug = slugify(name)
    out_path = SCREENSHOT_DIR / f"{slug}.jpg"
    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("  Playwright not installed. Run: pip install playwright && playwright install chromium")
        return None

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport=VIEWPORT)
        try:
            page.goto(url, wait_until="networkidle", timeout=30000)
            page.wait_for_timeout(5000)
            page.screenshot(path=str(out_path), full_page=False, type="jpeg", quality=85)
            kb = out_path.stat().st_size // 1024
            print(f"  Screenshot: OK ({kb}KB)")
            browser.close()
            return out_path
        except Exception as e:
            print(f"  Screenshot FAIL: {e}")
            browser.close()
            return None


# ─── CSV Updates ──────────────────────────────────────────────────────────

def update_lead_csv(lead: dict, demo_url: str, has_audio: bool):
    """Update lead-queue.csv: demo_url + pipeline_stage."""
    with open(LEAD_CSV, encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fieldnames = list(reader.fieldnames)
        leads = list(reader)

    lead_id = lead.get("lead_id", "")
    for row in leads:
        if row.get("lead_id", "").strip() == lead_id:
            row["demo_url"] = demo_url
            has_email = row.get("email", "").strip()
            if has_email:
                row["pipeline_stage"] = "screenshotted"
            else:
                row["pipeline_stage"] = "phone_only"
            if has_audio:
                row["notes"] = (row.get("notes", "") + " | audio").strip(" | ")
            break

    with open(LEAD_CSV, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(leads)


def log_deploy(lead: dict, url: str, has_audio: bool):
    """Append to demo-deploys-20.csv."""
    new_file = not DEPLOY_LOG.exists()
    DEPLOY_LOG.parent.mkdir(parents=True, exist_ok=True)
    with open(DEPLOY_LOG, "a", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        if new_file:
            writer.writerow(["business_name", "city", "phone", "demo_url", "lead_id", "has_audio", "deployed_at"])
        writer.writerow([
            lead.get("business_name", ""),
            lead.get("city", ""),
            lead.get("phone", ""),
            url,
            lead.get("lead_id", ""),
            "yes" if has_audio else "no",
            datetime.now().isoformat(),
        ])


# ─── Lead Selection ───────────────────────────────────────────────────────

def load_pending_leads(mode: str = "all") -> list[dict]:
    """Load leads with pipeline_stage=scraped, no demo_url."""
    if not LEAD_CSV.exists():
        print(f"ERROR: {LEAD_CSV} not found")
        return []
    with open(LEAD_CSV, encoding="utf-8") as f:
        leads = list(csv.DictReader(f))

    pending = []
    for l in leads:
        stage = l.get("pipeline_stage", "").strip()
        has_demo = bool(l.get("demo_url", "").strip())
        has_email = bool(l.get("email", "").strip())
        if stage == "scraped" and not has_demo:
            if mode == "email" and not has_email:
                continue
            if mode == "phone" and has_email:
                continue
            pending.append(l)
    return pending


# ─── Main ─────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Orchestrate deploy pipeline")
    parser.add_argument("--count", type=int, default=5, help="Number of leads to process")
    parser.add_argument("--mode", choices=["all", "email", "phone"], default="all")
    parser.add_argument("--start", type=int, default=0, help="Offset into pending list")
    parser.add_argument("--lang", choices=["en", "es"], default="en")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--no-audio", action="store_true", help="Skip audio generation")
    args = parser.parse_args()

    if not ELEVENLABS_KEY and not args.no_audio:
        print("WARNING: ELEVENLABS_API_KEY not set. Audio will be skipped.")
        print("  Set it in .env or use --no-audio to suppress this warning.\n")
        args.no_audio = True

    pending = load_pending_leads(args.mode)
    if not pending:
        print("No pending leads found.")
        return

    batch = pending[args.start:args.start + args.count]
    print(f"Orchestrator — {len(batch)} leads (mode={args.mode})")
    print(f"{'DRY RUN' if args.dry_run else 'Live deploy'}\n")

    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)

    deployed = 0
    audio_ok = 0
    screenshot_ok = 0

    for i, lead in enumerate(batch):
        name = lead.get("business_name", "Unknown")
        slug = slugify(name)
        site_name = slug[:30]
        phone = lead.get("phone", "")
        has_email = bool(lead.get("email", "").strip())
        label = "EMAIL" if has_email else "PHONE"

        print(f"[{i+1}/{len(batch)}] {name} ({label}) | {phone}")

        # 1. Generate audio
        audio_path = None
        has_audio = False
        if not args.no_audio:
            audio_file = AUDIO_DIR / f"{slug}.mp3"
            if audio_file.exists():
                print(f"  Audio: already exists, reusing")
                audio_path = audio_file
                has_audio = True
            else:
                script_text = generate_script(lead, args.lang)
                print(f"  Audio: generating...")
                if not args.dry_run:
                    if generate_audio(script_text, audio_file):
                        audio_path = audio_file
                        has_audio = True
                        audio_ok += 1
                        print(f"  Audio: OK ({audio_file.stat().st_size // 1024}KB)")
                    else:
                        print(f"  Audio: FAILED — continuing without audio")
                else:
                    print(f"  [DRY RUN] Would generate audio")

        # 2. Build
        build_dir = build_demo(lead, audio_path)
        print(f"  Built: {name}")

        # 3. Deploy
        if args.dry_run:
            url = f"https://{site_name}.netlify.app"
            print(f"  [DRY RUN] Would deploy: {url}")
        else:
            url = deploy_to_netlify(build_dir, site_name)
            if not url:
                print(f"  DEPLOY FAILED — skipping screenshot")
                shutil.rmtree(build_dir, ignore_errors=True)
                continue
            print(f"  Deploy: {url}")
            deployed += 1

        # 4. Wait for CDN + Screenshot
        if not args.dry_run and url:
            print(f"  Waiting 5s for CDN...")
            time.sleep(5)
            ss_path = capture_screenshot(name, url)
            if ss_path:
                screenshot_ok += 1

        # 5. Update CSVs
        if not args.dry_run and url:
            update_lead_csv(lead, url, has_audio)
            log_deploy(lead, url, has_audio)
            print(f"  CSVs updated (pipeline_stage={'screenshotted' if has_email else 'phone_only'})")

        # Cleanup
        shutil.rmtree(build_dir, ignore_errors=True)
        print()

    # Summary
    print(f"{'='*60}")
    print(f"Done: {deployed}/{len(batch)} deployed")
    print(f"  Audio:     {audio_ok}/{len(batch)} generated")
    print(f"  Screenshots: {screenshot_ok}/{len(batch)} captured")
    print(f"  CSVs updated: {LEAD_CSV.name}, {DEPLOY_LOG.name}")
    print(f"\nNext: sync to Railway -> cd outreach && railway up")


if __name__ == "__main__":
    main()
