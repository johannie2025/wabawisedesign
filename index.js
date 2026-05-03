/**
 * WABA Node Engine — WhatsApp Web.js bridge
 * Version ES Module pour Node v24+
 */
 
 // À ajouter au début de index.js
const logger = (id, message, level = 'INFO') => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${id}] [${level}]: ${message}`);
};

import express from 'express';
import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'fs';
import https from 'https';
import http from 'http';
import cors from 'cors';
import qrcode from 'qrcode';
import crypto from 'crypto';
import { fileURLToPath } from 'url';


// Importation compatible ES Modules pour whatsapp-web.js
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors());

// À appeler juste après le démarrage de ton tunnel Bore
function updateTunnelConfig(url) {
    // Sauvegarde dans un fichier JSON que PHP pourra lire
    const config = { nodeUrl: url };
    fs.writeFileSync('./tunnel_config.json', JSON.stringify(config));
    console.log(`✅ Config mise à jour : ${url}`);
}

// Exemple d'usage quand tu récupères l'info de Bore :
// updateTunnelConfig("http://bore.pub:58385");

// --- CONFIGURATION CHEMINS ---
const PORT          = process.env.PORT  || 3000;
const PHP_BASE_URL  = process.env.PHP_URL || 'https://wisedesign.pro/wabaperso';
const INSTANCES_DIR = path.join(__dirname, 'instances');
const STATE_FILE    = path.join(__dirname, 'channels.json');
// Chemin spécifique vers ton installation Chrome à Bata
const CHROME_PATH   = 'C:\\Users\\Wise Josias\\.cache\\puppeteer\\chrome\\win64-147.0.7727.57\\chrome-win64\\chrome.exe';

if (!fs.existsSync(INSTANCES_DIR)) fs.mkdirSync(INSTANCES_DIR, { recursive: true });

// --- PERSISTANCE ---
function loadState() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
    catch { return {}; }
}
function saveState(state) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

const instances = new Map();
let channelsMeta = loadState();

// --- HELPERS ---
function ok(res, data = {}) { res.json({ _ok: true, ...data }); }
function err(res, msg, code = 400) { res.status(code).json({ _ok: false, error: msg }); }

function getInstance(req, res) {
    const inst = instances.get(req.params.id);
    if (!inst) { err(res, 'Channel not found', 404); return null; }
    return inst;
}

async function forwardWebhook(webhookUrl, event, data) {
    if (!webhookUrl) return;
    const body = JSON.stringify({ event, data, ts: Date.now() });
    const urlObj = new URL(webhookUrl);
    const mod = urlObj.protocol === 'https:' ? https : http;
    const req = mod.request({
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    });
    req.on('error', (e) => console.error(`Webhook Error: ${e.message}`));
    req.write(body);
    req.end();
}

app.post('/cleanup', async (req, res) => {
    const { mode } = req.body;
    const instancesDir = './instances';

    try {
        const folders = fs.readdirSync(instancesDir);
        
        for (const folder of folders) {
            const folderPath = path.join(instancesDir, folder);
            
            // Si mode 'all' ou si vous ajoutez une logique pour 'expired'
            if (fs.lstatSync(folderPath).isDirectory()) {
                // On tente de fermer la session si elle est en mémoire
                if (sessions[folder]) {
                    await sessions[folder].destroy().catch(() => {});
                    delete sessions[folder];
                }
                // Suppression physique
                fs.rmSync(folderPath, { recursive: true, force: true });
            }
        }
        res.json({ ok: true, message: "Dossiers supprimés" });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});


// --- INITIALISATION CLIENT ---
function createClient(channelId) {
    return new Client({
        authStrategy: new LocalAuth({
            clientId: channelId,
            dataPath: path.join(INSTANCES_DIR, channelId),
        }),
        puppeteer: {
            executablePath: CHROME_PATH,
            headless: "new",
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ],
        },
    });
}

function attachEvents(channelId, client) {
    const inst = instances.get(channelId);
    if (!inst) return;

    client.on('qr', async (qrString) => {
        try {
            inst.qrPng = await qrcode.toBuffer(qrString, { type: 'png', width: 300 });
            inst.status = 'qr';
            console.log(`[${channelId}] QR prêt`);
        } catch (e) { console.error('QR gen error', e); }
    });

    client.on('ready', async () => {
        inst.status = 'CONNECTED';
        inst.qrPng = null;
        try {
            const info = client.info;
            inst.info = { wid: info.wid._serialized, phone: info.wid.user, name: info.pushname };
            channelsMeta[channelId] = { ...(channelsMeta[channelId] || {}), phone: inst.info.phone, name: inst.info.name };
            saveState(channelsMeta);
        } catch {}
        console.log(`[${channelId}] CONNECTÉ — ${inst.info?.phone}`);
        forwardWebhook(inst.webhookUrl, 'channel.connected', { channel_id: channelId, phone: inst.info?.phone });
    });

    client.on('disconnected', (reason) => {
        inst.status = 'disconnected';
        console.log(`[${channelId}] Déconnecté: ${reason}`);
        forwardWebhook(inst.webhookUrl, 'channel.disconnected', { channel_id: channelId, reason });
    });

    client.on('message', async (msg) => {
        if (msg.fromMe) return;
        const payload = {
            messages: [{
                id: msg.id._serialized,
                from: msg.from,
                body: msg.body,
                type: msg.type,
                timestamp: msg.timestamp,
            }],
        };
        forwardWebhook(inst.webhookUrl, 'messages', payload);
    });
}

async function restoreChannels() {
    const ids = Object.keys(channelsMeta);
    for (const id of ids) {
        console.log(`[boot] Restauration du canal ${id}…`);
        const client = createClient(id);
        const inst = {
            client,
            status: 'loading',
            webhookUrl: channelsMeta[id]?.webhookUrl || null,
        };
        instances.set(id, inst);
        attachEvents(id, client);
        client.initialize().catch((e) => console.error(`[${id}] Init error:`, e.message));
    }
}

// --- ROUTES ---

app.post('/channels', async (req, res) => {
    const { name, user_id } = req.body;
    if (!name) return err(res, 'name required'); // Erreur gérée pour PHP[cite: 1, 2]

    const channelId = `ch_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const token = crypto.randomBytes(32).toString('hex');

    const client = createClient(channelId);
    const inst = { client, status: 'loading', webhookUrl: null, meta: { name, user_id, token } };
    
    instances.set(channelId, inst);
    attachEvents(channelId, client);

    channelsMeta[channelId] = { name, user_id, token, webhookUrl: null };
    saveState(channelsMeta);

client.initialize().catch(e => {
    logger(id, `Initialization error: ${e.message}`, 'ERROR');
    // On met à jour l'instance pour que l'API sache pourquoi ça a échoué
    const inst = instances.get(id);
    if(inst) inst.lastError = e.message;
});

    client.initialize().catch((e) => console.error(`[${channelId}] Init error:`, e.message));
    ok(res, { id: channelId, token });
});

app.get('/channels/:id/qr/image', (req, res) => {
    const inst = getInstance(req, res);
    if (!inst || !inst.qrPng) return res.status(503).send('QR not ready');
    res.setHeader('Content-Type', 'image/png');
    res.send(inst.qrPng);
});

app.patch('/channels/:id/webhook', (req, res) => {
    const inst = getInstance(req, res);
    if (!inst) return;
    const { url } = req.body;
    inst.webhookUrl = url;
    channelsMeta[req.params.id].webhookUrl = url;
    saveState(channelsMeta);
    ok(res);
});

// Santé du moteur
app.get('/health', (req, res) => ok(res, { engine: 'waba-node', uptime: process.uptime() }));

app.listen(PORT, async () => {
    console.log(`🚀 WABA Node Engine — http://localhost:${PORT}`);
    await restoreChannels();
});