"""Batch deploy demos from lead-queue.csv using Netlify site IDs.

Pipeline order: add_new → generate-audio → deploy → screenshot → email
Run generate-audio.py BEFORE this script so MP3s are bundled."""
import os, sys, csv, tempfile, subprocess, re, urllib.parse, shutil
from pathlib import Path
from datetime import datetime

ROOT = Path(__file__).parent.parent
TEMPLATE_DIR = ROOT / "demo-template"
CSV_PATH = ROOT / "data" / "lead-queue.csv"
LOG_PATH = ROOT / "data" / "demo-deploys-20.csv"

env = {**os.environ, "NO_COLOR": "1"}

# Get site ID -> name mapping from netlify
result = subprocess.run(
    ["netlify.cmd", "sites:list"],
    capture_output=True, text=True, timeout=30, encoding="utf-8", errors="ignore", env=env
)
site_ids = {}
for line in (result.stdout + result.stderr).splitlines():
    m = re.match(r'^([a-z0-9][-a-z0-9]*)\s*-\s*([a-f0-9-]{36})', line)
    if m:
        site_ids[m.group(1)] = m.group(2)

print(f"Found {len(site_ids)} sites in Netlify account")

with open(CSV_PATH, encoding="utf-8") as f:
    leads = list(csv.DictReader(f))

new_file = not LOG_PATH.exists()
log = open(LOG_PATH, "a", encoding="utf-8")
if new_file:
    log.write("business_name,city,phone,demo_url,deployed_at\n")

deployed = 0

for lead in leads:
    name = lead.get("business_name", "")
    email = lead.get("email", "").strip()
    if not email:
        continue
    if lead.get("pipeline_stage", "").strip() != "new":
        print(f"SKIP {name}: pipeline_stage={lead.get('pipeline_stage','?')}")
        continue

    city = lead.get("city", "your area").replace(" CA", "")
    phone = lead.get("phone", "").strip() or "(858) 465-8919"
    slug = name.lower().strip().replace(" & ", " ").replace(" ", "-").replace("'", "").replace(".", "").replace("&", "")[:30]

    # Find site ID matching this slug
    site_id = site_ids.get(slug)
    if not site_id:
        for sname, sid in site_ids.items():
            if sname.startswith(slug[:20]):
                site_id = sid
                slug = sname
                break

    if not site_id:
        print(f"SKIP {name}: no site for slug '{slug}'")
        continue

    # Build HTML from template
    html = (TEMPLATE_DIR / "index.html").read_text(encoding="utf-8")
    html = html.replace("{{BUSINESS_NAME}}", name)
    short_name = name.split()[0] if name else "Business"
    html = html.replace("{{BUSINESS_NAME_SHORT}}", short_name)

    # Logo: business name with last word in orange
    words = name.split()
    if len(words) > 1:
        logo_html = ' '.join(words[:-1]) + ' <span>' + words[-1].upper() + '</span>'
    else:
        logo_html = '<span>' + name.upper() + '</span>'
    html = html.replace("{{BUSINESS_NAME_LOGO}}", logo_html)

    html = html.replace("{{BUSINESS_NAME_ENCODED}}", urllib.parse.quote(name))
    html = html.replace("{{TRADE}}", "Welding")
    html = html.replace("{{CITY}}", city)
    html = html.replace("{{CITY_ENCODED}}", urllib.parse.quote(city))
    html = html.replace("{{PHONE}}", phone.replace(" ", "").replace("-", "").replace("(", "").replace(")", ""))
    html = html.replace("{{PHONE_DISPLAY}}", phone)
    html = html.replace("{{LEAD_ID}}", slug[:20])

    # Audio + photo bundling
    audio_path = ROOT / "audio" / f"{slug}.mp3"
    has_audio = audio_path.exists()
    html = html.replace("{{AUDIO_URL}}", "./audio.mp3" if has_audio else "")

    build_dir = Path(tempfile.mkdtemp(prefix="demo-"))
    (build_dir / "index.html").write_text(html, encoding="utf-8")

    # Always bundle Daniel's photo for the "A quick word from Daniel" section
    photo_src = TEMPLATE_DIR / "daniel.jpg"
    if photo_src.exists():
        shutil.copy2(photo_src, build_dir / "daniel.jpg")

    # Bundle audio if available
    if has_audio:
        shutil.copy2(audio_path, build_dir / "audio.mp3")
        print(f"[audio bundled]", end=" ", flush=True)

    print(f"Deploying {name} ...", end=" ", flush=True)
    result = subprocess.run(
        ["netlify.cmd", "deploy", "--dir", str(build_dir), "--site", site_id, "--prod"],
        capture_output=True, text=True, timeout=120, encoding="utf-8", errors="ignore", env=env
    )

    combined = result.stdout + result.stderr
    url_match = re.search(r'(https://[^\s]+\.netlify\.app)', combined)
    if url_match:
        url = url_match.group(1)
        print(f"OK {url}")
        log.write(f'"{name}","{city}","{phone}","{url}","{datetime.now().isoformat()}"\n')
        log.flush()
        lead["demo_url"] = url
        lead["pipeline_stage"] = "deployed"
        deployed += 1
    else:
        print("FAIL")

    shutil.rmtree(build_dir, ignore_errors=True)

log.close()

# Rewrite lead-queue.csv with updated demo_urls
if deployed > 0:
    fieldnames = list(leads[0].keys())
    with open(CSV_PATH, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(leads)
    print(f"Updated {deployed} leads to pipeline_stage=deployed")

print(f"\nDeployed: {deployed}")
