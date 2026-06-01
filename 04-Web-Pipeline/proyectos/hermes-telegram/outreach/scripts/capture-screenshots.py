"""
Capture demo page screenshots. Only processes leads with pipeline_stage=deployed.

Usage:
    python scripts/capture-screenshots.py              # Deployed leads only
    python scripts/capture-screenshots.py --limit 3    # First 3 only
    python scripts/capture-screenshots.py --slug "javiers-custom-welding"  # Just one
    python scripts/capture-screenshots.py --force      # Re-capture existing screenshots
"""
import csv
import sys
import time
import argparse
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).parent.parent
LEAD_CSV = ROOT / "data" / "lead-queue.csv"
SCREENSHOT_DIR = ROOT / "screenshots"
SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)

VIEWPORT = {"width": 1280, "height": 800}


def slugify(name: str) -> str:
    return name.lower().strip().replace(" & ", " ").replace(" ", "-").replace("'", "").replace(".", "").replace("&", "")[:40]


def load_deployed_leads() -> list[dict]:
    """Return leads with pipeline_stage=deployed that have a demo_url."""
    if not LEAD_CSV.exists():
        print(f"ERROR: {LEAD_CSV} not found")
        return []
    leads = []
    with open(LEAD_CSV, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            stage = row.get("pipeline_stage", "").strip()
            name = row.get("business_name", "").strip()
            url = row.get("demo_url", "").strip()
            if stage == "deployed" and name and url:
                leads.append({"name": name, "url": url, "lead_id": row.get("lead_id", "")})
    return leads


def capture(name: str, url: str, force: bool = False) -> str | None:
    """Capture screenshot of url, return file path or None."""
    slug = slugify(name)
    out_path = SCREENSHOT_DIR / f"{slug}.jpg"

    if out_path.exists() and not force:
        print(f"  {name} ... SKIP (already exists)")
        return str(out_path)

    print(f"  {name} ...", end=" ", flush=True)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport=VIEWPORT)

        try:
            page.goto(url, wait_until="networkidle", timeout=30000)
            page.wait_for_timeout(5000)
            page.screenshot(path=str(out_path), full_page=False, type="jpeg", quality=85)
            file_size = out_path.stat().st_size // 1024
            print(f"OK ({file_size}KB)")
            browser.close()
            return str(out_path)
        except Exception as e:
            print(f"FAIL: {e}")
            browser.close()
            return None


def update_pipeline_stage(lead_id: str, new_stage: str):
    """Update pipeline_stage for a single lead in lead-queue.csv."""
    with open(LEAD_CSV, encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fieldnames = list(reader.fieldnames)
        leads = list(reader)

    for lead in leads:
        if lead.get("lead_id", "").strip() == lead_id:
            lead["pipeline_stage"] = new_stage
            break

    with open(LEAD_CSV, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(leads)


def main():
    parser = argparse.ArgumentParser(description="Capture demo screenshots")
    parser.add_argument("--limit", type=int, default=0, help="Max demos to capture")
    parser.add_argument("--slug", type=str, default="", help="Capture single demo by slug")
    parser.add_argument("--force", action="store_true", help="Re-capture even if screenshot exists")
    args = parser.parse_args()

    # Load all deployed (not yet screenshotted) leads
    leads = load_deployed_leads()

    if args.slug:
        leads = [l for l in leads if slugify(l["name"]) == args.slug or slugify(l["name"]).startswith(args.slug[:20])]
        if not leads:
            print(f"No deployed lead matching slug '{args.slug}'")
            sys.exit(1)

    # Also allow --slug to force-capture any lead with a demo_url if --force is set
    if args.slug and args.force:
        with open(LEAD_CSV, encoding="utf-8") as f:
            all_leads = list(csv.DictReader(f))
        for row in all_leads:
            if slugify(row.get("business_name", "")) == args.slug:
                if row.get("demo_url", "").strip():
                    leads = [{"name": row["business_name"], "url": row["demo_url"], "lead_id": row["lead_id"]}]
                break

    if not leads:
        print("No deployed leads to capture (pipeline_stage=deployed)")
        sys.exit(0)

    items = leads
    if args.limit > 0:
        items = items[:args.limit]

    print(f"Capturing {len(items)} screenshot(s)...")
    ok = 0
    failed = 0

    for item in items:
        name = item["name"]
        url = item["url"]
        lead_id = item["lead_id"]
        result = capture(name, url, force=args.force)
        if result:
            update_pipeline_stage(lead_id, "screenshotted")
            ok += 1
        else:
            failed += 1
        time.sleep(0.5)

    print(f"\nDone: {ok} OK, {failed} failed")


if __name__ == "__main__":
    main()
