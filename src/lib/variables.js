/**
 * Xyron Rose Manager - Dynamic Variable Handler
 * Handles text variable replacement and number formatting
 */

/**
 * Replaces dynamic variables in welcome/goodbye text
 * @param {string} text - The template text with variables
 * @param {object} params - Object containing replacement values
 * @param {string} params.mention - The @mention tag for the user
 * @param {string} params.shownumber - The user's phone number in display format
 * @param {number} params.membercount - Current group member count
 * @param {string} params.groupname - The group's subject/name
 * @returns {string} - The processed text with variables replaced
 */
function replaceVariables(text, params = {}) {
    if (!text || typeof text !== 'string') return '';

    const now = new Date();

    // Bengali month names for nicer date formatting
    const options_time = {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
        timeZone: 'Asia/Dhaka'
    };

    const options_date = {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: 'Asia/Dhaka'
    };

    const currentTime = now.toLocaleString('bn-BD', options_time);
    const currentDate = now.toLocaleString('bn-BD', options_date);

    let result = text;

    // Replace all supported variables
    result = result.replace(/{mention}/gi, params.mention || '@user');
    result = result.replace(/{shownumber}/gi, params.shownumber || 'N/A');
    result = result.replace(/{membercount}/gi, params.membercount !== undefined ? String(params.membercount) : '0');
    result = result.replace(/{time}/gi, currentTime);
    result = result.replace(/{date}/gi, currentDate);
    result = result.replace(/{groupname}/gi, params.groupname || 'Group');

    return result;
}

/**
 * Converts a local BD number or international number to WhatsApp JID format
 * If 11-digit BD number (01XXXXXXXXX) -> 8801XXXXXXXXX@s.whatsapp.net
 * If already has country code or is a full JID, handle accordingly
 * @param {string} input - The phone number string
 * @returns {string} - WhatsApp JID
 */
function numberToJid(input) {
    if (!input || typeof input !== 'string') return null;

    // Remove all non-digit characters
    let cleaned = input.replace(/[^0-9]/g, '');

    // Remove trailing @s.whatsapp.net if someone passed a partial jid
    if (input.includes('@s.whatsapp.net')) {
        return input.trim();
    }

    // If it's an 11-digit BD number starting with 0
    if (cleaned.length === 11 && cleaned.startsWith('0')) {
        cleaned = '88' + cleaned;
    }

    // If it's a 13-digit number starting with 88
    if (cleaned.length === 13 && cleaned.startsWith('88')) {
        return cleaned + '@s.whatsapp.net';
    }

    // For any other international number, just append the suffix
    if (cleaned.length >= 10) {
        return cleaned + '@s.whatsapp.net';
    }

    return null;
}

/**
 * Extracts a displayable number from a JID
 * e.g., 8801912345678@s.whatsapp.net -> 8801912345678
 * @param {string} jid - WhatsApp JID
 * @returns {string} - Display number
 */
function jidToNumber(jid) {
    if (!jid || typeof jid !== 'string') return 'N/A';
    return jid.replace('@s.whatsapp.net', '').replace('@g.us', '');
}

/**
 * Parses a time string like "10m", "1h", "1d" into milliseconds
 * Supports: s (seconds), m (minutes), h (hours), d (days)
 * @param {string} timeStr - Time string
 * @returns {number|null} - Duration in milliseconds, or null if invalid
 */
function parseTimeString(timeStr) {
    if (!timeStr || typeof timeStr !== 'string') return null;

    const match = timeStr.trim().match(/^(\d+)\s*(s|m|h|d)$/i);
    if (!match) return null;

    const value = parseInt(match[1]);
    const unit = match[2].toLowerCase();

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
    parseTimeString
};
