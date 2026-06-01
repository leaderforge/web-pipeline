"""Add new leads to lead-queue.csv with dedup by domain and lead_id."""
import csv
import re
from pathlib import Path
from datetime import datetime

ROOT = Path(__file__).parent.parent
CSV_PATH = ROOT / "data" / "lead-queue.csv"

today = datetime.now().strftime("%Y-%m-%d")

# ── Paste new leads here ──────────────────────────────────────────
# Format: (lead_id, business_name, phone, email, website, city)
new_leads = [
    # ("abc01", "Business Name", "(555) 555-5555", "email@example.com", "https://example.com", "City"),
]

def extract_domain(url: str) -> str:
    """Extract bare domain from URL for dedup."""
    if not url:
        return ""
    host = re.sub(r"^https?://", "", url)
    host = host.split("/")[0]
    host = host.replace("www.", "")
    return host.lower()

# ── Load existing domains and lead_ids for dedup ──────────────────
existing_ids = set()
existing_domains = set()
fieldnames = []
if CSV_PATH.exists():
    with open(CSV_PATH, encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fieldnames = list(reader.fieldnames)
        for row in reader:
            existing_ids.add(row.get("lead_id", "").strip())
            domain = extract_domain(row.get("website", ""))
            if domain:
                existing_domains.add(domain)

# Ensure pipeline_stage is in fieldnames
if "pipeline_stage" not in fieldnames:
    fieldnames.append("pipeline_stage")

# ── Append new leads ──────────────────────────────────────────────
added = 0
skipped = 0

with open(CSV_PATH, "a", encoding="utf-8", newline="") as f:
    writer = csv.writer(f)
    for lid, name, phone, email, website, city in new_leads:
        if lid in existing_ids:
            print(f"SKIP {lid}: {name} — lead_id already exists")
            skipped += 1
            continue

        domain = extract_domain(website)
        if domain and domain in existing_domains:
            print(f"SKIP {lid}: {name} — domain '{domain}' already in database")
            skipped += 1
            continue

        writer.writerow([
            lid, name, "", phone, email, website, "good", city, "CA",
            website, str(bool(email)), str(bool(phone)), str(bool(website)),
            "3", today, "", "", "", "scraped", "", "", "Firecrawl batch " + today,
            "new",  # pipeline_stage
        ])
        print(f"ADDED {lid}: {name} — {city}")
        added += 1

print(f"\nDone: {added} added, {skipped} skipped, {len(new_leads)} total")
