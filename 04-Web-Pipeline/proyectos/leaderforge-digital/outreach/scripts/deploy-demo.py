"""
Deploy personalized demo pages to Netlify.

For each lead: clone the demo template, replace {{SLOTS}},
deploy to Netlify as a new site, and return the URL.

Usage:
    python scripts/deploy-demo.py --input data/leads-welders-ca.csv
    python scripts/deploy-demo.py --input data/leads-welders-ca.csv --count 5
    python scripts/deploy-demo.py --input data/leads-welders-ca.csv --dry-run

Requirements:
    npm i -g netlify-cli
    netlify login (once)
"""

import os
import re
import sys
import csv
import json
import shutil
import argparse
import subprocess
import tempfile
import urllib.parse
from pathlib import Path
from datetime import datetime

from dotenv import load_dotenv

load_dotenv()

NETLIFY_ACCOUNT = os.getenv("NETLIFY_ACCOUNT_SLUG", "")

TEMPLATE_DIR = Path("demo-template")
DEPLOY_LOG = Path("data/demo-deploys.csv")
AUDIO_DIR = Path("audio")


def safe_print(s: str):
    """Print safely on Windows by stripping non-cp1252 chars."""
    try:
        print(s)
    except UnicodeEncodeError:
        print(s.encode("cp1252", errors="replace").decode("cp1252"))


def slugify(name: str) -> str:
    """Convert business name to URL-safe slug."""
    return name.lower().strip().replace(" ", "-").replace("'", "").replace(".", "")[:40]


def build_demo(lead: dict, audio_path: Path | None = None) -> Path:
    """Replace template slots, copy assets, write to temp dir. Returns path."""
    name = lead.get("business_name", "Your Business")
    trade = lead.get("website_quality", "") or "Welding"
    city = lead.get("city", "your area")
    phone = lead.get("phone", "").strip()
    lead_id = lead.get("id", slugify(name))

    if not phone:
        phone = "(858) 465-8919"

    city_clean = city.replace(" CA", "").replace(" ca", "")

    template_html = (TEMPLATE_DIR / "index.html").read_text(encoding="utf-8")

    # Determine audio URL
    audio_url = ""
    if audio_path and audio_path.exists():
        audio_url = "./audio.mp3"

    html = template_html
    html = html.replace("{{BUSINESS_NAME}}", name)
    html = html.replace("{{BUSINESS_NAME_SHORT}}", name.split()[0] if name else "Business")
    html = html.replace("{{BUSINESS_NAME_ENCODED}}", urllib.parse.quote(name))
    html = html.replace("{{TRADE}}", trade.title() if trade else "Welding")
    html = html.replace("{{CITY}}", city_clean)
    html = html.replace("{{CITY_ENCODED}}", urllib.parse.quote(city_clean))
    html = html.replace("{{PHONE}}", phone.replace(" ", "").replace("-", "").replace("(", "").replace(")", ""))
    html = html.replace("{{PHONE_DISPLAY}}", phone)
    html = html.replace("{{LEAD_ID}}", lead_id)
    html = html.replace("{{AUDIO_URL}}", audio_url)

    build_dir = Path(tempfile.mkdtemp(prefix="demo-"))
    (build_dir / "index.html").write_text(html, encoding="utf-8")

    # Copy audio file into build dir if present
    if audio_path and audio_path.exists():
        shutil.copy2(audio_path, build_dir / "audio.mp3")
        safe_print(f"  Audio: bundled ({audio_path.name})")

    safe_print(f"  Built: {name} -> {build_dir}")
    return build_dir


def deploy_to_netlify(build_dir: Path, site_name: str, dry_run: bool = False) -> str | None:
    """Create a Netlify site and deploy. Returns deployed URL or None."""
    if dry_run:
        safe_print(f"  [DRY RUN] Would deploy {site_name}")
        return f"https://{site_name}.netlify.app"

    try:
        site_id = None
        env = {**os.environ, "NO_COLOR": "1"}

        # Step 1: Create the site
        create_cmd = ["netlify.cmd", "sites:create", "--name", site_name]
        if NETLIFY_ACCOUNT:
            create_cmd.extend(["--account-slug", NETLIFY_ACCOUNT])
        create = subprocess.run(
            create_cmd,
            capture_output=True, text=True, timeout=30,
            encoding="utf-8", errors="ignore", env=env,
        )

        if create.returncode == 0:
            # Parse Project ID and URL from create output (goes to stdout)
            combined = create.stdout + create.stderr
            id_match = re.search(r'Project ID:\s*([a-f0-9-]{36})', combined)
            if id_match:
                site_id = id_match.group(1)
            url_match = re.search(r'URL:\s*(https://[^\s]+)', combined)
            site_url = url_match.group(1) if url_match else f"https://{site_name}.netlify.app"
            if "already exists" in combined:
                safe_print(f"  Site exists: {site_url}")
            else:
                safe_print(f"  Site created: {site_url}")
        else:
            combined = create.stdout + create.stderr
            if "already exists" in combined or "taken" in combined:
                safe_print(f"  Site {site_name} already exists, reusing...")
                site_url = f"https://{site_name}.netlify.app"
            else:
                safe_print(f"  Site create error: {combined[:200]}")
                return None

        # Step 2: Deploy (use site ID if we have it, otherwise site name)
        deploy_target = site_id or site_name
        result = subprocess.run(
            ["netlify.cmd", "deploy", "--dir", str(build_dir), "--site", deploy_target, "--prod"],
            capture_output=True, text=True, timeout=120, cwd=str(build_dir),
            encoding="utf-8", errors="ignore", env=env,
        )

        if result.returncode != 0:
            combined_err = result.stdout + result.stderr
            safe_print(f"  Deploy error: {combined_err[:200]}")
            return None

        # Parse URL from deploy output (check both stdout and stderr)
        combined = result.stdout + result.stderr
        url_match = re.search(r'Production URL:\s*(https://[^\s]+)', combined)
        if url_match:
            return url_match.group(1)

        # Fallback: scan for any netlify.app URL
        for line in combined.splitlines():
            line = line.strip()
            if "https://" in line and ".netlify.app" in line:
                return line.split()[-1].strip("<>")

        safe_print(f"  Deploy output: {combined[:300]}")
        return None

    except subprocess.TimeoutExpired:
        print("  Netlify deploy timed out")
        return None
    except FileNotFoundError:
        print("  ERROR: Netlify CLI not installed. Run: npm i -g netlify-cli")
        sys.exit(1)


def log_deploy(lead: dict, url: str, audio_url: str):
    """Log deployment to CSV."""
    new_file = not DEPLOY_LOG.exists()
    DEPLOY_LOG.parent.mkdir(parents=True, exist_ok=True)
    with open(DEPLOY_LOG, "a", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        if new_file:
            writer.writerow(["business_name", "city", "phone", "demo_url", "audio_url", "deployed_at"])
        writer.writerow([
            lead.get("business_name", ""),
            lead.get("city", ""),
            lead.get("phone", ""),
            url,
            audio_url,
            datetime.now().isoformat(),
        ])


def main():
    parser = argparse.ArgumentParser(description="Deploy demo pages to Netlify")
    parser.add_argument("--input", default="data/leads-welders-ca.csv", help="CSV of leads")
    parser.add_argument("--start", type=int, default=0)
    parser.add_argument("--count", type=int, default=0, help="Max deploys (0 = all)")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--audio-dir", default="audio", help="Directory with audio files")
    args = parser.parse_args()

    input_path = Path(args.input)
    if not input_path.exists():
        safe_print(f"ERROR: {input_path} not found. Run scrape-leads.py first.")
        sys.exit(1)

    with open(input_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        leads = list(reader)

    # Add ID column if not present
    for i, lead in enumerate(leads):
        if "id" not in lead:
            lead["id"] = slugify(lead.get("business_name", f"lead-{i}"))

    target = leads[args.start:]
    if args.count > 0:
        target = target[:args.count]

    safe_print(f"Demo Deploy — {len(target)} leads")
    safe_print(f"{'DRY RUN — no deploys' if args.dry_run else 'Deploying to Netlify'}\n")

    deployed = 0
    for i, lead in enumerate(target):
        name = lead.get("business_name", "Unknown")
        slug = slugify(name)
        site_name = slug[:30]  # Netlify site name must be <= 63 chars

        safe_print(f"[{i + 1}/{len(target)}] {name}")

        # Find audio file (try exact match, then glob for naming quirks)
        audio_path = None
        audio_file = AUDIO_DIR / f"{slug}.mp3"
        if audio_file.exists():
            audio_path = audio_file
        else:
            # Handle double-dot naming (e.g. slug..mp3) and other quirks
            candidates = list(AUDIO_DIR.glob(f"{slug}*.mp3")) if AUDIO_DIR.exists() else []
            if candidates:
                audio_path = candidates[0]

        build_dir = build_demo(lead, audio_path)
        url = deploy_to_netlify(build_dir, site_name, args.dry_run)

        if url:
            log_deploy(lead, url, "./audio.mp3" if audio_path else "")
            safe_print(f"  -> {url}")
            deployed += 1

        # Cleanup temp dir
        shutil.rmtree(build_dir, ignore_errors=True)

    safe_print(f"\n{'='*60}")
    safe_print(f"Deployed: {deployed}/{len(target)}")
    safe_print(f"Log: {DEPLOY_LOG}")


if __name__ == "__main__":
    main()
