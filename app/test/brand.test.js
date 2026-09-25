'use strict';
/* Jeu de marque « Échéance » : fichiers présents, dimensions exactes, 16×16 dédié, SVG dessinés à la main
 * (aucune image raster intégrée, aucune ressource distante), manifeste et pages câblés. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');
const BRAND = path.join(PUB, 'assets', 'brand');
const read = f => fs.readFileSync(path.join(BRAND, f));
const pngSize = buf => { assert.equal(buf.slice(1, 4).toString('latin1'), 'PNG'); return [buf.readUInt32BE(16), buf.readUInt32BE(20)]; };

const SVGS = ['delaipay-logo.svg', 'delaipay-logo-light-bg.svg', 'delaipay-logo-dark-bg.svg', 'delaipay-logo-mono.svg',
  'delaipay-symbol-light-bg.svg', 'delaipay-symbol-dark-bg.svg', 'delaipay-symbol-mono.svg', 'delaipay-mark.svg',
  'delaipay-maskable.svg', 'favicon.svg', 'favicon-16.svg'];

test('marque : SVG dessinés à la main — aucune image raster, aucune URL distante, aucun script', () => {
  for (const f of SVGS) {
    const s = read(f).toString('utf8');
    assert.match(s, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox=/, `${f} : SVG autonome`);
    assert.ok(!/<image|base64|<script|href=|url\(/i.test(s), `${f} : ni raster intégré, ni lien, ni script`);
  }
});

test('marque : monochromes en currentColor, 16×16 dédié (grille 16, pas une réduction)', () => {
  for (const f of ['delaipay-symbol-mono.svg', 'delaipay-logo-mono.svg']) {
    const fills = [...read(f).toString().matchAll(/fill="([^"]+)"/g)].map(m => m[1]);
    assert.ok(fills.length && fills.every(x => x === 'currentColor'), `${f} : une seule couleur, héritée`);
  }
  const f16 = read('favicon-16.svg').toString();
  assert.match(f16, /viewBox="0 0 16 16"/);
  assert.match(f16, /shape-rendering="crispEdges"/);
  assert.notEqual(f16.replace(/\s/g, ''), read('favicon.svg').toString().replace(/\s/g, ''), 'dessin propre au 16 px');
});

test('marque : icônes raster aux dimensions exactes et favicon.ico 16 + 32', () => {
  for (const [f, s] of [['favicon-16.png', 16], ['favicon-32.png', 32], ['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512], ['icon-maskable-512.png', 512]])
    assert.deepEqual(pngSize(read(f)), [s, s], f);
  const ico = read('favicon.ico');
  assert.equal(ico.readUInt16LE(2), 1, 'type icône'); assert.equal(ico.readUInt16LE(4), 2, 'deux images');
  const sizes = [0, 1].map(i => ico.readUInt8(6 + 16 * i));
  assert.deepEqual(sizes, [16, 32]);
  const off16 = ico.readUInt32LE(6 + 12), len16 = ico.readUInt32LE(6 + 8);
  assert.ok(ico.slice(off16, off16 + len16).equals(read('favicon-16.png')), 'le 16 px de l’ICO est le dessin dédié');
});

test('marque : manifeste local et pages câblées (favicon 16/32, manifeste, « Propulsé par DelaiPay »)', () => {
  const m = JSON.parse(fs.readFileSync(path.join(PUB, 'manifest.webmanifest'), 'utf8'));
  assert.equal(m.short_name, 'DelaiPay');
  for (const i of m.icons) {
    assert.ok(i.src.startsWith('/assets/brand/'), 'icône locale');
    assert.ok(fs.existsSync(path.join(PUB, i.src)), i.src);
  }
  assert.ok(m.icons.some(i => i.purpose === 'maskable'));
  for (const page of ['app.html', 'login.html', 'invite.html']) {
    const h = fs.readFileSync(path.join(PUB, page), 'utf8');
    assert.match(h, /rel="icon" type="image\/png" sizes="16x16" href="\/assets\/brand\/favicon-16\.png"/, page);
    assert.match(h, /rel="manifest" href="\/manifest\.webmanifest"/, page);
    assert.ok(!/https?:\/\//.test(h.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, '')), `${page} : aucune ressource distante`);
  }
  assert.match(fs.readFileSync(path.join(PUB, 'app.html'), 'utf8'), /class="powered-by"[^>]*>[\s\S]*Propulsé par <b>DelaiPay<\/b>/);
});
