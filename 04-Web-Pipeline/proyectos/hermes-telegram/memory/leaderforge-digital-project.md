---
name: leaderforge-digital-project
description: "leaderforge.digital — landing page, Railway API, cold outreach con Netlify, pipeline diario"
metadata:
  node_type: memory
  type: project
---

LeaderForge Digital es la agencia de sitios web para negocios locales de oficios. Proyecto personal de Daniel.

## Landing Page
- **URL**: https://leaderforge.digital
- **Deploy**: Vercel
- **Stack**: Tailwind CDN + GSAP ScrollTrigger + Phosphor Icons
- **Pendiente**: animaciones de video (Seedance 2.0)

## Backend (Railway)
- **API**: https://dependable-luck-production-7edf.up.railway.app
- **Endpoints**: `/api/quote`, `/api/demo-view` (tracking pixel con bot filter 16 keywords), `/api/whatsapp-click`, `/sms/incoming`

## Cold Outreach System
Scripts en `outreach/scripts/`:
- `scrape-leads.py` — Firecrawl → CSV de leads
- `deploy-demo.py` / `deploy-batch.py` — Template personalizado → Netlify (demo-template con 10 slots {{BUSINESS_NAME}}, {{PHONE}}, etc.)
- `screenshot.py` — Playwright → screenshots
- `send-campaign.py` — Email HTML con screenshot CID inline
- `follow-up.py` — Day 3 / Day 7 emails de seguimiento
- `phone-outreach.py` — Notificaciones via Telegram (SMS + screenshot)
- `cleanup.py` — Elimina demos >14 dias sin respuesta
- `daily-pipeline.py` — Corre follow-up + cleanup (diseñado para cron 7am)

**Leads actuales**: 5 welding businesses en CA (2 con email ya contactados, 3 phone-only pendientes)

## Pendiente
- Phone outreach para 3 leads sin email (Morena Welding, California On-Site Welding, American Mobile Welding)
- Verificar daily-pipeline.py corrio hoy; revisar campaign-log.csv por nuevas respuestas

## Google Workspace Trial
- Inicio: 2026-05-25 | Cobro $16: 2026-06-08 | Notificar: 2026-06-07
