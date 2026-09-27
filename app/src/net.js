'use strict';
/**
 * Réseau — adresse IP du client, proxy de confiance, listes CIDR. Sans dépendance externe.
 *
 * PROXY DE CONFIANCE (INC 3A) : l'en-tête X-Forwarded-For n'est lu QUE s'il provient d'un proxy déclaré
 * dans la variable TRUST_PROXY (valeurs Express : « loopback », « 127.0.0.1 », « 10.0.0.0/8, 127.0.0.1 »…).
 * Sans TRUST_PROXY, req.ip = adresse de la connexion TCP : un X-Forwarded-For forgé par le client est ignoré.
 * Production derrière nginx sur la même machine : TRUST_PROXY=loopback.
 */
const net = require('net');

/** Valeur à passer à app.set('trust proxy', …) — false par défaut (aucun en-tête de proxy cru). */
function trustProxySetting(raw = process.env.TRUST_PROXY) {
  if (raw == null || String(raw).trim() === '' || /^(0|false|non|no)$/i.test(String(raw).trim())) return false;
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) return +s; // nombre de sauts (déconseillé : documenté pour compatibilité)
  return s.split(',').map(x => x.trim()).filter(Boolean);
}

/** « ::ffff:127.0.0.1 » → « 127.0.0.1 » ; supprime la zone IPv6 ; null si l'adresse est illisible. */
function normalizeIp(ip) {
  if (!ip) return null;
  let s = String(ip).trim();
  if (s.startsWith('::ffff:') && net.isIPv4(s.slice(7))) s = s.slice(7);
  s = s.replace(/%.*$/, '');
  return net.isIP(s) ? s.toLowerCase() : null;
}
function clientIp(req) { return normalizeIp(req && (req.ip || (req.socket && req.socket.remoteAddress))) || null; }

/**
 * Valide et normalise une entrée CIDR (« 203.0.113.7 », « 203.0.113.0/24 », « 2001:db8::/32 »).
 * @returns {{ok:true, cidr, family, base, prefix}|{ok:false, error}}
 */
function parseCidr(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return { ok: false, error: 'Adresse ou plage vide.' };
  const [addr, pfx, extra] = raw.split('/');
  if (extra !== undefined) return { ok: false, error: `« ${raw} » : format attendu 203.0.113.0/24 ou 203.0.113.7.` };
  const ip = normalizeIp(addr);
  if (!ip) return { ok: false, error: `« ${raw} » n’est pas une adresse IP valide.` };
  const family = net.isIPv4(ip) ? 4 : 6, max = family === 4 ? 32 : 128;
  const prefix = pfx === undefined ? max : (/^\d{1,3}$/.test(pfx) ? +pfx : NaN);
  if (!(prefix >= 0 && prefix <= max)) return { ok: false, error: `« ${raw} » : longueur de préfixe invalide (0 à ${max}).` };
  if (prefix < (family === 4 ? 8 : 16)) return { ok: false, error: `« ${raw} » : plage trop large (/${prefix}). Utilisez au moins /${family === 4 ? 8 : 16}.` };
  return { ok: true, cidr: prefix === max ? ip : `${ip}/${prefix}`, family, base: ip, prefix };
}

/** Liste CIDR → objet { has(ip) }. Les entrées invalides sont ignorées (elles sont refusées à l'enregistrement). */
function cidrMatcher(list) {
  const bl = new net.BlockList();
  let n = 0;
  for (const e of list || []) {
    const p = parseCidr(typeof e === 'string' ? e : e && e.cidr);
    if (!p.ok) continue;
    bl.addSubnet(p.base, p.prefix, p.family === 4 ? 'ipv4' : 'ipv6'); n++;
  }
  return {
    size: n,
    has(ip) {
      const a = normalizeIp(ip); if (!a || !n) return false;
      try { return bl.check(a, net.isIPv4(a) ? 'ipv4' : 'ipv6'); } catch (_) { return false; }
    },
  };
}
function ipInList(ip, list) { return cidrMatcher(list).has(ip); }

module.exports = { trustProxySetting, normalizeIp, clientIp, parseCidr, cidrMatcher, ipInList };
