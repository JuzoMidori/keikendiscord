/**
 * Keiken WhatsApp Bridge Server
 * ─────────────────────────────
 * Deploy this to Railway or Render (free).
 * It connects to WhatsApp Web and exposes an HTTP API
 * that your Discord bot (bot.py) calls to send/receive messages.
 *
 * Environment variables to set on the Node server:
 *   API_SECRET          = same secret string as WHATSAPP_API_SECRET in Glacier .env
 *   DISCORD_WEBHOOK_URL = same webhook URL as in Glacier .env
 *   WHATSAPP_GROUP_JID  = 120363409291163831@g.us
 *   PORT                = (set automatically by Railway/Render)
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode  = require('qrcode');
const axios   = require('axios');
const express = require('express');

const PORT         = process.env.PORT               || 3000;
const API_SECRET   = process.env.API_SECRET         || 'keiken_bridge_secret';
const WEBHOOK_URL  = process.env.DISCORD_WEBHOOK_URL || '';
const GROUP_JID    = process.env.WHATSAPP_GROUP_JID  || '120363409291163831@g.us';

const app    = express();
app.use(express.json());

// ── State ──────────────────────────────────────────────────────────────────────
let waReady   = false;
let lastQrB64 = null;   // latest QR as base64 PNG — shown at GET /

// ── Auth middleware ────────────────────────────────────────────────────────────
function requireSecret(req, res, next) {
    if (req.headers['x-secret'] !== API_SECRET) {
        return res.status(401).json({ error: 'unauthorized' });
    }
    next();
}

// ── WhatsApp client ────────────────────────────────────────────────────────────
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--single-process',
            '--no-zygote',
        ]
    }
});

client.on('qr', async (qr) => {
    console.log('📱 New QR code received');
    try {
        lastQrB64 = await qrcode.toDataURL(qr);
        console.log('✅ QR ready — open the server URL in your browser to scan');
    } catch (e) {
        console.error('❌ QR generate error:', e.message);
    }
});

client.on('ready', () => {
    waReady   = true;
    lastQrB64 = null;
    const name = client.info?.pushname || 'unknown';
    console.log(`✅ WhatsApp ready — connected as: ${name}`);
});

client.on('message', async (msg) => {
    if (msg.from !== GROUP_JID || msg.fromMe) return;
    if (!WEBHOOK_URL) return;

    try {
        const contact    = await msg.getContact();
        const senderName = contact.pushname || contact.name || 'WhatsApp';

        let avatarUrl = null;
        try { avatarUrl = await client.getProfilePicUrl(contact.id._serialized); } catch (_) {}

        let text = msg.body || '';
        if (!text && msg.hasMedia) {
            const media = await msg.downloadMedia().catch(() => null);
            text = media ? `📎 [${media.mimetype.split('/')[0]}]` : '📎 [attachment]';
        }
        if (!text) return;

        const payload = { content: text, username: `${senderName} (WhatsApp)` };
        if (avatarUrl) payload.avatar_url = avatarUrl;

        await axios.post(WEBHOOK_URL, payload, { timeout: 10000 });
        console.log(`✅ WA→Discord: ${senderName}: ${text.slice(0, 60)}`);
    } catch (e) {
        console.error('❌ WA→Discord error:', e.message);
    }
});

client.on('auth_failure', () => {
    waReady = false;
    console.error('❌ Auth failed — restart server to get new QR');
});

client.on('disconnected', (reason) => {
    waReady = false;
    console.warn('⚠️  Disconnected:', reason, '— restarting client in 10s...');
    setTimeout(() => client.initialize(), 10000);
});

// ── HTTP API endpoints ─────────────────────────────────────────────────────────

// GET / — show QR code in browser (no auth needed — it's just a QR image)
app.get('/', (req, res) => {
    if (waReady) {
        return res.send(`
            <html><body style="font-family:sans-serif;text-align:center;padding:40px">
            <h2>✅ WhatsApp Bridge Connected</h2>
            <p>WhatsApp is authenticated and the bridge is running.</p>
            </body></html>
        `);
    }
    if (lastQrB64) {
        return res.send(`
            <html><body style="font-family:sans-serif;text-align:center;padding:40px">
            <h2>📱 Scan this QR with WhatsApp</h2>
            <p>Open WhatsApp → ⋮ menu → Linked Devices → Link a Device</p>
            <img src="${lastQrB64}" style="width:300px;height:300px"/>
            <p style="color:gray">Refreshes automatically — reload page if expired</p>
            <script>setTimeout(()=>location.reload(), 30000)</script>
            </body></html>
        `);
    }
    return res.send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:40px">
        <h2>⏳ Starting WhatsApp client...</h2>
        <p>Please wait a few seconds and refresh.</p>
        <script>setTimeout(()=>location.reload(), 5000)</script>
        </body></html>
    `);
});

// GET /status — called by bot.py to check connection
app.get('/status', requireSecret, (req, res) => {
    res.json({ ready: waReady, group: GROUP_JID });
});

// POST /send — called by bot.py to send Discord messages to WhatsApp
app.post('/send', requireSecret, async (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });
    if (!waReady) return res.status(503).json({ error: 'WhatsApp not ready' });

    try {
        const chat = await client.getChatById(GROUP_JID);
        await chat.sendMessage(text);
        console.log(`✅ Discord→WA: ${text.slice(0, 60)}`);
        res.json({ ok: true });
    } catch (e) {
        console.error('❌ Send error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`🚀 Bridge API server running on port ${PORT}`);
    console.log(`   Open your server URL in a browser to scan the WhatsApp QR code`);
});

client.initialize();
