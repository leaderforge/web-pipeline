# Stack Architecture — MedillaForms v2.0

**Versión:** 2.0
**Fecha:** 2026-05-31

---

## Diagrama de Arquitectura

```
Cliente (WhatsApp)
    │
    ▼
Telnyx (bridge oficial Meta)
    │
    │  webhook POST /webhook/whatsapp
    ▼
Railway — medillaforms (Node.js Express)
    │
    ├── DeepSeek v4-pro       ← conversación del agente
    ├── GPT-4o-mini Vision    ← análisis de facturas (OCR + errores)
    ├── Whisper               ← transcripción notas de voz
    ├── Stripe API            ← pagos ($29 USD)
    ├── Zelle (manual)        ← confirmación vía Telegram
    ├── Playwright            ← HTML → 2 PNG (es + en)
    ├── Google Sheets API     ← reportes automáticos
    ├── Firecrawl API         ← research bajo demanda
    ├── PostgreSQL            ← sesiones, conversation_log
    └── Redis                 ← cache, locks distribuidos
    │
    ▼
Cliente recibe:
    - Análisis de factura (gratis)
    - Opción de pago ($29 USD — Stripe o Zelle)
    - 2 cartas PNG (español + inglés)
    - Instrucciones de envío

Notificaciones a Daniel:
    - @MedillaFormsBot (Telegram)
    - Google Sheet "MedillaForms" → tab "Reportes"
```

---

## Componentes

| Componente | Tecnología | Host/Plan | Costo |
|---|---|---|---|
| Landing | HTML/CSS | Vercel Hobby | $0 |
| Backend | Node.js + Express | Railway Hobby | ~$5/mes |
| DB | PostgreSQL | Railway | Incluido |
| Cache | Redis | Railway | Incluido |
| Conversación | DeepSeek v4-pro | Pay-as-you-go | ~$0.001/msg |
| Visión (OCR) | GPT-4o-mini | Pay-as-you-go | ~$0.003/análisis |
| Audio | OpenAI Whisper | Pay-as-you-go | ~$0.006/min |
| WhatsApp | Telnyx | ~$0.004/msg | Variable |
| Pagos | Stripe + Zelle | 2.9% + $0.30 | ~$1.14/venta |
| Cartas | Playwright | Incluido en Railway | $0 |
| Reportes | Google Sheets API | Gratis | $0 |
| Research | Firecrawl | Pay-as-you-go | ~$0.01/búsqueda |
| Dominio | medillaforms.com | Porkbun | ~$10/año |

---

## Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Health check (DB + uptime) |
| GET | `/api/internal/ping` | Health monitor (Hermes) |
| POST | `/webhook/whatsapp` | Telnyx WhatsApp inbound |
| POST | `/stripe/webhook` | Stripe checkout.session.completed |
| POST | `/telegram/webhook` | Comando "listo <id>" (Zelle) |
| GET | `/api/admin/sessions` | Sesiones activas |
| GET | `/api/admin/stats` | Estadísticas diarias |
| GET | `/api/admin/health-details` | Health extendido |

---

## Flujo de Datos

### Análisis de factura
1. Cliente envía imagen → Telnyx webhook → Railway
2. Railway descarga imagen → resize (sharp, max 2048px) → GPT-4o-mini Vision
3. OpenAI devuelve JSON estructurado con errores A-G
4. Cross-reference con KB local (CPT codes, billing errors, charity care, state laws)
5. Guarda analysis_result en PostgreSQL

### Pago Stripe
1. Hermes presenta hook → cliente elige Stripe
2. Railway crea Stripe Checkout Session ($29)
3. Cliente paga → webhook checkout.session.completed → Railway
4. payment_confirmed = true → FASE 4 (educator + closer)

### Pago Zelle
1. Cliente elige Zelle → Hermes envía datos
2. Telegram notifica a Daniel: "💰 Zelle pendiente — listo <session_id>"
3. Daniel verifica transferencia → escribe "listo <session_id>" en @MedillaFormsBot
4. Telegram webhook → payment_confirmed = true → FASE 4

### Entrega de cartas
1. Educator explica errores uno por uno
2. Closer genera 2 PNG con Playwright (HTML → screenshot)
3. Envía ambas imágenes por WhatsApp
4. Instrucciones de envío (correo certificado)
5. Google Sheets: append row a "Reportes"

---

## Proyecto Railway

MedillaForms es un proyecto **independiente** de hermes-telegram:

```
medillaforms (1a3369b9-1555-4651-8144-018e74c7bb3e)
├── medillaforms (147b02fc)     ← Node.js Express
├── Postgres (3ebed6aa)         ← Sesiones
└── Redis (183beb56)            ← Cache
```

Si hermes-telegram cae, MedillaForms sigue operando sin interrupción.
