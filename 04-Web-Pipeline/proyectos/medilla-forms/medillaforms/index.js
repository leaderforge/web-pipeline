// =============================================================================
// MedillaForms — Backend Principal
// Servicio educativo de análisis de facturas médicas vía WhatsApp
// Stack: Node.js + Express + PostgreSQL + Redis en Railway
// =============================================================================

import "dotenv/config";
import express from "express";

// --- Database + Session ---
import {
  pool, initDB,
  loadSession, createSession,
  appendToConversationLog,
  buildConversationHistory, buildContextFromHistory,
} from "./middleware/session.js";

// --- Services ---
import { whatsapp } from "./services/whatsapp.js";
import { openai } from "./services/openai.js";
import { deepseek } from "./services/deepseek.js";
import { stripe } from "./services/stripe.js";
import { telegram } from "./services/telegram.js";
import { sheets } from "./services/sheets.js";
import { firecrawl } from "./services/firecrawl.js";

// --- Agents ---
import { HermesAgent } from "./agents/hermes.js";
import { IntakeAgent } from "./agents/intake.js";
import { AnalyzerAgent } from "./agents/analyzer.js";
import { EducatorAgent } from "./agents/educator.js";
import { CloserAgent } from "./agents/closer.js";

// --- Middleware ---
import { enforceGuardrails } from "./middleware/legal.js";

// --- Jobs ---
// JOBS DE FOLLOW-UP — DESACTIVADOS
// Para activar: descomentar las líneas de cron.schedule
// y aprobar templates de WhatsApp en Meta Business Manager
// import { startFollowupJobs } from "./jobs/followup_2h.js";
// import { startFollowup20h } from "./jobs/followup_20h.js";

// =============================================================================
// Express App
// =============================================================================
const app = express();
const PORT = process.env.PORT || 3000;

// Raw body for Stripe webhook signature verification
app.use("/stripe/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

// =============================================================================
// Health Check
// =============================================================================
app.get("/health", async (req, res) => {
  try {
    const { rowCount } = await pool.query("SELECT 1");
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      db: rowCount > 0 ? "connected" : "error",
      uptime: process.uptime(),
    });
  } catch (e) {
    res.status(503).json({ status: "degraded", error: e.message });
  }
});

// Internal ping for Hermes health monitor
app.get("/api/internal/ping", (req, res) => {
  res.json({ pong: true, ts: new Date().toISOString() });
});

// =============================================================================
// Telnyx WhatsApp Webhook (POST /webhook/whatsapp)
// =============================================================================
app.post("/webhook/whatsapp", async (req, res) => {
  const signature = req.headers["telnyx-signature-ed25519"];
  const timestamp = req.headers["telnyx-timestamp"];
  const rawBody = JSON.stringify(req.body);

  // Verify Ed25519 signature
  if (!whatsapp.verifySignature(rawBody, signature, timestamp)) {
    console.warn("⚠️ Webhook signature verification failed");
    // Still return 200 to prevent Telnyx retry storms
    return res.status(200).json({ status: "signature_failed" });
  }

  const { data } = req.body;
  const eventType = data?.event_type;
  const eventId = data?.id;

  console.log(`📨 Webhook: ${eventType} id=${eventId?.slice(0, 12)}`);

  // Only process inbound messages
  if (eventType !== "message.received") {
    return res.status(200).json({ status: "ignored", event_type: eventType });
  }

  // Extract phone and message from Telnyx payload
  const payload = data?.payload || {};
  const fromRaw = payload.from || {};
  const phone = typeof fromRaw === "object"
    ? (fromRaw.phone_number || "")
    : String(fromRaw || "");
  const contactName = typeof fromRaw === "object" ? (fromRaw.name || "") : "";
  const text = payload.text || "";
  const media = payload.media || [];
  const msgType = payload.type || "text";

  if (!phone) {
    return res.status(200).json({ status: "no_phone" });
  }

  // Respond 200 immediately — process async
  res.status(200).json({ status: "accepted" });

  // Fire-and-forget processing
  processInbound(phone, text, media, contactName, msgType).catch((err) => {
    console.error("❌ processInbound error:", err);
    telegram.alertServerError(err).catch(() => {});
  });
});

// =============================================================================
// Stripe Webhook (POST /stripe/webhook)
// =============================================================================
app.post("/stripe/webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const event = stripe.verifyWebhook(req.body, sig);

  if (!event) {
    return res.status(400).json({ error: "Invalid signature" });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const sessionId = session.client_reference_id;

    if (sessionId) {
      await confirmPayment(sessionId, "stripe", session.id);
    }
  }

  res.status(200).json({ status: "ok" });
});

// =============================================================================
// Telegram Webhook (POST /telegram/webhook)
// =============================================================================
app.post("/telegram/webhook", async (req, res) => {
  const message = req.body?.message || req.body?.channel_post;
  if (!message) return res.status(200).json({ status: "no_message" });

  const chatId = String(message.chat?.id || "");
  const expectedChatId = process.env.MEDILLA_TELEGRAM_CHAT_ID || "";
  const text = message.text || "";

  // Verify it's from Daniel
  if (chatId !== expectedChatId) {
    return res.status(200).json({ status: "unauthorized" });
  }

  // Parse "listo <session_code>" command (Zelle confirmation)
  // The code is the first 8 chars of the UUID — look up full session
  const listoMatch = text.match(/^listo\s+([\w-]+)/i);
  if (listoMatch) {
    const code = listoMatch[1];

    // Find session by UUID prefix (first 8 chars)
    const sessionResult = await pool.query(
      `SELECT id FROM sessions
       WHERE id::text LIKE $1 || '%'
       AND payment_confirmed = false
       AND state IN ('waiting_zelle', 'waiting_payment')
       LIMIT 1`,
      [code]
    );

    if (sessionResult.rowCount === 0) {
      await telegram.sendMessage(
        `❌ No se encontró sesión pendiente con código ${code}. Verifica el ID.`
      );
      return res.status(200).json({ status: "ok", confirmed: false });
    }

    const sessionId = sessionResult.rows[0].id;
    const found = await confirmPayment(sessionId, "zelle", null);

    await telegram.sendMessage(
      found
        ? `✅ Pago confirmado para sesión ${sessionId.slice(0, 8)}. Enviando cartas...`
        : `❌ Error al confirmar sesión ${sessionId.slice(0, 8)}.`
    );

    return res.status(200).json({ status: "ok", confirmed: found });
  }

  return res.status(200).json({ status: "ignored" });
});

// =============================================================================
// Admin Endpoints
// =============================================================================
app.get("/api/admin/sessions", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, whatsapp_number, state, hospital_name, payment_method,
              payment_confirmed, errors_found, last_message_at
       FROM sessions
       WHERE session_closed_at IS NULL
       ORDER BY last_message_at DESC
       LIMIT 50`
    );
    res.json({ total: result.rowCount, sessions: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/admin/stats", async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const result = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE DATE(created_at) = $1) AS today_sessions,
         COUNT(*) FILTER (WHERE payment_confirmed = true AND DATE(created_at) = $1) AS today_paid,
         COUNT(*) FILTER (WHERE sheets_reported = true AND DATE(created_at) = $1) AS today_delivered
       FROM sessions`,
      [today]
    );
    res.json({ date: today, ...result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =============================================================================
// Core: Process Inbound Messages
// =============================================================================
async function processInbound(phone, text, media, contactName, msgType) {
  // Load or create session from PostgreSQL
  let session = await loadSession(phone);

  if (!session) {
    session = await createSession(phone, contactName);
  }

  // Detect returning user (24h+ since last message)
  const returningContext = buildContextFromHistory(session);

  // Save incoming message to conversation log
  await appendToConversationLog(session.id, "user", text || "[media]", msgType);

  // Handle media (photo of bill)
  if (media && media.length > 0) {
    await handleIncomingMedia(phone, media, session);
    return;
  }

  // Handle audio (voice note)
  if (text === "" && msgType === "audio" && media?.length > 0) {
    await handleVoiceNote(phone, media, session);
    return;
  }

  // Handle text
  if (text) {
    await routeText(phone, text, session, returningContext);
    return;
  }

  // Unsupported — send fallback
  await whatsapp.sendText(phone, "Por ahora solo puedo leer texto e imágenes. ¿Tiene una factura médica que enviarme? 📸");
}

// Session management functions imported from middleware/session.js

// =============================================================================
// Handle Media (Photo of Bill)
// =============================================================================
async function handleIncomingMedia(phone, media, session) {
  const mediaUrl = media[0]?.url;
  if (!mediaUrl) {
    await whatsapp.sendText(phone, "No pude leer la imagen. ¿Podría reenviarla?");
    return;
  }

  await whatsapp.sendText(phone, "¡Perfecto! Recibí su factura. Deme un momento para analizarla... ⏳");

  try {
    // Download image from Telnyx
    const imageBuffer = await whatsapp.downloadMedia(mediaUrl);

    // Validate size
    if (imageBuffer.length > 10 * 1024 * 1024) {
      await whatsapp.sendText(phone, "La imagen es muy grande. ¿Podría enviar una foto más pequeña?");
      return;
    }

    // Resize if needed (max 2048px)
    const sharp = (await import("sharp")).default;
    let processed = imageBuffer;
    const metadata = await sharp(imageBuffer).metadata();
    const maxDim = Math.max(metadata.width || 0, metadata.height || 0);
    if (maxDim > 2048) {
      const ratio = 2048 / maxDim;
      processed = await sharp(imageBuffer)
        .resize({
          width: Math.round((metadata.width || 2048) * ratio),
          height: Math.round((metadata.height || 2048) * ratio),
          fit: "inside",
        })
        .jpeg({ quality: 85 })
        .toBuffer();
      console.log(`📐 Resized: ${metadata.width}x${metadata.height} → processed`);
    }

    // Run analyzer
    const analyzer = new AnalyzerAgent(whatsapp, openai, session);
    await analyzer.analyze(processed);

  } catch (err) {
    console.error("❌ Media processing error:", err);
    await telegram.alertServerError(err).catch(() => {});
    await whatsapp.sendText(phone, "Disculpe, tuve un problema técnico. ¿Podría intentarlo de nuevo en un momento?");
  }
}

// =============================================================================
// Handle Voice Notes
// =============================================================================
async function handleVoiceNote(phone, media, session) {
  try {
    await whatsapp.sendText(phone, "Estoy escuchando su mensaje... 🎧");

    const mediaUrl = media[0]?.url;
    if (!mediaUrl) {
      await whatsapp.sendText(phone, "No pude escuchar el audio. ¿Podría escribir su mensaje?");
      return;
    }

    const audioBuffer = await whatsapp.downloadMedia(mediaUrl);
    const transcription = await openai.transcribeAudio(audioBuffer);

    if (!transcription) {
      await whatsapp.sendText(phone, "No pude entender el audio. ¿Podría escribir su mensaje o intentarlo de nuevo?");
      return;
    }

    await appendToConversationLog(session.id, "user", `[voice] ${transcription}`, "transcription");
    const returningContext = buildContextFromHistory(session);
    await routeText(phone, transcription, session, returningContext);

  } catch (err) {
    console.error("❌ Voice note error:", err);
    await whatsapp.sendText(phone, "Tuve un problema procesando su nota de voz. ¿Podría escribir su mensaje?");
  }
}

// =============================================================================
// Route Text to Agent Based on State
// =============================================================================
async function routeText(phone, text, session, returningContext = "") {
  // Enforce legal guardrails before anything
  const guardrailResult = enforceGuardrails(text, session);
  if (guardrailResult.blocked) {
    await whatsapp.sendText(phone, guardrailResult.response);
    return;
  }

  // ── 24-HOUR RULE ──────────────────────────────────────────────────
  // WhatsApp Business: solo responder dentro de ventana de 24h
  const lastMsg = session.last_message_at ? new Date(session.last_message_at) : null;
  const hoursSinceLastMsg = lastMsg
    ? (Date.now() - lastMsg.getTime()) / (1000 * 60 * 60)
    : 0;
  // Si pasaron más de 24h y el usuario NO acaba de escribir, no iniciar conversación
  if (hoursSinceLastMsg > 24 && session.state === "closed") {
    await whatsapp.sendText(phone,
      "¡Qué gusto volver a saber de usted! ¿Tiene otra factura que revisar? 📸"
    );
    await pool.query(
      `UPDATE sessions SET state = 'intake', updated_at = NOW() WHERE id = $1`,
      [session.id]
    );
    return;
  }

  // ── ALCANCE: verificar que el mensaje sea sobre facturación médica ─
  const outOfScopePhrases = [
    "clima", "weather", "fútbol", "football", "política", "politics",
    "elecciones", "religión", "religion", "receta", "prescription",
  ];
  const textLower = text.toLowerCase();
  const isOutOfScope = outOfScopePhrases.some(p => textLower.includes(p));
  if (isOutOfScope) {
    await whatsapp.sendText(phone,
      "Mi función es ayudarle exclusivamente con su facturación médica. " +
      "¿Hay algo sobre los cargos de su factura en lo que pueda servirle?"
    );
    return;
  }

  const state = session.state || "intake";

  switch (state) {
    case "new":
    case "intake": {
      const intake = new IntakeAgent(whatsapp, deepseek, session);
      await intake.handle(text, returningContext);
      break;
    }

    case "analyzing":
    case "analyzed": {
      // User sent text while analyzing or between analysis and hook
      await whatsapp.sendText(phone, "Estoy procesando su factura en este momento. Un momento por favor... ⏳");
      break;
    }

    case "waiting_payment":
    case "waiting_zelle": {
      // User is in payment phase — can chat but can't advance without payment
      const hermes = new HermesAgent(whatsapp, deepseek, session);
      await hermes.handleWaitingPayment(text);
      break;
    }

    case "awaiting_signer": {
      // User is responding to signer prompt (minor patient)
      const closer = new CloserAgent(whatsapp, deepseek, stripe, session);
      await closer.handleSignerResponse(text);
      break;
    }

    case "paid":
    case "delivering": {
      const educator = new EducatorAgent(whatsapp, deepseek, firecrawl, session);
      await educator.handle(text);
      break;
    }

    case "delivered": {
      const closer = new CloserAgent(whatsapp, deepseek, stripe, session);
      await closer.handlePostDelivery(text);
      break;
    }

    case "closed": {
      // Returning user who completed a previous session
      await whatsapp.sendText(phone,
        "¡Qué gusto verle de nuevo! ¿Tiene otra factura que revisar? 📸"
      );
      await pool.query(
        `UPDATE sessions SET state = 'intake', updated_at = NOW() WHERE id = $1`,
        [session.id]
      );
      break;
    }

    default: {
      const hermes = new HermesAgent(whatsapp, deepseek, session);
      await hermes.handleFallback(text);
    }
  }
}

// =============================================================================
// Confirm Payment (Stripe webhook or Zelle manual)
// =============================================================================
async function confirmPayment(sessionId, method, stripeSessionId) {
  const result = await pool.query(
    `UPDATE sessions
     SET payment_confirmed = true,
         payment_method = $2::varchar(20),
         state = 'paid',
         stripe_session_id = COALESCE($3::varchar(255), stripe_session_id),
         zelle_pending = CASE WHEN $2 = 'zelle' THEN false ELSE zelle_pending END,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [sessionId, method, stripeSessionId]
  );

  if (result.rowCount === 0) return false;

  const session = result.rows[0];

  // Notify user
  await whatsapp.sendText(session.whatsapp_number,
    "¡Confirmado! Recibimos su pago. En un momento le enviamos sus cartas. 🎉"
  );

  // Trigger FASE 4 — delivery
  await deliverLetters(session);

  return true;
}

// =============================================================================
// FASE 4 — Generate and Deliver Dispute Letters
// =============================================================================
async function deliverLetters(session) {
  try {
    const closer = new CloserAgent(whatsapp, deepseek, stripe, session);
    await closer.deliver();
  } catch (err) {
    console.error("❌ Delivery error:", err);
    await telegram.alertServerError(err).catch(() => {});
    await whatsapp.sendText(session.whatsapp_number,
      "Disculpe, tuve un problema técnico generando sus cartas. Estoy trabajando en resolverlo. Se las enviaré en unos minutos."
    );
  }
}

// =============================================================================
// Startup
// =============================================================================
async function start() {
  console.log("🚀 Iniciando MedillaForms...");

  // Initialize database
  await initDB();
  console.log("✅ PostgreSQL connected");

  // Verify services
  try {
    await redis.ping();
    console.log("✅ Redis connected");
  } catch (e) {
    console.warn("⚠️ Redis not available — running without cache");
  }

  // Start Express
  app.listen(PORT, () => {
    console.log(`✅ MedillaForms running on port ${PORT}`);
    console.log(`   Health: http://localhost:${PORT}/health`);
    console.log(`   WhatsApp webhook: POST /webhook/whatsapp`);
    console.log(`   Stripe webhook: POST /stripe/webhook`);
    console.log(`   Telegram webhook: POST /telegram/webhook`);
  });

  // JOBS DE FOLLOW-UP — DESACTIVADOS
  // Para activar: descomentar estas líneas
  // y aprobar templates de WhatsApp en Meta Business Manager
  //
  // import { Cron } from "cron";
  // const followup2h = new Cron("*/30 * * * *", async () => {
  //   const { runFollowup2h } = await import("./jobs/followup_2h.js");
  //   await runFollowup2h(pool, whatsapp, telegram);
  // });
  // const followup20h = new Cron("0 */4 * * *", async () => {
  //   const { runFollowup20h } = await import("./jobs/followup_20h.js");
  //   await runFollowup20h(pool, whatsapp, stripe, telegram);
  // });
  // console.log("✅ Follow-up jobs activated");
  console.log("⚠️ Follow-up jobs DESACTIVADOS — templates pendientes de aprobación Meta");
}

// Redis connection (lazy — won't crash if unavailable)
import Redis from "ioredis";
const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: 2,
  lazyConnect: true,
  retryStrategy: () => null, // Don't retry — fail fast
});

start().catch((err) => {
  console.error("❌ Failed to start:", err);
  process.exit(1);
});

export { app };
