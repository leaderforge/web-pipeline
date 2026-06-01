require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { google } = require('googleapis');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Middleware ---
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: false }));

// --- Multer ---
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/heic', 'image/heif'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPG, PNG, and HEIC allowed.'));
    }
  }
});

// --- R2 Client ---
const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// ====================================================================
// MULTI-BRAND CONFIGURATION
// ====================================================================

const BRANDS = {
  'welding-brothers': {
    displayName: 'The Welding Brothers',
    telegramToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramChatId: process.env.TELEGRAM_CHAT_ID,
    sheetTab: 'Leads',
    r2Folder: 'leads',
    phones: ['+19514183001', '+19517336105'], // Twilio/Telnyx numbers for WB
  },
  'roof-kings': {
    displayName: 'Roof Kings',
    telegramToken: process.env.TELEGRAM_BOT_TOKEN_RK,
    telegramChatId: process.env.TELEGRAM_CHAT_ID_RK,
    sheetTab: 'RK Leads',
    r2Folder: 'roof-kings/leads',
    phones: ['+18584658919'], // Twilio/Telnyx numbers for RK
  },
};

function getBrand(brandKey) {
  return BRANDS[brandKey] || BRANDS['welding-brothers'];
}

function detectBrandByPhone(toNumber) {
  if (!toNumber) return BRANDS['welding-brothers'];
  const cleaned = toNumber.replace(/\s/g, '');
  for (const [key, brand] of Object.entries(BRANDS)) {
    if (brand.phones.some(p => cleaned.includes(p.replace(/\s/g, '')))) {
      return brand;
    }
  }
  return BRANDS['welding-brothers'];
}

// --- Google Sheets Auth ---
function getSheetsClient() {
  const privateKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    privateKey,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  return google.sheets({ version: 'v4', auth });
}

// --- Ensure Sheet Headers for all brands ---
async function ensureHeaders() {
  const sheets = getSheetsClient();
  const needed = ['Fecha', 'Nombre', 'Telefono', 'Tipo de Trabajo', 'Mejor Hora', 'Fotos', 'Fuente', 'Estado'];

  for (const [key, brand] of Object.entries(BRANDS)) {
    try {
      try {
        await sheets.spreadsheets.values.get({
          spreadsheetId: process.env.GOOGLE_SHEETS_ID,
          range: `'${brand.sheetTab}'!A1:H1`,
        });
      } catch (e) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: process.env.GOOGLE_SHEETS_ID,
          requestBody: {
            requests: [{
              addSheet: { properties: { title: brand.sheetTab } }
            }]
          }
        });
        console.log(`Created "${brand.sheetTab}" sheet tab.`);
      }

      await sheets.spreadsheets.values.update({
        spreadsheetId: process.env.GOOGLE_SHEETS_ID,
        range: `'${brand.sheetTab}'!A1:H1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [needed] },
      });
      console.log(`Headers written to "${brand.sheetTab}".`);
    } catch (err) {
      console.error(`ensureHeaders error for ${brand.sheetTab}:`, err.message);
    }
  }
}

// --- LA Time Helpers ---
function getLASubmittedAt() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).format(new Date()).replace(' ', 'T');
}

function getLAFormatted() {
  return new Date().toLocaleString('es-MX', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

// --- Decode base64 ---
function decodeBase64(dataUri) {
  const matches = dataUri.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!matches) return null;
  return { buffer: Buffer.from(matches[2], 'base64'), mimeType: matches[1] };
}

// --- Upload to R2 ---
async function uploadToR2(buffer, key, contentType) {
  const cmd = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  });
  await r2.send(cmd);
  return `${process.env.R2_PUBLIC_URL}/${key}`;
}

// --- Telegram Notification ---
async function sendTelegram(lead, brandKey) {
  const brand = getBrand(brandKey);

  const msg = [
    `🔧 *New Lead — ${brand.displayName}*`,
    '',
    `👤 *Name:* ${lead.name}`,
    `📞 *Phone:* ${lead.phone}`,
    `🔨 *Job Type:* ${lead.jobType}`,
    `🕐 *Best Time:* ${lead.bestTime || 'Not specified'}`,
    `📅 *Submitted:* ${lead.submittedAt}`,
    `🌐 *Source:* ${lead.source || 'Website'}`,
  ].join('\n');

  const baseUrl = `https://api.telegram.org/bot${brand.telegramToken}`;

  await fetch(`${baseUrl}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: brand.telegramChatId,
      text: msg,
      parse_mode: 'Markdown',
    }),
  });

  if (lead.photos && lead.photos.length > 0) {
    for (const photoUrl of lead.photos) {
      try {
        await fetch(`${baseUrl}/sendPhoto`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: brand.telegramChatId,
            photo: photoUrl,
          }),
        });
      } catch (photoErr) {
        console.error('Telegram sendPhoto failed:', photoErr.message);
      }
    }
  }
}

// --- Send simple Telegram notification (for WhatsApp, calls, SMS) ---
async function sendSimpleTelegram(brandKey, lines) {
  const brand = getBrand(brandKey);
  const baseUrl = `https://api.telegram.org/bot${brand.telegramToken}`;

  await fetch(`${baseUrl}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: brand.telegramChatId,
      text: lines.join('\n'),
      parse_mode: 'Markdown',
    }),
  });
}

// ====================================================================
// ENDPOINTS
// ====================================================================

// --- POST /api/quote ---
app.post('/api/quote', upload.array('photos', 5), async (req, res) => {
  try {
    const { name, phone, jobType, bestTime, lang, source, brand: brandKey } = req.body;
    if (!name || !phone || !jobType) {
      return res.status(400).json({ error: 'Name, phone, and job type are required.' });
    }

    const brand = getBrand(brandKey);
    const submittedAt = getLASubmittedAt();
    const submittedAtFormatted = getLAFormatted();
    const photoUrls = [];

    // Multipart files
    if (req.files && req.files.length > 0) {
      console.log('Photos received via multipart:', req.files.length);
      for (const file of req.files) {
        const ext = path.extname(file.originalname) || '.jpg';
        const key = `${brand.r2Folder}/${uuidv4()}${ext}`;
        const url = await uploadToR2(file.buffer, key, file.mimetype);
        photoUrls.push(url);
      }
    }

    // Base64 data URIs
    let photosArray = req.body.photos;
    if (typeof photosArray === 'string') {
      try { photosArray = JSON.parse(photosArray); } catch (e) { photosArray = []; }
    }
    if (photosArray && Array.isArray(photosArray) && photosArray.length > 0) {
      console.log('Photos received via base64 JSON:', photosArray.length);
      for (const photo of photosArray) {
        const dataUri = typeof photo === 'string' ? photo : (photo.data || photo.url || '');
        if (!dataUri || !dataUri.startsWith('data:')) continue;
        const decoded = decodeBase64(dataUri);
        if (!decoded) continue;
        const ext = decoded.mimeType === 'image/png' ? '.png' : '.jpg';
        const key = `${brand.r2Folder}/${uuidv4()}${ext}`;
        const url = await uploadToR2(decoded.buffer, key, decoded.mimeType);
        photoUrls.push(url);
      }
    }

    // Google Sheets
    const sheets = getSheetsClient();
    const photosCell = photoUrls.length > 0 ? photoUrls.join(', ') : 'Sin fotos';
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: `'${brand.sheetTab}'!A:H`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[
          submittedAt,
          name,
          phone,
          jobType,
          bestTime || '',
          photosCell,
          source || 'Website',
          'Nuevo'
        ]],
      },
    });

    // Telegram
    try {
      await sendTelegram({ name, phone, jobType, bestTime, photos: photoUrls, submittedAt: submittedAtFormatted, source }, brandKey);
    } catch (tgErr) {
      console.error('Telegram send failed:', tgErr.message);
    }

    res.json({ success: true, photos: photoUrls });
  } catch (err) {
    console.error('POST /api/quote error:', err);
    res.status(500).json({ error: 'Internal server error. Please try again.' });
  }
});

// --- POST /api/whatsapp-click ---
app.post('/api/whatsapp-click', async (req, res) => {
  try {
    const { brand: brandKey, whatsappNumber } = req.body;
    const brand = getBrand(brandKey);

    const msg = [
      `💬 *WhatsApp Click — ${brand.displayName}*`,
      '',
      'Alguien hizo clic en el boton de WhatsApp desde la landing page.',
      whatsappNumber ? `📱 *WhatsApp destino:* ${whatsappNumber}` : '',
      `🕐 *Hora:* ${getLAFormatted()}`,
    ].filter(Boolean).join('\n');

    await sendSimpleTelegram(brandKey, msg.split('\n'));
    console.log(`WhatsApp click forwarded to Telegram (${brand.displayName})`);
  } catch (err) {
    console.error('WhatsApp click notification error:', err.message);
  }

  res.json({ success: true });
});

// --- POST /sms/incoming (Twilio) ---
app.post('/sms/incoming', async (req, res) => {
  try {
    const from = req.body.From || 'Desconocido';
    const to = req.body.To || '';
    const body = req.body.Body || '(sin mensaje)';
    const brand = detectBrandByPhone(to);

    const msg = [
      `📱 *SMS ENTRANTE — ${brand.displayName}*`,
      '',
      `📞 *De:* ${from}`,
      `📞 *A:* ${to}`,
      `💬 *Mensaje:* ${body}`,
      `🕐 *Hora:* ${getLAFormatted()}`,
    ].join('\n');

    const baseUrl = `https://api.telegram.org/bot${brand.telegramToken}`;
    await fetch(`${baseUrl}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: brand.telegramChatId,
        text: msg,
        parse_mode: 'Markdown',
      }),
    });

    console.log(`SMS forwarded to Telegram (${brand.displayName}) from:`, from);
  } catch (err) {
    console.error('SMS incoming error:', err.message);
  }

  res.set('Content-Type', 'text/xml');
  res.send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
});

// --- POST /telnyx/incoming ---
const recentCalls = new Set();

app.post('/telnyx/incoming', async (req, res) => {
  try {
    // --- Voice call (JSON: CallSid without CallStatus) ---
    if (req.body.CallSid && !req.body.CallStatus) {
      const from = req.body.From || 'Desconocido';
      const to = req.body.To || '';
      const brand = detectBrandByPhone(to);
      const isNew = !recentCalls.has(req.body.CallSid);
      if (isNew) {
        recentCalls.add(req.body.CallSid);
        if (recentCalls.size > 100) recentCalls.delete(recentCalls.values().next().value);

        const msg = [
          `📞 *LLAMADA ENTRANTE — ${brand.displayName}*`,
          '',
          `📱 *De:* ${from}`,
          `📱 *A:* ${to}`,
          `🕐 *Hora:* ${getLAFormatted()}`,
        ].join('\n');

        const baseUrl = `https://api.telegram.org/bot${brand.telegramToken}`;
        await fetch(`${baseUrl}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: brand.telegramChatId, text: msg, parse_mode: 'Markdown' }),
        }).catch(e => console.error('Telegram send failed:', e.message));
        console.log(`Call forwarded to Telegram (${brand.displayName}) from:`, from);
      }
      res.set('Content-Type', 'text/xml');
      return res.send('<?xml version="1.0" encoding="UTF-8"?><Response><Dial>+19517336105</Dial></Response>');
    }

    // --- Voice call (form-encoded: CallStatus=ringing) ---
    if (req.body.CallStatus === 'ringing') {
      const from = req.body.From || 'Desconocido';
      const to = req.body.To || '';
      const brand = detectBrandByPhone(to);
      const sid = req.body.CallSid || '';
      const isNew = sid && !recentCalls.has(sid);
      if (isNew) {
        recentCalls.add(sid);
        if (recentCalls.size > 100) recentCalls.delete(recentCalls.values().next().value);

        const msg = [
          `📞 *LLAMADA ENTRANTE — ${brand.displayName}*`,
          '',
          `📱 *De:* ${from}`,
          `📱 *A:* ${to}`,
          `🕐 *Hora:* ${getLAFormatted()}`,
        ].join('\n');

        const baseUrl = `https://api.telegram.org/bot${brand.telegramToken}`;
        await fetch(`${baseUrl}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: brand.telegramChatId, text: msg, parse_mode: 'Markdown' }),
        }).catch(e => console.error('Telegram send failed:', e.message));
        console.log(`Call forwarded to Telegram (${brand.displayName}) from:`, from);
      }
      res.set('Content-Type', 'text/xml');
      return res.send('<?xml version="1.0" encoding="UTF-8"?><Response><Dial>+19517336105</Dial></Response>');
    }

    if (req.body.CallStatus) return res.sendStatus(200);

    // --- Messaging (V2 API JSON) ---
    const event = req.body?.data?.event_type;
    const payload = req.body?.data?.payload || {};

    if (event === 'message.received') {
      const from = payload.from?.phone_number || 'Desconocido';
      const to = payload.to?.phone_number || '';
      const brand = detectBrandByPhone(to);
      const text = payload.text || '';
      const media = payload.media || [];

      const caption = [
        `📱 *SMS ENTRANTE — ${brand.displayName}*`,
        '',
        `📞 *De:* ${from}`,
        text ? `💬 *Mensaje:* ${text}` : '',
        media.length > 0 ? `📎 *Adjuntos:* ${media.length}` : '',
        `🕐 *Hora:* ${getLAFormatted()}`,
      ].filter(Boolean).join('\n');

      const baseUrl = `https://api.telegram.org/bot${brand.telegramToken}`;
      await fetch(`${baseUrl}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: brand.telegramChatId, text: caption, parse_mode: 'Markdown' }),
      });

      for (const m of media) {
        try {
          const mediaUrl = m.url || m.content_url || '';
          const type = m.content_type || m.type || '';
          let method = 'sendDocument'; let param = 'document';
          if (type.startsWith('image/')) { method = 'sendPhoto'; param = 'photo'; }
          else if (type.startsWith('audio/')) { method = 'sendAudio'; param = 'audio'; }
          else if (type.startsWith('video/')) { method = 'sendVideo'; param = 'video'; }
          await fetch(`${baseUrl}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: brand.telegramChatId, [param]: mediaUrl }),
          });
        } catch (mediaErr) {
          console.error('Telnyx media send failed:', mediaErr.message);
        }
      }
      console.log(`SMS forwarded to Telegram (${brand.displayName}) from:`, from);
    } else {
      console.log('Telnyx unhandled:', event || JSON.stringify(req.body).substring(0, 200));
    }
  } catch (err) {
    console.error('Telnyx incoming error:', err.message);
  }

  res.sendStatus(200);
});

// --- Health Check ---
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Welding Brothers + Roof Kings API' });
});

// --- Start ---
app.listen(PORT, async () => {
  console.log(`Multi-brand API running on port ${PORT}`);
  console.log(`Brands: ${Object.keys(BRANDS).join(', ')}`);
  await ensureHeaders();
});
