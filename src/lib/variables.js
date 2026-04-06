/**
 * ═══════════════════════════════════════════════════
 *  Xyron Rose Manager - Dynamic Variable Handler
 *  Handles text replacement and number formatting
 * ═══════════════════════════════════════════════════
 */

/**
 * Replaces dynamic variables in welcome/goodbye text
 * @param {string} text - Template text with {variables}
 * @param {object} params - Replacement values
 * @returns {string} - Processed text
 */
function replaceVariables(text, params = {}) {
    if (!text || typeof text !== 'string') return '';

    const now = new Date();

    const timeOptions = {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
        timeZone: 'Asia/Dhaka'
    };

    const dateOptions = {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: 'Asia/Dhaka'
    };

    const currentTime = now.toLocaleString('en-US', timeOptions);
    const currentDate = now.toLocaleString('en-US', dateOptions);

    let result = text;
    result = result.replace(/{mention}/gi, params.mention || '@user');
    result = result.replace(/{shownumber}/gi, params.shownumber || 'N/A');
    result = result.replace(/{membercount}/gi, params.membercount !== undefined ? String(params.membercount) : '0');
    result = result.replace(/{time}/gi, currentTime);
    result = result.replace(/{date}/gi, currentDate);
    result = result.replace(/{groupname}/gi, params.groupname || 'Group');

    return result;
}

/**
 * Converts phone number to WhatsApp JID
 * 11-digit BD number (01XXXXXXXXX) -> 8801XXXXXXXXX@s.whatsapp.net
 * @param {string} input - Phone number or partial JID
 * @returns {string|null} - WhatsApp JID or null
 */
function numberToJid(input) {
    if (!input || typeof input !== 'string') return null;

    // If already a full JID, return as-is
    if (input.includes('@s.whatsapp.net')) {
        return input.trim();
    }

    // Remove everything except digits
    let cleaned = input.replace(/[^0-9]/g, '');

    if (cleaned.length === 0) return null;

    // 11-digit BD number starting with 0 -> prepend 88
    if (cleaned.length === 11 && cleaned.startsWith('0')) {
        cleaned = '88' + cleaned;
    }

    // 10-digit BD number without leading 0 -> prepend 880
    if (cleaned.length === 10 && cleaned.startsWith('1')) {
        cleaned = '880' + cleaned;
    }

    // Must be at least 10 digits to be a valid number
    if (cleaned.length >= 10) {
        return cleaned + '@s.whatsapp.net';
    }

    return null;
}

/**
 * Extracts display number from a JID
 * @param {string} jid - WhatsApp JID
 * @returns {string} - Clean number string
 */
function jidToNumber(jid) {
    if (!jid || typeof jid !== 'string') return 'unknown';
    return jid.split('@')[0].split(':')[0];
}

/**
 * Normalizes a JID by removing the device suffix (:XX)
 * So 88019XXXXX:25@s.whatsapp.net becomes 88019XXXXX@s.whatsapp.net
 * @param {string} jid
 * @returns {string}
 */
function normalizeJid(jid) {
    if (!jid || typeof jid !== 'string') return '';
    const [user, server] = jid.split('@');
    const cleanUser = user.split(':')[0];
    return server ? `${cleanUser}@${server}` : cleanUser;
}

/**
 * Parses time strings like "10m", "1h", "1d" into milliseconds
 * @param {string} timeStr - Time string
 * @returns {number|null} - Milliseconds or null if invalid
 */
function parseTimeString(timeStr) {
    if (!timeStr || typeof timeStr !== 'string') return null;

    const match = timeStr.trim().match(/^(\d+)\s*(s|m|h|d)$/i);
    if (!match) return null;

    const value = parseInt(match[1]);
    const unit = match[2].toLowerCase();

    if (value <= 0) return null;

    switch (unit) {
        case 's': return value * 1000;
        case 'm': return value * 60 * 1000;
        case 'h': return value * 60 * 60 * 1000;
        case 'd': return value * 24 * 60 * 60 * 1000;
        default: return null;
    }
}

module.exports = {
    replaceVariables,
    numberToJid,
    jidToNumber,
    normalizeJid,
    parseTimeString
};
