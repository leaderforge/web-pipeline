// =============================================================================
// Google Sheets Service — Automated reporting
// Appends one row per completed session to "MedillaForms" spreadsheet
// =============================================================================

import { google } from "googleapis";

class SheetsService {
  constructor() {
    this.spreadsheetId = process.env.GOOGLE_SHEETS_ID || "";
    this.serviceEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "";
    this.privateKey = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
    this.enabled = !!(this.spreadsheetId && this.serviceEmail && this.privateKey);

    if (!this.enabled) {
      console.warn("⚠️ Google Sheets not configured — reporting disabled");
    }
  }

  // ---------------------------------------------------------------------------
  // Get authenticated sheets client
  // ---------------------------------------------------------------------------
  _getClient() {
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: this.serviceEmail,
        private_key: this.privateKey,
      },
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    return google.sheets({ version: "v4", auth });
  }

  // ---------------------------------------------------------------------------
  // Ensure headers exist in Row 1
  // ---------------------------------------------------------------------------
  async ensureHeaders() {
    if (!this.enabled) return;

    try {
      const sheets = this._getClient();
      const range = "Reportes!A1:Q1";

      // Check if headers already exist
      const existing = await sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range,
      });

      if (existing.data.values && existing.data.values.length > 0) {
        return; // Headers exist
      }

      // Create headers
      const headers = [[
        "Fecha y Hora",
        "ID Sesión",
        "WhatsApp",
        "Estado",
        "Hospital",
        "Páginas",
        "Errores Encontrados",
        "Monto Factura ($)",
        "Ahorro Potencial ($)",
        "Método de Pago",
        "Cobrado ($)",
        "¿Pagó?",
        "Tiempo Conversación (min)",
        "Resultado",
        "Charity Care",
        "Protecciones Estatales",
        "Notas",
      ]];

      await sheets.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: "Reportes!A1:Q1",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: headers },
      });

      console.log("📊 Google Sheets headers created");
    } catch (e) {
      console.error("❌ Sheets ensureHeaders error:", e.message);
    }
  }

  // ---------------------------------------------------------------------------
  // Append a completed session row
  // ---------------------------------------------------------------------------
  async appendSession(session) {
    if (!this.enabled) {
      console.log("📊 Sheets disabled — would report:", session.id?.slice(0, 8));
      return false;
    }

    try {
      // Calculate conversation duration in minutes
      const startTime = session.session_started_at
        ? new Date(session.session_started_at)
        : new Date();
      const endTime = session.session_closed_at
        ? new Date(session.session_closed_at)
        : new Date();
      const durationMin = Math.round((endTime - startTime) / 60000);

      // Format date in Pacific Time
      const now = new Date();
      const ptFormatter = new Intl.DateTimeFormat("es-MX", {
        timeZone: "America/Los_Angeles",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      const dateStr = ptFormatter.format(now);

      // Parse analysis for charity care and state protections
      const analysis = session.analysis_result || {};
      const charityCare = analysis.hospital_es_nonprofit ? "Sí" : "No";
      const stateProtections = session.user_state || "N/A";

      // Determine result
      let resultado = "Completado";
      if (!session.payment_confirmed) resultado = "Abandonó";
      if (session.payment_confirmed && !session.sheets_reported) resultado = "Pagó — sin cartas";

      const row = [
        dateStr,
        (session.id || "").slice(0, 8),
        `***-***-${(session.whatsapp_number || "").slice(-4)}`,
        session.user_state || "N/A",
        session.hospital_name || "N/A",
        (session.photos || []).length || 1,
        session.errors_found || 0,
        session.total_billed || 0,
        session.potential_savings || 0,
        session.payment_method === "stripe" ? "Stripe" : session.payment_method === "zelle" ? "Zelle" : "N/A",
        session.payment_confirmed ? 29 : 0,
        session.payment_confirmed ? "Sí" : "No",
        durationMin,
        resultado,
        charityCare,
        stateProtections,
        `Hospital: ${session.hospital_name || "N/A"}. Errores: ${session.errors_found || 0}`,
      ];

      const sheets = this._getClient();
      await sheets.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: "Reportes!A:Q",
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: [row] },
      });

      console.log(`📊 Sheet reported: session ${session.id?.slice(0, 8)}`);
      return true;
    } catch (e) {
      console.error("❌ Sheets append error:", e.message);
      return false;
    }
  }
}

export const sheets = new SheetsService();
export default { sheets };
