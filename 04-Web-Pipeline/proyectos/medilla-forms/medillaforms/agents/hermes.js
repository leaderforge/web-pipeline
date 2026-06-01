// =============================================================================
// Hermes Agent — Orchestrator + FASE 3 (Hook + Cobro)
// Manages the payment decision and routes between phases
// =============================================================================

import { pool, appendToConversationLog, buildConversationHistory } from "../middleware/session.js";
import { zelle } from "../services/zelle.js";
import { stripe as stripeSvc } from "../services/stripe.js";
import { telegram as telegramSvc } from "../services/telegram.js";
import { deepseek } from "../services/deepseek.js";
// buildConversationHistory imported above
import { sanitizeAgentResponse } from "../middleware/legal.js";

export class HermesAgent {
  constructor(whatsapp, deepseekSvc, session) {
    this.whatsapp = whatsapp;
    this.deepseek = deepseekSvc || deepseek;
    this.session = session;
    this.phone = session.whatsapp_number;
  }

  // ===========================================================================
  // FASE 3 — Present the hook and payment options
  // ===========================================================================
  async presentHook() {
    const analysis = this.session.analysis_result || {};
    const errorsFound = analysis.errores_detectados?.length || this.session.errors_found || 0;
    const savings = analysis.ahorro_total_estimado || this.session.potential_savings || 0;
    const hospital = this.session.hospital_name || analysis.hospital || "su proveedor";

    if (errorsFound === 0) {
      await this.whatsapp.sendText(this.phone,
        `Revisé su factura de *${hospital}* y no encontré errores evidentes de facturación.\n\n` +
        `Su factura parece estar correcta según los códigos y precios estándar. ` +
        `Aún así, siempre puede negociar un plan de pago o preguntar por asistencia financiera.\n\n` +
        `¿Quiere que le explique cómo funciona el proceso de asistencia financiera hospitalaria?`
      );
      return;
    }

    // Build context for DeepSeek
    const context = {
      hospital_name: hospital,
      user_state: this.session.user_state || "",
      total_billed: String(analysis.total_facturado || this.session.total_billed || 0),
      errors_found: String(errorsFound),
      potential_savings: String(savings),
      zelle_phone: zelle.phone,
      zelle_name: zelle.name,
    };

    const history = buildConversationHistory(this.session.conversation_log);

    const hookMessage = await this.deepseek.chat(
      "closer_hook",
      history,
      `PRESENTA EL RESUMEN DEL ANÁLISIS. Encontré ${errorsFound} errores. Ahorro estimado: $${savings}. Hospital: ${hospital}.`,
      context
    );

    const cleaned = sanitizeAgentResponse(hookMessage);
    await this.whatsapp.sendText(this.phone, cleaned);
    await appendToConversationLog(this.session.id, "assistant", cleaned);

    // Update state
    await pool.query(
      `UPDATE sessions SET state = 'waiting_payment', updated_at = NOW() WHERE id = $1`,
      [this.session.id]
    );
    this.session.state = "waiting_payment";
  }

  // ===========================================================================
  // Handle payment method selection
  // ===========================================================================
  async handlePaymentChoice(text) {
    const textLower = text.toLowerCase();

    // User chose Stripe
    if (textLower.includes("tarjeta") || textLower.includes("stripe") || textLower.includes("1") ||
        textLower.includes("crédito") || textLower.includes("debito") || textLower.includes("card")) {
      return await this._handleStripeChoice();
    }

    // User chose Zelle
    if (textLower.includes("zelle") || textLower.includes("2") || textLower.includes("transferencia")) {
      return await this._handleZelleChoice();
    }

    // User is still deciding — present options
    if (textLower.includes("opciones") || textLower.includes("cómo pago") || textLower.includes("como pago") ||
        textLower.includes("pagar") || textLower.includes("método")) {
      const zelleInfo = zelle.getPaymentInstructions();
      await this.whatsapp.sendText(this.phone,
        `Tiene dos opciones:\n\n` +
        `1️⃣ Tarjeta de crédito/débito — Procesamiento automático e inmediato.\n\n` +
        `2️⃣ Zelle:\nNúmero: ${zelleInfo.phone}\nNombre: ${zelleInfo.name}\nMonto: $29.00\n` +
        `Una vez realizada la transferencia, avíseme y verificaremos su pago para continuar.\n\n` +
        `¿Cómo prefiere realizar su pago?`
      );
      return;
    }

    // Default — help them decide
    await this.whatsapp.sendText(this.phone,
      `¿Cómo prefiere realizar su pago? 💳\n\n` +
      `1️⃣ Tarjeta de crédito/débito — Inmediato\n` +
      `2️⃣ Zelle — Transferencia manual`
    );
  }

  // ===========================================================================
  // Handle Stripe payment choice
  // ===========================================================================
  async _handleStripeChoice() {
    try {
      const checkoutUrl = await stripeSvc.createCheckoutSession(
        this.phone,
        this.session.id,
        false
      );

      await this.whatsapp.sendText(this.phone,
        `Aquí está su link de pago seguro: 💳\n\n` +
        `${checkoutUrl}\n\n` +
        `En cuanto se confirme el pago, le envío sus cartas de inmediato. ` +
        `Recibirá DOS cartas: una en español y una en inglés.\n\n` +
        `*Recordatorio:* Esto es un servicio educativo. No soy abogado.`
      );

      await pool.query(
        `UPDATE sessions SET state = 'waiting_payment', payment_method = 'stripe', updated_at = NOW() WHERE id = $1`,
        [this.session.id]
      );
      this.session.state = "waiting_payment";
      this.session.payment_method = "stripe";
    } catch (e) {
      console.error("❌ Stripe checkout error:", e);
      await telegramSvc.alertStripeFailure(e.message);
      await this.whatsapp.sendText(this.phone,
        "Disculpe, hubo un problema al generar el link de pago. ¿Quiere intentar con Zelle mientras tanto?\n\n" +
        `Zelle: ${zelle.phone} / ${zelle.name} / $29.00`
      );
    }
  }

  // ===========================================================================
  // Handle Zelle payment choice
  // ===========================================================================
  async _handleZelleChoice() {
    const zelleInfo = zelle.getPaymentInstructions();

    await this.whatsapp.sendText(this.phone,
      `Perfecto. Una vez que realice la transferencia, avíseme aquí y estaremos verificando su pago.\n\n` +
      `${zelleInfo.message}\n\n` +
      `En cuanto lo confirmemos, le enviamos sus cartas de inmediato.`
    );

    await pool.query(
      `UPDATE sessions SET state = 'waiting_zelle', payment_method = 'zelle', zelle_pending = true, updated_at = NOW() WHERE id = $1`,
      [this.session.id]
    );
    this.session.state = "waiting_zelle";
    this.session.payment_method = "zelle";
    this.session.zelle_pending = true;

    // Notify Daniel
    await telegramSvc.notifyZellePending(this.session);
  }

  // ===========================================================================
  // Handle messages while waiting for payment
  // ===========================================================================
  async handleWaitingPayment(text) {
    const textLower = text.toLowerCase();

    // User says they've paid via Zelle
    if (textLower.includes("ya pagué") || textLower.includes("ya pague") || textLower.includes("envié") ||
        textLower.includes("envie") || textLower.includes("transferí") || textLower.includes("listo") ||
        textLower.includes("done") || textLower.includes("sent")) {
      await this.whatsapp.sendText(this.phone,
        "Gracias por avisar. Estamos verificando su transferencia. En cuanto se confirme, le envío sus cartas de inmediato. ⏳\n\n" +
        "Esto puede tomar unos minutos."
      );

      // Notify Daniel again
      await telegramSvc.notifyZellePending(this.session);
      return;
    }

    // User selected Stripe / credit card (first time or switching from Zelle)
    if (textLower.includes("tarjeta") || textLower.includes("stripe") || textLower.includes("crédito") ||
        textLower.includes("debito") || textLower.includes("card")) {
      if (this.session.payment_method !== "stripe") {
        await this._handleStripeChoice();
        return;
      }
      // Already on Stripe — remind them
      await this.whatsapp.sendText(this.phone,
        "El link de pago ya está en el mensaje anterior. ¿Lo ve? Si tuvo algún problema con el pago, dígame y le ayudo."
      );
      return;
    }

    // User selected Zelle (first time or switching from Stripe)
    if (textLower.includes("zelle") || textLower.includes("transferencia")) {
      if (this.session.payment_method !== "zelle") {
        await this._handleZelleChoice();
        return;
      }
      // Already on Zelle — remind them
      await this.whatsapp.sendText(this.phone,
        `Los datos de Zelle están en el mensaje anterior:\n` +
        `Número: ${zelle.phone}\nNombre: ${zelle.name}\nMonto: $29.00\n\n` +
        `Cuando realice la transferencia, avíseme y verificaremos su pago.`
      );
      return;
    }

    // General questions — use DeepSeek
    const history = buildConversationHistory(this.session.conversation_log);
    const response = await this.deepseek.chat(
      "closer_hook",
      history,
      text,
      { hospital_name: this.session.hospital_name || "" }
    );
    await this.whatsapp.sendText(this.phone, sanitizeAgentResponse(response));
    await appendToConversationLog(this.session.id, "assistant", response);
  }

  // ===========================================================================
  // Fallback for unknown states
  // ===========================================================================
  async handleFallback(text) {
    await this.whatsapp.sendText(this.phone,
      "Estoy aquí para ayudarle con sus facturas médicas. ¿En qué etapa del proceso estaba?"
    );
  }
}

export default { HermesAgent };
