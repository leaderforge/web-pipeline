// =============================================================================
// Firecrawl Service — Búsqueda bajo demanda de información médico-facturación
// =============================================================================

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { deepseek } from "./deepseek.js";
import { telegram } from "./telegram.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");

// Trusted domains for medical billing information
const TRUSTED_DOMAINS = [
  "cms.gov", "ssa.gov", "healthcare.gov", "hhs.gov",
  "irs.gov", "consumerfinance.gov", "kff.org",
  "patientadvocate.org", "ncsl.org",
  ".gov", ".org", ".edu",
];

// Per-session Firecrawl call counter (max 2 per session)
const sessionCallCount = new Map();

class FirecrawlService {
  constructor() {
    this.apiKey = process.env.FIRECRAWL_API_KEY || "";
    this.enabled = !!this.apiKey;

    if (!this.enabled) {
      console.warn("⚠️ FIRECRAWL_API_KEY not set — live research disabled");
    }
  }

  // ===========================================================================
  // Main entry point — search for medical billing information
  // ===========================================================================
  async searchMedicalBillingInfo(query, context = {}) {
    // PASO 1 — Check local knowledge base first
    const localResult = this._searchLocalKB(query);
    if (localResult && localResult.confidence > 0.8) {
      console.log(`📚 Local KB hit: ${query.slice(0, 60)}...`);
      return { source: "local", data: localResult };
    }

    // PASO 2 — If Firecrawl is disabled, return null
    if (!this.enabled) {
      console.log(`🔍 Firecrawl disabled — would search: ${query.slice(0, 60)}...`);
      return null;
    }

    // PASO 3 — Build optimized query
    const optimizedQuery = this._buildMedicalQuery(query, context);

    // PASO 4 — Call Firecrawl search
    let results;
    try {
      results = await this._search(optimizedQuery);
      if (!results || results.length === 0) return null;
    } catch (e) {
      console.error("❌ Firecrawl search error:", e.message);
      return null;
    }

    // PASO 5 — Filter by trusted domains
    const filtered = results.filter((r) =>
      TRUSTED_DOMAINS.some((d) => (r.url || "").includes(d))
    );
    if (filtered.length === 0) return null;

    // PASO 6 — Extract relevant data with DeepSeek
    const content = filtered[0].markdown || filtered[0].content || "";
    const extracted = await deepseek.extractData(content, query);
    if (!extracted) return null;

    // PASO 7 — Save to local JSON for future queries
    const dataType = this._classifyDataType(query);
    await this._appendToLocalJson(dataType, {
      query,
      answer: extracted,
      source: filtered[0].url,
      scraped_at: new Date().toISOString(),
      confidence: 0.7,
    });

    // PASO 8 — Notify Daniel via Telegram
    await telegram.notifyNewKnowledge(dataType, query, filtered[0].url, extracted);

    return {
      source: "firecrawl",
      data: extracted,
      url: filtered[0].url,
    };
  }

  // ===========================================================================
  // Search local knowledge base
  // ===========================================================================
  _searchLocalKB(query) {
    const files = [
      { name: "charity_care", file: "charity_care.json" },
      { name: "state_laws", file: "state_laws.json" },
      { name: "cpt_codes", file: "cpt_codes.json" },
      { name: "billing_errors", file: "billing_errors.json" },
      { name: "general", file: "general_knowledge.json" },
    ];

    const queryLower = query.toLowerCase();

    for (const { name, file } of files) {
      const path = join(DATA_DIR, file);
      if (!existsSync(path)) continue;

      try {
        const data = JSON.parse(readFileSync(path, "utf-8"));

        // Search strategy varies by file type
        if (file === "cpt_codes.json") {
          // Search by code or description
          for (const [code, info] of Object.entries(data.codes || {})) {
            if (queryLower.includes(code.toLowerCase()) ||
                (info.description && queryLower.includes(info.description.toLowerCase()))) {
              return {
                data: `${info.description}: Medicare rate ~$${info.medicare_rate}. Hospital price typically 2-3x this rate.`,
                confidence: 0.9,
                source: file,
              };
            }
          }
        }

        if (file === "charity_care.json") {
          // Search by hospital name
          for (const [key, hospital] of Object.entries(data.hospitals || {})) {
            if (queryLower.includes(key) || queryLower.includes(hospital.name.toLowerCase())) {
              return {
                data: `${hospital.name}: ${hospital.program}. Threshold: ${hospital.threshold_fpl} FPL. ${hospital.details} Phone: ${hospital.phone}.`,
                confidence: 0.85,
                source: file,
              };
            }
          }
          // General charity care advice
          if (queryLower.includes("charity care") || queryLower.includes("asistencia financiera")) {
            return {
              data: data.general_advice?.es || data.general_advice?.en || "",
              confidence: 0.9,
              source: file,
            };
          }
        }

        if (file === "state_laws.json") {
          // Search by state
          for (const [abbr, state] of Object.entries(data.states || {})) {
            if (queryLower.includes(abbr.toLowerCase()) ||
                queryLower.includes(state.name.toLowerCase())) {
              // Check if query is about deadlines/expiration
              const isDeadlineQuery = /caduc|plazo|deadline|expir|statute|limitation|venc|prescrip|cuánto tiempo|how long|time limit|años|years|meses|months/i.test(queryLower);
              
              if (isDeadlineQuery && state.dispute_deadlines) {
                const dd = state.dispute_deadlines;
                return {
                  data: `${state.name}:\n` +
                    `- Estatuto de limitación: ${dd.statute_of_limitations}\n` +
                    `- Plazo para facturar: ${dd.billing_deadline}\n` +
                    `- Apelación de seguro: ${dd.insurance_appeal}\n` +
                    `- Charity care: ${dd.charity_care_application}\n` +
                    `- No Surprises Act: ${dd.no_surprises_act_idr}\n` +
                    `- ${dd.important_warning}`,
                  confidence: 0.9,
                  source: file,
                };
              }
              
              return {
                data: `${state.name}: ${state.protections.join("; ")}`,
                confidence: 0.85,
                source: file,
              };
            }
          }
        }
      } catch (e) {
        // File might be malformed — skip
      }
    }

    return null;
  }

  // ===========================================================================
  // Build optimized search query for medical billing context
  // ===========================================================================
  _buildMedicalQuery(query, context) {
    const hospital = context.hospital_name || "";
    const state = context.user_state || "";

    let optimized = query.trim();

    // Add hospital name if present
    if (hospital && !optimized.toLowerCase().includes(hospital.toLowerCase())) {
      optimized = `${hospital} ${optimized}`;
    }

    // Add context keywords for better results
    if (optimized.toLowerCase().includes("charity care") ||
        optimized.toLowerCase().includes("asistencia financiera")) {
      optimized += " financial assistance income threshold FPL eligibility";
    }

    if (optimized.toLowerCase().includes("disput") ||
        optimized.toLowerCase().includes("error") ||
        optimized.toLowerCase().includes("apel")) {
      optimized += " medical billing patient advocacy";
    }

    return optimized;
  }

  // ===========================================================================
  // Call Firecrawl search API
  // ===========================================================================
  async _search(query) {
    const response = await fetch("https://api.firecrawl.dev/v1/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        query,
        limit: 3,
        scrapeOptions: { formats: ["markdown"] },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Firecrawl API error: ${response.status} ${error}`);
    }

    const data = await response.json();
    return data.data || data.results || [];
  }

  // ===========================================================================
  // Classify data type for storage
  // ===========================================================================
  _classifyDataType(query) {
    const lower = query.toLowerCase();
    if (lower.includes("charity care") || lower.includes("financial assist") || lower.includes("asistencia financiera")) {
      return "charity_care";
    }
    if (lower.includes("law") || lower.includes("ley") || lower.includes("protection") || lower.includes("protección")) {
      return "state_law";
    }
    if (lower.includes("cpt") || lower.includes("code") || lower.includes("código") || lower.includes("medicare rate")) {
      return "cpt_code";
    }
    if (lower.includes("error") || lower.includes("billing") || lower.includes("facturación")) {
      return "billing_error";
    }
    return "general";
  }

  // ===========================================================================
  // Append new data to local JSON file
  // ===========================================================================
  async _appendToLocalJson(dataType, entry) {
    const fileMap = {
      charity_care: "charity_care.json",
      state_law: "state_laws.json",
      cpt_code: "cpt_codes.json",
      billing_error: "billing_errors.json",
      general: "general_knowledge.json",
    };

    const filename = fileMap[dataType] || "general_knowledge.json";
    const path = join(DATA_DIR, filename);

    try {
      let data = {};
      if (existsSync(path)) {
        data = JSON.parse(readFileSync(path, "utf-8"));
      }

      // Add new entry under "firecrawl_findings" key
      if (!data.firecrawl_findings) data.firecrawl_findings = [];
      data.firecrawl_findings.push(entry);

      // Keep max 100 entries
      if (data.firecrawl_findings.length > 100) {
        data.firecrawl_findings = data.firecrawl_findings.slice(-100);
      }

      writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
      console.log(`📚 Saved to ${filename}: ${entry.query.slice(0, 60)}...`);
    } catch (e) {
      console.error(`❌ Failed to save to ${filename}:`, e.message);
    }
  }

  // ===========================================================================
  // Track per-session call count
  // ===========================================================================
  canCall(sessionId) {
    const count = sessionCallCount.get(sessionId) || 0;
    return count < 2;
  }

  incrementCallCount(sessionId) {
    const count = (sessionCallCount.get(sessionId) || 0) + 1;
    sessionCallCount.set(sessionId, count);
    return count;
  }
}

export const firecrawl = new FirecrawlService();
export default { firecrawl };
