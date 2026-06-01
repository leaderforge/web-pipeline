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
  const errores = analysis.errores_detectados || [];
  const items = analysis.items || [];
  const disclaimer = getLetterFooterDisclaimer(lang);
  const today = formatDate(new Date().toISOString().slice(0, 10), lang);

  // ── Signer info ────────────────────────────────────────────────
  const signerName = signerData.name || "Cliente";
  const signerRel = signerData.relationship || "self";
  const patientName = signerData.patientName || signerName;
  const isMinor = signerData.isMinor || false;

  // ── Patient display name ──────────────────────────────────────
  const displayPatient = isMinor && patientName
    ? `${patientName} (${lang === "es" ? "menor de edad" : "minor"})`
    : patientName || signerName;

  // ── Intro paragraph (adapted by relationship) ─────────────────
  let introText = "";
  if (!isMinor || signerRel === "self") {
    // Adult patient
    if (lang === "es") {
      introText = `Le escribo para solicitar una revisión detallada de mi factura médica.`;
    } else {
      introText = `I am writing to request a detailed review of my medical bill.`;
    }
  } else {
    // Minor — adapt by relationship
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

  // Build errors table rows
  let erroresRows = "";
  errores.forEach((err, i) => {
    const precioRef = formatCurrency(err.precio_referencia || 0);
    const precioFact = formatCurrency(err.precio_facturado || 0);
    const ahorroErr = formatCurrency(err.ahorro_estimado || 0);
    const titulo = err.titulo || (lang === "es" ? "Error detectado" : "Detected error");
    const desc = err.descripcion || "";

    erroresRows += `
      <tr>
        <td>${i + 1}</td>
        <td>${titulo}</td>
        <td>${desc}</td>
        <td class="num">${precioFact}</td>
        <td class="num">${precioRef}</td>
        <td class="num">${ahorroErr}</td>
      </tr>`;
  });

  // Build items table rows
  let itemsRows = "";
  items.forEach((item) => {
    const precioUnit = formatCurrency(item.precio_unitario || 0);
    const precioTotal = formatCurrency(item.precio_total || 0);
    itemsRows += `
      <tr>
        <td>${item.codigo_cpt || "—"}</td>
        <td>${item.descripcion || ""}</td>
        <td class="num">${item.cantidad || 1}</td>
        <td class="num">${precioUnit}</td>
        <td class="num">${precioTotal}</td>
      </tr>`;
  });

  // Replace placeholders
  const html = template
    .replace(/\{customer_name\}/g, displayPatient)
    .replace(/\{signer_name\}/g, signerName)
    .replace(/\{signer_rel\}/g, signerRel === "parent" ? (lang === "es" ? "padre/madre" : "parent") 
                                : signerRel === "legal_guardian" ? (lang === "es" ? "tutor legal" : "legal guardian")
                                : (lang === "es" ? "representante autorizado" : "authorized representative"))
    .replace(/\{intro_text\}/g, introText)
    .replace(/\{hospital\}/g, hospital)
    .replace(/\{fecha\}/g, fecha)
    .replace(/\{total_facturado\}/g, total)
    .replace(/\{ahorro_estimado\}/g, ahorro)
    .replace(/\{errores_rows\}/g, erroresRows)
    .replace(/\{items_rows\}/g, itemsRows)
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
  
  const signerName = signerData.name || "Cliente";
  const patientName = signerData.patientName || signerName;
  const isMinor = signerData.isMinor || false;
  const displayName = isMinor ? `${patientName} (menor) — Firmante: ${signerName}` : signerName;

  let erroresTextEs = "";
  let erroresTextEn = "";
  (analysis.errores_detectados || []).forEach((err) => {
    erroresTextEs += `- ${err.titulo || "Error"}: ${err.descripcion || ""}\n`;
    erroresTextEn += `- ${err.titulo || "Error"}: ${err.descripcion || ""}\n`;
  });

  const disclaimerEs = getLetterFooterDisclaimer("es");
  const disclaimerEn = getLetterFooterDisclaimer("en");

  const esText =
    `[MEDILLAFORMS — CARTA DE DISPUTA]\n\n` +
    `Fecha: ${fecha}\nProveedor: ${hospital}\nPaciente: ${customerName}\n\n` +
    `Estimado departamento de facturación:\n\n` +
    `Le escribo para solicitar una revisión detallada de mi factura médica ` +
    `por un total de ${total}. Tras un análisis exhaustivo, he identificado ` +
    `los siguientes posibles errores de facturación:\n\n${erroresTextEs}\n` +
    `Ahorro total estimado: ${ahorro}\n\n` +
    `Agradecería que revisaran estos puntos y ajustaran la factura en consecuencia. ` +
    `Quedo atento a su respuesta.\n\nAtentamente,\n${customerName}\n\n` +
    `---\n${disclaimerEs}`;

  const enText =
    `[MEDILLAFORMS — DISPUTE LETTER]\n\n` +
    `Date: ${fecha}\nProvider: ${hospital}\nPatient: ${customerName}\n\n` +
    `Dear billing department:\n\n` +
    `I am writing to request a detailed review of my medical bill ` +
    `totaling ${total}. After thorough analysis, I have identified ` +
    `the following potential billing errors:\n\n${erroresTextEn}\n` +
    `Total estimated savings: ${ahorro}\n\n` +
    `I would appreciate it if you could review these items and adjust the bill ` +
    `accordingly. I look forward to your response.\n\nSincerely,\n${customerName}\n\n` +
    `---\n${disclaimerEn}`;

  return { es_text: esText, en_text: enText };
}

// =============================================================================
// Fallback HTML templates (embedded)
// =============================================================================
function getFallbackTemplate(lang) {
  if (lang === "es") {
    return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><style>
      body { font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 750px; margin: 40px auto; padding: 20px; color: #222; }
      .header { text-align: center; border-bottom: 2px solid #2563eb; padding-bottom: 20px; margin-bottom: 30px; }
      .header h1 { color: #2563eb; margin: 0; font-size: 24px; }
      .header p { color: #666; margin: 5px 0 0 0; }
      .section { margin-bottom: 25px; }
      .section h2 { color: #2563eb; font-size: 16px; border-bottom: 1px solid #e5e7eb; padding-bottom: 5px; }
      table { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 13px; }
      th { background: #f3f4f6; text-align: left; padding: 8px; border: 1px solid #d1d5db; }
      td { padding: 8px; border: 1px solid #d1d5db; }
      .num { text-align: right; }
      .summary { background: #eff6ff; border: 1px solid #bfdbfe; padding: 15px; border-radius: 8px; margin: 20px 0; }
      .footer { margin-top: 40px; padding-top: 15px; border-top: 1px solid #e5e7eb; font-size: 11px; color: #9ca3af; text-align: center; }
    </style></head><body>
      <div class="header"><h1>MedillaForms — Carta de Disputa</h1><p>Servicio educativo de análisis de facturación médica</p></div>
      <div class="section"><h2>Información General</h2>
        <p><strong>Fecha:</strong> {today}</p>
        <p><strong>Proveedor:</strong> {hospital}</p>
        <p><strong>Paciente:</strong> {customer_name}</p>
        <p><strong>Fecha de servicio:</strong> {fecha}</p>
        <p><strong>Total facturado:</strong> {total_facturado}</p>
      </div>
      <div class="section"><h2>Estimado departamento de facturación:</h2>
        <p>Le escribo para solicitar una revisión detallada de mi factura médica. Tras un análisis de los cargos, he identificado <strong>{num_errores} posibles errores</strong> que suman aproximadamente <strong>{ahorro_estimado}</strong>.</p>
      </div>
      <div class="section"><h2>Errores Identificados</h2>
        <table><thead><tr><th>#</th><th>Error</th><th>Descripción</th><th>Cargo Actual</th><th>Precio Referencia</th><th>Ahorro Est.</th></tr></thead><tbody>{errores_rows}</tbody></table>
      </div>
      <div class="section"><h2>Desglose de Cargos</h2>
        <table><thead><tr><th>CPT</th><th>Descripción</th><th>Cant.</th><th>Precio Unit.</th><th>Total</th></tr></thead><tbody>{items_rows}</tbody></table>
      </div>
      <div class="summary"><strong>Ahorro total estimado:</strong> {ahorro_estimado}<br>
        Solicito respetuosamente la revisión y ajuste de los cargos mencionados. Agradezco su atención.</div>
      <p>Atentamente,<br><strong>{customer_name}</strong></p>
      <div class="footer"><p>{disclaimer}</p></div>
    </body></html>`;
  } else {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><style>
      body { font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 750px; margin: 40px auto; padding: 20px; color: #222; }
      .header { text-align: center; border-bottom: 2px solid #2563eb; padding-bottom: 20px; margin-bottom: 30px; }
      .header h1 { color: #2563eb; margin: 0; font-size: 24px; }
      .header p { color: #666; margin: 5px 0 0 0; }
      .section { margin-bottom: 25px; }
      .section h2 { color: #2563eb; font-size: 16px; border-bottom: 1px solid #e5e7eb; padding-bottom: 5px; }
      table { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 13px; }
      th { background: #f3f4f6; text-align: left; padding: 8px; border: 1px solid #d1d5db; }
      td { padding: 8px; border: 1px solid #d1d5db; }
      .num { text-align: right; }
      .summary { background: #eff6ff; border: 1px solid #bfdbfe; padding: 15px; border-radius: 8px; margin: 20px 0; }
      .footer { margin-top: 40px; padding-top: 15px; border-top: 1px solid #e5e7eb; font-size: 11px; color: #9ca3af; text-align: center; }
    </style></head><body>
      <div class="header"><h1>MedillaForms — Dispute Letter</h1><p>Educational Medical Billing Analysis Service</p></div>
      <div class="section"><h2>General Information</h2>
        <p><strong>Date:</strong> {today}</p>
        <p><strong>Provider:</strong> {hospital}</p>
        <p><strong>Patient:</strong> {customer_name}</p>
        <p><strong>Date of Service:</strong> {fecha}</p>
        <p><strong>Total Billed:</strong> {total_facturado}</p>
      </div>
      <div class="section"><h2>Dear Billing Department:</h2>
        <p>I am writing to request a detailed review of my medical bill. After analysis of the charges, I have identified <strong>{num_errores} potential errors</strong> totaling approximately <strong>{ahorro_estimado}</strong>.</p>
      </div>
      <div class="section"><h2>Identified Errors</h2>
        <table><thead><tr><th>#</th><th>Error</th><th>Description</th><th>Billed</th><th>Reference</th><th>Est. Savings</th></tr></thead><tbody>{errores_rows}</tbody></table>
      </div>
      <div class="section"><h2>Charge Breakdown</h2>
        <table><thead><tr><th>CPT</th><th>Description</th><th>Qty</th><th>Unit Price</th><th>Total</th></tr></thead><tbody>{items_rows}</tbody></table>
      </div>
      <div class="summary"><strong>Total Estimated Savings:</strong> {ahorro_estimado}<br>
        I respectfully request review and adjustment of the charges mentioned. Thank you for your attention.</div>
      <p>Sincerely,<br><strong>{customer_name}</strong></p>
      <div class="footer"><p>{disclaimer}</p></div>
    </body></html>`;
  }
}

export { generateLetters, generateTextLetters };
export default { generateLetters, generateTextLetters };
