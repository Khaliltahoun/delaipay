'use strict';
/**
 * Données de DÉMONSTRATION entièrement FICTIVES (aucun client, fournisseur ni identifiant réel).
 *
 * Le classeur `fixtures/demo-t1-2026.json` reproduit à l'identique les montants, dates, nombre de lignes et
 * relations fournisseur de la référence de non-régression T1 2026 (36 factures · 16 en retard ·
 * 350 964,42 DH · amende 7 025,33 DH) ; seuls les noms, IF et ICE sont fictifs.
 */
const XLSX = require('xlsx');
const DATA = require('./fixtures/demo-t1-2026.json');

const DEMO_CLIENT = {
  raison_sociale: 'STE ORYX AUTO SARL',
  ice: '009990000000017', if_fiscal: '99000017', rc: '9901', forme_juridique: 'SARL',
  secteur: 'Négoce & distribution automobile', ville: 'Casablanca', adresse: '15 BD DES CEDRES, Casablanca',
  ca_ht: 60457607.22, exercice_ref: 2026, email: 'contact@oryx-auto.demo',
};

const DEMO_PERSONA = { nom: 'Leïla Amrani', email: 'admin@hlz.demo', initiales: 'LA', titre: 'Commissaire aux comptes' };

// Conventions de démonstration (120 j), rattachées par ICE fictif.
const DEMO_CONVENTIONS = [
  { ice: '009980000000011', nom: 'KORAL ENGINS SA' },
  { ice: '009980000000001', nom: 'ALPHA PIECES AUTO' },
  { ice: '009980000000002', nom: 'BETA EXPRESS SARL' },
  { ice: '009980000000005', nom: 'ETOILE CARROSSERIE' },
];

const DEMO_SOURCE_NAME = 'demo-oryx-t1-2026.xlsx';

// Date ISO → numéro de série Excel (cellule numérique au format date, comme un classeur Excel ordinaire).
function serial(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000;
}

/** Classeur .xlsx (Buffer) construit à partir du jeu fictif. */
function demoWorkbookBuffer() {
  const ws = {};
  DATA.rows.forEach((row, r) => row.forEach((v, c) => {
    if (v == null) return;
    const ref = XLSX.utils.encode_cell({ r, c });
    if (typeof v === 'object' && v.d) ws[ref] = { t: 'n', v: serial(v.d), z: 'm/d/yy' };
    else ws[ref] = typeof v === 'number' ? { t: 'n', v } : { t: 's', v: String(v) };
  }));
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: DATA.rows.length - 1, c: DATA.rows[0].length - 1 } });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, DATA.sheet);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { DEMO_CLIENT, DEMO_PERSONA, DEMO_CONVENTIONS, DEMO_SOURCE_NAME, demoWorkbookBuffer };
