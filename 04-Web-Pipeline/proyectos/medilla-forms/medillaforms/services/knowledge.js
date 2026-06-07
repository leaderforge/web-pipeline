// =============================================================================
// Knowledge Base Service — Local KB loader for billing questions
// Injects state laws, charity care, billing rules, and deadlines into every
// DeepSeek call to prevent generic/sezgada responses.
// =============================================================================

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "..", "data");

// Cache — loaded once on first use
let _stateLaws = null;
let _charityCare = null;
let _billingErrors = null;
let _cptCodes = null;
let _legalGuardrails = null;
let _faq = null;

function loadJSON(filename) {
  const p = path.join(DATA_DIR, filename);
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (e) {
    console.warn(`⚠️ KB: Could not load ${filename}: ${e.message}`);
    return null;
  }
}

function getStateLaws() {
  if (!_stateLaws) _stateLaws = loadJSON("state_laws.json");
  return _stateLaws;
}

function getCharityCare() {
  if (!_charityCare) _charityCare = loadJSON("charity_care.json");
  return _charityCare;
}

function getBillingErrors() {
  if (!_billingErrors) _billingErrors = loadJSON("billing_errors.json");
  return _billingErrors;
}

function getCPTCodes() {
  if (!_cptCodes) _cptCodes = loadJSON("cpt_codes.json");
  return _cptCodes;
}

function getLegalGuardrails() {
  if (!_legalGuardrails) _legalGuardrails = loadJSON("legal_guardrails.json");
  return _legalGuardrails;
}

function getFAQ() {
  if (!_faq) _faq = loadJSON("faq.json");
  return _faq;
}

// =============================================================================
// FAQ topic keywords and matching
// =============================================================================
const FAQ_KEYWORDS = [
  "tipo", "tipos", "factura", "facturas", "analizan", "analizar", "revisan",
  "cubren", "aplican", "aplica", "cuentas", "cobros", "gastos",
  "bill", "bills", "medical", "médicas", "medicas", "hospital",
  "hospitalarias", "clínica", "clinica", "doctor", "médico", "medico",
  "especialista", "dentista", "dental", "ambulancia", "emergencia",
  "urgencia", "laboratorio", "radiología", "radiologia", "cirugía",
  "cirugia", "receta", "medicamento", "farmacia", "qué facturas",
  "que facturas", "cuáles facturas", "cuales facturas",
  "estado", "estados", "cubre", "disponible", "dónde", "donde",
  "ubicación", "ubicacion", "operan", "funciona en", "sirve en",
  "gratis", "gratuito", "cobran", "cobra", "precio", "cuesta",
  "costo", "pago", "pagar", "tarifa", "free", "cost", "price",
  "tarda", "tardan", "demora", "tiempo", "cuánto", "cuanto",
  "rápido", "rapido", "entrega", "entregar", "cómo funciona",
  "como funciona", "proceso", "pasos", "funciona", "explicar",
  "garantía", "garantia", "garantizan", "garantizado", "aseguran",
  "reembolso", "refund", "devolución", "devolucion",
];

function searchFAQ(question) {
  const lower = question.toLowerCase();
  const faq = getFAQ();
  if (!faq || !faq.topics) return null;

  // Score each topic by keyword overlap
  let bestMatch = null;
  let bestScore = 0;

  for (const [topicKey, topic] of Object.entries(faq.topics)) {
    let score = 0;
    for (const kw of topic.keywords) {
      if (lower.includes(kw.toLowerCase())) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = topic;
    }
  }

  // Require at least 2 keyword matches for confidence
  if (bestScore >= 2 && bestMatch) {
    let result = `## ${bestMatch.question}\n${bestMatch.answer}`;
    if (bestMatch.what_we_dont) {
      result += `\n\n⚠️ ${bestMatch.what_we_dont}`;
    }
    return result;
  }

  return null;
}

// =============================================================================
// State abbreviations map (for detecting state mentions)
// =============================================================================
const STATE_ABBREV = {
  "al": "AL", "ak": "AK", "az": "AZ", "ar": "AR", "ca": "CA", "co": "CO", "ct": "CT",
  "de": "DE", "fl": "FL", "ga": "GA", "hi": "HI", "id": "ID", "il": "IL", "in": "IN",
  "ia": "IA", "ks": "KS", "ky": "KY", "la": "LA", "me": "ME", "md": "MD", "ma": "MA",
  "mi": "MI", "mn": "MN", "ms": "MS", "mo": "MO", "mt": "MT", "ne": "NE", "nv": "NV",
  "nh": "NH", "nj": "NJ", "nm": "NM", "ny": "NY", "nc": "NC", "nd": "ND", "oh": "OH",
  "ok": "OK", "or": "OR", "pa": "PA", "ri": "RI", "sc": "SC", "sd": "SD", "tn": "TN",
  "tx": "TX", "ut": "UT", "vt": "VT", "va": "VA", "wa": "WA", "wv": "WV", "wi": "WI",
  "wy": "WY", "dc": "DC",
};

const STATE_NAMES = {
  "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR",
  "california": "CA", "colorado": "CO", "connecticut": "CT", "delaware": "DE",
  "florida": "FL", "georgia": "GA", "hawaii": "HI", "idaho": "ID", "illinois": "IL",
  "indiana": "IN", "iowa": "IA", "kansas": "KS", "kentucky": "KY", "louisiana": "LA",
  "maine": "ME", "maryland": "MD", "massachusetts": "MA", "michigan": "MI",
  "minnesota": "MN", "mississippi": "MS", "missouri": "MO", "montana": "MT",
  "nebraska": "NE", "nevada": "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND",
  "ohio": "OH", "oklahoma": "OK", "oregon": "OR", "pennsylvania": "PA",
  "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
  "tennessee": "TN", "texas": "TX", "utah": "UT", "vermont": "VT", "virginia": "VA",
  "washington": "WA", "west virginia": "WV", "wisconsin": "WI", "wyoming": "WY",
};

// =============================================================================
// TOPIC DETECTORS — what kind of question is this?
// =============================================================================
const DEADLINE_KEYWORDS = [
  "plazo", "plazos", "días", "dias", "día", "dia", "semanas", "mes", "meses",
  "año", "años", "tiempo", "tarda", "tardan", "demora", "demoran",
  "deadline", "days", "weeks", "months", "year", "timeline",
  "estatuto", "statute", "limitación", "limitation", "prescribe", "prescripción",
  "vence", "vencimiento", "caduca", "caducidad",
];

const CHARITY_KEYWORDS = [
  "charity", "caridad", "asistencia financiera", "financial assistance",
  "descuento", "discount", "income", "ingreso", "ingresos", "FPL",
  "programa", "program", "elegible", "eligible", "califico", "calificar",
  "sin seguro", "uninsured", "sin cobertura", "no tengo seguro",
  "hospital público", "nonprofit", "non-profit", "sin fines de lucro",
];

const CPT_KEYWORDS = [
  "cpt", "código", "codigo", "code", "códigos", "codigos",
  "medicare", "precio", "price", "costo", "cost", "tarifa", "rate",
  "facturaron", "cobraron", "cargo", "cargos", "duplicado", "duplicate",
  "upcoding", "desagregación", "unbundling",
];

const STATE_PROTECTION_KEYWORDS = [
  "protección", "proteccion", "protection", "derecho", "rights", "ley", "law",
  "estatal", "state", "regulación", "regulation", "norma", "agencia", "agency",
  "queja", "complaint", "reportar", "report", "balance billing",
  "sorpresa", "surprise", "emergencia", "emergency",
];

// =============================================================================
// detectState — find which state the question is about
// =============================================================================
function detectState(text, sessionState) {
  const lower = text.toLowerCase();

  // 1. Check if session has a state
  if (sessionState && STATE_ABBREV[sessionState.toLowerCase()]) {
    return STATE_ABBREV[sessionState.toLowerCase()];
  }

  // 2. Check for state abbreviation in text
  for (const [abbr, code] of Object.entries(STATE_ABBREV)) {
    const pattern = new RegExp(`\\b${abbr}\\b`, "i");
    if (pattern.test(text)) return code;
  }

  // 3. Check for full state names
  for (const [name, code] of Object.entries(STATE_NAMES)) {
    if (lower.includes(name)) return code;
  }

  return null;
}

// =============================================================================
// topicMatches — check if text matches topic keywords
// =============================================================================
function topicMatches(text, keywords) {
  const lower = text.toLowerCase();
  return keywords.some(kw => lower.includes(kw));
}

// =============================================================================
// MAIN — searchKnowledge(question, context) → relevant KB excerpts
// context: { state, hospital_name, patient_name, errors_found }
// =============================================================================
export function searchKnowledge(question, context = {}) {
  const excerpts = [];
  const sessionState = context.state || context.user_state || "";
  const hospitalName = context.hospital_name || "";

  // ═══ DETECT STATE ═══
  const stateCode = detectState(question, sessionState);

  // ═══ STATE LAWS ═══
  if (stateCode) {
    const laws = getStateLaws();
    if (laws && laws.states && laws.states[stateCode]) {
      const st = laws.states[stateCode];
      excerpts.push(`## Leyes y protecciones en ${st.name} (${stateCode})`);

      if (st.protections && st.protections.length > 0) {
        excerpts.push("**Protecciones al paciente:**");
        st.protections.forEach(p => excerpts.push(`- ${p}`));
      }

      if (topicMatches(question, DEADLINE_KEYWORDS)) {
        excerpts.push("\n**Plazos y fechas límite:**");
        if (st.dispute_deadlines) {
          const dd = st.dispute_deadlines;
          if (dd.statute_of_limitations) excerpts.push(`- Estatuto de limitaciones: ${dd.statute_of_limitations}`);
          if (dd.billing_deadline) excerpts.push(`- Plazo de facturación: ${dd.billing_deadline}`);
          if (dd.insurance_appeal) excerpts.push(`- Apelación de seguro: ${dd.insurance_appeal}`);
          if (dd.hospital_response) excerpts.push(`- Respuesta del hospital: ${dd.hospital_response}`);
          if (dd.collection_agency) excerpts.push(`- Agencias de cobranza: ${dd.collection_agency}`);
          if (dd.dispute_window) excerpts.push(`- Ventana de disputa: ${dd.dispute_window}`);
          if (dd.refund_timeline) excerpts.push(`- Plazo de reembolso: ${dd.refund_timeline}`);
        }
      }

      if (st.charity_care_threshold) {
        excerpts.push(`\n**Umbral de Charity Care:** ${st.charity_care_threshold}`);
      }
      if (st.key_agency) {
        excerpts.push(`**Agencia estatal clave:** ${st.key_agency}`);
      }
      if (st.complaint_url && topicMatches(question, STATE_PROTECTION_KEYWORDS)) {
        excerpts.push(`**Quejas/Reportes:** ${st.complaint_url}`);
      }
    }
  }

  // ═══ CHARITY CARE ═══
  if (topicMatches(question, CHARITY_KEYWORDS) || (hospitalName && topicMatches(question, ["hospital", "programa", "descuento", "asistencia"]))) {
    const cc = getCharityCare();
    if (cc && cc.hospitals) {
      // Try to match hospital by name
      let hospitalData = null;
      const lowerHospital = hospitalName.toLowerCase();
      for (const [key, data] of Object.entries(cc.hospitals)) {
        if (key && lowerHospital.includes(key.toLowerCase())) {
          hospitalData = data;
          break;
        }
      }

      if (hospitalData) {
        excerpts.push(`\n## Asistencia Financiera — ${hospitalData.name || hospitalName}`);
        if (hospitalData.details) excerpts.push(`- ${hospitalData.details}`);
        if (hospitalData.how_to_apply) excerpts.push(`- Cómo aplicar: ${hospitalData.how_to_apply}`);
        if (hospitalData.url) excerpts.push(`- Más información: ${hospitalData.url}`);

        // Add general charity care primer if relevant
        if (cc._charity_care_primer) {
          excerpts.push(`\n**Sobre Charity Care (ley federal IRS 501r):**`);
          if (cc._charity_care_primer.what_it_is) excerpts.push(`- ${cc._charity_care_primer.what_it_is}`);
          if (cc._charity_care_primer.who_qualifies) excerpts.push(`- ${cc._charity_care_primer.who_qualifies}`);
          if (cc._charity_care_primer.how_to_apply) excerpts.push(`- ${cc._charity_care_primer.how_to_apply}`);
        }
      } else if (cc._charity_care_primer) {
        excerpts.push(`\n## Asistencia Financiera Hospitalaria (Charity Care)`);
        const primer = cc._charity_care_primer;
        if (primer.what_it_is) excerpts.push(`- ${primer.what_it_is}`);
        if (primer.who_qualifies) excerpts.push(`- ${primer.who_qualifies}`);
        if (primer.how_to_apply) excerpts.push(`- ${primer.how_to_apply}`);
        if (primer.legal_basis) excerpts.push(`- Base legal: ${primer.legal_basis}`);
      }
    }
  }

  // ═══ BILLING ERRORS ═══
  if (topicMatches(question, CPT_KEYWORDS) || topicMatches(question, ["error", "errores", "facturación", "billing", "duplicado", "upcoding"])) {
    const be = getBillingErrors();
    if (be && be.errors) {
      excerpts.push(`\n## Errores comunes de facturación médica`);
      be.errors.slice(0, 5).forEach(err => {
        excerpts.push(`- **${err.name || err.type}:** ${(err.description || "").slice(0, 200)}`);
      });
    }
  }

  // ═══ CPT CODES ═══
  if (topicMatches(question, ["cpt", "código", "codigo", "precio medicare", "medicare rate"])) {
    const cpt = getCPTCodes();
    if (cpt) {
      // Try to find specific CPT codes mentioned in the question
      const codeMatch = question.match(/\b(\d{5})\b/g);
      if (codeMatch && cpt.codes) {
        codeMatch.forEach(code => {
          const info = cpt.codes[code];
          if (info) {
            excerpts.push(`\n## CPT ${code}`);
            if (info.description) excerpts.push(`- Descripción: ${info.description}`);
            if (info.medicare_rate) excerpts.push(`- Tarifa Medicare: ${info.medicare_rate}`);
            if (info.typical_hospital_range) excerpts.push(`- Rango típico hospital: ${info.typical_hospital_range}`);
            if (info.notes) excerpts.push(`- Notas: ${info.notes}`);
          }
        });
      }
    }
  }

  // ═══ LEGAL GUARDRAILS ═══
  const guardrails = getLegalGuardrails();
  if (guardrails && guardrails.disclaimers) {
    excerpts.push(`\n## Recordatorio legal importante`);
    if (guardrails.disclaimers.educational) excerpts.push(`- ${guardrails.disclaimers.educational}`);
    if (guardrails.disclaimers.not_legal_advice) excerpts.push(`- ${guardrails.disclaimers.not_legal_advice}`);
    if (guardrails.disclaimers.no_guarantee) excerpts.push(`- ${guardrails.disclaimers.no_guarantee}`);
  }

  // ═══ FAQ — Pre-sales questions ═══
  // Only include FAQ if no other KB sections matched (avoids mixing FAQ with billing data)
  if (excerpts.length === 0) {
    const faqAnswer = searchFAQ(question);
    if (faqAnswer) {
      excerpts.push(faqAnswer);
    }
  }

  return excerpts.length > 0 ? excerpts.join("\n") : null;
}

// =============================================================================
// getKBContext — convenience wrapper for adding KB to DeepSeek prompts
// Returns a string ready to be appended to the system prompt
// =============================================================================
export function getKBContext(question, context = {}) {
  const kb = searchKnowledge(question, context);
  if (!kb) return "";

  return `\n\n📚 BASE DE CONOCIMIENTO LOCAL (DATOS OBJETIVOS — USA ESTOS DATOS, NO LOS INVENTES):\n${kb}\n\n⚠️ Reglas al usar estos datos:\n- Cítalos como HECHOS, no como consejos.\n- Si los datos cubren la pregunta, responde con ellos.\n- Si los datos NO cubren la pregunta, di "Esa información específica no la tengo en mi base de conocimiento".\n- NUNCA inventes plazos, fechas, ni procedimientos.`;
}

export { searchFAQ };

export default { searchKnowledge, getKBContext, searchFAQ };
