# Universal Ads & Tracking Methodology
## Generic framework for any business — plug and play

---

# PART 1: The Tracking Stack (Meta Pixel + GA4)

## Overview — The 3-Layer Architecture

```
[WEBSITE] → [GA4] → [Google Ads]       ← Paid Search conversions
[WEBSITE] → [Meta Pixel] → [Meta Ads]  ← Social conversions
                 ↘
            [Facebook Conversions API]  ← Server-side fallback (optional)
```

**Core principle:** Every business needs TWO independent tracking systems that feed into their respective ad platforms. GA4 feeds Google Ads. Meta Pixel feeds Meta Ads. They do NOT talk to each other.

---

## Layer 1: Google Analytics 4 (GA4)

### What it is
GA4 is Google's free analytics platform. It tracks every page view, click, scroll, and conversion on your site. Google Ads imports conversions directly from GA4 — this is the cleanest, most reliable way to track Google Ads performance.

### Setup (one-time, 15 minutes)

**Step 1 — Get the Measurement ID**
1. Go to https://analytics.google.com
2. Create account → Property → choose "Web"
3. Copy the Measurement ID (format: `G-XXXXXXXXXX`)

**Step 2 — Install on website**
Paste this in the `<head>` of every page:

```html
<!-- Google Analytics -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXXXX"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-XXXXXXXXXX');
</script>
```

**Step 3 — Test**
- Open your site in incognito
- Go to GA4 → Reports → Real-time
- You should see your visit appear within seconds

### Data stream: Website → GA4 → Google Ads

The flow is:
1. User visits site → GA4 tag fires `page_view`
2. User scrolls to key section → custom event fires `view_content`
3. User clicks phone/WhatsApp → custom event fires `contact`
4. User submits form → custom event fires `generate_lead`
5. Google Ads imports these events as conversion actions

### Key configuration
- Enable "Google Signals" (for remarketing)
- Link to Google Ads (GA4 → Admin → Google Ads Links)
- Set up conversion events (see Part 3 below)

---

## Layer 2: Meta Pixel

### What it is
The Meta Pixel is a JavaScript snippet that tracks visitors on your website and sends events back to Facebook/Meta. It powers: conversion tracking, retargeting audiences, lookalike audiences, and campaign optimization.

### Setup (one-time, 15 minutes)

**Step 1 — Get the Pixel ID**
1. Go to https://business.facebook.com/events_manager2
2. Create Pixel → name it after the business
3. Copy the Pixel ID (format: a 15-16 digit number)

**Step 2 — Install base code on website**
Paste this in the `<head>` of every page, AFTER the GA4 code:

```html
<!-- Meta Pixel Code -->
<script>
!function(f,b,e,v,n,t,s)
{if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];
s.parentNode.insertBefore(t,s)}(window, document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
fbq('init', 'YOUR_PIXEL_ID');
fbq('track', 'PageView');
</script>
<noscript><img height="1" width="1" style="display:none"
src="https://www.facebook.com/tr?id=YOUR_PIXEL_ID&ev=PageView&noscript=1"
/></noscript>
<!-- End Meta Pixel Code -->
```

**Step 3 — Verify with Meta Pixel Helper**
- Install the Chrome extension "Meta Pixel Helper"
- Visit your site
- The extension icon should light up blue, showing the pixel firing

---

# PART 2: Conversion Events — The Universal Pattern

## The 3 Events Every Business Tracks

Every business has the same funnel. Events map to it:

| Event | Trigger | Feeds |
|-------|---------|-------|
| **ViewContent** | User scrolls to key section (services, pricing, gallery) | Both Pixel + GA4 |
| **Contact** | User clicks phone number, WhatsApp, or email link | Both Pixel + GA4 |
| **Lead** | User submits contact/quote form | Both Pixel + GA4 |

## JavaScript Implementation (Generic, Copy-Pasteable)

### 1. Unified tracking function

```javascript
function trackConversion(eventName, params) {
  // Meta Pixel
  if (typeof fbq !== 'undefined') {
    fbq('track', eventName, params);
  }
  // Google Analytics 4 → Google Ads imports these
  if (typeof gtag !== 'undefined') {
    var ga4Event = eventName === 'Lead' ? 'generate_lead' :
                   eventName === 'Contact' ? 'contact' :
                   eventName === 'ViewContent' ? 'view_content' :
                   eventName.toLowerCase();
    gtag('event', ga4Event, params);
  }
}
```

**Why this matters:** This single function fires BOTH pixels simultaneously. You call it once, both platforms receive the event. This is the entire integration pattern.

### 2. ViewContent — Fire once per section when scrolled into view

```javascript
var pixelFired = {};

function fireViewContent(section, label) {
  if (pixelFired[section]) return;  // dedup — fire only once
  pixelFired[section] = true;
  trackConversion('ViewContent', {
    content_name: label,
    content_category: section
  });
}

// Wire up each section with ScrollTrigger or Intersection Observer
// Example with Intersection Observer (no GSAP needed):
var observer = new IntersectionObserver(function(entries) {
  entries.forEach(function(entry) {
    if (entry.isIntersecting) {
      fireViewContent(entry.target.id, entry.target.dataset.trackLabel);
    }
  });
}, { threshold: 0.3 });

document.querySelectorAll('[data-track-view]').forEach(function(el) {
  observer.observe(el);
});
```

### 3. Contact — Phone clicks & WhatsApp

```javascript
// All tel: links
document.querySelectorAll('a[href^="tel:"]').forEach(function(link) {
  link.addEventListener('click', function() {
    trackConversion('Contact', {
      content_name: 'Phone Call',
      content_category: 'contact'
    });
  });
});

// WhatsApp button
var whatsappBtn = document.getElementById('whatsappButton');
if (whatsappBtn) {
  whatsappBtn.addEventListener('click', function() {
    trackConversion('Contact', {
      content_name: 'WhatsApp Message',
      content_category: 'contact'
    });
  });
}
```

### 4. Lead — Form submission (bulletproof pattern)

```javascript
// WRAPPER pattern — intercepts form success handler
var leadTracked = false;
var originalShowMessage = showFormMessage;

showFormMessage = function(type, text) {
  if (type === 'success' && !leadTracked) {
    leadTracked = true;
    trackConversion('Lead', {
      content_name: 'Quote Form Submit',
      content_category: 'lead',
      status: 'submitted'
    });
    // Reset after 5s so re-submissions fire again
    setTimeout(function() { leadTracked = false; }, 5000);
  }
  return originalShowMessage(type, text);
};
```

**Important:** Also fire Lead event inside the form's `sendForm()` function, right before redirect, wrapped in try-catch so it never blocks the user:

```javascript
function sendForm(payload, submitBtn, originalHTML) {
  var endpoint = 'https://your-api.com/api/quote';
  var redirected = false;

  function go() {
    if (redirected) return;
    redirected = true;
    // Fire Lead event — wrapped so it NEVER blocks redirect
    try {
      trackConversion('Lead', {
        content_name: 'Quote Form Submit',
        content_category: 'lead',
        status: 'submitted'
      });
    } catch(e) {}
    window.location.href = '/thank-you';
  }

  // Safety timeout — redirect after 8s even if API hangs
  var safety = setTimeout(go, 8000);

  fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  .then(function(res) { clearTimeout(safety); go(); })
  .catch(function()    { clearTimeout(safety); go(); });
}
```

**Key design decisions in this pattern:**
- `redirected` closure flag prevents double navigation
- `try-catch` prevents tracking errors from blocking the user
- 8-second safety timeout ensures redirect even if API is dead
- Both `.then` and `.catch` call the same `go()` — the redirect is unconditional

---

# PART 3: Connecting GA4 → Google Ads

## Import Conversions from GA4 to Google Ads

**Pre-requisite:** You must create at least 1 campaign in Google Ads to unlock the full dashboard.

**Steps:**
1. Go to https://ads.google.com/aw/conversions/import
2. Select "Google Analytics 4"
3. Choose your GA4 property
4. Select the events to import:
   - `generate_lead` → Category: "Lead" → Value: use the Lead value
   - `contact` → Category: "Contact" → Value: use the Contact value
   - `view_content` → Category: "Page View" (secondary, not primary conversion)
5. Set attribution model: **Data-driven** (or Last Click if data-driven unavailable)
6. Set conversion window: **30 days** (standard for service businesses)

## Why This Architecture Wins

| Approach | Reliability | Notes |
|----------|-------------|-------|
| GA4 → Google Ads import | ✅ Best | Native integration, no manual UTM parsing |
| Google Ads conversion tag | ⚠️ OK | Extra tag to maintain, can break |
| Manual import from CRM | ❌ Fragile | CSV uploads, human error, delayed |

**The GA4 import is the cleanest path.** One tag on the site feeds both analytics AND Google Ads conversions.

---

# PART 4: Google Ads Campaign Structure (4-Campaign Model)

## The Universal 4-Campaign Architecture

This structure works for ANY local service business. Adjust keywords per industry, but the architecture is constant:

| # | Campaign | % Budget | Language | Intent | Bidding |
|---|----------|----------|----------|--------|---------|
| 01 | High Intent (Primary Lang) | 55% | EN | High — "near me", "service + city" | Max Conversions |
| 02 | High Intent (Secondary Lang) | 25% | ES/Other | High — same keywords, second language | Max Conversions |
| 03 | Mid Intent / Research | 12% | EN | Medium — "how much", "best", "vs" | Max Conversions |
| 04 | Competitor Conquest | 8% | EN | High — competitor brand names | Max Conversions |

### Why 4 campaigns?

- **55% on High Intent (Primary):** Captures the biggest, most profitable segment. "Service near me" queries.
- **25% on Secondary Language:** Often cheaper CPC, less competition, high conversion rate. Massive ROI opportunity.
- **12% on Mid Intent:** Captures people researching — "how much does X cost", "X vs Y". Lower conversion rate but cheap clicks and builds pipeline.
- **8% on Conquest:** Bids on competitor names. Small budget, but captures people looking for alternatives.

### Budget Formula (Generic)

```
Total Monthly Budget = $1,200 (recommended starting point)
Daily Budget = Total / 30.4 = ~$40/day

Campaign 01 = Total * 0.55 = $660/mo → $22/day
Campaign 02 = Total * 0.25 = $300/mo → $10/day
Campaign 03 = Total * 0.12 = $144/mo → $5/day  (round to $5)
Campaign 04 = Total * 0.08 = $96/mo  → $3/day  (round to $3)

Total daily = $40/day ✅
Total monthly = $1,200 ✅
```

### For larger budgets, scale proportionally:

| Total/Mo | C01 (55%) | C02 (25%) | C03 (12%) | C04 (8%) |
|----------|-----------|-----------|-----------|----------|
| $1,200 | $22/day | $10/day | $5/day | $3/day |
| $1,800 | $33/day | $15/day | $7/day | $5/day |
| $2,400 | $44/day | $20/day | $10/day | $6/day |
| $3,000 | $55/day | $25/day | $12/day | $8/day |

---

## Campaign Settings (Universal Defaults)

### Location Targeting
- **Include:** Business city + radius (50 miles for service businesses, 15 miles for retail/restaurants)
- **Exclude:** Adjacent major metros that are too far to serve profitably
- **Location options:** "Presence: People in or regularly in your targeted locations"

### Language
- Campaign 01, 03, 04: Primary language of the market
- Campaign 02: Secondary language (e.g., Spanish in US Sunbelt)

### Bidding Strategy
- **Start:** Maximize Conversions (no CPA cap in week 1 — lets Google learn)
- **Week 2+:** Target CPA — set at 50-70% of what you're willing to pay per lead initially, adjust as data accumulates
- **Minimum 15-20 conversions before switching to Target CPA** — Google needs data

### Ad Rotation
- **Optimize: Prefer best performing ads** (let Google optimize)

### Ad Scheduling
- Service businesses: **Mon-Fri 6am-8pm, Sat 8am-2pm** (unless you offer 24/7)
- Adjust per business hours

---

## Negative Keywords (Universal, Account-Level)

These apply to almost ALL local service businesses. Add/customize per industry:

```
jobs, hiring, salary, course, training, school, certification, diy,
how to, tutorial, homemade, free, craigslist, facebook marketplace,
indeed, internship, used, buy, for sale, auction, ebay
```

**Why account-level negatives:** They prevent ALL campaigns from showing on irrelevant queries. Saves budget immediately.

---

## Ad Copy Pattern (Generic Template)

### Headline Patterns

| Slot | Purpose | Example Templates |
|------|---------|-------------------|
| H1 | Primary keyword + intent | `[Service] Near Me`, `Best [Service] [City]` |
| H2 | Differentiation | `Fast Turnaround`, `15+ Years Experience`, `Family Owned` |
| H3 | Call to action | `Free Estimate Today`, `Call Now`, `Same Day Service` |

### Description Patterns

| Slot | Content |
|------|---------|
| D1 | What you do + area served + key benefit |
| D2 | CTA + urgency + phone number |

### Template:

**Headline 1:** `[Service] in [City]`
**Headline 2:** `[Differentiator]`
**Headline 3:** `Free Estimate | Call Now`
**Description 1:** Expert [service] in [area]. [Benefit 1], [Benefit 2], and [Benefit 3]. Satisfaction guaranteed.
**Description 2:** Call [phone] for a free quote today. Same-day service available. Hablamos Español.

---

## Thank-You Page (Conversion Destination)

Every form submission must redirect to a dedicated thank-you page (`/thank-you` or `/gracias`).

### Why it matters:
- Confirms submission to the user
- Provides conversion URL for Google Ads tracking
- Gives an alternative action (call now, back to home)
- Can fire additional conversion pixels on page load

### Key elements:
1. ✅ Confirmation icon/message
2. 📞 Phone number (in case they need immediate help)
3. 🔙 Navigation back to main site
4. 📊 GA4 + Meta Pixel base code (for cross-domain tracking)
5. 🌐 Bilingual message if market requires it

### Clean URL setup (`vercel.json` or equivalent):
```json
{ "cleanUrls": true }
```

---

# PART 5: Pre-Launch Checklist

## Before spending $1 on ads:

- [ ] **GA4 installed** — Verify in Real-time report, see your own visit
- [ ] **Meta Pixel installed** — Verify with Meta Pixel Helper Chrome extension
- [ ] **ViewContent fires** — Scroll to tracked sections, verify in GA4 Realtime
- [ ] **Contact fires** — Click phone/WhatsApp, verify event in GA4 Realtime
- [ ] **Lead fires** — Submit test form, verify in GA4 Realtime
- [ ] **Lead → Redirect works** — Form submission redirects to /thank-you
- [ ] **Thank-you page loads** — Accessible at /thank-you, no 404
- [ ] **Google Ads linked to GA4** — Verified in Admin → Google Ads Links
- [ ] **Conversions imported** — `generate_lead` and `contact` appear in Google Ads → Conversions
- [ ] **Google Search Console verified** — Domain ownership confirmed
- [ ] **Google Business Profile created** — Required for local service businesses

## Only then:
- [ ] Create 4 campaigns following Part 4 structure
- [ ] Add negative keywords at account level
- [ ] Set budgets per campaign as calculated above
- [ ] Pause campaigns until ready to launch
- [ ] Activate when budget is committed

---

# PART 6: Common Pitfalls & Fixes

| Problem | Cause | Fix |
|---------|-------|-----|
| Form redirect goes to 404 | Clean URLs not configured | Add `vercel.json` with `"cleanUrls": true` or redirect to `.html` |
| Tracking blocks redirect | `trackConversion()` throws error inside promise chain | Wrap in try-catch, use unconditional `go()` function |
| Double redirects / race conditions | Multiple `.then()` chains | Use closure `redirected` flag, single `go()` function |
| API hangs, user waits forever | No timeout on fetch | Add 8-second safety setTimeout that calls `go()` |
| Google Ads forces campaign creation | New accounts must create 1 campaign first | Create minimal campaign, pause immediately, then configure |
| GA4 events not showing in Google Ads | GA4 not linked to Google Ads | Admin → Google Ads Links → Create link |
| Meta Pixel Helper shows yellow | Event mismatch or missing parameter | Check event names match exactly (`Lead` ≠ `lead`) |
| Conversions show "No recent conversions" | Takes 24-48 hours to appear | Wait, or submit a test lead and check back tomorrow |

---

# PART 7: The Complete File Checklist

For any new business website, these files must exist:

```
project/
├── index.html                  # GA4 + Meta Pixel in <head>
├── thank-you.html              # GA4 + Meta Pixel in <head>
├── vercel.json                 # { "cleanUrls": true }
├── google-ads-setup.md         # Campaign config (Part 4)
├── js/
│   └── tracking.js             # trackConversion() + ViewContent/Contact/Lead wiring
├── googleXXXXXXXXX.html        # Google Search Console verification file
└── robots.txt                  # Allow all crawlers
```

---

**Document version:** 1.0
**Last updated:** 2026-05-13
**Designed for:** Any local service business with a website and ad budget
