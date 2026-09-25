/* eslint-env browser, node */
'use strict';
/**
 * Couleur d'un espace de travail → variantes ACCESSIBLES (WCAG 2.1).
 *
 * La couleur saisie par un cabinet n'accentue que son identité (monogramme, repère de l'élément actif). Elle ne doit
 * jamais casser le contraste : on la corrige (jamais on ne la refuse).
 *  - `tenant` / `tenantInk` : fond et texte du monogramme — texte ≥ 4,5:1. On garde la couleur d'origine si un texte
 *    encre ou blanc l'atteint ; sinon on l'assombrit jusqu'à 4,5:1 avec du blanc.
 *  - `tenantLine` : repère de l'élément actif sur la barre latérale (fond pétrole) — objet graphique ≥ 3:1 ;
 *    la couleur est éclaircie jusqu'à l'atteindre.
 */
(function () {
const INK = '#0F2530';
const WHITE = '#FFFFFF';
const SIDEBARS = ['#0C2A36', '#08171D']; // barre latérale claire / sombre (le repère doit tenir sur les deux)
const DEFAULT = '#15475A';
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

const toRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const toHex = rgb => '#' + rgb.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
function luminance(hex) {
  const [r, g, b] = toRgb(hex).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
// Mélange linéaire (sRGB) de `hex` vers `target`, t ∈ [0, 1].
function mix(hex, target, t) {
  const a = toRgb(hex), b = toRgb(target);
  return toHex(a.map((v, i) => v + (b[i] - v) * t));
}
// Plus petit mélange vers `target` qui satisfait `ok` (pas de 2 %).
function adjust(hex, target, ok) {
  for (let t = 0; t <= 1.0001; t += 0.02) { const c = mix(hex, target, t); if (ok(c)) return c; }
  return target;
}

/** Variantes accessibles d'une couleur d'espace (ou de la couleur par défaut). */
function tenantPalette(input) {
  const base = HEX_RE.test(input || '') ? input.toUpperCase() : DEFAULT;
  let tenant = base, tenantInk;
  if (contrast(WHITE, base) >= 4.5) tenantInk = WHITE;
  else if (contrast(INK, base) >= 4.5) tenantInk = INK;
  else { tenant = adjust(base, '#000000', c => contrast(WHITE, c) >= 4.5); tenantInk = WHITE; }
  const tenantLine = adjust(base, WHITE, c => SIDEBARS.every(s => contrast(c, s) >= 3));
  return { source: base, tenant, tenantInk, tenantLine, corrected: tenant !== base };
}

const api = { tenantPalette, contrast, luminance, mix, INK, WHITE, SIDEBARS };
// Même fichier pour le serveur (CommonJS) et l'aperçu en direct des paramètres (servi sur /js/brand-color.js).
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else if (typeof window !== 'undefined') window.brandColor = api;
})();
