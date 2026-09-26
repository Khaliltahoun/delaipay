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

// Extrait une déclaration (const / function) de app.js pour la tester isolément (pas de DOM).
function fromApp(names) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const parts = names.map(n => {
    const re = new RegExp(`^(?:const ${n} = [\\s\\S]*?;\\n(?=const |function |\\/\\/|$)|function ${n}\\([\\s\\S]*?\\n}\\n)`, 'm');
    const m = src.match(re); assert.ok(m, `${n} introuvable dans app.js`); return m[0];
  });
  return new Function(parts.join('\n') + `\nreturn { ${names.join(', ')} };`)();
}
test('journal d’audit : détails lisibles — ni JSON brut, ni rôle technique (P3-9)', () => {
  const { auditDetails } = fromApp(['money', 'dateFr', 'ROLE_FR', 'DET_KEY', 'HIDDEN_DET', 'INTERNAL_ID', 'facLine', 'detVal', 'auditDetails']);
  assert.equal(auditDetails('{"email":"admin@hlz.demo"}'), 'E-mail : admin@hlz.demo');
  assert.equal(auditDetails('{"avant":"lecture","apres":"collaborateur","id":"usr_x"}'), 'Avant : Lecture seule · Après : Comptable');
  assert.equal(auditDetails('{"annee":2026,"trimestre":1,"figee":false}'), 'Année : 2026 · Trimestre : T1 · Période figée : Non');
  assert.equal(auditDetails('texte libre'), 'texte libre');
  assert.equal(auditDetails(null), '');
  assert.ok(!/[{}"]/.test(auditDetails('{"role":"admin","x":{"nb":3}}')), 'aucun caractère JSON');
});

test('navigation : groupes métier dans l’ordre, chaque entrée mène à une vue existante', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const groups = [...html.matchAll(/<div class="nav-lbl">([^<]+)<\/div>/g)].map(m => m[1].replace('&amp;', '&'));
  assert.deepEqual(groups, ['Pilotage', 'Clients & factures', 'Déclarations', 'Paramètres']);
  const views = new Set([...js.slice(js.indexOf('const VIEWS = {'), js.indexOf('};', js.indexOf('const VIEWS = {'))).matchAll(/^\s+([a-z]+): \{/gm)].map(m => m[1]));
  const navTargets = [...html.matchAll(/class="nav-item" data-view="([a-z]+)"/g)].map(m => m[1]);
  for (const v of navTargets) assert.ok(views.has(v), `entrée « ${v} » sans vue`);
  for (const v of ['fournisseurs', 'reseau']) assert.ok(navTargets.includes(v), `page ${v} dans la navigation`);
});

test('messages d’erreur : aucune clé technique visible (« four_nom » → « Fournisseur »)', () => {
  const { plainMsg } = fromApp(['FIELD_FR', 'plainMsg']);
  assert.equal(plainMsg('Champ obligatoire « four_nom » non mappé.'), 'Champ obligatoire « Fournisseur » non mappé.');
  assert.equal(plainMsg('Mapping refusé : a | b'), 'Correspondance des colonnes refusée : a — b');
  assert.equal(plainMsg('La colonne « MONTANT » du champ « date_facture »'), 'La colonne « MONTANT » du champ « Date de facture »', 'un en-tête de fichier n’est pas traduit');
});

test('P3/NEW-1 : dossier supprimé ou identifiant périmé → sélection oubliée, jamais une page bloquée', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.match(js, /e\.code === 'client_introuvable' && seq === _renderSeq\) return clientGone\(\)/, 'la vue redirige vers les clients');
  assert.match(js, /catch \(e\) \{ if \(e\.code === 'client_introuvable'\) \{ forgetClient\(\);/, 'le chargement des périodes ne bloque pas le démarrage');
  assert.match(js, /localStorage\.removeItem\('dp-client'\)/, 'la sélection mémorisée est effacée');
  assert.match(js, /Aucun dossier sélectionné/, 'EMPTY-1 : « aucun sélectionné » distinct de « aucun client »');
});

test('VER-2b : le journal AFFICHE le(s) numéro(s) de facture des levées, annulations et résolutions (rendu, pas seulement stocké)', () => {
  const { auditDetails } = fromApp(['money', 'dateFr', 'ROLE_FR', 'DET_KEY', 'HIDDEN_DET', 'INTERNAL_ID', 'facLine', 'detVal', 'auditDetails']);
  const lev = auditDetails(JSON.stringify({ anomalie: 'ano_4gBW0ccu2-7k', type: 'convention_absente', facture: '1299/2025',
    factures: [{ numero: '1299/2025', date_facture: '2025-11-30', ttc: 1385 }], fournisseur: 'BETA EXPRESS SARL', periode: 'T1 2026',
    convention: { id: 'conv_6etmfzT0InpC', delai: 120, date_signature: '2025-12-15', date_effet: '2026-01-01', date_fin: null },
    utilisateur: { id: 'usr_x', nom: 'Admin' }, horodatage: '2026-09-26T14:00:12.000Z', accuse_signature_retroactive: true }));
  assert.match(lev, /Factures : 1299\/2025 du 30\/11\/2025 1 385,00 DH TTC/);
  assert.match(lev, /Fournisseur : BETA EXPRESS SARL/); assert.match(lev, /Signature : 15\/12\/2025/);
  assert.ok(!/ano_|conv_|usr_|2026-09-26T/.test(lev), 'aucun identifiant interne ni horodatage ISO');
  const dup = auditDetails(JSON.stringify({ anomalie: 'ano_oOSS0vj3a9Wt', type: 'doublon_potentiel', facture: 'FA25-5256, FA25-5256',
    factures: [{ numero: 'FA25-5256', date_facture: '2025-12-19', ttc: 76111 }, { numero: 'FA25-5256', date_facture: '2025-12-19', ttc: 76111 }], motif: 'Deux règlements partiels' }));
  assert.equal((dup.match(/FA25-5256 du 19\/12\/2025 76 111,00 DH TTC/g) || []).length, 2, 'doublon : toutes les factures concernées');
  assert.ok(!/Facture : /.test(dup), 'pas de doublon de libellé');
  assert.equal(auditDetails(JSON.stringify({ facture: 'fac_AbCdEf123456', avant: 'potentiel', apres: 'confirme' })), 'Avant : potentiel · Après : confirme', 'identifiant interne masqué');
  const clo = auditDetails(JSON.stringify({ verifications_en_attente: { ouvertes: 26, aVerifier: 12, convManquantes: 8, horsValidite: 1, total: 47 }, accuse_verifications: true }));
  assert.match(clo, /anomalies ouvertes : 26, à vérifier : 12, sans convention justificative : 8/); assert.ok(!/aVerifier|convManquantes/.test(clo));
});
