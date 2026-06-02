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
  async analyzeBill(imageBuffer, cptReference = "") {
    if (!process.env.OPENAI_API_KEY) {
      console.warn("⚠️ OPENAI_API_KEY not set — returning mock analysis");
      return this._mockAnalysis();
    }

    const base64 = imageBuffer.toString("base64");

    // Build prompt with CPT reference rates injected
    const promptWithRates = cptReference
      ? cptReference + "\n\n---\n\n" + ANALYZER_PROMPT
      : ANALYZER_PROMPT;

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: ANALYZER_SYSTEM },
          {
            role: "user",
            content: [
              { type: "text", text: promptWithRates },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${base64}`,
                  detail: "high",
                },
              },
            ],
          },
        ],
        max_tokens: 4000,
        temperature: 0.1,
        response_format: { type: "json_object" },
      });

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
