// =============================================================================
// Intake Agent — FASE 1: Welcome, language detection, photo collection
// =============================================================================

import { pool, appendToConversationLog, buildConversationHistory } from "../middleware/session.js";
import { sanitizeAgentResponse, getFirstMessageDisclaimer } from "../middleware/legal.js";
import { addPhoto, confirmPhotos, clearBuffer, getStoredPhotos, getStoredCount, clearStoredPhotos } from "../middleware/buffer.js";
import { deepseek } from "../services/deepseek.js";
import { openai } from "../services/openai.js";
import { zelle } from "../services/zelle.js";
import { getKBContext } from "../services/knowledge.js";
import { HermesAgent } from "./hermes.js";
import { AnalyzerAgent } from "./analyzer.js";

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

    // ═══ DETECT $24 EXIT INTENT ═══════════════════════════════
    // If user clicked the exit popup on the landing page, they arrive
    // with "Hola, vi la oferta de $24 USD" — tag session with discount
    if (textLower.includes("$24") || textLower.includes("24 usd") ||
        textLower.includes("oferta de 24") || textLower.includes("24 dólares") ||
        textLower.includes("descuento") || textLower.includes("exit intent")) {
      if (!this.session.amount || this.session.amount === 29) {
        await pool.query(
          `UPDATE sessions SET amount = 24, updated_at = NOW() WHERE id = $1`,
          [this.session.id]
        );
        this.session.amount = 24;
        console.log(`🏷️ Session ${this.session.id.slice(0,8)} tagged as $24 exit intent`);
      }
    }

    // --- First message (or returning user after 24h+) ---
    if (msgCount <= 1 || returningContext) {
      await this._sendWelcome(returningContext);
      return;
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

    // --- Number of pages (detect ANY number in response) ---
    // After the bot asks "¿Cuántas páginas?", ANY number in the response = page count
    const numberMatch = text.match(/\b(\d+)\b/);
    const spokenNumbers = {
      "una":1,"uno":1,"un":1,"dos":2,"tres":3,"cuatro":4,"cinco":5,
      "seis":6,"siete":7,"ocho":8,"nueve":9,"diez":10,
      "once":11,"doce":12,"trece":13,"catorce":14,"quince":15
    };
    
    let detectedNum = null;
    // Try digit match first
    if (numberMatch) {
      const n = parseInt(numberMatch[1]);
      if (n >= 1 && n <= 20) detectedNum = n;
    }
    // Try spoken number
    if (!detectedNum) {
      for (const [word, val] of Object.entries(spokenNumbers)) {
        if (textLower.includes(word)) { detectedNum = val; break; }
      }
    }
    // Also match page-related keywords even without number (assume 1)
    if (!detectedNum && this._matches(textLower, ["página", "pagina", "hoja", "foto", "fotografía", "page", "photo", "picture"])) {
      // Mentioned pages but no number → ask
      await this._askPageCount();
      return;
    }

    if (detectedNum) {
      await this._confirmPageCount(detectedNum);
      return;
    }

    // --- User confirms all photos sent (require stronger match than just "si") ---
    if (this._matches(textLower, ["son todas", "todas", "eso es todo", "listo",
                                   "that's all", "done", "ready", "ya está", "ya esta",
                                   "envié todas", "envie todas", "esas son todas"])) {
      const stored = getStoredPhotos(this.phone);
      const count = stored.length;

      if (count === 0) {
        await this.whatsapp.sendText(this.phone,
          "No he recibido ninguna foto aún. ¿Puedes enviarme tu factura? 📸"
        );
        return;
      }

      await pool.query(
        `UPDATE sessions SET photos_confirmed = true, photos_expected = $2, state = 'analyzing', updated_at = NOW() WHERE id = $1`,
        [this.session.id, count]
      );
      this.session.photos_confirmed = true;
      this.session.photos_expected = count;
      this.session.state = "analyzing";

      await this.whatsapp.sendText(this.phone,
        `Perfecto, ${count} ${count === 1 ? "página confirmada" : "páginas confirmadas"}. Deme un momento para analizarlas... ⏳`
      );

      await this._triggerAnalysis();
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

    // --- General questions → DeepSeek + KB ---
    const history = buildConversationHistory(this.session.conversation_log);
    const context = {
      user_state: this.session.user_state || "",
      returning_context: returningContext,
    };
    const kbCtx = getKBContext(text, {
      state: this.session.user_state || "",
    });
    const response = await this.deepseek.chat(
      "intake",
      history,
      text + (kbCtx ? `\n\n📚 DATOS OBJETIVOS: ${kbCtx}` : ""),
      context
    );
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
        `¿Tiene su factura médica a la mano? Mándeme una foto cuando esté listo. 📸`;

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

    // Check if enough photos are already buffered
    const alreadyBuffered = getStoredCount(this.phone);

    if (alreadyBuffered >= num) {
      // All photos already sent — analyze now!
      await this.whatsapp.sendText(this.phone,
        `¡Perfecto! Ya tengo las ${alreadyBuffered} páginas. Deme un momento para analizarlas... ⏳`
      );
      await pool.query(
        `UPDATE sessions SET photos_confirmed = true, state = 'analyzing', updated_at = NOW() WHERE id = $1`,
        [this.session.id]
      );
      this.session.photos_confirmed = true;
      this.session.state = "analyzing";
      await this._triggerAnalysis();
      return;
    }

    const remaining = num - alreadyBuffered;
    await this.whatsapp.sendText(this.phone,
      `Perfecto, ${num} página${num === 1 ? "" : "s"}. Ya recibí ${alreadyBuffered}. ` +
      `Envíame ${remaining === 1 ? "la que falta" : `las ${remaining} restantes`} cuando estés listo.`
    );
  }

  // ===========================================================================
  // Trigger analysis from buffered photos
  // ===========================================================================
  async _triggerAnalysis() {
    const allPhotos = getStoredPhotos(this.phone);
    if (allPhotos.length === 0) {
      console.warn("⚠️ _triggerAnalysis called but no photos buffered");
      return;
    }

    try {
      const analyzer = new AnalyzerAgent(this.whatsapp, openai, this.session);
      await analyzer.analyze(allPhotos[0].buffer);

      // Clean up buffer after successful analysis
      clearStoredPhotos(this.phone);
    } catch (err) {
      console.error("❌ Intake _triggerAnalysis error:", err);
      clearStoredPhotos(this.phone);
    }
  }

  // ===========================================================================
  // Helper: check if text matches any keyword
  // ===========================================================================
  _matches(text, keywords) {
    return keywords.some((kw) => text.includes(kw));
  }
}

export default { IntakeAgent };
