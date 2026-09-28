'use strict';
/* Horodatages du journal (espace et plateforme) : stockés en UTC, affichés dans le fuseau de l'espace, fuseau indiqué. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const t = require('../src/time-format');

test('journal : heure stockée UTC affichée dans le fuseau de l’espace, avec le fuseau', () => {
  // Valeur SQLite datetime('now') (UTC, sans fuseau) et variante milliseconde (platform_audit, login_event).
  assert.equal(t.formatLocal('2026-09-27 21:48:00'), '27/09/2026 à 22:48 (UTC+1)', 'défaut Africa/Casablanca');
  assert.equal(t.formatLocal('2026-09-27 21:48:00.123', 'Africa/Casablanca'), '27/09/2026 à 22:48 (UTC+1)');
  assert.equal(t.formatLocal('2026-09-27 21:48:00', 'UTC'), '27/09/2026 à 21:48 (UTC+0)');
  assert.equal(t.formatLocal('2026-07-15 10:00:00', 'Europe/Paris'), '15/07/2026 à 12:00 (UTC+2)', 'heure d’été');
  assert.equal(t.formatLocal('2026-01-15T10:00:00Z', 'Europe/Paris'), '15/01/2026 à 11:00 (UTC+1)');
  assert.equal(t.formatLocal('2026-12-31 23:30:00'), '01/01/2027 à 00:30 (UTC+1)', 'changement de jour');
  assert.equal(t.formatLocal('2026-09-27 21:48:00', 'Africa/Casablanca', { withZone: false }), '27/09/2026 à 22:48');
  for (const bad of [null, '', 'pas une date']) assert.equal(t.formatLocal(bad), '—');
  assert.equal(t.formatLocal('2026-09-27 21:48:00', 'Fuseau/Inconnu'), '27/09/2026 à 22:48 (UTC+1)', 'fuseau inconnu : repli sur Africa/Casablanca');
  assert.equal(t.zoneLabel('Africa/Casablanca'), 'UTC+1');
});

test('journal : même formateur dans l’espace et la console (servi à /js/time-format.js)', async () => {
  const pub = path.join(__dirname, '..', 'public');
  assert.match(fs.readFileSync(path.join(pub, 'app.html'), 'utf8'), /\/js\/time-format\.js/);
  assert.match(fs.readFileSync(path.join(pub, 'console.html'), 'utf8'), /\/js\/time-format\.js/);
  const app = fs.readFileSync(path.join(pub, 'js', 'app.js'), 'utf8');
  assert.match(app, /tsLocal\(a\.created_at\)/, 'journal de l’espace : fuseau de l’espace');
  assert.ok(!/esc\(dateTimeFr\(/.test(app), 'plus aucun horodatage affiché en UTC brut');
  const con = fs.readFileSync(path.join(pub, 'js', 'console.js'), 'utf8');
  assert.match(con, /C\.fdtz\(r\.created_at\)/, 'journal plateforme : fuseau affiché');
  // Le module est exécutable tel quel dans un navigateur (global DPTime).
  const sandbox = {}; new Function('self', fs.readFileSync(path.join(__dirname, '..', 'src', 'time-format.js'), 'utf8').replace("typeof module === 'object' && module.exports", 'false'))(sandbox);
  assert.equal(sandbox.DPTime.formatLocal('2026-09-27 21:48:00'), '27/09/2026 à 22:48 (UTC+1)');
});

test('TZ-1 : instant proche de minuit UTC → bonne date locale ; Ramadan → UTC+0 ; saisie locale → UTC', () => {
  assert.equal(t.formatDate('2026-09-27 23:40:10'), '28/09/2026', '23:40 UTC = 00:40 le 28 à Casablanca');
  assert.equal(t.formatLocal('2026-09-27 23:40:10'), '28/09/2026 à 00:40 (UTC+1)');
  assert.equal(t.formatDate('2026-09-27'), '27/09/2026', 'date calendaire : jamais convertie');
  assert.equal(t.formatDate('2026-10-04 23:09:03', 'Africa/Casablanca'), '05/10/2026');
  // Ramadan 2026 (heure légale ramenée à UTC+0 au Maroc) : libellé calculé à la date, jamais codé en dur.
  assert.equal(t.formatLocal('2026-03-01 23:30:00'), '01/03/2026 à 23:30 (UTC+0)');
  assert.equal(t.zoneLabel('Africa/Casablanca', '2026-03-01 12:00:00'), 'UTC+0');
  assert.equal(t.zoneLabel('Africa/Casablanca', '2026-09-28 12:00:00'), 'UTC+1');
  assert.equal(t.formatValue('2026-09-27 23:25:10'), '28/09/2026 à 00:25 (UTC+1)', 'détail du journal');
  assert.equal(t.formatValue('texte'), 'texte');
  assert.equal(t.fromLocalInput('2026-09-28T23:00', 'Africa/Casablanca'), '2026-09-28T22:00:00.000Z');
  assert.equal(t.fromLocalInput('2026-03-01T10:00', 'Africa/Casablanca'), '2026-03-01T10:00:00.000Z', 'Ramadan : UTC+0');
});

test('TZ-1 : plus aucun formatage direct des dates dans le code d’affichage', () => {
  const dir = path.join(__dirname, '..', 'public', 'js');
  // Seules exceptions : données envoyées au serveur (toISOString), champs de formulaire de dates calendaires, nombres (toLocaleString).
  const allowed = [/toLocaleString\('fr-FR'/, /le: new Date\(\)\.toISOString\(\)/, /const v = x => \(x \? String\(x\)\.slice\(0, 10\)/, /exFresh/, /fromLocalInput/];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
    fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((line, i) => {
      if (!/toISOString|toLocale(Date|Time)?String|getHours\(\)|reverse\(\)\.join\('\/'\)|\.slice\(0, 1[069]\)/.test(line)) return;
      assert.ok(allowed.some(re => re.test(line)), `${f}:${i + 1} formate une date sans passer par time-format.js : ${line.trim().slice(0, 120)}`);
    });
  }
  for (const page of ['invite.html', 'reset.html', 'login.html', 'app.html', 'console.html'])
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'public', page), 'utf8'), /\/js\/time-format\.js/, page);
});
