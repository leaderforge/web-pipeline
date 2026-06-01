"""
Automated follow-up sequence for cold email campaign.

Checks Google Sheets for leads without response, sends follow-ups
at predefined intervals. Follows the cadence:
- Day 3: Gentle reminder
- Day 7: Break-up email

Usage:
    python scripts/follow-up.py
    python scripts/follow-up.py --dry-run
    python scripts/follow-up.py --lang en
"""

import os
import re
import sys
import csv
import smtplib
import argparse
import time
from pathlib import Path
from datetime import datetime, timezone
from email.mime.text import MIMEText
from email.mime.image import MIMEImage
from email.mime.multipart import MIMEMultipart
from email.utils import formataddr

from dotenv import load_dotenv

load_dotenv()

SMTP_HOST = os.getenv("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASS = os.getenv("SMTP_PASS", "")
FROM_EMAIL = os.getenv("FROM_EMAIL", SMTP_USER)
FROM_NAME = os.getenv("FROM_NAME", "Daniel Ortega")

GOOGLE_SHEETS_ID = os.getenv("GOOGLE_SHEETS_ID", "")
GOOGLE_SERVICE_ACCOUNT_EMAIL = os.getenv("GOOGLE_SERVICE_ACCOUNT_EMAIL", "")
GOOGLE_PRIVATE_KEY = os.getenv("GOOGLE_PRIVATE_KEY", "")

CAMPAIGN_LOG = Path("data/campaign-log.csv")
FOLLOWUP_LOG = Path("data/followup-log.csv")
SCREENSHOT_DIR = Path("screenshots")

# ── Follow-up templates (HTML) ────────────────────────────────────

FOLLOWUP_DAY3_EN = """<html>
<body style="font-family:'Segoe UI',system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#fafaf9;">
<div style="padding:28px 24px;background:#fff;border-radius:12px;border:1px solid #e5e5e5;">
<p style="font-size:16px;color:#1a1a1a;margin:0 0 14px 0;">Hey {first},</p>
<p style="font-size:15px;color:#444;line-height:1.6;margin:0 0 18px 0;">Just bumping this — in case it got buried. I built a demo page for <strong>{business_name}</strong>:</p>
<p style="text-align:center;margin:0 0 18px 0;"><a href="{demo_url}"><img src="cid:screenshot" alt="{business_name} preview" style="width:100%;max-width:100%;border-radius:8px;border:1px solid #e5e5e5;"></a></p>
<p style="text-align:center;margin:0 0 18px 0;"><a href="{demo_url}" style="display:inline-block;background:#f2610b;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:11px 26px;border-radius:9999px;">Take another look &rarr;</a></p>
<p style="font-size:14px;color:#666;line-height:1.5;margin:0 0 14px 0;">No pressure. If now's not the right time, no worries.</p>
<p style="font-size:13px;color:#999;margin:0;">&mdash; Daniel<br><a href="mailto:daniel@leaderforgeai.com" style="color:#f2610b;">daniel@leaderforgeai.com</a><br>(858) 465-8919</p>
</div>
<div style="text-align:center;margin-top:12px;"><p style="font-size:11px;color:#bbb;">LeaderForge Digital &mdash; <a href="https://www.leaderforge.digital" style="color:#f2610b;">www.leaderforge.digital</a></p></div>
</body></html>"""

FOLLOWUP_DAY3_ES = """<html>
<body style="font-family:'Segoe UI',system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#fafaf9;">
<div style="padding:28px 24px;background:#fff;border-radius:12px;border:1px solid #e5e5e5;">
<p style="font-size:16px;color:#1a1a1a;margin:0 0 14px 0;">{first},</p>
<p style="font-size:15px;color:#444;line-height:1.6;margin:0 0 18px 0;">Solo para recordarte — por si se perdio. Te arme una pagina demo para <strong>{business_name}</strong>:</p>
<p style="text-align:center;margin:0 0 18px 0;"><a href="{demo_url}"><img src="cid:screenshot" alt="{business_name} preview" style="width:100%;max-width:100%;border-radius:8px;border:1px solid #e5e5e5;"></a></p>
<p style="text-align:center;margin:0 0 18px 0;"><a href="{demo_url}" style="display:inline-block;background:#f2610b;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:11px 26px;border-radius:9999px;">Mira tu pagina &rarr;</a></p>
<p style="font-size:14px;color:#666;line-height:1.5;margin:0 0 14px 0;">Sin presion. Si no es el momento, no hay problema.</p>
<p style="font-size:13px;color:#999;margin:0;">&mdash; Daniel<br><a href="mailto:daniel@leaderforgeai.com" style="color:#f2610b;">daniel@leaderforgeai.com</a><br>(858) 465-8919</p>
</div>
<div style="text-align:center;margin-top:12px;"><p style="font-size:11px;color:#bbb;">LeaderForge Digital &mdash; <a href="https://www.leaderforge.digital" style="color:#f2610b;">www.leaderforge.digital</a></p></div>
</body></html>"""

FOLLOWUP_DAY7_EN = """<html>
<body style="font-family:'Segoe UI',system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#fafaf9;">
<div style="padding:28px 24px;background:#fff;border-radius:12px;border:1px solid #e5e5e5;">
<p style="font-size:16px;color:#1a1a1a;margin:0 0 14px 0;">{first},</p>
<p style="font-size:15px;color:#444;line-height:1.6;margin:0 0 18px 0;">Last one from me — I'll leave you alone after this. The demo for <strong>{business_name}</strong> is still up:</p>
<p style="text-align:center;margin:0 0 18px 0;"><a href="{demo_url}"><img src="cid:screenshot" alt="{business_name} preview" style="width:100%;max-width:100%;border-radius:8px;border:1px solid #e5e5e5;"></a></p>
<p style="text-align:center;margin:0 0 18px 0;"><a href="{demo_url}" style="display:inline-block;background:#f2610b;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:11px 26px;border-radius:9999px;">See your demo &rarr;</a></p>
<p style="font-size:14px;color:#666;line-height:1.5;margin:0 0 8px 0;">If you ever want to get serious about your online presence, the door's open.</p>
<p style="font-size:14px;color:#666;line-height:1.5;margin:0 0 14px 0;">Otherwise — wish you a killer {month}.</p>
<p style="font-size:13px;color:#999;margin:0;">&mdash; Daniel<br><a href="mailto:daniel@leaderforgeai.com" style="color:#f2610b;">daniel@leaderforgeai.com</a><br>(858) 465-8919</p>
</div>
<div style="text-align:center;margin-top:12px;"><p style="font-size:11px;color:#bbb;">LeaderForge Digital &mdash; <a href="https://www.leaderforge.digital" style="color:#f2610b;">www.leaderforge.digital</a></p></div>
</body></html>"""

FOLLOWUP_DAY7_ES = """<html>
<body style="font-family:'Segoe UI',system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#fafaf9;">
<div style="padding:28px 24px;background:#fff;border-radius:12px;border:1px solid #e5e5e5;">
<p style="font-size:16px;color:#1a1a1a;margin:0 0 14px 0;">{first},</p>
<p style="font-size:15px;color:#444;line-height:1.6;margin:0 0 18px 0;">Ultimo mensaje — ya no te molesto mas. La pagina demo de <strong>{business_name}</strong> sigue ahi:</p>
<p style="text-align:center;margin:0 0 18px 0;"><a href="{demo_url}"><img src="cid:screenshot" alt="{business_name} preview" style="width:100%;max-width:100%;border-radius:8px;border:1px solid #e5e5e5;"></a></p>
<p style="text-align:center;margin:0 0 18px 0;"><a href="{demo_url}" style="display:inline-block;background:#f2610b;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:11px 26px;border-radius:9999px;">Ver tu demo &rarr;</a></p>
<p style="font-size:14px;color:#666;line-height:1.5;margin:0 0 8px 0;">Si algun dia quieres poner en serio tu presencia online, aqui estoy.</p>
<p style="font-size:14px;color:#666;line-height:1.5;margin:0 0 14px 0;">Si no — te deseo un excelente {month}.</p>
<p style="font-size:13px;color:#999;margin:0;">&mdash; Daniel<br><a href="mailto:daniel@leaderforgeai.com" style="color:#f2610b;">daniel@leaderforgeai.com</a><br>(858) 465-8919</p>
</div>
<div style="text-align:center;margin-top:12px;"><p style="font-size:11px;color:#bbb;">LeaderForge Digital &mdash; <a href="https://www.leaderforge.digital" style="color:#f2610b;">www.leaderforge.digital</a></p></div>
</body></html>"""


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


def get_campaign_data(sheets) -> list[dict]:
    """Read CampaignTracker sheet and return rows."""
    if not sheets:
        return []
    try:
        result = sheets.spreadsheets().values().get(
            spreadsheetId=GOOGLE_SHEETS_ID,
            range="'CampaignTracker'!A:K",
        ).execute()
        values = result.get("values", [])
        if len(values) < 2:
            return []

        headers = values[0]
        rows = []
        for row in values[1:]:
            d = {}
            for i, h in enumerate(headers):
                d[h.lower()] = row[i] if i < len(row) else ""
            rows.append(d)
        return rows
    except Exception as e:
        print(f"  Sheets read error: {e}")
        return []


def update_followup_count(sheets, lead_id: str, count: int):
    """Update follow-up count in sheet."""
    if not sheets:
        return
    try:
        result = sheets.spreadsheets().values().get(
            spreadsheetId=GOOGLE_SHEETS_ID,
            range="'CampaignTracker'!A:A",
        ).execute()
        values = result.get("values", [])
        for i, row in enumerate(values):
            if row and row[0] == lead_id:
                row_index = i + 1  # 1-indexed
                sheets.spreadsheets().values().update(
                    spreadsheetId=GOOGLE_SHEETS_ID,
                    range=f"'CampaignTracker'!K{row_index}",
                    valueInputOption="USER_ENTERED",
                    body={"values": [[count]]},
                ).execute()
                break
    except Exception as e:
        print(f"    Update error: {e}")


def send_email(to_email: str, subject: str, html_body: str, text_body: str, screenshot_path: str | None = None) -> bool:
    """Send an HTML follow-up email, with optional embedded screenshot."""
    if not to_email:
        return False

    png = Path(screenshot_path) if screenshot_path else None
    if png and png.exists():
        msg = MIMEMultipart("related")
        msg.attach(MIMEText(text_body, "plain", "utf-8"))
        msg.attach(MIMEText(html_body, "html", "utf-8"))
        img_data = png.read_bytes()
        img = MIMEImage(img_data, _subtype="png")
        img.add_header("Content-ID", "<screenshot>")
        img.add_header("Content-Disposition", "inline", filename="demo.png")
        msg.attach(img)
    else:
        msg = MIMEMultipart("alternative")
        msg.attach(MIMEText(text_body, "plain", "utf-8"))
        msg.attach(MIMEText(html_body, "html", "utf-8"))

    msg["From"] = formataddr((FROM_NAME, FROM_EMAIL))
    msg["To"] = to_email
    msg["Subject"] = subject

    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15) as server:
            server.starttls()
            server.login(SMTP_USER, SMTP_PASS)
            server.sendmail(FROM_EMAIL, [to_email], msg.as_string())
        return True
    except Exception as e:
        print(f"    SMTP ERROR: {e}")
        return False


def log_followup(lead_id: str, name: str, email: str, followup_type: str, status: str):
    """Log follow-up."""
    new_file = not FOLLOWUP_LOG.exists()
    FOLLOWUP_LOG.parent.mkdir(parents=True, exist_ok=True)
    with open(FOLLOWUP_LOG, "a", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        if new_file:
            writer.writerow(["lead_id", "name", "email", "type", "status", "sent_at"])
        writer.writerow([lead_id, name, email, followup_type, status, datetime.now().isoformat()])


def main():
    parser = argparse.ArgumentParser(description="Send follow-up emails based on campaign data")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--lang", choices=["en", "es"], default="en")
    args = parser.parse_args()

    sheets = get_sheets_client()
    if not sheets:
        print("ERROR: Google Sheets not configured. Set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY.")
        sys.exit(1)

    rows = get_campaign_data(sheets)
    if not rows:
        print("No campaign data found in Google Sheets.")
        return

    print(f"Follow-up Engine — {len(rows)} campaign rows")
    print(f"  Language: {args.lang}")
    if args.dry_run:
        print("  DRY RUN\n")
    else:
        print()

    now = datetime.now(timezone.utc)
    sent = 0

    for row in rows:
        lead_id = row.get("lead id", "")
        name = row.get("business name", "")
        email = row.get("email", "")
        demo_url = row.get("demo url", "")
        responded = row.get("responded", "no").lower()
        opened = row.get("opened demo", "no").lower()
        email_status = row.get("email status", "")
        followups = int(row.get("follow-ups", "0"))
        sent_at_str = row.get("email sent", "")

        if not email or email_status == "failed":
            continue
        if responded == "yes":
            continue  # Already responded — don't follow up

        # Parse sent date
        try:
            sent_at = datetime.fromisoformat(sent_at_str)
        except (ValueError, TypeError):
            continue

        days_since = (now - sent_at.replace(tzinfo=timezone.utc)).days

        first = name.split()[0] if name else "there"
        month = now.strftime("%B")

        if followups == 0 and 2 <= days_since <= 5:
            subject = f"Re: {first} — quick look at {name} online" if args.lang == "en" else f"Re: {first} — te arme esto para {name}"
            html_body = (FOLLOWUP_DAY3_ES if args.lang == "es" else FOLLOWUP_DAY3_EN).format(
                first=first, business_name=name, demo_url=demo_url
            )
            ftype = "day3"
        elif followups == 1 and 6 <= days_since <= 10:
            subject = f"Re: {first} — last one" if args.lang == "en" else f"Re: {first} — ultimo"
            html_body = (FOLLOWUP_DAY7_ES if args.lang == "es" else FOLLOWUP_DAY7_EN).format(
                first=first, business_name=name, month=month, demo_url=demo_url
            )
            ftype = "day7"
        else:
            continue  # Not time yet

        text_body = re.sub(r'<[^>]+>', '', html_body).strip()

        print(f"  {name} ({lead_id}) — {ftype} follow-up ({days_since}d since send)")
        print(f"    To: {email}")
        print(f"    Subject: {subject}")

        if args.dry_run:
            print(f"    Body: {text_body[:80]}...")
            continue

        # Look up screenshot
        slug = name.lower().strip().replace(" ", "-").replace("'", "").replace(".", "")[:40]
        screenshot = SCREENSHOT_DIR / f"{slug}.png"
        if not screenshot.exists():
            candidates = list(SCREENSHOT_DIR.glob(f"{slug}*.png")) if SCREENSHOT_DIR.exists() else []
            screenshot = candidates[0] if candidates else None

        success = send_email(email, subject, html_body, text_body, str(screenshot) if screenshot and screenshot.exists() else None)
        status = "sent" if success else "failed"
        log_followup(lead_id, name, email, ftype, status)

        if success:
            update_followup_count(sheets, lead_id, followups + 1)
            sent += 1
            print(f"    => SENT")
            time.sleep(8)

    print(f"\n{'='*60}")
    print(f"Follow-ups sent: {sent}")
    print(f"Log: {FOLLOWUP_LOG}")


if __name__ == "__main__":
    main()
