# Environment Variables — MedillaForms v2.0

**Version:** 2.0 (Node.js)
**Updated:** 2026-05-31

---

## Backend (Railway — `medillaforms` service)

### Telnyx (WhatsApp bridge)

| Variable | Estado | Descripción |
|---|---|---|
| `TELNYX_API_KEY` | ✅ Configurado | API key de Telnyx |
| `TELNYX_PUBLIC_KEY` | ✅ Configurado | Ed25519 public key para webhook |
| `TELNYX_PHONE_NUMBER` | ✅ `+12139054680` | Número WhatsApp |

### OpenAI (Vision + Whisper)

| Variable | Estado | Descripción |
|---|---|---|
| `OPENAI_API_KEY` | ✅ Configurado | Misma key que Hermes |
| `OPENAI_MODEL` | ✅ `gpt-4o-mini` | Modelo para análisis |

### DeepSeek (Conversación del agente)

| Variable | Estado | Descripción |
|---|---|---|
| `DEEPSEEK_API_KEY` | ✅ Configurado | API key DeepSeek |
| `DEEPSEEK_BASE_URL` | ✅ `https://api.deepseek.com` | **IMPORTANTE:** endpoint OpenAI-compatible. NO usar `/anthropic` |

### Stripe (Pagos)

| Variable | Estado | Descripción |
|---|---|---|
| `STRIPE_SECRET_KEY` | ⚠️ `sk_test_PLACEHOLDER` | Reemplazar con key real |
| `STRIPE_WEBHOOK_SECRET` | ⚠️ `whsec_PLACEHOLDER` | Reemplazar con key real |
| `STRIPE_PRICE_MAIN` | ⚠️ `price_PLACEHOLDER` | Producto $29 USD |
| `STRIPE_PRICE_EXIT_INTENT` | ⚠️ `price_PLACEHOLDER` | Producto $24 USD |

### Telegram (@MedillaFormsBot)

| Variable | Estado | Descripción |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ✅ Configurado | `8764279536:...` |
| `TELEGRAM_CHAT_ID` | ✅ `8753553351` | Chat ID de Daniel |
| `MEDILLA_TELEGRAM_BOT_TOKEN` | ✅ (duplicado) | Mismo token, nombre legacy |
| `MEDILLA_TELEGRAM_CHAT_ID` | ✅ (duplicado) | Mismo chat ID, nombre legacy |

### Google Sheets

| Variable | Estado | Descripción |
|---|---|---|
| `GOOGLE_SHEETS_ID` | ✅ `1BRzo2GaXuOSUOxgdxEXx8Ow2p-Pq47Po4RuVMOR8OsY` | Sheet "MedillaForms" |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | ✅ `leaderforge-sheets@leaderforge-ai.iam.gserviceaccount.com` | Service account |
| `GOOGLE_PRIVATE_KEY` | ✅ Configurado | RSA private key |

### Database

| Variable | Estado | Descripción |
|---|---|---|
| `DATABASE_URL` | ✅ Auto (Railway PostgreSQL) | `postgresql://...` |
| `REDIS_URL` | ✅ Auto (Railway Redis) | `redis://default:...@redis.railway.internal:6379` |

### Zelle

| Variable | Estado | Descripción |
|---|---|---|
| `ZELLE_PHONE` | ✅ `9517336105` | Número de Daniel |
| `ZELLE_NAME` | ✅ `Daniel Alcantara` | Nombre en Zelle |

### Firecrawl

| Variable | Estado | Descripción |
|---|---|---|
| `FIRECRAWL_API_KEY` | ✅ Configurado | Misma key que Hermes |

### Otros

| Variable | Estado | Descripción |
|---|---|---|
| `PORT` | ✅ `3000` | Puerto del servidor |
| `MEDILLA_FORWARD_PHONE` | ✅ `+19517336105` | Forward de llamadas |
| `NOTIFY_SECRET` | ✅ Configurado | Secreto para comunicación interna |

---

## Local Development

Archivo `.env` en `04-Web-Pipeline/proyectos/medilla-forms/medillaforms/.env`:

Copiar de `.env.example` y llenar. Para desarrollo local sin Railway:

```
DATABASE_URL=postgresql://localhost:5432/medillaforms
REDIS_URL=redis://localhost:6379
PORT=3000
# Las demás APIs se pueden dejar vacías para test — el código maneja graceful degradation
```
