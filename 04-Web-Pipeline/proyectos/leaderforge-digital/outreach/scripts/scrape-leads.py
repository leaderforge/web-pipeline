"""
Google Business Lead Scraper — Welders in California.

Uses Firecrawl search to find welding/fabrication businesses across
California cities, then scrapes each business profile to detect:
- Whether they have a website
- If the website is professional or a template (Wix, no mobile, etc.)
- Contact info (phone, email if available)

Outputs a prioritized CSV: businesses WITHOUT good websites first
(they're the highest-probability clients).

Usage:
    python scripts/scrape-leads.py
    python scripts/scrape-leads.py --city "Los Angeles" --limit 20
    python scripts/scrape-leads.py --cities-file data/ca-cities.txt
"""

import os
import sys
import csv
import json
import argparse
import re
import time
from pathlib import Path
from datetime import datetime

import requests
from dotenv import load_dotenv

load_dotenv()

FIRECRAWL_KEY = os.getenv("FIRECRAWL_API_KEY")
API_BASE = "https://api.firecrawl.dev/v1"

# Default California cities to target (high welding/fabrication density)
DEFAULT_CITIES = [
    "Los Angeles CA",
    "San Diego CA",
    "San Jose CA",
    "San Francisco CA",
    "Fresno CA",
    "Sacramento CA",
    "Oakland CA",
    "Bakersfield CA",
    "Anaheim CA",
    "Riverside CA",
    "Santa Ana CA",
    "Stockton CA",
    "Long Beach CA",
    "Ontario CA",
    "Fontana CA",
    "San Bernardino CA",
    "Modesto CA",
    "Oxnard CA",
]

# Keywords to detect a bad/template/no website
NO_SITE_MARKERS = [
    "wix.com", "wixsite.com", "weebly.com", "wordpress.com",
    "business.google.com", "facebook.com/pg", "instagram.com/",
    "yelp.com/biz", "yellowpages.com",
]

# Domains that are NOT welding businesses (directories, social, jobs)
SKIP_DOMAINS = [
    "yelp.com", "reddit.com", "facebook.com", "indeed.com",
    "linkedin.com", "twitter.com", "instagram.com", "youtube.com",
    "yellowpages.com", "mapquest.com", "superpages.com",
    "angi.com", "thumbtack.com", "nextdoor.com", "bizjournals.com",
    "manta.com", "chamberofcommerce.com", "bbb.org",
]

# Business name patterns to skip
SKIP_NAME_PATTERNS = [
    r"^TOP\s*\d+\s*BEST", r"\bReddit\b", r"\bIndeed\b",
    r"^\d+\s*Best\b", r"\bYelp\b", r"\bJobs\b.*\bCA\b",
]

CSV_HEADERS = [
    "business_name", "phone", "email", "website", "website_quality",
    "has_website", "city", "source_url", "notes", "priority", "scraped_at"
]


def search_businesses(query: str, limit: int = 15) -> list[dict]:
    """Search Google Business via Firecrawl for businesses matching query."""
    headers = {
        "Authorization": f"Bearer {FIRECRAWL_KEY}",
        "Content-Type": "application/json",
    }
    resp = requests.post(
        f"{API_BASE}/search",
        headers=headers,
        json={"query": query, "limit": limit, "lang": "en", "country": "us"},
    )
    resp.raise_for_status()
    data = resp.json()
    if not data.get("success"):
        print(f"  Search failed: {data}")
        return []
    return data.get("data", [])


def scrape_page(url: str) -> str | None:
    """Scrape a business website or profile page for contact info."""
    headers = {
        "Authorization": f"Bearer {FIRECRAWL_KEY}",
        "Content-Type": "application/json",
    }
    try:
        resp = requests.post(
            f"{API_BASE}/scrape",
            headers=headers,
            json={"url": url, "formats": ["markdown"], "onlyMainContent": True},
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        if data.get("success") and "data" in data:
            return data["data"].get("markdown", "")
    except Exception as e:
        print(f"    Scrape error: {e}")
    return None


def extract_email(text: str) -> str:
    """Try to extract an email address from text."""
    match = re.search(r'[\w\.-]+@[\w\.-]+\.\w+', text)
    return match.group(0) if match else ""


def assess_website(url: str, scraped_content: str | None) -> str:
    """Rate website quality: 'none', 'basic', 'template', 'good'."""
    if not url or url in ("", "N/A"):
        return "none"

    url_lower = url.lower()
    for marker in NO_SITE_MARKERS:
        if marker in url_lower:
            return "template"

    if scraped_content:
        length = len(scraped_content)
        if length < 300:
            return "basic"
        if any(kw in scraped_content.lower() for kw in ["wix", "weebly", "squarespace", "godaddy"]):
            return "template"

    return "good"


def should_skip(name: str, url: str) -> bool:
    """Filter out non-business results (directories, social media, job sites)."""
    url_lower = url.lower() if url else ""
    for domain in SKIP_DOMAINS:
        if domain in url_lower:
            return True
    for pattern in SKIP_NAME_PATTERNS:
        if re.search(pattern, name, re.IGNORECASE):
            return True
    return False


def process_city(city: str, limit: int, writer: csv.DictWriter, results: list):
    """Search and process businesses in one city."""
    queries = [
        f"welding shop {city}",
        f"mobile welder {city}",
    ]

    for query in queries:
        print(f"\n  Searching: {query}")

        try:
            businesses = search_businesses(query, limit=limit)
        except Exception as e:
            print(f"  ERROR: {e}")
            continue

        print(f"  Found: {len(businesses)} results")

        for biz in businesses:
            name = biz.get("title", "Unknown")
            url = biz.get("url", "")
            description = biz.get("description", "")

            if not name or name == "Unknown":
                continue

            if should_skip(name, url):
                print(f"    SKIP (noise): {name[:60]}...")
                continue

            print(f"    {name[:60]}...")

            # Extract phone and email from description
            phone = ""
            email = extract_email(description)

            # Phone patterns in description
            phone_match = re.search(r'(\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})', description)
            if phone_match:
                phone = phone_match.group(0)

            # Determine website from URL
            website = ""
            if url and "google.com" not in url and "yelp.com" not in url:
                website = url
            elif description:
                site_match = re.search(r'(https?://[^\s]+)', description)
                if site_match:
                    candidate = site_match.group(0)
                    if "google.com" not in candidate:
                        website = candidate

        quality = assess_website(website, None)

        # Priority: 1 = no website (HOT), 2 = template (WARM), 3 = basic, 4 = good (COLD)
        priority_map = {"none": 1, "template": 2, "basic": 3, "good": 4}
        priority = priority_map.get(quality, 4)

        row = {
            "business_name": name,
            "phone": phone,
            "email": email,
            "website": website if website else "N/A",
            "website_quality": quality,
            "has_website": "yes" if website else "no",
            "city": city,
            "source_url": url,
            "notes": description[:200] if description else "",
            "priority": priority,
            "scraped_at": datetime.now().isoformat(),
        }
        writer.writerow(row)
        results.append(row)

        # Print priority flag
        flag = {1: " HOT - NO WEBSITE", 2: " WARM - TEMPLATE", 3: " COOL - BASIC", 4: " COLD - GOOD SITE"}
        print(f"      => {flag.get(priority, '')}")


def main():
    parser = argparse.ArgumentParser(description="Scrape welders from Google Business via Firecrawl")
    parser.add_argument("--city", help="Single city to target")
    parser.add_argument("--cities-file", help="File with cities, one per line")
    parser.add_argument("--limit", type=int, default=15, help="Results per city")
    parser.add_argument("--output", default="data/leads-welders-ca.csv", help="Output CSV path")
    args = parser.parse_args()

    if not FIRECRAWL_KEY:
        print("ERROR: FIRECRAWL_API_KEY not set in .env")
        sys.exit(1)

    # Determine cities
    if args.city:
        cities = [args.city]
    elif args.cities_file:
        cities = [l.strip() for l in Path(args.cities_file).read_text().splitlines() if l.strip()]
    else:
        cities = DEFAULT_CITIES

    print(f"Firecrawl Lead Scraper — Welders in California")
    print(f"  Cities: {len(cities)}")
    print(f"  Limit:  {args.limit} per city")
    print(f"  Output: {args.output}")

    # Ensure output directory exists
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Write CSV with headers
    results = []
    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_HEADERS)
        writer.writeheader()

        for city in cities:
            process_city(city, args.limit, writer, results)

    # Summary
    print(f"\n{'='*60}")
    print(f"TOTAL: {len(results)} leads scraped")

    # Priority breakdown
    hot = sum(1 for r in results if r["priority"] == 1)
    warm = sum(1 for r in results if r["priority"] == 2)
    cool = sum(1 for r in results if r["priority"] == 3)
    cold = sum(1 for r in results if r["priority"] == 4)

    print(f"  HOT (no website):    {hot}")
    print(f"  WARM (template):     {warm}")
    print(f"  COOL (basic site):   {cool}")
    print(f"  COLD (good site):    {cold}")
    print(f"\n  Output: {output_path}")
    print(f"\nNext: python scripts/send-campaign.py --input {args.output}")


if __name__ == "__main__":
    main()
