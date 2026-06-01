// =============================================================================
// Session Middleware — PostgreSQL connection + session helpers
// Imported by BOTH index.js and agents (no circular dependencies)
// =============================================================================

import pg from "pg";
import crypto from "crypto";

const { Pool } = pg;

// Database connection
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// =============================================================================
// Initialize Database — Create sessions table if not exists
// =============================================================================
export async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id                    UUID PRIMARY KEY,
        whatsapp_number       VARCHAR(20) NOT NULL,
        state                 VARCHAR(30) DEFAULT 'intake',
        photos                JSONB DEFAULT '[]'::jsonb,
        photos_expected       INTEGER,
        photos_confirmed      BOOLEAN DEFAULT FALSE,
        analysis_result       JSONB,
        errors_found          INTEGER DEFAULT 0,
        potential_savings     DECIMAL(12,2) DEFAULT 0,
        total_billed          DECIMAL(12,2) DEFAULT 0,
        hospital_name         VARCHAR(255),
        user_state            VARCHAR(5),
        stripe_session_id     VARCHAR(255),
        payment_method        VARCHAR(20),
        payment_confirmed     BOOLEAN DEFAULT FALSE,
        zelle_pending         BOOLEAN DEFAULT FALSE,
        carta_es_url          VARCHAR(500),
        carta_en_url          VARCHAR(500),
        conversation_log      JSONB DEFAULT '[]'::jsonb,
        last_message_at       TIMESTAMP,
        session_started_at    TIMESTAMP DEFAULT NOW(),
        session_closed_at     TIMESTAMP,
        followup_2h_sent      BOOLEAN DEFAULT FALSE,
        followup_20h_sent     BOOLEAN DEFAULT FALSE,
        sheets_reported       BOOLEAN DEFAULT FALSE,
        created_at            TIMESTAMP DEFAULT NOW(),
        updated_at            TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_whatsapp ON sessions(whatsapp_number);
      CREATE INDEX IF NOT EXISTS idx_sessions_state ON sessions(state);
      CREATE INDEX IF NOT EXISTS idx_sessions_last_message ON sessions(last_message_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_payment ON sessions(payment_confirmed, payment_method);
    `);
    console.log("✅ Database tables initialized");
  } finally {
    client.release();
  }
}

// =============================================================================
// Load/Create sessions
// =============================================================================
export async function loadSession(phone) {
  const result = await pool.query(
    `SELECT * FROM sessions
     WHERE whatsapp_number = $1 AND session_closed_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [phone]
  );
  return result.rows[0] || null;
}

export async function createSession(phone, contactName) {
  const id = crypto.randomUUID();
  const result = await pool.query(
    `INSERT INTO sessions (id, whatsapp_number, state, conversation_log, session_started_at, last_message_at, updated_at)
     VALUES ($1, $2, 'intake', '[]'::jsonb, NOW(), NOW(), NOW())
     RETURNING *`,
    [id, phone]
  );
  console.log(`🆕 New session: ${phone.slice(-4)} (${contactName || "anon"})`);
  return result.rows[0];
}

// =============================================================================
// Append to conversation log (max 100 messages, FIFO)
// =============================================================================
export async function appendToConversationLog(sessionId, role, content, msgType = "text") {
  await pool.query(
    `UPDATE sessions
     SET conversation_log = (
       SELECT jsonb_agg(entry ORDER BY (entry->>'timestamp') ASC)
       FROM (
         SELECT jsonb_array_elements(conversation_log) AS entry
         UNION ALL
         SELECT jsonb_build_object(
           'role', $2::text,
           'content', $3::text,
           'type', $4::text,
           'timestamp', NOW()::text
         ) AS entry
       ) sub
       LIMIT 100
     ),
     last_message_at = NOW(),
     updated_at = NOW()
     WHERE id = $1`,
    [sessionId, role, content, msgType]
  );
}

// =============================================================================
// Build conversation history for DeepSeek (last 20 messages)
// =============================================================================
export function buildConversationHistory(conversationLog) {
  if (!conversationLog || !Array.isArray(conversationLog)) return [];
  return conversationLog.slice(-20).map((m) => ({
    role: m.role,
    content: m.content,
  }));
}

// =============================================================================
// Build Context for Returning Users (24h+ since last message)
// =============================================================================
export function buildContextFromHistory(session) {
  if (!session) return "";

  const lastMessageAt = session.last_message_at
    ? new Date(session.last_message_at)
    : null;

  if (!lastMessageAt) return "";

  const hoursSinceLastMessage =
    (Date.now() - lastMessageAt.getTime()) / 3600000;

  if (hoursSinceLastMessage < 24) return "";

  const conversationLog = session.conversation_log || [];
  const last20 = conversationLog.slice(-20);

  if (last20.length === 0) return "";

  const historyText = last20
    .map((m) => `[${m.role}]: ${m.content}`)
    .join("\n");

  return `
HISTORIAL PREVIO (últimos ${last20.length} mensajes, el usuario regresó después de ${Math.round(hoursSinceLastMessage)} horas):
${historyText}

El usuario regresó después de más de 24 horas.
Estado actual de la sesión: ${session.state}
Hospital: ${session.hospital_name || "no registrado"}
Errores encontrados: ${session.errors_found || "no analizado aún"}
Pagó: ${session.payment_confirmed ? "Sí" : "No"}

Salúdale con continuidad. NO repitas la bienvenida completa. Reconoce que es un usuario que regresa.`;
}

export default {
  pool, initDB,
  loadSession, createSession,
  appendToConversationLog,
  buildConversationHistory, buildContextFromHistory,
};
