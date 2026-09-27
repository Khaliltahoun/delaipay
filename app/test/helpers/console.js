'use strict';
/** Session de console complète (mot de passe + enrôlement TOTP) pour les tests. Nécessite TRUST_PROXY=loopback. */
const assert = require('node:assert');
const H = require('./http');

const ADMIN = 'admin.localhost';
const PW = 'Plateforme-Sure-2026!';
let ipSeq = 10, admSeq = 0;
const newIp = (prefix = '198.51.100') => `${prefix}.${(ipSeq++ % 250) + 1}`;
function consoleBrowser(ip = newIp('192.0.2')) {
  return H.browser(ADMIN, { headers: { 'X-Forwarded-For': ip, 'X-DP-Console': '1', 'User-Agent': 'Mozilla/5.0 (Macintosh) Chrome/128' } });
}
async function consoleSession() {
  const pauth = require('../../src/platform/auth');
  const totp = require('../../src/platform/totp');
  const email = `ops-h${++admSeq}-${process.pid}@delaipay.test`;
  pauth.createAdmin({ email, nom: 'Opérateur H' + admSeq, password: PW });
  const b = consoleBrowser();
  let r = await b.post('/api/platform/auth/login', { email, password: PW });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await b.get('/api/platform/auth/enrolment');
  const secret = r.body.secret.replace(/\s/g, '');
  r = await b.post('/api/platform/auth/enrolment', { code: totp.totp(secret) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return Object.assign(b, { email, secret });
}
module.exports = { ADMIN, PW, newIp, consoleBrowser, consoleSession };
