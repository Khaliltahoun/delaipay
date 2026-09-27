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
