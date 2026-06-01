// =============================================================================
// DeepSeek Service — Conversational AI for Hermes agent
// Using DeepSeek v4-pro via OpenAI-compatible API
// =============================================================================

import OpenAI from "openai";
import { BASE_PERSONA } from "../prompts/base_persona.js";
import { LEGAL_GUARDRAILS } from "../prompts/legal_guardrails.js";
import { INTAKE_PROMPT } from "../prompts/intake_prompt.js";
import { EDUCATOR_PROMPT } from "../prompts/educator_prompt.js";
import { CLOSER_HOOK_PROMPT, CLOSER_DELIVERY_PROMPT } from "../prompts/closer_prompt.js";

class DeepSeekService {
  constructor() {
    this.client = new OpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY || "",
      baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    });
    this.model = "deepseek-chat"; // v4-pro
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
  // Send message to DeepSeek and get response
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
        max_tokens: 400,
        temperature: 0.7,
        presence_penalty: 0.1,
      });

      const content = response.choices[0]?.message?.content || "";
      console.log(`🧠 DeepSeek (${phase}): ${content.slice(0, 80)}...`);

      return content;
    } catch (e) {
      console.error("❌ DeepSeek error:", e.message);
      // Fallback to simple responses
      return this._fallbackResponse(phase);
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
