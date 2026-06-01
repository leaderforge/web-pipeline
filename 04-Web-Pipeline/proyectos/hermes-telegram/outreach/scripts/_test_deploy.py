"""Test deploy one demo with new template."""
import csv, tempfile, subprocess, re, urllib.parse, shutil, os
from pathlib import Path

ROOT = Path(__file__).parent.parent
TEMPLATE_DIR = ROOT / "demo-template"
CSV_PATH = ROOT / "data" / "lead-queue.csv"

with open(CSV_PATH, encoding="utf-8") as f:
    leads = list(csv.DictReader(f))

lead = [l for l in leads if l["business_name"] == "Javier's Custom Welding"][0]
name = lead["business_name"]
city = lead.get("city", "your area").replace(" CA", "")
phone = lead.get("phone", "").strip()
slug = name.lower().strip().replace(" & ", " ").replace(" ", "-").replace("'", "").replace(".", "").replace("&", "")[:30]

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
audio_path = ROOT / "audio" / (slug + ".mp3")
html = html.replace("{{AUDIO_URL}}", "./audio.mp3" if audio_path.exists() else "")

build_dir = Path(tempfile.mkdtemp(prefix="demo-"))
(build_dir / "index.html").write_text(html, encoding="utf-8")

photo_src = TEMPLATE_DIR / "daniel.jpg"
if photo_src.exists():
    shutil.copy2(photo_src, build_dir / "daniel.jpg")

if audio_path.exists():
    shutil.copy2(audio_path, build_dir / "audio.mp3")
    print("[audio bundled]", flush=True)

env = {**os.environ, "NO_COLOR": "1"}
result = subprocess.run(
    ["netlify.cmd", "deploy", "--dir", str(build_dir), "--site", "7951180c-1f5c-44d7-adaf-e268de35980b", "--prod"],
    capture_output=True, text=True, timeout=120, encoding="utf-8", errors="ignore", env=env
)

combined = (result.stdout + result.stderr).encode("ascii", errors="replace").decode("ascii")
print(combined[:600])
url_match = re.search(r"(https://[^\s]+\.netlify\.app)", combined)
if url_match:
    print("DEPLOYED: " + url_match.group(1))
else:
    print("FAIL - check output above")

shutil.rmtree(build_dir, ignore_errors=True)
