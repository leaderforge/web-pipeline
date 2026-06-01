"""
Send phone-only leads to Telegram for manual SMS outreach.
Also logs to Google Sheets PhoneOutreach tab.

Usage:
    python scripts/phone-outreach.py --input data/demo-deploys.csv
    python scripts/phone-outreach.py --lead "Business Name" --phone "555-1234" --url "https://..."
"""

import os
import sys
import csv
import argparse
import requests
from pathlib import Path
from datetime import datetime
from dotenv import load_dotenv

load_dotenv()

TELEGRAM_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN_LF", "")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID_LF", "")
GOOGLE_SHEETS_ID = os.getenv("GOOGLE_SHEETS_ID", "")
GOOGLE_SERVICE_ACCOUNT_EMAIL = os.getenv("GOOGLE_SERVICE_ACCOUNT_EMAIL", "")
GOOGLE_PRIVATE_KEY = os.getenv("GOOGLE_PRIVATE_KEY", "")

SCREENSHOT_DIR = Path("screenshots")

PHONEOUTREACH_HEADERS = [
    "Business Name", "Phone", "City", "Demo URL",
    "Notified to Telegram", "Status", "Notes", "Updated At",
]


def find_screenshot(name: str) -> Path | None:
    """Find screenshot file for a business, handling naming quirks."""
    slug = name.lower().strip().replace(" ", "-").replace("'", "").replace(".", "")[:40]
    path = SCREENSHOT_DIR / f"{slug}.png"
    if path.exists():
        return path
    candidates = list(SCREENSHOT_DIR.glob(f"{slug}*.png")) if SCREENSHOT_DIR.exists() else []
    return candidates[0] if candidates else None


def send_telegram_message(text: str) -> bool:
    """Send a plain-text message to Daniel's Telegram."""
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    resp = requests.post(url, json={"chat_id": TELEGRAM_CHAT_ID, "text": text}, timeout=10)
    return resp.status_code == 200


def send_telegram_photo(image_path: Path, caption: str = "") -> bool:
    """Send a photo to Daniel's Telegram."""
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendPhoto"
    with open(image_path, "rb") as f:
        data = {"chat_id": TELEGRAM_CHAT_ID}
        if caption:
            data["caption"] = caption
        resp = requests.post(url, data=data, files={"photo": f}, timeout=15)
    return resp.status_code == 200


def outreach_lead(name: str, phone: str, demo_url: str, city: str, dry_run: bool = False) -> tuple[bool, bool]:
    """Send SMS text + screenshot to Telegram. Returns (sms_sent, photo_sent)."""
    body = (
        f"Hola, soy Daniel de LeaderForge Digital. "
        f"Te arme una pagina demo para {name} en {city}:\n"
        f"{demo_url}\n"
        f"Si te gusta como se ve, dime y lo afinamos en una llamada de 15 minutos. "
        f"Si no, ahi tienes pagina gratis.\n"
        f"www.leaderforge.digital"
    )

    sms_msg = f"{phone}\n\n{body}"

    if dry_run:
        print(f"    [DRY RUN] SMS message:")
        print(f"    ---")
        print(f"    {phone}")
        print(f"    {body}")
        return True, False

    # 1st message: SMS text
    sms_ok = send_telegram_message(sms_msg)
    if not sms_ok:
        return False, False

    # 2nd message: screenshot
    screenshot = find_screenshot(name)
    if screenshot:
        photo_ok = send_telegram_photo(screenshot, caption=f"{name} — {city}")
        return True, photo_ok

    return True, False  # SMS sent, no screenshot available


def get_sheets_client():
    """Return authenticated Google Sheets client."""
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


def ensure_phoneoutreach_sheet(sheets):
    """Ensure the PhoneOutreach sheet exists with headers."""
    if not sheets:
        return
    try:
        sheets.spreadsheets().values().get(
            spreadsheetId=GOOGLE_SHEETS_ID,
            range="'PhoneOutreach'!A1:H1",
        ).execute()
    except Exception:
        sheets.spreadsheets().batchUpdate(
            spreadsheetId=GOOGLE_SHEETS_ID,
            body={"requests": [{"addSheet": {"properties": {"title": "PhoneOutreach"}}}]},
        ).execute()
        sheets.spreadsheets().values().update(
            spreadsheetId=GOOGLE_SHEETS_ID,
            range="'PhoneOutreach'!A1:H1",
            valueInputOption="USER_ENTERED",
            body={"values": [PHONEOUTREACH_HEADERS]},
        ).execute()
        print("  Created 'PhoneOutreach' sheet.")


def log_to_sheets(sheets, name: str, phone: str, city: str, demo_url: str, status: str, notes: str = ""):
    """Log phone outreach to Google Sheets."""
    if not sheets:
        return
    try:
        sheets.spreadsheets().values().append(
            spreadsheetId=GOOGLE_SHEETS_ID,
            range="'PhoneOutreach'!A:H",
            valueInputOption="USER_ENTERED",
            insertDataOption="INSERT_ROWS",
            body={"values": [[
                name, phone, city, demo_url,
                "yes" if status == "telegram_sent" else "no",
                status,
                notes,
                datetime.now().isoformat(),
            ]]},
        ).execute()
    except Exception as e:
        print(f"    Sheets log error: {e}")


def main():
    parser = argparse.ArgumentParser(description="Send phone-only leads to Telegram for manual SMS")
    parser.add_argument("--input", default="data/demo-deploys.csv")
    parser.add_argument("--lead", help="Single lead name")
    parser.add_argument("--phone", help="Phone for single lead")
    parser.add_argument("--url", help="Demo URL for single lead")
    parser.add_argument("--city", default="CA")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if not TELEGRAM_TOKEN or not TELEGRAM_CHAT_ID:
        print("ERROR: TELEGRAM_BOT_TOKEN_LF and TELEGRAM_CHAT_ID_LF must be set in .env")
        sys.exit(1)

    # Single lead mode
    if args.lead:
        name = args.lead
        phone = args.phone or "N/A"
        url = args.url or ""
        city = args.city

        print(f"Phone Outreach — {name}")
        print(f"  Phone: {phone}")
        print(f"  Demo:  {url}")

        sms_ok, photo_ok = outreach_lead(name, phone, url, city, args.dry_run)
        if sms_ok:
            print(f"  -> SMS sent to Telegram")
            if photo_ok:
                print(f"  -> Screenshot sent to Telegram")
            sheets = get_sheets_client()
            if sheets and not args.dry_run:
                ensure_phoneoutreach_sheet(sheets)
                log_to_sheets(sheets, name, phone, city, url, "telegram_sent",
                              "screenshot_sent" if photo_ok else "no_screenshot")
        else:
            print(f"  FAILED to send Telegram")
        return

    # Batch mode — read deploy log
    input_path = Path(args.input)
    if not input_path.exists():
        print(f"ERROR: {input_path} not found.")
        sys.exit(1)

    with open(input_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        leads = list(reader)

    # Filter: leads WITHOUT email (phone-only outreach)
    phone_leads = [l for l in leads if not l.get("email", "").strip()]

    print(f"Phone Outreach — {len(phone_leads)} leads without email")

    sheets = get_sheets_client()
    if sheets and not args.dry_run:
        ensure_phoneoutreach_sheet(sheets)

    sent = 0
    for lead in phone_leads:
        name = lead.get("business_name", "Unknown")
        phone = lead.get("phone", "").strip()
        city = lead.get("city", "Unknown")
        url = lead.get("demo_url", "")

        if not phone:
            print(f"  SKIP {name} — no phone number available")
            if sheets and not args.dry_run:
                log_to_sheets(sheets, name, phone or "N/A", city, url, "no_phone", "Need to find phone number")
            continue

        print(f"  {name} | {phone} | {url}")

        sms_ok, photo_ok = outreach_lead(name, phone, url, city, args.dry_run)
        if sms_ok:
            status = "telegram_sent"
            notes = "screenshot_sent" if photo_ok else "no_screenshot"
            print(f"    -> SMS sent" + (" + screenshot" if photo_ok else " (no screenshot)"))
            if sheets and not args.dry_run:
                log_to_sheets(sheets, name, phone, city, url, status, notes)
            sent += 1
        else:
            print(f"    -> Telegram FAILED")
            if sheets and not args.dry_run:
                log_to_sheets(sheets, name, phone, city, url, "telegram_failed", "")

    print(f"\n{'='*60}")
    print(f"Sent to Telegram: {sent}/{len(phone_leads)}")
    if sheets:
        print(f"Google Sheets: https://docs.google.com/spreadsheets/d/{GOOGLE_SHEETS_ID}")


if __name__ == "__main__":
    main()
