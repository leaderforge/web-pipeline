// =============================================================================
// WhatsApp Service — Telnyx bridge to Meta WhatsApp Cloud API
// =============================================================================

import crypto from "crypto";

class WhatsAppService {
  constructor() {
    this.apiKey = process.env.TELNYX_API_KEY || "";
    this.publicKey = process.env.TELNYX_PUBLIC_KEY || "";
    this.fromNumber = process.env.TELNYX_PHONE_NUMBER || "";
    this.baseUrl = "https://api.telnyx.com/v2";
  }

  // ---------------------------------------------------------------------------
  // Verify Ed25519 webhook signature
  // ---------------------------------------------------------------------------
  verifySignature(payload, signature, timestamp) {
    if (!signature || !timestamp || !this.publicKey) {
      // If no public key configured, skip verification (dev mode)
      if (!this.publicKey) {
        console.warn("⚠️ TELNYX_PUBLIC_KEY not set — skipping signature verification");
        return true;
      }
      return false;
    }

    try {
      const signedPayload = `${timestamp}.${payload}`;
      const signatureBuffer = Buffer.from(signature, "base64");
      const publicKeyBuffer = Buffer.from(this.publicKey, "base64");

      // Ed25519 expects 32-byte key — Telnyx provides base64-encoded raw key
      const verify = crypto.verify(
        null,
        Buffer.from(signedPayload),
        {
          key: crypto.createPublicKey({
            key: Buffer.concat([
              Buffer.from("302a300506032b656e032100", "hex"), // Ed25519 OID prefix
              publicKeyBuffer,
            ]),
            format: "der",
            type: "spki",
          }),
        },
        signatureBuffer
      );

      return verify;
    } catch (e) {
      console.error("Signature verification error:", e.message);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Send text message via Telnyx
  // ---------------------------------------------------------------------------
  async sendText(to, text) {
    if (!this.apiKey || !this.fromNumber) {
      console.warn(`⚠️ WhatsApp not configured — would send to ${to.slice(-4)}: ${text.slice(0, 60)}...`);
      return { ok: false, error: "not_configured" };
    }

    try {
      const response = await fetch(`${this.baseUrl}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          from: this.fromNumber,
          to,
          text,
          messaging_profile_id: this.fromNumber,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        console.error(`❌ WhatsApp send error: ${response.status}`, data);
        return { ok: false, error: data };
      }

      console.log(`📤 WhatsApp sent to ${to.slice(-4)}: ${text.slice(0, 60)}...`);
      return { ok: true, data };
    } catch (e) {
      console.error("❌ WhatsApp send exception:", e.message);
      return { ok: false, error: e.message };
    }
  }

  // ---------------------------------------------------------------------------
  // Send image via Telnyx
  // ---------------------------------------------------------------------------
  async sendImage(to, imageUrlOrBuffer, caption = "") {
    if (!this.apiKey || !this.fromNumber) {
      console.warn(`⚠️ WhatsApp not configured — would send image to ${to.slice(-4)}`);
      return { ok: false, error: "not_configured" };
    }

    try {
      // If it's a URL, use media_url. If buffer, upload first.
      let mediaUrl = imageUrlOrBuffer;
      if (Buffer.isBuffer(imageUrlOrBuffer)) {
        mediaUrl = await this.uploadMedia(imageUrlOrBuffer, "image/png");
      }

      const response = await fetch(`${this.baseUrl}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          from: this.fromNumber,
          to,
          text: caption || "",
          media_url: mediaUrl,
          messaging_profile_id: this.fromNumber,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        console.error(`❌ WhatsApp image send error: ${response.status}`, data);
        return { ok: false, error: data };
      }

      console.log(`📸 WhatsApp image sent to ${to.slice(-4)}`);
      return { ok: true, data };
    } catch (e) {
      console.error("❌ WhatsApp image send exception:", e.message);
      return { ok: false, error: e.message };
    }
  }

  // ---------------------------------------------------------------------------
  // Upload media to Telnyx (for sending images)
  // ---------------------------------------------------------------------------
  async uploadMedia(buffer, mimeType = "image/png") {
    const formData = new FormData();
    formData.append("file", new Blob([buffer], { type: mimeType }), "image.png");

    const response = await fetch(`${this.baseUrl}/media`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: formData,
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(`Media upload failed: ${JSON.stringify(data)}`);
    }

    return data.data?.url || "";
  }

  // ---------------------------------------------------------------------------
  // Download media from Telnyx (user's photo of bill)
  // ---------------------------------------------------------------------------
  async downloadMedia(mediaUrl) {
    try {
      const response = await fetch(mediaUrl, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Media download failed: ${response.status}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (e) {
      console.error("❌ Media download error:", e.message);
      throw e;
    }
  }

  // ---------------------------------------------------------------------------
  // Send typing indicator (when agent is "thinking")
  // ---------------------------------------------------------------------------
  async sendTypingIndicator(to, action = "typing_on") {
    // Telnyx doesn't directly support typing indicators via REST.
    // This would require the WhatsApp Business API directly.
    // Placeholder for future implementation.
    return { ok: true, note: "typing_indicator_not_supported_via_telnyx" };
  }
}

export const whatsapp = new WhatsAppService();
export default { whatsapp };
