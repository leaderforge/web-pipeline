// =============================================================================
// Analyzer Agent — FASE 2: OCR + Cross-reference + Build report
// =============================================================================

import { pool, appendToConversationLog } from "../middleware/session.js";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { openai } from "../services/openai.js";
import { deepseek } from "../services/deepseek.js";
import { telegram } from "../services/telegram.js";
import { HermesAgent } from "./hermes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");

export class AnalyzerAgent {
  constructor(whatsapp, openaiSvc, session) {
    this.whatsapp = whatsapp;
    this.openai = openaiSvc || openai;
    this.session = session;
    this.phone = session.whatsapp_number;
    this.retryCount = 0;
    this.maxRetries = 3;
  }

  // ===========================================================================
  // Analyze bill image using GPT-4o Vision + cross-reference with local KB
  // ===========================================================================
  async analyze(imageBuffers) {
    // Normalize: single buffer or array — both accepted
    const buffers = Array.isArray(imageBuffers) ? imageBuffers : [imageBuffers];

    // Mark session as analyzing
    await pool.query(
      `UPDATE sessions SET state = 'analyzing', updated_at = NOW() WHERE id = $1`,
      [this.session.id]
    );

    try {
      // Build CPT reference lookup for the AI
      const cptRef = this._buildCptReference();

      // Step 1: GPT-4o Vision analysis — pass ALL pages
      const userState = this.session.user_state || "CA";
      const result = await this.openai.analyzeBill(buffers, cptRef, userState);

      if (result.error) {
        await this._handleAnalysisError(result.error);
        return;
      }

      // Step 2: Validate it's a medical bill
      if (result.severidad === "invalida" || result.es_factura_medica === false) {
        await this.whatsapp.sendText(this.phone,
          "Esa imagen no parece ser una factura médica o documento de salud. 🏥\n\n" +
          "MedillaForms solo puede ayudarle con facturas de hospitales, clínicas, laboratorios o servicios médicos.\n\n" +
          "¿Tiene una factura médica para revisar? Mándemela cuando guste."
        );
        await pool.query(
          `UPDATE sessions SET state = 'intake', updated_at = NOW() WHERE id = $1`,
          [this.session.id]
        );
        return;
      }

      // Step 3: Check OCR confidence
      const confidence = result.confianza_ocr || 0;
      if (confidence < 70) {
        this.retryCount++;
        if (this.retryCount >= this.maxRetries) {
          await this.whatsapp.sendText(this.phone,
            "Disculpe, no he podido leer bien la factura después de varios intentos. " +
            "¿Podría intentar con una foto diferente?\n\n" +
            "Tips: coloque la factura plana sobre una mesa oscura, con buena luz natural, " +
            "y asegúrese de que todo el texto sea visible."
          );
          await telegram.alertImageNotLegible(this.phone, this.retryCount);
          await pool.query(
            `UPDATE sessions SET state = 'intake', updated_at = NOW() WHERE id = $1`,
            [this.session.id]
          );
          return;
        }

        await this.whatsapp.sendText(this.phone,
          "La imagen está un poco difícil de leer. ¿Podría tomar otra foto?\n\n" +
          "Intente que la factura esté plana sobre una mesa, con buena luz, y que el texto sea claro."
        );
        return;
      }

      // Step 4: Cross-reference with local knowledge base
      const enriched = this._crossReference(result);

      // Step 4b: Detect minority + extract patient name
      const patientName = enriched.patient_name || enriched.nombre_paciente || "";
      const patientAge = enriched.patient_age || enriched.edad_paciente || 
        this._calculateAge(enriched.patient_dob || enriched.fecha_nacimiento);
      const isMinor = patientAge > 0 && patientAge < 18;

      // Extract invoice/bill ID if GPT-4o found it
      const facturaId = enriched.factura_id || null;

      // ═══ INVOICE ID GATE ════════════════════════════════════
      // If no invoice/account number was detected, STOP and ask user.
      // Without this, the dispute letter is incomplete — hospitals require it.
      if (!facturaId) {
        // Store partial analysis temporarily, mark session as waiting for invoice
        await pool.query(
          `UPDATE sessions
           SET analysis_result = $2,
               errors_found = $3,
               potential_savings = $4,
               total_billed = $5,
               hospital_name = $6,
               user_state = $7,
               patient_name = $8,
               patient_is_minor = $9,
               photos = photos || '[]'::jsonb,
               state = 'awaiting_invoice',
               updated_at = NOW()
           WHERE id = $1`,
          [
            this.session.id,
            JSON.stringify(enriched),
            (enriched.errores_detectados || []).length,
            enriched.ahorro_total_estimado || 0,
            enriched.total_facturado || 0,
            enriched.hospital || "N/A",
            enriched.estado || "CA",
            patientName,
            isMinor,
          ]
        );

        // Update local session
        this.session.analysis_result = enriched;
        this.session.state = "awaiting_invoice";

        await this.whatsapp.sendText(this.phone,
          `Revisé sus fotos y ya tengo información valiosa. Pero hay algo que necesito para continuar:\\n\\n` +
          `📋 *El número de factura (Invoice # o Account #).*\\n\\n` +
          `Este número aparece en su factura original, generalmente en la esquina superior derecha, con un formato como:\\n` +
          `• \"Invoice #: INV-2025-0042\"\\n` +
          `• \"Account #: 12345678\"\\n` +
          `• \"Bill #: B-9876543\"\\n\\n` +
          `Es importante porque el hospital lo usa para identificar su caso. Sin él, la carta de disputa no puede ser procesada.\\n\\n` +
          `*¿Podría revisar su factura y enviarme ese número?*`
        );
        await appendToConversationLog(this.session.id, "assistant", "Invoice gate: asking for invoice #");
        return;
      }

      // Step 5: Save analysis to session
      await pool.query(
        `UPDATE sessions
         SET analysis_result = $2,
             errors_found = $3,
             potential_savings = $4,
             total_billed = $5,
             hospital_name = $6,
             user_state = $7,
             patient_name = $8,
             patient_is_minor = $9,
             factura_id = $10,
             photos = photos || '[]'::jsonb,
             state = 'analyzed',
             updated_at = NOW()
         WHERE id = $1`,
        [
          this.session.id,
          JSON.stringify(enriched),
          (enriched.errores_detectados || []).length,
          enriched.ahorro_total_estimado || 0,
          enriched.total_facturado || 0,
          enriched.hospital || "N/A",
          enriched.estado || "CA",
          patientName,
          isMinor,
          facturaId,
        ]
      );

      // Update local session object
      this.session.analysis_result = enriched;
      this.session.errors_found = (enriched.errores_detectados || []).length;
      this.session.potential_savings = enriched.ahorro_total_estimado || 0;
      this.session.total_billed = enriched.total_facturado || 0;
      this.session.hospital_name = enriched.hospital || "N/A";
      this.session.user_state = enriched.estado || "CA";
      this.session.patient_name = patientName;
      this.session.patient_is_minor = isMinor;
      this.session.factura_id = facturaId;

      // Step 6: Present hook (FASE 3)
      const hermes = new HermesAgent(this.whatsapp, null, this.session);
      await hermes.presentHook();

    } catch (e) {
      console.error("❌ Analyzer error:", e);
      await this._handleAnalysisError(e.message);
    }
  }

  // ===========================================================================
  // Cross-reference analysis with local knowledge base
  // ===========================================================================
  _crossReference(analysis) {
    const enriched = { ...analysis };

    // Load local knowledge bases
    const cptCodes = this._loadJson("cpt_codes.json");
    const billingErrors = this._loadJson("billing_errors.json");
    const charityCare = this._loadJson("charity_care.json");
    const stateLaws = this._loadJson("state_laws.json");

    // Enrich each detected error
    if (enriched.errores_detectados) {
      enriched.errores_detectados = enriched.errores_detectados.map((err) => {
        const enriched_err = {
          ...err,
          tipo_descripcion: billingErrors?.error_types?.[`${err.tipo}_${this._getErrorTypeName(err.tipo)}`]?.name || err.tipo,
        };

        // ── VALIDATE precio_referencia against CPT codes ──
        // If the error has an associated item with a CPT code, cross-check
        // the reference price against our local CPT database.
        if (enriched.items && enriched.items.length > 0 && err.item_referencia) {
          const refLower = err.item_referencia.toLowerCase();

          // Try to find matching CPT code from items
          for (const item of enriched.items) {
            const code = item.codigo_cpt;
            if (code && cptCodes?.codes && cptCodes.codes[code]) {
              const cptEntry = cptCodes.codes[code];
              const medicareRate = cptEntry.medicare_rate || 0;

              // Check if item description matches the error reference
              const itemDesc = (item.descripcion || "").toLowerCase();
              if (medicareRate > 0 && (itemDesc.includes(refLower.slice(0, 15)) || refLower.includes(itemDesc.slice(0, 15)))) {
                // Medicare rate found — use 2.5x as reasonable reference
                const reasonableRef = Math.round(medicareRate * 2.5 * 100) / 100;
                const gptRef = err.precio_referencia || 0;

                // If GPT-4o's reference is wildly off (>5x the reasonable rate), correct it
                if (gptRef > reasonableRef * 2 || gptRef < medicareRate * 0.5) {
                  console.log(`⚠️ Correcting precio_referencia for ${code}: GPT=${gptRef} → CPT-based=${reasonableRef} (Medicare=${medicareRate})`);
                  enriched_err.precio_referencia = reasonableRef;
                  enriched_err.evidencia = (enriched_err.evidencia || "") +
                    ` Tarifa Medicare: $${medicareRate}. Referencia ajustada: $${reasonableRef} (2.5× Medicare).`;
                }
                break;
              }
            }
          }
        }

        return enriched_err;
      });
    }

    // Cross-reference CPT codes
    if (enriched.items && cptCodes?.codes) {
      enriched.items = enriched.items.map((item) => {
        const code = item.codigo_cpt;
        if (code && cptCodes.codes[code]) {
          const ref = cptCodes.codes[code];
          const ratio = item.precio_unitario / (ref.medicare_rate || 1);
          return {
            ...item,
            medicare_rate: ref.medicare_rate,
            category: ref.category,
            price_vs_medicare_ratio: Math.round(ratio * 10) / 10,
            potential_overcharge: ratio > 3,
          };
        }
        return item;
      });
    }

    // Check charity care
    if (enriched.hospital && charityCare?.hospitals) {
      const hospitalLower = enriched.hospital.toLowerCase();
      for (const [key, info] of Object.entries(charityCare.hospitals)) {
        if (hospitalLower.includes(key) || hospitalLower.includes(info.name.toLowerCase())) {
          enriched.charity_care_info = info;
          enriched.aplica_charity_care = true;
          break;
        }
      }
    }

    // Check state protections
    if (enriched.estado && stateLaws?.states) {
      const stateKey = enriched.estado.toUpperCase();
      enriched.state_protections = stateLaws.states[stateKey] || null;
    }

    return enriched;
  }

  // ===========================================================================
  // Handle invoice number response — user provides Invoice # after gate
  // Uses DeepSeek to understand natural language (same pattern as handleAwaitingPhotos)
  // ===========================================================================
  async handleInvoiceResponse(text) {
    const sessionId = this.session.id || "unknown";
    const attempt = this.session.invoice_attempts || 0;

    // Increment attempt counter
    this.session.invoice_attempts = attempt + 1;

    // ── STALLING DETECTION (>3 messages without invoice) ──
    if (attempt >= 3) {
      await this.whatsapp.sendText(this.phone,
        "Parece que está teniendo dificultad para encontrar el número de factura. No se preocupe.\n\n" +
        "📸 *Opción fácil:* envíeme otra foto de su factura, pero esta vez enfoque la *esquina superior derecha* — " +
        "ahí suele aparecer el Invoice #.\n\n" +
        "Si prefiere, también puede escribir lo que ve en esa sección y yo lo identifico."
      );
      this.session.invoice_attempts = 0; // Reset counter after offering help
      return;
    }

    // ── Use DeepSeek to understand user's intent ──
    const reasoning = await deepseek.chat(
      "intake",
      [],
      `El usuario está en el paso donde le pedí el *número de factura* (Invoice #, Account #, Bill #) ` +
      `de su factura médica.\n\n` +
      `El usuario respondió: "${text}"\n\n` +
      `Analiza su respuesta y clasifícala en UNA de estas categorías:\n\n` +
      `1. Si el usuario PROPORCIONÓ un número de factura o account number → responde "INVOICE:<número>" ` +
      `(extrae SOLO el código alfanumérico, sin texto extra. Ej: si dice "Creo que es INV-2025-0042" → "INVOICE:INV-2025-0042")\n` +
      `2. Si el usuario hace una PREGUNTA sobre dónde encontrarlo, cómo se ve, o pide ayuda → responde "QUESTION" ` +
      `(ej: "¿dónde encuentro eso?", "no lo veo", "¿cómo se ve?", "¿me puedes ayudar?")\n` +
      `3. Si el usuario NO está hablando del invoice o cambió de tema → responde "UNRELATED"\n` +
      `4. Si el usuario está evadiendo, pide tiempo o la respuesta es ambigua → responde "STALLING" ` +
      `(ej: "dame un momento", "luego te lo paso", "ahorita", "ok")\n\n` +
      `RESPONDE SOLO CON EL CÓDIGO: INVOICE:<número>, QUESTION, UNRELATED, o STALLING. Nada más.`,
      {}
    );

    const answer = (reasoning || "").trim().toUpperCase();
    console.log(`📋 Invoice gate [${sessionId.slice(0,8)}] attempt ${attempt}: "${text.slice(0,60)}" → ${answer}`);

    // ── INVOICE:<id> — user provided it! ──────────────────────
    if (answer.startsWith("INVOICE:")) {
      const facturaId = answer.split(":")[1]?.trim();
      if (!facturaId || facturaId.length < 2) {
        // Extraction failed somehow
        await this._askForInvoiceAgain();
        return;
      }

      // Save invoice ID to session
      await pool.query(
        `UPDATE sessions 
         SET factura_id = $2, state = 'analyzed', updated_at = NOW() 
         WHERE id = $1`,
        [this.session.id, facturaId]
      );
      this.session.factura_id = facturaId;
      this.session.state = "analyzed";
      this.session.invoice_attempts = 0;

      // Update analysis_result
      const analysis = this.session.analysis_result || {};
      analysis.factura_id = facturaId;
      await pool.query(
        `UPDATE sessions SET analysis_result = $2 WHERE id = $1`,
        [this.session.id, JSON.stringify(analysis)]
      );
      this.session.analysis_result = analysis;

      await this.whatsapp.sendText(this.phone,
        `¡Perfecto! Número de factura *${facturaId}* registrado. ✅\n\n` +
        `Ahora continúo con el análisis de su caso...`
      );
      await appendToConversationLog(this.session.id, "user", text);
      await appendToConversationLog(this.session.id, "assistant", `Invoice received: ${facturaId} (DeepSeek extracted)`);

      // Continue to hook (FASE 3)
      const { HermesAgent } = await import("./hermes.js");
      const hermes = new HermesAgent(this.whatsapp, null, this.session);
      await hermes.presentHook();
      return;
    }

    // ── QUESTION — user needs help finding it ────────────────
    if (answer === "QUESTION") {
      await this.whatsapp.sendText(this.phone,
        "Entiendo, no se preocupe. El número de factura aparece en su factura original del hospital. Busque:\n\n" +
        "📄 *Parte superior derecha* de la primera página.\n" +
        "🔍 Palabras clave: *Invoice #*, *Account #*, *Bill #*, *Statement #*.\n" +
        "🔢 Es un código alfanumérico (letras y números), algo como:\n" +
        "   • `INV-2025-0042`\n" +
        "   • `ACCT-12345678`\n" +
        "   • `B-9876543`\n\n" +
        "Si no lo encuentra, puede enviarme otra foto enfocando la esquina superior derecha de la factura y yo lo identifico por usted."
      );
      await appendToConversationLog(this.session.id, "user", text);
      await appendToConversationLog(this.session.id, "assistant", "Invoice gate: guided user to find invoice");
      return;
    }

    // ── UNRELATED — user is off-topic ────────────────────────
    if (answer === "UNRELATED") {
      await this.whatsapp.sendText(this.phone,
        "Antes de continuar, necesito un dato importante de su factura:\n\n" +
        "📋 *El número de factura (Invoice # o Account #)*\n\n" +
        "Aparece en la esquina superior derecha de su factura original. " +
        "Sin este número, el hospital no puede identificar su caso.\n\n" +
        "¿Podría revisar su factura y enviármelo?"
      );
      return;
    }

    // ── STALLING / AMBIGUOUS / DEFAULT ───────────────────────
    await this.whatsapp.sendText(this.phone,
      "Cuando esté listo, envíeme el número de factura. " +
      "Está en su factura original, en la parte superior derecha. " +
      "Es algo como *INV-2025-0042* o *Account #: 12345678*."
    );
  }

  async _askForInvoiceAgain() {
    await this.whatsapp.sendText(this.phone,
      "No logré identificar el número de factura en su mensaje. ¿Podría escribirlo exactamente como aparece en su factura?\n\n" +
      "Por ejemplo: *INV-2025-0042* o *ABC-12345678*"
    );
  }

  // ===========================================================================
  // Build CPT code reference table for injection into GPT-4o prompt
  // Extracts the most relevant codes grouped by category
  // ===========================================================================
  _buildCptReference() {
    const cptCodes = this._loadJson("cpt_codes.json");
    if (!cptCodes?.codes) return "";

    // Focus on hospital-relevant categories with codes under $2000 (common bills)
    const priorityCategories = [
      "emergency", "outpatient", "inpatient", "anesthesia",
      "radiology", "pathology_lab", "medicine", "evaluation_management",
      "therapy_rehab"
    ];

    const lines = ["TARIFAS MEDICARE DE REFERENCIA (2025) — Usa estos valores para comparar:"];
    let count = 0;
    const MAX = 120;

    for (const [code, info] of Object.entries(cptCodes.codes)) {
      if (count >= MAX) break;
      const rate = info.medicare_rate || 0;
      const cat = info.category || "";
      const desc = info.description || "";

      // Include high-value codes (surgery, imaging) + all common categories
      const isPriority = priorityCategories.some(c => cat.includes(c) || cat === c);
      const isHighValue = rate > 100;
      const isCommon = !!desc;

      if (isPriority || isHighValue || isCommon) {
        const descSuffix = desc ? ` (${desc})` : "";
        lines.push(`${code}: $${rate} [${cat}]${descSuffix}`);
        count++;
      }
    }

    // Add lab reference rates
    if (cptCodes.lab_reference_rates) {
      lines.push("\nTARIFAS DE LABORATORIO (CLFS):");
      for (const [code, info] of Object.entries(cptCodes.lab_reference_rates)) {
        if (code.startsWith("_")) continue;
        lines.push(`${code}: $${info.medicare_rate} — ${info.description}`);
      }
    }

    // Add medication markup warning
    if (cptCodes.medication_reference) {
      lines.push("\nALERTA DE SOBREPRECIO EN MEDICAMENTOS/SUMINISTROS:");
      for (const [name, info] of Object.entries(cptCodes.medication_reference)) {
        if (name.startsWith("_")) continue;
        lines.push(`${name}: costo real ~$${info.actual_cost}${info.unit ? '/' + info.unit : ''}, hospitales cobran ~$${info.typical_charge}${info.unit ? '/' + info.unit : ''}`);
      }
    }

    return lines.join("\n");
  }

  // ===========================================================================
  // Handle analysis errors
  // ===========================================================================
  async _handleAnalysisError(error) {
    console.error("❌ Analysis error:", error);

    this.retryCount++;
    if (this.retryCount >= this.maxRetries) {
      await this.whatsapp.sendText(this.phone,
        "Disculpe, estoy teniendo dificultades técnicas para analizar su factura. " +
        "Por favor intente de nuevo en unos minutos."
      );
      await telegram.alertOpenaiDown(error);
      await pool.query(
        `UPDATE sessions SET state = 'intake', updated_at = NOW() WHERE id = $1`,
        [this.session.id]
      );
      return;
    }

    await this.whatsapp.sendText(this.phone,
      "Tuve una dificultad leyendo la factura. Voy a intentarlo de nuevo. Un momento..."
    );
  }

  // ===========================================================================
  // Helper: load JSON file
  // ===========================================================================
  _loadJson(filename) {
    const path = join(DATA_DIR, filename);
    try {
      if (existsSync(path)) {
        return JSON.parse(readFileSync(path, "utf-8"));
      }
    } catch (e) {
      console.warn(`⚠️ Could not load ${filename}:`, e.message);
    }
    return null;
  }

  // ===========================================================================
  // Helper: map error type code to name
  // ===========================================================================
  _getErrorTypeName(tipo) {
    const map = {
      A: "upcoding",
      B: "duplication",
      C: "unbundling",
      D: "facility_fees",
      E: "medication_pricing",
      F: "quantity_errors",
      G: "out_of_network",
    };
    return map[tipo] || "unknown";
  }

  // Calculate age from DOB string (YYYY-MM-DD, MM/DD/YYYY, etc.)
  _calculateAge(dob) {
    if (!dob) return 0;
    try {
      const parsed = new Date(dob);
      if (isNaN(parsed.getTime())) return 0;
      const today = new Date();
      let age = today.getFullYear() - parsed.getFullYear();
      const monthDiff = today.getMonth() - parsed.getMonth();
      if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < parsed.getDate())) {
        age--;
      }
      return age >= 0 ? age : 0;
    } catch {
      return 0;
    }
  }
}

export default { AnalyzerAgent };
