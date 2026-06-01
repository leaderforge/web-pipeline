# Client Acquisition System

Lead scraping + cold email campaigns for local service businesses.

## Strategy (Cold Email 2026)

- **Plain text only** — no HTML, no images, feels personal
- **Fact-based personalization** — no fake flattery, only technical observations
- **One relevant portfolio piece** — The Welding Brothers (same industry as prospect)
- **Low-friction CTA** — "Want me to send you the link?" instead of booking a call
- **Zoho Mail free tier** — 50 emails/day limit, space batches accordingly

## Setup

```bash
pip install -r requirements.txt
cp .env.example .env
# Edit .env with your Firecrawl API key and SMTP credentials
```

## Usage

### 1. Scrape leads

```bash
python scripts/scrape-leads.py                          # 18 CA cities, 15 per city
python scripts/scrape-leads.py --city "Los Angeles"     # Single city
python scripts/scrape-leads.py --limit 30               # More results per city
```

Output: `data/leads-welders-ca.csv` with priority scoring (1=HOT no website, 4=COLD good site).

### 2. Send campaign

```bash
python scripts/send-campaign.py --dry-run               # Preview emails without sending
python scripts/send-campaign.py --priority hot --count 10  # First 10 HOT leads
python scripts/send-campaign.py --priority hot --count 50  # Max daily for Zoho free
python scripts/send-campaign.py --priority warm         # Send to WARM leads
python scripts/send-campaign.py --delay 20              # Slower sending (conservative)
```

Sends are logged to `data/sent-log.csv`. Do NOT re-send to addresses already in the log.

### Sending strategy (Zoho free: 50/day)

| Day | Batch | Priority | Count |
|-----|-------|----------|-------|
| 1   | 1     | hot      | 10    |
| 2   | 2     | hot      | 15    |
| 3   | 3     | hot      | 15    |
| 4   | 4     | warm     | 10    |

Warm up the sender reputation: start small, increase daily.

## Email setup (Zoho Mail free tier)

1. Buy domain on Porkbun (leaderforgeai.com already owned)
2. Sign up for Zoho Mail free tier (up to 5 users)
3. Verify domain by adding MX records in Porkbun DNS
4. Create `daniel@leaderforgeai.com`
5. Generate app password in Zoho Mail Admin > Security
6. Add credentials to `.env`
