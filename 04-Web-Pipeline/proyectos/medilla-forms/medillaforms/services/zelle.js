// =============================================================================
// Zelle Service — Manual payment tracking
// No API for Zelle. Daniel manually confirms payments via Telegram.
// This service tracks pending Zelle payments and generates confirmation codes.
// =============================================================================

class ZelleService {
  constructor() {
    this.phone = process.env.ZELLE_PHONE || "9517336105";
    this.name = process.env.ZELLE_NAME || "Daniel Alcantara";
    this.amount = 29.0;
  }

  /**
   * Get Zelle payment instructions for the user.
   * @param {number} amount - Payment amount (default 29)
   */
  getPaymentInstructions(amount = 29) {
    return {
      phone: this.phone,
      name: this.name,
      amount: amount,
      message: `Zelle:\nNúmero: ${this.phone}\nNombre: ${this.name}\nMonto: $${amount.toFixed(2)}\n\nUna vez realizada la transferencia, avíseme aquí y verificaremos su pago para continuar.`,
    };
  }

  /**
   * Generate a confirmation key for Daniel to use.
   * The confirmation code is the first 8 chars of the session UUID.
   */
  getConfirmationCode(sessionId) {
    return sessionId.slice(0, 8);
  }

  /**
   * Build the Telegram notification for a pending Zelle payment.
   */
  buildPendingNotification(session) {
    const code = this.getConfirmationCode(session.id);
    const rawPhone = (session.whatsapp_number || "").replace(/[^0-9]/g, "");
    const phoneLink = rawPhone ? `<a href="https://wa.me/${rawPhone}">+${rawPhone}</a>` : "N/A";

    return (
      `💰 <b>Zelle pendiente — MedillaForms</b>\n\n` +
      `Monto esperado: <b>$${this.amount.toFixed(2)}</b>\n` +
      `WhatsApp: ${phoneLink}\n` +
      `Hospital: ${session.hospital_name || "No analizado aún"}\n` +
      `Errores: ${session.errors_found || "No analizado aún"}\n` +
      `Sesión: <code>${session.id}</code>\n\n` +
      `Para confirmar, responde:\n` +
      `<b>listo ${code}</b>`
    );
  }

  /**
   * Check if a confirmation code matches the session.
   */
  validateConfirmationCode(sessionId, submittedCode) {
    return sessionId.startsWith(submittedCode);
  }
}

export const zelle = new ZelleService();
export default { zelle };
