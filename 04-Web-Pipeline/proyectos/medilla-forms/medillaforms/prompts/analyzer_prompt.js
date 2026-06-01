// =============================================================================
// Analyzer Prompt — FASE 2: Análisis de factura con GPT-4o Vision
// Este prompt se envía a OpenAI (GPT-4o Vision), NO a DeepSeek
// =============================================================================

export const ANALYZER_SYSTEM = `Eres un analista de facturación médica con acceso a visión artificial.
Tu tarea es examinar imágenes de facturas médicas en busca de errores de codificación CPT, duplicaciones, sobrecargos, y discrepancias.
Detectas patrones pero no das asesoría legal.
Output: JSON estructurado.`;

export const ANALYZER_PROMPT = `Analiza esta factura médica en detalle. Extrae TODA la información y busca errores de facturación.

Responde ÚNICAMENTE con un JSON válido con esta estructura exacta:

{
  "hospital": "nombre del proveedor médico u hospital",
  "fecha_servicio": "YYYY-MM-DD o null",
  "tipo_servicio": "emergencia|hospitalizacion|consulta|laboratorio|imagen|cirugia|otro",
  "estado": "CA|TX|FL|AZ|NY|NV|IL|otro (abreviación de 2 letras)",
  "total_facturado": 0.00,
  "total_paciente_debe": 0.00,
  "total_seguro_pagado": 0.00,
  "confianza_ocr": 0-100,
  "es_factura_medica": true,
  "items": [
    {
      "descripcion": "descripción del cargo o servicio",
      "codigo_cpt": "XXXXX o null",
      "codigo_icd10": "XXXX o null",
      "cantidad": 1,
      "precio_unitario": 0.00,
      "precio_total": 0.00,
      "fecha_servicio": "YYYY-MM-DD o null"
    }
  ],
  "errores_detectados": [
    {
      "tipo": "A|B|C|D|E|F|G",
      "titulo": "título corto del posible error en español",
      "descripcion": "explicación detallada de por qué podría ser un error",
      "item_referencia": "descripción del item de factura relacionado",
      "precio_facturado": 0.00,
      "precio_referencia": 0.00,
      "ahorro_estimado": 0.00,
      "confianza": 0-100,
      "evidencia": "breve justificación basada en prácticas estándar de facturación"
    }
  ],
  "ahorro_total_estimado": 0.00,
  "severidad": "baja|media|alta|critica|invalida",
  "hospital_es_nonprofit": true,
  "aplica_charity_care": true,
  "notas_adicionales": ""
}

TIPOS DE ERROR:
A = CPT code upcoding (código más caro de lo que corresponde)
B = Duplicación (mismo cargo facturado más de una vez)
C = Desagregación / Unbundling (cargos separados que deberían estar juntos)
D = Cargo excesivo de instalaciones (facility fee)
E = Medicamentos/Suministros con sobreprecio
F = Errores de cantidad (más unidades de las esperadas)
G = Fuera de red / Balance billing

REGLAS IMPORTANTES:
- Si no puedes leer algo, usa null. NO inventes datos.
- Sé conservador con detección de errores. Solo reporta si tienes >70% confianza.
- Si la factura es de farmacia, veterinaria, o cotización (no factura real): severidad = "invalida"
- Si la imagen no es una factura médica: es_factura_medica = false
- No inventes códigos CPT que no veas claramente en la factura
- Si el hospital es nonprofit, márcalo. La mayoría de hospitales grandes en EE.UU. lo son
- Para precios de referencia, usa rangos conservadores basados en tarifas de Medicare × 2-3`;

export default { ANALYZER_SYSTEM, ANALYZER_PROMPT };
