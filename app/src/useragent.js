'use strict';
/**
 * Lecture PRUDENTE du navigateur, du système et du type d'appareil (affichage uniquement, jamais une décision
 * de sécurité). Le MODÈLE d'appareil n'est JAMAIS deviné à partir du User-Agent : il provient uniquement de
 * l'indice client Sec-CH-UA-Model (demandé par Accept-CH), sinon il reste inconnu (« — »).
 */
function pick(list, s) { for (const [re, name, verRe] of list) { if (re.test(s)) { const m = verRe ? s.match(verRe) : null; return m ? `${name} ${m[1]}` : name; } } return null; }
const BROWSERS = [
  [/Edg\//, 'Edge', /Edg\/(\d+)/], [/OPR\//, 'Opera', /OPR\/(\d+)/], [/SamsungBrowser\//, 'Samsung Internet', /SamsungBrowser\/(\d+)/],
  [/Firefox\//, 'Firefox', /Firefox\/(\d+)/], [/FxiOS\//, 'Firefox', /FxiOS\/(\d+)/], [/CriOS\//, 'Chrome', /CriOS\/(\d+)/],
  [/Chrome\//, 'Chrome', /Chrome\/(\d+)/], [/Version\/[\d.]+.*Safari\//, 'Safari', /Version\/(\d+)/],
];
const OSES = [
  [/Windows NT/, 'Windows'], [/iPhone|iPad|iPod/, 'iOS'], [/Mac OS X|Macintosh/, 'macOS'], [/Android/, 'Android'],
  [/CrOS/, 'ChromeOS'], [/Linux/, 'Linux'],
];
const unq = v => (v == null ? null : String(v).trim().replace(/^"|"$/g, '').slice(0, 80) || null);

/** @returns {{navigateur, os, type_appareil, modele}} */
function describe(headers = {}) {
  const ua = String(headers['user-agent'] || '');
  const chPlatform = unq(headers['sec-ch-ua-platform']);
  const chMobile = headers['sec-ch-ua-mobile'];
  const model = unq(headers['sec-ch-ua-model']);
  const navigateur = pick(BROWSERS, ua);
  let os = pick(OSES, ua);
  if (chPlatform) os = chPlatform === 'macOS' ? 'macOS' : chPlatform;
  let type = 'ordinateur';
  if (/iPad|Tablet/i.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))) type = 'tablette';
  else if (chMobile === '?1' || /Mobi|iPhone|iPod/i.test(ua)) type = 'mobile';
  if (!ua) type = null;
  return { navigateur, os, type_appareil: type, modele: model };
}

/** En-têtes à envoyer pour obtenir le modèle (navigateurs Chromium, contexte sécurisé). */
const ACCEPT_CH = 'Sec-CH-UA-Model, Sec-CH-UA-Platform, Sec-CH-UA-Platform-Version, Sec-CH-UA-Mobile';

module.exports = { describe, ACCEPT_CH };
