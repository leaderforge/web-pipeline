// =============================================================================
// DeepSeek Service — Conversational AI for Hermes agent
// Using DeepSeek v4-pro via OpenAI-compatible API
// v2: Added reviewer layer (CAPA 3) — legal + human quality review
// =============================================================================

import OpenAI from "openai";
import { BASE_PERSONA } from "../prompts/base_persona.js";
import { LEGAL_GUARDRAILS } from "../prompts/legal_guardrails.js";
import { INTAKE_PROMPT } from "../prompts/intake_prompt.js";
import { EDUCATOR_PROMPT } from "../prompts/educator_prompt.js";
import { CLOSER_HOOK_PROMPT, CLOSER_DELIVERY_PROMPT } from "../prompts/closer_prompt.js";
import { REVIEWER_PROMPT } from "../prompts/reviewer_prompt.js";

class DeepSeekService {
  constructor() {
    this.client = new OpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY || "",
      baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    });
    this.model = "deepseek-chat"; // v4-pro
    this.reviewEnabled = true; // CAPA 3: Reviewer activo por defecto
  }

  // ---------------------------------------------------------------------------
  // Build system prompt with all layers
  // ---------------------------------------------------------------------------
  _buildSystemPrompt(phase, context = {}) {
    const layers = [BASE_PERSONA, LEGAL_GUARDRAILS];

    // Add phase-specific prompt
    switch (phase) {
      case "intake":
        layers.push(this._fillTemplate(INTAKE_PROMPT, context));
        break;
      case "educator":
        layers.push(this._fillTemplate(EDUCATOR_PROMPT, context));
        break;
      case "closer_hook":
        layers.push(this._fillTemplate(CLOSER_HOOK_PROMPT, context));
        break;
      case "closer_delivery":
        layers.push(this._fillTemplate(CLOSER_DELIVERY_PROMPT, context));
        break;
      default:
        break;
    }

    return layers.join("\n\n---\n\n");
  }

  _fillTemplate(template, context) {
    let filled = template;
    for (const [key, value] of Object.entries(context)) {
      filled = filled.replace(new RegExp(`\\{${key}\\}`, "g"), String(value ?? ""));
    }
    return filled;
  }

  // ---------------------------------------------------------------------------
  // Send message to DeepSeek and get response (WITH reviewer)
  // ---------------------------------------------------------------------------
  async chat(phase, history, userMessage, sessionContext = {}) {
    if (!process.env.DEEPSEEK_API_KEY) {
      console.warn("⚠️ DEEPSEEK_API_KEY not set — returning mock response");
      return this._mockResponse(phase, userMessage);
    }

    const systemPrompt = this._buildSystemPrompt(phase, sessionContext);

    const messages = [
      { role: "system", content: systemPrompt },
      ...history.slice(-30), // Last 30 messages for context
      { role: "user", content: userMessage },
    ];

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages,
        max_tokens: 600, // ⬆️ Subido de 400 para respuestas más humanas
        temperature: 0.75, // ⬆️ Subido de 0.7 para más variación natural
        presence_penalty: 0.15,
      });

      const draft = response.choices[0]?.message?.content || "";
      console.log(`🧠 DeepSeek (${phase}): ${draft.slice(0, 80)}...`);

      // ── CAPA 3: Reviewer ──────────────────────────────────────────
      if (this.reviewEnabled && phase !== "analyzer") {
        const reviewed = await this._reviewResponse(phase, userMessage, draft, sessionContext);
        return reviewed;
      }

      return draft;
    } catch (e) {
      console.error("❌ DeepSeek error:", e.message);
      // Fallback to simple responses
      return this._fallbackResponse(phase);
    }
  }

  // ---------------------------------------------------------------------------
  // CAPA 3 — Reviewer: Legal + Human Quality check
  // ---------------------------------------------------------------------------
  async _reviewResponse(phase, userMessage, draft, context = {}) {
    try {
      const reviewMessages = [
        { role: "system", content: REVIEWER_PROMPT },
        {
          role: "user",
          content: [
            `FASE: ${phase}`,
            `CONTEXTO: hospital=${context.hospital_name || "N/A"}, estado=${context.user_state || "N/A"}`,
            ``,
            `MENSAJE DEL USUARIO:`,
            `"${userMessage}"`,
            ``,
            `RESPUESTA PROPUESTA POR EL AGENTE:`,
            `"${draft}"`,
            ``,
            `Evalúa la respuesta según los criterios del revisor.`,
            `Responde ÚNICAMENTE con JSON: {"accion": "aprobar"|"corregir"|"reescribir", "respuesta_final": "...", "problemas": [...], "nota_interna": "..."}`,
          ].join("\n"),
        },
      ];

      const reviewResponse = await this.client.chat.completions.create({
        model: this.model,
        messages: reviewMessages,
        max_tokens: 500,
        temperature: 0.3, // Determinista para revisión legal
        response_format: { type: "json_object" },
      });

      const raw = reviewResponse.choices[0]?.message?.content || "{}";
      let result;
      try {
        result = JSON.parse(raw);
      } catch {
        // Si el JSON no es válido, usar la respuesta original como fallback seguro
        console.warn("⚠️ Reviewer returned invalid JSON — using draft as-is");
        return draft;
      }

      const action = result.accion || "aprobar";
      const final = result.respuesta_final || draft;

      if (action === "aprobar") {
        console.log(`✅ Reviewer: APROBADO — ${result.nota_interna || "sin problemas"}`);
        return final;
      }

      if (action === "corregir") {
        const problems = (result.problemas || []).join(", ");
        console.log(`🔧 Reviewer: CORREGIDO — ${problems}`);
        return final;
      }

      if (action === "reescribir") {
        const problems = (result.problemas || []).join(", ");
        console.warn(`🚨 Reviewer: REESCRITO (riesgo legal) — ${problems}`);
        console.warn(`   Original: ${draft.slice(0, 100)}`);
        console.warn(`   Nueva:    ${final.slice(0, 100)}`);
        return final;
      }

      return final;
    } catch (e) {
      console.error("❌ Reviewer error:", e.message);
      // Si el revisor falla, devolver el draft — mejor que no responder
      return draft;
    }
  }

  // ---------------------------------------------------------------------------
  // Extract specific data from text (used by Firecrawl results)
  // ---------------------------------------------------------------------------
  async extractData(content, question) {
    if (!process.env.DEEPSEEK_API_KEY) return null;

    const systemPrompt = `Eres un asistente que extrae datos específicos de documentos.
Responde ÚNICAMENTE con el dato solicitado. Máximo 3 oraciones.
Si la información no está clara en el texto, responde "null".`;

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `TEXTO FUENTE:\n${content.slice(0, 3000)}\n\nPREGUNTA: ${question}\n\nExtrae solo el dato que responde la pregunta:`,
          },
        ],
        max_tokens: 150,
        temperature: 0.2,
      });

      const result = response.choices[0]?.message?.content || "";
      return result === "null" ? null : result;
    } catch (e) {
      console.error("❌ DeepSeek extract error:", e.message);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Fallback responses when API is unavailable
  // ---------------------------------------------------------------------------
  _fallbackResponse(phase) {
    const fallbacks = {
      intake: "Disculpe, estoy teniendo dificultades técnicas. ¿Podría intentarlo de nuevo en un momento?",
      educator: "Un momento, estoy procesando la información. ¿Podría intentarlo de nuevo?",
      closer_hook: "Disculpe la interrupción. ¿Podría intentarlo de nuevo en unos segundos?",
      closer_delivery: "Disculpe, estoy teniendo un problema técnico. Sus cartas están siendo procesadas.",
    };
    return fallbacks[phase] || fallbacks.intake;
  }

  _mockResponse(phase, userMessage) {
    if (phase === "intake") {
      if (userMessage.toLowerCase().includes("factura") || userMessage.toLowerCase().includes("hospital")) {
        return "Entiendo que tiene una factura médica. ¿Cuántas páginas o fotografías tiene? Cuando guste, puede enviármelas y las analizo para usted.";
      }
      return "¡Buenas! Bienvenido a MedillaForms. Soy Hermes, su asistente de análisis de facturas médicas.\n\nImportante: somos un servicio educativo. No somos abogados y no proporcionamos asesoría legal.\n\n¿En qué le puedo ayudar hoy?";
    }
    if (phase === "educator") {
      return "Entiendo. ¿Tiene alguna pregunta sobre este punto? Cuando esté listo, continuamos con el siguiente.";
    }
    return "Estoy aquí para ayudarle. ¿En qué puedo asistirle?";
  }
}

export const deepseek = new DeepSeekService();
export default { deepseek };
