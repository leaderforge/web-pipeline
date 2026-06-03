// =============================================================================
// Closer Agent — FASE 4: Generate letters, deliver, report to Sheets
// MUST validate payment_confirmed = true before delivering
// =============================================================================

import { pool, appendToConversationLog, buildConversationHistory } from "../middleware/session.js";
import { sanitizeAgentResponse, getLetterFooterDisclaimer } from "../middleware/legal.js";
import { deepseek } from "../services/deepseek.js";
import { generateLetters, generateTextLetters } from "../services/generator.js";
import { sheets } from "../services/sheets.js";
import { telegram } from "../services/telegram.js";

export class CloserAgent {
  constructor(whatsapp, deepseekSvc, stripeSvc, session) {
    this.whatsapp = whatsapp;
    this.deepseek = deepseekSvc || deepseek;
    this.stripe = stripeSvc;
    this.session = session;
    this.phone = session.whatsapp_number;
  }

  // ===========================================================================
  // FASE 4 — Generate and deliver dispute letters
  // DOUBLE CHECK: payment_confirmed MUST be true
  // ===========================================================================
  async deliver() {
    // GUARD: Never deliver without payment
    if (!this.session.payment_confirmed) {
      console.error(`❌ Attempted delivery without payment. Session: ${this.session.id.slice(0, 8)}`);
      await this.whatsapp.sendText(this.phone,
        "Para recibir sus cartas de disputa, es necesario completar el pago de $29 USD. " +
        "¿Cómo prefiere realizar su pago?"
      );
      return;
    }

    // ── CHECK: Is the patient a minor? ─────────────────────────────────
    const patientName = this.session.patient_name || "";
    const isMinor = this.session.patient_is_minor || false;
    const signerName = this.session.signer_name || "";
    const signerRel = this.session.signer_relationship || "";

    // If patient is minor and we haven't asked about signer yet
    if (isMinor && !signerName) {
      await this.whatsapp.sendText(this.phone,
        `Detectamos que el paciente *${patientName}* es menor de edad.\n\n` +
        `Para la carta de disputa, necesito saber:\n\n` +
        `*¿Quién firmará la carta como responsable?*\n\n` +
        `A) Soy su *padre o madre*\n` +
        `B) Soy su *tutor legal* designado por corte\n` +
        `C) Soy otro *familiar o representante autorizado*\n\n` +
        `Por favor, respóndame con la letra (A, B, o C) y el nombre completo que debe aparecer.\n` +
        `Ejemplo: "A, María García López"`
      );
      await pool.query(
        `UPDATE sessions SET state = 'awaiting_signer', updated_at = NOW() WHERE id = $1`,
        [this.session.id]
      );
      this.session.state = "awaiting_signer";
      return;
    }

    // Determine final signer info
    let finalSignerName, finalSignerRel;
    if (isMinor && signerName) {
      finalSignerName = signerName;
      finalSignerRel = signerRel;
    } else if (isMinor && !signerName) {
      // Shouldn't reach here (handled above), but fallback
      finalSignerName = this.session.customer_name || patientName;
      finalSignerRel = "parent";
    } else {
      // Adult — signer is the patient (name extracted from bill)
      finalSignerName = patientName || "Cliente";
      finalSignerRel = "self";
    }

    try {
      // Step 1: Brief education — explain the errors before generating letters
      const analysis = this.session.analysis_result || {};
      const errors = analysis.errores_detectados || [];
      if (errors.length > 0) {
        const errorSummary = errors.map((e, i) =>
          `${i + 1}. *${e.titulo || "Error detectado"}*: ${(e.descripcion || "").slice(0, 200)}`
        ).join("\n\n");

        await this.whatsapp.sendText(this.phone,
          `Antes de preparar sus cartas, un resumen de lo que encontramos en su factura:\n\n${errorSummary}\n\n` +
          `*Ahorro total estimado: $${(analysis.ahorro_total_estimado || 0).toLocaleString()}*\n\n` +
          `Ahora preparo sus cartas. Un momento...`
        );
        await appendToConversationLog(this.session.id, "assistant", "Educator: error summary sent");

        // If charity care applies, mention it
        if (analysis.charity_care_info) {
          await this.whatsapp.sendText(this.phone,
            `💡 Un dato adicional: *${this.session.hospital_name}* tiene un programa de asistencia financiera (charity care). Si sus ingresos son limitados, podría calificar para descuentos importantes.\n\n` +
            `Es independiente de la disputa — puede aplicar a ambos. ¿Quiere que le explique cómo funciona?`
          );
        }
      }

      // Step 2: Notify user letters are coming
      await this.whatsapp.sendText(this.phone,
        "¡Perfecto! Estoy preparando sus cartas de disputa personalizadas. " +
        "Recibirá dos imágenes:\n" +
        "📄 Una en español (para usted)\n" +
        "📄 Una en inglés (para el hospital)\n\n" +
        "Un momento por favor..."
      );

      await pool.query(
        `UPDATE sessions SET state = 'delivering', updated_at = NOW() WHERE id = $1`,
        [this.session.id]
      );

      // Step 3: Generate letters (analysis already loaded above)
      const signerData = {
        name: finalSignerName,
        relationship: finalSignerRel,
        patientName: patientName,
        isMinor: isMinor,
      };

      let esBuffer, enBuffer;
      try {
        const letters = await generateLetters(analysis, signerData);
        esBuffer = letters.es_bytes;
        enBuffer = letters.en_bytes;
        console.log(`📄 Letters generated: ES=${esBuffer.length}B, EN=${enBuffer.length}B`);
      } catch (e) {
        // Playwright not available — fallback to text
        console.warn(`⚠️ Playwright failed, falling back to text: ${e.message}`);
        const textLetters = generateTextLetters(analysis, signerData);

        await this.whatsapp.sendText(this.phone,
          `📄 *Carta en Español:*\n\n${textLetters.es_text.slice(0, 1500)}`
        );
        await this.whatsapp.sendText(this.phone,
          `📄 *Carta en Inglés:*\n\n${textLetters.en_text.slice(0, 1500)}`
        );

        // Still give instructions
        await this._sendInstructions();
        await this._reportToSheets();
        return;
      }

      // Step 3: Send Spanish letter
      await this.whatsapp.sendImage(this.phone, esBuffer,
        "📄 Carta de disputa en ESPAÑOL — para su referencia"
      );

      // Step 4: Send English letter
      await this.whatsapp.sendImage(this.phone, enBuffer,
        "📄 Dispute letter in ENGLISH — para enviar al hospital"
      );

      // Step 5: Send instructions
      await this._sendInstructions();

      // Step 6: Report to Google Sheets
      await this._reportToSheets();

      // Step 7: Update session state — keep OPEN for follow-up questions
      await pool.query(
        `UPDATE sessions
         SET state = 'delivered',
             sheets_reported = true,
             updated_at = NOW()
         WHERE id = $1`,
        [this.session.id]
      );
      this.session.state = "delivered";

      console.log(`✅ Session ${this.session.id.slice(0, 8)} — letters delivered, session stays open for follow-up`);

    } catch (e) {
      console.error("❌ Delivery error:", e);
      await telegram.alertServerError(e);
      await this.whatsapp.sendText(this.phone,
        "Disculpe, tuve un problema técnico generando sus cartas. " +
        "No se preocupe — estoy trabajando en resolverlo. Se las enviaré en unos minutos."
      );
    }
  }

  // ===========================================================================
  // Send mailing instructions
  // ===========================================================================
  async _sendInstructions() {
    const hospital = this.session.hospital_name || "el hospital";

    await this.whatsapp.sendText(this.phone,
      `📝 *Instrucciones para enviar su disputa:*\n\n` +
      `1️⃣ Imprima la carta en INGLÉS (la segunda imagen)\n` +
      `2️⃣ Fírmela con su nombre completo\n` +
      `3️⃣ Envíela por *correo certificado* al departamento de facturación de *${hospital}*\n` +
      `4️⃣ Guarde el recibo del correo certificado\n` +
      `5️⃣ Conserve una copia de la carta firmada\n\n` +
      `El hospital suele responder en un plazo de 30 días.\n\n` +
      `¿Tiene alguna duda sobre el proceso?`
    );
  }

  // ===========================================================================
  // Report completed session to Google Sheets
  // ===========================================================================
  async _reportToSheets() {
    if (this.session.sheets_reported) {
      console.log("📊 Already reported — skipping");
      return;
    }

    // Ensure headers exist
    await sheets.ensureHeaders();

    // Append session data
    const success = await sheets.appendSession(this.session);
    if (success) {
      await pool.query(
        `UPDATE sessions SET sheets_reported = true, updated_at = NOW() WHERE id = $1`,
        [this.session.id]
      );
    }
  }

  // ===========================================================================
  // Handle signer response for minor patients
  // ===========================================================================
  async handleSignerResponse(text) {
    const textTrimmed = text.trim();
    
    // Parse response: "A, María García" or just "A" or "María García"
    const match = textTrimmed.match(/^([ABC])\b[,\s]*\s*(.*)/i);
    
    let relationship = "";
    let signerNameInput = "";
    
    if (match) {
      const letter = match[1].toUpperCase();
      signerNameInput = match[2]?.trim() || "";
      
      const relMap = {
        "A": "parent",
        "B": "legal_guardian", 
        "C": "other"
      };
      relationship = relMap[letter];
    } else {
      // No letter found — treat entire text as name, default to parent
      const looksLikeName = /^[A-Za-zÁ-Úá-úÑñ\s'-]{3,60}$/.test(textTrimmed);
      if (looksLikeName) {
        signerNameInput = textTrimmed;
        relationship = "parent";
      } else {
        await this.whatsapp.sendText(this.phone,
          "No entendí bien. Por favor, respóndame con la letra (A, B o C) y el nombre.\n\n" +
          "Ejemplo: \"A, María García\"\n\n" +
          "A) Soy su padre o madre\n" +
          "B) Soy su tutor legal\n" +
          "C) Soy otro familiar o representante"
        );
        return;
      }
    }
    
    // Validate name
    if (signerNameInput.length < 2) {
      await this.whatsapp.sendText(this.phone,
        "¿Podría darme el nombre completo, por favor? Necesito saber cómo firmar la carta."
      );
      return;
    }
    
    // Save to session
    await pool.query(
      `UPDATE sessions 
       SET signer_name = $2, signer_relationship = $3, state = 'paid', updated_at = NOW() 
       WHERE id = $1`,
      [this.session.id, signerNameInput, relationship]
    );
    this.session.signer_name = signerNameInput;
    this.session.signer_relationship = relationship;
    this.session.state = "paid";
    
    const relLabels = {
      "parent": "padre/madre",
      "legal_guardian": "tutor legal",
      "other": "representante autorizado"
    };
    
    await this.whatsapp.sendText(this.phone,
      `Perfecto. La carta irá firmada por *${signerNameInput}* como *${relLabels[relationship]}* del menor *${this.session.patient_name}*.\n\n` +
      "Ahora preparo sus cartas..."
    );
    
    // Call deliver again — now signer is set
    await this.deliver();
  }

  // ===========================================================================
  // Handle post-delivery messages — user returns after receiving letters
  // ===========================================================================
  async handlePostDelivery(text) {
    const textLower = text.toLowerCase();

    // Refund request
    if (this._matches(textLower, [
      "reembolso", "devolución", "refund", "cancelar", "regresar",
      "dinero", "cancel", "money back", "return",
    ])) {
      await this.whatsapp.sendText(this.phone,
        "Entiendo. Proceso su devolución sin problema — tiene 7 días de garantía.\n\n" +
        "¿Me diría brevemente por qué el servicio no fue lo que esperaba? Me ayuda a mejorar."
      );
      await telegram.sendMessage(
        `⚠️ <b>Solicitud de refund</b>\nSesión: <code>${this.session.id.slice(0, 8)}</code>\n` +
        `WhatsApp: ***${this.phone.slice(-4)}\nHospital: ${this.session.hospital_name || "N/A"}\n` +
        `Método de pago: ${this.session.payment_method}\n` +
        `<i>Procesar manualmente si fue Zelle.</i>`
      );
      return;
    }

    // Follow-up questions — user already has their letters, keep context
    const history = buildConversationHistory(this.session.conversation_log);
    const contextInfo = {
      hospital_name: this.session.hospital_name || "",
      patient_name: this.session.patient_name || "",
      payment_method: this.session.payment_method || "",
      errors_found: String(this.session.errors_found || 0),
    };

    const response = await this.deepseek.chat(
      "closer_delivery",
      history,
      `[POST-ENTREGA] El usuario YA recibió sus cartas de disputa. ` +
      `Hospital: ${contextInfo.hospital_name}. Paciente: ${contextInfo.patient_name}. ` +
      `Responde de forma cálida y natural a su mensaje: "${text}"\n\n` +
      `Mantén el contexto de la conversación. NO lo trates como nuevo usuario. ` +
      `Ya pagó, ya recibió las cartas. Ahora solo necesita seguimiento.`,
      contextInfo
    );
    await this.whatsapp.sendText(this.phone, sanitizeAgentResponse(response));
    await appendToConversationLog(this.session.id, "assistant", response);
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================
  _matches(text, keywords) {
    return keywords.some((kw) => text.includes(kw));
  }
}

export default { CloserAgent };
