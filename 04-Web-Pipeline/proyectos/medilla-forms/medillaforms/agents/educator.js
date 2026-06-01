// =============================================================================
// Educator Agent — FASE 4: Explain errors one by one (post-pago)
// Integrates Firecrawl for live research when local KB lacks data
// =============================================================================

import { pool, appendToConversationLog, buildConversationHistory } from "../middleware/session.js";
import { sanitizeAgentResponse } from "../middleware/legal.js";
import { deepseek } from "../services/deepseek.js";
import { firecrawl } from "../services/firecrawl.js";
import { CloserAgent } from "./closer.js";

export class EducatorAgent {
  constructor(whatsapp, deepseekSvc, firecrawlSvc, session) {
    this.whatsapp = whatsapp;
    this.deepseek = deepseekSvc || deepseek;
    this.firecrawl = firecrawlSvc || firecrawl;
    this.session = session;
    this.phone = session.whatsapp_number;
    this.errorIndex = 0; // Track which error we're explaining
    this.errorsExplained = false;
  }

  // ===========================================================================
  // Start explaining errors
  // ===========================================================================
  async startExplanation() {
    const analysis = this.session.analysis_result || {};
    const errors = analysis.errores_detectados || [];

    if (errors.length === 0) {
      // No errors — go straight to delivery
      const closer = new CloserAgent(this.whatsapp, this.deepseek, null, this.session);
      await closer.deliver();
      return;
    }

    // Explain first error
    await this._explainNextError();
  }

  // ===========================================================================
  // Handle user messages during education phase
  // ===========================================================================
  async handle(text) {
    const textLower = text.toLowerCase();

    // User confirms understanding → next error
    if (this._matches(textLower, ["sí", "si", "ok", "entiendo", "adelante", "sigue", "continue",
                                   "entendido", "claro", "dale", "siguiente", "next", "yes", "go ahead"])) {
      if (this.errorIndex >= this._getErrors().length) {
        // All errors explained → generate letters
        await this._finishEducation();
        return;
      }
      await this._explainNextError();
      return;
    }

    // User asks a question → try to answer it
    const answer = await this._answerQuestion(text);
    if (answer) {
      await this.whatsapp.sendText(this.phone, sanitizeAgentResponse(answer));
      await appendToConversationLog(this.session.id, "assistant", answer);
    } else {
      // Fallback to DeepSeek
      const history = buildConversationHistory(this.session.conversation_log);
      const context = this._buildContext();
      const response = await this.deepseek.chat("educator", history, text, context);
      await this.whatsapp.sendText(this.phone, sanitizeAgentResponse(response));
      await appendToConversationLog(this.session.id, "assistant", response);
    }
  }

  // ===========================================================================
  // Answer user question — try local KB first, then Firecrawl
  // ===========================================================================
  async _answerQuestion(text) {
    // First try Firecrawl if it's a specific medical billing question
    const firecrawlTriggers = [
      "cuánto cuesta", "cuanto cuesta", "cuál es el precio", "cual es el precio",
      "charity care", "asistencia financiera", "financial assistance",
      "política", "politica", "requisito", "income", "ingreso", "FPL",
      "programa", "program", "elegible", "eligible",
    ];

    const shouldSearch = firecrawlTriggers.some((t) => text.toLowerCase().includes(t));

    if (shouldSearch && this.firecrawl.canCall(this.session.id)) {
      const context = {
        hospital_name: this.session.hospital_name || "",
        user_state: this.session.user_state || "",
      };

      await this.whatsapp.sendText(this.phone, "Un momento, déjeme verificar esa información... 🔍");
      await appendToConversationLog(this.session.id, "assistant", "Un momento, déjeme verificar esa información...");

      const result = await this.firecrawl.searchMedicalBillingInfo(text, context);
      this.firecrawl.incrementCallCount(this.session.id);

      if (result) {
        const source = result.url ? `\n\n_(${result.url})_` : "";
        return `${result.data}${source}`;
      }
    }

    return null; // No answer found — fallback to DeepSeek
  }

  // ===========================================================================
  // Explain next error in sequence
  // ===========================================================================
  async _explainNextError() {
    const errors = this._getErrors();

    if (this.errorIndex >= errors.length) {
      await this._finishEducation();
      return;
    }

    const err = errors[this.errorIndex];
    this.errorIndex++;

    const msg = await this._formatError(err, this.errorIndex, errors.length);
    await this.whatsapp.sendText(this.phone, msg);
    await appendToConversationLog(this.session.id, "assistant", msg);
  }

  // ===========================================================================
  // Format error for display
  // ===========================================================================
  async _formatError(err, index, total) {
    const titulo = err.titulo || "Posible error detectado";
    const descripcion = err.descripcion || "";
    const precioFacturado = this._formatCurrency(err.precio_facturado || 0);
    const precioReferencia = this._formatCurrency(err.precio_referencia || 0);
    const ahorroEstimado = this._formatCurrency(err.ahorro_estimado || 0);
    const evidencia = err.evidencia || "";

    let msg =
      `*Error ${index} de ${total}:* ${titulo}\n\n` +
      `En su factura aparece un cargo de *${precioFacturado}* `;

    if (err.item_referencia) {
      msg += `por ${err.item_referencia}. `;
    }

    if (err.precio_referencia > 0) {
      msg += `En situaciones similares, este tipo de servicio suele estar alrededor de *${precioReferencia}*. `;
    }

    if (err.ahorro_estimado > 0) {
      const diff = err.precio_facturado - err.precio_referencia;
      msg += `La diferencia es de aproximadamente *${this._formatCurrency(diff)}*.`;
    }

    if (descripcion) {
      msg += `\n\n${descripcion}`;
    }

    if (evidencia) {
      msg += `\n\n_${evidencia}_`;
    }

    msg += `\n\n¿Tiene sentido? ¿Alguna pregunta sobre este punto?`;

    return msg;
  }

  // ===========================================================================
  // Finish education phase — trigger letter generation
  // ===========================================================================
  async _finishEducation() {
    this.errorsExplained = true;

    const analysis = this.session.analysis_result || {};
    const total = analysis.total_facturado || this.session.total_billed || 0;
    const errorsCount = (analysis.errores_detectados || []).length || this.session.errors_found || 0;
    const savings = analysis.ahorro_total_estimado || this.session.potential_savings || 0;

    let summary =
      `En resumen:\n\n` +
      `📊 Factura total: *${this._formatCurrency(total)}*\n` +
      `🔍 Errores encontrados: *${errorsCount}*\n` +
      `💰 Ahorro potencial estimado: *${this._formatCurrency(savings)}*`;

    // Add charity care if available
    if (analysis.charity_care_info) {
      const cc = analysis.charity_care_info;
      summary += `\n\nAdemás, *${cc.name}* tiene un programa de asistencia financiera para pacientes con ingresos familiares de hasta *${cc.threshold_fpl}*. Le recomiendo preguntar por este programa directamente en el departamento de facturación.`;
    }

    // Add state protections if available
    if (analysis.state_protections) {
      const sp = analysis.state_protections;
      summary += `\n\nEn *${sp.name}*, existen protecciones al paciente que podrían aplicar a su caso. Consulte con el departamento de facturación del hospital.`;
    }

    summary += `\n\nAhora le preparo sus dos cartas. Un momento por favor...`;

    await this.whatsapp.sendText(this.phone, summary);
    await appendToConversationLog(this.session.id, "assistant", summary);

    // Trigger letter generation and delivery via CloserAgent
    const closer = new CloserAgent(this.whatsapp, this.deepseek, null, this.session);
    await closer.deliver();
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================
  _getErrors() {
    const analysis = this.session.analysis_result || {};
    return analysis.errores_detectados || [];
  }

  _formatCurrency(amount) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount);
  }

  _matches(text, keywords) {
    return keywords.some((kw) => text.includes(kw));
  }

  _buildContext() {
    const analysis = this.session.analysis_result || {};
    return {
      hospital_name: this.session.hospital_name || "",
      user_state: this.session.user_state || "",
      total_billed: String(analysis.total_facturado || this.session.total_billed || 0),
      errors_found: String((analysis.errores_detectados || []).length),
      potential_savings: String(analysis.ahorro_total_estimado || this.session.potential_savings || 0),
      charity_care_info: analysis.charity_care_info ? "Sí" : "No disponible",
      state_protections: analysis.state_protections ? "Sí" : "No disponible",
    };
  }
}

export default { EducatorAgent };
