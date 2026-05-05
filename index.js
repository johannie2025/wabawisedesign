/**
 * WABA Node Engine — WhatsApp Web.js bridge
 * Optimisé pour Render.com (filesystem éphémère)
 * Corrigé — 4 Mai 2026
 */

// Ajoutez cet import en haut de votre fichier
import { executablePath } from 'puppeteer';
import express  from 'express';
import path     from 'path';
import fs       from 'fs';
import https    from 'https';
import http     from 'http';
import cors     from 'cors';
import qrcode   from 'qrcode';
import crypto   from 'crypto';
import { fileURLToPath } from 'url';

import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── LOGGER ───────────────────────────────────────────────────────────────────
const logger = (id, message, level = 'INFO') => {
    const ts = new Date().toISOString();
    console.log(`[${ts}] [${id}] [${level}]: ${message}`);
};

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const PORT                = process.env.PORT              || 3000;
const PHP_BASE_URL        = process.env.PHP_URL           || 'https://wisedesign.pro/wabaperso';
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || null;
const INSTANCES_DIR       = path.join(__dirname, 'instances');
const STATE_FILE          = path.join(__dirname, 'channels.json');

// Sur Render le disque est éphémère mais on garde instances/ pour LocalAuth
// (les sessions survivent tant que le service tourne)
if (!fs.existsSync(INSTANCES_DIR)) fs.mkdirSync(INSTANCES_DIR, { recursive: true });

// ─── EXPRESS ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(cors());

// ─── PERSISTANCE ──────────────────────────────────────────────────────────────
function loadState() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
    catch { return {}; }
}
function saveState(state) {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
    catch (e) { logger('state', `saveState error: ${e.message}`, 'WARN'); }
}

const instances  = new Map();
let channelsMeta = loadState();

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const ok  = (res, data = {})       => res.json({ _ok: true,  ...data });
const err = (res, msg, code = 400) => res.status(code).json({ _ok: false, error: msg });

function getInstance(req, res) {
    const inst = instances.get(req.params.id);
    if (!inst) { err(res, 'Channel not found', 404); return null; }
    return inst;
}

async function forwardWebhook(webhookUrl, event, data) {
    if (!webhookUrl) return;
    const body = JSON.stringify({ event, data, ts: Date.now() });
    try {
        const urlObj = new URL(webhookUrl);
        const mod    = urlObj.protocol === 'https:' ? https : http;
        const req    = mod.request({
            hostname : urlObj.hostname,
            port     : urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
            path     : urlObj.pathname + urlObj.search,
            method   : 'POST',
            headers  : {
                'Content-Type'   : 'application/json',
                'Content-Length' : Buffer.byteLength(body),
            },
        });
        req.on('error', (e) => logger('webhook', `Error: ${e.message}`, 'WARN'));
        req.write(body);
        req.end();
    } catch (e) {
        logger('webhook', `Invalid URL ${webhookUrl}: ${e.message}`, 'WARN');
    }
}

// ─── CRÉATION CLIENT ──────────────────────────────────────────────────────────
function createClient(id) {
    return new Client({
        authStrategy: new LocalAuth({
            clientId : id,
            dataPath : INSTANCES_DIR,
        }),
         puppeteer: {
            headless : true,
            executablePath: executablePath(), // Force l'utilisation du Chrome installé
            protocolTimeout: 60000,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-zygote',
                '--single-process',
            ],
        },
    });
}

// ─── ATTACHEMENT ÉVÉNEMENTS ───────────────────────────────────────────────────
function attachEvents(channelId, client) {
    const inst = instances.get(channelId);
    if (!inst) return;

    client.on('qr', async (qrString) => {
        try {
            inst.qrPng    = await qrcode.toBuffer(qrString, { type: 'png', width: 300 });
            inst.qrString = qrString;
            inst.status   = 'qr';
            logger(channelId, 'QR prêt');
            forwardWebhook(inst.webhookUrl, 'channel.qr', { channel_id: channelId });
        } catch (e) {
            logger(channelId, `QR gen error: ${e.message}`, 'ERROR');
        }
    });

    client.on('loading_screen', (percent) => {
        inst.status = 'loading';
        logger(channelId, `Chargement ${percent}%`);
    });

    client.on('authenticated', () => {
        inst.status = 'authenticated';
        logger(channelId, 'Authentifié');
    });

    client.on('auth_failure', (msg) => {
        inst.status    = 'auth_failure';
        inst.lastError = msg;
        logger(channelId, `Auth failure: ${msg}`, 'ERROR');
        forwardWebhook(inst.webhookUrl, 'channel.auth_failure', { channel_id: channelId, reason: msg });
    });

    client.on('ready', async () => {
        inst.status   = 'CONNECTED';
        inst.qrPng    = null;
        inst.qrString = null;
        try {
            const info = client.info;
            inst.info  = {
                wid   : info.wid._serialized,
                phone : info.wid.user,
                name  : info.pushname,
            };
            channelsMeta[channelId] = {
                ...(channelsMeta[channelId] || {}),
                phone : inst.info.phone,
                name  : inst.info.name,
            };
            saveState(channelsMeta);
        } catch {}
        logger(channelId, `CONNECTÉ — ${inst.info?.phone}`);
        forwardWebhook(inst.webhookUrl, 'channel.connected', {
            channel_id : channelId,
            phone      : inst.info?.phone,
            name       : inst.info?.name,
        });
    });

    client.on('disconnected', (reason) => {
        inst.status = 'disconnected';
        logger(channelId, `Déconnecté: ${reason}`, 'WARN');
        forwardWebhook(inst.webhookUrl, 'channel.disconnected', { channel_id: channelId, reason });
    });

    // ── Messages entrants ─────────────────────────────────────────────────────
    client.on('message', async (msg) => {
        if (msg.fromMe) return;
        let mediaData = null;
        if (msg.hasMedia) {
            try {
                const media = await msg.downloadMedia();
                mediaData = {
                    mimetype : media.mimetype,
                    data     : media.data,   // base64
                    filename : media.filename || null,
                };
            } catch (e) {
                logger(channelId, `Media download error: ${e.message}`, 'WARN');
            }
        }
        const payload = {
            messages: [{
                id         : msg.id._serialized,
                from       : msg.from,
                to         : msg.to,
                body       : msg.body,
                type       : msg.type,
                timestamp  : msg.timestamp,
                hasMedia   : msg.hasMedia,
                media      : mediaData,
                notifyName : msg.notifyName || null,
                isGroup    : msg.from.endsWith('@g.us'),
            }],
        };
        forwardWebhook(inst.webhookUrl, 'messages', payload);
    });

    // ── Accusés de réception (0=pending 1=sent 2=received 3=read 4=played) ───
    client.on('message_ack', (msg, ack) => {
        forwardWebhook(inst.webhookUrl, 'message.ack', {
            channel_id : channelId,
            message_id : msg.id._serialized,
            ack,
        });
    });
}

// ─── RESTAURATION AU BOOT ─────────────────────────────────────────────────────
async function restoreChannels() {
    const ids = Object.keys(channelsMeta);
    for (const id of ids) {
        logger('boot', `Restauration du canal ${id}…`);
        const client = createClient(id);
        const inst   = {
            client,
            status     : 'loading',
            webhookUrl : channelsMeta[id]?.webhookUrl || null,
            info       : null,
            qrPng      : null,
            qrString   : null,
            lastError  : null,
        };
        instances.set(id, inst);
        attachEvents(id, client);
        client.initialize().catch((e) => {
            logger(id, `Init error: ${e.message}`, 'ERROR');
            inst.status    = 'error';
            inst.lastError = e.message;
        });
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ── Santé ─────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => ok(res, {
    engine   : 'waba-node',
    uptime   : process.uptime(),
    channels : instances.size,
}));

// ── Lister tous les canaux ────────────────────────────────────────────────────
// GET /channels
app.get('/channels', (_req, res) => {
    const list = [];
    for (const [id, inst] of instances.entries()) {
        list.push({
            id,
            status     : inst.status,
            phone      : inst.info?.phone || channelsMeta[id]?.phone || null,
            name       : inst.info?.name  || channelsMeta[id]?.name  || null,
            webhookUrl : inst.webhookUrl,
            lastError  : inst.lastError,
            meta       : channelsMeta[id] || {},
        });
    }
    ok(res, { channels: list });
});

// ── Créer un canal ────────────────────────────────────────────────────────────
// POST /channels  { name, user_id }
app.post('/channels', async (req, res) => {
    const { name, user_id } = req.body;
    if (!name) return err(res, 'name required');

    const channelId = `ch_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const token     = crypto.randomBytes(32).toString('hex');

    const client = createClient(channelId);
    const inst   = {
        client,
        status     : 'loading',
        webhookUrl : null,
        info       : null,
        qrPng      : null,
        qrString   : null,
        lastError  : null,
        meta       : { name, user_id, token },
    };

    instances.set(channelId, inst);
    attachEvents(channelId, client);

    channelsMeta[channelId] = { name, user_id, token, webhookUrl: null };
    saveState(channelsMeta);

    // FIX: initialize() appelé UNE seule fois (était appelé deux fois)
    client.initialize().catch((e) => {
        logger(channelId, `Init error: ${e.message}`, 'ERROR');
        inst.status    = 'error';
        inst.lastError = e.message;
    });

    ok(res, { id: channelId, token });
});

// ── Statut d'un canal ─────────────────────────────────────────────────────────
// GET /channels/:id/status
app.get('/channels/:id/status', (req, res) => {
    const inst = getInstance(req, res);
    if (!inst) return;
    ok(res, {
        id        : req.params.id,
        status    : inst.status,
        phone     : inst.info?.phone || null,
        name      : inst.info?.name  || null,
        lastError : inst.lastError   || null,
    });
});

// ── QR image PNG ──────────────────────────────────────────────────────────────
// GET /channels/:id/qr/image
app.get('/channels/:id/qr/image', (req, res) => {
    const inst = getInstance(req, res);
    if (!inst) return;
    if (!inst.qrPng) return res.status(202).json({ _ok: false, error: 'QR not ready yet', status: inst.status });
    res.setHeader('Content-Type', 'image/png');
    res.send(inst.qrPng);
});

// ── QR string brut (pour affichage custom) ────────────────────────────────────
// GET /channels/:id/qr
app.get('/channels/:id/qr', (req, res) => {
    const inst = getInstance(req, res);
    if (!inst) return;
    if (!inst.qrString) return err(res, 'QR not ready yet', 202);
    ok(res, { qr: inst.qrString });
});

// ── Définir / mettre à jour le webhook ───────────────────────────────────────
// PATCH /channels/:id/webhook  { url }
app.patch('/channels/:id/webhook', (req, res) => {
    const inst = getInstance(req, res);
    if (!inst) return;
    const { url } = req.body;
    inst.webhookUrl = url || null;
    if (channelsMeta[req.params.id]) {
        channelsMeta[req.params.id].webhookUrl = url || null;
        saveState(channelsMeta);
    }
    ok(res, { webhookUrl: inst.webhookUrl });
});

// ── Envoyer un message texte ──────────────────────────────────────────────────
// POST /channels/:id/send  { to, message }
// "to" : numéro sans + ni @c.us  ex: "34612345678"
app.post('/channels/:id/send', async (req, res) => {
    const inst = getInstance(req, res);
    if (!inst) return;
    if (inst.status !== 'CONNECTED') return err(res, `Channel not connected (status: ${inst.status})`, 503);

    const { to, message } = req.body;
    if (!to || !message) return err(res, 'to and message required');

    try {
        const chatId = to.includes('@') ? to : `${to}@c.us`;
        const sent   = await inst.client.sendMessage(chatId, message);
        ok(res, { message_id: sent.id._serialized });
    } catch (e) {
        logger(req.params.id, `Send error: ${e.message}`, 'ERROR');
        err(res, e.message, 500);
    }
});

// ── Envoyer un média ──────────────────────────────────────────────────────────
// POST /channels/:id/send-media  { to, caption?, base64, mimetype, filename? }
app.post('/channels/:id/send-media', async (req, res) => {
    const inst = getInstance(req, res);
    if (!inst) return;
    if (inst.status !== 'CONNECTED') return err(res, `Channel not connected (status: ${inst.status})`, 503);

    const { to, caption, base64, mimetype, filename } = req.body;
    if (!to || !base64 || !mimetype) return err(res, 'to, base64 and mimetype required');

    try {
        const chatId = to.includes('@') ? to : `${to}@c.us`;
        const media  = new MessageMedia(mimetype, base64, filename || null);
        const sent   = await inst.client.sendMessage(chatId, media, { caption: caption || '' });
        ok(res, { message_id: sent.id._serialized });
    } catch (e) {
        logger(req.params.id, `Send-media error: ${e.message}`, 'ERROR');
        err(res, e.message, 500);
    }
});

// ── Récupérer les contacts ────────────────────────────────────────────────────
// GET /channels/:id/contacts
app.get('/channels/:id/contacts', async (req, res) => {
    const inst = getInstance(req, res);
    if (!inst) return;
    if (inst.status !== 'CONNECTED') return err(res, 'Channel not connected', 503);
    try {
        const contacts = await inst.client.getContacts();
        const list     = contacts.map(c => ({
            id      : c.id._serialized,
            name    : c.name || c.pushname || null,
            number  : c.number,
            isMe    : c.isMe,
            isGroup : c.isGroup,
        }));
        ok(res, { contacts: list });
    } catch (e) {
        err(res, e.message, 500);
    }
});

// ── Récupérer les chats récents ───────────────────────────────────────────────
// GET /channels/:id/chats
app.get('/channels/:id/chats', async (req, res) => {
    const inst = getInstance(req, res);
    if (!inst) return;
    if (inst.status !== 'CONNECTED') return err(res, 'Channel not connected', 503);
    try {
        const chats = await inst.client.getChats();
        const list  = chats.map(c => ({
            id          : c.id._serialized,
            name        : c.name,
            isGroup     : c.isGroup,
            unreadCount : c.unreadCount,
            timestamp   : c.timestamp,
            lastMessage : c.lastMessage?.body || null,
        }));
        ok(res, { chats: list });
    } catch (e) {
        err(res, e.message, 500);
    }
});

// ── Historique d'un chat ──────────────────────────────────────────────────────
// GET /channels/:id/chats/:chatId/messages?limit=20
app.get('/channels/:id/chats/:chatId/messages', async (req, res) => {
    const inst = getInstance(req, res);
    if (!inst) return;
    if (inst.status !== 'CONNECTED') return err(res, 'Channel not connected', 503);
    try {
        const limit = parseInt(req.query.limit) || 20;
        const chat  = await inst.client.getChatById(req.params.chatId);
        const msgs  = await chat.fetchMessages({ limit });
        const list  = msgs.map(m => ({
            id        : m.id._serialized,
            from      : m.from,
            to        : m.to,
            body      : m.body,
            type      : m.type,
            timestamp : m.timestamp,
            fromMe    : m.fromMe,
            hasMedia  : m.hasMedia,
        }));
        ok(res, { messages: list });
    } catch (e) {
        err(res, e.message, 500);
    }
});

// ── Déconnecter / supprimer un canal ─────────────────────────────────────────
// DELETE /channels/:id
// Render: suppression mémoire uniquement (pas de rm -rf disque)
app.delete('/channels/:id', async (req, res) => {
    const inst = getInstance(req, res);
    if (!inst) return;
    try { await inst.client.destroy(); } catch {}
    instances.delete(req.params.id);
    delete channelsMeta[req.params.id];
    saveState(channelsMeta);
    ok(res, { deleted: req.params.id });
});

// ── Logout WhatsApp sans supprimer le canal ───────────────────────────────────
// POST /channels/:id/logout
app.post('/channels/:id/logout', async (req, res) => {
    const inst = getInstance(req, res);
    if (!inst) return;
    try {
        await inst.client.logout();
        inst.status   = 'disconnected';
        inst.info     = null;
        inst.qrPng    = null;
        inst.qrString = null;
        ok(res, { status: 'logged_out' });
    } catch (e) {
        err(res, e.message, 500);
    }
});

// ── Redémarrer un canal ───────────────────────────────────────────────────────
// POST /channels/:id/restart
app.post('/channels/:id/restart', async (req, res) => {
    const inst = getInstance(req, res);
    if (!inst) return;
    try { await inst.client.destroy(); } catch {}

    const newClient    = createClient(req.params.id);
    inst.client        = newClient;
    inst.status        = 'loading';
    inst.qrPng         = null;
    inst.qrString      = null;
    inst.lastError     = null;

    attachEvents(req.params.id, newClient);
    newClient.initialize().catch((e) => {
        logger(req.params.id, `Restart error: ${e.message}`, 'ERROR');
        inst.status    = 'error';
        inst.lastError = e.message;
    });
    ok(res, { status: 'restarting' });
});

// ── Cleanup mémoire (Render: PAS de suppression disque) ──────────────────────
// POST /cleanup  { mode: 'all' | 'disconnected' }
app.post('/cleanup', async (req, res) => {
    const { mode } = req.body;
    const cleaned  = [];

    for (const [id, inst] of instances.entries()) {
        if (mode === 'all' || (mode === 'disconnected' && inst.status === 'disconnected')) {
            try { await inst.client.destroy(); } catch {}
            instances.delete(id);
            delete channelsMeta[id];
            cleaned.push(id);
        }
    }
    saveState(channelsMeta);
    ok(res, { cleaned, count: cleaned.length });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  KEEP-ALIVE — évite le spin-down sur Render free tier
// ═══════════════════════════════════════════════════════════════════════════════
function keepAlive() {
    if (!RENDER_EXTERNAL_URL) {
        logger('keep-alive', 'RENDER_EXTERNAL_URL non définie — mode réveil désactivé', 'WARN');
        return;
    }
    const url = `${RENDER_EXTERNAL_URL}/health`;
    setInterval(() => {
        https.get(url, (r) => {
            logger('keep-alive', `Ping ${url} → ${r.statusCode}`);
        }).on('error', (e) => {
            logger('keep-alive', `Ping error: ${e.message}`, 'WARN');
        });
    }, 600_000); // toutes les 10 min
}

// ═══════════════════════════════════════════════════════════════════════════════
//  DÉMARRAGE
// ═══════════════════════════════════════════════════════════════════════════════
app.listen(PORT, async () => {
    logger('server', `🚀 WABA Node Engine démarré — http://localhost:${PORT}`);
    keepAlive();            // FIX: était défini mais jamais appelé
    await restoreChannels();
});
