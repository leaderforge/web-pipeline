// =============================================================================
// Intake Agent — FASE 1: Welcome, language detection, photo collection
// =============================================================================

import { pool, appendToConversationLog, buildConversationHistory } from "../middleware/session.js";
import { sanitizeAgentResponse, getFirstMessageDisclaimer } from "../middleware/legal.js";
import { addPhoto, confirmPhotos, clearBuffer } from "../middleware/buffer.js";
import { deepseek } from "../services/deepseek.js";
import { zelle } from "../services/zelle.js";
import { HermesAgent } from "./hermes.js";

export class IntakeAgent {
  constructor(whatsapp, deepseekSvc, session) {
    this.whatsapp = whatsapp;
    this.deepseek = deepseekSvc || deepseek;
    this.session = session;
    this.phone = session.whatsapp_number;
  }

  // ===========================================================================
  // Main handler for intake phase messages
  // ===========================================================================
  async handle(text, returningContext = "") {
    const msgCount = (this.session.conversation_log || []).length;
    const textLower = text.toLowerCase();

    // --- First message (or returning user after 24h+) ---
    if (msgCount <= 1 || returningContext) {
      await this._sendWelcome(returningContext);
      return;
    }

    // --- Name capture (2nd-3rd message, no name yet) ---
    if (!this.session.customer_name && msgCount <= 3) {
      const name = text.trim().replace(/\.$/, "");
      // Validate: looks like a name (2-4 words, no digits, no URLs, no question marks)
      const looksLikeName = /^[A-Za-zÁ-Úá-úÑñ\s'-]{2,60}$/.test(name) && !/[?¿]/.test(name);
      if (looksLikeName) {
        await pool.query(
          `UPDATE sessions SET customer_name = $2, updated_at = NOW() WHERE id = $1`,
          [this.session.id, name]
        );
        this.session.customer_name = name;
        await appendToConversationLog(this.session.id, "user", text);
        await this.whatsapp.sendText(this.phone,
          `¡Mucho gusto, ${name.split(" ")[0]}! 😊\n\n` +
          `¿Tiene su factura médica a la mano? Mándeme una foto cuando esté listo. 📸\n\n` +
          `Si aún no tienen su factura pero quieren saber cómo funciona, también podemos platicar.`
        );
        await appendToConversationLog(this.session.id, "assistant", 
          `¡Mucho gusto, ${name.split(" ")[0]}! 😊\n\n` +
          `¿Tiene su factura médica a la mano? Mándeme una foto cuando esté listo. 📸\n\n` +
          `Si aún no tienen su factura pero quieren saber cómo funciona, también podemos platicar.`
        );
        return;
      }
    }

    // --- Price questions ---
    if (this._matches(textLower, ["cuánto", "cuanto", "precio", "cuesta", "costo", "pago",
                                   "how much", "price", "cost", "payment", "fee"])) {
      await this._explainPricing();
      return;
    }

    // --- Service explanation ---
    if (this._matches(textLower, ["cómo funciona", "como funciona", "explicar", "servicio",
                                   "qué haces", "que haces", "how does it", "explain", "what do you"])) {
      await this._explainService();
      return;
    }

    // --- Number of pages ---
    if (this._matches(textLower, ["página", "pagina", "hoja", "foto", "fotografía", "page", "photo", "picture"]) ||
        /^\d+$/.test(text.trim())) {
      const num = parseInt(text.trim());
      if (num > 0 && num <= 20) {
        await this._confirmPageCount(num);
      } else {
        await this._askPageCount();
      }
      return;
    }

    // --- User confirms all photos sent ---
    if (this._matches(textLower, ["sí", "si", "son todas", "todas", "eso es todo", "listo",
                                   "yes", "all", "that's all", "done", "ready"])) {
      const result = confirmPhotos(this.phone);
      if (result) {
        await pool.query(
          `UPDATE sessions SET photos_confirmed = true, photos_expected = $2, state = 'analyzing', updated_at = NOW() WHERE id = $1`,
          [this.session.id, result.photoCount]
        );
        this.session.photos_confirmed = true;
        this.session.state = "analyzing";

        await this.whatsapp.sendText(this.phone,
          "Perfecto, gracias. Deme un momento para revisar su factura, por favor."
        );
      }
      return;
    }

    // --- Zelle payment question ---
    if (textLower.includes("zelle")) {
      const zelleInfo = zelle.getPaymentInstructions();
      await this.whatsapp.sendText(this.phone,
        `Así funciona el pago por Zelle:\n\n${zelleInfo.message}\n\n` +
        `Pero primero necesito analizar su factura. ¿La tiene a la mano? 📸`
      );
      return;
    }

    // --- General questions → DeepSeek ---
    const history = buildConversationHistory(this.session.conversation_log);
    const context = {
      user_state: this.session.user_state || "",
      returning_context: returningContext,
    };
    const response = await this.deepseek.chat("intake", history, text, context);
    const cleaned = sanitizeAgentResponse(response);
    await this.whatsapp.sendText(this.phone, cleaned);
    await appendToConversationLog(this.session.id, "assistant", cleaned);
  }

  // ===========================================================================
  // Send welcome message
  // ===========================================================================
  async _sendWelcome(returningContext) {
    if (returningContext) {
      // Returning user — use DeepSeek with context
      const history = [];
      const response = await this.deepseek.chat(
        "intake",
        history,
        "El usuario regresó. Dale continuidad según el historial y pregúntale en qué le puedes ayudar.",
        { returning_context: returningContext, user_state: this.session.user_state || "" }
      );
      await this.whatsapp.sendText(this.phone, sanitizeAgentResponse(response));
      await appendToConversationLog(this.session.id, "assistant", response);
    } else {
      // New user — standard welcome
      const disclaimer = getFirstMessageDisclaimer("es");
      const welcomeMsg =
        `¡Buenas! Bienvenido a MedillaForms. 💙\n\n` +
        `Soy Hermes, su asistente de análisis de facturas médicas.\n\n` +
        `*${disclaimer}*\n\n` +
        `Antes de empezar, ¿cómo se llama?`;

      await this.whatsapp.sendText(this.phone, welcomeMsg);
      await appendToConversationLog(this.session.id, "assistant", welcomeMsg);
    }
  }

  // ===========================================================================
  // Explain pricing
  // ===========================================================================
  async _explainPricing() {
    await this.whatsapp.sendText(this.phone,
      "Así funciona:\n\n" +
      "1️⃣ Me manda una foto de su factura\n" +
      "2️⃣ La analizo y le digo qué posibles errores encontré *(gratis)*\n" +
      "3️⃣ Si quiere las cartas de disputa, cuesta *$29 USD* — pago único\n\n" +
      "¿Tiene su factura a la mano? Mándemela cuando esté listo. 📸"
    );
  }

  // ===========================================================================
  // Explain service
  // ===========================================================================
  async _explainService() {
    await this.whatsapp.sendText(this.phone,
      "Claro, así funciona:\n\n" +
      "📸 Me manda una foto de su factura médica\n" +
      "🔍 La analizo con inteligencia artificial y busco posibles errores de facturación *(gratis)*\n" +
      "📝 Si quiere, por $29 USD le preparo cartas de disputa personalizadas\n" +
      "📄 Recibe DOS cartas: una en español (para usted) y una en inglés (para el hospital)\n\n" +
      "Es como tener un amigo que sabe de facturación médica. ¿Tiene una factura para revisar?"
    );
  }

  // ===========================================================================
  // Ask how many pages
  // ===========================================================================
  async _askPageCount() {
    await this.whatsapp.sendText(this.phone,
      "¿Cuántas páginas o fotografías tiene su factura?"
    );
  }

  // ===========================================================================
  // Confirm page count and request photos
  // ===========================================================================
  async _confirmPageCount(num) {
    await pool.query(
      `UPDATE sessions SET photos_expected = $2, updated_at = NOW() WHERE id = $1`,
      [this.session.id, num]
    );
    this.session.photos_expected = num;

    await this.whatsapp.sendText(this.phone,
      `Perfecto, ${num} página(s). Cuando guste, envíemelas.\n\n` +
      `Le recomiendo tomarles foto con buena iluminación, sobre una superficie plana, ` +
      `asegurándose que todo el texto sea legible.`
    );
  }

  // ===========================================================================
  // Helper: check if text matches any keyword
  // ===========================================================================
  _matches(text, keywords) {
    return keywords.some((kw) => text.includes(kw));
  }
}

export default { IntakeAgent };
