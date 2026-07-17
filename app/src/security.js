'use strict';
/**
 * Sécurité HTTP — sans dépendance externe.
 *  - En-têtes de durcissement (CSP, anti-clickjacking, nosniff, HSTS…)
 *  - Limiteur de débit en mémoire (anti brute-force sur le login)
 */

// Content-Security-Policy : 'unsafe-inline' est requis car l'UI utilise des
// gestionnaires d'événements inline (onclick=…) et une balise <style> inline.
// Le reste est cloisonné sur 'self' — aucune origine externe autorisée.
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "form-action 'self'",
].join('; ');

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('X-XSS-Protection', '0'); // désactive le filtre legacy (obsolète, source de bugs)
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

/**
 * Limiteur de débit en mémoire (fenêtre glissante simple).
 * @param {object} opts { windowMs, max, keyGenerator, message }
 */
function rateLimit(opts = {}) {
  const windowMs = opts.windowMs || 15 * 60 * 1000; // 15 min
  const max = opts.max || 30;
  const message = opts.message || 'Trop de tentatives. Réessayez plus tard.';
  const keyGen = opts.keyGenerator || (req => req.ip);
  const hits = new Map(); // key -> { count, reset }

  // Purge périodique pour éviter la fuite mémoire.
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs);
  if (timer.unref) timer.unref();

  return function (req, res, next) {
    const now = Date.now();
    const key = keyGen(req);
    let rec = hits.get(key);
    if (!rec || rec.reset <= now) { rec = { count: 0, reset: now + windowMs }; hits.set(key, rec); }
    rec.count++;
    const remaining = Math.max(0, max - rec.count);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil((rec.reset - now) / 1000)));
    if (rec.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((rec.reset - now) / 1000)));
      return res.status(429).json({ error: message });
    }
    next();
  };
}

module.exports = { securityHeaders, rateLimit, CSP };
