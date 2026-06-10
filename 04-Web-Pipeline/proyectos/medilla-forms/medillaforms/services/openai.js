// =============================================================================
// OpenAI Service — GPT-4o Vision for bill analysis + Whisper for voice notes
// =============================================================================

import OpenAI from "openai";
import { ANALYZER_SYSTEM, ANALYZER_PROMPT } from "../prompts/analyzer_prompt.js";

class OpenAIService {
  constructor() {
    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY || "",
    });
    this.model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  }

  // ---------------------------------------------------------------------------
  // GPT-4o Vision — Analyze medical bill image
  // ---------------------------------------------------------------------------
  async analyzeBill(imageBuffers, cptReference = "", userState = "CA") {
    if (!process.env.OPENAI_API_KEY) {
      console.warn("⚠️ OPENAI_API_KEY not set — returning mock analysis");
      return this._mockAnalysis();
    }

    // Normalize: accept single buffer or array
    const buffers = Array.isArray(imageBuffers) ? imageBuffers : [imageBuffers];
    const totalPages = buffers.length;

    // Build prompt with CPT reference rates and state injected
    const promptWithRates = cptReference
      ? cptReference + "\n\n---\n\n" + ANALYZER_PROMPT
      : ANALYZER_PROMPT;
    const multiPageNote = totalPages > 1
      ? `\n\nFACTURA DE MÚLTIPLES PÁGINAS: Estás viendo ${totalPages} páginas de una misma factura médica. Cada página está etiquetada como "--- PÁGINA X ---". Analiza TODAS las páginas como UN SOLO documento. No asumas que la primera página contiene todos los cargos.`
      : "";
    const promptWithState = promptWithRates + multiPageNote + `\n\nESTADO DEL PACIENTE: ${userState}. Usa las protecciones al consumidor y tarifas de referencia de este estado para tu análisis.`;

    // Build content array: text prompt + all images labeled by page
    const imageContents = buffers.map((buf, i) => [
      { type: "text", text: `--- PÁGINA ${i + 1} de ${totalPages} ---` },
      {
        type: "image_url",
        image_url: {
          url: `data:image/jpeg;base64,${buf.toString("base64")}`,
          detail: "high",
        },
      },
    ]).flat();

    // Dynamic max_tokens: more pages = more output needed
    const outputTokens = Math.min(4000 + (totalPages - 1) * 500, 16000);

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: ANALYZER_SYSTEM },
          {
            role: "user",
            content: [
              { type: "text", text: promptWithState },
              ...imageContents,
            ],
          },
        ],
        max_tokens: outputTokens,
        temperature: 0.1,
        response_format: { type: "json_object" },
      });

      console.log(`🤖 Analyzer analyzed ${totalPages} page(s) — ${outputTokens} max output tokens`);

      const raw = response.choices[0]?.message?.content || "{}";
      console.log(`🤖 Analyzer output: ${raw.length} chars`);

      try {
        return JSON.parse(raw);
      } catch {
        console.error("❌ Failed to parse analyzer JSON:", raw.slice(0, 300));
        return { error: "json_parse_failed" };
      }
    } catch (e) {
      console.error("❌ OpenAI Vision error:", e.message);
      return { error: e.message };
    }
  }

  // ---------------------------------------------------------------------------
  // OpenAI Whisper — Transcribe voice notes
  // ---------------------------------------------------------------------------
  async transcribeAudio(audioBuffer) {
    if (!process.env.OPENAI_API_KEY) {
      console.warn("⚠️ OPENAI_API_KEY not set — cannot transcribe");
      return null;
    }

    try {
      // Convert to a File-like object for Whisper
      const blob = new Blob([audioBuffer], { type: "audio/ogg" });
      const file = new File([blob], "audio.ogg", { type: "audio/ogg" });

      const response = await this.client.audio.transcriptions.create({
        model: "whisper-1",
        file,
        language: "es", // Default Spanish, Whisper auto-detects if wrong
      });

      return response.text || null;
    } catch (e) {
      console.error("❌ Whisper error:", e.message);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Mock analysis for development without API key
  // ---------------------------------------------------------------------------
  _mockAnalysis() {
    return {
      hospital: "Hospital de Ejemplo",
      fecha_servicio: "2026-05-15",
      tipo_servicio: "emergencia",
      estado: "CA",
      factura_id: "INV-2026-0042",
      total_facturado: 4500.0,
      total_paciente_debe: 1200.0,
      total_seguro_pagado: 3300.0,
      confianza_ocr: 92,
      es_factura_medica: true,
      items: [
        { descripcion: "Emergency Dept Visit Level 5", codigo_cpt: "99285", cantidad: 1, precio_unitario: 2500.0, precio_total: 2500.0 },
        { descripcion: "CT Head without contrast", codigo_cpt: "70450", cantidad: 1, precio_unitario: 1200.0, precio_total: 1200.0 },
        { descripcion: "CBC with differential", codigo_cpt: "85025", cantidad: 1, precio_unitario: 300.0, precio_total: 300.0 },
      ],
      errores_detectados: [
        {
          tipo: "A",
          titulo: "Posible upcoding en visita a emergencia",
          descripcion: "La visita a emergencia fue codificada como nivel 5 (99285), pero los síntomas documentados sugieren que un nivel 3 (99283) sería más apropiado.",
          item_referencia: "Emergency Dept Visit Level 5",
          precio_facturado: 2500.0,
          precio_referencia: 800.0,
          ahorro_estimado: 1700.0,
          confianza: 85,
          evidencia: "Según guías CMS, nivel 5 requiere amenaza inmediata a la vida. Dolor abdominal sin complicaciones típicamente es nivel 3.",
        },
      ],
      ahorro_total_estimado: 1700.0,
      severidad: "media",
      hospital_es_nonprofit: true,
      aplica_charity_care: true,
      notas_adicionales: "[MOCK] Esto es un análisis de prueba — configura OPENAI_API_KEY para análisis reales",
    };
  }
}

export const openai = new OpenAIService();
export default { openai };
