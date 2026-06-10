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
import { getKBContext } from "../services/knowledge.js";

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
    // ── PRECHECK: if payment already confirmed (prepaid/landing flow), skip to delivery ──
    if (this.session.payment_confirmed) {
      await this._skipToDelivery();
      return;
    }
    const analysis = this.session.analysis_result || {};
    const errorsFound = analysis.errores_detectados?.length || this.session.errors_found || 0;
    const savings = analysis.ahorro_total_estimado || this.session.potential_savings || 0;

    if (errorsFound === 0) {
      await this.whatsapp.sendText(this.phone,
        `Revisé su factura y no encontré errores evidentes de facturación.\n\n` +
        `Los códigos y precios facturados parecen estar dentro de lo estándar. ` +
        `Si aun así le preocupa algo, puedo explicarle cómo funciona la asistencia financiera hospitalaria. ¿Le interesa?`
      );
      return;
    }

    const history = buildConversationHistory(this.session.conversation_log);

    // Build error details with original English concept FIRST, then Spanish title
    const errores = analysis.errores_detectados || [];
    const errorDetails = errores.map((e, i) => {
      const eng = e.item_referencia || "";
      const esp = e.titulo || e.tipo || "error";
      return `${i + 1}. ${eng} — ${esp}`;
    }).join("\n");
    const errorTitles = errores.map(e => e.titulo || e.tipo || "error").join(", ");

    const hookMessage = await this.deepseek.chat(
      "closer_hook",
      history,
      `DATOS DEL ANÁLISIS (USA EXACTAMENTE ESTOS NÚMEROS, NOMBRES Y CONCEPTOS):\n` +
      `- Errores encontrados: ${errorsFound}\n` +
      `- Detalle de cada error (concepto original en inglés + descripción en español):\n${errorDetails}\n` +
      `- Ahorro total estimado: $${savings}\n\n` +
      `El usuario NO ha pagado. Nombra cada error con SU CONCEPTO ORIGINAL EN INGLÉS primero (como aparece en la factura), ` +
      `seguido de una breve explicación en español. Luego menciona el ahorro total y ofrece las cartas. ` +
      `Enumera las discrepancias claramente.\n` +
      `NO inventes plazos. NO pidas comprobante. Las reglas completas están en tu sistema.`,
      { errors_found: String(errorsFound), potential_savings: "$" + String(savings), error_types: errorTitles }
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
  // Skip payment phase — user already paid (prepaid/landing)
  // ===========================================================================
  async _skipToDelivery() {
    const analysis = this.session.analysis_result || {};
    const errorsFound = analysis.errores_detectados?.length || this.session.errors_found || 0;

    if (errorsFound === 0) {
      await this.whatsapp.sendText(this.phone,
        `Revisé su factura y no encontré errores evidentes de facturación.\n\n` +
        `Su factura parece estar correcta. Como su pago ya fue procesado y no se encontraron ` +
        `errores que disputar, podemos ofrecerle un reembolso completo.\n\n` +
        `¿Desea que procesemos el reembolso?`
      );
      return;
    }

    await this.whatsapp.sendText(this.phone,
      `✅ Su pago ya está confirmado. Encontré ${errorsFound} errores en su factura.\n\n` +
      `Estoy generando sus cartas de disputa ahora mismo. Un momento...`
    );

    // Update state and trigger delivery
    await pool.query(
      `UPDATE sessions SET state = 'paid', updated_at = NOW() WHERE id = $1`,
      [this.session.id]
    );
    this.session.state = 'paid';

    // Import dynamically to avoid circular dependency
    const { default: closerModule } = await import("./closer.js");
    const closer = new closerModule.CloserAgent(this.whatsapp, this.deepseek, null, this.session);
    await closer.deliver();
  }

  // ===========================================================================
  // Handle payment method selection
  // ===========================================================================
  async handlePaymentChoice(text) {
    const textLower = text.toLowerCase();
    const amount = this.session.amount || 29;
    const isDiscount = amount === 24;

    // User chose Stripe
    if (textLower.includes("tarjeta") || textLower.includes("stripe") || textLower.includes("1") ||
        textLower.includes("crédito") || textLower.includes("debito") || textLower.includes("card")) {
      return await this._handleStripeChoice(isDiscount);
    }

    // User chose Zelle
    if (textLower.includes("zelle") || textLower.includes("2") || textLower.includes("transferencia")) {
      return await this._handleZelleChoice(amount);
    }

    // User is still deciding — present options
    if (textLower.includes("opciones") || textLower.includes("cómo pago") || textLower.includes("como pago") ||
        textLower.includes("pagar") || textLower.includes("método")) {
      const zelleInfo = zelle.getPaymentInstructions(amount);
      await this.whatsapp.sendText(this.phone,
        `Tiene dos opciones:\n\n` +
        `1️⃣ Tarjeta de crédito/débito — Procesamiento automático e inmediato.\n\n` +
        `2️⃣ Zelle:\nNúmero: ${zelleInfo.phone}\nNombre: ${zelleInfo.name}\nMonto: $${amount}.00\n` +
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
  async _handleStripeChoice(isDiscount = false) {
    try {
      const checkoutUrl = await stripeSvc.createCheckoutSession(
        this.phone,
        this.session.id,
        isDiscount
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
        `Zelle: ${zelle.phone} / ${zelle.name} / $${this.session.amount || 29}.00`
      );
    }
  }

  // ===========================================================================
  // Handle Zelle payment choice
  // ===========================================================================
  async _handleZelleChoice(amount = 29) {
    const zelleInfo = zelle.getPaymentInstructions(amount);

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
    // 🔄 RELOAD session from DB to catch Daniel's Zelle confirmation
    const reloaded = await pool.query(
      `SELECT * FROM sessions WHERE id = $1`,
      [this.session.id]
    );
    if (reloaded.rowCount > 0) {
      this.session = { ...this.session, ...reloaded.rows[0] };
    }

    // ⛔ GUARD: If this session was never set to Zelle pending, 
    // don't mention Zelle verification at all. This prevents stale
    // state from leaking into clean sessions.
    const isZelleFlow = this.session.zelle_pending === true;
    const textLower = text.toLowerCase();

    // 🧹 SANITY: If state is waiting_zelle but zelle_pending is false,
    // the session was improperly cleaned. Reset to waiting_payment.
    if (this.session.state === 'waiting_zelle' && !isZelleFlow) {
      await pool.query(
        `UPDATE sessions SET state = 'waiting_payment', payment_method = NULL, updated_at = NOW() WHERE id = $1`,
        [this.session.id]
      );
      this.session.state = 'waiting_payment';
      this.session.payment_method = null;
    }

    // ✅ Payment was just confirmed (by Daniel via Zelle, or Stripe webhook)
    if (this.session.payment_confirmed || this.session.state === 'paid') {
      // Check if letters were already delivered
      const alreadyDelivered = (this.session.conversation_log || []).some(m =>
        m && typeof m === "object" && m.role === "assistant" &&
        String(m.content || "").includes("Instrucciones para enviar")
      );

      if (!alreadyDelivered) {
        // Letters haven't been delivered yet — trigger delivery
        await this.whatsapp.sendText(this.phone,
          "¡Su pago fue confirmado! En un momento le envío sus cartas. 🎉"
        );
        const { CloserAgent } = await import("./closer.js");
        const closer = new CloserAgent(this.whatsapp, this.deepseek, null, this.session);
        await closer.deliver();
        return;
      }

      // Letters already sent — route to post-delivery Q&A
      await pool.query(
        `UPDATE sessions SET state = 'delivered', updated_at = NOW() WHERE id = $1`,
        [this.session.id]
      );
      this.session.state = 'delivered';
      // Fall through: the index.js router will pick up 'delivered' state
      await this.whatsapp.sendText(this.phone,
        "¿En qué más puedo ayudarle? 🙂"
      );
      return;
    }

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

    // 📸 User sends a screenshot or comprobante
    if (textLower.includes("comprobante") || textLower.includes("captura") ||
        textLower.includes("screenshot") || textLower.includes("imagen") ||
        textLower.includes("foto") || textLower.includes("evidencia")) {
      await this.whatsapp.sendText(this.phone,
        "Gracias por enviar el comprobante. Lo estamos revisando. En cuanto se confirme el pago, le enviamos sus cartas. ⏳"
      );
      await telegramSvc.sendMessage(
        `📸 ${this.session.id.slice(0,8)} — El cliente envió comprobante de pago Zelle. Verifica en tu banco.`
      );
      return;
    }

    // ⏳ User asks about payment wait time or confirmation status
    // MUST be clearly about PAYMENT, not general questions
    if ((textLower.includes("cuánto tarda") && (textLower.includes("pago") || textLower.includes("verificar") || textLower.includes("zelle") || textLower.includes("transferencia"))) ||
        (textLower.includes("cuánto falta") && (textLower.includes("pago") || textLower.includes("confirmar") || textLower.includes("carta"))) ||
        textLower.includes("demora el pago") || textLower.includes("demora la verificación") ||
        textLower.includes("cuándo confirman el pago") || textLower.includes("cuándo verifican el pago") ||
        textLower.includes("cuando confirman el pago") || textLower.includes("cuando verifican el pago")) {
      await this.whatsapp.sendText(this.phone,
        "Seguimos verificando su pago. Esto puede tomar unos minutos. Le avisaré en cuanto se confirme. ⏳\n\n" +
        "¡Gracias por su paciencia!"
      );
      return;
    }

    // User selected Stripe / credit card (first time or switching from Zelle)
    if (textLower.includes("tarjeta") || textLower.includes("stripe") || textLower.includes("crédito") ||
        textLower.includes("debito") || textLower.includes("card")) {
      if (this.session.payment_method !== "stripe") {
        await this._handleStripeChoice();
        return;
      }
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
      await this.whatsapp.sendText(this.phone,
        `Los datos de Zelle están en el mensaje anterior:\n` +
        `Número: ${zelle.phone}\nNombre: ${zelle.name}\nMonto: $29.00\n\n` +
        `Cuando realice la transferencia, avíseme y verificaremos su pago.`
      );
      return;
    }

    // General questions — use DeepSeek but with payment-waiting context + KB
    const history = buildConversationHistory(this.session.conversation_log);
    const kbCtx = getKBContext(text, {
      state: this.session.user_state || "",
      hospital_name: this.session.hospital_name || "",
    });
    const response = await this.deepseek.chat(
      "closer_hook",
      history,
      text + "\n\n[IMPORTANTE: El cliente está en espera de verificación de pago Zelle. NO prometas que el pago está confirmado. Sé amable y responde su pregunta, pero recuérdale que su pago está siendo verificado y recibirá confirmación pronto.]" +
      (kbCtx ? `\n\n📚 DATOS OBJETIVOS: ${kbCtx}` : ""),
      { hospital_name: this.session.hospital_name || "" }
    );
    await this.whatsapp.sendText(this.phone, sanitizeAgentResponse(response));
    await appendToConversationLog(this.session.id, "assistant", response);
  }

  // ===========================================================================
  // Fallback for unknown states
  // ===========================================================================
  async handleFallback(text) {
    // Hermes safety net: context-aware recovery response
    // Check what stage the user is at and respond accordingly
    const hasAnalysis = this.session.analysis_result != null;
    const hasPaid = this.session.payment_confirmed;
    const hasPhotos = (this.session.photos || "").length > 2;
    const hasErrors = (this.session.errors_found || 0) > 0;

    let recovery;
    if (hasPaid) {
      recovery = "Gracias por su paciencia. \ud83d\ude4f\n\n" +
        "Estoy revisando su caso. Recuerde que sus cartas est\u00e1n listas y " +
        "tenemos toda la informaci\u00f3n de su factura guardada.\n\n" +
        "\u00bfEn qu\u00e9 puedo ayudarle puntualmente?";
    } else if (hasAnalysis && hasErrors) {
      recovery = "Ya analic\u00e9 su factura y encontr\u00e9 posibles errores. \ud83d\udd0d\n\n" +
        "\u00bfQuiere que le explique lo que encontr\u00e9? " +
        "O si prefiere, puedo prepararle sus cartas de disputa por $49 USD.";
    } else if (hasPhotos) {
      recovery = "Recib\u00ed su(s) foto(s). \ud83d\udcf8\n\n" +
        "Deme un momento para terminar de analizar su factura. " +
        "\u00bfTiene m\u00e1s p\u00e1ginas para enviarme o son todas?";
    } else {
      recovery = "Estoy aqu\u00ed para ayudarle con su factura m\u00e9dica. \ud83d\udc99\n\n" +
        "\u00bfYa tiene su factura detallada (itemized bill) a la mano? " +
        "Si solo tiene el resumen de 1 hoja, puedo explicarle c\u00f3mo obtener la versi\u00f3n completa.";
    }

    await this.whatsapp.sendText(this.phone, recovery);
  }
}

export default { HermesAgent };
