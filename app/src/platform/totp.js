'use strict';
/**
 * TOTP (RFC 6238, HMAC-SHA1, 6 chiffres, pas de 30 s) et Base32 (RFC 4648) — sans dépendance externe.
 * Compatible avec les applications d'authentification courantes (Google Authenticator, Aegis, 1Password…).
 */
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const s = String(str || '').toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of s) {
    const i = B32.indexOf(ch); if (i < 0) throw new Error('Base32 invalide');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const STEP = 30, DIGITS = 6;
function generateSecret() { return base32Encode(crypto.randomBytes(20)); } // 160 bits (RFC 4226 §4)
function hotp(secretB32, counter) {
  const key = base32Decode(secretB32);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}
function stepAt(ms = Date.now()) { return Math.floor(ms / 1000 / STEP); }
function totp(secretB32, ms = Date.now()) { return hotp(secretB32, stepAt(ms)); }

/**
 * Vérifie un code avec une tolérance de ±1 pas (décalage d'horloge). Anti-rejeu : un pas déjà utilisé
 * (≤ lastStep) est refusé. @returns {number|null} le pas accepté (à mémoriser), ou null.
 */
function verify(secretB32, code, { lastStep = -1, ms = Date.now(), window = 1 } = {}) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const now = stepAt(ms);
  for (let d = -window; d <= window; d++) {
    const s = now + d;
    if (s <= lastStep) continue;
    const exp = hotp(secretB32, s);
    if (crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(c))) return s;
  }
  return null;
}

function otpauthUri({ secret, account, issuer = 'DelaiPay' }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`;
}

module.exports = { base32Encode, base32Decode, generateSecret, hotp, totp, verify, otpauthUri, stepAt };
