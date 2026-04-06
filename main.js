require('dotenv').config();

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    getContentType
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const fs = require('fs-extra');
const path = require('path');
const express = require('express');
const crypto = require('crypto');

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
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const logs = [];
let pairingCode = null;
let connectionStatus = 'disconnected';
let globalSock = null;

// Store verify sessions: token -> { groupId, createdAt }
const verifySessions = new Map();

function addLog(message) {
    const timestamp = new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka' });
    const entry = `[${timestamp}] ${message}`;
    logs.push(entry);
    if (logs.length > 300) logs.shift();
    console.log(entry);
}

function generateToken() {
    return crypto.randomBytes(16).toString('hex');
}

const app = express();
app.use(express.json());

// ── Main Panel ──────────────────────────────────────────────
app.get('/', (req, res) => {
    const logHtml = logs.slice().reverse().map(l =>
        `<div class="log-entry">${l}</div>`
    ).join('');

    res.send(`<!DOCTYPE html>
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
        <div style="color:#8b949e;font-size:14px">WhatsApp → Settings → Linked Devices → Link a Device → Link with Phone Number</div>
    </div>` : ''}
    <div class="logs-container">
        <h2>📋 Live Logs</h2>
        ${logHtml || '<div class="log-entry">No logs yet...</div>'}
    </div>
    <div class="footer">
        <p>© 2024 Xyron Rose Manager | Developer: Prime Xyron | t.me/prime_xyron</p>
    </div>
</body>
</html>`);
});

// ── Verify Page ─────────────────────────────────────────────
app.get('/verify/:token', async (req, res) => {
    const { token } = req.params;
    const session = verifySessions.get(token);

    if (!session) {
        return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Invalid Link - Xyron Rose</title>
    <style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{background:#0d1117;color:#c9d1d9;font-family:'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
        .card{background:#161b22;border:1px solid #f85149;border-radius:16px;padding:40px;text-align:center;max-width:400px;width:90%}
        .icon{font-size:60px;margin-bottom:20px}
        h2{color:#f85149;margin-bottom:10px}
        p{color:#8b949e;font-size:14px}
    </style>
</head>
<body>
    <div class="card">
        <div class="icon">❌</div>
        <h2>Invalid or Expired Link</h2>
        <p>This verification link is invalid or has expired.<br>Please use <strong>!!verify</strong> again in your WhatsApp group to get a new link.</p>
    </div>
</body>
</html>`);
    }

    // Check if expired (15 minutes)
    if (Date.now() - session.createdAt > 15 * 60 * 1000) {
        verifySessions.delete(token);
        return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Expired - Xyron Rose</title>
    <style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{background:#0d1117;color:#c9d1d9;font-family:'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
        .card{background:#161b22;border:1px solid #d29922;border-radius:16px;padding:40px;text-align:center;max-width:400px;width:90%}
        .icon{font-size:60px;margin-bottom:20px}
        h2{color:#d29922;margin-bottom:10px}
        p{color:#8b949e;font-size:14px}
    </style>
</head>
<body>
    <div class="card">
        <div class="icon">⏰</div>
        <h2>Link Expired</h2>
        <p>This verification link has expired (15 min limit).<br>Please use <strong>!!verify</strong> again in WhatsApp.</p>
    </div>
</body>
</html>`);
    }

    let groupName = 'Unknown Group';
    let participants = [];
    let botNumber = '';
    let botRawId = '';

    try {
        if (globalSock && globalSock.user) {
            botRawId = globalSock.user.id || '';
            botNumber = botRawId.replace(/[^0-9]/g, '');
            const metadata = await globalSock.groupMetadata(session.groupId);
            groupName = metadata.subject || 'Unknown Group';
            participants = metadata.participants || [];
        }
    } catch (e) {
        addLog(`Verify page metadata error: ${e.message}`);
    }

    const botParticipant = participants.find(p => {
        const pNum = p.id.replace(/[^0-9]/g, '');
        return pNum === botNumber;
    });

    const isAdmin = botParticipant
        ? (botParticipant.admin === 'admin' || botParticipant.admin === 'superadmin')
        : false;

    const statusColor = isAdmin ? '#3fb950' : '#f85149';
    const statusIcon = isAdmin ? '✅' : '❌';
    const statusText = isAdmin ? 'Bot has Admin Rights' : 'Bot does NOT have Admin Rights';
    const statusBg = isAdmin ? 'rgba(63,185,80,0.1)' : 'rgba(248,81,73,0.1)';
    const statusBorder = isAdmin ? '#3fb950' : '#f85149';

    const participantRows = participants.map(p => {
        const pNum = p.id.replace(/[^0-9]/g, '');
        const isBot = pNum === botNumber;
        const adminBadge = p.admin
            ? `<span style="background:${p.admin === 'superadmin' ? '#d29922' : '#58a6ff'};color:#0d1117;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:bold">${p.admin === 'superadmin' ? '👑 Owner' : '⚡ Admin'}</span>`
            : `<span style="background:#21262d;color:#8b949e;padding:2px 8px;border-radius:20px;font-size:11px">Member</span>`;
        const botBadge = isBot
            ? `<span style="background:#58a6ff;color:#0d1117;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:bold;margin-left:4px">🤖 BOT</span>`
            : '';
        return `<tr style="border-bottom:1px solid #21262d;${isBot ? 'background:rgba(88,166,255,0.05)' : ''}">
            <td style="padding:10px;font-size:13px;color:${isBot ? '#58a6ff' : '#c9d1d9'}">${p.id}${botBadge}</td>
            <td style="padding:10px;text-align:center">${adminBadge}</td>
        </tr>`;
    }).join('');

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Verify Bot - ${groupName}</title>
    <style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{background:#0d1117;color:#c9d1d9;font-family:'Segoe UI',sans-serif;padding:20px;min-height:100vh}
        .container{max-width:700px;margin:0 auto}
        .header{text-align:center;padding:30px 0;border-bottom:1px solid #30363d;margin-bottom:24px}
        .header h1{color:#58a6ff;font-size:24px;margin-bottom:6px}
        .header p{color:#8b949e;font-size:14px}
        .status-card{border-radius:14px;padding:24px;text-align:center;margin-bottom:24px;border:2px solid ${statusBorder};background:${statusBg}}
        .status-icon{font-size:48px;margin-bottom:12px}
        .status-title{font-size:20px;font-weight:bold;color:${statusColor};margin-bottom:6px}
        .group-name{color:#8b949e;font-size:14px}
        .info-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:24px}
        .info-box{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:16px;text-align:center}
        .info-box .label{color:#8b949e;font-size:12px;margin-bottom:4px}
        .info-box .value{color:#c9d1d9;font-size:14px;font-weight:bold;word-break:break-all}
        .verify-btn{width:100%;padding:16px;background:#238636;color:#fff;border:none;border-radius:10px;font-size:16px;font-weight:bold;cursor:pointer;margin-bottom:24px;transition:all 0.2s}
        .verify-btn:hover{background:#2ea043}
        .verify-btn:disabled{background:#21262d;color:#484f58;cursor:not-allowed}
        .verify-btn.checking{background:#d29922}
        .result-box{display:none;border-radius:10px;padding:16px;margin-bottom:24px;text-align:center;font-weight:bold;font-size:15px}
        .result-box.success{background:rgba(63,185,80,0.1);border:1px solid #3fb950;color:#3fb950}
        .result-box.fail{background:rgba(248,81,73,0.1);border:1px solid #f85149;color:#f85149}
        .participants-card{background:#161b22;border:1px solid #30363d;border-radius:14px;overflow:hidden;margin-bottom:24px}
        .participants-card h3{padding:16px 20px;border-bottom:1px solid #30363d;color:#58a6ff;font-size:15px}
        table{width:100%;border-collapse:collapse}
        th{padding:10px;background:#21262d;color:#8b949e;font-size:12px;text-align:left}
        .footer{text-align:center;color:#484f58;font-size:13px;padding:20px 0}
        .badge-admin{display:inline-block;background:rgba(88,166,255,0.15);color:#58a6ff;padding:3px 10px;border-radius:20px;font-size:12px}
        @media(max-width:500px){.info-grid{grid-template-columns:1fr}}
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🤖 Xyron Rose Manager</h1>
            <p>Bot Admin Verification Panel</p>
        </div>

        <div class="status-card">
            <div class="status-icon">${statusIcon}</div>
            <div class="status-title">${statusText}</div>
            <div class="group-name">🏷️ Group: <strong style="color:#c9d1d9">${groupName}</strong></div>
        </div>

        <div class="info-grid">
            <div class="info-box">
                <div class="label">Bot Raw ID</div>
                <div class="value" style="font-size:11px">${botRawId || 'N/A'}</div>
            </div>
            <div class="info-box">
                <div class="label">Bot Number</div>
                <div class="value">${botNumber || 'N/A'}</div>
            </div>
            <div class="info-box">
                <div class="label">Total Members</div>
                <div class="value">${participants.length}</div>
            </div>
            <div class="info-box">
                <div class="label">Bot Found in Group</div>
                <div class="value" style="color:${botParticipant ? '#3fb950' : '#f85149'}">${botParticipant ? '✅ Yes' : '❌ No'}</div>
            </div>
        </div>

        <button class="verify-btn" id="verifyBtn" onclick="runVerify()">
            🔍 Verify Bot Admin Status Now
        </button>

        <div class="result-box" id="resultBox"></div>

        <div class="participants-card">
            <h3>👥 Group Participants (${participants.length})</h3>
            <table>
                <thead>
                    <tr>
                        <th>JID / Number</th>
                        <th style="text-align:center">Role</th>
                    </tr>
                </thead>
                <tbody>
                    ${participantRows || '<tr><td colspan="2" style="padding:20px;text-align:center;color:#8b949e">No participants found</td></tr>'}
                </tbody>
            </table>
        </div>

        <div class="footer">
            <p>🤖 Xyron Rose Manager | Developer: Prime Xyron | t.me/prime_xyron</p>
            <p style="margin-top:4px">Link expires in 15 minutes from generation</p>
        </div>
    </div>

    <script>
        async function runVerify() {
            const btn = document.getElementById('verifyBtn');
            const resultBox = document.getElementById('resultBox');

            btn.disabled = true;
            btn.className = 'verify-btn checking';
            btn.textContent = '⏳ Checking...';
            resultBox.style.display = 'none';

            try {
                const res = await fetch('/verify/${token}/check', { method: 'POST' });
                const data = await res.json();

                resultBox.style.display = 'block';

                if (data.isAdmin) {
                    resultBox.className = 'result-box success';
                    resultBox.innerHTML = '✅ Verified! Bot has admin rights. All features are operational!';
                    btn.style.background = '#3fb950';
                    btn.textContent = '✅ Verification Complete';
                } else if (!data.botFound) {
                    resultBox.className = 'result-box fail';
                    resultBox.innerHTML = '❌ Bot was not found in this group! Make sure the bot is in the group.';
                    btn.className = 'verify-btn';
                    btn.disabled = false;
                    btn.textContent = '🔍 Verify Bot Admin Status Now';
                } else {
                    resultBox.className = 'result-box fail';
                    resultBox.innerHTML = '❌ Bot is in the group but does NOT have admin rights. Please promote the bot to admin in WhatsApp.';
                    btn.className = 'verify-btn';
                    btn.disabled = false;
                    btn.textContent = '🔄 Check Again';
                }
            } catch (e) {
                resultBox.style.display = 'block';
                resultBox.className = 'result-box fail';
                resultBox.innerHTML = '❌ Network error. Please try again.';
                btn.className = 'verify-btn';
                btn.disabled = false;
                btn.textContent = '🔍 Verify Bot Admin Status Now';
            }
        }
    </script>
</body>
</html>`);
});

// ── Verify API Endpoint ─────────────────────────────────────
app.post('/verify/:token/check', async (req, res) => {
    const { token } = req.params;
    const session = verifySessions.get(token);

    if (!session) {
        return res.json({ success: false, error: 'Invalid token', isAdmin: false, botFound: false });
    }

    if (Date.now() - session.createdAt > 15 * 60 * 1000) {
        verifySessions.delete(token);
        return res.json({ success: false, error: 'Expired', isAdmin: false, botFound: false });
    }

    try {
        if (!globalSock || !globalSock.user) {
            return res.json({ success: false, error: 'Bot not connected', isAdmin: false, botFound: false });
        }

        const botNumber = globalSock.user.id.replace(/[^0-9]/g, '');
        const metadata = await globalSock.groupMetadata(session.groupId);
        const participants = metadata.participants || [];

        const botParticipant = participants.find(p => {
            const pNum = p.id.replace(/[^0-9]/g, '');
            return pNum === botNumber;
        });

        if (!botParticipant) {
            return res.json({ success: false, isAdmin: false, botFound: false, groupName: metadata.subject });
        }

        const isAdmin = botParticipant.admin === 'admin' || botParticipant.admin === 'superadmin';

        addLog(`Verify API: Bot in "${metadata.subject}" - Found: true | Admin: ${isAdmin} | Role: ${botParticipant.admin}`);

        return res.json({
            success: true,
            isAdmin: isAdmin,
            botFound: true,
            adminRole: botParticipant.admin || 'none',
            groupName: metadata.subject,
            totalMembers: participants.length
        });

    } catch (e) {
        addLog(`Verify API error: ${e.message}`);
        return res.json({ success: false, error: e.message, isAdmin: false, botFound: false });
    }
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
            db[groupId][key] = key === 'filters' ? {} : key === 'reactionEmojis' ? [...DEFAULT_GROUP_SETTINGS[key]] : DEFAULT_GROUP_SETTINGS[key];
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
        return await sock.groupMetadata(groupId);
    } catch (e) {
        addLog(`Metadata error ${groupId}: ${e.message}`);
        return null;
    }
}

async function isBotAdmin(sock, groupId) {
    try {
        const metadata = await fetchGroupMetadataSafe(sock, groupId);
        if (!metadata) return false;
        const botNumber = (sock.user?.id || '').replace(/[^0-9]/g, '');
        for (const p of metadata.participants) {
            const pNum = p.id.replace(/[^0-9]/g, '');
            if (pNum === botNumber) {
                return p.admin === 'admin' || p.admin === 'superadmin';
            }
        }
        return false;
    } catch (e) {
        return false;
    }
}

async function isGroupAdmin(sock, groupId, userJid) {
    try {
        const metadata = await fetchGroupMetadataSafe(sock, groupId);
        if (!metadata) return false;
        const userNumber = userJid.replace(/[^0-9]/g, '');
        for (const p of metadata.participants) {
            const pNum = p.id.replace(/[^0-9]/g, '');
            if (pNum === userNumber) {
                return p.admin === 'admin' || p.admin === 'superadmin';
            }
        }
        return false;
    } catch (e) {
        return false;
    }
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
    if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
    if (m.imageMessage?.caption) return m.imageMessage.caption;
    if (m.videoMessage?.caption) return m.videoMessage.caption;
    if (m.documentMessage?.caption) return m.documentMessage.caption;
    return '';
}

function getTargetJid(msg, args) {
    const contextInfo = msg.message?.extendedTextMessage?.contextInfo
        || msg.message?.imageMessage?.contextInfo
        || msg.message?.videoMessage?.contextInfo;

    if (contextInfo?.participant) return normalizeJid(contextInfo.participant);
    if (contextInfo?.mentionedJid?.length > 0) return normalizeJid(contextInfo.mentionedJid[0]);

    if (args?.length > 0) {
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
    const botNumber = (sock.user?.id || '').replace(/[^0-9]/g, '');
    const senderJid = msg.key.participant || msg.key.remoteJid;
    const senderNumber = senderJid.replace(/[^0-9]/g, '');
    return botNumber === senderNumber;
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

    globalSock = sock;

    if (!sock.authState.creds.registered) {
        addLog('Generating pairing code...');
        connectionStatus = 'connecting';
        await new Promise(resolve => setTimeout(resolve, 3000));
        try {
            let phoneNumber = BOT_NUMBER.replace(/[^0-9]/g, '');
            if (phoneNumber.length === 11 && phoneNumber.startsWith('0')) phoneNumber = '88' + phoneNumber;
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
            globalSock = sock;
            addLog('Connected to WhatsApp!');
            addLog(`Bot ID: ${sock.user?.id}`);
        }
        if (connection === 'close') {
            connectionStatus = 'disconnected';
            const code = lastDisconnect?.error?.output?.statusCode;
            addLog(`Disconnected. Code: ${code}`);
            if (code === DisconnectReason.loggedOut) {
                await fs.remove(AUTH_DIR);
            }
            setTimeout(startBot, 5000);
        }
        if (connection === 'connecting') {
            connectionStatus = 'connecting';
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
                const vars = {
                    mention: `@${userNumber}`,
                    shownumber: userNumber,
                    membercount: metadata.participants.length,
                    groupname: metadata.subject || 'Unknown Group'
                };
                if (action === 'add' && settings.welcome) {
                    try {
                        await sock.sendMessage(groupId, {
                            text: replaceVariables(settings.welcomeMsg, vars),
                            mentions: [participant]
                        });
                    } catch (e) {}
                }
                if (action === 'remove' && settings.goodbye) {
                    try {
                        await sock.sendMessage(groupId, {
                            text: replaceVariables(settings.goodbyeMsg, vars),
                            mentions: [participant]
                        });
                    } catch (e) {}
                }
                if (action === 'remove') await removeMute(groupId, participant);
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
                if (!msg.key.remoteJid?.endsWith('@g.us')) continue;

                const groupId = msg.key.remoteJid;
                const senderJid = msg.key.participant || msg.key.remoteJid;
                const normalizedSender = normalizeJid(senderJid);
                const selfMsg = isSelfMessage(sock, msg);

                if (msg.messageStubType) {
                    const settings = await getGroupSettings(groupId);
                    if (settings.cleanservice) {
                        try { await sock.sendMessage(groupId, { delete: msg.key }); } catch (e) {}
                    }
                    continue;
                }

                const contentType = getContentType(msg.message);
                if (contentType === 'protocolMessage' || contentType === 'senderKeyDistributionMessage') continue;

                const body = getMessageText(msg);

                if (!selfMsg) {
                    const muted = await isUserMuted(groupId, normalizedSender);
                    if (muted) {
                        try {
                            if (await isBotAdmin(sock, groupId)) {
                                await sock.sendMessage(groupId, { delete: msg.key });
                            }
                        } catch (e) {}
                        continue;
                    }
                }

                if (!selfMsg && body) {
                    const settings = await getGroupSettings(groupId);
                    if (settings.antilink && /chat\.whatsapp\.com|wa\.me/i.test(body)) {
                        const senderIsAuth = await isAuthorized(sock, groupId, normalizedSender);
                        if (!senderIsAuth && await isBotAdmin(sock, groupId)) {
                            try {
                                await sock.sendMessage(groupId, { delete: msg.key });
                                await sock.sendMessage(groupId, {
                                    text: `⚠️ @${jidToNumber(senderJid)}, sharing links is not allowed! Your message has been deleted.`,
                                    mentions: [senderJid]
                                });
                            } catch (e) {}
                            continue;
                        }
                    }
                }

                if (!selfMsg && body) {
                    const settings = await getGroupSettings(groupId);
                    if (settings.filters && Object.keys(settings.filters).length > 0) {
                        const lowerBody = body.toLowerCase();
                        let filtered = false;
                        for (const [word, reply] of Object.entries(settings.filters)) {
                            if (lowerBody.includes(word.toLowerCase())) {
                                const senderIsAuth = await isAuthorized(sock, groupId, normalizedSender);
                                if (!senderIsAuth && await isBotAdmin(sock, groupId)) {
                                    try {
                                        await sock.sendMessage(groupId, { delete: msg.key });
                                        await sock.sendMessage(groupId, {
                                            text: `⚠️ @${jidToNumber(senderJid)}, ${reply}`,
                                            mentions: [senderJid]
                                        });
                                    } catch (e) {}
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
                    if (settings.reaction && settings.reactionEmojis?.length > 0) {
                        const emoji = settings.reactionEmojis[Math.floor(Math.random() * settings.reactionEmojis.length)];
                        try { await sock.sendMessage(groupId, { react: { text: emoji, key: msg.key } }); } catch (e) {}
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

                let command = '', args = [], prefix = '';

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
                } else continue;

                if (!command) continue;
                addLog(`CMD: ${prefix}${command} | From: ${jidToNumber(senderJid)}`);

                if (prefix === '!!' && command === 'help') {
                    await sock.sendMessage(groupId, {
                        text: `╔═══════════════════════════════════╗
║     🤖 *XYRON ROSE MANAGER*       ║
║   Group Management Bot v2.1       ║
╚═══════════════════════════════════╝

━━━ 👑 *SETUP & ADMIN* ━━━
• \`!addme\` — Register as group owner
• \`!!goback\` — Bot leaves group (Owner only)
• \`!!verify\` — Get bot verification link
• \`!cleanservice on/off\` — Auto-delete system msgs

━━━ 👋 *WELCOME & GOODBYE* ━━━
• \`.welcome on/off\`
• \`.goodbye on/off\`
• \`.setwelcome [text]\`
• \`.setgoodbye [text]\`

📝 *Variables:* {mention} {shownumber} {membercount} {time} {date} {groupname}

━━━ 🔇 *MUTE & SECURITY* ━━━
• \`.mute [time] [target]\` — 10s/30m/1h/1d
• \`.unmute [target]\`
• \`.antilink on/off\`
• \`.filter [word] [reply]\`
• \`.removefilter [word]\`

━━━ 🛡️ *MODERATION* ━━━
• \`.promote [target]\`
• \`.demote [target]\`
• \`.kick [target]\`
• \`.tagall [text]\`

━━━ 😁 *REACTION* ━━━
• \`!reaction on/off\`
• \`.reaction set [emojis]\`

👨‍💻 *Developer:* Prime Xyron
📢 t.me/prime_xyron`
                    }, { quoted: msg });
                    continue;
                }

                if (prefix === '!!' && command === 'verify') {
                    const token = generateToken();
                    verifySessions.set(token, { groupId, createdAt: Date.now() });

                    setTimeout(() => verifySessions.delete(token), 15 * 60 * 1000);

                    const verifyUrl = `${BASE_URL}/verify/${token}`;

                    await sock.sendMessage(groupId, {
                        text: `🔍 *Bot Verification Link*\n\n📎 Click the link below to verify bot admin status:\n\n${verifyUrl}\n\n⏰ This link expires in *15 minutes*.\n\n💡 On the page, click *"Verify Bot Admin Status Now"* button to check.`
                    }, { quoted: msg });

                    addLog(`Verify link generated for group: ${groupId}`);
                    continue;
                }

                if (prefix === '!' && command === 'addme') {
                    const existingOwner = await getOwner(groupId);
                    if (existingOwner) {
                        await sock.sendMessage(groupId, {
                            text: `⚠️ This group already has a registered owner: @${jidToNumber(existingOwner)}`,
                            mentions: [existingOwner]
                        }, { quoted: msg });
                    } else {
                        await setOwner(groupId, normalizedSender);
                        await sock.sendMessage(groupId, {
                            text: `✅ @${jidToNumber(senderJid)} is now the registered owner!`,
                            mentions: [senderJid]
                        }, { quoted: msg });
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
                    if (!await isRegisteredOwner(groupId, normalizedSender)) {
                        await sock.sendMessage(groupId, { text: '❌ Only the registered owner can make the bot leave.' }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(groupId, { text: '👋 Goodbye! Xyron Rose Manager is leaving...\n📢 t.me/prime_xyron' });
                    await new Promise(r => setTimeout(r, 2000));
                    try { await sock.groupLeave(groupId); } catch (e) {}
                    continue;
                }

                if (prefix === '!' && command === 'cleanservice') {
                    const toggle = args[0]?.toLowerCase();
                    if (toggle === 'on') {
                        await updateGroupSettings(groupId, { cleanservice: true });
                        await sock.sendMessage(groupId, { text: '✅ Clean Service *enabled*.' }, { quoted: msg });
                    } else if (toggle === 'off') {
                        await updateGroupSettings(groupId, { cleanservice: false });
                        await sock.sendMessage(groupId, { text: '❌ Clean Service *disabled*.' }, { quoted: msg });
                    } else {
                        const s = await getGroupSettings(groupId);
                        await sock.sendMessage(groupId, { text: `📝 Usage: \`!cleanservice on/off\`\nCurrent: ${s.cleanservice ? '✅ ON' : '❌ OFF'}` }, { quoted: msg });
                    }
                    continue;
                }

                if (prefix === '.' && command === 'welcome') {
                    const toggle = args[0]?.toLowerCase();
                    if (toggle === 'on') {
                        await updateGroupSettings(groupId, { welcome: true });
                        await sock.sendMessage(groupId, { text: '✅ Welcome messages *enabled*!' }, { quoted: msg });
                    } else if (toggle === 'off') {
                        await updateGroupSettings(groupId, { welcome: false });
                        await sock.sendMessage(groupId, { text: '❌ Welcome messages *disabled*.' }, { quoted: msg });
                    } else {
                        const s = await getGroupSettings(groupId);
                        await sock.sendMessage(groupId, { text: `📝 \`.welcome on/off\`\nCurrent: ${s.welcome ? '✅ ON' : '❌ OFF'}` }, { quoted: msg });
                    }
                    continue;
                }

                if (prefix === '.' && command === 'goodbye') {
                    const toggle = args[0]?.toLowerCase();
                    if (toggle === 'on') {
                        await updateGroupSettings(groupId, { goodbye: true });
                        await sock.sendMessage(groupId, { text: '✅ Goodbye messages *enabled*!' }, { quoted: msg });
                    } else if (toggle === 'off') {
                        await updateGroupSettings(groupId, { goodbye: false });
                        await sock.sendMessage(groupId, { text: '❌ Goodbye messages *disabled*.' }, { quoted: msg });
                    } else {
                        const s = await getGroupSettings(groupId);
                        await sock.sendMessage(groupId, { text: `📝 \`.goodbye on/off\`\nCurrent: ${s.goodbye ? '✅ ON' : '❌ OFF'}` }, { quoted: msg });
                    }
                    continue;
                }

                if (prefix === '.' && command === 'setwelcome') {
                    const text = args.join(' ').trim();
                    if (!text) {
                        await sock.sendMessage(groupId, {
                            text: `📝 *Usage:* \`.setwelcome [message]\`\n\n📌 Variables:\n{mention} {shownumber} {membercount} {groupname} {time} {date}`
                        }, { quoted: msg });
                    } else {
                        await updateGroupSettings(groupId, { welcomeMsg: text });
                        const preview = replaceVariables(text, { mention: '@User', shownumber: '88019XXXXXXXX', membercount: 100, groupname: 'Test Group' });
                        await sock.sendMessage(groupId, { text: `✅ Welcome message set!\n\n📝 Preview:\n${preview}` }, { quoted: msg });
                    }
                    continue;
                }

                if (prefix === '.' && command === 'setgoodbye') {
                    const text = args.join(' ').trim();
                    if (!text) {
                        await sock.sendMessage(groupId, {
                            text: `📝 *Usage:* \`.setgoodbye [message]\`\n\n📌 Variables:\n{mention} {shownumber} {membercount} {groupname} {time} {date}`
                        }, { quoted: msg });
                    } else {
                        await updateGroupSettings(groupId, { goodbyeMsg: text });
                        const preview = replaceVariables(text, { mention: '@User', shownumber: '88019XXXXXXXX', membercount: 99, groupname: 'Test Group' });
                        await sock.sendMessage(groupId, { text: `✅ Goodbye message set!\n\n📝 Preview:\n${preview}` }, { quoted: msg });
                    }
                    continue;
                }

                if (prefix === '.' && command === 'mute') {
                    if (!await isBotAdmin(sock, groupId)) {
                        await sock.sendMessage(groupId, { text: '⚠️ Bot must be admin! Use `!!verify` to check.' }, { quoted: msg });
                        continue;
                    }
                    if (args.length < 1) {
                        await sock.sendMessage(groupId, { text: `📝 *Usage:* \`.mute [time] [target]\`\n⏱️ Time: 10s, 30m, 1h, 1d\n👤 Target: Reply or phone number` }, { quoted: msg });
                        continue;
                    }
                    const timeStr = args[0];
                    const duration = parseTimeString(timeStr);
                    if (!duration) {
                        await sock.sendMessage(groupId, { text: '❌ Invalid time! Use: 10s, 30m, 1h, 1d' }, { quoted: msg });
                        continue;
                    }
                    const targetJid = getTargetJid(msg, args.slice(1));
                    if (!targetJid) {
                        await sock.sendMessage(groupId, { text: '❌ Target not found! Reply or provide a number.' }, { quoted: msg });
                        continue;
                    }
                    if (targetJid.replace(/[^0-9]/g, '') === (sock.user?.id || '').replace(/[^0-9]/g, '')) {
                        await sock.sendMessage(groupId, { text: '❌ Cannot mute the bot!' }, { quoted: msg });
                        continue;
                    }
                    if (await isGroupAdmin(sock, groupId, targetJid)) {
                        await sock.sendMessage(groupId, { text: '❌ Cannot mute a group admin!' }, { quoted: msg });
                        continue;
                    }
                    const expiresAt = Date.now() + duration;
                    await setMute(groupId, targetJid, expiresAt);
                    const expiry = new Date(expiresAt).toLocaleString('en-US', { timeZone: 'Asia/Dhaka' });
                    await sock.sendMessage(groupId, {
                        text: `🔇 *User Muted!*\n\n👤 @${jidToNumber(targetJid)}\n⏱️ Duration: ${timeStr}\n📅 Expires: ${expiry}`,
                        mentions: [targetJid]
                    }, { quoted: msg });
                    continue;
                }

                if (prefix === '.' && command === 'unmute') {
                    const targetJid = getTargetJid(msg, args);
                    if (!targetJid) {
                        await sock.sendMessage(groupId, { text: '❌ Target not found!' }, { quoted: msg });
                        continue;
                    }
                    const removed = await removeMute(groupId, targetJid);
                    await sock.sendMessage(groupId, {
                        text: removed
                            ? `🔊 @${jidToNumber(targetJid)} has been unmuted! ✅`
                            : `ℹ️ @${jidToNumber(targetJid)} is not muted.`,
                        mentions: [targetJid]
                    }, { quoted: msg });
                    continue;
                }

                if (prefix === '.' && command === 'antilink') {
                    const toggle = args[0]?.toLowerCase();
                    if (toggle === 'on') {
                        if (!await isBotAdmin(sock, groupId)) {
                            await sock.sendMessage(groupId, { text: '⚠️ Bot must be admin first! Use `!!verify`.' }, { quoted: msg });
                            continue;
                        }
                        await updateGroupSettings(groupId, { antilink: true });
                        await sock.sendMessage(groupId, { text: '✅ Antilink *enabled*! Links will be auto-deleted.\n⚠️ Admins & owner are exempt.' }, { quoted: msg });
                    } else if (toggle === 'off') {
                        await updateGroupSettings(groupId, { antilink: false });
                        await sock.sendMessage(groupId, { text: '❌ Antilink *disabled*.' }, { quoted: msg });
                    } else {
                        const s = await getGroupSettings(groupId);
                        await sock.sendMessage(groupId, { text: `📝 \`.antilink on/off\`\nCurrent: ${s.antilink ? '✅ ON' : '❌ OFF'}` }, { quoted: msg });
                    }
                    continue;
                }

                if (prefix === '.' && command === 'filter') {
                    if (!await isBotAdmin(sock, groupId)) {
                        await sock.sendMessage(groupId, { text: '⚠️ Bot must be admin to enforce filters! Use `!!verify`.' }, { quoted: msg });
                        continue;
                    }
                    if (args.length < 2) {
                        const settings = await getGroupSettings(groupId);
                        const filterKeys = Object.keys(settings.filters || {});
                        if (filterKeys.length === 0) {
                            await sock.sendMessage(groupId, { text: `📝 *Usage:* \`.filter [word] [reply]\`\n\n📋 No active filters.\n🗑️ Remove: \`.removefilter [word]\`` }, { quoted: msg });
                        } else {
                            let listText = '📋 *Active Filters:*\n\n';
                            for (const [w, r] of Object.entries(settings.filters)) listText += `• *${w}* → ${r}\n`;
                            await sock.sendMessage(groupId, { text: listText }, { quoted: msg });
                        }
                        continue;
                    }
                    const filterWord = args[0].toLowerCase();
                    const filterReply = args.slice(1).join(' ');
                    const settings = await getGroupSettings(groupId);
                    const filters = settings.filters || {};
                    filters[filterWord] = filterReply;
                    await updateGroupSettings(groupId, { filters });
                    await sock.sendMessage(groupId, { text: `✅ Filter set!\n🔤 Word: *${filterWord}*\n💬 Reply: ${filterReply}` }, { quoted: msg });
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
                        await updateGroupSettings(groupId, { filters });
                        await sock.sendMessage(groupId, { text: `✅ Filter "${filterWord}" removed.` }, { quoted: msg });
                    } else {
                        await sock.sendMessage(groupId, { text: `❌ No filter found: "${filterWord}"` }, { quoted: msg });
                    }
                    continue;
                }

                if (prefix === '.' && command === 'promote') {
                    if (!await isBotAdmin(sock, groupId)) {
                        await sock.sendMessage(groupId, { text: '⚠️ Bot must be admin! Use `!!verify`.' }, { quoted: msg });
                        continue;
                    }
                    const targetJid = getTargetJid(msg, args);
                    if (!targetJid) {
                        await sock.sendMessage(groupId, { text: '❌ Target not found! Reply or provide a number.' }, { quoted: msg });
                        continue;
                    }
                    if (await isGroupAdmin(sock, groupId, targetJid)) {
                        await sock.sendMessage(groupId, { text: `ℹ️ @${jidToNumber(targetJid)} is already an admin!`, mentions: [targetJid] }, { quoted: msg });
                        continue;
                    }
                    try {
                        await sock.groupParticipantsUpdate(groupId, [targetJid], 'promote');
                        await sock.sendMessage(groupId, { text: `✅ @${jidToNumber(targetJid)} promoted to admin! 🎉`, mentions: [targetJid] }, { quoted: msg });
                    } catch (e) {
                        await sock.sendMessage(groupId, { text: `❌ Promote failed: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                if (prefix === '.' && command === 'demote') {
                    if (!await isBotAdmin(sock, groupId)) {
                        await sock.sendMessage(groupId, { text: '⚠️ Bot must be admin!' }, { quoted: msg });
                        continue;
                    }
                    const targetJid = getTargetJid(msg, args);
                    if (!targetJid) {
                        await sock.sendMessage(groupId, { text: '❌ Target not found!' }, { quoted: msg });
                        continue;
                    }
                    try {
                        await sock.groupParticipantsUpdate(groupId, [targetJid], 'demote');
                        await sock.sendMessage(groupId, { text: `✅ @${jidToNumber(targetJid)} demoted.`, mentions: [targetJid] }, { quoted: msg });
                    } catch (e) {
                        await sock.sendMessage(groupId, { text: `❌ Demote failed: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                if (prefix === '.' && command === 'kick') {
                    if (!await isBotAdmin(sock, groupId)) {
                        await sock.sendMessage(groupId, { text: '⚠️ Bot must be admin! Use `!!verify`.' }, { quoted: msg });
                        continue;
                    }
                    const targetJid = getTargetJid(msg, args);
                    if (!targetJid) {
                        await sock.sendMessage(groupId, { text: '❌ Target not found! Reply or provide a number.' }, { quoted: msg });
                        continue;
                    }
                    if (targetJid.replace(/[^0-9]/g, '') === (sock.user?.id || '').replace(/[^0-9]/g, '')) {
                        await sock.sendMessage(groupId, { text: '❌ Cannot kick the bot!' }, { quoted: msg });
                        continue;
                    }
                    if (await isGroupAdmin(sock, groupId, targetJid) && !await isRegisteredOwner(groupId, normalizedSender)) {
                        await sock.sendMessage(groupId, { text: '❌ Cannot kick an admin!' }, { quoted: msg });
                        continue;
                    }
                    try {
                        await sock.groupParticipantsUpdate(groupId, [targetJid], 'remove');
                        await sock.sendMessage(groupId, { text: `✅ @${jidToNumber(targetJid)} removed. 👢`, mentions: [targetJid] }, { quoted: msg });
                        await removeMute(groupId, targetJid);
                    } catch (e) {
                        await sock.sendMessage(groupId, { text: `❌ Kick failed: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                if (prefix === '.' && command === 'tagall') {
                    const metadata = await fetchGroupMetadataSafe(sock, groupId);
                    if (!metadata) {
                        await sock.sendMessage(groupId, { text: '❌ Could not fetch group info.' }, { quoted: msg });
                        continue;
                    }
                    const tagText = args.join(' ') || '📢 Attention Everyone!';
                    let text = `📢 *${tagText}*\n\n`;
                    const mentions = [];
                    for (const p of metadata.participants) {
                        text += `• @${jidToNumber(p.id)}\n`;
                        mentions.push(p.id);
                    }
                    text += `\n👥 Total: ${metadata.participants.length}`;
                    await sock.sendMessage(groupId, { text, mentions }, { quoted: msg });
                    continue;
                }

                if (prefix === '!' && command === 'reaction') {
                    const toggle = args[0]?.toLowerCase();
                    if (toggle === 'on') {
                        await updateGroupSettings(groupId, { reaction: true });
                        const s = await getGroupSettings(groupId);
                        await sock.sendMessage(groupId, { text: `✅ Auto Reaction *enabled*!\nEmojis: ${(s.reactionEmojis || []).join(' ')}` }, { quoted: msg });
                    } else if (toggle === 'off') {
                        await updateGroupSettings(groupId, { reaction: false });
                        await sock.sendMessage(groupId, { text: '❌ Auto Reaction *disabled*.' }, { quoted: msg });
                    } else {
                        const s = await getGroupSettings(groupId);
                        await sock.sendMessage(groupId, { text: `📝 \`!reaction on/off\`\nCurrent: ${s.reaction ? '✅ ON' : '❌ OFF'}\nEmojis: ${(s.reactionEmojis || []).join(' ')}` }, { quoted: msg });
                    }
                    continue;
                }

                if (prefix === '.' && command === 'reaction') {
                    if (args[0]?.toLowerCase() === 'set') {
                        const emojis = args.slice(1).filter(e => e.trim());
                        if (emojis.length === 0) {
                            await sock.sendMessage(groupId, { text: `📝 *Usage:* \`.reaction set [emojis]\`\nExample: \`.reaction set 😁 🙏 🌚 ❤️ 🔥\`` }, { quoted: msg });
                        } else {
                            await updateGroupSettings(groupId, { reactionEmojis: emojis });
                            await sock.sendMessage(groupId, { text: `✅ Emojis set! ${emojis.join(' ')}` }, { quoted: msg });
                        }
                    } else {
                        const s = await getGroupSettings(groupId);
                        await sock.sendMessage(groupId, { text: `📋 Reaction: ${s.reaction ? '✅ ON' : '❌ OFF'}\nEmojis: ${(s.reactionEmojis || []).join(' ')}` }, { quoted: msg });
                    }
                    continue;
                }

            } catch (e) {
                addLog(`Message error: ${e.message}`);
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
                        try {
                            await sock.sendMessage(groupId, {
                                text: `🔊 @${jidToNumber(userJid)}'s mute has expired. ✅`,
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

    addLog('All handlers ready. Bot is operational.');
}

startBot().catch(err => {
    addLog(`Fatal: ${err.message}`);
    console.error(err);
});
