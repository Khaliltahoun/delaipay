'use strict';
/**
 * Génération du visa (commissaire aux comptes / expert-comptable) au format officiel
 * reçu de Mme Zahra (docs/visa - CADOZAT.docx) — exportable en Word (.docx) et PDF.
 * Un modèle de "blocs" partagé garantit que le Word, le PDF et l'aperçu écran sont identiques.
 */
const { Document, Packer, Paragraph, TextRun, AlignmentType } = require('docx');
const PDFDocument = require('pdfkit');
const { fmtMoney } = require('./util');

function frDate(d) { return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`; }
function periodeDates(annee, trimestre) {
  const s = new Date(annee, (trimestre - 1) * 3, 1);
  const e = new Date(annee, trimestre * 3, 0);
  return { debut: frDate(s), fin: frDate(e) };
}

/** Construit les blocs du visa à partir des données de la déclaration. */
function buildData({ e, annee, trimestre, montant, conclusion, signataire, type }) {
  const rs = e.raison_sociale;
  const siege = e.adresse || e.ville || '—';
  const { debut, fin } = periodeDates(annee, trimestre);
  const m = fmtMoney(montant);
  const isCAC = type === 'CAC';
  const roleTitle = isCAC ? 'du commissaire aux comptes' : "de l'expert-comptable";
  const role = isCAC ? 'commissaire aux comptes' : 'expert-comptable';
  const today = frDate(new Date());
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
    { align: 'left', runs: [{ t: 'Conclusion :', b: true, u: true }] },
    conclusionBlock(conclusion, periodeSuffix),
    { align: 'justify', runs: [{ t: `Notre visa n'a pour seul objectif que celui indiqué dans le premier paragraphe ci-dessus et est réservé à votre propre usage dans le cadre de la loi 69-21. Il ne peut être utilisé à d'autres fins, ni être communiqué à d'autres parties.` }] },
    spacer,
    { align: 'right', runs: [{ t: `Marrakech le ${today}`, b: true }] },
    { align: 'right', runs: [{ t: signataire, b: true }] },
    { align: 'right', runs: [{ t: "Membre de l'Ordre des", b: true }] },
    { align: 'right', runs: [{ t: 'Experts Comptables', b: true }] },
  ];

  return { type, typeLabel: isCAC ? 'Commissaire aux comptes (CAC)' : 'Expert-comptable / comptable agréé',
    role, conclusion, signataire, lieu: 'Marrakech', date: today, debut, fin, montant, blocks };
}

function conclusionBlock(conclusion, suffix) {
  const c = (conclusion || '').toLowerCase();
  let lead;
  if (c.includes('réserve')) lead = "Sur la base de nos travaux, et en raison des réserves mentionnées ci-dessus, nous exprimons une conclusion avec réserve sur la concordance des informations figurant dans l'état joint à la déclaration des délais de paiement, avec les justificatifs des informations figurant sur les factures non payées dans les délais prévus à l'article 2.78 de la loi 69-21";
  else if (c.includes('refus')) lead = "Sur la base de nos travaux, nous ne sommes pas en mesure de nous prononcer sur la concordance des informations figurant dans l'état joint à la déclaration des délais de paiement, avec les justificatifs des informations figurant sur les factures non payées dans les délais prévus à l'article 2.78 de la loi 69-21";
  else if (c.includes('observation') && !c.includes('sans')) lead = "Sur la base de nos travaux, et sous réserve des observations mentionnées ci-dessus, nous n'avons pas d'autres observations sur la concordance des informations figurant dans l'état joint à la déclaration des délais de paiement, avec les justificatifs des informations figurant sur les factures non payées dans les délais prévus à l'article 2.78 de la loi 69-21";
  else lead = "Sur la base de nos travaux, nous n'avons pas d'observations sur la concordance des informations figurant dans l'état joint à la déclaration des délais de paiement, avec les justificatifs des informations figurant sur les factures non payées dans les délais prévus à l'article 2.78 de la loi 69-21";
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

module.exports = { buildData, toDocx, toPdf, periodeDates };
