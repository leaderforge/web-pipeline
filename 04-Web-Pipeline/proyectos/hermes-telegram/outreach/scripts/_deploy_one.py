"""Deploy a single lead by lead_id."""
import csv, tempfile, subprocess, re, urllib.parse, shutil, os, sys
from pathlib import Path
from datetime import datetime

ROOT = Path(__file__).parent.parent
TEMPLATE_DIR = ROOT / "demo-template"
CSV_PATH = ROOT / "data" / "lead-queue.csv"
LOG_PATH = ROOT / "data" / "demo-deploys-20.csv"

lead_id = sys.argv[1] if len(sys.argv) > 1 else "rww01"
site_id = sys.argv[2] if len(sys.argv) > 2 else None

with open(CSV_PATH, encoding="utf-8") as f:
    leads = list(csv.DictReader(f))

lead = None
for l in leads:
    if l["lead_id"].strip() == lead_id:
        lead = l
        break

if not lead:
    print(f"Lead '{lead_id}' not found")
    sys.exit(1)

name = lead["business_name"]
city = lead.get("city", "your area").replace(" CA", "")
phone = lead.get("phone", "").strip()
slug = name.lower().strip().replace(" & ", " ").replace(" ", "-").replace("'", "").replace(".", "").replace("&", "")[:30]
print(f"Deploying: {name} (slug: {slug})")

if not site_id:
    # Look up site from Netlify
    result = subprocess.run(
        ["netlify.cmd", "sites:list"],
        capture_output=True, text=True, timeout=30, encoding="utf-8", errors="ignore",
        env={**os.environ, "NO_COLOR": "1"}
    )
    site_ids = {}
    for line in (result.stdout + result.stderr).splitlines():
        m = re.match(r'^([a-z0-9][-a-z0-9]*)\s*-\s*([a-f0-9-]{36})', line)
        if m:
            site_ids[m.group(1)] = m.group(2)
    site_id = site_ids.get(slug)
    if not site_id:
        for sname, sid in site_ids.items():
            if sname.startswith(slug[:20]):
                site_id = sid
                slug = sname
                break
    if not site_id:
        print(f"No Netlify site found for slug '{slug}'")
        sys.exit(1)

print(f"Site ID: {site_id}")

html = (TEMPLATE_DIR / "index.html").read_text(encoding="utf-8")
html = html.replace("{{BUSINESS_NAME}}", name)
short_name = name.split()[0] if name else "Business"
html = html.replace("{{BUSINESS_NAME_SHORT}}", short_name)
words = name.split()
if len(words) > 1:
    logo_html = " ".join(words[:-1]) + " <span>" + words[-1].upper() + "</span>"
else:
    logo_html = "<span>" + name.upper() + "</span>"
html = html.replace("{{BUSINESS_NAME_LOGO}}", logo_html)
html = html.replace("{{BUSINESS_NAME_ENCODED}}", urllib.parse.quote(name))
html = html.replace("{{TRADE}}", "Welding")
html = html.replace("{{CITY}}", city)
html = html.replace("{{CITY_ENCODED}}", urllib.parse.quote(city))
html = html.replace("{{PHONE}}", phone.replace(" ", "").replace("-", "").replace("(", "").replace(")", ""))
html = html.replace("{{PHONE_DISPLAY}}", phone)
html = html.replace("{{LEAD_ID}}", slug[:20])
audio_path = ROOT / "audio" / f"{slug}.mp3"
has_audio = audio_path.exists()
html = html.replace("{{AUDIO_URL}}", "./audio.mp3" if has_audio else "")

build_dir = Path(tempfile.mkdtemp(prefix="demo-"))
(build_dir / "index.html").write_text(html, encoding="utf-8")

photo_src = TEMPLATE_DIR / "daniel.jpg"
if photo_src.exists():
    shutil.copy2(photo_src, build_dir / "daniel.jpg")

if has_audio:
    shutil.copy2(audio_path, build_dir / "audio.mp3")
    print(f"[audio bundled]", end=" ", flush=True)

env = {**os.environ, "NO_COLOR": "1"}
result = subprocess.run(
    ["netlify.cmd", "deploy", "--dir", str(build_dir), "--site", site_id, "--prod"],
    capture_output=True, text=True, timeout=120, encoding="utf-8", errors="ignore", env=env
)

combined = (result.stdout + result.stderr).encode("ascii", errors="replace").decode("ascii")
print(combined[:600])
url_match = re.search(r'(https://[^\s]+\.netlify\.app)', combined)
if url_match:
    url = url_match.group(1)
    print(f"DEPLOYED: {url}")
    with open(LOG_PATH, "a", encoding="utf-8") as log:
        log.write(f'"{name}","{city}","{phone}","{url}","{datetime.now().isoformat()}"\n')
else:
    print("FAIL")

shutil.rmtree(build_dir, ignore_errors=True)
