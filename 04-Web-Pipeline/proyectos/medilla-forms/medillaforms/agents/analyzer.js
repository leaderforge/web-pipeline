// =============================================================================
// Analyzer Agent — FASE 2: OCR + Cross-reference + Build report
// =============================================================================

import { pool, appendToConversationLog } from "../middleware/session.js";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { openai } from "../services/openai.js";
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
  async analyze(imageBuffer) {
    // Mark session as analyzing
    await pool.query(
      `UPDATE sessions SET state = 'analyzing', updated_at = NOW() WHERE id = $1`,
      [this.session.id]
    );

    try {
      // Build CPT reference lookup for the AI
      const cptRef = this._buildCptReference();

      // Step 1: GPT-4o Vision analysis — include user's state for better reference pricing
      const userState = this.session.user_state || "CA";
      const result = await this.openai.analyzeBill(imageBuffer, cptRef, userState);

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
      enriched.errores_detectados = enriched.errores_detectados.map((err) => ({
        ...err,
        tipo_descripcion: billingErrors?.error_types?.[`${err.tipo}_${this._getErrorTypeName(err.tipo)}`]?.name || err.tipo,
      }));
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
  // ===========================================================================
  async handleInvoiceResponse(text) {
    const trimmed = text.trim();

    // Validate it looks like an invoice/account number (alphanumeric, 4-30 chars)
    const looksLikeInvoice = /^[A-Za-z0-9\-_#]{4,30}$/.test(trimmed);

    if (!looksLikeInvoice) {
      await this.whatsapp.sendText(this.phone,
        "Eso no parece un número de factura. Revise su factura original y busque algo como:\n\n" +
        "• *Invoice #:* INV-2025-0042\n" +
        "• *Account #:* 12345678\n" +
        "• *Bill #:* B-9876543\n\n" +
        "Generalmente está en la esquina superior derecha. ¿Podría intentarlo de nuevo?"
      );
      return;
    }

    // Save invoice ID to session
    const facturaId = trimmed.toUpperCase();
    await pool.query(
      `UPDATE sessions 
       SET factura_id = $2, state = 'analyzed', updated_at = NOW() 
       WHERE id = $1`,
      [this.session.id, facturaId]
    );
    this.session.factura_id = facturaId;
    this.session.state = "analyzed";

    // Also update analysis_result with factura_id
    const analysis = this.session.analysis_result || {};
    analysis.factura_id = facturaId;
    await pool.query(
      `UPDATE sessions SET analysis_result = $2 WHERE id = $1`,
      [this.session.id, JSON.stringify(analysis)]
    );
    this.session.analysis_result = analysis;

    await this.whatsapp.sendText(this.phone, `¡Perfecto! Número de factura *${facturaId}* registrado. ✅\n\nAhora continúo con el análisis...`);
    await appendToConversationLog(this.session.id, "user", text);
    await appendToConversationLog(this.session.id, "assistant", `Invoice received: ${facturaId}`);

    // Continue to hook (FASE 3)
    const { HermesAgent } = await import("./hermes.js");
    const hermes = new HermesAgent(this.whatsapp, null, this.session);
    await hermes.presentHook();
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
