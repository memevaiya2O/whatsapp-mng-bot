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

const AUTH_DIR = '/tmp/auth_info';
const DB_DIR = path.join(__dirname, 'src', 'database');
const GROUPS_DB = path.join(DB_DIR, 'groups.json');
const MUTES_DB = path.join(DB_DIR, 'mutes.json');
const ADMINS_DB = path.join(DB_DIR, 'admins.json');

const BOT_NUMBER = process.env.BOT_NUMBER || '';
const PORT = process.env.PORT || 3000;

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

const app = express();

app.get('/', (req, res) => {
    const logHtml = logs.slice().reverse().map(l => `<div class="log-entry">${l}</div>`).join('');
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Xyron Rose Manager</title>
        <style>
            *{margin:0;padding:0;box-sizing:border-box}
            body{background:#0d1117;color:#c9d1d9;font-family:'Segoe UI',monospace;padding:20px}
            .header{text-align:center;padding:30px;border-bottom:2px solid #30363d;margin-bottom:20px}
            .header h1{color:#58a6ff;font-size:28px}
            .header p{color:#8b949e;margin-top:5px}
            .status-box{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:20px;margin-bottom:20px;text-align:center}
            .status{font-size:20px;font-weight:bold}
            .connected{color:#3fb950}.disconnected{color:#f85149}.connecting{color:#d29922}
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
            <div>📱 Pairing Code</div>
            <div class="pairing-code">${pairingCode}</div>
            <div class="pairing-note">WhatsApp → Settings → Linked Devices → Link a Device → Link with Phone Number</div>
        </div>` : ''}
        <div class="logs-container">
            <h2>📋 Live Logs</h2>
            ${logHtml || '<div class="log-entry">No logs yet...</div>'}
        </div>
        <div class="footer">
            <p>© 2024 Xyron Rose Manager | Developer: Prime Xyron | t.me/prime_xyron</p>
        </div>
    </body>
    </html>
    `);
});

app.listen(PORT, () => {
    addLog(`Web panel started on port ${PORT}`);
});

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
        return {};
    }
}

async function writeDb(filePath, data) {
    try {
        await fs.writeJson(filePath, data, { spaces: 2 });
    } catch (e) {
        addLog(`DB write error: ${e.message}`);
    }
}

const DEFAULT_GROUP_SETTINGS = {
    welcome: false,
    goodbye: false,
    welcomeMsg: '🎉 Welcome {mention}!\n👤 Number: {shownumber}\n👥 Members: {membercount}\n🏷️ Group: {groupname}\n🕐 Time: {time}\n📅 Date: {date}',
    goodbyeMsg: '👋 Goodbye {mention}!\n🏷️ Group: {groupname}\n👥 Remaining: {membercount}',
    antilink: false,
    filters: {},
    reaction: false,
    reactionEmojis: ['😁', '🙏', '❤️', '🔥', '👍'],
    cleanservice: false
};

async function getGroupSettings(groupId) {
    const db = await readDb(GROUPS_DB);
    if (!db[groupId]) {
        db[groupId] = JSON.parse(JSON.stringify(DEFAULT_GROUP_SETTINGS));
        await writeDb(GROUPS_DB, db);
    }
    let changed = false;
    for (const key of Object.keys(DEFAULT_GROUP_SETTINGS)) {
        if (db[groupId][key] === undefined) {
            if (key === 'filters') {
                db[groupId][key] = {};
            } else if (key === 'reactionEmojis') {
                db[groupId][key] = [...DEFAULT_GROUP_SETTINGS[key]];
            } else {
                db[groupId][key] = DEFAULT_GROUP_SETTINGS[key];
            }
            changed = true;
        }
    }
    if (changed) await writeDb(GROUPS_DB, db);
    return db[groupId];
}

async function updateGroupSettings(groupId, updates) {
    const db = await readDb(GROUPS_DB);
    if (!db[groupId]) {
        db[groupId] = JSON.parse(JSON.stringify(DEFAULT_GROUP_SETTINGS));
    }
    for (const [key, value] of Object.entries(updates)) {
        db[groupId][key] = value;
    }
    await writeDb(GROUPS_DB, db);
    return db[groupId];
}

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

async function setOwner(groupId, userJid) {
    const db = await readDb(ADMINS_DB);
    db[groupId] = normalizeJid(userJid);
    await writeDb(ADMINS_DB, db);
}

async function getOwner(groupId) {
    const db = await readDb(ADMINS_DB);
    return db[groupId] || null;
}

function getBotJid(sock) {
    if (!sock.user || !sock.user.id) return '';
    return normalizeJid(sock.user.id);
}

async function fetchGroupMetadataSafe(sock, groupId) {
    try {
        const metadata = await sock.groupMetadata(groupId);
        return metadata;
    } catch (e) {
        addLog(`Failed to fetch metadata for ${groupId}: ${e.message}`);
        return null;
    }
}

async function isBotAdmin(sock, groupId) {
    const metadata = await fetchGroupMetadataSafe(sock, groupId);
    if (!metadata) return false;

    const botJid = getBotJid(sock);
    const botNumber = botJid.split('@')[0];

    for (const participant of metadata.participants) {
        const pNumber = participant.id.split('@')[0].split(':')[0];
        if (pNumber === botNumber) {
            if (participant.admin === 'admin' || participant.admin === 'superadmin') {
                return true;
            }
            return false;
        }
    }
    return false;
}

async function isGroupAdmin(sock, groupId, userJid) {
    const metadata = await fetchGroupMetadataSafe(sock, groupId);
    if (!metadata) return false;

    const userNumber = normalizeJid(userJid).split('@')[0];

    for (const participant of metadata.participants) {
        const pNumber = participant.id.split('@')[0].split(':')[0];
        if (pNumber === userNumber) {
            if (participant.admin === 'admin' || participant.admin === 'superadmin') {
                return true;
            }
            return false;
        }
    }
    return false;
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
    const contextInfo = msg.message?.extendedTextMessage?.contextInfo
        || msg.message?.imageMessage?.contextInfo
        || msg.message?.videoMessage?.contextInfo;

    if (contextInfo && contextInfo.participant) {
        return normalizeJid(contextInfo.participant);
    }

    if (contextInfo && contextInfo.mentionedJid && contextInfo.mentionedJid.length > 0) {
        return normalizeJid(contextInfo.mentionedJid[0]);
    }

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
    if (msg.key.fromMe) return true;
    const botJid = getBotJid(sock);
    const senderJid = msg.key.participant || msg.key.remoteJid;
    if (normalizeJid(senderJid) === botJid) return true;
    const botNumber = botJid.split('@')[0];
    const senderNumber = normalizeJid(senderJid).split('@')[0];
    if (botNumber === senderNumber) return true;
    return false;
}

async function startBot() {
    await ensureDbFiles();
    addLog('Xyron Rose Manager is starting...');

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    addLog(`Baileys version: ${version.join('.')}`);

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

    if (!sock.authState.creds.registered) {
        addLog('Generating pairing code...');
        connectionStatus = 'connecting';
        await new Promise(resolve => setTimeout(resolve, 3000));

        try {
            let phoneNumber = BOT_NUMBER.replace(/[^0-9]/g, '');
            if (phoneNumber.length === 11 && phoneNumber.startsWith('0')) {
                phoneNumber = '88' + phoneNumber;
            }
            addLog(`Requesting pairing code for: ${phoneNumber}`);
            const code = await sock.requestPairingCode(phoneNumber);
            pairingCode = code;
            addLog(`Pairing Code: ${code}`);
        } catch (e) {
            addLog(`Pairing code error: ${e.message}`);
        }
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            connectionStatus = 'connected';
            pairingCode = null;
            addLog('Successfully connected to WhatsApp!');
            addLog(`Bot JID: ${sock.user?.id}`);
            addLog(`Normalized: ${getBotJid(sock)}`);
        }

        if (connection === 'close') {
            connectionStatus = 'disconnected';
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            addLog(`Connection closed. Code: ${statusCode}`);

            if (statusCode === DisconnectReason.loggedOut) {
                addLog('Logged out. Clearing auth...');
                await fs.remove(AUTH_DIR);
                setTimeout(startBot, 5000);
            } else {
                addLog('Reconnecting in 5s...');
                setTimeout(startBot, 5000);
            }
        }

        if (connection === 'connecting') {
            connectionStatus = 'connecting';
            addLog('Connecting...');
        }
    });

    sock.ev.on('group-participants.update', async (event) => {
        try {
            const { id: groupId, participants, action } = event;
            const settings = await getGroupSettings(groupId);

            const metadata = await fetchGroupMetadataSafe(sock, groupId);
            if (!metadata) return;

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
                        await sock.sendMessage(groupId, { text: text, mentions: [participant] });
                        addLog(`Welcome sent in: ${metadata.subject}`);
                    } catch (e) {}
                }

                if (action === 'remove' && settings.goodbye) {
                    const text = replaceVariables(settings.goodbyeMsg, vars);
                    try {
                        await sock.sendMessage(groupId, { text: text, mentions: [participant] });
                        addLog(`Goodbye sent in: ${metadata.subject}`);
                    } catch (e) {}
                }

                if (action === 'remove') {
                    await removeMute(groupId, participant);
                }
            }
        } catch (e) {
            addLog(`Participant update error: ${e.message}`);
        }
    });

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

                if (msg.messageStubType) {
                    const settings = await getGroupSettings(groupId);
                    if (settings.cleanservice) {
                        try {
                            await sock.sendMessage(groupId, { delete: msg.key });
                        } catch (e) {}
                    }
                    continue;
                }

                const contentType = getContentType(msg.message);
                if (contentType === 'protocolMessage' || contentType === 'senderKeyDistributionMessage') {
                    continue;
                }

                const body = getMessageText(msg);

                if (!selfMsg) {
                    const muted = await isUserMuted(groupId, normalizedSender);
                    if (muted) {
                        try {
                            const botAdmin = await isBotAdmin(sock, groupId);
                            if (botAdmin) {
                                await sock.sendMessage(groupId, { delete: msg.key });
                                addLog(`Deleted muted user msg: ${jidToNumber(senderJid)}`);
                            }
                        } catch (e) {}
                        continue;
                    }
                }

                if (!selfMsg && body) {
                    const settings = await getGroupSettings(groupId);
                    if (settings.antilink) {
                        const hasLink = /chat\.whatsapp\.com|wa\.me/i.test(body);
                        if (hasLink) {
                            const senderIsAuth = await isAuthorized(sock, groupId, normalizedSender);
                            if (!senderIsAuth) {
                                const botAdmin = await isBotAdmin(sock, groupId);
                                if (botAdmin) {
                                    try {
                                        await sock.sendMessage(groupId, { delete: msg.key });
                                        await sock.sendMessage(groupId, {
                                            text: `⚠️ @${jidToNumber(senderJid)}, sharing links is not allowed in this group! Your message has been deleted.`,
                                            mentions: [senderJid]
                                        });
                                        addLog(`Antilink: deleted from ${jidToNumber(senderJid)}`);
                                    } catch (e) {}
                                }
                                continue;
                            }
                        }
                    }
                }

                if (!selfMsg && body) {
                    const settings = await getGroupSettings(groupId);
                    if (settings.filters && Object.keys(settings.filters).length > 0) {
                        const lowerBody = body.toLowerCase();
                        let filtered = false;

                        for (const [filterWord, filterReply] of Object.entries(settings.filters)) {
                            if (lowerBody.includes(filterWord.toLowerCase())) {
                                const senderIsAuth = await isAuthorized(sock, groupId, normalizedSender);
                                if (!senderIsAuth) {
                                    const botAdmin = await isBotAdmin(sock, groupId);
                                    if (botAdmin) {
                                        try {
                                            await sock.sendMessage(groupId, { delete: msg.key });
                                            await sock.sendMessage(groupId, {
                                                text: `⚠️ @${jidToNumber(senderJid)}, ${filterReply}`,
                                                mentions: [senderJid]
                                            });
                                            addLog(`Filter "${filterWord}" triggered by ${jidToNumber(senderJid)}`);
                                        } catch (e) {}
                                    }
                                }
                                filtered = true;
                                break;
                            }
                        }
                        if (filtered) continue;
                    }
                }

                if (!selfMsg) {
                    const settings = await getGroupSettings(groupId);
                    if (settings.reaction && settings.reactionEmojis && settings.reactionEmojis.length > 0) {
                        const randomEmoji = settings.reactionEmojis[Math.floor(Math.random() * settings.reactionEmojis.length)];
                        try {
                            await sock.sendMessage(groupId, { react: { text: randomEmoji, key: msg.key } });
                        } catch (e) {}
                    }
                }

                if (body && body.toLowerCase().includes('made by')) {
                    try {
                        await sock.sendMessage(groupId, {
                            text: '🤖 *Xyron Rose Manager*\n👨‍💻 Developer: Prime Xyron\n📢 t.me/prime_xyron'
                        }, { quoted: msg });
                    } catch (e) {}
                }

                if (!body || body.length === 0) continue;

                let command = '';
                let args = [];
                let prefix = '';

                if (body.startsWith('!!')) {
                    prefix = '!!';
                    const rest = body.slice(2).trim().split(/\s+/);
                    command = rest.shift()?.toLowerCase() || '';
                    args = rest;
                } else if (body.startsWith('!')) {
                    prefix = '!';
                    const rest = body.slice(1).trim().split(/\s+/);
                    command = rest.shift()?.toLowerCase() || '';
                    args = rest;
                } else if (body.startsWith('.')) {
                    prefix = '.';
                    const rest = body.slice(1).trim().split(/\s+/);
                    command = rest.shift()?.toLowerCase() || '';
                    args = rest;
                } else {
                    continue;
                }

                if (!command) continue;

                addLog(`CMD: ${prefix}${command} | Args: [${args.join(', ')}] | From: ${jidToNumber(senderJid)}`);

                if (prefix === '!!' && command === 'help') {
                    const helpText = `╔═══════════════════════════════════╗
║     🤖 *XYRON ROSE MANAGER*       ║
║   Group Management Bot v2.0       ║
╚═══════════════════════════════════╝

📋 *COMMAND LIST:*

━━━ 👑 *SETUP & ADMIN* ━━━
• \`!addme\` — Register as group owner
• \`!!goback\` — Bot leaves group (Owner only)
• \`!!verify\` — Check if bot has admin rights
• \`!cleanservice on/off\` — Auto-delete system msgs

━━━ 👋 *WELCOME & GOODBYE* ━━━
• \`.welcome on/off\` — Toggle welcome messages
• \`.goodbye on/off\` — Toggle goodbye messages
• \`.setwelcome [text]\` — Set welcome message
• \`.setgoodbye [text]\` — Set goodbye message

📝 *Variables:*
\`{mention}\` \`{shownumber}\` \`{membercount}\`
\`{time}\` \`{date}\` \`{groupname}\`

━━━ 🔇 *MUTE & SECURITY* ━━━
• \`.mute [time] [target]\` — Mute user (10m/1h/1d)
• \`.unmute [target]\` — Unmute user
• \`.antilink on/off\` — Block links
• \`.filter [word] [reply]\` — Set word filter
• \`.removefilter [word]\` — Remove filter

━━━ 🛡️ *MODERATION* ━━━
• \`.promote [target]\` — Promote to admin
• \`.demote [target]\` — Demote from admin
• \`.kick [target]\` — Remove from group
• \`.tagall [text]\` — Tag all members

━━━ 😁 *AUTO REACTION* ━━━
• \`!reaction on/off\` — Toggle reactions
• \`.reaction set [emojis]\` — Set emojis

━━━━━━━━━━━━━━━━━━━━━━━
👨‍💻 *Developer:* Prime Xyron
📢 *Telegram:* t.me/prime_xyron
━━━━━━━━━━━━━━━━━━━━━━━`;

                    await sock.sendMessage(groupId, { text: helpText }, { quoted: msg });
                    continue;
                }

                if (prefix === '!!' && command === 'verify') {
                    const botAdmin = await isBotAdmin(sock, groupId);
                    const metadata = await fetchGroupMetadataSafe(sock, groupId);
                    const groupName = metadata ? metadata.subject : 'Unknown';

                    if (botAdmin) {
                        await sock.sendMessage(groupId, {
                            text: `✅ *Verification Successful!*\n\n🤖 Bot has admin rights in this group.\n🏷️ Group: ${groupName}\n\nAll features are fully operational. You can now use all commands.`
                        }, { quoted: msg });
                        addLog(`Verify: Bot IS admin in ${groupName}`);
                    } else {
                        await sock.sendMessage(groupId, {
                            text: `❌ *Verification Failed!*\n\n🤖 Bot does NOT have admin rights in this group.\n🏷️ Group: ${groupName}\n\n⚠️ Please promote the bot to admin to use features like:\n• Antilink\n• Filter\n• Mute\n• Kick/Promote\n• Clean Service`
                        }, { quoted: msg });
                        addLog(`Verify: Bot is NOT admin in ${groupName}`);
                    }
                    continue;
                }

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
                        addLog(`Owner registered: ${jidToNumber(senderJid)} for ${groupId}`);
                    }
                    continue;
                }

                const authorized = await isAuthorized(sock, groupId, normalizedSender);
                if (!authorized) {
                    await sock.sendMessage(groupId, {
                        text: '❌ You do not have permission. Only group admins or the registered owner can use bot commands.'
                    }, { quoted: msg });
                    continue;
                }

                if (prefix === '!!' && command === 'goback') {
                    const isOwner = await isRegisteredOwner(groupId, normalizedSender);
                    if (!isOwner) {
                        await sock.sendMessage(groupId, {
                            text: '❌ Only the registered owner can make the bot leave.'
                        }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(groupId, {
                        text: '👋 Goodbye! Xyron Rose Manager is leaving...\n🤖 Add me back anytime!\n📢 t.me/prime_xyron'
                    });
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    try {
                        await sock.groupLeave(groupId);
                        addLog(`Bot left group: ${groupId}`);
                    } catch (e) {
                        addLog(`Leave error: ${e.message}`);
                    }
                    continue;
                }

                if (prefix === '!' && command === 'cleanservice') {
                    const toggle = args[0]?.toLowerCase();
                    if (toggle === 'on') {
                        await updateGroupSettings(groupId, { cleanservice: true });
                        await sock.sendMessage(groupId, {
                            text: '✅ Clean Service *enabled*.\nSystem messages will be auto-deleted.'
                        }, { quoted: msg });
                    } else if (toggle === 'off') {
                        await updateGroupSettings(groupId, { cleanservice: false });
                        await sock.sendMessage(groupId, {
                            text: '❌ Clean Service *disabled*.'
                        }, { quoted: msg });
                    } else {
                        const s = await getGroupSettings(groupId);
                        await sock.sendMessage(groupId, {
                            text: `📝 Usage: \`!cleanservice on\` or \`!cleanservice off\`\nCurrent: ${s.cleanservice ? '✅ ON' : '❌ OFF'}`
                        }, { quoted: msg });
                    }
                    continue;
                }

                if (prefix === '.' && command === 'welcome') {
                    const toggle = args[0]?.toLowerCase();
                    if (toggle === 'on') {
                        await updateGroupSettings(groupId, { welcome: true });
                        await sock.sendMessage(groupId, {
                            text: '✅ Welcome messages *enabled*!'
                        }, { quoted: msg });
                    } else if (toggle === 'off') {
                        await updateGroupSettings(groupId, { welcome: false });
                        await sock.sendMessage(groupId, {
                            text: '❌ Welcome messages *disabled*.'
                        }, { quoted: msg });
                    } else {
                        const s = await getGroupSettings(groupId);
                        await sock.sendMessage(groupId, {
                            text: `📝 Usage: \`.welcome on\` or \`.welcome off\`\nCurrent: ${s.welcome ? '✅ ON' : '❌ OFF'}`
                        }, { quoted: msg });
                    }
                    continue;
                }

                if (prefix === '.' && command === 'goodbye') {
                    const toggle = args[0]?.toLowerCase();
                    if (toggle === 'on') {
                        await updateGroupSettings(groupId, { goodbye: true });
                        await sock.sendMessage(groupId, {
                            text: '✅ Goodbye messages *enabled*!'
                        }, { quoted: msg });
                    } else if (toggle === 'off') {
                        await updateGroupSettings(groupId, { goodbye: false });
                        await sock.sendMessage(groupId, {
                            text: '❌ Goodbye messages *disabled*.'
                        }, { quoted: msg });
                    } else {
                        const s = await getGroupSettings(groupId);
                        await sock.sendMessage(groupId, {
                            text: `📝 Usage: \`.goodbye on\` or \`.goodbye off\`\nCurrent: ${s.goodbye ? '✅ ON' : '❌ OFF'}`
                        }, { quoted: msg });
                    }
                    continue;
                }

                if (prefix === '.' && command === 'setwelcome') {
                    const welcomeText = args.join(' ').trim();
                    if (!welcomeText) {
                        await sock.sendMessage(groupId, {
                            text: `📝 *Usage:* \`.setwelcome [message]\`\n\n📌 *Variables:*\n• \`{mention}\` — Tags user\n• \`{shownumber}\` — Phone number\n• \`{membercount}\` — Member count\n• \`{groupname}\` — Group name\n• \`{time}\` — Current time\n• \`{date}\` — Current date\n\n📝 *Example:*\n\`.setwelcome 🎉 Welcome {mention} to {groupname}!\``
                        }, { quoted: msg });
                    } else {
                        await updateGroupSettings(groupId, { welcomeMsg: welcomeText });
                        const preview = replaceVariables(welcomeText, {
                            mention: '@User', shownumber: '88019XXXXXXXX', membercount: 100, groupname: 'Test Group'
                        });
                        await sock.sendMessage(groupId, {
                            text: `✅ Welcome message set!\n\n📝 *Preview:*\n${preview}`
                        }, { quoted: msg });
                    }
                    continue;
                }

                if (prefix === '.' && command === 'setgoodbye') {
                    const goodbyeText = args.join(' ').trim();
                    if (!goodbyeText) {
                        await sock.sendMessage(groupId, {
                            text: `📝 *Usage:* \`.setgoodbye [message]\`\n\n📌 *Variables:*\n• \`{mention}\` — Tags user\n• \`{shownumber}\` — Phone number\n• \`{membercount}\` — Remaining count\n• \`{groupname}\` — Group name\n• \`{time}\` — Time\n• \`{date}\` — Date`
                        }, { quoted: msg });
                    } else {
                        await updateGroupSettings(groupId, { goodbyeMsg: goodbyeText });
                        const preview = replaceVariables(goodbyeText, {
                            mention: '@User', shownumber: '88019XXXXXXXX', membercount: 99, groupname: 'Test Group'
                        });
                        await sock.sendMessage(groupId, {
                            text: `✅ Goodbye message set!\n\n📝 *Preview:*\n${preview}`
                        }, { quoted: msg });
                    }
                    continue;
                }

                if (prefix === '.' && command === 'mute') {
                    const botAdmin = await isBotAdmin(sock, groupId);
                    if (!botAdmin) {
                        await sock.sendMessage(groupId, {
                            text: '⚠️ Bot must be admin to mute users! Use `!!verify` to check.'
                        }, { quoted: msg });
                        continue;
                    }

                    if (args.length < 1) {
                        await sock.sendMessage(groupId, {
                            text: `📝 *Usage:* \`.mute [time] [target]\`\n\n⏱️ *Time:* 10s, 30m, 1h, 1d\n👤 *Target:* Reply to msg OR phone number\n\n📝 *Examples:*\n• \`.mute 30m\` (reply to someone)\n• \`.mute 1h 01912345678\``
                        }, { quoted: msg });
                        continue;
                    }

                    const timeStr = args[0];
                    const duration = parseTimeString(timeStr);
                    if (!duration) {
                        await sock.sendMessage(groupId, {
                            text: '❌ Invalid time! Use: `10s`, `30m`, `1h`, `1d`'
                        }, { quoted: msg });
                        continue;
                    }

                    const targetJid = getTargetJid(msg, args.slice(1));
                    if (!targetJid) {
                        await sock.sendMessage(groupId, {
                            text: '❌ Target not found! Reply to a message or provide a number.'
                        }, { quoted: msg });
                        continue;
                    }

                    if (normalizeJid(targetJid).split('@')[0] === botJid.split('@')[0]) {
                        await sock.sendMessage(groupId, { text: '❌ Cannot mute the bot!' }, { quoted: msg });
                        continue;
                    }

                    const targetIsAdmin = await isGroupAdmin(sock, groupId, targetJid);
                    if (targetIsAdmin) {
                        await sock.sendMessage(groupId, { text: '❌ Cannot mute a group admin!' }, { quoted: msg });
                        continue;
                    }

                    const expiresAt = Date.now() + duration;
                    await setMute(groupId, targetJid, expiresAt);
                    const expiryDate = new Date(expiresAt).toLocaleString('en-US', { timeZone: 'Asia/Dhaka' });

                    await sock.sendMessage(groupId, {
                        text: `🔇 *User Muted!*\n\n👤 User: @${jidToNumber(targetJid)}\n⏱️ Duration: ${timeStr}\n📅 Expires: ${expiryDate}\n\n⚠️ All their messages will be auto-deleted.`,
                        mentions: [targetJid]
                    }, { quoted: msg });
                    addLog(`Muted: ${jidToNumber(targetJid)} for ${timeStr}`);
                    continue;
                }

                if (prefix === '.' && command === 'unmute') {
                    const targetJid = getTargetJid(msg, args);
                    if (!targetJid) {
                        await sock.sendMessage(groupId, {
                            text: '❌ Target not found! Reply to a message or provide a number.'
                        }, { quoted: msg });
                        continue;
                    }

                    const removed = await removeMute(groupId, targetJid);
                    if (removed) {
                        await sock.sendMessage(groupId, {
                            text: `🔊 *User Unmuted!*\n\n👤 User: @${jidToNumber(targetJid)}\n✅ They can send messages again.`,
                            mentions: [targetJid]
                        }, { quoted: msg });
                    } else {
                        await sock.sendMessage(groupId, {
                            text: `ℹ️ @${jidToNumber(targetJid)} is not muted.`,
                            mentions: [targetJid]
                        }, { quoted: msg });
                    }
                    continue;
                }

                if (prefix === '.' && command === 'antilink') {
                    const toggle = args[0]?.toLowerCase();
                    if (toggle === 'on') {
                        const botAdmin = await isBotAdmin(sock, groupId);
                        if (!botAdmin) {
                            await sock.sendMessage(groupId, {
                                text: '⚠️ Bot must be admin first! Use `!!verify` to check.'
                            }, { quoted: msg });
                            continue;
                        }
                        await updateGroupSettings(groupId, { antilink: true });
                        await sock.sendMessage(groupId, {
                            text: '✅ Antilink *enabled*!\nMessages with WhatsApp links will be deleted.\n\n⚠️ Admins & owner are exempt.'
                        }, { quoted: msg });
                    } else if (toggle === 'off') {
                        await updateGroupSettings(groupId, { antilink: false });
                        await sock.sendMessage(groupId, {
                            text: '❌ Antilink *disabled*.'
                        }, { quoted: msg });
                    } else {
                        const s = await getGroupSettings(groupId);
                        await sock.sendMessage(groupId, {
                            text: `📝 Usage: \`.antilink on\` or \`.antilink off\`\nCurrent: ${s.antilink ? '✅ ON' : '❌ OFF'}`
                        }, { quoted: msg });
                    }
                    continue;
                }

                if (prefix === '.' && command === 'filter') {
                    const botAdmin = await isBotAdmin(sock, groupId);
                    if (!botAdmin) {
                        await sock.sendMessage(groupId, {
                            text: '⚠️ Bot must be admin to enforce filters! Use `!!verify` to check.'
                        }, { quoted: msg });
                        continue;
                    }

                    if (args.length < 2) {
                        const settings = await getGroupSettings(groupId);
                        const filterKeys = Object.keys(settings.filters || {});

                        if (filterKeys.length === 0) {
                            await sock.sendMessage(groupId, {
                                text: `📝 *Usage:* \`.filter [word] [reply]\`\n\n📝 *Example:* \`.filter spam No spamming!\`\n\n📋 No active filters.\n🗑️ Remove: \`.removefilter [word]\``
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

                    const filterWord = args[0].toLowerCase();
                    const filterReply = args.slice(1).join(' ');
                    const settings = await getGroupSettings(groupId);
                    const filters = settings.filters || {};
                    filters[filterWord] = filterReply;
                    await updateGroupSettings(groupId, { filters: filters });

                    await sock.sendMessage(groupId, {
                        text: `✅ Filter set!\n\n🔤 Word: *${filterWord}*\n💬 Reply: ${filterReply}\n\n⚠️ Messages containing "${filterWord}" will be deleted.`
                    }, { quoted: msg });
                    addLog(`Filter added: "${filterWord}" in ${groupId}`);
                    continue;
                }

                if (prefix === '.' && command === 'removefilter') {
                    if (args.length < 1) {
                        await sock.sendMessage(groupId, { text: '📝 Usage: `.removefilter [word]`' }, { quoted: msg });
                        continue;
                    }

                    const filterWord = args[0].toLowerCase();
                    const settings = await getGroupSettings(groupId);
                    const filters = settings.filters || {};

                    if (filters[filterWord]) {
                        delete filters[filterWord];
                        await updateGroupSettings(groupId, { filters: filters });
                        await sock.sendMessage(groupId, {
                            text: `✅ Filter "${filterWord}" removed.`
                        }, { quoted: msg });
                    } else {
                        await sock.sendMessage(groupId, {
                            text: `❌ No filter found: "${filterWord}"`
                        }, { quoted: msg });
                    }
                    continue;
                }

                if (prefix === '.' && command === 'promote') {
                    const botAdmin = await isBotAdmin(sock, groupId);
                    if (!botAdmin) {
                        await sock.sendMessage(groupId, {
                            text: '⚠️ Bot must be admin to promote! Use `!!verify` to check.'
                        }, { quoted: msg });
                        continue;
                    }

                    const targetJid = getTargetJid(msg, args);
                    if (!targetJid) {
                        await sock.sendMessage(groupId, {
                            text: '❌ Target not found! Reply to a message or provide a number.\n\nExamples:\n• `.promote` (reply)\n• `.promote 01912345678`'
                        }, { quoted: msg });
                        continue;
                    }

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
                        addLog(`Promoted: ${jidToNumber(targetJid)} in ${groupId}`);
                    } catch (e) {
                        await sock.sendMessage(groupId, {
                            text: `❌ Promote failed: ${e.message}`
                        }, { quoted: msg });
                    }
                    continue;
                }

                if (prefix === '.' && command === 'demote') {
                    const botAdmin = await isBotAdmin(sock, groupId);
                    if (!botAdmin) {
                        await sock.sendMessage(groupId, {
                            text: '⚠️ Bot must be admin to demote!'
                        }, { quoted: msg });
                        continue;
                    }

                    const targetJid = getTargetJid(msg, args);
                    if (!targetJid) {
                        await sock.sendMessage(groupId, {
                            text: '❌ Target not found! Reply or provide a number.'
                        }, { quoted: msg });
                        continue;
                    }

                    try {
                        await sock.groupParticipantsUpdate(groupId, [targetJid], 'demote');
                        await sock.sendMessage(groupId, {
                            text: `✅ @${jidToNumber(targetJid)} has been demoted.`,
                            mentions: [targetJid]
                        }, { quoted: msg });
                        addLog(`Demoted: ${jidToNumber(targetJid)} in ${groupId}`);
                    } catch (e) {
                        await sock.sendMessage(groupId, {
                            text: `❌ Demote failed: ${e.message}`
                        }, { quoted: msg });
                    }
                    continue;
                }

                if (prefix === '.' && command === 'kick') {
                    const botAdmin = await isBotAdmin(sock, groupId);
                    if (!botAdmin) {
                        await sock.sendMessage(groupId, {
                            text: '⚠️ Bot must be admin to kick! Use `!!verify` to check.'
                        }, { quoted: msg });
                        continue;
                    }

                    const targetJid = getTargetJid(msg, args);
                    if (!targetJid) {
                        await sock.sendMessage(groupId, {
                            text: '❌ Target not found! Reply or provide a number.\n\nExamples:\n• `.kick` (reply)\n• `.kick 01912345678`'
                        }, { quoted: msg });
                        continue;
                    }

                    if (normalizeJid(targetJid).split('@')[0] === botJid.split('@')[0]) {
                        await sock.sendMessage(groupId, {
                            text: '❌ Cannot kick the bot! Use `!!goback` instead.'
                        }, { quoted: msg });
                        continue;
                    }

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
                            text: `✅ @${jidToNumber(targetJid)} has been removed. 👢`,
                            mentions: [targetJid]
                        }, { quoted: msg });
                        addLog(`Kicked: ${jidToNumber(targetJid)} from ${groupId}`);
                        await removeMute(groupId, targetJid);
                    } catch (e) {
                        await sock.sendMessage(groupId, {
                            text: `❌ Kick failed: ${e.message}`
                        }, { quoted: msg });
                    }
                    continue;
                }

                if (prefix === '.' && command === 'tagall') {
                    try {
                        const metadata = await fetchGroupMetadataSafe(sock, groupId);
                        if (!metadata) {
                            await sock.sendMessage(groupId, { text: '❌ Could not fetch group info.' }, { quoted: msg });
                            continue;
                        }
                        const participants = metadata.participants;
                        const tagText = args.join(' ') || '📢 Attention Everyone!';

                        let text = `📢 *${tagText}*\n\n`;
                        const mentions = [];

                        for (const p of participants) {
                            text += `• @${jidToNumber(p.id)}\n`;
                            mentions.push(p.id);
                        }

                        text += `\n👥 Total: ${participants.length} members`;
                        await sock.sendMessage(groupId, { text: text, mentions: mentions }, { quoted: msg });
                        addLog(`Tag all: ${participants.length} in ${groupId}`);
                    } catch (e) {
                        await sock.sendMessage(groupId, { text: `❌ Tag all failed: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                if (prefix === '!' && command === 'reaction') {
                    const toggle = args[0]?.toLowerCase();
                    if (toggle === 'on') {
                        await updateGroupSettings(groupId, { reaction: true });
                        const s = await getGroupSettings(groupId);
                        await sock.sendMessage(groupId, {
                            text: `✅ Auto Reaction *enabled*! 😁\n\nEmojis: ${(s.reactionEmojis || []).join(' ')}\nChange: \`.reaction set [emojis]\``
                        }, { quoted: msg });
                    } else if (toggle === 'off') {
                        await updateGroupSettings(groupId, { reaction: false });
                        await sock.sendMessage(groupId, {
                            text: '❌ Auto Reaction *disabled*.'
                        }, { quoted: msg });
                    } else {
                        const s = await getGroupSettings(groupId);
                        await sock.sendMessage(groupId, {
                            text: `📝 Usage: \`!reaction on\` or \`!reaction off\`\nCurrent: ${s.reaction ? '✅ ON' : '❌ OFF'}\nEmojis: ${(s.reactionEmojis || []).join(' ')}`
                        }, { quoted: msg });
                    }
                    continue;
                }

                if (prefix === '.' && command === 'reaction') {
                    const subCommand = args[0]?.toLowerCase();
                    if (subCommand === 'set') {
                        const emojis = args.slice(1).filter(e => e.trim() !== '');
                        if (emojis.length === 0) {
                            await sock.sendMessage(groupId, {
                                text: `📝 *Usage:* \`.reaction set [emojis]\`\n\n📝 *Example:* \`.reaction set 😁 🙏 🌚 ❤️ 🔥\``
                            }, { quoted: msg });
                        } else {
                            await updateGroupSettings(groupId, { reactionEmojis: emojis });
                            await sock.sendMessage(groupId, {
                                text: `✅ Reaction emojis set!\n\n${emojis.join(' ')}\nTotal: ${emojis.length} emojis`
                            }, { quoted: msg });
                        }
                    } else {
                        const s = await getGroupSettings(groupId);
                        await sock.sendMessage(groupId, {
                            text: `📋 *Auto Reaction Settings*\n\n• Status: ${s.reaction ? '✅ ON' : '❌ OFF'}\n• Emojis: ${(s.reactionEmojis || []).join(' ')}\n\nCommands:\n• \`!reaction on/off\`\n• \`.reaction set [emojis]\``
                        }, { quoted: msg });
                    }
                    continue;
                }

            } catch (msgError) {
                addLog(`Message error: ${msgError.message}`);
            }
        }
    });

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
                        addLog(`Mute expired: ${jidToNumber(userJid)} in ${groupId}`);
                        try {
                            await sock.sendMessage(groupId, {
                                text: `🔊 @${jidToNumber(userJid)}'s mute has expired. They can now send messages. ✅`,
                                mentions: [userJid]
                            });
                        } catch (e) {}
                    }
                }
                if (db[groupId] && Object.keys(db[groupId]).length === 0) {
                    delete db[groupId];
                    changed = true;
                }
            }

            if (changed) await writeDb(MUTES_DB, db);
        } catch (e) {}
    }, 30000);

    addLog('All handlers ready. Xyron Rose Manager is operational.');
}

startBot().catch(err => {
    addLog(`Fatal: ${err.message}`);
    console.error(err);
});
