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
import { firecrawl } from "../services/firecrawl.js";

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

      // Step 2: Generate letters immediately (no intermediate message)
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

        await pool.query(
          `UPDATE sessions SET state = 'delivering', updated_at = NOW() WHERE id = $1`,
          [this.session.id]
        );
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
    const facturaId = this.session.factura_id || "su número de factura";

    await this.whatsapp.sendText(this.phone,
      `📝 *Instrucciones para enviar su disputa:*\n\n` +
      `1️⃣ Imprima la carta en INGLÉS (la segunda imagen)\n` +
      `2️⃣ Fírmela debajo del nombre que ya aparece en la carta\n` +
      `3️⃣ Busque en su factura original la *dirección de facturación* de *${hospital}* (aparece como \"Billing Department\", \"Remitir pagos a\" o \"Payment Address\")\n` +
      `4️⃣ Meta la carta firmada en un sobre y escriba esa dirección\n` +
      `5️⃣ Envíela por *correo certificado* (Certified Mail) en cualquier oficina de USPS. Cuesta ~$5 y le dan comprobante de entrega\n` +
      `6️⃣ Guarde el comprobante y una copia de la carta firmada\n\n` +
      `El hospital tiene 30 días para responder por ley.\n\n` +
      `*Su número de factura:* \`${facturaId}\` — inclúyalo si el hospital se lo pide.\n\n` +
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
        "Entiendo. Proceso su devolución sin problema.\n\n" +
        "¿Me diría brevemente por qué el servicio no fue lo que esperaba? Me ayuda a mejorar."
      );
      await telegram.sendMessage(
        `⚠️ <b>Solicitud de refund</b>\nSesión: <code>${this.session.id.slice(0, 8)}</code>\n` +
        `WhatsApp: <a href="https://wa.me/${this.phone.replace(/[^0-9]/g, "")}">${this.phone}</a>\n` +
        `Hospital: ${this.session.hospital_name || "N/A"}\n` +
        `Método de pago: ${this.session.payment_method}\n` +
        `<i>Procesar manualmente si fue Zelle.</i>`
      );
      return;
    }

    // ── Despedida / cierre ─────────────────────────────────────
    if (this._matches(textLower, [
      "gracias", "thank you", "ok gracias", "perfecto", "entendido",
      "listo", "adiós", "bye", "hasta luego", "nos vemos",
    ])) {
      await this._closeSession();
      return;
    }

    // ═══════════════════════════════════════════════════════════
    // CAPA 1 — Clasificar la pregunta
    // ═══════════════════════════════════════════════════════════
    const category = await this._classifyQuestion(text);

    const userState = this.session.user_state || "CA";
    const hospital = this.session.hospital_name || "";
    const history = buildConversationHistory(this.session.conversation_log);
    const contextInfo = {
      hospital_name: hospital,
      patient_name: this.session.patient_name || "",
      payment_method: this.session.payment_method || "",
      errors_found: String(this.session.errors_found || 0),
      state: userState,
    };

    // ═══════════════════════════════════════════════════════════
    // CAPA 2 — Manejar según tipo
    // ═══════════════════════════════════════════════════════════

    // ── LEGAL ⚖️ → hechos objetivos + derivar a abogado ─────
    if (category === "LEGAL") {
      // Try to find objective public information
      let objectiveFacts = "";
      if (firecrawl.canCall(this.session.id)) {
        const context = { hospital_name: hospital, user_state: userState };
        const result = await firecrawl.searchMedicalBillingInfo(text, context);
        if (result) {
          firecrawl.incrementCallCount(this.session.id);
          // CAPA 3 — Sanitize: convertir consejos en hechos objetivos
          objectiveFacts = await this._sanitizeResearchContent(result.data, userState);
          console.log(`⚖️ Legal question — sanitized facts: ${objectiveFacts.slice(0, 120)}...`);
        }
      }

      const factsContext = objectiveFacts
        ? `\n\n📚 DATOS OBJETIVOS (FUENTE PÚBLICA):\n${objectiveFacts}\n\nUsa estos datos como hechos descriptivos. NO los conviertas en consejos legales.`
        : "";

      const response = await this.deepseek.chat(
        "closer_delivery",
        history,
        `[POST-ENTREGA — PREGUNTA LEGAL] El usuario YA recibió sus cartas. ` +
        `Hospital: ${hospital}. Estado: ${userState}. ` +
        `Mensaje del usuario: "${text}"\n\n` +
        `REGLAS ESTRICTAS:\n` +
        `⛔ NO eres abogado. NO des consejos legales.\n` +
        `⛔ NO digas "usted debe", "le recomiendo que", "tiene derecho a".\n` +
        `✅ Si hay datos objetivos (protecciones, recursos, leyes), menciónalos como HECHOS:\n` +
        `   "En California existe el Department of Managed Health Care que recibe quejas de pacientes."\n` +
        `✅ NUNCA digas "presente una queja" — di "las quejas se pueden presentar ante...".\n` +
        `✅ Cierra SIEMPRE con: "Para determinar si su caso aplica, le recomiendo consultar con un abogado en ${userState}."\n` +
        `✅ Responde de forma cálida y humana.\n` +
        `⛔ NUNCA ofrezcas seguimiento del caso. Nuestro servicio terminó al entregar las cartas.` +
        factsContext,
        contextInfo
      );

      const sanitized = sanitizeAgentResponse(response);
      await this.whatsapp.sendText(this.phone, sanitized);
      await appendToConversationLog(this.session.id, "assistant", response);
      return;
    }

    // ── FACTURACIÓN 📋 → investigar con Firecrawl ─────────────
    if (category === "FACTURACION") {
      let researchedAnswer = null;
      if (firecrawl.canCall(this.session.id)) {
        const context = { hospital_name: hospital, user_state: userState };
        const result = await firecrawl.searchMedicalBillingInfo(text, context);
        if (result) {
          firecrawl.incrementCallCount(this.session.id);
          // CAPA 3 — Sanitize antes de pasar a DeepSeek
          researchedAnswer = await this._sanitizeResearchContent(result.data, userState);
          console.log(`📋 Facturación research [${result.source}]: ${String(researchedAnswer).slice(0, 100)}...`);
        }
      }

      const researchContext = researchedAnswer
        ? `\n\n📚 INFORMACIÓN DE INVESTIGACIÓN (DATOS OBJETIVOS):\n${String(researchedAnswer)}\n\nUsa estos datos para responder. NO los conviertas en consejos.`
        : `\n\n⚠️ No se encontró información específica sobre esta consulta. Si no sabes la respuesta, dilo honestamente: "Desconozco ese dato específico".`;

      const response = await this.deepseek.chat(
        "closer_delivery",
        history,
        `[POST-ENTREGA — FACTURACIÓN] El usuario YA recibió sus cartas. ` +
        `Hospital: ${hospital}. Paciente: ${contextInfo.patient_name}. Estado: ${userState}. ` +
        `Responde de forma cálida y natural a: "${text}"\n\n` +
        `REGLAS:\n` +
        `- Responde con información ÚTIL basada en los DATOS OBJETIVOS proporcionados.\n` +
        `- Si no tienes datos para responder algo específico, di: "Esa información específica la desconozco".\n` +
        `- NO inventes datos, plazos ni procedimientos.\n` +
        `- Mantén el contexto. NO trates al usuario como nuevo.\n` +
        `⛔ NUNCA ofrezcas seguimiento del caso. Nuestro servicio terminó al entregar las cartas.` +
        researchContext,
        contextInfo
      );

      const sanitized = sanitizeAgentResponse(response);
      await this.whatsapp.sendText(this.phone, sanitized);
      await appendToConversationLog(this.session.id, "assistant", response);

      // If user seems done → close
      if (this._matches(textLower, ["gracias", "thank", "ok", "perfecto", "listo", "bye", "adiós"])) {
        await this._closeSession();
      }
      return;
    }

    // ── GENERAL 💬 → respuesta normal ────────────────────────
    const response = await this.deepseek.chat(
      "closer_delivery",
      history,
      `[POST-ENTREGA — GENERAL] El usuario YA recibió sus cartas de disputa. ` +
      `Hospital: ${hospital}. Paciente: ${contextInfo.patient_name}. ` +
      `Responde de forma cálida y natural a su mensaje: "${text}"\n\n` +
      `Mantén el contexto de la conversación. NO lo trates como nuevo usuario. ` +
      `Ya pagó, ya recibió las cartas.\n` +
      `⛔ NUNCA ofrezcas seguimiento del caso. Nuestro servicio terminó. ` +
      `Si el usuario no tiene más preguntas, despídete con calidez.`,
      contextInfo
    );

    const sanitized = sanitizeAgentResponse(response);
    await this.whatsapp.sendText(this.phone, sanitized);
    await appendToConversationLog(this.session.id, "assistant", response);

    if (this._matches(textLower, ["gracias", "thank", "ok", "perfecto", "listo", "bye", "adiós"])) {
      await this._closeSession();
    }
  }

  // ═════════════════════════════════════════════════════════════
  // CAPA 1 — Clasificar pregunta: LEGAL / FACTURACION / GENERAL
  // ═════════════════════════════════════════════════════════════
  async _classifyQuestion(text) {
    const textLower = text.toLowerCase();

    // Fast keyword pre-check for clear categories
    const LEGAL_KEYWORDS = [
      "demanda", "demandar", "demando", "abogado", "denunciar", "denuncia",
      "ilegal", "corte", "tribunal", "juez", "judicial", "ley", "derecho",
      "obligación", "queja formal", "reportar", "violación", "fraud",
      "negligencia", "malpractice", "sue", "lawsuit", "attorney",
    ];

    const FACTURACION_KEYWORDS = [
      "cpt", "código", "error", "costo", "precio", "cargo", "medicare",
      "seguro", "cobertura", "deducible", "copago", "factura", "billing",
      "hospital", "clínica", "procedimiento", "servicio", "tarifa",
      "descuento", "caridad", "charity", "financiera", "pago", "plan",
      "códigos", "upcoding", "duplicado", "desagregación",
    ];

    const isLegal = LEGAL_KEYWORDS.some(kw => textLower.includes(kw));
    const isFacturacion = FACTURACION_KEYWORDS.some(kw => textLower.includes(kw));

    // Clear cases
    if (isLegal && !isFacturacion) return "LEGAL";
    if (isFacturacion && !isLegal) return "FACTURACION";
    if (!isLegal && !isFacturacion) return "GENERAL";

    // Ambiguous: both or neither matched clearly — use DeepSeek reasoning
    const systemPrompt = `Eres un clasificador de preguntas. Analiza el mensaje y clasifícalo en UNA categoría.`;

    try {
      const classification = await this.deepseek.chat(
        "closer_delivery",
        [],
        `Clasifica esta pregunta de un usuario que YA recibió sus cartas de disputa médica:\n\n` +
        `"${text}"\n\n` +
        `Categorías:\n` +
        `- LEGAL: pregunta sobre demandas, abogados, derechos legales, denuncias, cortes, leyes\n` +
        `- FACTURACION: pregunta sobre códigos CPT, precios, errores de facturación, seguros, cargos médicos\n` +
        `- GENERAL: agradecimientos, despedidas, preguntas sobre el proceso, tiempos de espera, siguiente paso\n\n` +
        `Responde ÚNICAMENTE con una palabra: LEGAL, FACTURACION o GENERAL.`,
        {}
      );

      const cat = (classification || "").trim().toUpperCase();
      if (cat.includes("LEGAL")) return "LEGAL";
      if (cat.includes("FACTURACION")) return "FACTURACION";
      return "GENERAL";
    } catch {
      // Fallback: if both matched, default to LEGAL (safer)
      return isLegal ? "LEGAL" : "GENERAL";
    }
  }

  // ═════════════════════════════════════════════════════════════
  // CAPA 3 — Sanitizar contenido de investigación
  // Convierte consejos/imperativos en hechos objetivos
  // ═════════════════════════════════════════════════════════════
  async _sanitizeResearchContent(rawContent, userState) {
    if (!rawContent) return "";

    try {
      const sanitized = await this.deepseek.chat(
        "closer_delivery",
        [],
        `Reescribe el siguiente texto convirtiendo CONSEJOS e IMPERATIVOS en HECHOS OBJETIVOS.\n\n` +
        `TEXTO ORIGINAL:\n${String(rawContent).slice(0, 2000)}\n\n` +
        `REGLAS DE TRANSFORMACIÓN:\n` +
        `- "You should file a complaint" → "Complaints can be filed with..."\n` +
        `- "Patients have the right to sue" → "Legal options available to patients include..."\n` +
        `- "You must request an itemized bill" → "Patients can request an itemized bill"\n` +
        `- "Your hospital is violating..." → "Hospitals are required to..."\n` +
        `- "Demand a reduction" → "Reductions may be requested"\n` +
        `- ELIMINA frases como "you deserve", "fight back", "don't let them"\n` +
        `- CONVIERTE todo a voz pasiva o tercera persona\n` +
        `- MANTÉN los datos factuales: números, nombres de agencias, leyes, plazos legales\n` +
        `- Si el texto menciona protecciones al consumidor en ${userState}, consérvalas como dato objetivo\n` +
        `- NO añadas información nueva. Solo transforma el tono.`,
        {}
      );

      return sanitized || String(rawContent).slice(0, 1500);
    } catch {
      return String(rawContent).slice(0, 1500);
    }
  }

  // ===========================================================================
  // Close session: warm goodbye + clear placeholder data
  // ===========================================================================
  async _closeSession() {
    await this.whatsapp.sendText(this.phone,
      "Ha sido un placer ayudarle. Si en el futuro necesita revisar otra factura médica, " +
      "aquí estaré. ¡Mucha suerte con su disputa! 🏥✨"
    );

    // Clear placeholder data but preserve user identity
    await pool.query(
      `UPDATE sessions
       SET customer_name = NULL,
           patient_name = NULL,
           photos = '[]'::jsonb,
           photos_expected = NULL,
           photos_confirmed = FALSE,
           analysis_result = NULL,
           errors_found = 0,
           potential_savings = 0,
           total_billed = 0,
           hospital_name = NULL,
           factura_id = NULL,
           signer_name = NULL,
           signer_relationship = NULL,
           carta_es_url = NULL,
           carta_en_url = NULL,
           state = 'closed',
           session_closed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [this.session.id]
    );

    console.log(`🧹 Session ${this.session.id.slice(0, 8)} — data cleared, user identity preserved`);
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================
  _matches(text, keywords) {
    return keywords.some((kw) => text.includes(kw));
  }
}

export default { CloserAgent };
