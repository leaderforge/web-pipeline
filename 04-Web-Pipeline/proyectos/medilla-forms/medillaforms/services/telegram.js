// =============================================================================
// Telegram Service — Notifications to @MedillaFormsBot
// Separate from Hermes main bot. Daniel receives:
//   🔴 Critical alerts (immediate)
//   🟡 Daily summaries (8 PM PT)
//   📚 New Firecrawl data notifications
//   💰 Zelle pending confirmations
// =============================================================================

class TelegramService {
  constructor() {
    this.botToken = process.env.TELEGRAM_BOT_TOKEN || "";
    this.chatId = process.env.TELEGRAM_CHAT_ID || "";
    this.enabled = !!(this.botToken && this.chatId);

    if (!this.enabled) {
      console.warn("⚠️ Telegram notifications disabled — TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set");
    }
  }

  // ---------------------------------------------------------------------------
  // Format phone number as clickable WhatsApp link for Telegram
  // ---------------------------------------------------------------------------
  _formatWhatsAppLink(phone) {
    const raw = (phone || "").replace(/[^0-9]/g, "");
    if (!raw) return "N/A";
    return `<a href="https://wa.me/${raw}">+${raw}</a>`;
  }

  // ---------------------------------------------------------------------------
  // Send message to Daniel
  // ---------------------------------------------------------------------------
  async sendMessage(text, disableNotification = false) {
    if (!this.enabled) {
      console.log(`📱 Would notify: ${text.slice(0, 80)}...`);
      return false;
    }

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: "HTML",
          disable_notification: disableNotification,
        }),
      });

      const data = await response.json();
      if (!data.ok) {
        console.error("❌ Telegram send error:", data);
        return false;
      }
      return true;
    } catch (e) {
      console.error("❌ Telegram send exception:", e.message);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // 📨 New inbound message notification
  // ---------------------------------------------------------------------------
  async notifyNewMessage(phone, text, isNewSession = false, hasMedia = false) {
    const emoji = hasMedia ? "📸" : "💬";
    const label = isNewSession ? "🆕 NUEVO" : "📨 Mensaje";
    const preview = (text || "").slice(0, 120) || (hasMedia ? "[Foto/Archivo]" : "[Audio/Voice]");

    await this.sendMessage(
      `${emoji} <b>${label} — MedillaForms</b>\n\n` +
      `WhatsApp: ${this._formatWhatsAppLink(phone)}\n` +
      `Mensaje: ${preview}`,
      false
    );
  }

  // ---------------------------------------------------------------------------
  // 🔴 Critical: OpenAI API down
  // ---------------------------------------------------------------------------
  async alertOpenaiDown(detail = "") {
    await this.sendMessage(
      `🔴 <b>CRÍTICO — OpenAI caído</b>\n\n` +
      `GPT-4o Vision o Chat API está fallando después de 3+ reintentos.\n` +
      `Los usuarios no pueden procesar facturas.\n\n` +
      `<pre>${(detail || "").slice(0, 200)}</pre>\n\n` +
      `<i>Revisa status.openai.com y los logs de Railway.</i>`,
      false
    );
  }

  // ---------------------------------------------------------------------------
  // 🔴 Critical: Server error (500)
  // ---------------------------------------------------------------------------
  async alertServerError(error) {
    const errorStr = error instanceof Error ? `${error.message}\n${error.stack || ""}` : String(error);
    await this.sendMessage(
      `🔴 <b>CRÍTICO — Error en MedillaForms</b>\n\n` +
      `<pre>${errorStr.slice(0, 300)}</pre>\n\n` +
      `<i>Revisa los logs en Railway Dashboard → medilla-forms.</i>`,
      false
    );
  }

  // ---------------------------------------------------------------------------
  // 🔴 Critical: Service down (from health monitor)
  // ---------------------------------------------------------------------------
  async alertServiceDown() {
    await this.sendMessage(
      `🔴 <b>CRÍTICO — MedillaForms no responde</b>\n\n` +
      `El health check de Hermes detectó que el servicio no responde.\n` +
      `Se intentó redeploy automático.\n\n` +
      `<i>Revisa Railway Dashboard → medilla-forms → Deployments.</i>`,
      false
    );
  }

  // ---------------------------------------------------------------------------
  // 🔴 Critical: Stripe failure
  // ---------------------------------------------------------------------------
  async alertStripeFailure(detail = "") {
    await this.sendMessage(
      `🔴 <b>CRÍTICO — Error en Stripe</b>\n\n` +
      `Fallo al procesar un pago o verificar webhook.\n\n` +
      `<pre>${(detail || "").slice(0, 200)}</pre>`,
      false
    );
  }

  // ---------------------------------------------------------------------------
  // 💰 Zelle pending notification
  // ---------------------------------------------------------------------------
  async notifyZellePending(session) {
    const amount = session.amount || 29;
    await this.sendMessage(
      `💰 <b>Zelle pendiente — MedillaForms</b>\n\n` +
      `Monto esperado: <b>$${amount}.00</b>\n` +
      `WhatsApp: ${this._formatWhatsAppLink(session.whatsapp_number)}\n` +
      `Hospital: ${session.hospital_name || "No analizado aún"}\n` +
      `Errores: ${session.errors_found || "No analizado aún"}\n` +
      `Sesión: <code>${session.id}</code>\n\n` +
      `Para confirmar, responde:\n` +
      `<b>listo ${(session.id || "").slice(0, 8)}</b>`,
      false
    );
  }

  // ---------------------------------------------------------------------------
  // 📚 New data added to knowledge base (Firecrawl)
  // ---------------------------------------------------------------------------
  async notifyNewKnowledge(dataType, query, source, extracted) {
    await this.sendMessage(
      `📚 <b>Dato nuevo — MedillaForms KB</b>\n\n` +
      `Tipo: <b>${dataType}</b>\n` +
      `Query: ${query}\n` +
      `Fuente: ${source}\n` +
      `Dato: ${(extracted || "").slice(0, 200)}\n\n` +
      `<i>Revisa y valida este dato en data/${dataType === "general" ? "general_knowledge" : dataType}.json</i>`,
      true
    );
  }

  // ---------------------------------------------------------------------------
  // 🎉 First sale celebration
  // ---------------------------------------------------------------------------
  async notifyFirstSale() {
    await this.sendMessage(
      `🎉 <b>¡PRIMERA VENTA!</b>\n\n` +
      `Alguien acaba de pagar $29 USD en MedillaForms. 🚀`,
      false
    );
  }

  // ---------------------------------------------------------------------------
  // 📷 Image not legible (3 failed attempts)
  // ---------------------------------------------------------------------------
  async alertImageNotLegible(phone, attempts) {
    await this.sendMessage(
      `📷 <b>Imagen no legible — ${attempts} intentos</b>\n\n` +
      `WhatsApp: ${this._formatWhatsAppLink(phone)}\n` +
      `El usuario ha intentado ${attempts} veces enviar una foto y no se ha podido leer.\n\n` +
      `<i>Considera contactarlo manualmente.</i>`,
      false
    );
  }

  // ---------------------------------------------------------------------------
  // 🟡 Daily summary
  // ---------------------------------------------------------------------------
  async sendDailySummary(stats) {
    const text =
      `📊 <b>MedillaForms — Resumen ${stats.date}</b>\n\n` +
      `📄 Cartas generadas: <b>${stats.lettersGenerated || 0}</b>\n` +
      `👥 Usuarios nuevos: <b>${stats.newUsers || 0}</b>\n` +
      `⚠️ Errores: <b>${stats.errors || 0}</b>\n` +
      `💰 Ingresos: <b>$${(stats.revenue || 0).toFixed(2)} USD</b>\n\n` +
      `<i>— @MedillaFormsBot</i>`;

    await this.sendMessage(text, true);
  }
}

export const telegram = new TelegramService();
export default { telegram };
