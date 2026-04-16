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
const fs      = require('fs');
const path    = require('path');

const PORT        = process.env.PORT               || 3000;
const API_SECRET  = process.env.API_SECRET         || 'keiken_bridge_secret';
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const GROUP_JID   = process.env.WHATSAPP_GROUP_JID  || '120363409291163831@g.us';

const app = express();
app.use(express.json());

// ── Find Chrome executable ────────────────────────────────────────────────────
// Primary: honour explicit env var (set this on Render if auto-detect ever fails)
// Secondary: scan the custom --path we passed to `npx puppeteer browsers install`
// Tertiary: fall back to system Chrome paths
function findChrome() {
    // 1. Explicit override via env
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        console.log(`✅ Chrome from env: ${process.env.PUPPETEER_EXECUTABLE_PATH}`);
        return process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    // 2. Scan the custom install path used in the build command:
    //    npx puppeteer browsers install chrome --path /opt/render/project/src/.chrome
    //    Installed layout: .chrome/chrome/{version-folder}/chrome-linux64/chrome
    const customBase = path.join(__dirname, '.chrome', 'chrome');
    if (fs.existsSync(customBase)) {
        try {
            const versions = fs.readdirSync(customBase);
            for (const v of versions) {
                const candidate = path.join(customBase, v, 'chrome-linux64', 'chrome');
                if (fs.existsSync(candidate)) {
                    console.log(`✅ Found Chrome at: ${candidate}`);
                    return candidate;
                }
            }
        } catch (e) {
            console.warn('⚠️  Error scanning .chrome dir:', e.message);
        }
    }

    // 3. System Chrome fallbacks
    const systemPaths = [
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
    ];
    for (const c of systemPaths) {
        if (fs.existsSync(c)) {
            console.log(`✅ Found system Chrome at: ${c}`);
            return c;
        }
    }

    console.warn('⚠️  Chrome not found — letting Puppeteer auto-detect via .puppeteerrc.cjs');
    return undefined;
}

const CHROME_PATH = findChrome();

// ── State ─────────────────────────────────────────────────────────────────────
let waReady   = false;
let lastQrB64 = null;

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireSecret(req, res, next) {
    if (req.headers['x-secret'] !== API_SECRET) {
        return res.status(401).json({ error: 'unauthorized' });
    }
    next();
}

// ── WhatsApp client ───────────────────────────────────────────────────────────
const puppeteerConfig = {
    headless: true,
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--no-zygote',
    ]
};
if (CHROME_PATH) puppeteerConfig.executablePath = CHROME_PATH;

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: puppeteerConfig
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

// ── HTTP endpoints ────────────────────────────────────────────────────────────

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

app.get('/status', requireSecret, (req, res) => {
    res.json({ ready: waReady, group: GROUP_JID });
});

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

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`🚀 Bridge API server running on port ${PORT}`);
    console.log(`   Open your server URL in a browser to scan the WhatsApp QR code`);
});

client.initialize();
