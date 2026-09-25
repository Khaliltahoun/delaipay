'use strict';
/* Design system : couleur d'espace toujours accessible, jetons du thème conformes WCAG AA, aucune taille de police hors échelle. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const bc = require('../src/brand-color');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
const ok = (p) => {
  assert.ok(bc.contrast(p.tenant, p.tenantInk) >= 4.5, `monogramme ${p.source} → ${p.tenant}/${p.tenantInk}`);
  for (const s of bc.SIDEBARS) assert.ok(bc.contrast(p.tenantLine, s) >= 3, `repère actif ${p.source} → ${p.tenantLine} sur ${s}`);
};

test('couleur d’espace #7A3E9D : conservée, texte blanc ≥ 4,5:1, repère actif éclairci ≥ 3:1', () => {
  const p = bc.tenantPalette('#7A3E9D');
  assert.equal(p.tenant, '#7A3E9D'); assert.equal(p.tenantInk, '#FFFFFF'); assert.equal(p.corrected, false);
  assert.notEqual(p.tenantLine, '#7A3E9D', 'violet trop sombre sur la barre latérale → éclairci');
  ok(p);
});

test('couleur d’espace très claire #F5F0C8 : texte encre (jamais blanc sur jaune pâle)', () => {
  const p = bc.tenantPalette('#F5F0C8');
  assert.equal(p.tenantInk, bc.INK);
  ok(p);
  assert.ok(bc.contrast('#FFFFFF', '#F5F0C8') < 1.2, 'le blanc aurait été illisible');
});

test('couleur d’espace : gris moyen corrigé (ni blanc ni encre n’atteignaient 4,5:1), entrée invalide → défaut', () => {
  const p = bc.tenantPalette('#808080');
  assert.equal(p.corrected, true); ok(p);
  for (const bad of [null, '', 'red', '#FFF', '#12345G', 'javascript:alert(1)']) { const d = bc.tenantPalette(bad); assert.equal(d.source, '#15475A'); ok(d); }
});

test('couleur d’espace : invariants tenus sur 1 000 couleurs quelconques', () => {
  let seed = 42; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 1000; i++) ok(bc.tenantPalette('#' + Math.floor(rnd() * 0xFFFFFF).toString(16).padStart(6, '0').toUpperCase()));
});

test('identité publique d’un espace : variantes accessibles fournies à l’interface', () => {
  const tenant = require('../src/tenant');
  const b = tenant.publicBranding({ nom: 'Cabinet Test', slug: 'test', couleur_primaire: '#F5F0C8' });
  assert.deepEqual(Object.keys(b.palette).sort(), ['corrected', 'source', 'tenant', 'tenantInk', 'tenantLine']);
  assert.equal(b.palette.tenantInk, bc.INK);
});

// Jetons de thème : lecture directe de app.css (source unique).
function tokens(selector) {
  const start = CSS.indexOf(selector + '{'); assert.ok(start >= 0, selector);
  const body = CSS.slice(start, CSS.indexOf('\n}', start));
  const out = {}; for (const m of body.matchAll(/--([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})\b/g)) out[m[1]] = m[2];
  return out;
}
test('jetons : textes et statuts ≥ 4,5:1 (WCAG AA) dans les thèmes clair et sombre', () => {
  const light = tokens(':root'), dark = { ...light, ...tokens(':root[data-theme="dark"]') };
  for (const [name, t] of [['clair', light], ['sombre', dark]]) {
    for (const bg of ['surface', 'bg', 'surface-2', 'surface-3']) for (const fg of ['ink', 'ink-2', 'muted', 'faint', 'ok', 'watch', 'warn', 'late', 'severe', 'info', 'locked'])
      assert.ok(bc.contrast(t[fg], t[bg]) >= 4.5, `${name} : --${fg} ${t[fg]} sur --${bg} ${t[bg]} = ${bc.contrast(t[fg], t[bg]).toFixed(2)}`);
    for (const st of ['ok', 'watch', 'warn', 'late', 'severe', 'info', 'locked'])
      assert.ok(bc.contrast(t[st], t[st + '-soft']) >= 4.5, `${name} : pastille --${st} sur --${st}-soft`);
    assert.ok(bc.contrast(t['btn-primary-ink'], t['btn-primary-bg']) >= 4.5, `${name} : bouton principal`);
    assert.ok(bc.contrast(t['btn-primary-ink'], t['btn-primary-hover']) >= 4.5, `${name} : bouton principal survolé`);
  }
  // Même famille pétrole pour le bouton principal dans les deux thèmes (plus de cyan pâle en sombre).
  assert.ok(bc.luminance(dark['btn-primary-bg']) < 0.2);
});

test('jetons : aucune taille de police littérale hors de l’échelle (CSS et JS)', () => {
  const files = ['public/css/app.css', 'public/js/app.js', 'public/js/login.js', 'public/js/invite.js', 'public/app.html', 'public/login.html', 'public/invite.html'];
  for (const f of files) {
    const s = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.deepEqual(s.match(/font-size:\s*[0-9.]+px/g) || [], [], `${f} : utiliser var(--fs-*)`);
  }
});
