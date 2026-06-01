"""
Clean up expired demo sites and screenshots.

Logic:
- Reads demo-deploys.csv for deployed sites
- Cross-references CampaignTracker (Google Sheets) for response status
- Deletes demos >14 days since deploy with no response
- Deletes corresponding screenshots
- Can optionally delete Netlify sites

Usage:
    python scripts/cleanup.py --dry-run
    python scripts/cleanup.py --max-age 14
    python scripts/cleanup.py --delete-netlify  # also delete Netlify sites
"""

import os
import sys
import csv
import json
import argparse
import subprocess
from pathlib import Path
from datetime import datetime, timezone

from dotenv import load_dotenv

load_dotenv()

GOOGLE_SHEETS_ID = os.getenv("GOOGLE_SHEETS_ID", "")
GOOGLE_SERVICE_ACCOUNT_EMAIL = os.getenv("GOOGLE_SERVICE_ACCOUNT_EMAIL", "")
GOOGLE_PRIVATE_KEY = os.getenv("GOOGLE_PRIVATE_KEY", "")

DEPLOY_LOG = Path("data/demo-deploys.csv")
SCREENSHOT_DIR = Path("screenshots")
CLEANUP_LOG = Path("data/cleanup-log.csv")


def get_sheets_client():
    if not GOOGLE_SERVICE_ACCOUNT_EMAIL or not GOOGLE_PRIVATE_KEY:
        return None
    from google.oauth2.service_account import Credentials
    private_key = GOOGLE_PRIVATE_KEY.replace('\\n', '\n')
    creds = Credentials.from_service_account_info({
        "client_email": GOOGLE_SERVICE_ACCOUNT_EMAIL,
        "private_key": private_key,
        "token_uri": "https://oauth2.googleapis.com/token",
    }, scopes=["https://www.googleapis.com/auth/spreadsheets"])
    from googleapiclient.discovery import build
    return build("sheets", "v4", credentials=creds)


def get_campaign_data(sheets) -> dict[str, dict]:
    """Return CampaignTracker rows keyed by business name (lowercase)."""
    if not sheets:
        return {}
    try:
        result = sheets.spreadsheets().values().get(
            spreadsheetId=GOOGLE_SHEETS_ID,
            range="'CampaignTracker'!A:K",
        ).execute()
        values = result.get("values", [])
        if len(values) < 2:
            return {}
        headers = [h.lower() for h in values[0]]
        rows = {}
        for row in values[1:]:
            d = {headers[i]: row[i] if i < len(row) else "" for i in range(len(headers))}
            key = d.get("business name", "").strip().lower()
            if key:
                rows[key] = d
        return rows
    except Exception as e:
        print(f"  Sheets read error: {e}")
        return {}


def get_netlify_sites() -> dict[str, str]:
    """Return {site_name: site_id} from Netlify CLI."""
    try:
        result = subprocess.run(
            ["netlify.cmd", "api", "listSites"],
            capture_output=True, text=True, encoding="utf-8", errors="ignore",
            timeout=30, env={**os.environ, "NO_COLOR": "1"},
        )
        sites = json.loads(result.stdout)
        return {s["name"]: s["id"] for s in sites if isinstance(s, dict) and "name" in s}
    except Exception as e:
        print(f"  Netlify API error: {e}")
        return {}


def delete_netlify_site(site_id: str) -> bool:
    """Delete a Netlify site by ID."""
    try:
        result = subprocess.run(
            ["netlify.cmd", "api", "deleteSite", "--data", json.dumps({"site_id": site_id})],
            capture_output=True, text=True, encoding="utf-8", errors="ignore",
            timeout=30, env={**os.environ, "NO_COLOR": "1"},
        )
        return result.returncode == 0
    except Exception as e:
        print(f"    Netlify delete error: {e}")
        return False


def log_cleanup(name: str, demo_url: str, action: str, details: str = ""):
    new_file = not CLEANUP_LOG.exists()
    CLEANUP_LOG.parent.mkdir(parents=True, exist_ok=True)
    with open(CLEANUP_LOG, "a", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        if new_file:
            writer.writerow(["business_name", "demo_url", "action", "details", "cleaned_at"])
        writer.writerow([name, demo_url, action, details, datetime.now().isoformat()])


def main():
    parser = argparse.ArgumentParser(description="Clean up expired demo pages")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--max-age", type=int, default=14, help="Days until a demo expires (default: 14)")
    parser.add_argument("--delete-netlify", action="store_true", help="Also delete Netlify sites")
    args = parser.parse_args()

    if not DEPLOY_LOG.exists():
        print(f"No deploy log at {DEPLOY_LOG}")
        return

    with open(DEPLOY_LOG, newline="", encoding="utf-8") as f:
        deploys = list(csv.DictReader(f))

    if not deploys:
        print("No deploys in log.")
        return

    sheets = get_sheets_client()
    campaign = get_campaign_data(sheets) if sheets else {}
    netlify_sites = get_netlify_sites() if args.delete_netlify else {}

    now = datetime.now(timezone.utc)
    deleted_screenshots = 0
    deleted_sites = 0

    print(f"Cleanup — {len(deploys)} deploys, max age: {args.max_age} days")
    if args.dry_run:
        print("  DRY RUN\n")

    for d in deploys:
        name = d.get("business_name", "Unknown")
        url = d.get("demo_url", "")
        deployed_str = d.get("deployed_at", "")

        if not url:
            continue

        # Parse deploy date
        try:
            deployed_at = datetime.fromisoformat(deployed_str)
        except (ValueError, TypeError):
            continue

        age_days = (now - deployed_at.replace(tzinfo=timezone.utc)).days

        # Check campaign status
        key = name.strip().lower()
        camp = campaign.get(key, {})
        responded = camp.get("responded", "no").lower() if camp else "no"

        if responded == "yes":
            continue  # They responded — preserve
        if age_days < args.max_age:
            continue  # Not expired yet

        print(f"  EXPIRED: {name} ({age_days}d old)")

        # Delete screenshot
        slug = name.lower().strip().replace(" ", "-").replace("'", "").replace(".", "")[:40]
        candidates = list(SCREENSHOT_DIR.glob(f"{slug}*.png")) if SCREENSHOT_DIR.exists() else []
        for sp in candidates:
            if args.dry_run:
                print(f"    [DRY RUN] Would delete screenshot: {sp}")
            else:
                sp.unlink()
                print(f"    Deleted screenshot: {sp}")
                deleted_screenshots += 1

        # Delete Netlify site
        if args.delete_netlify:
            site_slug = url.rstrip("/").split("/")[-1].replace(".netlify.app", "")
            site_id = netlify_sites.get(site_slug)
            if site_id:
                if args.dry_run:
                    print(f"    [DRY RUN] Would delete Netlify site: {site_slug} ({site_id})")
                else:
                    ok = delete_netlify_site(site_id)
                    if ok:
                        print(f"    Deleted Netlify site: {site_slug}")
                        deleted_sites += 1
                    else:
                        print(f"    FAILED to delete Netlify site: {site_slug}")
            else:
                print(f"    Netlify site not found: {site_slug}")

        if not args.dry_run:
            log_cleanup(name, url, "expired", f"age={age_days}d, responded={responded}")

    print(f"\n{'='*60}")
    print(f"Screenshots deleted: {deleted_screenshots}")
    print(f"Netlify sites deleted: {deleted_sites}")
    print(f"Log: {CLEANUP_LOG}")


if __name__ == "__main__":
    main()
