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
  const zoneOf = p => { const z = (p.timeZoneName || 'UTC').replace(/^GMT/, 'UTC'); return z === 'UTC' ? 'UTC+0' : z; };
  function safeParts(d, tz) { try { return parts(d, tz); } catch (_) { return parts(d, DEFAULT_TZ); } }
  /** Instant stocké ? (date ET heure) — les dates calendaires « AAAA-MM-JJ » ne sont jamais converties de fuseau. */
  const INSTANT_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d\d:?\d\d)?$/;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  function isInstant(v) { return typeof v === 'string' && INSTANT_RE.test(v.trim()); }
  /** « 27/09/2026 à 22:48 (UTC+1) » — `withZone:false` pour omettre le fuseau. Libellé calculé à CETTE date (UTC+0 en Ramadan). */
  function formatLocal(s, tz, { withZone = true } = {}) {
    const d = parseStored(s); if (!d) return '—';
    const p = safeParts(d, tz);
    return `${p.day}/${p.month}/${p.year} à ${p.hour}:${p.minute}${withZone ? ` (${zoneOf(p)})` : ''}`;
  }
  /** Date seule. Instant → jour local dans le fuseau (jamais un jour de décalage) ; date calendaire → telle quelle. */
  function formatDate(s, tz) {
    if (s == null || s === '') return '—';
    const str = String(s).trim();
    if (DATE_RE.test(str)) { const [y, m, d] = str.split('-'); return `${d}/${m}/${y}`; }
    const d = parseStored(str); if (!d) return '—';
    const p = safeParts(d, tz);
    return `${p.day}/${p.month}/${p.year}`;
  }
  /** Valeur quelconque d'un détail (journal) : instant → heure locale avec fuseau ; date calendaire → jj/mm/aaaa ; sinon inchangée. */
  function formatValue(v, tz) {
    if (isInstant(v)) return formatLocal(v, tz);
    if (typeof v === 'string' && DATE_RE.test(v.trim())) return formatDate(v, tz);
    return v;
  }
  /** Libellé du fuseau seul à une date, ex. « UTC+1 » (ou « UTC+0 » pendant le Ramadan au Maroc). */
  function zoneLabel(tz, at = new Date()) { return zoneOf(safeParts(at instanceof Date ? at : parseStored(at) || new Date(), tz)); }
  /** Saisie locale « AAAA-MM-JJTHH:MM » (champ datetime-local) interprétée DANS le fuseau → instant ISO UTC. */
  function fromLocalInput(str, tz) {
    const m = String(str || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/); if (!m) return null;
    const wanted = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    let t = wanted;
    for (let i = 0; i < 2; i++) {
      const p = safeParts(new Date(t), tz);
      const shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
      t += wanted - shown;
    }
    return new Date(t).toISOString();
  }
  return { parseStored, formatLocal, formatDate, formatValue, isInstant, zoneLabel, fromLocalInput, DEFAULT_TZ };
});
