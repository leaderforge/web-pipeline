"""
Take screenshots of deployed demo pages.

Uses Playwright (headless Chromium) to capture each demo page
as a PNG for embedding in cold emails.

Usage:
    python scripts/screenshot.py --input data/demo-deploys.csv
    python scripts/screenshot.py --input data/demo-deploys.csv --count 5

Requirements:
    pip install playwright
    playwright install chromium
"""

import os
import sys
import csv
import argparse
import time
from pathlib import Path
from datetime import datetime

SCREENSHOT_DIR = Path("screenshots")
LOG_PATH = Path("data/screenshot-log.csv")

try:
    from playwright.sync_api import sync_playwright
    HAS_PLAYWRIGHT = True
except ImportError:
    HAS_PLAYWRIGHT = False


def take_screenshot(url: str, output_path: Path, width: int = 1280, height: int = 800) -> bool:
    """Capture a full-page screenshot of the demo page."""
    if not HAS_PLAYWRIGHT:
        print("  ERROR: playwright not installed. Run: pip install playwright && playwright install chromium")
        return False

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(viewport={"width": width, "height": height})
            # Block tracking pixel during screenshot to avoid false notifications
            page.route("**/api/demo-view*", lambda route: route.abort())
            page.goto(url, wait_until="networkidle", timeout=20000)
            page.screenshot(path=str(output_path), full_page=False)
            browser.close()
        return True
    except Exception as e:
        print(f"  Screenshot error: {e}")
        return False


def log_screenshot(business_name: str, url: str, screenshot_path: str):
    """Log screenshot generation."""
    new_file = not LOG_PATH.exists()
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(LOG_PATH, "a", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        if new_file:
            writer.writerow(["business_name", "url", "screenshot_path", "captured_at"])
        writer.writerow([business_name, url, screenshot_path, datetime.now().isoformat()])


def main():
    parser = argparse.ArgumentParser(description="Screenshot demo pages")
    parser.add_argument("--input", default="data/demo-deploys.csv")
    parser.add_argument("--start", type=int, default=0)
    parser.add_argument("--count", type=int, default=0)
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=800)
    args = parser.parse_args()

    input_path = Path(args.input)
    if not input_path.exists():
        print(f"ERROR: {input_path} not found. Run deploy-demo.py first.")
        sys.exit(1)

    with open(input_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        deploys = list(reader)

    target = deploys[args.start:]
    if args.count > 0:
        target = target[:args.count]

    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)

    print(f"Screenshot Capture — {len(target)} demo pages")
    print(f"  Resolution: {args.width}x{args.height}\n")

    captured = 0
    for i, row in enumerate(target):
        name = row.get("business_name", "Unknown")
        url = row.get("demo_url", "")

        if not url:
            print(f"[{i + 1}/{len(target)}] {name} — SKIP (no URL)")
            continue

        slug = name.lower().strip().replace(" ", "-").replace("'", "").replace(".", "")[:40]
        screenshot_path = SCREENSHOT_DIR / f"{slug}.png"

        print(f"[{i + 1}/{len(target)}] {name}")
        print(f"  URL: {url}")

        success = take_screenshot(url, screenshot_path, args.width, args.height)
        if success:
            log_screenshot(name, url, str(screenshot_path))
            print(f"  -> {screenshot_path}")
            captured += 1

        time.sleep(1)

    print(f"\n{'='*60}")
    print(f"Captured: {captured}/{len(target)}")
    print(f"Screenshots: {SCREENSHOT_DIR}")


if __name__ == "__main__":
    main()
