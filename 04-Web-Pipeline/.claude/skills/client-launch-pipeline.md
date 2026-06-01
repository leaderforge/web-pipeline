---
name: client-launch-pipeline
description: |
  Master skill: Complete end-to-end client launch system. Takes a client from zero to fully operational digital presence. Combines competitive research (Firecrawl), premium website build (taste-skill design system from Leonxlnx), backend lead capture (Railway + Cloudflare R2 + Google Sheets + Telegram), full Google ecosystem, social media presence, Facebook Pixel, Telnyx telephony, and Google Ads campaign architecture.

  Triggers: "launch client", "new client", "client setup", "build for [business]", "complete digital launch", "lead capture system for [business]", "client pipeline", "new website for [business]".

  MODULAR — phases compose independently. Skip what doesn't apply.
allowed-tools: Read, Write, Grep, Glob, Bash, WebFetch, mcp__firecrawl__firecrawl_scrape, mcp__firecrawl__firecrawl_map, mcp__firecrawl__firecrawl_search
---

# Client Launch Pipeline — Zero to Live

You are a senior digital strategist and full-stack operator executing the Client Launch Pipeline. You ship complete client systems — landing page, backend, integrations, marketing infrastructure — in a focused session. Speed matters. Quality matters more.

This skill compresses what agencies deliver in 4-6 weeks into focused execution. Output: live website, working lead capture, automated notifications, Google ecosystem active, social media configured, tracking pixels installed, ad campaigns architected.

---

## EXECUTION ENVIRONMENT

**Primary tool:** VS Code + Claude Code CLI
**Model strategy:** Claude Opus 4.7 default, switch to DeepSeek for bulk/research phases to optimize token costs.

**Required credentials (stored at `$env:USERPROFILE\` on Windows):**
```
.vercel-token        — Vercel deploy
.firecrawl-token     — Research scraping (Firecrawl MCP)
```

**Required accounts:**
```
Porkbun (domain)  |  Vercel (frontend)  |  Railway (backend)
Cloudflare (R2)   |  Google (Workspace, Cloud, Analytics, Business)
Telnyx (telephony)  |  Telegram (bot notifications)
Meta Business (Facebook + Instagram + Pixel)
Yelp (if local service business)
```

---

## DESIGN SYSTEM — Taste-Skill (Leonxlnx)

All website builds use the official taste-skill design system installed at:
```
.agents/skills/design-taste-frontend/SKILL.md
```

Before building any site, load this skill. The design system enforces:

| Rule | Banned | Use Instead |
|------|--------|-------------|
| Font | Inter | Outfit, Geist, Cabinet Grotesk, DM Sans |
| Icons | Lucide | Phosphor Icons |
| Shadows | Generic box-shadow | Diffused ambient shadows |
| Cards | Single container | Double-Bezel pattern |
| Spacing | Symmetric | Asymmetric bento grids |
| Height | `h-screen` | `min-h-[100dvh]` |
| Nav | Standard bar | Floating island nav pill |
| Colors | #000 pure black | #1A1A1A charcoal |

Design parameters (per project):
- DESIGN_VARIANCE: 4-7 (layout experimentation)
- MOTION_INTENSITY: 6-8 (animation depth)
- VISUAL_DENSITY: 4-5 (content per viewport)

Other available taste skills:
- `high-end-visual-design` — calm, polished, premium typography
- `minimalist-ui` — editorial, Notion/Linear-inspired
- `industrial-brutalist-ui` — hard mechanical, Swiss type
- `redesign-existing-projects` — audit-first redesign workflow
- `image-to-code` — generate reference images, analyze, implement

---

## PHASE 0 — CLIENT INTAKE (10 min)

Conduct conversational intake. Get the human story.

### Required Questions

**Q1 — The Business:** What they do, who they serve, what makes them different.
**Q2 — The Operator:** Who runs it? Solo, family, team? Daily reality?
**Q3 — The Customer:** Ideal customer — demographics, geography, decision triggers.
**Q4 — The Money:** Avg ticket size, sales cycle, what a "win" looks like.
**Q5 — Geography:** Service area — cities, zip codes, radius.
**Q6 — Existing Assets:** Website URL? Logo? Photos? GMB? Social? Reviews?
**Q7 — The Stakes:** Goal — first customer? Beat competitor? X leads/month?
**Q8 — Compliance:** Licensed industry? Languages? Sensitivities?

Save to: `research/00-client-intake.md`

---

## PHASE 1 — RESEARCH & COMPETITIVE INTELLIGENCE (30 min)

### 1A — Determine Data Source

**Path A — Client has website:** Firecrawl scrape → extract brand data.
**Path B — No website:** Manual collection from intake (logo, colors, photos).

### 1B — Client Brand Extraction

If Path A: `firecrawl_map` + `firecrawl_scrape` the existing site.
Extract: logo, colors (CSS), fonts, tone, messaging, content, structure.

If Path B: Compile from intake data + logo color extraction via PowerShell System.Drawing.

### 1C — Competitor Discovery

Firecrawl search: `"[industry] [city/region]"` — find top 10 competitors.
Score on 8 criteria (1-10): Search visibility, Review quality, Visual design, Mobile UX, Content depth, Social proof, CTA strategy, Page speed.

### 1D — Deep Scrape Top 3

For top 3: extract exact colors, typography, hero structure, CTA language, conversion mechanism, strengths, weaknesses (= opportunities).

### 1E — Pattern Identification

What do ALL top performers do? What do NONE do? (Gap opportunities.)

Save: `research/01-client-brand.md`, `research/02-competitor-[1,2,3].md`, `research/03-competitive-patterns.md`

### 1F — Competitive Analysis Report (Client Deliverable)

Build `competitive-analysis.html` — polished, A4 PDF-ready HTML report. This is a SALES TOOL.

Design: Instrument Serif headings, DM Sans body, paper background #f6f4f0, terracotta accent #c45d3e, grain overlay SVG filter, cards with 4px accent border. Pure HTML + CSS. Bilingual OK if client prefers Spanish.

---

## PHASE 2 — DESIGN BRIEF & APPROVAL (15 min)

Consolidate research into `research/04-build-brief.md`:
- Design Direction (colors with justification, typography, photography style, animation level, what to AVOID)
- Site Architecture (pages, nav, CTA strategy)
- Content Framework (3 H1 options, value prop, section-by-section copy, SEO keywords)
- Conversion Playbook (primary goal, lead capture, social proof, trust signals)

### HARD STOP — Get Client Approval
Do not proceed without explicit approval.

---

## PHASE 3 — DOMAIN & DNS (10 min)

### 3A — Purchase Domain

Buy on Porkbun (`.com` preferred, `.co`/`.io`/`.site` fallback).

### 3B — Delegate Nameservers to Vercel (CRITICAL)

**Do NOT manually add A/CNAME records on Porkbun and leave Porkbun nameservers.**
This causes SSL provisioning issues. Safari on iOS will show "This website may be dangerous"
warnings. Vercel MUST control the DNS zone to auto-manage SSL certificates.

1. In **Porkbun** → Domain → **Name Servers** (or "DNS Settings" → "Authoritative Nameservers")
2. Remove all Porkbun nameservers (`curitiba.ns.porkbun.com`, `fortaleza.ns.porkbun.com`, etc.)
3. Set custom nameservers to exactly these TWO:
   ```
   ns1.vercel-dns.com
   ns2.vercel-dns.com
   ```
4. Save. Propagation takes 5 min to 2 hours.

### 3C — Add Domain to Vercel Project

```powershell
vercel domains add [domain.com] --cwd "[project]/site"
```

Then `vercel domains inspect [domain.com]` — confirm `Edge Network: yes` and nameservers show `ns1.vercel-dns.com / ns2.vercel-dns.com` as both Intended AND Current.

### 3D — Verify SSL

```powershell
curl -sI "https://[domain.com]" | grep -E "HTTP|server"
# Must return: HTTP/1.1 200 OK + Server: Vercel
```

### Common Mistake & Symptom

| What was done | Symptom |
|---|---|
| A record @ → 76.76.21.21 kept on Porkbun nameservers | Site loads on desktop Chrome/Firefox, BUT Safari on iPhone shows "This website may be impersonating leaderforge.digital" or "may be dangerous" |
| Correct: nameservers delegated to Vercel | SSL works everywhere, no warnings, auto-renewal |

**Why:** With Porkbun nameservers + manual A record, Vercel uses HTTP validation for SSL (works but fragile). With Vercel nameservers, Vercel provisions the SSL cert via DNS validation (proper, stable, recognized by Apple's certificate transparency logs). Safari trusts DNS-validated certs more.

---

## PHASE 4 — WEBSITE BUILD (45 min)

### Tech Stack (Fixed)
```
HTML + Tailwind CSS CDN + GSAP 3.12.5 + ScrollTrigger + Phosphor Icons
```

No frameworks. No build step. Maximum portability.

### CDN Links
```html
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://unpkg.com/@phosphor-icons/web@2.1.1"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/ScrollTrigger.min.js"></script>
```

### Required Sections
1. Hero with 3D animation placeholder
2. Services / Products
3. Process / How it works (3-5 steps)
4. Social proof (testimonials, reviews)
5. Trust signals (guarantee, credentials, years)
6. Gallery (real photos when available)
7. CTA form (4 fields max + photo upload)
8. Footer with contact, social, legal

### Design Rules (Taste-Skill)
Load `.agents/skills/design-taste-frontend/SKILL.md` before building. Apply all anti-generic rules.

### Bilingual (if applicable)
Use `data-en` / `data-es` attributes with JS toggle. Schema in primary language.

### SEO Day 1
Title (60 chars + geo + service), meta description (155 chars), Open Graph (1200x630 image), Twitter Card, Schema.org LocalBusiness, canonical, sitemap.xml, robots.txt, alt text on all images.

---

## PHASE 5 — IMAGES & ANIMATIONS (Semi-Manual)

This phase generates the visual assets for the landing page. Images can be auto-generated
via Hugging Face or manually via Midjourney/Stable Diffusion. Animations are semi-manual:
Claude writes the prompts, the user generates in Kling 3 / Runway.

---

### 5A — IMAGE SPECIFICATIONS

#### Ratios by Use Case

| Image Type | Desktop Ratio | Mobile Ratio | Notes |
|---|---|---|---|
| Lifestyle (hero, about) | 16:9 crop | **3:4** generate | Generate 3:4, use `object-fit: cover` with `object-position: center 30%` on desktop |
| Flat lay (portfolio divider) | **1:1** | **1:1** | Universal. Works everywhere. |
| Device split (showcase) | 16:9 crop | **1:1** stack | Generate 1:1 with elements stacked vertically; crops to 16:9 on desktop |
| Footer banner | **16:9** | **16:9** | Decorative strip. Cover-crops OK on mobile. |

#### HTML Implementation

```html
<!-- Hero image: generated 3:4, crops to 16:9 on desktop -->
<img src="hero-lifestyle.jpg"
     class="w-full h-full object-cover object-[center_30%]"
     alt="Tradesman with phone at job site">

<!-- Flat lay: 1:1, universal -->
<img src="flatlay-workshop.jpg"
     class="w-full aspect-square object-cover rounded-2xl"
     alt="Workshop with phone showing website">

<!-- Footer banner: 16:9 -->
<img src="footer-banner.jpg"
     class="w-full aspect-video object-cover"
     alt="Tradesman at golden hour">
```

#### Generation Tool

Hugging Face (auto) or Midjourney/Stable Diffusion (manual). Each `<img>` placeholder
in the HTML includes a `data-prompt` attribute with the generation prompt.

---

### 5B — ANIMATION SPECIFICATIONS

#### Tool & Limits

| Parameter | Spec |
|---|---|
| Tool | Kling 3 Flash (or Runway Gen-3) |
| **Max prompt length** | **2500 characters** |
| Desktop format | 16:9 (1920x1080) |
| Mobile format | 9:16 (1080x1920) |
| Alpha channel | Preferred for web transparency |
| Font for text overlays | Outfit Bold |
| FPS | 30 |

#### Critical Prompt Rules for Kling 3

1. **2500 characters max.** Count before submitting.
2. **All on-screen text must be literal English phrases between 2-4 words max.** Never rely on the AI to generate readable text — give it the exact phrases between quotes: `"New lead"`, `"Quote please"`, `"Send a photo."`
3. **No complex punctuation** in on-screen messages. Write like WhatsApp texts.
4. **No pixel dimensions in the prompt.** The tool handles format separately.
5. **Use short, punchy phase labels:** BUILD, UNIFY, RESPOND — not "Phase 1: Construction of the website."
6. **Specify color hex codes** exactly: orange (#F2610B), zinc grays, white. This keeps the brand consistent.
7. **Avoid:** "cinematic," "stunning," "beautiful," "high quality," "4K," "8K", camera specs (aperture, lens types), and any pixel counts.

#### Animation Architecture

Always generate **2-3 animations** per landing page:

| # | Name | Duration | Location | Function |
|---|---|---|---|---|
| 1 | Hero | 5-7s | Hero section | Sets tone. Shows the product in action. |
| 2 | Mid-page | 5s | After stats/how-it-works | Demonstrates the key differentiator (unified inbox, AI replies, etc.) |
| 3 | Journey | 5-6s | Before pricing/contact | Shows the full customer journey: Google → website → phone |

Skip animation 3 for simpler builds. Minimum: hero animation.

#### File Naming & Folder Convention

```
assets/animations/
├── desktop1.mp4    # Animation 1 — Desktop (1920x1080)
├── mobile1.mp4     # Animation 1 — Mobile (1080x1920)
├── desktop2.mp4    # Animation 2 — Desktop
├── mobile2.mp4     # Animation 2 — Mobile
└── README.md       # Note: folder is lowercase 'animations' — critical for Linux deploys
```

#### Video HTML Pattern — Poster-First, Single Tag

**One `<video>` tag with `<source media>` — not separate video elements.**
The browser selects the right source based on viewport width.

```html
<!-- HERO VIDEO: poster shows immediately, no black flash, autoplay on load -->
<video class="hero-video" muted loop playsinline autoplay preload="auto"
       poster="assets/images/hero-desktop.jpg"
       aria-label="Animation description for screen readers">
  <source media="(min-width: 769px)" src="assets/animations/desktop1.mp4" type="video/mp4">
  <source media="(max-width: 768px)" src="assets/animations/mobile1.mp4" type="video/mp4">
</video>

<!-- Fallback image: hidden by default, shown if video errors -->
<picture class="hero-fallback">
  <source media="(min-width: 769px)" srcset="assets/images/hero-desktop.jpg">
  <source media="(max-width: 768px)" srcset="assets/images/hero-mobile.jpg">
  <img src="assets/images/hero-desktop.jpg" alt="Fallback" class="w-full h-full object-cover" loading="eager">
</picture>
```

#### CSS — Video Always Visible (Poster Shows Natively)

```css
/* Video is ALWAYS visible — the browser poster attribute handles the loading state.
   NEVER use opacity: 0 on the video element — it hides the poster too, causing black flash. */
.hero-video, .anim2-video {
  position: absolute; inset: 0;
  width: 100%; height: 100%;
  object-fit: cover;
}

.hero-fallback, .anim2-fallback { display: none; }
.hero-fallback.is-visible, .anim2-fallback.is-visible { display: block; }

.hero-video-wrap {
  position: relative;
  background: #0d0d0d; /* dark bg only visible if poster image also fails */
  aspect-ratio: 16/9;
}

@media (max-width: 768px) {
  .hero-video-wrap { aspect-ratio: 9/16; max-height: 80vh; }
}
```

#### JavaScript — Error Handling & Scroll-Triggered Play

```js
const heroVideo = document.querySelector('.hero-video');
const anim2Video = document.querySelector('.anim2-video');
const heroFallback = document.querySelector('.hero-fallback');
const anim2Fallback = document.querySelector('.anim2-fallback');

// Hero: if video fails to load or play, show fallback image
heroVideo.addEventListener('error', () => {
  heroVideo.style.display = 'none';
  if (heroFallback) heroFallback.classList.add('is-visible');
});

// Animation 2 (below fold): load & play only when scrolled into view
const anim2Observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting && anim2Video) {
      anim2Video.play().catch(() => {});
      anim2Video.addEventListener('playing', () => {
        if (anim2Fallback) anim2Fallback.classList.add('is-hidden');
      }, { once: true });
      anim2Video.addEventListener('error', () => {
        anim2Video.style.display = 'none';
        if (anim2Fallback) anim2Fallback.classList.remove('is-hidden');
      }, { once: true });
      anim2Observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.2 });

if (anim2Video) anim2Observer.observe(anim2Video);
```

#### Preload Strategy

| Video | `preload` | Rationale |
|---|---|---|
| Hero (animation 1) | `auto` | Above the fold — must load immediately |
| Mid-page (animation 2+) | `none` | Below the fold — IntersectionObserver triggers load on scroll |

`preload="none"` saves bandwidth. The poster image carries the section visually until the user scrolls near it.

#### Video Compression — Mandatory Before Deploy

**Source files from Kling/Runway are 5-15 MB each — too heavy for web.** Compress before deploying.

```bash
# CRF 28 for hero (higher quality, more visible)
ffmpeg -i input.mp4 -c:v libx264 -crf 28 -preset slow -movflags +faststart -an output.mp4

# CRF 30 for mid-page (slightly more compression, still looks good)
ffmpeg -i input.mp4 -c:v libx264 -crf 30 -preset slow -movflags +faststart -an output.mp4
```

| Flag | Purpose |
|---|---|
| `-crf 28` | Constant Rate Factor — 28 = visually nearly lossless, ~60-70% size reduction |
| `-preset slow` | Better compression ratio (takes longer, run once) |
| `-movflags +faststart` | Moves moov atom to front — video starts playing before full download |
| `-an` | Strips audio track (these are background animations, always muted) |

**Target:** <2 MB per file. A 7 MB source → ~1.2 MB after CRF 28. Total animation payload <6 MB.

**Verify after compression:**
```bash
ls -lh assets/animations/*.mp4
```

#### Critical Rules Checklist (Video Implementation)

- [ ] Folder is `assets/animations/` (lowercase — Linux deploys break on `Animations/`)
- [ ] Single `<video>` tag per animation with `<source media>` for desktop/mobile swap
- [ ] Video has all 4 attributes: `muted loop playsinline autoplay`
- [ ] `poster` attribute points to a real image that exists in `assets/images/`
- [ ] CSS does NOT set `opacity: 0` on the video element (poster must be visible)
- [ ] Fallback `<picture>` or `<img>` exists and has JS error handling
- [ ] Hero uses `preload="auto"`, mid-page uses `preload="none"`
- [ ] Mid-page video has IntersectionObserver to trigger `.play()` on scroll
- [ ] All videos compressed with ffmpeg CRF 28-30 before deploy
- [ ] `.vercel/project.json` exists and project is linked to Vercel

#### Semi-Manual Workflow

1. Claude writes the animation prompts (≤2500 chars each) + start/end frame image prompts
2. User generates start + end frame images in Midjourney/Stable Diffusion
3. User feeds both frames + animation prompt to Kling 3 Flash
4. User saves output to `assets/animations/desktop[N].mp4` and `mobile[N].mp4`
5. Claude integrates the `<video>` tags into the HTML following the poster-first pattern above
6. Claude compresses all videos with ffmpeg before deploy
7. Claude deploys to Vercel and verifies videos load from the live domain

**Claude's job:** write prompts, integrate video HTML with poster-first pattern, compress videos, deploy, verify.
**User's job:** generate images, run Kling, save the raw MP4 files.

---

### 5C — REFERENCE PROMPTS (LeaderForge Digital, May 2026)

These are the validated prompts from the LeaderForge Digital build. Use as template.

#### Image Prompts

**Lifestyle (3:4):**
```
Vertical portrait, 3:4. A welder in his 40s, clean dark work shirt, standing next to his welding rig at golden hour in a California industrial yard. Holding an iPhone — the screen glows with an orange-accented Telegram chat showing lead notifications. Behind him, half-finished metal structure out of focus. Warm California sunset light, shallow depth of field on the phone and his face. Editorial photography, natural color grade with amber undertones. Authentic, not staged. Subject in upper-center so it crops well to 16:9 on desktop.
```

**Flat Lay (1:1):**
```
Square 1:1. Overhead flat lay on a rustic dark wooden workbench. Worn leather welding gloves, a modern iPhone showing a trade-business website with orange (#F2610B) accents, a minimalist black business card reading "LeaderForge.Digital" with an orange dot, scattered metal shavings, a matte black coffee cup. Morning sunlight diagonally from top-left. Textured, warm, authentic workshop feel. Lived-in, not sterile.
```

**Device Split (1:1 stacked):**
```
Square 1:1. Clean warm-gray background. TOP HALF: MacBook angled, screen showing a beautiful trade website (dark header, orange CTAs, welding hero image). BOTTOM HALF: iPhone held by a rough calloused hand, showing the same website perfectly responsive on mobile. Orange horizontal line connects both screens. Clean product photography, soft studio lighting. Elements stacked vertically so it reads naturally.
```

**Footer Banner (16:9):**
```
Wide landscape 16:9. A tradesman in work clothes walking away from camera toward his truck at golden hour. Shot from behind at low angle. Phone in right hand — the screen illuminates his hand warm orange. Background: California job site with equipment silhouettes. Sky: dramatic warm orange fading to deep zinc blue. Emotional, aspirational, cinematic.
```

#### Animation Prompt Template

Structure all 3 prompts like this (≤2500 chars):

```
[X]s product animation. [Style descriptor]. [Background/color notes]. [Phone/font specs]. [Format info].

PHASE 1 (0-Xs) [ONE-WORD LABEL]
[Visual sequence — 2-3 sentences max]. [Text overlay if any, between quotes].

PHASE 2 (X-Ys) [ONE-WORD LABEL]
[Visual sequence — 2-3 sentences max]. [On-screen messages: literal English between quotes, 2-4 words each].

PHASE 3 (Y-Zs) [ONE-WORD LABEL]
[Visual sequence — 2-3 sentences max]. [On-screen text between quotes]. Final frame: [logo/tagline].
```

#### Validated Animation Prompts

See `proyectos/leaderforge-digital/index.html` source comments for the full 3 prompts
(Animación 1 "Build & Deliver" 7s, Animación 2 "Unified Inbox" 5s, Animación 3 "Lead Journey" 6s).
These are the Kling-validated ≤2500 char versions with literal English text strings.

---

## PHASE 6 — DEPLOY FRONTEND (10 min)

Vercel CLI deploys directly from local files. No GitHub required.

```powershell
vercel --cwd "[project]/site"          # First deploy
vercel --prod --cwd "[project]/site"   # Production
vercel domains add [domain.com] --cwd "[project]/site"
```

vercel.json: `{ "cleanUrls": false }` (preserves .html extensions).

### Post-Deploy Verification (MANDATORY)

```powershell
# 1. Verify nameservers are Vercel's (NOT Porkbun's)
vercel domains inspect [domain.com] --cwd "[project]/site"
# Both "Intended" and "Current" must show ns1.vercel-dns.com / ns2.vercel-dns.com

# 2. Verify SSL from multiple angles
curl -sI "http://[domain.com]"  | grep -E "HTTP|Location"   # Must: 308 → https://
curl -sI "https://[domain.com]" | grep -E "HTTP|Server"     # Must: 200 + Vercel

# 3. Verify video assets load
curl -sI "https://[domain.com]/assets/animations/desktop1.mp4" | grep -E "HTTP|Content-Length|X-Vercel-Cache"
```

**Do not hand off to client until ALL three pass.** Safari iOS will flag incomplete SSL setups.

---

## PHASE 7 — BACKEND & LEAD CAPTURE (30 min)

### Endpoints
- `POST /api/quote` — Form + photo upload → R2 → Google Sheets → Telegram
- `POST /telnyx/incoming` — SMS/MMS/call → Telegram
- `POST /api/whatsapp-click` — Log WhatsApp clicks
- `GET /health` — Status check

### Multi-Brand Architecture
The Railway backend supports multiple brands simultaneously via `BRANDS` config object. Each brand: own Telegram bot, Google Sheets tab, R2 folder, phone numbers.

### Infrastructure
- **Railway** — Node.js + Express backend ($5/mo)
- **Cloudflare R2** — Photo storage (S3-compatible)
- **Google Sheets** — Lead database (lightweight CRM)
- **Telegram Bot API** — Real-time notifications

---

## PHASE 8 — TELEPHONY — Telnyx (15 min)

Why Telnyx over Twilio: Twilio blacklists VoIP for personal forwarding without A2P 10DLC.

1. Buy local number ($2 total: $1 number + $1 first month)
2. Configure: Call Forwarding → operator's cell, HD Voice, Inbound Call Screening
3. Webhook: `https://[railway].up.railway.app/telnyx/incoming` for SMS/MMS

---

## PHASE 9 — GOOGLE ECOSYSTEM (30 min)

- **Google Business Profile** — Create, verify, add photos, request reviews
- **Google Search Console** — Add property, submit sitemap, request indexing
- **Google Analytics GA4** — Create property, install tag in `<head>`
- **Google Ads** — Create account, link to Analytics and GMB (don't launch yet)

---

## PHASE 10 — SOCIAL MEDIA (20 min)

- **Facebook Page** — Create with CTA: Call Now → Telnyx number
- **Instagram Business** — Create, connect to Facebook, bio + contact button
- **Initial Content** — 3 starter posts (Welcome, Service spotlight, Trust signal)

---

## PHASE 11 — META BUSINESS MANAGER (15 min)

1. Create Business Manager account
2. Add Facebook Page + Instagram Account
3. Business verification (recommended)

---

## PHASE 12 — FACEBOOK PIXEL (15 min)

1. Create Pixel in Events Manager
2. Install in `<head>` (fbq init + noscript fallback)
3. Add conversion events: Lead (form submit), Contact (phone/WhatsApp click)
4. Verify with Meta Pixel Helper Chrome extension

---

## PHASE 13 — DIRECTORY LISTINGS (Conditional, 20 min)

- **Yelp** — Claim, complete profile, 30-day free trial ($540 value). Set Day 29 cancel reminder.
- **Bing Places** — Import from Google (5 min, real traffic)
- **Industry-specific** — Angi/HomeAdvisor (home services), Thumbtack, BBB, etc.

---

## PHASE 14 — TESTING & QA (15 min)

Full checklist covering: Website (desktop + mobile), Lead Capture (test submission), Telephony (call + SMS + MMS), Tracking (GA4 realtime + Meta Pixel events), Google Ecosystem (GMB + Search Console + Analytics), Social (FB + IG live).

Save: `research/05-qa-checklist.md`

---

## PHASE 15 — CLIENT HANDOFF (15 min)

1. Generate handoff report (what was built, credentials, costs)
2. Recurring costs disclosure (~$7/mo without Yelp, $900/mo recommended ad spend)
3. Operator training (15 min call): Telegram, Google Sheets, social posting, GMB updates
4. Calendar reminders (Day 7, 14, 28, 30)

---

## PHASE 16 — ADS TRACKING & CAMPAIGN ARCHITECTURE (45 min)

Reference: `templates/ads-tracking-methodology.md`

### Three-Layer Tracking
```
Layer 1 — GA4 (site analytics)
Layer 2 — Meta Pixel + Google Ads tag (platform pixels)
Layer 3 — Unified trackConversion() (single source of truth)
```

### Universal Conversion Events
`ViewContent`, `Contact`, `Lead` — three events for every industry.

### Bulletproof Form Wrapper
800ms safety timeout before redirect ensures pixels fire.

### Campaign Architecture (55/25/12/8 Split)
```
Campaign 1 — Search High Intent:  55% ($660/mo at $1,200 budget)
Campaign 2 — Search Broader:      25% ($300/mo)
Campaign 3 — Performance Max:     12% ($144/mo)
Campaign 4 — Retargeting:          8% ($96/mo)
```

### Pre-Launch Checklist
Tracking verified, form integrity confirmed, site readiness, campaign setup, operational readiness. Never enable campaigns until ALL items green.

### Launch Sequence
Campaign 4 first (needs 14-day audience build) → Campaign 3 → Campaign 2 → Campaign 1 last.

---

## OPERATING PRINCIPLES

**Speed without sloppiness.** Target time is aspirational. Quality first.
**Modular execution.** Phases compose. Skip what doesn't apply.
**Real data over guesswork.** Every decision justified by competitive research.
**The handoff is the product.** Client must be able to operate the system.
**Costs are visible.** Every recurring cost disclosed upfront.
**Recovery is part of the system.** Graceful degradation if services fail.
**First 72 hours critical.** Expect first leads in 24-72 hours with ads active.

---

## OUTPUT STRUCTURE

```
[client-name]/
├── research/
│   ├── 00-client-intake.md
│   ├── 01-client-brand.md
│   ├── 02-competitor-[1,2,3].md
│   ├── 03-competitive-patterns.md
│   ├── 04-build-brief.md
│   ├── 05-qa-checklist.md
│   ├── 06-negative-keywords.md
│   ├── 07-ads-prelaunch-checklist.md
│   └── 08-campaign-launch-plan.md
├── competitive-analysis.html
├── site/
│   ├── index.html
│   ├── 404.html
│   ├── gracias.html / thank-you.html
│   ├── css/
│   ├── js/
│   │   └── main.js (trackConversion + form wrapper)
│   ├── assets/
│   │   ├── animations/ (2-3 animations × 2 orientations, compressed <2MB each)
│   │   └── images/
│   ├── sitemap.xml
│   ├── robots.txt
│   └── vercel.json
├── api/
│   ├── server.js
│   ├── services/
│   ├── package.json
│   └── .env (NOT committed)
├── deploy.ps1
└── README.md
```

---

## VERSION HISTORY

v2.0 — Unified master skill. Merged website-intelligence (v1) + client-launch-pipeline (v1.2).
       Integrated official taste-skill from Leonxlnx (12 design skills). Replaced embedded
       design rules with reference to `.agents/skills/design-taste-frontend/SKILL.md`.
       Preserved 16-phase architecture from v2. Added competitive analysis HTML report
       from v1. Standardized Tailwind CDN + Phosphor Icons + GSAP stack.

Based on: The Welding Brothers + San Diego RoofKings launches (May 2026).
