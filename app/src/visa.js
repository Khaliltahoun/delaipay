'use strict';
/**
 * Génération du visa (commissaire aux comptes / expert-comptable) au format officiel
 * du modèle de visa officiel fourni par le cabinet pilote — exportable en Word (.docx) et PDF.
 * Un modèle de "blocs" partagé garantit que le Word, le PDF et l'aperçu écran sont identiques.
 */
const { Document, Packer, Paragraph, TextRun, AlignmentType } = require('docx');
const PDFDocument = require('pdfkit');
const { fmtMoney } = require('./util');

/* Conclusions du modèle officiel — liste FERMÉE (modification autorisée par le fondateur, 2026-09-27 : voir DECISIONS.md).
 * Une conclusion vide ou non reconnue est REFUSÉE : jamais de formulation « pas d'observations » par défaut. */
const CONCLUSIONS = ['Sans observation', 'Avec observation', 'Avec réserve', 'Refus de visa'];
// « Avec observation » et « Avec réserve » : le texte renvoie aux observations / réserves « mentionnées ci-dessus »
// → au moins UNE est exigée et elles sont imprimées juste avant la conclusion (VISA-2).
const NEEDS_OBS = { 'Avec observation': { titre: 'Observations :', mot: 'observation' }, 'Avec réserve': { titre: 'Réserves :', mot: 'réserve' } };
const OBS_MAX = 20, OBS_LEN = 1000;
/** Normalise la liste (tableau ou texte, une par ligne) ; lève une erreur si requise et vide. */
function normalizeObservations(conclusion, observations) {
  const list = (Array.isArray(observations) ? observations : String(observations || '').split(/\r?\n/))
    .map(o => String(o == null ? '' : o).replace(/^\s*(?:[-•*]|\d+[.)])\s*/, '').trim()).filter(Boolean);
  const need = NEEDS_OBS[conclusion];
  if (!need) return [];
  if (!list.length) throw new VisaError(`La conclusion « ${conclusion} » exige au moins une ${need.mot} : le texte du visa renvoie aux ${need.mot}s « mentionnées ci-dessus ».`, 'observations_requises');
  if (list.length > OBS_MAX) throw new VisaError(`${OBS_MAX} ${need.mot}s au maximum.`, 'observations_trop_nombreuses');
  const long = list.find(o => o.length > OBS_LEN);
  if (long) throw new VisaError(`Chaque ${need.mot} est limitée à ${OBS_LEN} caractères.`, 'observation_trop_longue');
  return list;
}
/**
 * P3-11 : ville de signature = ville de l'adresse de l'ESPACE (cabinet), jamais une ville codée en dur.
 * « 12 bd Zerktouni, 20000 Casablanca » → « Casablanca » ; dernier segment (virgule / retour à la ligne), sans code
 * postal ni pays. Adresse absente ou illisible → null (la lettre porte alors « Le jj/mm/aaaa », l'écran le signale).
 */
function cityFromAddress(adresse) {
  const parts = String(adresse || '').split(/[,\n;]/).map(x => x.replace(/\b\d{4,6}\b/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean)
    .filter(x => !/^(maroc|morocco|royaume du maroc)$/i.test(x));
  let last = parts[parts.length - 1];
  // Adresse sur une seule ligne sans virgule (« Avenue Mohammed V 40000 Marrakech ») : dernier mot.
  if (parts.length === 1 && last && last.split(' ').length > 2) last = last.split(' ').pop();
  if (!last || !/\p{L}/u.test(last) || last.length > 60) return null;
  return last;
}
class VisaError extends Error { constructor(msg, code) { super(msg); this.status = 400; this.code = code; } }

function frDate(d) { return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`; }
function periodeDates(annee, trimestre) {
  const s = new Date(annee, (trimestre - 1) * 3, 1);
  const e = new Date(annee, trimestre * 3, 0);
  return { debut: frDate(s), fin: frDate(e) };
}

/** Construit les blocs du visa à partir des données de la déclaration. */
function buildData({ e, annee, trimestre, montant, conclusion, signataire, type, observations, adresseCabinet }) {
  if (!CONCLUSIONS.includes(conclusion))
    throw new VisaError(`Conclusion du visa ${conclusion ? `« ${conclusion} » non reconnue` : 'manquante'} : choisissez « Sans observation », « Avec observation », « Avec réserve » ou « Refus de visa ».`, 'conclusion_invalide');
  const obs = normalizeObservations(conclusion, observations);
  const rs = e.raison_sociale;
  const siege = e.adresse || e.ville || '—';
  const { debut, fin } = periodeDates(annee, trimestre);
  const m = fmtMoney(montant);
  const isCAC = type === 'CAC';
  const roleTitle = isCAC ? 'du commissaire aux comptes' : "de l'expert-comptable";
  const role = isCAC ? 'commissaire aux comptes' : 'expert-comptable';
  const today = frDate(new Date());
  const lieu = cityFromAddress(adresseCabinet);
  const art = "l'article 2.78 de la loi 69-21";

  const spacer = { runs: [{ t: '' }] };
  const periodeSuffix = [{ t: ' de la société ' }, { t: rs, b: true }, { t: ' au titre de la période du ' }, { t: `${debut} au ${fin}`, b: true }, { t: '.' }];

  const blocks = [
    { align: 'left', runs: [{ t: "À l'attention de Monsieur le gérant", b: true }] },
    { align: 'left', runs: [{ t: `De la société ${rs}`, b: true }] },
    { align: 'left', runs: [{ t: `Siège social : ${siege}`, b: true }] },
    spacer,
    { align: 'justify', runs: [{ t: `Visa ${roleTitle} relatif à la concordance des informations figurant dans l'état joint à la déclaration des délais de paiement, prévu par la loi 69-21 relative aux délais de paiement modifiant les dispositions de la loi 15-95 relative au code de commerce.`, b: true }] },
    { align: 'left', runs: [{ t: `Période du ${debut} au ${fin}`, b: true, u: true }] },
    { align: 'justify', runs: [
      { t: `En notre qualité de ${role} de la société ` }, { t: rs, b: true },
      { t: ` et en application des dispositions de la loi 69-21 relative aux délais de paiement, nous avons vérifié la concordance des informations, figurant dans l'état joint à la déclaration des délais de paiement, avec les justificatifs des informations figurant sur les factures non payées dans les délais prévus à ${art} de la société ` },
      { t: rs, b: true }, { t: ` au titre de la période du ` }, { t: `${debut} au ${fin}`, b: true },
      { t: `. Ledit état, ci-joint, fait ressortir un montant de ` }, { t: `${m} Dhs`, b: true },
      { t: ` de factures non payées totalement ou partiellement dans lesdits délais.` },
    ] },
    { align: 'justify', runs: [
      { t: `Ces informations ont été établies sous la responsabilité de la direction de la société ` }, { t: rs, b: true },
      { t: ` qui doit s'assurer de leur exhaustivité et de leur sincérité. Il nous appartient de vérifier la concordance de ces informations avec les justificatifs des informations figurant sur les factures non payées dans les délais prévus à ${art}.` },
    ] },
    { align: 'justify', runs: [{ t: `Notre intervention qui porte sur le contrôle de concordance, par sondages, d'informations documentaires et de gestion, ne constitue ni un audit, ni un examen limité. Elle a été effectuée selon la Directive de l'Ordre des Experts Comptables, approuvée le 06 octobre 2024.` }] },
    { align: 'justify', runs: [{ t: `Nos travaux ne sont pas destinés à remplacer les diligences qu'il appartient à l'Administration, ayant eu communication de ce visa, de mettre en œuvre au regard de ses propres besoins en application de la loi 69-21.` }] },
    // Observations / réserves auxquelles renvoie la conclusion (« mentionnées ci-dessus »).
    ...(obs.length ? [{ align: 'left', runs: [{ t: NEEDS_OBS[conclusion].titre, b: true, u: true }] },
      ...obs.map((o, i) => ({ align: 'justify', runs: [{ t: `${i + 1}. `, b: true }, { t: o }] }))] : []),
    { align: 'left', runs: [{ t: 'Conclusion :', b: true, u: true }] },
    conclusionBlock(conclusion, periodeSuffix),
    { align: 'justify', runs: [{ t: `Notre visa n'a pour seul objectif que celui indiqué dans le premier paragraphe ci-dessus et est réservé à votre propre usage dans le cadre de la loi 69-21. Il ne peut être utilisé à d'autres fins, ni être communiqué à d'autres parties.` }] },
    spacer,
    { align: 'right', runs: [{ t: lieu ? `${lieu} le ${today}` : `Le ${today}`, b: true }] },
    { align: 'right', runs: [{ t: signataire, b: true }] },
    { align: 'right', runs: [{ t: "Membre de l'Ordre des", b: true }] },
    { align: 'right', runs: [{ t: 'Experts Comptables', b: true }] },
  ];

  return { type, typeLabel: isCAC ? 'Commissaire aux comptes (CAC)' : 'Expert-comptable / comptable agréé',
    role, conclusion, signataire, observations: obs, lieu, date: today, debut, fin, montant, blocks };
}

function conclusionBlock(conclusion, suffix) {
  const LEADS = {
    'Avec réserve': "Sur la base de nos travaux, et en raison des réserves mentionnées ci-dessus, nous exprimons une conclusion avec réserve sur la concordance des informations figurant dans l'état joint à la déclaration des délais de paiement, avec les justificatifs des informations figurant sur les factures non payées dans les délais prévus à l'article 2.78 de la loi 69-21",
    'Refus de visa': "Sur la base de nos travaux, nous ne sommes pas en mesure de nous prononcer sur la concordance des informations figurant dans l'état joint à la déclaration des délais de paiement, avec les justificatifs des informations figurant sur les factures non payées dans les délais prévus à l'article 2.78 de la loi 69-21",
    'Avec observation': "Sur la base de nos travaux, et sous réserve des observations mentionnées ci-dessus, nous n'avons pas d'autres observations sur la concordance des informations figurant dans l'état joint à la déclaration des délais de paiement, avec les justificatifs des informations figurant sur les factures non payées dans les délais prévus à l'article 2.78 de la loi 69-21",
    'Sans observation': "Sur la base de nos travaux, nous n'avons pas d'observations sur la concordance des informations figurant dans l'état joint à la déclaration des délais de paiement, avec les justificatifs des informations figurant sur les factures non payées dans les délais prévus à l'article 2.78 de la loi 69-21",
  };
  const lead = LEADS[conclusion];
  if (!lead) throw new VisaError('Conclusion du visa non reconnue.', 'conclusion_invalide');
  return { align: 'justify', runs: [{ t: lead }, ...suffix] };
}

const AL = { left: AlignmentType.LEFT, justify: AlignmentType.JUSTIFIED, right: AlignmentType.RIGHT, center: AlignmentType.CENTER };

/** Word (.docx) — Buffer */
function toDocx(blocks) {
  const paras = blocks.map(b => new Paragraph({
    alignment: AL[b.align || 'justify'],
    spacing: { after: 100, line: 240 },
    children: (b.runs || []).map(r => new TextRun({
      text: r.t || '', bold: !!r.b, underline: r.u ? { type: 'single' } : undefined,
      font: 'Times New Roman', size: 22,
    })),
  }));
  const doc = new Document({
    creator: 'DelaiPay', title: 'Visa loi 69-21',
    sections: [{ properties: { page: { margin: { top: 850, bottom: 700, left: 950, right: 950 } } }, children: paras }],
  });
  return Packer.toBuffer(doc);
}

/** PDF — écrit dans un flux (res) */
function toPdf(blocks, stream) {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 48, bottom: 40, left: 62, right: 62 } });
  doc.pipe(stream);
  for (const b of blocks) {
    const runs = (b.runs || []).filter(r => r.t != null).map(r => ({ ...r }));
    if (!runs.length || (runs.length === 1 && runs[0].t === '')) { doc.moveDown(0.45); continue; }
    // PDFKit rogne l'espace initial des segments "continued" : on déplace l'espace vers la fin du segment précédent.
    for (let i = 1; i < runs.length; i++) {
      if (/^\s/.test(runs[i].t)) { runs[i].t = runs[i].t.replace(/^\s+/, ''); runs[i - 1].t = runs[i - 1].t.replace(/\s+$/, '') + ' '; }
    }
    const align = b.align === 'right' ? 'right' : (b.align === 'left' ? 'left' : 'justify');
    runs.forEach((r, i) => {
      doc.font(r.b ? 'Times-Bold' : 'Times-Roman').fontSize(10.5);
      doc.text(r.t, { continued: i < runs.length - 1, align, underline: !!r.u, lineGap: 1.5 });
    });
    doc.moveDown(0.32);
  }
  doc.end();
  return doc;
}

module.exports = { cityFromAddress, buildData, toDocx, toPdf, periodeDates, CONCLUSIONS, VisaError, NEEDS_OBS, normalizeObservations };
