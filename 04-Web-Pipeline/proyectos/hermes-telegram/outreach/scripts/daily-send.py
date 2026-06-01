"""
Daily email sender for Railway cron. Handles initial sends + follow-ups.

3-touch cadence: Day 0 (initial) → Day 3 (follow-up) → Day 7 (break-up)
Warm-up limits: 10/day → 15/day → 20/day. No weekends.

Called by Telegram bot APScheduler at 9am PT (16:00 UTC).

Usage:
    python scripts/daily-send.py
    python scripts/daily-send.py --dry-run
    python scripts/daily-send.py --limit 5
    python scripts/daily-send.py --mode follow-up
    python scripts/daily-send.py --json   # JSON output for bot consumption
"""

import os
import sys
import csv
import json
import re
import smtplib
import argparse
import time
import random
from pathlib import Path
from datetime import datetime, timezone, date
from email.mime.text import MIMEText
from email.mime.image import MIMEImage
from email.mime.multipart import MIMEMultipart
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

ROOT = Path(__file__).parent.parent
LEAD_CSV = ROOT / "data" / "lead-queue.csv"
DEPLOY_CSV = ROOT / "data" / "demo-deploys-20.csv"
SEND_LOG = ROOT / "data" / "daily-send-log.csv"
SCREENSHOT_DIR = ROOT / "screenshots"
TEMPLATE_DIR = ROOT / "templates"

DELAY_MIN = 120  # Minimum seconds between emails (2 min)
DELAY_MAX = 240  # Maximum seconds between emails (4 min)

# Daily send limits (warm-up schedule)
WARMUP_SCHEDULE = {
    1: 10, 2: 10, 3: 10, 4: 10, 5: 10,
    6: 15, 7: 15, 8: 15, 9: 15, 10: 15,
}.get


# ── Templates ───────────────────────────────────────────────────────

EMAIL_INITIAL_EN = """<html>
<body style="font-family:'Segoe UI',system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#fafaf9;">
<div style="padding:28px 24px;background:#fff;border-radius:12px;border:1px solid #e5e5e5;">
<p style="font-size:16px;color:#1a1a1a;margin:0 0 14px 0;">Hey {first},</p>
<p style="font-size:15px;color:#444;line-height:1.6;margin:0 0 18px 0;">I built a quick demo page for <strong>{business_name}</strong> in {city}:</p>
<p style="text-align:center;margin:0 0 18px 0;"><a href="{demo_url}"><img src="cid:screenshot" alt="{business_name} preview" style="width:100%;max-width:100%;border-radius:8px;border:1px solid #e5e5e5;"></a></p>
<p style="text-align:center;margin:0 0 18px 0;"><a href="{demo_url}" style="display:inline-block;background:#f2610b;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:11px 26px;border-radius:9999px;">See your demo &rarr;</a></p>
<p style="font-size:14px;color:#666;line-height:1.5;margin:0 0 14px 0;">If you like it, let me know and we'll dial it in on a 15-minute call. No cost to keep it up — just want to show you what's possible.</p>
<p style="font-size:13px;color:#999;margin:0;">&mdash; Daniel<br><a href="mailto:daniel@leaderforgeai.com" style="color:#f2610b;">daniel@leaderforgeai.com</a><br>(858) 465-8919</p>
</div>
<div style="text-align:center;margin-top:12px;"><p style="font-size:11px;color:#bbb;">LeaderForge Digital &mdash; <a href="https://www.leaderforge.digital" style="color:#f2610b;">www.leaderforge.digital</a></p></div>
</body></html>"""

EMAIL_INITIAL_ES = """<html>
<body style="font-family:'Segoe UI',system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#fafaf9;">
<div style="padding:28px 24px;background:#fff;border-radius:12px;border:1px solid #e5e5e5;">
<p style="font-size:16px;color:#1a1a1a;margin:0 0 14px 0;">{first},</p>
<p style="font-size:15px;color:#444;line-height:1.6;margin:0 0 18px 0;">Te arme una pagina demo para <strong>{business_name}</strong> en {city}:</p>
<p style="text-align:center;margin:0 0 18px 0;"><a href="{demo_url}"><img src="cid:screenshot" alt="{business_name} preview" style="width:100%;max-width:100%;border-radius:8px;border:1px solid #e5e5e5;"></a></p>
<p style="text-align:center;margin:0 0 18px 0;"><a href="{demo_url}" style="display:inline-block;background:#f2610b;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:11px 26px;border-radius:9999px;">Ver tu pagina &rarr;</a></p>
<p style="font-size:14px;color:#666;line-height:1.5;margin:0 0 14px 0;">Si te gusta, dime y lo afinamos en una llamada de 15 minutos. Sin costo mantenerla — solo quiero mostrarte lo que es posible.</p>
<p style="font-size:13px;color:#999;margin:0;">&mdash; Daniel<br><a href="mailto:daniel@leaderforgeai.com" style="color:#f2610b;">daniel@leaderforgeai.com</a><br>(858) 465-8919</p>
</div>
<div style="text-align:center;margin-top:12px;"><p style="font-size:11px;color:#bbb;">LeaderForge Digital &mdash; <a href="https://www.leaderforge.digital" style="color:#f2610b;">www.leaderforge.digital</a></p></div>
</body></html>"""

EMAIL_FOLLOWUP_EN = """<html>
<body style="font-family:'Segoe UI',system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#fafaf9;">
<div style="padding:28px 24px;background:#fff;border-radius:12px;border:1px solid #e5e5e5;">
<p style="font-size:16px;color:#1a1a1a;margin:0 0 14px 0;">Hey {first},</p>
<p style="font-size:15px;color:#444;line-height:1.6;margin:0 0 18px 0;">Just bumping this — in case it got buried. The demo for <strong>{business_name}</strong> is still up:</p>
<p style="text-align:center;margin:0 0 18px 0;"><a href="{demo_url}"><img src="cid:screenshot" alt="{business_name} preview" style="width:100%;max-width:100%;border-radius:8px;border:1px solid #e5e5e5;"></a></p>
<p style="text-align:center;margin:0 0 18px 0;"><a href="{demo_url}" style="display:inline-block;background:#f2610b;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:11px 26px;border-radius:9999px;">Take another look &rarr;</a></p>
<p style="font-size:14px;color:#666;line-height:1.5;margin:0 0 14px 0;">No pressure. If now's not the right time, no worries.</p>
<p style="font-size:13px;color:#999;margin:0;">&mdash; Daniel<br><a href="mailto:daniel@leaderforgeai.com" style="color:#f2610b;">daniel@leaderforgeai.com</a><br>(858) 465-8919</p>
</div>
<div style="text-align:center;margin-top:12px;"><p style="font-size:11px;color:#bbb;">LeaderForge Digital &mdash; <a href="https://www.leaderforge.digital" style="color:#f2610b;">www.leaderforge.digital</a></p></div>
</body></html>"""

EMAIL_BREAKUP_EN = """<html>
<body style="font-family:'Segoe UI',system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#fafaf9;">
<div style="padding:28px 24px;background:#fff;border-radius:12px;border:1px solid #e5e5e5;">
<p style="font-size:16px;color:#1a1a1a;margin:0 0 14px 0;">{first},</p>
<p style="font-size:15px;color:#444;line-height:1.6;margin:0 0 18px 0;">Last one from me — I'll leave you alone after this. The demo for <strong>{business_name}</strong> is still up:</p>
<p style="text-align:center;margin:0 0 18px 0;"><a href="{demo_url}"><img src="cid:screenshot" alt="{business_name} preview" style="width:100%;max-width:100%;border-radius:8px;border:1px solid #e5e5e5;"></a></p>
<p style="text-align:center;margin:0 0 18px 0;"><a href="{demo_url}" style="display:inline-block;background:#f2610b;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:11px 26px;border-radius:9999px;">See your demo &rarr;</a></p>
<p style="font-size:14px;color:#666;line-height:1.5;margin:0 0 8px 0;">If you ever want to get serious about your online presence, the door's open.</p>
<p style="font-size:14px;color:#666;line-height:1.5;margin:0 0 14px 0;">Otherwise — wish you a great {month}.</p>
<p style="font-size:13px;color:#999;margin:0;">&mdash; Daniel<br><a href="mailto:daniel@leaderforgeai.com" style="color:#f2610b;">daniel@leaderforgeai.com</a><br>(858) 465-8919</p>
</div>
<div style="text-align:center;margin-top:12px;"><p style="font-size:11px;color:#bbb;">LeaderForge Digital &mdash; <a href="https://www.leaderforge.digital" style="color:#f2610b;">www.leaderforge.digital</a></p></div>
</body></html>"""


# ── Helpers ─────────────────────────────────────────────────────────

def load_leads() -> list[dict]:
    """Load leads from master CSV."""
    if not LEAD_CSV.exists():
        return []
    with open(LEAD_CSV, encoding="utf-8") as f:
        return list(csv.DictReader(f))


def load_demo_urls() -> dict[str, str]:
    """Return {business_name: demo_url} mapping."""
    if not DEPLOY_CSV.exists():
        return {}
    urls = {}
    with open(DEPLOY_CSV, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            name = row.get("business_name", "").strip()
            url = row.get("demo_url", "").strip()
            if name and url:
                urls[name] = url
    return urls


def slugify(name: str) -> str:
    return name.lower().strip().replace(" & ", " ").replace(" ", "-").replace("'", "").replace(".", "").replace("&", "")[:40]


def find_screenshot(name: str) -> str | None:
    """Find screenshot for a business (png or jpg)."""
    slug = slugify(name)
    for ext in (".jpg", ".png"):
        path = SCREENSHOT_DIR / f"{slug}{ext}"
        if path.exists():
            return str(path)
    candidates = list(SCREENSHOT_DIR.glob(f"{slug}*.*")) if SCREENSHOT_DIR.exists() else []
    return str(candidates[0]) if candidates else None


def send_email(to_email: str, subject: str, html_body: str, screenshot_path: str | None = None) -> bool:
    """Send HTML email with optional embedded screenshot."""
    if not to_email:
        return False

    text_body = re.sub(r"<[^>]+>", "", html_body).strip()

    png = Path(screenshot_path) if screenshot_path else None
    if png and png.exists():
        msg = MIMEMultipart("related")
        # Wrap text+HTML in multipart/alternative so email clients render HTML
        alt_part = MIMEMultipart("alternative")
        alt_part.attach(MIMEText(text_body, "plain", "utf-8"))
        alt_part.attach(MIMEText(html_body, "html", "utf-8"))
        msg.attach(alt_part)
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


def log_send(lead_id: str, name: str, email: str, email_type: str, status: str, demo_url: str = ""):
    """Append to daily send log."""
    new_file = not SEND_LOG.exists()
    SEND_LOG.parent.mkdir(parents=True, exist_ok=True)
    with open(SEND_LOG, "a", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        if new_file:
            writer.writerow(["lead_id", "name", "email", "type", "status", "demo_url", "sent_at"])
        writer.writerow([lead_id, name, email, email_type, status, demo_url, datetime.now().isoformat()])


def update_lead_csv(lead_id: str, email_type: str, demo_url: str = ""):
    """Update the master CSV with email tracking info."""
    if not LEAD_CSV.exists():
        return
    # Read all rows
    with open(LEAD_CSV, encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
        fieldnames = rows[0].keys() if rows else []

    updated = False
    for row in rows:
        if row.get("lead_id", "") == lead_id:
            row["email_sent_at"] = datetime.now().isoformat()
            row["email_status"] = "sent"
            row["funnel_stage"] = email_type  # initial / follow-up / break-up
            if row.get("pipeline_stage", "") == "screenshotted":
                row["pipeline_stage"] = "emailed"
            if demo_url:
                row["demo_url"] = demo_url
            updated = True
            break

    if updated:
        with open(LEAD_CSV, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=list(fieldnames))
            writer.writeheader()
            writer.writerows(rows)


def is_weekend() -> bool:
    """No sends on Saturday (5) or Sunday (6)."""
    return date.today().weekday() in (5, 6)


def get_daily_limit(batch_day: int) -> int:
    """Get max emails for this batch day. Default 20 after day 10."""
    return WARMUP_SCHEDULE(batch_day) or 20


def count_sent_today() -> int:
    """Count emails sent today from the log."""
    if not SEND_LOG.exists():
        return 0
    today = date.today().isoformat()
    count = 0
    with open(SEND_LOG, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row.get("sent_at", "").startswith(today):
                count += 1
    return count


# ── Main logic ──────────────────────────────────────────────────────

def find_initial_sends(leads: list[dict]) -> list[dict]:
    """Leads with pipeline_stage=screenshotted — ready for first email."""
    candidates = []
    for lead in leads:
        email = lead.get("email", "").strip()
        if not email:
            continue
        if lead.get("pipeline_stage", "").strip() != "screenshotted":
            continue
        candidates.append(lead)
    return candidates


def find_followups(leads: list[dict]) -> list[tuple[dict, str]]:
    """Leads due for follow-up or break-up. Returns (lead, type)."""
    now = datetime.now(timezone.utc)
    due = []

    for lead in leads:
        email = lead.get("email", "").strip()
        if not email:
            continue
        sent_str = lead.get("email_sent_at", "").strip()
        if not sent_str:
            continue
        funnel = lead.get("funnel_stage", "").strip()
        responded = lead.get("responded", "").strip().lower()

        if responded == "yes":
            continue

        try:
            sent_at = datetime.fromisoformat(sent_str)
        except ValueError:
            continue

        days_since = (now - sent_at.replace(tzinfo=timezone.utc)).days

        if funnel in ("initial", "scraped", "") and 2 <= days_since <= 5:
            due.append((lead, "follow-up"))
        elif funnel == "follow-up" and 6 <= days_since <= 10:
            due.append((lead, "break-up"))

    return due


def run_send(mode: str = "all", lang: str = "en", limit: int = 0, dry_run: bool = False) -> dict:
    """Main send routine. Returns summary dict for JSON output."""
    if is_weekend():
        return {"status": "skipped", "reason": "weekend", "sent": 0}

    leads = load_leads()
    demo_urls = load_demo_urls()
    already_sent = count_sent_today()

    tasks = []  # List of (lead, email_type, subject, html, screenshot)

    if mode in ("initial", "all"):
        candidates = find_initial_sends(leads)
        for lead in candidates:
            name = lead.get("business_name", "")
            city = lead.get("city", "your area").replace(" CA", "")
            first = name.split()[0] if name else "there"
            demo_url = demo_urls.get(name, "")
            screenshot = find_screenshot(name)

            if lang == "es":
                subject = f"{first} -- te arme esto para {name}"
                tpl = EMAIL_INITIAL_ES
            else:
                subject = f"{first} -- quick look at {name} online"
                tpl = EMAIL_INITIAL_EN

            html = tpl.format(first=first, business_name=name, city=city, demo_url=demo_url)
            tasks.append((lead, "initial", subject, html, screenshot, demo_url))

    if mode in ("follow-up", "all"):
        followups = find_followups(leads)
        for lead, ftype in followups:
            name = lead.get("business_name", "")
            first = name.split()[0] if name else "there"
            demo_url = demo_urls.get(name, lead.get("demo_url", ""))
            screenshot = find_screenshot(name)

            if ftype == "follow-up":
                tpl = EMAIL_FOLLOWUP_EN
                prefix = "Re:"
                subject_line = f"quick look at {name} online"
            else:
                tpl = EMAIL_BREAKUP_EN
                prefix = "Re:"
                subject_line = "last one"
                month = datetime.now().strftime("%B")
                tpl = tpl.replace("{month}", month)

            subject = f"{prefix} {first} -- {subject_line}"
            html = tpl.format(first=first, business_name=name, demo_url=demo_url)
            tasks.append((lead, ftype, subject, html, screenshot, demo_url))

    # Apply limit
    if limit > 0:
        tasks = tasks[:limit]

    # Respect daily warm-up cap
    daily_cap = get_daily_limit(1)  # Default to day-1 cap for now
    available = max(0, daily_cap - already_sent)
    if len(tasks) > available:
        tasks = tasks[:available]

    if dry_run:
        print(f"DRY RUN -- {len(tasks)} emails would be sent")
        for lead, etype, subject, html, screenshot, demo_url in tasks:
            print(f"  [{etype}] {lead.get('business_name')} -> {lead.get('email')}")
            print(f"    Subject: {subject}")
            print(f"    Screenshot: {screenshot or 'NONE'}")
        return {"status": "dry_run", "would_send": len(tasks), "tasks": [
            {"lead_id": t[0].get("lead_id"), "type": t[1], "email": t[0].get("email")}
            for t in tasks
        ]}

    sent = 0
    failed = 0
    results = []

    for i, (lead, etype, subject, html, screenshot, demo_url) in enumerate(tasks):
        name = lead.get("business_name", "Unknown")
        email = lead.get("email", "")
        lead_id = lead.get("lead_id", "")

        print(f"[{i+1}/{len(tasks)}] {name} ({etype}) -> {email}")

        success = send_email(email, subject, html, screenshot)
        status = "sent" if success else "failed"
        log_send(lead_id, name, email, etype, status, demo_url)

        if success:
            update_lead_csv(lead_id, etype, demo_url)
            sent += 1
            results.append({"lead_id": lead_id, "name": name, "type": etype, "status": "sent"})
            print(f"    SENT")
        else:
            failed += 1
            results.append({"lead_id": lead_id, "name": name, "type": etype, "status": "failed"})
            print(f"    FAILED")

        if i < len(tasks) - 1:
            delay = random.randint(DELAY_MIN, DELAY_MAX)
            time.sleep(delay)

    return {
        "status": "ok",
        "sent": sent,
        "failed": failed,
        "daily_cap": daily_cap,
        "already_sent_today": already_sent,
        "results": results,
    }


def main():
    parser = argparse.ArgumentParser(description="Daily email sender for Railway cron")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--mode", choices=["initial", "follow-up", "all"], default="all")
    parser.add_argument("--lang", choices=["en", "es"], default="en")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--json", action="store_true", help="Output JSON summary")
    args = parser.parse_args()

    if not SMTP_USER or not SMTP_PASS:
        msg = {"status": "error", "reason": "SMTP not configured"}
        if args.json:
            print(json.dumps(msg))
        else:
            print("ERROR: SMTP_USER and SMTP_PASS not set in .env")
        sys.exit(1)

    summary = run_send(mode=args.mode, lang=args.lang, limit=args.limit, dry_run=args.dry_run)

    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        print(f"\nSent: {summary.get('sent', 0)} | Failed: {summary.get('failed', 0)}")


if __name__ == "__main__":
    main()
