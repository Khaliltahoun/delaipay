'use strict';
/**
 * Affichage des horodatages (INC 3A) — partagé par le serveur (tests) et les navigateurs (/js/time-format.js).
 * Les valeurs STOCKÉES restent en UTC (SQLite « AAAA-MM-JJ HH:MM:SS[.mmm] » ou ISO 8601) ; l'AFFICHAGE se fait
 * dans le fuseau de l'espace (Africa/Casablanca par défaut) avec le fuseau indiqué : « 27/09/2026 à 22:48 (UTC+1) ».
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DPTime = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DEFAULT_TZ = 'Africa/Casablanca';
  /** Horodatage stocké (UTC) → Date ; null si illisible. Une valeur SANS fuseau est TOUJOURS lue comme UTC. */
  function parseStored(s) {
    if (s == null || s === '') return null;
    if (s instanceof Date) return isNaN(s) ? null : s;
    const str = String(s).trim();
    const iso = /[zZ]$|[+-]\d\d:?\d\d$/.test(str) ? str.replace(' ', 'T') : str.replace(' ', 'T') + 'Z';
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(str) ? str + 'T00:00:00Z' : iso);
    return isNaN(d) ? null : d;
  }
  function parts(d, tz) {
    const f = new Intl.DateTimeFormat('fr-FR', { timeZone: tz || DEFAULT_TZ, day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset' });
    const o = {}; for (const p of f.formatToParts(d)) o[p.type] = p.value;
    return o;
  }
  /** « 27/09/2026 à 22:48 (UTC+1) » — `withZone:false` pour omettre le fuseau. */
  function formatLocal(s, tz, { withZone = true } = {}) {
    const d = parseStored(s); if (!d) return '—';
    let p;
    try { p = parts(d, tz); } catch (_) { p = parts(d, DEFAULT_TZ); }
    const zone = (p.timeZoneName || 'UTC').replace(/^GMT/, 'UTC');
    return `${p.day}/${p.month}/${p.year} à ${p.hour}:${p.minute}${withZone ? ` (${zone === 'UTC' ? 'UTC' : zone})` : ''}`;
  }
  /** Libellé du fuseau seul, ex. « UTC+1 ». */
  function zoneLabel(tz, at = new Date()) { try { return (parts(at, tz).timeZoneName || 'UTC').replace(/^GMT/, 'UTC'); } catch (_) { return 'UTC'; } }
  return { parseStored, formatLocal, zoneLabel, DEFAULT_TZ };
});
