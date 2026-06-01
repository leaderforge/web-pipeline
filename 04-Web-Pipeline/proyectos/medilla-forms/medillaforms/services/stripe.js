// =============================================================================
// Stripe Service — Payment processing ($29 USD)
// =============================================================================

import Stripe from "stripe";

class StripeService {
  constructor() {
    const apiKey = process.env.STRIPE_SECRET_KEY || "";
    // Stripe throws if initialized with empty string — handle gracefully
    try {
      this.stripe = apiKey ? new Stripe(apiKey) : null;
    } catch {
      this.stripe = null;
      console.warn("⚠️ Stripe initialization failed — payments disabled");
    }
    this.webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "";

    if (!this.stripe) {
      console.warn("⚠️ STRIPE_SECRET_KEY not set — Stripe payments disabled");
    }
  }

  // ---------------------------------------------------------------------------
  // Create Stripe Checkout Session for $29
  // ---------------------------------------------------------------------------
  async createCheckoutSession(phone, sessionId, isExitIntent = false) {
    if (!this.stripe) {
      console.warn("⚠️ Stripe not initialized — returning mock URL");
      return "https://example.com/mock-payment";
    }

    const priceId = isExitIntent
      ? (process.env.STRIPE_PRICE_EXIT_INTENT || "price_exit")
      : (process.env.STRIPE_PRICE_MAIN || "price_main");

    try {
      const session = await this.stripe.checkout.sessions.create({
        line_items: [
          {
            price: priceId,
            quantity: 1,
          },
        ],
        mode: "payment",
        success_url: "https://medillaforms.com/gracias",
        cancel_url: "https://medillaforms.com/",
        client_reference_id: sessionId,
        metadata: {
          session_id: sessionId,
          phone,
        },
        payment_intent_data: {
          metadata: {
            session_id: sessionId,
            phone,
          },
        },
      });

      console.log(`💳 Stripe checkout created for session ${sessionId.slice(0, 8)}`);
      return session.url;
    } catch (e) {
      console.error("❌ Stripe session error:", e.message);
      throw e;
    }
  }

  // ---------------------------------------------------------------------------
  // Verify Stripe Webhook Signature
  // ---------------------------------------------------------------------------
  verifyWebhook(body, signature) {
    if (!this.stripe || !this.webhookSecret) {
      console.warn("⚠️ Stripe webhook not configured — skipping verification");
      try { return JSON.parse(body.toString()); } catch { return null; }
    }

    try {
      return this.stripe.webhooks.constructEvent(
        body,
        signature,
        this.webhookSecret
      );
    } catch (e) {
      console.error("❌ Stripe webhook verification failed:", e.message);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Process a refund
  // ---------------------------------------------------------------------------
  async refund(paymentIntentId, amount = null) {
    if (!this.stripe) {
      console.warn("⚠️ Stripe not initialized — cannot refund");
      return null;
    }

    try {
      const refundParams = { payment_intent: paymentIntentId };
      if (amount) refundParams.amount = amount;

      const refund = await this.stripe.refunds.create(refundParams);
      console.log(`💰 Refund processed: ${refund.id}`);
      return refund;
    } catch (e) {
      console.error("❌ Stripe refund error:", e.message);
      throw e;
    }
  }
}

export const stripe = new StripeService();
export default { stripe };
