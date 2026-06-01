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
      // Step 1: GPT-4o Vision analysis
      const result = await this.openai.analyzeBill(imageBuffer);

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

      // Step 5: Save analysis to session
      await pool.query(
        `UPDATE sessions
         SET analysis_result = $2,
             errors_found = $3,
             potential_savings = $4,
             total_billed = $5,
             hospital_name = $6,
             user_state = $7,
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
        ]
      );

      // Update local session object
      this.session.analysis_result = enriched;
      this.session.errors_found = (enriched.errores_detectados || []).length;
      this.session.potential_savings = enriched.ahorro_total_estimado || 0;
      this.session.total_billed = enriched.total_facturado || 0;
      this.session.hospital_name = enriched.hospital || "N/A";
      this.session.user_state = enriched.estado || "CA";

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
}

export default { AnalyzerAgent };
