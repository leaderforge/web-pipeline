// =============================================================================
// Follow-up Job — 2 Hours After Last Message
// BUSCA: sesiones en waiting_payment o waiting_zelle
//        donde last_message_at > hace 2 horas
//        y payment_confirmed = false
//        y followup_2h_sent = false
//
// ⚠️ INACTIVO — El código está completo pero NO se ejecuta.
//    Para activar: descomentar las líneas de cron en index.js
//    y APROBAR el template de WhatsApp en Meta Business Manager.
// =============================================================================

import Redis from "ioredis";

const REDIS_LOCK_KEY = "medillaforms:followup_2h_lock";
const LOCK_TTL = 300; // 5 minutes — prevent duplicate sends across replicas

/**
 * Run the 2-hour follow-up job.
 * Should be called by a cron scheduler every 30 minutes.
 */
export async function runFollowup2h(pool, whatsapp, telegram) {
  // Redis distributed lock to prevent duplicates
  const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  });

  try {
    const acquired = await redis.set(REDIS_LOCK_KEY, "1", "EX", LOCK_TTL, "NX");
    if (!acquired) {
      console.log("🔒 Followup 2h: lock held by another instance — skipping");
      return { sent: 0, skipped: "locked" };
    }

    // Find sessions that need follow-up
    const result = await pool.query(`
      SELECT id, whatsapp_number, hospital_name, errors_found,
             potential_savings, last_message_at
      FROM sessions
      WHERE state IN ('waiting_payment', 'waiting_zelle')
        AND payment_confirmed = false
        AND followup_2h_sent = false
        AND last_message_at < NOW() - INTERVAL '2 hours'
        AND last_message_at > NOW() - INTERVAL '48 hours'
      LIMIT 20
    `);

    let sent = 0;
    for (const session of result.rows) {
      try {
        const savings = session.potential_savings || 0;
        const hospital = session.hospital_name || "su proveedor";
        const errors = session.errors_found || 0;

        // TEMPLATE PENDIENTE — requiere aprobación de Meta Business Manager
        const message =
          `Hola, soy Hermes de MedillaForms. Hace unas horas revisamos su factura ` +
          `de *${hospital}* y encontramos *${errors}* posible(s) error(es) ` +
          `que suman aproximadamente *$${savings.toLocaleString()}*.\n\n` +
          `¿Tiene alguna duda sobre el proceso de pago? Estamos aquí para ayudarle. 💙`;

        await whatsapp.sendText(session.whatsapp_number, message);

        // Mark as sent
        await pool.query(
          `UPDATE sessions SET followup_2h_sent = true, updated_at = NOW() WHERE id = $1`,
          [session.id]
        );

        sent++;
        console.log(`📨 Followup 2h sent to ${session.whatsapp_number.slice(-4)}`);

        // Small delay between messages to avoid rate limits
        await new Promise((r) => setTimeout(r, 1000));
      } catch (e) {
        console.error(`❌ Followup 2h error for ${session.id.slice(0, 8)}:`, e.message);
      }
    }

    if (sent > 0) {
      console.log(`✅ Followup 2h: ${sent} messages sent`);
    }

    return { sent };
  } catch (e) {
    console.error("❌ Followup 2h job error:", e.message);
    return { sent: 0, error: e.message };
  } finally {
    try { await redis.quit(); } catch {}
  }
}

export default { runFollowup2h };
