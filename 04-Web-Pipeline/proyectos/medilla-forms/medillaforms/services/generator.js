// =============================================================================
// Letter Generator — HTML → PNG via Playwright
// Generates TWO dispute letters per processing:
//   carta-es.png (Spanish — for the client)
//   carta-en.png (English — for the hospital/provider)
// =============================================================================

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { getLetterFooterDisclaimer } from "../middleware/legal.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(__dirname, "..", "templates");

// =============================================================================
// Load HTML template
// =============================================================================
function loadTemplate(lang) {
  const path = join(TEMPLATE_DIR, `carta-${lang}.html`);
  try {
    return readFileSync(path, "utf-8");
  } catch {
    console.error(`❌ Template not found: ${path}`);
    return null;
  }
}

// =============================================================================
// Format currency
// =============================================================================
function formatCurrency(amount) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount || 0);
}

// =============================================================================
// Format date for display
// =============================================================================
function formatDate(dateStr, lang) {
  if (!dateStr) return "N/A";
  try {
    const dt = new Date(dateStr);
    if (isNaN(dt.getTime())) return dateStr;

    if (lang === "es") {
      const months = [
        "enero", "febrero", "marzo", "abril", "mayo", "junio",
        "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
      ];
      return `${dt.getDate()} de ${months[dt.getMonth()]} del ${dt.getFullYear()}`;
    } else {
      return dt.toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
    }
  } catch {
    return dateStr;
  }
}

// =============================================================================
// Build detailed error blocks for the letter (replaces old table)
// =============================================================================
function buildErrorDetail(errores, lang) {
  if (!errores || errores.length === 0) return "";

  let html = "";

  errores.forEach((err, i) => {
    const idx = i + 1;
    const isLast = i === errores.length - 1;

    // ── Concept name ──
    // Spanish letter: show original English concept from bill (item_referencia)
    // English letter: show original English concept (item_referencia)
    const concepto = err.item_referencia || (lang === "es" ? err.titulo : (err.titulo_en || err.titulo));

    // ── Original charge ──
    const cargoOriginal = formatCurrency(err.precio_facturado || 0);

    // ── Reason for dispute ──
    // Spanish letter: use descripcion (Spanish)
    // English letter: use descripcion_en (English), fallback to descripcion
    const motivo = lang === "es"
      ? (err.descripcion || "")
      : (err.descripcion_en || err.descripcion || "");

    // ── Target amount (what it should be) ──
    const precioObjetivo = formatCurrency(err.precio_referencia || 0);

    // ── Estimated savings ──
    const ahorro = formatCurrency(err.ahorro_estimado || 0);

    // ── Labels by language ──
    const labels = lang === "es" ? {
      cargoOriginal: "Cargo original",
      motivo: "Motivo de apelación",
      seApela: "Se apela a que el cargo sea de",
      ahorro: "Ahorro estimado en este cargo",
    } : {
      cargoOriginal: "Original Charge",
      motivo: "Reason for Dispute",
      seApela: "Requested adjustment to",
      ahorro: "Estimated Savings",
    };

    html += `
    <div class="error-block">
      <div class="error-number">${idx}.</div>
      <div class="error-concept">${concepto}</div>
      <div class="error-detail"><strong>${labels.cargoOriginal}:</strong> ${cargoOriginal}</div>
      <div class="error-detail"><strong>${labels.motivo}:</strong> ${motivo}</div>
      <div class="error-detail"><strong>${labels.seApela}:</strong> ${precioObjetivo}</div>
      <div class="error-detail"><strong>${labels.ahorro}:</strong> ${ahorro}</div>
    </div>${isLast ? "" : '<hr class="error-separator">'}`;
  });

  return html;
}

// =============================================================================
// Build HTML content for a letter
// =============================================================================
function buildHtml(analysis, signerData, lang) {
  let template = loadTemplate(lang);
  if (!template) {
    template = getFallbackTemplate(lang);
  }

  const hospital = analysis.hospital || "N/A";
  const fecha = formatDate(analysis.fecha_servicio, lang);
  const total = formatCurrency(analysis.total_facturado || 0);
  const ahorro = formatCurrency(analysis.ahorro_total_estimado || 0);
  const facturaId = analysis.factura_id || "—";

  // ── Factura ID label ──
  const facturaIdLabel = lang === "es" ? "Factura #" : "Invoice #";

  const errores = analysis.errores_detectados || [];
  const disclaimer = getLetterFooterDisclaimer(lang);
  const today = formatDate(new Date().toISOString().slice(0, 10), lang);

  // ── Signer info ──
  const signerName = signerData.name || "Cliente";
  const signerRel = signerData.relationship || "self";
  const patientName = signerData.patientName || signerName;
  const isMinor = signerData.isMinor || false;

  // Patient display name
  let displayPatient;
  if (isMinor && signerRel !== "self") {
    displayPatient = signerName;
  } else {
    displayPatient = patientName || signerName;
  }

  // Care-of line
  let careOfLine = "";
  if (isMinor && signerRel !== "self") {
    if (lang === "es") {
      careOfLine = `<div class="care-of">En representaci\u00f3n de: ${patientName}, menor de edad</div>`;
    } else {
      careOfLine = `<div class="care-of">On behalf of: ${patientName}, a minor</div>`;
    }
  }

  // ── Intro paragraph ──
  let introText = "";
  if (!isMinor || signerRel === "self") {
    if (lang === "es") {
      introText = `Le escribo para solicitar una revisión detallada de mi factura médica.`;
    } else {
      introText = `I am writing to request a detailed review of my medical bill.`;
    }
  } else {
    const relMap = {
      "parent": {
        es: `Le escribo como ${signerName.includes(" ") ? signerName.split(" ")[0] : signerName}, madre/padre de ${patientName}, menor de edad, para solicitar una revisión detallada de su factura médica.`,
        en: `I am writing as ${signerName.includes(" ") ? signerName.split(" ")[0] : signerName}, parent of ${patientName}, a minor, to request a detailed review of their medical bill.`,
      },
      "legal_guardian": {
        es: `Le escribo como tutor/a legal de ${patientName}, menor de edad, designado/a por corte, para solicitar una revisión detallada de su factura médica.`,
        en: `I am writing as the court-appointed legal guardian of ${patientName}, a minor, to request a detailed review of their medical bill.`,
      },
      "other": {
        es: `Le escribo como representante autorizado de ${patientName}, menor de edad, para solicitar una revisión detallada de su factura médica.`,
        en: `I am writing as the authorized representative of ${patientName}, a minor, to request a detailed review of their medical bill.`,
      },
    };
    const entry = relMap[signerRel] || relMap["parent"];
    introText = entry[lang] || entry["es"];
  }

  // ── Build detailed error blocks ──
  const erroresDetalle = buildErrorDetail(errores, lang);

  // ── Signer relationship label ──
  const signerRelLabel = signerRel === "parent" ? (lang === "es" ? "padre/madre" : "parent")
    : signerRel === "legal_guardian" ? (lang === "es" ? "tutor legal" : "legal guardian")
    : signerRel === "self" ? ""
    : (lang === "es" ? "representante autorizado" : "authorized representative");

  // Replace placeholders
  const html = template
    .replace(/\{customer_name\}/g, displayPatient)
    .replace(/\{care_of_line\}/g, careOfLine)
    .replace(/\{signer_name\}/g, signerName)
    .replace(/\{signer_rel\}/g, signerRelLabel)
    .replace(/\{intro_text\}/g, introText)
    .replace(/\{hospital\}/g, hospital)
    .replace(/\{fecha\}/g, fecha)
    .replace(/\{total_facturado\}/g, total)
    .replace(/\{ahorro_estimado\}/g, ahorro)
    .replace(/\{factura_id_label\}/g, facturaIdLabel)
    .replace(/\{factura_id\}/g, facturaId)
    .replace(/\{factura_id_row\}/g, "")
    .replace(/\{errores_rows\}/g, "")       // legacy — removed
    .replace(/\{items_rows\}/g, "")          // legacy — removed
    .replace(/\{errores_detalle\}/g, erroresDetalle)
    .replace(/\{today\}/g, today)
    .replace(/\{num_errores\}/g, String(errores.length))
    .replace(/\{disclaimer\}/g, disclaimer);

  return html;
}

// =============================================================================
// Generate both letters as PNG buffers
// =============================================================================
async function generateLetters(analysis, signerData) {
  let playwright;
  try {
    playwright = await import("playwright");
  } catch {
    throw new Error("Playwright not installed. Run: npx playwright install chromium");
  }

  console.log(`📄 Generating letters for: ${signerData.name}, hospital: ${analysis.hospital}`);

  const htmlEs = buildHtml(analysis, signerData, "es");
  const htmlEn = buildHtml(analysis, signerData, "en");

  const browser = await playwright.chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 800, height: 1200 } });

  // Spanish letter
  await page.setContent(htmlEs, { waitUntil: "networkidle" });
  const esHeight = await page.evaluate(() => document.body.scrollHeight);
  await page.setViewportSize({ width: 800, height: esHeight + 40 });
  const esBuffer = await page.screenshot({ fullPage: true, type: "png" });
  console.log(`📄 Spanish letter: ${esBuffer.length} bytes`);

  // English letter
  await page.setContent(htmlEn, { waitUntil: "networkidle" });
  const enHeight = await page.evaluate(() => document.body.scrollHeight);
  await page.setViewportSize({ width: 800, height: enHeight + 40 });
  const enBuffer = await page.screenshot({ fullPage: true, type: "png" });
  console.log(`📄 English letter: ${enBuffer.length} bytes`);

  await browser.close();

  return { es_bytes: esBuffer, en_bytes: enBuffer };
}

// =============================================================================
// Fallback: plain-text letters if Playwright unavailable
// =============================================================================
function generateTextLetters(analysis, signerData) {
  const hospital = analysis.hospital || "N/A";
  const fecha = analysis.fecha_servicio || "N/A";
  const total = formatCurrency(analysis.total_facturado || 0);
  const ahorro = formatCurrency(analysis.ahorro_total_estimado || 0);
  const today = formatDate(new Date().toISOString().slice(0, 10), "es");

  const signerName = signerData.name || "Cliente";
  const patientName = signerData.patientName || signerName;
  const isMinor = signerData.isMinor || false;
  const displayName = isMinor ? `${patientName} (menor) — Firmante: ${signerName}` : signerName;

  const facturaId = analysis.factura_id || null;
  const facturaLine = facturaId ? `\nID Factura: ${facturaId}` : "";

  let erroresTextEs = "";
  let erroresTextEn = "";
  (analysis.errores_detectados || []).forEach((err, i) => {
    const idx = i + 1;
    const concepto = err.item_referencia || err.titulo || "Error";
    const cargo = formatCurrency(err.precio_facturado || 0);
    const motivoEs = err.descripcion || "";
    const motivoEn = err.descripcion_en || err.descripcion || "";
    const objetivo = formatCurrency(err.precio_referencia || 0);
    const ahorroErr = formatCurrency(err.ahorro_estimado || 0);

    erroresTextEs += `${idx}. ${concepto}\n` +
      `   Cargo original: ${cargo}\n` +
      `   Motivo: ${motivoEs}\n` +
      `   Se apela a: ${objetivo}\n` +
      `   Ahorro: ${ahorroErr}\n\n`;

    erroresTextEn += `${idx}. ${concepto}\n` +
      `   Original Charge: ${cargo}\n` +
      `   Reason: ${motivoEn}\n` +
      `   Requested adjustment: ${objetivo}\n` +
      `   Savings: ${ahorroErr}\n\n`;
  });

  const disclaimerEs = getLetterFooterDisclaimer("es");
  const disclaimerEn = getLetterFooterDisclaimer("en");

  const esText =
    `${today}\n\n` +
    `Proveedor: ${hospital}\nPaciente: ${displayName}${facturaLine}\n\n` +
    `Estimado departamento de facturación:\n\n` +
    `Le escribo para solicitar una revisión detallada de mi factura médica ` +
    `por un total de ${total}. Tras un análisis exhaustivo, he identificado ` +
    `los siguientes posibles errores de facturación:\n\n${erroresTextEs}` +
    `Ahorro total estimado: ${ahorro}\n\n` +
    `Agradecería que revisaran estos puntos y ajustaran la factura en consecuencia. ` +
    `Quedo atento a su respuesta.\n\nAtentamente,\n${signerName}\n\n` +
    `---\n${disclaimerEs}`;

  const enText =
    `${today}\n\n` +
    `Provider: ${hospital}\nPatient: ${displayName}${facturaLine}\n\n` +
    `Dear Billing Department:\n\n` +
    `I am writing to request a detailed review of my medical bill ` +
    `totaling ${total}. After thorough analysis, I have identified ` +
    `the following potential billing errors:\n\n${erroresTextEn}` +
    `Total estimated savings: ${ahorro}\n\n` +
    `I would appreciate it if you could review these items and adjust the bill ` +
    `accordingly. I look forward to your response.\n\nSincerely,\n${signerName}\n\n` +
    `---\n${disclaimerEn}`;

  return { es_text: esText, en_text: enText };
}

// =============================================================================
// Fallback HTML templates (embedded)
// =============================================================================
function getFallbackTemplate(lang) {
  if (lang === "es") {
    return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><style>
      body { font-family: 'Georgia', serif; max-width: 720px; margin: 36px auto 28px auto; padding: 0 44px; color: #1a1a1a; line-height: 1.5; font-size: 12pt; }
      .sender { margin-bottom: 16px; } .sender .name { font-size: 13pt; font-weight: bold; }
      .sender .care-of { font-size: 9.5pt; color: #555; margin-top: 1px; font-style: italic; }
      .date-line { margin-bottom: 18px; } .ref-line { margin-bottom: 18px; font-size: 10.5pt; }
      .salutation { margin-bottom: 12px; } .body-text { margin-bottom: 8px; text-align: justify; font-size: 11.5pt; }
      .section-heading { font-size: 10.5pt; font-weight: bold; text-transform: uppercase; border-bottom: 1px solid #333; padding-bottom: 4px; margin: 18px 0 12px 0; }
      .error-block { margin-bottom: 12px; } .error-number { font-size: 11.5pt; font-weight: bold; }
      .error-concept { font-size: 11pt; font-weight: bold; color: #2563eb; margin-bottom: 5px; }
      .error-detail { font-size: 10.5pt; margin-bottom: 2px; padding-left: 14px; }
      .error-separator { border-top: 1px dotted #ccc; margin: 10px 0; }
      .summary-box { border: 1px solid #333; padding: 10px 14px; margin: 14px 0 20px 0; font-size: 10.5pt; }
      .signature-area { margin-top: 32px; } .signature-space { height: 42px; }
      .signature-line { width: 260px; border-bottom: 1px solid #999; margin-bottom: 4px; }
      .signature-label { font-size: 10pt; font-weight: 600; }
      .letter-footer { margin-top: 36px; padding-top: 10px; border-top: 1px solid #ccc; display: flex; align-items: center; gap: 12px; }
      .footer-logo { width: 48px; height: 48px; flex-shrink: 0; }
      .footer-disclaimer { font-size: 8pt; color: #777; line-height: 1.4; }
      @media print { body { margin: 0.5in 0.55in 0.9in 0.55in; } @page { margin: 0.5in 0.55in; size: letter; }
        .letter-footer { position: fixed; bottom: 0; left: 0.55in; right: 0.55in; margin-top: 0; padding-top: 8px; border-top: 1px solid #ccc; background: white; }
        .final-block { break-inside: avoid; page-break-inside: avoid; }
        .signature-space { height: 32px; } }
    </style></head><body>
      <div class="sender"><div class="name">{customer_name}</div>{care_of_line}</div>
      <div class="date-line">{today}</div>
      <div class="ref-line"><strong>Ref:</strong> Disputa de factura médica — {hospital}<br><strong>{factura_id_label}:</strong> {factura_id}</div>
      <div class="salutation"><strong>Estimado departamento de facturación:</strong></div>
      <p class="body-text">{intro_text}</p>
      <p class="body-text">Tras un análisis detallado de los cargos, he identificado <strong>{num_errores} posible(s) error(es)</strong> de facturación que suman aproximadamente <strong>{ahorro_estimado}</strong>.</p>
      <div class="section-heading">Errores Identificados</div>
      {errores_detalle}
      <div class="final-block"><div class="summary-box"><p><strong>Total facturado:</strong> {total_facturado}</p><p><strong>Ahorro total estimado:</strong> {ahorro_estimado}</p><p style="margin-top:8px">Solicito respetuosamente la revisión y ajuste de los cargos mencionados.</p></div>
      <div class="signature-area"><p style="margin-bottom:6px">Atentamente,</p><div class="signature-space"></div><div class="signature-line"></div><div class="signature-label">{signer_name}</div><div class="signature-rel">{signer_rel}</div></div></div>
      <div class="letter-footer"><div class="footer-logo"><svg viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M 50 35 L 150 35 L 160 95 C 160 150 130 175 100 185 C 70 175 40 150 40 95 Z" stroke="#2A9D8F" stroke-width="12" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M 100 55 L 100 145" stroke="#2A9D8F" stroke-width="12" stroke-linecap="round" fill="none"/><path d="M 65 100 L 135 100" stroke="#2A9D8F" stroke-width="12" stroke-linecap="round" fill="none"/><path d="M 115 135 L 130 150 L 165 110" stroke="#F4A261" stroke-width="12" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg></div><div class="footer-disclaimer">{disclaimer}</div></div>
    </body></html>`;
  } else {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><style>
      body { font-family: 'Georgia', serif; max-width: 720px; margin: 36px auto 28px auto; padding: 0 44px; color: #1a1a1a; line-height: 1.5; font-size: 12pt; }
      .sender { margin-bottom: 16px; } .sender .name { font-size: 13pt; font-weight: bold; }
      .sender .care-of { font-size: 9.5pt; color: #555; margin-top: 1px; font-style: italic; }
      .date-line { margin-bottom: 18px; } .ref-line { margin-bottom: 18px; font-size: 10.5pt; }
      .salutation { margin-bottom: 12px; } .body-text { margin-bottom: 8px; text-align: justify; font-size: 11.5pt; }
      .section-heading { font-size: 10.5pt; font-weight: bold; text-transform: uppercase; border-bottom: 1px solid #333; padding-bottom: 4px; margin: 18px 0 12px 0; }
      .error-block { margin-bottom: 12px; } .error-number { font-size: 11.5pt; font-weight: bold; }
      .error-concept { font-size: 11pt; font-weight: bold; color: #2563eb; margin-bottom: 5px; }
      .error-detail { font-size: 10.5pt; margin-bottom: 2px; padding-left: 14px; }
      .error-separator { border-top: 1px dotted #ccc; margin: 10px 0; }
      .summary-box { border: 1px solid #333; padding: 10px 14px; margin: 14px 0 20px 0; font-size: 10.5pt; }
      .signature-area { margin-top: 32px; } .signature-space { height: 42px; }
      .signature-line { width: 260px; border-bottom: 1px solid #999; margin-bottom: 4px; }
      .signature-label { font-size: 10pt; font-weight: 600; }
      .letter-footer { margin-top: 36px; padding-top: 10px; border-top: 1px solid #ccc; display: flex; align-items: center; gap: 12px; }
      .footer-logo { width: 48px; height: 48px; flex-shrink: 0; }
      .footer-disclaimer { font-size: 8pt; color: #777; line-height: 1.4; }
      @media print { body { margin: 0.5in 0.55in 0.9in 0.55in; } @page { margin: 0.5in 0.55in; size: letter; }
        .letter-footer { position: fixed; bottom: 0; left: 0.55in; right: 0.55in; margin-top: 0; padding-top: 8px; border-top: 1px solid #ccc; background: white; }
        .final-block { break-inside: avoid; page-break-inside: avoid; }
        .signature-space { height: 32px; } }
    </style></head><body>
      <div class="sender"><div class="name">{customer_name}</div>{care_of_line}</div>
      <div class="date-line">{today}</div>
      <div class="ref-line"><strong>Re:</strong> Medical Bill Dispute — {hospital}<br><strong>{factura_id_label}:</strong> {factura_id}</div>
      <div class="salutation"><strong>Dear Billing Department:</strong></div>
      <p class="body-text">{intro_text}</p>
      <p class="body-text">After a thorough analysis of the charges, I have identified <strong>{num_errores} potential billing error(s)</strong> totaling approximately <strong>{ahorro_estimado}</strong>.</p>
      <div class="section-heading">Identified Errors</div>
      {errores_detalle}
      <div class="final-block"><div class="summary-box"><p><strong>Total Billed:</strong> {total_facturado}</p><p><strong>Total Estimated Savings:</strong> {ahorro_estimado}</p><p style="margin-top:8px">I respectfully request the review and adjustment of the charges mentioned above.</p></div>
      <div class="signature-area"><p style="margin-bottom:6px">Sincerely,</p><div class="signature-space"></div><div class="signature-line"></div><div class="signature-label">{signer_name}</div><div class="signature-rel">{signer_rel}</div></div></div>
      <div class="letter-footer"><div class="footer-logo"><svg viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M 50 35 L 150 35 L 160 95 C 160 150 130 175 100 185 C 70 175 40 150 40 95 Z" stroke="#2A9D8F" stroke-width="12" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M 100 55 L 100 145" stroke="#2A9D8F" stroke-width="12" stroke-linecap="round" fill="none"/><path d="M 65 100 L 135 100" stroke="#2A9D8F" stroke-width="12" stroke-linecap="round" fill="none"/><path d="M 115 135 L 130 150 L 165 110" stroke="#F4A261" stroke-width="12" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg></div><div class="footer-disclaimer">{disclaimer}</div></div>
    </body></html>`;
  }
}

export { generateLetters, generateTextLetters };
export default { generateLetters, generateTextLetters };
