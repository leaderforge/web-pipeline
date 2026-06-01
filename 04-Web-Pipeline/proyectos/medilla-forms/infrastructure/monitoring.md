# Monitoring — MedillaForms

**Versión:** 2.0
**Fecha:** 2026-05-31

---

## Health Checks

### Railway
- Endpoint: `GET /health` (devuelve status + DB + uptime)
- Railway hace ping cada 30s
- Si falla 3 veces → restart automático
- `restartPolicyMaxRetries = 3` en railway.toml

### Hermes Health Monitor (externo)
- Hermes (`hermes-telegram`) puede monitorear medillaforms:
  - `GET https://medillaforms-production.up.railway.app/api/internal/ping`
- Si está caído → `railway up --service=medillaforms` → espera 60s → rechequea
- Si sigue caído → alerta a Daniel-Hermes (chat principal)

---

## Alertas Automáticas a Telegram (@MedillaFormsBot)

### Alertas Críticas (inmediatas)
- OpenAI API caída (3+ fallos)
- Error 500 en el backend
- Stripe webhook failure
- Servicio no responde (health check)
- Imagen no legible (3 intentos fallidos)

### Alertas Informativas
- 💰 Zelle pendiente (con session_id para confirmar)
- 📚 Nuevo dato agregado a KB vía Firecrawl
- 🎉 Primera venta
- 🏆 Hitos de ventas (cada 10)

### Daily Summary (8 PM PT)
- Cartas generadas
- Usuarios nuevos
- Errores
- Ingresos del día

---

## Métricas Clave

| Métrica | Fuente | Frecuencia |
|---|---|---|
| Sesiones activas | `GET /api/admin/sessions` | On demand |
| Ventas del día | `GET /api/admin/stats` | On demand |
| Tokens usados / costo | OpenAI Dashboard | Diario |
| Errores del backend | Railway logs | Continuo |
| Estado del servicio | `GET /health` | 30s (Railway) |

---

## Logs

```bash
railway logs --service=medillaforms
```

Niveles:
- `console.log` — flujo normal (webhooks, pagos, análisis)
- `console.warn` — advertencias (servicio no configurado, OCR bajo)
- `console.error` — errores (API failures, webhook errors)

**Regla:** NUNCA loguear base64 de imágenes ni datos extraídos de facturas. Solo metadata.

---

## Plan de Contingencia

### Si OpenAI API cae
- Mensaje automático: "Servicio no disponible, intente en 5 min"
- Reintentar 3 veces con backoff
- Si > 15 min → notificar a @MedillaFormsBot

### Si Telnyx/WhatsApp cae
- Revisar Telnyx Portal por incidentes
- Si > 30 min → notificar a Daniel

### Si Stripe cae
- No aceptar pagos con tarjeta
- Sugerir Zelle como alternativa
- Si > 1 hora → notificar

### Si Railway cae completamente
- Landing en Vercel muestra mensaje
- WhatsApp no responderá (depende de Railway)
- Railway envía alerta por email
