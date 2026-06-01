# The Welding Brothers — Website

Landing page for The Welding Brothers, Southern California dump truck body fabrication specialists.

**Live (after deploy):** https://theweldingbrothers.site
**Email:** hello@theweldingbrothers.site
**Phone:** (951) 418-3001

## Tech Stack

- HTML5, CSS3, vanilla JavaScript
- GSAP + ScrollTrigger for cinematic animations (MOTION_INTENSITY=8)
- No frameworks, no build step
- Mobile-first responsive (375px → 768px → 1280px → 1920px)
- taste-skill: DESIGN_VARIANCE=4, VISUAL_DENSITY=5

## Project Structure

```
welding-brothers/
├── index.html              # Single landing page
├── 404.html                # Custom 404
├── assets/
│   ├── images/
│   │   ├── dump2.jpg       # Red dump truck — completed work
│   │   ├── dump3.jpg       # Gray dump truck — chassis work
│   │   └── logo.jpg        # Company logo
│   └── video/              # Empty — for future 3D animations
├── css/
│   └── style.css           # All styles
├── js/
│   └── main.js             # GSAP, hero tabs, lang toggle, form, lightbox
├── sitemap.xml
├── robots.txt
└── README.md
```

## Color Palette

| Role | Hex | Usage |
|------|-----|-------|
| Primary Blue | `#2979C1` | CTAs, accents, nav highlight |
| Blue Hover | `#3388D0` | Button hover states |
| Blue Accent | `#5BA0E9` | Star ratings, micro-interactions |
| Charcoal | `#1A1A1A` | Main background (never #000) |
| Dark Surface | `#1E1E1E` | Cards, form backgrounds |
| Deep Surface | `#111111` | Footer, hero animation zone |
| Steel Gray | `#8A8A8A` | Secondary text, dividers |

## Typography

- **Headings:** Oswald Bold — condensed, industrial, authoritative
- **Body:** DM Sans — clean, modern, premium (no Inter per taste-skill)
- **Spanish:** Both fonts support extended Latin characters

## Features

- **Bilingual EN/ES** — toggle persists in localStorage
- **Phone-first CTA** — (951) 418-3001 prominent in nav and hero
- **3D Hero Animation** — Single 5s trailer: bare chassis → custom dump body fabrication
- **Visual Warranty Module** — 3-year structural / 1-year general workmanship
- **Testimonials Section** — 3 customer reviews
- **Photo upload** — 5 photos max, JPG/PNG/HEIC, 10MB each
- **Smart form** — Name, Phone, Job Type, Best Time to Call
- **GSAP scroll animations** — cinematic section reveals (MI=8)
- **Lightbox gallery** — click to enlarge photos
- **3D placeholders** — 3 marked slots for Seedance 2.0 animations
- **Schema.org LocalBusiness** — full markup with Southern California areaServed
- **prefers-reduced-motion** respected
- **Glass morphism nav** — backdrop-filter blur

## Service Area

Perris, Fontana, Ontario, Riverside, Rancho Cucamonga, San Bernardino, Moreno Valley, Corona & all of Southern California.

## Warranty

- **3-Year Structural:** Frame, welds, structural integrity
- **1-Year General:** Hydraulics, tailgate mechanisms, hinges, non-structural work

All warranties provided in writing per California CCR §3376.

## Deployment (Vercel)

```bash
cd welding-brothers
vercel --prod
```

Or via Vercel dashboard:
1. Go to https://vercel.com/new
2. Import `welding-brothers/` folder
3. Framework: Other (static site)
4. Deploy

## Connecting the Form Endpoint

The form currently shows a success message even without a backend (graceful degradation).

To connect a real endpoint:

1. Deploy the Railway backend
2. In `js/main.js`, update the endpoint variable:
   ```js
   const endpoint = 'https://your-railway-app.railway.app/api/quote';
   ```
3. The payload format is:
   ```json
   {
     "name": "string",
     "phone": "string",
     "jobType": "string",
     "bestTime": "string",
     "lang": "en|es",
     "photos": [{"name": "string", "data": "base64"}],
     "submittedAt": "ISO date"
   }
   ```

## 3D Animation Integration

Three animation slots are marked in the HTML for Seedance 2.0:

| Location | Desktop | Mobile | Type |
|----------|---------|--------|------|
| Hero — Before | 1920×1080 | 1080×1920 | WebM with alpha |
| Hero — During | 1920×1080 | 1080×1920 | WebM with alpha |
| Hero — After | 1920×1080 | 1080×1920 | WebM with alpha |
| Services (left) | 1280×720 | 750×750 | WebM with alpha |
| Process (right) | 1280×720 | 750×750 | WebM with alpha |

See `research/seedance-prompts.md` for full generation prompts.

## SEO Checklist

- [x] Title tag with primary keyword
- [x] Meta description
- [x] Canonical URL
- [x] Open Graph tags
- [x] Schema.org LocalBusiness (Southern California areaServed)
- [x] Heading hierarchy (H1 → H3)
- [x] Alt text on all images
- [x] sitemap.xml
- [x] robots.txt
- [x] Custom 404 page
- [x] Mobile responsive
- [ ] favicon.ico
- [ ] OG image (1200×630px)
- [ ] Google Business Profile (after launch)
- [ ] Google Search Console (after domain setup)
