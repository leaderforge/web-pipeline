# Railway Config — MedillaForms Backend (v2.0 Node.js)

**Version:** 2.0 (Node.js)
**Date:** 2026-05-31

---

## Architecture

MedillaForms corre como un **proyecto independiente** en Railway, separado de hermes-telegram:

```
Railway Project: medillaforms (1a3369b9-1555-4651-8144-018e74c7bb3e)
├── medillaforms (147b02fc)     ← Node.js Express backend
├── Postgres                    ← Sesiones + conversation_log
└── Redis                       ← Cache + locks distribuidos

Railway Project: hermes-telegram (32ce3577-534f-4f25-974d-ae8e62e0b40a)
└── hermes-telegram             ← Python bot de Daniel (independiente)
```

---

## Deploy

```bash
cd 04-Web-Pipeline/proyectos/medilla-forms/medillaforms

# Link al proyecto correcto
railway link -p medillaforms

# Deploy
railway up --service=medillaforms

# Redeploy (sin rebuild)
railway redeploy --service=medillaforms --yes

# Ver logs
railway logs --service=medillaforms
```

---

## Procfile

```
web: npx playwright install chromium && node index.js
```

Nota: Playwright instala Chromium en cada deploy (~30s extra). Para producción se puede usar `playwright-core` con browser pre-instalado.

---

## Variables de Entorno

Ver `infrastructure/env-variables.md` para la lista completa.

Comando para setear:
```bash
railway variables set --service=medillaforms KEY=VALUE
```

---

## PostgreSQL + Redis

Agregados con:
```bash
railway add --database postgres
railway add --database redis
```

Las URLs se obtienen de:
```bash
railway variables list --service=Postgres
railway variables list --service=Redis
```

---

## Health Monitor

Hermes (`hermes-telegram`) puede observar medillaforms vía:
```
GET https://medillaforms-production.up.railway.app/api/internal/ping
```

---

## Telnyx Webhook

Ya configurado en Telnyx Portal → Messaging Profiles:
- URL: `https://medillaforms-production.up.railway.app/webhook/whatsapp`

---

## Stripe Webhook

En Stripe Dashboard → Webhooks:
- URL: `https://medillaforms-production.up.railway.app/stripe/webhook`
- Eventos: `checkout.session.completed`

---

## Telegram Webhook

Configurado vía API:
```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://medillaforms-production.up.railway.app/telegram/webhook"
```

---

## Comandos Útiles

```bash
# Status
railway status

# Env vars
railway variables list --service=medillaforms
railway variables set KEY=VALUE --service=medillaforms

# Logs
railway logs --service=medillaforms

# Redeploy
railway redeploy --service=medillaforms --yes

# Deploy
railway up --service=medillaforms
```
