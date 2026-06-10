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
    this.lastSendError = null;
    this.lastSendResponse = null;
  }

  // ---------------------------------------------------------------------------
  // Clean & validate phone number — strip non-digits, ensure + prefix
  // ---------------------------------------------------------------------------
  _cleanPhone(phone) {
    if (!phone || typeof phone !== "string") return null;
    let cleaned = phone.replace(/[^0-9+]/g, "");
    // Already has + prefix — assume it's valid
    if (cleaned.startsWith("+")) {
      return cleaned.length >= 10 ? cleaned : null;
    }
    // US number without country code — add +1
    if (cleaned.length === 10) {
      return "+1" + cleaned;
    }
    // 11 digits starting with 1 — add +
    if (cleaned.length === 11 && cleaned.startsWith("1")) {
      return "+" + cleaned;
    }
    // Non-US: fallback to + prefix
    if (cleaned.length >= 10) {
      return "+" + cleaned;
    }
    return null;
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
  // Send text message via Telnyx WhatsApp
  // Uses /v2/messages/whatsapp with whatsapp_message wrapper
  // ---------------------------------------------------------------------------
  async sendText(to, text) {
    if (!this.apiKey || !this.fromNumber) {
      console.warn(`⚠️ WhatsApp not configured — would send to ${to?.slice(-4)}: ${text.slice(0, 60)}...`);
      return { ok: false, error: "not_configured" };
    }

    // Clean and validate phone number
    const cleanTo = this._cleanPhone(to);
    if (!cleanTo) {
      console.warn(`⚠️ Invalid phone number — cannot send: ${to?.slice(-4)}`);
      return { ok: false, error: "invalid_phone" };
    }

    try {
      const response = await fetch(`${this.baseUrl}/messages/whatsapp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          from: this.fromNumber,
          to: cleanTo,
          whatsapp_message: {
            type: "text",
            text: {
              body: text,
              preview_url: false,
            },
          },
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        console.error(`❌ WhatsApp send error: ${response.status}`, JSON.stringify(data).slice(0, 300));
        this.lastSendError = { status: response.status, body: data, at: new Date().toISOString() };
        return { ok: false, error: data };
      }

      this.lastSendResponse = { status: response.status, body: data, at: new Date().toISOString() };
      console.log(`📤 WhatsApp sent to ${cleanTo.slice(-4)}: ${text.slice(0, 60)}...`);
      return { ok: true, data };
    } catch (e) {
      console.error("❌ WhatsApp send exception:", e.message);
      this.lastSendError = { status: "exception", body: e.message, at: new Date().toISOString() };
      return { ok: false, error: e.message };
    }
  }

  // ---------------------------------------------------------------------------
  // Send image via Telnyx WhatsApp
  // Uses /v2/messages/whatsapp with whatsapp_message.image wrapper
  // ---------------------------------------------------------------------------
  async sendImage(to, imageUrlOrBuffer, caption = "") {
    if (!this.apiKey || !this.fromNumber) {
      console.warn(`⚠️ WhatsApp not configured — would send image to ${to?.slice(-4)}`);
      return { ok: false, error: "not_configured" };
    }

    // Clean and validate phone number
    const cleanTo = this._cleanPhone(to);
    if (!cleanTo) {
      console.warn(`⚠️ Invalid phone number — cannot send image: ${to?.slice(-4)}`);
      return { ok: false, error: "invalid_phone" };
    }

    try {
      // If it's a buffer, upload to Telnyx media first
      let mediaLink = imageUrlOrBuffer;
      if (Buffer.isBuffer(imageUrlOrBuffer)) {
        mediaLink = await this.uploadMedia(imageUrlOrBuffer, "image/png");
        if (!mediaLink) {
          console.error("❌ Media upload returned empty URL");
          return { ok: false, error: "media_upload_failed" };
        }
      }

      const imagePayload = {
        link: mediaLink,
      };
      if (caption) {
        imagePayload.caption = caption;
      }

      const response = await fetch(`${this.baseUrl}/messages/whatsapp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          from: this.fromNumber,
          to: cleanTo,
          whatsapp_message: {
            type: "image",
            image: imagePayload,
          },
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        console.error(`❌ WhatsApp image send error: ${response.status}`, JSON.stringify(data).slice(0, 300));
        this.lastSendError = { status: response.status, body: data, at: new Date().toISOString() };
        return { ok: false, error: data };
      }

      this.lastSendResponse = { status: response.status, body: data, at: new Date().toISOString() };
      console.log(`📸 WhatsApp image sent to ${cleanTo.slice(-4)}`);
      return { ok: true, data };
    } catch (e) {
      console.error("❌ WhatsApp image send exception:", e.message);
      this.lastSendError = { status: "exception", body: e.message, at: new Date().toISOString() };
      return { ok: false, error: e.message };
    }
  }

  // ---------------------------------------------------------------------------
  // "Upload" media by saving to local disk and returning a public URL.
  // Telnyx WhatsApp API requires a publicly accessible URL in the `link` field.
  // We serve these via Express static at /letters/ from /tmp/medillaforms-letters/
  // ---------------------------------------------------------------------------
  async uploadMedia(buffer, mimeType = "image/png") {
    const { randomUUID } = await import("crypto");
    const { writeFileSync } = await import("fs");
    const id = randomUUID();
    const filename = `${id}.png`;
    const filepath = `/tmp/medillaforms-letters/${filename}`;
    writeFileSync(filepath, buffer);
    const publicUrl = `https://api.medillaforms.com/letters/${filename}`;
    console.log(`📁 Letter saved: ${filepath} (${buffer.length} bytes) → ${publicUrl}`);
    return publicUrl;
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
  // Download WhatsApp media via Meta media ID (resolved through Telnyx)
  // ---------------------------------------------------------------------------
  async downloadWhatsAppMedia(messageId, mediaId) {
    try {
      // Step 1: Retrieve the full message from Telnyx to get the media URL
      const msgResponse = await fetch(`${this.baseUrl}/messages/${messageId}`, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
      });

      if (!msgResponse.ok) {
        throw new Error(`Message retrieval failed: ${msgResponse.status}`);
      }

      const msgData = await msgResponse.json();
      const mediaUrls = msgData.data?.media || [];
      
      // Find the matching media by ID or use the first one
      let downloadUrl = null;
      if (mediaUrls.length > 0) {
        downloadUrl = mediaUrls[0].url || mediaUrls[0].content_url || null;
      }

      if (!downloadUrl) {
        // Fallback: try WhatsApp direct media URL via Telnyx
        downloadUrl = `${this.baseUrl}/messages/${messageId}/media/${mediaId}`;
      }

      console.log(`📥 Downloading WhatsApp media: ${downloadUrl.slice(0, 80)}...`);

      const response = await fetch(downloadUrl, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });

      if (!response.ok) {
        throw new Error(`WhatsApp media download failed: ${response.status}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (e) {
      console.error("❌ WhatsApp media download error:", e.message);
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
