// =============================================================================
// Legal Guardrail Middleware
// Scans EVERY user message before it reaches the agent.
// Blocks or redirects if legal boundaries are crossed.
// =============================================================================

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load guardrails from JSON
let guardrails;
try {
  const path = join(__dirname, "..", "data", "legal_guardrails.json");
  guardrails = JSON.parse(readFileSync(path, "utf-8"));
} catch {
  // Fallback in-memory guardrails if file not found
  guardrails = {
    blocked_phrases: {
      lawsuit: {
        trigger: ["demanda", "demandar", "corte", "juez", "tribunal", "ilegal"],
        response_es:
          "Eso está fuera del alcance de MedillaForms como servicio educativo. Le recomiendo consultar con un abogado especializado en salud en {state}. ¿Hay algo más sobre su factura en lo que pueda ayudarle?",
      },
      legal_advice: {
        trigger: ["abogado", "legalmente", "asesoría legal"],
        response_es:
          "MedillaForms es un servicio educativo, no un despacho de abogados. Para asesoría legal específica, le recomiendo consultar con un abogado licenciado en {state}.",
      },
    },
  };
}

// Track how many times a user has hit legal guardrails (per session)
const legalHitCount = new Map();

/**
 * Enforce legal guardrails on user message.
 * Returns { blocked: true, response: "..." } if message should be blocked.
 * Returns { blocked: false } if message is OK to process.
 */
export function enforceGuardrails(text, session) {
  if (!text) return { blocked: false };

  const textLower = text.toLowerCase();
  const userState = session?.user_state || "su estado";

  for (const [category, config] of Object.entries(guardrails.blocked_phrases)) {
    const triggers = config.trigger || [];
    const hit = triggers.some((t) => textLower.includes(t.toLowerCase()));

    if (hit) {
      // Track hit count per session
      const sessionId = session?.id || "unknown";
      const hits = (legalHitCount.get(sessionId) || 0) + 1;
      legalHitCount.set(sessionId, hits);

      // Get response in user's language (default Spanish)
      const responseKey = session?.lang === "en" ? "response_en" : "response_es";
      let response = config[responseKey] || config.response_es || "";

      // Replace state placeholder
      response = response.replace("{state}", userState);

      // If user insists 3+ times on same legal topic
      if (hits >= 3) {
        response =
          "Entiendo su preocupación, pero como servicio educativo no puedo profundizar en ese tema. ¿Hay algo sobre los cargos de su factura en lo que pueda ayudarle?";
      }

      return { blocked: true, response, category, hitCount: hits };
    }
  }

  // Check prohibited statements — if the USER is asking us to say these things
  const prohibited = guardrails.prohibited_statements || [];
  for (const phrase of prohibited) {
    if (textLower.includes(phrase.toLowerCase())) {
      const response =
        "No puedo hacer esa afirmación. MedillaForms es un servicio educativo que proporciona información basada en datos públicos de facturación médica. ¿Puedo ayudarle de otra manera con su factura?";
      return { blocked: true, response, category: "prohibited_statement" };
    }
  }

  return { blocked: false };
}

/**
 * Check if an agent-generated response contains prohibited statements.
 * Returns the cleaned response, or the original if clean.
 */
export function sanitizeAgentResponse(text) {
  if (!text) return text;

  const prohibited = guardrails.prohibited_statements || [];
  let cleaned = text;

  for (const phrase of prohibited) {
    if (cleaned.toLowerCase().includes(phrase.toLowerCase())) {
      // Replace with safe alternative
      cleaned = cleaned.replace(
        new RegExp(phrase, "gi"),
        "[información basada en datos públicos]"
      );
    }
  }

  return cleaned;
}

/**
 * Get the required disclaimer for first message.
 */
export function getFirstMessageDisclaimer(lang = "es") {
  const disclaimers = guardrails.required_disclaimers || {};
  if (lang === "en") return disclaimers.first_message_en || "";
  return disclaimers.first_message_es || "";
}

/**
 * Get the letter footer disclaimer.
 */
export function getLetterFooterDisclaimer(lang = "es") {
  const disclaimers = guardrails.required_disclaimers || {};
  if (lang === "en") return disclaimers.letter_footer_en || "";
  return disclaimers.letter_footer_es || "";
}

export default { enforceGuardrails, sanitizeAgentResponse, getFirstMessageDisclaimer, getLetterFooterDisclaimer };
