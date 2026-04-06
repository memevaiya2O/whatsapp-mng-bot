

require('dotenv').config();

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    proto,
    getContentType
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const fs = require('fs-extra');
const path = require('path');
const express = require('express');

const {
    replaceVariables,
    numberToJid,
    jidToNumber,
    normalizeJid,
    parseTimeString
} = require('./src/lib/variables');

// ═══ PATHS & CONSTANTS ═══════════════════════════════════════
const AUTH_DIR = '/tmp/auth_info';
const DB_DIR = path.join(__dirname, 'src', 'database');
const GROUPS_DB = path.join(DB_DIR, 'groups.json');
const MUTES_DB = path.join(DB_DIR, 'mutes.json');
const ADMINS_DB = path.join(DB_DIR, 'admins.json');

const BOT_NUMBER = process.env.BOT_NUMBER || '';
const PORT = process.env.PORT || 3000;

// ═══ LOGGING SYSTEM ══════════════════════════════════════════
const logs = [];
let pairingCode = null;
let connectionStatus = 'disconnected';

function addLog(message) {
    const timestamp = new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka' });
    const entry = `[${timestamp}] ${message}`;
    logs.push(entry);
    if (logs.length > 300) logs.shift();
    console.log(entry);
}

// ═══ EXPRESS WEB PANEL ═══════════════════════════════════════
const app = express();

app.get('/', (req, res) => {
    const logHtml = logs.slice().reverse().map(l => `<div class="log-entry">${l}</div>`).join('');
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Xyron Rose Manager - Control Panel</title>
        <style>
            *{margin:0;padding:0;box-sizing:border-box}
            body{background:#0d1117;color:#c9d1d9;font-family:'Segoe UI',monospace;padding:20px}
            .header{text-align:center;padding:30px;border-bottom:2px solid #30363d;margin-bottom:20px}
            .header h1{color:#58a6ff;font-size:28px}
            .header p{color:#8b949e;margin-top:5px}
            .status-box{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:20px;margin-bottom:20px;text-align:center}
            .status{font-size:20px;font-weight:bold}
            .connected{color:#3fb950}
            .disconnected{color:#f85149}
            .connecting{color:#d29922}
            .pairing-box{background:#161b22;border:2px solid #58a6ff;border-radius:10px;padding:25px;margin-bottom:20px;text-align:center}
            .pairing-code{font-size:36px;font-weight:bold;color:#58a6ff;letter-spacing:8px;margin:10px 0}
            .pairing-note{color:#8b949e;font-size:14px}
            .logs-container{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:20px;max-height:500px;overflow-y:auto}
            .logs-container h2{color:#58a6ff;margin-bottom:15px}
            .log-entry{padding:4px 0;font-size:13px;border-bottom:1px solid #21262d;color:#8b949e;word-break:break-all}
            .footer{text-align:center;margin-top:30px;color:#484f58}
        </style>
        <meta http-equiv="refresh" content="5">
    </head>
    <body>
        <div class="header">
            <h1>🤖 Xyron Rose Manager</h1>
            <p>Advanced WhatsApp Group Management Bot by Prime Xyron</p>
        </div>
        <div class="status-box">
            <div>Connection Status:</div>
            <div class="status ${connectionStatus}">${connectionStatus.toUpperCase()}</div>
        </div>
        ${pairingCode ? `
        <div class="pairing-box">
            <div>📱 Pairing Code — Enter in WhatsApp → Linked Devices → Link with Phone Number</div>
            <div class="pairing-code">${pairingCode}</div>
            <div class="pairing-note">Go to WhatsApp → Settings → Linked Devices → Link a Device → Link with Phone Number</div>
        </div>` : ''}
        <div class="logs-container">
            <h2>📋 Live Logs</h2>
            ${logHtml || '<div class="log-entry">No logs yet...</div>'}
        </div>
        <div class="footer">
            <p>&copy; 2024 Xyron Rose Manager | Developer: Prime Xyron | t.me/prime_xyron</p>
        </div>
    </body>
    </html>
    `);
});

app.listen(PORT, () => {
    addLog(`🌐 Web panel started on port ${PORT}`);
});

// ═══════════════════════════════════════════════════════════════
// ═══ DATABASE FUNCTIONS ══════════════════════════════════════
// ═══════════════════════════════════════════════════════════════

async function ensureDbFiles() {
    await fs.ensureDir(DB_DIR);
    for (const f of [GROUPS_DB, MUTES_DB, ADMINS_DB]) {
        if (!await fs.pathExists(f)) {
            await fs.writeJson(f, {}, { spaces: 2 });
        }
    }
}

async function readDb(filePath) {
    try {
        await fs.ensureFile(filePath);
        const raw = await fs.readFile(filePath, 'utf-8');
        if (!raw || raw.trim() === '') return {};
        return JSON.parse(raw);
    } catch (e) {
        addLog(`⚠️ DB read error (${path.basename(filePath)}): ${e.message}`);
        return {};
    }
}

async function writeDb(filePath, data) {
    try {
        await fs.writeJson(filePath, data, { spaces: 2 });
    } catch (e) {
        addLog(`⚠️ DB write error (${path.basename(filePath)}): ${e.message}`);
    }
}

// ═══ GROUP SETTINGS ══════════════════════════════════════════

const DEFAULT_GROUP_SETTINGS = {
    welcome: false,
    goodbye: false,
    welcomeMsg: '🎉 Welcome {mention}!\n👤 Number: {shownumber}\n👥 Member Count: {membercount}\n🏷️ Group: {groupname}\n🕐 Time: {time}\n📅 Date: {date}',
    goodbyeMsg: '👋 Goodbye {mention}!\n🏷️ Group: {groupname}\n👥 Remaining Members: {membercount}',
    antilink: false,
    filters: {},
    reaction: false,
    reactionEmojis: ['😁', '🙏', '❤️', '🔥', '👍'],
    cleanservice: false
};

async function getGroupSettings(groupId) {
    const db = await readDb(GROUPS_DB);
    if (!db[groupId]) {
        db[groupId] = { ...DEFAULT_GROUP_SETTINGS, filters: {} };
        await writeDb(GROUPS_DB, db);
    }
    // Ensure all keys exist (in case DB was created with older version)
    let changed = false;
    for (const key of Object.keys(DEFAULT_GROUP_SETTINGS)) {
        if (db[groupId][key] === undefined) {
            db[groupId][key] = key === 'filters' ? {} : DEFAULT_GROUP_SETTINGS[key];
            changed = true;
        }
    }
    if (changed) await writeDb(GROUPS_DB, db);
    return db[groupId];
}

async function updateGroupSettings(groupId, updates) {
    const db = await readDb(GROUPS_DB);
    if (!db[groupId]) {
        db[groupId] = { ...DEFAULT_GROUP_SETTINGS, filters: {} };
    }
    for (const [key, value] of Object.entries(updates)) {
        db[groupId][key] = value;
    }
    await writeDb(GROUPS_DB, db);
    return db[groupId];
}

// ═══ MUTE FUNCTIONS ══════════════════════════════════════════

async function setMute(groupId, userJid, expiresAt) {
    const nJid = normalizeJid(userJid);
    const db = await readDb(MUTES_DB);
    if (!db[groupId]) db[groupId] = {};
    db[groupId][nJid] = expiresAt;
    await writeDb(MUTES_DB, db);
}

async function removeMute(groupId, userJid) {
    const nJid = normalizeJid(userJid);
    const db = await readDb(MUTES_DB);
    if (db[groupId] && db[groupId][nJid]) {
        delete db[groupId][nJid];
        if (Object.keys(db[groupId]).length === 0) delete db[groupId];
        await writeDb(MUTES_DB, db);
        return true;
    }
    return false;
}

async function isUserMuted(groupId, userJid) {
    const nJid = normalizeJid(userJid);
    const db = await readDb(MUTES_DB);
    if (!db[groupId] || !db[groupId][nJid]) return false;
    const expiresAt = db[groupId][nJid];
    if (Date.now() >= expiresAt) {
        delete db[groupId][nJid];
        if (Object.keys(db[groupId]).length === 0) delete db[groupId];
        await writeDb(MUTES_DB, db);
        return false;
    }
    return true;
}

// ═══ ADMIN/OWNER FUNCTIONS ═══════════════════════════════════

async function setOwner(groupId, userJid) {
    const db = await readDb(ADMINS_DB);
    db[groupId] = normalizeJid(userJid);
    await writeDb(ADMINS_DB, db);
}

async function getOwner(groupId) {
    const db = await readDb(ADMINS_DB);
    return db[groupId] || null;
}

// ═══ PERMISSION HELPERS ══════════════════════════════════════

function getBotJid(sock) {
    if (!sock.user || !sock.user.id) return '';
    return normalizeJid(sock.user.id);
}

async function getGroupAdminList(sock, groupId) {
    try {
        const metadata = await sock.groupMetadata(groupId);
        return metadata.participants
            .filter(p => p.admin === 'admin' || p.admin === 'superadmin')
            .map(p => normalizeJid(p.id));
    } catch (e) {
        addLog(`⚠️ Failed to fetch group metadata: ${e.message}`);
        return [];
    }
}

async function isGroupAdmin(sock, groupId, userJid) {
    const admins = await getGroupAdminList(sock, groupId);
    const nJid = normalizeJid(userJid);
    return admins.includes(nJid);
}

async function isBotAdmin(sock, groupId) {
    const botJid = getBotJid(sock);
    const admins = await getGroupAdminList(sock, groupId);
    return admins.includes(botJid);
}

async function isAuthorized(sock, groupId, userJid) {
    const nJid = normalizeJid(userJid);
    const owner = await getOwner(groupId);
    if (owner && normalizeJid(owner) === nJid) return true;
    return await isGroupAdmin(sock, groupId, userJid);
}

async function isRegisteredOwner(groupId, userJid) {
    const owner = await getOwner(groupId);
    if (!owner) return false;
    return normalizeJid(owner) === normalizeJid(userJid);
}

// ═══ MESSAGE HELPERS ═════════════════════════════════════════

function getMessageText(msg) {
    if (!msg || !msg.message) return '';
    const m = msg.message;

    if (m.conversation) return m.conversation;
    if (m.extendedTextMessage && m.extendedTextMessage.text) return m.extendedTextMessage.text;
    if (m.imageMessage && m.imageMessage.caption) return m.imageMessage.caption;
    if (m.videoMessage && m.videoMessage.caption) return m.videoMessage.caption;
    if (m.documentMessage && m.documentMessage.caption) return m.documentMessage.caption;
    if (m.buttonsResponseMessage) return m.buttonsResponseMessage.selectedButtonId || '';
    if (m.listResponseMessage) return m.listResponseMessage.singleSelectReply?.selectedRowId || '';
    if (m.templateButtonReplyMessage) return m.templateButtonReplyMessage.selectedId || '';

    return '';
}

function getTargetJid(msg, args) {
    // Priority 1: Quoted/replied message sender
    const contextInfo = msg.message?.extendedTextMessage?.contextInfo
        || msg.message?.imageMessage?.contextInfo
        || msg.message?.videoMessage?.contextInfo;

    if (contextInfo && contextInfo.participant) {
        return normalizeJid(contextInfo.participant);
    }

    // Priority 2: Mentioned users in message
    if (contextInfo && contextInfo.mentionedJid && contextInfo.mentionedJid.length > 0) {
        return normalizeJid(contextInfo.mentionedJid[0]);
    }

    // Priority 3: Parse number from args
    if (args && args.length > 0) {
        for (const arg of args) {
            const cleaned = arg.replace(/[^0-9]/g, '');
            if (cleaned.length >= 10) {
                const jid = numberToJid(cleaned);
                if (jid) return normalizeJid(jid);
            }
        }
    }

    return null;
}

function isSelfMessage(sock, msg) {
    const botJid = getBotJid(sock);
    if (msg.key.fromMe) return true;
    const senderJid = msg.key.participant || msg.key.remoteJid;
    if (normalizeJid(senderJid) === botJid) return true;
    return false;
}

// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// ═══ MAIN BOT FUNCTION ═══════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════

async function startBot() {
    await ensureDbFiles();
    addLog('🚀 Xyron Rose Manager is starting...');

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    addLog(`📡 Baileys version: ${version.join('.')}`);

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        logger: pino({ level: 'silent' }),
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        printQRInTerminal: false,
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        markOnlineOnConnect: true
    });

    // ═══ PAIRING CODE ════════════════════════════════════════
    if (!sock.authState.creds.registered) {
        addLog('🔑 Generating pairing code...');
        connectionStatus = 'connecting';

        await new Promise(resolve => setTimeout(resolve, 3000));

        try {
            let phoneNumber = BOT_NUMBER.replace(/[^0-9]/g, '');
            if (phoneNumber.length === 11 && phoneNumber.startsWith('0')) {
                phoneNumber = '88' + phoneNumber;
            }
            addLog(`📱 Requesting pairing code for: ${phoneNumber}`);
            const code = await sock.requestPairingCode(phoneNumber);
            pairingCode = code;
            addLog(`✅ Pairing Code: ${code}`);
            addLog(`📱 Go to WhatsApp → Linked Devices → Link with Phone Number`);
        } catch (e) {
            addLog(`❌ Pairing code error: ${e.message}`);
        }
    }

    // ═══ CONNECTION EVENTS ════════════════════════════════════
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            connectionStatus = 'connected';
            pairingCode = null;
            addLog('✅ Successfully connected to WhatsApp!');
            addLog(`🤖 Bot ID: ${sock.user?.id}`);
            addLog(`🤖 Normalized Bot JID: ${getBotJid(sock)}`);
        }

        if (connection === 'close') {
            connectionStatus = 'disconnected';
            const statusCode = lastDisconnect?.error?.output?.statusCode;

            addLog(`❌ Connection closed. Status code: ${statusCode}`);

            if (statusCode === DisconnectReason.loggedOut) {
                addLog('🚪 Logged out. Clearing auth and restarting...');
                await fs.remove(AUTH_DIR);
                setTimeout(startBot, 5000);
            } else {
                addLog('🔄 Reconnecting in 5 seconds...');
                setTimeout(startBot, 5000);
            }
        }

        if (connection === 'connecting') {
            connectionStatus = 'connecting';
            addLog('🔄 Connecting...');
        }
    });

    // ═══════════════════════════════════════════════════════════
    // ═══ GROUP PARTICIPANTS UPDATE (Welcome / Goodbye) ════════
    // ═══════════════════════════════════════════════════════════
    sock.ev.on('group-participants.update', async (event) => {
        try {
            const { id: groupId, participants, action } = event;
            const settings = await getGroupSettings(groupId);

            let metadata;
            try {
                metadata = await sock.groupMetadata(groupId);
            } catch (e) {
                addLog(`⚠️ Could not fetch group metadata: ${e.message}`);
                return;
            }

            for (const participant of participants) {
                const userNumber = jidToNumber(participant);
                const mention = `@${userNumber}`;

                const vars = {
                    mention: mention,
                    shownumber: userNumber,
                    membercount: metadata.participants.length,
                    groupname: metadata.subject || 'Unknown Group'
                };

                if (action === 'add' && settings.welcome) {
                    const text = replaceVariables(settings.welcomeMsg, vars);
                    try {
                        await sock.sendMessage(groupId, {
                            text: text,
                            mentions: [participant]
                        });
                        addLog(`👋 Welcome message sent in: ${metadata.subject}`);
                    } catch (e) {
                        addLog(`⚠️ Welcome send error: ${e.message}`);
                    }
                }

                if (action === 'remove' && settings.goodbye) {
                    const text = replaceVariables(settings.goodbyeMsg, vars);
                    try {
                        await sock.sendMessage(groupId, {
                            text: text,
                            mentions: [participant]
                        });
                        addLog(`👋 Goodbye message sent in: ${metadata.subject}`);
                    } catch (e) {
                        addLog(`⚠️ Goodbye send error: ${e.message}`);
                    }
                }

                if (action === 'remove') {
                    await removeMute(groupId, participant);
                }
            }
        } catch (e) {
            addLog(`⚠️ group-participants.update error: ${e.message}`);
        }
    });

    // ═══════════════════════════════════════════════════════════
    // ═══ MAIN MESSAGE HANDLER ════════════════════════════════
    // ═══════════════════════════════════════════════════════════
    sock.ev.on('messages.upsert', async (upsert) => {
        if (upsert.type !== 'notify') return;

        for (const msg of upsert.messages) {
            try {
                if (!msg.message) continue;
                if (msg.key.remoteJid === 'status@broadcast') continue;

                const isGroup = msg.key.remoteJid?.endsWith('@g.us');
                if (!isGroup) continue;

                const groupId = msg.key.remoteJid;
                const senderJid = msg.key.participant || msg.key.remoteJid;
                const normalizedSender = normalizeJid(senderJid);
                const botJid = getBotJid(sock);
                const selfMsg = isSelfMessage(sock, msg);

                // ───────────────────────────────────────────────
                // CLEAN SERVICE: Delete system/stub messages
                // ───────────────────────────────────────────────
                if (msg.messageStubType) {
                    const settings = await getGroupSettings(groupId);
                    if (settings.cleanservice) {
                        try {
                            await sock.sendMessage(groupId, { delete: msg.key });
                            addLog(`🧹 System message deleted (stub type: ${msg.messageStubType})`);
                        } catch (e) {
                            // Cannot delete, likely not admin
                        }
                    }
                    continue;
                }

                // Skip protocol messages
                const contentType = getContentType(msg.message);
                if (contentType === 'protocolMessage' || contentType === 'senderKeyDistributionMessage') {
                    continue;
                }

                const body = getMessageText(msg);

                // ───────────────────────────────────────────────
                // MUTE ENFORCEMENT: Delete muted user messages
                // ───────────────────────────────────────────────
                if (!selfMsg) {
                    const muted = await isUserMuted(groupId, normalizedSender);
                    if (muted) {
                        try {
                            const botIsAdmin = await isBotAdmin(sock, groupId);
                            if (botIsAdmin) {
                                await sock.sendMessage(groupId, { delete: msg.key });
                                addLog(`🔇 Deleted message from muted user: ${jidToNumber(senderJid)}`);
                            }
                        } catch (e) {
                            addLog(`⚠️ Mute delete error: ${e.message}`);
                        }
                        continue; // Do not process anything else from muted user
                    }
                }

                // ───────────────────────────────────────────────
                // ANTILINK ENFORCEMENT
                // ───────────────────────────────────────────────
                if (!selfMsg && body) {
                    const settings = await getGroupSettings(groupId);
                    if (settings.antilink) {
                        const hasLink = /chat\.whatsapp\.com|wa\.me/i.test(body);
                        if (hasLink) {
                            const senderIsAuth = await isAuthorized(sock, groupId, normalizedSender);
                            if (!senderIsAuth) {
                                const botIsAdmin = await isBotAdmin(sock, groupId);
                                if (botIsAdmin) {
                                    try {
                                        await sock.sendMessage(groupId, { delete: msg.key });
                                        await sock.sendMessage(groupId, {
                                            text: `⚠️ @${jidToNumber(senderJid)}, sharing links is not allowed in this group! Your message has been deleted.`,
                                            mentions: [senderJid]
                                        });
                                        addLog(`🔗 Antilink: Deleted message from ${jidToNumber(senderJid)}`);
                                    } catch (e) {
                                        addLog(`⚠️ Antilink error: ${e.message}`);
                                    }
                                }
                                continue;
                            }
                        }
                    }
                }

                // ───────────────────────────────────────────────
                // WORD FILTER ENFORCEMENT
                // ───────────────────────────────────────────────
                if (!selfMsg && body) {
                    const settings = await getGroupSettings(groupId);
                    if (settings.filters && Object.keys(settings.filters).length > 0) {
                        const lowerBody = body.toLowerCase();
                        let filtered = false;

                        for (const [filterWord, filterReply] of Object.entries(settings.filters)) {
                            if (lowerBody.includes(filterWord.toLowerCase())) {
                                const senderIsAuth = await isAuthorized(sock, groupId, normalizedSender);
                                if (!senderIsAuth) {
                                    const botIsAdmin = await isBotAdmin(sock, groupId);
                                    if (botIsAdmin) {
                                        try {
                                            await sock.sendMessage(groupId, { delete: msg.key });
                                            await sock.sendMessage(groupId, {
                                                text: `⚠️ @${jidToNumber(senderJid)}, ${filterReply}`,
                                                mentions: [senderJid]
                                            });
                                            addLog(`🚫 Filter triggered: "${filterWord}" by ${jidToNumber(senderJid)}`);
                                        } catch (e) { /* silent */ }
                                    }
                                }
                                filtered = true;
                                break;
                            }
                        }
                        if (filtered) continue;
                    }
                }

                // ───────────────────────────────────────────────
                // AUTO REACTION (only for non-bot messages)
                // ───────────────────────────────────────────────
                if (!selfMsg) {
                    const settings = await getGroupSettings(groupId);
                    if (settings.reaction && settings.reactionEmojis && settings.reactionEmojis.length > 0) {
                        const randomEmoji = settings.reactionEmojis[
                            Math.floor(Math.random() * settings.reactionEmojis.length)
                        ];
                        try {
                            await sock.sendMessage(groupId, {
                                react: { text: randomEmoji, key: msg.key }
                            });
                        } catch (e) { /* silent */ }
                    }
                }

                // ───────────────────────────────────────────────
                // "made by" EASTER EGG
                // ───────────────────────────────────────────────
                if (body && body.toLowerCase().includes('made by')) {
                    try {
                        await sock.sendMessage(groupId, {
                            text: '🤖 *Xyron Rose Manager*\n👨‍💻 Developer: Prime Xyron\n📢 t.me/prime_xyron'
                        }, { quoted: msg });
                    } catch (e) { /* silent */ }
                }

                // ───────────────────────────────────────────────
                // COMMAND PARSING
                // ───────────────────────────────────────────────
                if (!body || body.length === 0) continue;

                let command = '';
                let args = [];
                let prefix = '';
                let fullCommand = '';

                // Handle !! prefix commands (!!help, !!goback)
                if (body.startsWith('!!')) {
                    prefix = '!!';
                    const rest = body.slice(2).trim().split(/\s+/);
                    command = rest.shift()?.toLowerCase() || '';
                    args = rest;
                    fullCommand = prefix + command;
                }
                // Handle ! prefix commands (!addme, !cleanservice, !reaction)
                else if (body.startsWith('!')) {
                    prefix = '!';
                    const rest = body.slice(1).trim().split(/\s+/);
                    command = rest.shift()?.toLowerCase() || '';
                    args = rest;
                    fullCommand = prefix + command;
                }
                // Handle . prefix commands (.welcome, .mute, .kick, etc.)
                else if (body.startsWith('.')) {
                    prefix = '.';
                    const rest = body.slice(1).trim().split(/\s+/);
                    command = rest.shift()?.toLowerCase() || '';
                    args = rest;
                    fullCommand = prefix + command;
                }
                else {
                    continue; // Not a command
                }

                if (!command) continue;

                addLog(`📨 Command: ${fullCommand} | Args: [${args.join(', ')}] | Group: ${groupId} | User: ${jidToNumber(senderJid)}`);

                // ═══════════════════════════════════════════════
                // ═══ !!help ═══════════════════════════════════
                // ═══════════════════════════════════════════════
                if (prefix === '!!' && command === 'help') {
                    const helpText = `
╔═══════════════════════════════════╗
║     🤖 *XYRON ROSE MANAGER*       ║
║   Group Management Bot v2.0       ║
╚═══════════════════════════════════╝

📋 *COMMAND LIST:*

━━━ 👑 *SETUP & ADMIN* ━━━
• \`!addme\` — Register as group owner
• \`!!goback\` — Bot leaves the group (Owner only)
• \`!cleanservice on/off\` — Auto-delete system messages

━━━ 👋 *WELCOME & GOODBYE* ━━━
• \`.welcome on/off\` — Toggle welcome messages
• \`.goodbye on/off\` — Toggle goodbye messages
• \`.setwelcome [text]\` — Set welcome message
• \`.setgoodbye [text]\` — Set goodbye message

📝 *Variables:*
\`{mention}\` \`{shownumber}\` \`{membercount}\`
\`{time}\` \`{date}\` \`{groupname}\`

━━━ 🔇 *MUTE & SECURITY* ━━━
• \`.mute [time] [target]\` — Mute a user (10m/1h/1d)
• \`.unmute [target]\` — Unmute a user
• \`.antilink on/off\` — Block links
• \`.filter [word] [reply]\` — Set word filter
• \`.removefilter [word]\` — Remove a filter

━━━ 🛡️ *MODERATION* ━━━
• \`.promote [target]\` — Promote to admin
• \`.kick [target]\` — Remove from group
• \`.tagall [text]\` — Tag all members

━━━ 😁 *AUTO REACTION* ━━━
• \`!reaction on/off\` — Toggle reactions
• \`.reaction set [emojis]\` — Set emojis

━━━━━━━━━━━━━━━━━━━━━━━
👨‍💻 *Developer:* Prime Xyron
📢 *Telegram:* t.me/prime_xyron
━━━━━━━━━━━━━━━━━━━━━━━
                    `.trim();

                    await sock.sendMessage(groupId, { text: helpText }, { quoted: msg });
                    continue;
                }

                // ═══════════════════════════════════════════════
                // ═══ !addme ═══════════════════════════════════
                // ═══════════════════════════════════════════════
                if (prefix === '!' && command === 'addme') {
                    const existingOwner = await getOwner(groupId);
                    if (existingOwner) {
                        await sock.sendMessage(groupId, {
                            text: `⚠️ This group already has a registered owner: @${jidToNumber(existingOwner)}\n\nOnly one owner per group is allowed.`,
                            mentions: [existingOwner]
                        }, { quoted: msg });
                    } else {
                        await setOwner(groupId, normalizedSender);
                        await sock.sendMessage(groupId, {
                            text: `✅ Success! @${jidToNumber(senderJid)} is now the registered owner of this group.\n\nYou can now use all bot commands.`,
                            mentions: [senderJid]
                        }, { quoted: msg });
                        addLog(`👑 New owner registered: ${jidToNumber(senderJid)} for group: ${groupId}`);
                    }
                    continue;
                }

                // ═══════════════════════════════════════════════
                // AUTH CHECK FOR ALL REMAINING COMMANDS
                // ═══════════════════════════════════════════════
                const authorized = await isAuthorized(sock, groupId, normalizedSender);
                if (!authorized) {
                    await sock.sendMessage(groupId, {
                        text: '❌ You do not have permission to use this command. Only group admins or the registered owner can use bot commands.'
                    }, { quoted: msg });
                    continue;
                }

                // ═══════════════════════════════════════════════
                // ═══ !!goback ═════════════════════════════════
                // ═══════════════════════════════════════════════
                if (prefix === '!!' && command === 'goback') {
                    const isOwner = await isRegisteredOwner(groupId, normalizedSender);
                    if (!isOwner) {
                        await sock.sendMessage(groupId, {
                            text: '❌ Only the registered owner can make the bot leave. Use `!addme` first if no owner is registered.'
                        }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(groupId, {
                        text: '👋 Goodbye! Xyron Rose Manager is leaving this group...\n🤖 Add me back anytime!\n📢 t.me/prime_xyron'
                    });
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    try {
                        await sock.groupLeave(groupId);
                        addLog(`🚪 Bot left group: ${groupId}`);
                    } catch (e) {
                        addLog(`⚠️ Error leaving group: ${e.message}`);
                    }
                    continue;
                }

                // ═══════════════════════════════════════════════
                // ═══ !cleanservice ════════════════════════════
                // ═══════════════════════════════════════════════
                if (prefix === '!' && command === 'cleanservice') {
                    const toggle = args[0]?.toLowerCase();
                    if (toggle === 'on') {
                        await updateGroupSettings(groupId, { cleanservice: true });
                        await sock.sendMessage(groupId, {
                            text: '✅ Clean Service has been *enabled*.\n\nSystem messages (join/leave notifications) will be automatically deleted.'
                        }, { quoted: msg });
                        addLog(`🧹 Clean service ON for group: ${groupId}`);
                    } else if (toggle === 'off') {
                        await updateGroupSettings(groupId, { cleanservice: false });
                        await sock.sendMessage(groupId, {
                            text: '❌ Clean Service has been *disabled*.'
                        }, { quoted: msg });
                        addLog(`🧹 Clean service OFF for group: ${groupId}`);
                    } else {
                        await sock.sendMessage(groupId, {
                            text: '📝 Usage: `!cleanservice on` or `!cleanservice off`'
                        }, { quoted: msg });
                    }
                    continue;
                }

                // ═══════════════════════════════════════════════
                // ═══ .welcome ═════════════════════════════════
                // ═══════════════════════════════════════════════
                if (prefix === '.' && command === 'welcome') {
                    const toggle = args[0]?.toLowerCase();
                    if (toggle === 'on') {
                        await updateGroupSettings(groupId, { welcome: true });
                        await sock.sendMessage(groupId, {
                            text: '✅ Welcome messages have been *enabled*!\n\nNew members will receive a welcome message when they join.'
                        }, { quoted: msg });
                        addLog(`👋 Welcome ON for group: ${groupId}`);
                    } else if (toggle === 'off') {
                        await updateGroupSettings(groupId, { welcome: false });
                        await sock.sendMessage(groupId, {
                            text: '❌ Welcome messages have been *disabled*.'
                        }, { quoted: msg });
                        addLog(`👋 Welcome OFF for group: ${groupId}`);
                    } else {
                        const settings = await getGroupSettings(groupId);
                        await sock.sendMessage(groupId, {
                            text: `📝 Usage: \`.welcome on\` or \`.welcome off\`\n\n📊 Current status: ${settings.welcome ? '✅ ON' : '❌ OFF'}`
                        }, { quoted: msg });
                    }
                    continue;
                }

                // ═══════════════════════════════════════════════
                // ═══ .goodbye ═════════════════════════════════
                // ═══════════════════════════════════════════════
                if (prefix === '.' && command === 'goodbye') {
                    const toggle = args[0]?.toLowerCase();
                    if (toggle === 'on') {
                        await updateGroupSettings(groupId, { goodbye: true });
                        await sock.sendMessage(groupId, {
                            text: '✅ Goodbye messages have been *enabled*!\n\nA farewell message will be sent when someone leaves.'
                        }, { quoted: msg });
                        addLog(`👋 Goodbye ON for group: ${groupId}`);
                    } else if (toggle === 'off') {
                        await updateGroupSettings(groupId, { goodbye: false });
                        await sock.sendMessage(groupId, {
                            text: '❌ Goodbye messages have been *disabled*.'
                        }, { quoted: msg });
                        addLog(`👋 Goodbye OFF for group: ${groupId}`);
                    } else {
                        const settings = await getGroupSettings(groupId);
                        await sock.sendMessage(groupId, {
                            text: `📝 Usage: \`.goodbye on\` or \`.goodbye off\`\n\n📊 Current status: ${settings.goodbye ? '✅ ON' : '❌ OFF'}`
                        }, { quoted: msg });
                    }
                    continue;
                }

                // ═══════════════════════════════════════════════
                // ═══ .setwelcome ══════════════════════════════
                // ═══════════════════════════════════════════════
                if (prefix === '.' && command === 'setwelcome') {
                    const welcomeText = args.join(' ').trim();
                    if (!welcomeText) {
                        await sock.sendMessage(groupId, {
                            text: `📝 *Usage:* \`.setwelcome [message]\`

📌 *Available Variables:*
• \`{mention}\` — Tags the user
• \`{shownumber}\` — User's phone number
• \`{membercount}\` — Current member count
• \`{groupname}\` — Group name
• \`{time}\` — Current time
• \`{date}\` — Current date

📝 *Example:*
\`.setwelcome 🎉 Welcome {mention}! You have joined {groupname}. We now have {membercount} members!\``
                        }, { quoted: msg });
                    } else {
                        await updateGroupSettings(groupId, { welcomeMsg: welcomeText });
                        const preview = replaceVariables(welcomeText, {
                            mention: '@User',
                            shownumber: '88019XXXXXXXX',
                            membercount: 100,
                            groupname: 'Test Group'
                        });
                        await sock.sendMessage(groupId, {
                            text: `✅ Welcome message has been set!\n\n📝 *Preview:*\n${preview}`
                        }, { quoted: msg });
                        addLog(`📝 Welcome message set for group: ${groupId}`);
                    }
                    continue;
                }

                // ═══════════════════════════════════════════════
                // ═══ .setgoodbye ══════════════════════════════
                // ═══════════════════════════════════════════════
                if (prefix === '.' && command === 'setgoodbye') {
                    const goodbyeText = args.join(' ').trim();
                    if (!goodbyeText) {
                        await sock.sendMessage(groupId, {
                            text: `📝 *Usage:* \`.setgoodbye [message]\`

📌 *Available Variables:*
• \`{mention}\` — Tags the user
• \`{shownumber}\` — User's phone number
• \`{membercount}\` — Remaining member count
• \`{groupname}\` — Group name
• \`{time}\` — Current time
• \`{date}\` — Current date`
                        }, { quoted: msg });
                    } else {
                        await updateGroupSettings(groupId, { goodbyeMsg: goodbyeText });
                        const preview = replaceVariables(goodbyeText, {
                            mention: '@User',
                            shownumber: '88019XXXXXXXX',
                            membercount: 99,
                            groupname: 'Test Group'
                        });
                        await sock.sendMessage(groupId, {
                            text: `✅ Goodbye message has been set!\n\n📝 *Preview:*\n${preview}`
                        }, { quoted: msg });
                        addLog(`📝 Goodbye message set for group: ${groupId}`);
                    }
                    continue;
                }

                // ═══════════════════════════════════════════════
                // ═══ .mute ════════════════════════════════════
                // ═══════════════════════════════════════════════
                if (prefix === '.' && command === 'mute') {
                    const botIsAdmin = await isBotAdmin(sock, groupId);
                    if (!botIsAdmin) {
                        await sock.sendMessage(groupId, {
                            text: '⚠️ The bot must be an admin to mute users! Please promote the bot first.'
                        }, { quoted: msg });
                        continue;
                    }

                    if (args.length < 1) {
                        await sock.sendMessage(groupId, {
                            text: `📝 *Usage:* \`.mute [time] [target]\`

⏱️ *Time formats:* 10s, 30m, 1h, 1d
👤 *Target:* Reply to a message OR provide an 11-digit number

📝 *Examples:*
• \`.mute 30m\` (reply to someone's message)
• \`.mute 1h 01912345678\`
• \`.mute 1d 8801912345678\``
                        }, { quoted: msg });
                        continue;
                    }

                    const timeStr = args[0];
                    const duration = parseTimeString(timeStr);
                    if (!duration) {
                        await sock.sendMessage(groupId, {
                            text: '❌ Invalid time format! Use: `10s`, `30m`, `1h`, `1d`'
                        }, { quoted: msg });
                        continue;
                    }

                    const targetJid = getTargetJid(msg, args.slice(1));
                    if (!targetJid) {
                        await sock.sendMessage(groupId, {
                            text: '❌ Target not found! Reply to a message or provide a phone number.\n\nExample: `.mute 30m 01912345678`'
                        }, { quoted: msg });
                        continue;
                    }

                    // Don't mute the bot
                    if (normalizeJid(targetJid) === botJid) {
                        await sock.sendMessage(groupId, {
                            text: '❌ Cannot mute the bot!'
                        }, { quoted: msg });
                        continue;
                    }

                    // Don't mute admins
                    const targetIsAdmin = await isGroupAdmin(sock, groupId, targetJid);
                    if (targetIsAdmin) {
                        await sock.sendMessage(groupId, {
                            text: '❌ Cannot mute a group admin!'
                        }, { quoted: msg });
                        continue;
                    }

                    const expiresAt = Date.now() + duration;
                    await setMute(groupId, targetJid, expiresAt);

                    const expiryDate = new Date(expiresAt).toLocaleString('en-US', { timeZone: 'Asia/Dhaka' });

                    await sock.sendMessage(groupId, {
                        text: `🔇 *User has been muted!*

👤 User: @${jidToNumber(targetJid)}
⏱️ Duration: ${timeStr}
📅 Mute expires: ${expiryDate}

⚠️ All messages from this user will be automatically deleted until the mute expires.`,
                        mentions: [targetJid]
                    }, { quoted: msg });
                    addLog(`🔇 Muted: ${jidToNumber(targetJid)} for ${timeStr} in group: ${groupId}`);
                    continue;
                }

                // ═══════════════════════════════════════════════
                // ═══ .unmute ══════════════════════════════════
                // ═══════════════════════════════════════════════
                if (prefix === '.' && command === 'unmute') {
                    const targetJid = getTargetJid(msg, args);
                    if (!targetJid) {
                        await sock.sendMessage(groupId, {
                            text: '❌ Target not found! Reply to a message or provide a phone number.\n\nExample: `.unmute 01912345678`'
                        }, { quoted: msg });
                        continue;
                    }

                    const removed = await removeMute(groupId, targetJid);
                    if (removed) {
                        await sock.sendMessage(groupId, {
                            text: `🔊 *User has been unmuted!*\n\n👤 User: @${jidToNumber(targetJid)}\n✅ They can now send messages again.`,
                            mentions: [targetJid]
                        }, { quoted: msg });
                        addLog(`🔊 Unmuted: ${jidToNumber(targetJid)} in group: ${groupId}`);
                    } else {
                        await sock.sendMessage(groupId, {
                            text: `ℹ️ @${jidToNumber(targetJid)} is not in the mute list.`,
                            mentions: [targetJid]
                        }, { quoted: msg });
                    }
                    continue;
                }

                // ═══════════════════════════════════════════════
                // ═══ .antilink ════════════════════════════════
                // ═══════════════════════════════════════════════
                if (prefix === '.' && command === 'antilink') {
                    const toggle = args[0]?.toLowerCase();
                    if (toggle === 'on') {
                        const botIsAdmin = await isBotAdmin(sock, groupId);
                        if (!botIsAdmin) {
                            await sock.sendMessage(groupId, {
                                text: '⚠️ The bot must be an admin to enable antilink! Please promote the bot first.'
                            }, { quoted: msg });
                            continue;
                        }
                        await updateGroupSettings(groupId, { antilink: true });
                        await sock.sendMessage(groupId, {
                            text: '✅ Antilink has been *enabled*!\n\nAny message containing WhatsApp links will be automatically deleted.\n\n⚠️ Admins and the registered owner are exempt.'
                        }, { quoted: msg });
                        addLog(`🔗 Antilink ON for group: ${groupId}`);
                    } else if (toggle === 'off') {
                        await updateGroupSettings(groupId, { antilink: false });
                        await sock.sendMessage(groupId, {
                            text: '❌ Antilink has been *disabled*.'
                        }, { quoted: msg });
                        addLog(`🔗 Antilink OFF for group: ${groupId}`);
                    } else {
                        const settings = await getGroupSettings(groupId);
                        await sock.sendMessage(groupId, {
                            text: `📝 Usage: \`.antilink on\` or \`.antilink off\`\n\n📊 Current status: ${settings.antilink ? '✅ ON' : '❌ OFF'}`
                        }, { quoted: msg });
                    }
                    continue;
                }

                // ═══════════════════════════════════════════════
                // ═══ .filter ══════════════════════════════════
                // ═══════════════════════════════════════════════
                if (prefix === '.' && command === 'filter') {
                    if (args.length < 2) {
                        const settings = await getGroupSettings(groupId);
                        const filterKeys = Object.keys(settings.filters || {});

                        if (filterKeys.length === 0) {
                            await sock.sendMessage(groupId, {
                                text: `📝 *Usage:* \`.filter [word] [reply]\`

📝 *Example:* \`.filter spam Stop spamming in this group!\`

📋 No filters are currently set.
🗑️ Remove a filter: \`.removefilter [word]\``
                            }, { quoted: msg });
                        } else {
                            let listText = '📋 *Active Filters:*\n\n';
                            for (const [word, reply] of Object.entries(settings.filters)) {
                                listText += `• *${word}* → ${reply}\n`;
                            }
                            listText += `\n📝 Add: \`.filter [word] [reply]\`\n🗑️ Remove: \`.removefilter [word]\``;
                            await sock.sendMessage(groupId, { text: listText }, { quoted: msg });
                        }
                        continue;
                    }

                    const botIsAdmin = await isBotAdmin(sock, groupId);
                    if (!botIsAdmin) {
                        await sock.sendMessage(groupId, {
                            text: '⚠️ The bot must be an admin to enforce filters! Please promote the bot first.'
                        }, { quoted: msg });
                        continue;
                    }

                    const filterWord = args[0].toLowerCase();
                    const filterReply = args.slice(1).join(' ');

                    const settings = await getGroupSettings(groupId);
                    const filters = settings.filters || {};
                    filters[filterWord] = filterReply;
                    await updateGroupSettings(groupId, { filters: filters });

                    await sock.sendMessage(groupId, {
                        text: `✅ Filter has been set!\n\n🔤 Word: *${filterWord}*\n💬 Reply: ${filterReply}\n\n⚠️ When someone says "${filterWord}", their message will be deleted and they'll receive the reply.`
                    }, { quoted: msg });
                    addLog(`🚫 New filter: "${filterWord}" in group: ${groupId}`);
                    continue;
                }

                // ═══════════════════════════════════════════════
                // ═══ .removefilter ════════════════════════════
                // ═══════════════════════════════════════════════
                if (prefix === '.' && command === 'removefilter') {
                    if (args.length < 1) {
                        await sock.sendMessage(groupId, {
                            text: '📝 Usage: `.removefilter [word]`'
                        }, { quoted: msg });
                        continue;
                    }

                    const filterWord = args[0].toLowerCase();
                    const settings = await getGroupSettings(groupId);
                    const filters = settings.filters || {};

                    if (filters[filterWord]) {
                        delete filters[filterWord];
                        await updateGroupSettings(groupId, { filters: filters });
                        await sock.sendMessage(groupId, {
                            text: `✅ Filter "${filterWord}" has been removed.`
                        }, { quoted: msg });
                        addLog(`🗑️ Filter removed: "${filterWord}" from group: ${groupId}`);
                    } else {
                        await sock.sendMessage(groupId, {
                            text: `❌ No filter found with the word "${filterWord}".`
                        }, { quoted: msg });
                    }
                    continue;
                }

                // ═══════════════════════════════════════════════
                // ═══ .promote ═════════════════════════════════
                // ═══════════════════════════════════════════════
                if (prefix === '.' && command === 'promote') {
                    const botIsAdmin = await isBotAdmin(sock, groupId);
                    if (!botIsAdmin) {
                        await sock.sendMessage(groupId, {
                            text: '⚠️ The bot must be an admin to promote users! Please promote the bot first.'
                        }, { quoted: msg });
                        continue;
                    }

                    const targetJid = getTargetJid(msg, args);
                    if (!targetJid) {
                        await sock.sendMessage(groupId, {
                            text: '❌ Target not found! Reply to a message or provide a phone number.\n\nExamples:\n• `.promote` (reply to message)\n• `.promote 01912345678`'
                        }, { quoted: msg });
                        continue;
                    }

                    // Check if target is already admin
                    const alreadyAdmin = await isGroupAdmin(sock, groupId, targetJid);
                    if (alreadyAdmin) {
                        await sock.sendMessage(groupId, {
                            text: `ℹ️ @${jidToNumber(targetJid)} is already an admin!`,
                            mentions: [targetJid]
                        }, { quoted: msg });
                        continue;
                    }

                    try {
                        await sock.groupParticipantsUpdate(groupId, [targetJid], 'promote');
                        await sock.sendMessage(groupId, {
                            text: `✅ @${jidToNumber(targetJid)} has been promoted to admin! 🎉`,
                            mentions: [targetJid]
                        }, { quoted: msg });
                        addLog(`⬆️ Promoted: ${jidToNumber(targetJid)} in group: ${groupId}`);
                    } catch (e) {
                        await sock.sendMessage(groupId, {
                            text: `❌ Failed to promote: ${e.message}\n\nMake sure the user is in the group and the bot has admin rights.`
                        }, { quoted: msg });
                        addLog(`⚠️ Promote error: ${e.message}`);
                    }
                    continue;
                }

                // ═══════════════════════════════════════════════
                // ═══ .demote ══════════════════════════════════
                // ═══════════════════════════════════════════════
                if (prefix === '.' && command === 'demote') {
                    const botIsAdmin = await isBotAdmin(sock, groupId);
                    if (!botIsAdmin) {
                        await sock.sendMessage(groupId, {
                            text: '⚠️ The bot must be an admin to demote users!'
                        }, { quoted: msg });
                        continue;
                    }

                    const targetJid = getTargetJid(msg, args);
                    if (!targetJid) {
                        await sock.sendMessage(groupId, {
                            text: '❌ Target not found! Reply to a message or provide a phone number.'
                        }, { quoted: msg });
                        continue;
                    }

                    try {
                        await sock.groupParticipantsUpdate(groupId, [targetJid], 'demote');
                        await sock.sendMessage(groupId, {
                            text: `✅ @${jidToNumber(targetJid)} has been demoted from admin.`,
                            mentions: [targetJid]
                        }, { quoted: msg });
                        addLog(`⬇️ Demoted: ${jidToNumber(targetJid)} in group: ${groupId}`);
                    } catch (e) {
                        await sock.sendMessage(groupId, {
                            text: `❌ Failed to demote: ${e.message}`
                        }, { quoted: msg });
                    }
                    continue;
                }

                // ═══════════════════════════════════════════════
                // ═══ .kick ════════════════════════════════════
                // ═══════════════════════════════════════════════
                if (prefix === '.' && command === 'kick') {
                    const botIsAdmin = await isBotAdmin(sock, groupId);
                    if (!botIsAdmin) {
                        await sock.sendMessage(groupId, {
                            text: '⚠️ The bot must be an admin to kick users! Please promote the bot first.'
                        }, { quoted: msg });
                        continue;
                    }

                    const targetJid = getTargetJid(msg, args);
                    if (!targetJid) {
                        await sock.sendMessage(groupId, {
                            text: '❌ Target not found! Reply to a message or provide a phone number.\n\nExamples:\n• `.kick` (reply to message)\n• `.kick 01912345678`'
                        }, { quoted: msg });
                        continue;
                    }

                    // Don't kick the bot
                    if (normalizeJid(targetJid) === botJid) {
                        await sock.sendMessage(groupId, {
                            text: '❌ Cannot kick the bot! Use `!!goback` to make the bot leave.'
                        }, { quoted: msg });
                        continue;
                    }

                    // Don't kick other admins (unless sender is owner)
                    const targetIsAdmin = await isGroupAdmin(sock, groupId, targetJid);
                    if (targetIsAdmin) {
                        const senderIsOwner = await isRegisteredOwner(groupId, normalizedSender);
                        if (!senderIsOwner) {
                            await sock.sendMessage(groupId, {
                                text: '❌ Cannot kick an admin! Only the registered owner can kick admins.'
                            }, { quoted: msg });
                            continue;
                        }
                    }

                    try {
                        await sock.groupParticipantsUpdate(groupId, [targetJid], 'remove');
                        await sock.sendMessage(groupId, {
                            text: `✅ @${jidToNumber(targetJid)} has been removed from the group. 👢`,
                            mentions: [targetJid]
                        }, { quoted: msg });
                        addLog(`👢 Kicked: ${jidToNumber(targetJid)} from group: ${groupId}`);

                        // Also remove any mute for them
                        await removeMute(groupId, targetJid);
                    } catch (e) {
                        await sock.sendMessage(groupId, {
                            text: `❌ Failed to kick: ${e.message}\n\nMake sure the user is in the group.`
                        }, { quoted: msg });
                        addLog(`⚠️ Kick error: ${e.message}`);
                    }
                    continue;
                }

                // ═══════════════════════════════════════════════
                // ═══ .tagall ══════════════════════════════════
                // ═══════════════════════════════════════════════
                if (prefix === '.' && command === 'tagall') {
                    try {
                        const metadata = await sock.groupMetadata(groupId);
                        const participants = metadata.participants;
                        const tagText = args.join(' ') || '📢 Attention Everyone!';

                        let text = `📢 *${tagText}*\n\n`;
                        const mentions = [];

                        for (const p of participants) {
                            text += `• @${jidToNumber(p.id)}\n`;
                            mentions.push(p.id);
                        }

                        text += `\n👥 Total: ${participants.length} members`;

                        await sock.sendMessage(groupId, {
                            text: text,
                            mentions: mentions
                        }, { quoted: msg });
                        addLog(`📢 Tag all: ${participants.length} members in group: ${groupId}`);
                    } catch (e) {
                        await sock.sendMessage(groupId, {
                            text: `❌ Failed to tag all: ${e.message}`
                        }, { quoted: msg });
                    }
                    continue;
                }

                // ═══════════════════════════════════════════════
                // ═══ !reaction ════════════════════════════════
                // ═══════════════════════════════════════════════
                if (prefix === '!' && command === 'reaction') {
                    const toggle = args[0]?.toLowerCase();
                    if (toggle === 'on') {
                        await updateGroupSettings(groupId, { reaction: true });
                        const settings = await getGroupSettings(groupId);
                        await sock.sendMessage(groupId, {
                            text: `✅ Auto Reaction has been *enabled*! 😁\n\nThe bot will randomly react to messages with these emojis:\n${(settings.reactionEmojis || []).join(' ')}\n\nChange emojis: \`.reaction set [emojis]\``
                        }, { quoted: msg });
                        addLog(`😁 Reaction ON for group: ${groupId}`);
                    } else if (toggle === 'off') {
                        await updateGroupSettings(groupId, { reaction: false });
                        await sock.sendMessage(groupId, {
                            text: '❌ Auto Reaction has been *disabled*.'
                        }, { quoted: msg });
                        addLog(`😁 Reaction OFF for group: ${groupId}`);
                    } else {
                        const settings = await getGroupSettings(groupId);
                        await sock.sendMessage(groupId, {
                            text: `📝 Usage: \`!reaction on\` or \`!reaction off\`\n\n📊 Current status: ${settings.reaction ? '✅ ON' : '❌ OFF'}\n😁 Emojis: ${(settings.reactionEmojis || []).join(' ')}`
                        }, { quoted: msg });
                    }
                    continue;
                }

                // ═══════════════════════════════════════════════
                // ═══ .reaction set ════════════════════════════
                // ═══════════════════════════════════════════════
                if (prefix === '.' && command === 'reaction') {
                    const subCommand = args[0]?.toLowerCase();
                    if (subCommand === 'set') {
                        const emojis = args.slice(1).filter(e => e.trim() !== '');
                        if (emojis.length === 0) {
                            await sock.sendMessage(groupId, {
                                text: `📝 *Usage:* \`.reaction set [emojis]\`

📝 *Example:* \`.reaction set 😁 🙏 🌚 ❤️ 🔥\`

Separate emojis with spaces.`
                            }, { quoted: msg });
                        } else {
                            await updateGroupSettings(groupId, { reactionEmojis: emojis });
                            await sock.sendMessage(groupId, {
                                text: `✅ Reaction emojis have been set!\n\n${emojis.join(' ')}\n\nTotal: ${emojis.length} emojis`
                            }, { quoted: msg });
                            addLog(`😁 Reaction emojis updated for group: ${groupId}`);
                        }
                    } else {
                        const settings = await getGroupSettings(groupId);
                        await sock.sendMessage(groupId, {
                            text: `📋 *Auto Reaction Settings*

• Status: ${settings.reaction ? '✅ ON' : '❌ OFF'}
• Emojis: ${(settings.reactionEmojis || []).join(' ')}

📝 Commands:
• \`!reaction on/off\` — Toggle on/off
• \`.reaction set [emojis]\` — Set emojis`
                        }, { quoted: msg });
                    }
                    continue;
                }

            } catch (msgError) {
                addLog(`⚠️ Message processing error: ${msgError.message}`);
            }
        }
    });

    // ═══════════════════════════════════════════════════════════
    // ═══ PERIODIC MUTE CLEANUP (every 30 seconds) ════════════
    // ═══════════════════════════════════════════════════════════
    setInterval(async () => {
        try {
            const db = await readDb(MUTES_DB);
            let changed = false;
            const now = Date.now();

            for (const groupId of Object.keys(db)) {
                for (const userJid of Object.keys(db[groupId])) {
                    if (now >= db[groupId][userJid]) {
                        delete db[groupId][userJid];
                        changed = true;
                        addLog(`🔊 Mute expired (auto): ${jidToNumber(userJid)} in group: ${groupId}`);

                        try {
                            await sock.sendMessage(groupId, {
                                text: `🔊 @${jidToNumber(userJid)}'s mute has expired. They can now send messages again. ✅`,
                                mentions: [userJid]
                            });
                        } catch (e) { /* Group may no longer exist */ }
                    }
                }
                if (db[groupId] && Object.keys(db[groupId]).length === 0) {
                    delete db[groupId];
                    changed = true;
                }
            }

            if (changed) await writeDb(MUTES_DB, db);
        } catch (e) {
            // Silent cleanup error
        }
    }, 30000);

    addLog('✅ All event handlers have been set up successfully!');
    addLog('🤖 Xyron Rose Manager is ready and waiting for messages...');
}

// ═══════════════════════════════════════════════════════════════
// ═══ START ════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
startBot().catch(err => {
    addLog(`❌ Fatal Error: ${err.message}`);
    console.error(err);
});
