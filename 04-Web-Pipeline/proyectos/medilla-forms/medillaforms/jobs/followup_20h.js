// =============================================================================
// Follow-up Job — 20 Hours After 2h Follow-up
// BUSCA: sesiones donde followup_2h_sent = true
//        y followup_20h_sent = false
//        y last_message_at > hace 20 horas
//        y payment_confirmed = false
//
// ⚠️ INACTIVO — El código está completo pero NO se ejecuta.
//    Para activar: descomentar las líneas de cron en index.js
//    y APROBAR el template de WhatsApp en Meta Business Manager.
// =============================================================================

import Redis from "ioredis";

const REDIS_LOCK_KEY = "medillaforms:followup_20h_lock";
const LOCK_TTL = 300;

/**
 * Run the 20-hour follow-up job.
 * Should be called by a cron scheduler every 4 hours.
 */
export async function runFollowup20h(pool, whatsapp, stripe, telegram) {
  const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  });

  try {
    const acquired = await redis.set(REDIS_LOCK_KEY, "1", "EX", LOCK_TTL, "NX");
    if (!acquired) {
      console.log("🔒 Followup 20h: lock held by another instance — skipping");
      return { sent: 0, skipped: "locked" };
    }

    // Find sessions that got 2h follow-up but still haven't paid
    const result = await pool.query(`
      SELECT id, whatsapp_number, hospital_name, errors_found,
             potential_savings, payment_method, last_message_at
      FROM sessions
      WHERE followup_2h_sent = true
        AND followup_20h_sent = false
        AND payment_confirmed = false
        AND last_message_at < NOW() - INTERVAL '20 hours'
        AND last_message_at > NOW() - INTERVAL '7 days'
      LIMIT 20
    `);

    const zellePhone = process.env.ZELLE_PHONE || "9517336105";
    const zelleName = process.env.ZELLE_NAME || "Daniel Alcantara";

    let sent = 0;
    for (const session of result.rows) {
      try {
        const savings = session.potential_savings || 0;
        const hospital = session.hospital_name || "su proveedor";
        const errors = session.errors_found || 0;

        // Generate a fresh Stripe checkout link
        let stripeLink = "";
        if (stripe) {
          try {
            stripeLink = await stripe.createCheckoutSession(
              session.whatsapp_number,
              session.id,
              false
            );
          } catch {
            stripeLink = "[Link no disponible — solicítelo respondiendo a este mensaje]";
          }
        }

        // TEMPLATE PENDIENTE — requiere aprobación de Meta Business Manager
        const message =
          `Buenas, le contactamos de MedillaForms. 💙\n\n` +
          `Su análisis de factura de *${hospital}* sigue guardado. ` +
          `Encontramos *${errors}* error(es) con ahorro potencial de ` +
          `aproximadamente *$${savings.toLocaleString()}*.\n\n` +
          `Si desea sus cartas de disputa, puede completar el pago cuando guste:\n\n` +
          `💳 Tarjeta: ${stripeLink}\n` +
          `🏦 Zelle: ${zellePhone} / ${zelleName} / $29\n\n` +
          `Sus datos están guardados. No hay prisa.`;

        await whatsapp.sendText(session.whatsapp_number, message);

        // Mark as sent
        await pool.query(
          `UPDATE sessions SET followup_20h_sent = true, updated_at = NOW() WHERE id = $1`,
          [session.id]
        );

        sent++;
        console.log(`📨 Followup 20h sent to ${session.whatsapp_number.slice(-4)}`);

        await new Promise((r) => setTimeout(r, 1000));
      } catch (e) {
        console.error(`❌ Followup 20h error for ${session.id.slice(0, 8)}:`, e.message);
      }
    }

    if (sent > 0) {
      console.log(`✅ Followup 20h: ${sent} messages sent`);
    }

    return { sent };
  } catch (e) {
    console.error("❌ Followup 20h job error:", e.message);
    return { sent: 0, error: e.message };
  } finally {
    try { await redis.quit(); } catch {}
  }
}

export default { runFollowup20h };
