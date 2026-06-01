"""
Cold Email Campaign Sender — HTML + Screenshot + Tracking.

Sends HTML emails with embedded screenshot, demo page link,
and tracks everything in Google Sheets.

Usage:
    python scripts/send-campaign.py --input data/leads-welders-ca.csv
    python scripts/send-campaign.py --input data/leads-welders-ca.csv --dry-run
    python scripts/send-campaign.py --input data/leads-welders-ca.csv --lang es
    python scripts/send-campaign.py --input data/leads-welders-ca.csv --start 0 --count 10

Depends on deploy-demo.py and screenshot.py being run first.
"""

import os
import sys
import csv
import random
import smtplib
import argparse
import time
import json
from pathlib import Path
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.image import MIMEImage
from email.utils import formataddr

from dotenv import load_dotenv

load_dotenv()

# ── Config ──────────────────────────────────────────────────────────

SMTP_HOST = os.getenv("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASS = os.getenv("SMTP_PASS", "")
FROM_EMAIL = os.getenv("FROM_EMAIL", SMTP_USER)
FROM_NAME = os.getenv("FROM_NAME", "Daniel Ortega")

GOOGLE_SHEETS_ID = os.getenv("GOOGLE_SHEETS_ID", "")
GOOGLE_SERVICE_ACCOUNT_EMAIL = os.getenv("GOOGLE_SERVICE_ACCOUNT_EMAIL", "")
GOOGLE_PRIVATE_KEY = os.getenv("GOOGLE_PRIVATE_KEY", "")

DELAY_BETWEEN = 12
SCREENSHOT_DIR = Path("screenshots")
DEMO_LOG = Path("data/demo-deploys.csv")
CAMPAIGN_LOG = Path("data/campaign-log.csv")


# ── Google Sheets ───────────────────────────────────────────────────

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


def ensure_campaign_sheet(sheets):
    """Ensure the CampaignTracker sheet exists with headers."""
    if not sheets:
        return
    try:
        sheets.spreadsheets().values().get(
            spreadsheetId=GOOGLE_SHEETS_ID,
            range="'CampaignTracker'!A1:K1",
        ).execute()
    except Exception:
        # Create sheet
        sheets.spreadsheets().batchUpdate(
            spreadsheetId=GOOGLE_SHEETS_ID,
            body={"requests": [{"addSheet": {"properties": {"title": "CampaignTracker"}}}]},
        ).execute()
        # Write headers
        sheets.spreadsheets().values().update(
            spreadsheetId=GOOGLE_SHEETS_ID,
            range="'CampaignTracker'!A1:K1",
            valueInputOption="USER_ENTERED",
            body={"values": [[
                "Lead ID", "Business Name", "City", "Email", "Phone",
                "Demo URL", "Email Sent", "Email Status",
                "Opened Demo", "Responded", "Follow-ups"
            ]]},
        ).execute()
        print("  Created 'CampaignTracker' sheet.")


def log_to_sheets(sheets, lead: dict, demo_url: str, status: str):
    """Log email send to Google Sheets."""
    if not sheets:
        return
    try:
        name = lead.get("business_name", "")
        city = lead.get("city", "")
        email = lead.get("email", "")
        phone = lead.get("phone", "")
        slug = name.lower().strip().replace(" ", "-").replace("'", "")[:40]

        sheets.spreadsheets().values().append(
            spreadsheetId=GOOGLE_SHEETS_ID,
            range="'CampaignTracker'!A:K",
            valueInputOption="USER_ENTERED",
            insertDataOption="INSERT_ROWS",
            body={"values": [[
                slug, name, city, email, phone,
                demo_url,
                datetime.now().isoformat(),
                status,
                "no",  # opened demo
                "no",  # responded
                0,     # follow-ups
            ]]},
        ).execute()
    except Exception as e:
        print(f"    Sheets log error: {e}")


# ── Template ────────────────────────────────────────────────────────

def load_html_template(lang: str = "en") -> str:
    """Load HTML email template."""
    filename = f"email-welder{'-es' if lang == 'es' else ''}.html"
    template_path = Path("templates") / filename
    if not template_path.exists():
        # Fall back to English
        template_path = Path("templates") / "email-welder.html"
    if template_path.exists():
        return template_path.read_text(encoding="utf-8")
    # Fallback: build inline
    return build_fallback_template(lang)


def get_screenshot_cid(name: str) -> str | None:
    """Find screenshot for a business and return its path."""
    slug = name.lower().strip().replace(" ", "-").replace("'", "").replace(".", "")[:40]
    path = SCREENSHOT_DIR / f"{slug}.png"
    if path.exists():
        return str(path)
    # Handle naming quirks (double dots, etc.)
    candidates = list(SCREENSHOT_DIR.glob(f"{slug}*.png")) if SCREENSHOT_DIR.exists() else []
    return str(candidates[0]) if candidates else None


def get_demo_url(name: str) -> str:
    """Find demo URL from deploy log."""
    if not DEMO_LOG.exists():
        return ""
    with open(DEMO_LOG, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row.get("business_name", "") == name:
                return row.get("demo_url", "")
    return ""


def build_email(lead: dict, lang: str = "en") -> tuple[str, str, str | None]:
    """Build HTML email. Returns (subject, html_body, screenshot_path)."""
    name = lead.get("business_name", "your business")
    city = lead.get("city", "your area").replace(" CA", "")
    first = name.split()[0] if name else "there"

    demo_url = get_demo_url(name)
    screenshot_path = get_screenshot_cid(name)

    if lang == "es":
        subject = f"{first} — te arme esto para {name}"
    else:
        subject = f"{first} — quick look at {name} online"

    html = load_html_template(lang)
    html = html.replace("{{FIRST_NAME}}", first)
    html = html.replace("{{BUSINESS_NAME}}", name)
    html = html.replace("{{CITY}}", city)
    html = html.replace("{{DEMO_URL}}", demo_url)

    return subject, html, screenshot_path


def build_fallback_template(lang: str = "en") -> str:
    """Minimal HTML fallback template."""
    if lang == "es":
        return """<html><body style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;">
<h2>{{FIRST_NAME}},</h2>
<p>Te arme una pagina de prueba para <strong>{{BUSINESS_NAME}}</strong> en {{CITY}}.</p>
<p><a href="{{DEMO_URL}}"><img src="cid:screenshot" alt="{{BUSINESS_NAME}} preview" style="max-width:100%;border-radius:12px"></a></p>
<p><strong><a href="{{DEMO_URL}}">Ver pagina completa →</a></strong></p>
<p>Si te interesa, dime y lo afinamos en una llamada de 15 minutos.</p>
<p>Daniel<br>daniel@leaderforgeai.com<br>(858) 465-8919</p>
</body></html>"""
    else:
        return """<html><body style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;">
<h2>{{FIRST_NAME}},</h2>
<p>I built a quick demo page for <strong>{{BUSINESS_NAME}}</strong> in {{CITY}}.</p>
<p><a href="{{DEMO_URL}}"><img src="cid:screenshot" alt="{{BUSINESS_NAME}} preview" style="max-width:100%;border-radius:12px"></a></p>
<p><strong><a href="{{DEMO_URL}}">See full page →</a></strong></p>
<p>If you like it, let me know and we'll dial it in on a 15-minute call.</p>
<p>Daniel<br>daniel@leaderforgeai.com<br>(858) 465-8919</p>
</body></html>"""


def send_email(to_email: str, subject: str, html_body: str, screenshot_path: str | None) -> bool:
    """Send HTML email with embedded screenshot via SMTP."""
    if not to_email:
        return False

    msg = MIMEMultipart("related")
    msg["From"] = formataddr((FROM_NAME, FROM_EMAIL))
    msg["To"] = to_email
    msg["Subject"] = subject

    # Attach HTML
    msg.attach(MIMEText(html_body, "html", "utf-8"))

    # Attach screenshot as inline image
    if screenshot_path and os.path.exists(screenshot_path):
        with open(screenshot_path, "rb") as f:
            img = MIMEImage(f.read())
            img.add_header("Content-ID", "<screenshot>")
            img.add_header("Content-Disposition", "inline", filename="preview.png")
            msg.attach(img)

    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15) as server:
            server.starttls()
            server.login(SMTP_USER, SMTP_PASS)
            server.sendmail(FROM_EMAIL, [to_email], msg.as_string())
        return True
    except Exception as e:
        print(f"    SMTP ERROR: {e}")
        return False


def log_campaign(lead: dict, demo_url: str, status: str, lang: str):
    """Log to campaign CSV."""
    new_file = not CAMPAIGN_LOG.exists()
    CAMPAIGN_LOG.parent.mkdir(parents=True, exist_ok=True)
    with open(CAMPAIGN_LOG, "a", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        if new_file:
            writer.writerow(["business_name", "email", "city", "demo_url", "lang", "status", "sent_at"])
        writer.writerow([
            lead.get("business_name", ""),
            lead.get("email", ""),
            lead.get("city", ""),
            demo_url,
            lang,
            status,
            datetime.now().isoformat(),
        ])


def main():
    parser = argparse.ArgumentParser(description="Send HTML cold email campaign with screenshots")
    parser.add_argument("--input", default="data/leads-welders-ca.csv")
    parser.add_argument("--start", type=int, default=0)
    parser.add_argument("--count", type=int, default=0)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--lang", choices=["en", "es"], default="en")
    parser.add_argument("--delay", type=int, default=DELAY_BETWEEN)
    parser.add_argument("--random-delay", action="store_true", help="Randomize delay 40-60s between emails")
    parser.add_argument("--log", default="data/campaign-log.csv")
    args = parser.parse_args()

    if not SMTP_USER or not SMTP_PASS:
        print("ERROR: SMTP_USER and SMTP_PASS not set in .env")
        sys.exit(1)

    input_path = Path(args.input)
    if not input_path.exists():
        print(f"ERROR: {input_path} not found.")
        sys.exit(1)

    with open(input_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        leads = list(reader)

    # Filter: leads with emails
    leads_with_email = [l for l in leads if l.get("email", "").strip()]
    leads_no_email = [l for l in leads if not l.get("email", "").strip()]

    target = leads_with_email[args.start:]
    if args.count > 0:
        target = target[:args.count]

    print(f"Email Campaign — {len(target)} leads ({args.lang})")
    print(f"  With email:    {len(leads_with_email)}")
    print(f"  Without email: {len(leads_no_email)} (need phone outreach)")
    print(f"  From: {FROM_NAME} <{FROM_EMAIL}>")
    print(f"  Language: {args.lang}")
    if args.dry_run:
        print("  DRY RUN\n")
    else:
        print()

    # Google Sheets
    sheets = get_sheets_client()
    if sheets and not args.dry_run:
        ensure_campaign_sheet(sheets)

    sent = 0
    for i, lead in enumerate(target):
        name = lead.get("business_name", "Unknown")
        email = lead.get("email", "")
        city = lead.get("city", "Unknown")
        demo_url = get_demo_url(name)

        print(f"\n  [{args.start + i + 1}/{len(leads_with_email)}] {name}")
        print(f"    City: {city}  |  Email: {email}")
        print(f"    Demo: {demo_url or 'NOT DEPLOYED'}")

        subject, html_body, screenshot_path = build_email(lead, args.lang)

        if args.dry_run:
            print(f"    Subject: {subject}")
            print(f"    Screenshot: {screenshot_path or 'NONE'}")
            continue

        success = send_email(email, subject, html_body, screenshot_path)
        status = "sent" if success else "failed"

        log_campaign(lead, demo_url, status, args.lang)
        if sheets:
            log_to_sheets(sheets, lead, demo_url, status)

        print(f"    => {status.upper()}")

        if success:
            sent += 1
            delay = random.randint(40, 60) if args.random_delay else args.delay
            time.sleep(delay)

    print(f"\n{'='*60}")
    print(f"Sent: {sent} | Failed: {len(target) - sent}")
    if len(leads_no_email) > 0:
        print(f"Skipped (no email): {len(leads_no_email)} — need phone outreach")
    print(f"Google Sheets: https://docs.google.com/spreadsheets/d/{GOOGLE_SHEETS_ID}")


if __name__ == "__main__":
    main()
