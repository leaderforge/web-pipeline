# Web Pipeline v2.0 — Unified Client Launch System

Sistema unificado de lanzamiento de paginas para clientes. Fusiona lo mejor de Web Builder (v1) y Launch Pipeline (v2).

## Estructura

```
04-Web-Pipeline/
├── .claude/skills/
│   └── client-launch-pipeline.md   ← MASTER SKILL (16 fases)
├── .agents/skills/                 ← Taste-skill oficial (Leonxlnx, 12 skills)
│   └── design-taste-frontend/      ← Design skill principal
├── proyectos/
│   ├── welding-brothers/           ← Migrado de C:\Web Builder
│   ├── welding-brothers-api/       ← Backend Welding Brothers (Railway)
│   ├── roofkings/                  ← Migrado de C:\Launch Pipeline Websites
│   └── roofkings-api/              ← Backend RoofKings (Railway)
├── templates/
│   ├── ads-tracking-methodology.md ← Metodologia universal de tracking
│   └── animation-prompts.md        ← Prompts para FLUX + Seedance/Runway
├── .mcp.json                       ← Firecrawl MCP config
├── claude-mode.ps1                 ← Switch a Claude API
├── deepseek-mode.ps1               ← Switch a DeepSeek API
└── README.md
```

## Como usar

1. Abre este directorio en VS Code con Claude Code
2. Di: "launch client" o "new client for [business]"
3. El skill `client-launch-pipeline` se activa automaticamente
4. Sigue las 16 fases modulares

## Design system

Usa el taste-skill oficial de Leonxlnx (instalado en `.agents/skills/`).
12 skills disponibles: design-taste-frontend, high-end-visual-design, minimalist-ui,
industrial-brutalist-ui, image-to-code, y mas.

## Stack estandar

- Frontend: HTML + Tailwind CDN + GSAP + Phosphor Icons (Vercel)
- Backend: Node.js + Express (Railway, $5/mo)
- Storage: Cloudflare R2
- Database: Google Sheets (CRM ligero)
- Telefonia: Telnyx
- Notificaciones: Telegram Bot API
- Tracking: GA4 + Meta Pixel + Google Ads
- Research: Firecrawl MCP
