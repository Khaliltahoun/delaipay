'use strict';
/**
 * Pays d'une adresse IP — base LOCALE facultative, jamais d'appel réseau ni de téléchargement.
 *
 * GEOIP_DB = chemin d'un fichier CSV « début,fin,code_pays » (IPv4 pointées, ex. la base libre
 * « IP to Country Lite » de DB-IP, CC BY 4.0, déposée manuellement sur le serveur). Les lignes IPv6 sont ignorées.
 * Sans fichier : pays inconnu, affiché « — ». Les adresses privées / locales ne sont jamais géolocalisées.
 */
const fs = require('fs');
const net = require('net');

let table = null, loadedFrom = null;
const toNum = ip => ip.split('.').reduce((a, o) => a * 256 + (+o), 0);
function load() {
  const p = process.env.GEOIP_DB;
  if (!p) { table = []; loadedFrom = null; return; }
  if (loadedFrom === p) return;
  table = []; loadedFrom = p;
  try {
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const [a, b, cc] = line.replace(/"/g, '').split(',');
      if (!a || !b || !cc || !net.isIPv4(a) || !net.isIPv4(b)) continue;
      table.push([toNum(a), toNum(b), cc.trim().toUpperCase().slice(0, 2)]);
    }
    table.sort((x, y) => x[0] - y[0]);
  } catch (e) { console.error('GEOIP_DB illisible :', e.message); table = []; }
}
function isPrivate(ip) {
  return /^(10\.|127\.|192\.168\.|169\.254\.|0\.)/.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);
}
/** Code pays ISO (2 lettres) ou null. */
function country(ip) {
  if (!ip || !net.isIPv4(ip) || isPrivate(ip)) return null;
  if (table === null || loadedFrom !== (process.env.GEOIP_DB || null)) load();
  if (!table.length) return null;
  const n = toNum(ip);
  let lo = 0, hi = table.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, r = table[mid];
    if (n < r[0]) hi = mid - 1; else if (n > r[1]) lo = mid + 1; else return r[2];
  }
  return null;
}
function configured() { return !!process.env.GEOIP_DB; }

module.exports = { country, configured };
