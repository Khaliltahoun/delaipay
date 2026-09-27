'use strict';
/* Visa (modifications de visa.js autorisées par le fondateur, 2026-09-27) : conclusions, observations, lieu. */
const { test } = require('node:test');
const assert = require('node:assert');
const visa = require('../src/visa');

const E = { raison_sociale: 'STE ORYX AUTO SARL', adresse: 'Zone industrielle, Tanger' };
const base = { e: E, annee: 2026, trimestre: 1, montant: 350964.42, signataire: 'Leïla Amrani', type: 'EC' };
const text = d => d.blocks.map(b => (b.runs || []).map(r => r.t).join('')).join('\n');

test('visa : conclusion vide ou non reconnue refusée (jamais « pas d’observations » par défaut)', () => {
  for (const c of [undefined, null, '', 'Autre', 'sans observation', 'Refus']) {
    assert.throws(() => visa.buildData({ ...base, conclusion: c }), err => err.code === 'conclusion_invalide' && /Conclusion du visa/.test(err.message), String(c));
  }
  assert.deepEqual(visa.CONCLUSIONS, ['Sans observation', 'Avec observation', 'Avec réserve', 'Refus de visa']);
});

test('visa : contenu de la lettre pour chaque conclusion (VISA-2)', () => {
  const sans = text(visa.buildData({ ...base, conclusion: 'Sans observation', observations: 'ignorée' }));
  assert.match(sans, /nous n'avons pas d'observations sur la concordance/);
  assert.ok(!/Observations :|Réserves :|ignorée/.test(sans), 'aucune observation imprimée');
  const refus = text(visa.buildData({ ...base, conclusion: 'Refus de visa' }));
  assert.match(refus, /nous ne sommes pas en mesure de nous prononcer/);
  assert.ok(!/Observations :|Réserves :/.test(refus));
  const obs = visa.buildData({ ...base, conclusion: 'Avec observation', observations: '- Deux factures sans bon de commande.\n\n2) Convention BETA signée après la facture.' });
  const t = text(obs);
  assert.deepEqual(obs.observations, ['Deux factures sans bon de commande.', 'Convention BETA signée après la facture.']);
  assert.match(t, /sous réserve des observations mentionnées ci-dessus/);
  const iObs = t.indexOf('Observations :'), i1 = t.indexOf('1. Deux factures'), i2 = t.indexOf('2. Convention BETA'), iConcl = t.indexOf('Conclusion :');
  assert.ok(iObs > 0 && iObs < i1 && i1 < i2 && i2 < iConcl, 'observations numérotées juste avant la conclusion');
  assert.ok(t.indexOf('ne constitue ni un audit') < iObs, 'après les paragraphes de méthode');
  const res = text(visa.buildData({ ...base, conclusion: 'Avec réserve', observations: ['Justificatifs manquants pour 3 factures.'] }));
  assert.match(res, /en raison des réserves mentionnées ci-dessus/);
  assert.ok(res.indexOf('Réserves :') < res.indexOf('1. Justificatifs manquants') && res.indexOf('1. Justificatifs manquants') < res.indexOf('Conclusion :'));
});

test('visa : « Avec observation » et « Avec réserve » exigent au moins une observation (côté serveur)', () => {
  for (const c of ['Avec observation', 'Avec réserve'])
    for (const o of [undefined, '', '   \n  \n', [], ['  ']])
      assert.throws(() => visa.buildData({ ...base, conclusion: c, observations: o }), err => err.code === 'observations_requises', `${c} / ${JSON.stringify(o)}`);
  assert.throws(() => visa.buildData({ ...base, conclusion: 'Avec réserve', observations: Array(21).fill('x') }), err => err.code === 'observations_trop_nombreuses');
  assert.doesNotThrow(() => visa.buildData({ ...base, conclusion: 'Sans observation' }));
  assert.doesNotThrow(() => visa.buildData({ ...base, conclusion: 'Refus de visa' }));
});

test('visa : ville de signature tirée de l’adresse de l’espace (P3-11), repli explicite sans ville', () => {
  assert.equal(visa.cityFromAddress('12 bd Zerktouni, 20000 Casablanca'), 'Casablanca');
  assert.equal(visa.cityFromAddress('Résidence Al Andalous\nAgdal, Rabat, Maroc'), 'Rabat');
  assert.equal(visa.cityFromAddress('Avenue Mohammed V 40000 Marrakech'), 'Marrakech');
  assert.equal(visa.cityFromAddress('Fès'), 'Fès');
  for (const a of [null, '', '   ', '20000', ', ,']) assert.equal(visa.cityFromAddress(a), null, JSON.stringify(a));
  const withCity = visa.buildData({ ...base, conclusion: 'Sans observation', adresseCabinet: '45 rue Ibn Batouta, 90000 Tanger' });
  assert.equal(withCity.lieu, 'Tanger');
  assert.match(text(withCity), /\nTanger le \d{2}\/\d{2}\/\d{4}\n/);
  const none = visa.buildData({ ...base, conclusion: 'Sans observation' });
  assert.equal(none.lieu, null);
  assert.match(text(none), /\nLe \d{2}\/\d{2}\/\d{4}\n/);
  for (const d of [withCity, none]) assert.ok(!text(d).includes('Marrakech'), 'plus aucune ville codée en dur');
});
