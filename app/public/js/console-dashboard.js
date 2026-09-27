'use strict';
/* Console — tableau de bord de la plateforme. */
(window.DPC_EXT = window.DPC_EXT || []).push(function (C) {
const { $, $$, esc, IC } = C;
const dur = s => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h >= 48 ? `${Math.floor(h / 24)} j ${h % 24} h` : h ? `${h} h ${m} min` : `${m} min`; };
C.views.dash = async (el) => {
  const [d, act] = await Promise.all([C.api('GET', '/dashboard'), C.api('GET', '/support/active')]);
  const badge = $('#sigBadge'); badge.textContent = d.signaux; badge.classList.toggle('hidden', !d.signaux);
  const kpi = (lbl, val, sub = '', tone = '', go = '') => `<div class="kpi ${tone} ${go ? 'clk' : ''}" ${go ? `data-go="${go}" role="button" tabindex="0"` : ''}><div class="lbl">${esc(lbl)}</div><div class="val">${val}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  const a = d.abonnements, s = d.systeme;
  el.innerHTML = C.pageHead('Tableau de bord', `Plateforme DelaiPay — ${C.int(d.espaces.total)} espace(s). Aucun chiffre comptable des clients n’est affiché ici.`,
    `<button class="btn btn-primary" data-go="workspace-new">${IC.plus}Nouvel espace</button>`)
    + `<div class="kpi-grid">
      ${kpi('Espaces actifs', C.int(d.espaces.actif), '', '', 'workspaces')}
      ${kpi('Suspendus', C.int(d.espaces.suspendu), '', d.espaces.suspendu ? 'warn' : '', 'workspaces')}
      ${kpi('Expirés', C.int(d.espaces.expire), 'abonnement échu', d.espaces.expire ? 'late' : '', 'workspaces')}
      ${kpi('Échéances ≤ 30 jours', C.int(a.expirent30j), a.prochainsRenouvellements ? C.money(a.prochainsRenouvellements) : '', a.expirent30j ? 'warn' : '')}
      ${kpi('Revenu du mois', C.money(a.revenuMois.encaisse), `facturé ${C.money(a.revenuMois.facture)} · ${a.revenuMois.nb} abonnement(s)`)}
      ${kpi('Utilisateurs actifs', C.int(d.utilisateurs))}
      ${kpi('Connexions · 24 h', C.int(d.connexions24h), '', '', 'activity')}
      ${kpi('Échecs et blocages · 24 h', `${C.int(d.echecs24h)} <small>/ ${C.int(d.bloquees24h)} bloquée(s)</small>`, '', d.echecs24h || d.bloquees24h ? 'late' : '', 'activity')}
      ${kpi('Appareils en attente', C.int(d.appareilsEnAttente), 'à approuver', d.appareilsEnAttente ? 'warn' : '', 'sessions/devices/en_attente')}
      ${kpi('Accès d’assistance actifs', C.int(d.accesSupportActifs), '', d.accesSupportActifs ? 'warn' : '')}
    </div>
    <div class="cons-grid">
      <div class="card"><div class="card-h"><h3>Renouvellements dans les 30 jours</h3></div><div class="card-b" style="padding:0">${C.table(['Espace', 'Échéance', { label: 'Montant', num: true }, 'Paiement'],
        a.renouvellements.map(r => `<tr><td class="first"><a class="rowlink" href="#/workspace/${esc(r.id)}/abonnement">${esc(r.nom)}</a> <span class="muted mono t-xs">${esc(r.slug)}</span></td><td class="mono" data-l="Échéance">${C.fd(r.date_fin)}</td><td class="num" data-l="Montant">${C.money(r.montant)}</td><td data-l="Paiement">${esc({ paye: 'Payé', en_attente: 'En attente', en_retard: 'En retard' }[r.statut_paiement] || '—')}</td></tr>`),
        { empty: 'Aucune échéance dans les 30 jours.' })}
        ${a.echus.length ? `<div class="ops-foot"><span>${a.echus.length} abonnement(s) échu(s) : ${a.echus.map(e => `<a href="#/workspace/${esc(e.id)}/abonnement">${esc(e.slug)}</a> (${esc(e.etat === 'lecture_seule' ? 'lecture seule' : 'grâce')})`).join(', ')}</span></div>` : ''}</div>
      <div class="card"><div class="card-h"><h3>Actions rapides</h3></div><div class="card-b" style="display:grid;gap:8px">
        <button class="btn btn-ghost" data-go="workspace-new" style="justify-content:flex-start">${IC.plus}Créer un espace de travail</button>
        <button class="btn btn-ghost" data-go="sessions/devices/en_attente" style="justify-content:flex-start">${IC.lock}Approuver les appareils en attente (${C.int(d.appareilsEnAttente)})</button>
        <button class="btn btn-ghost" data-go="activity" style="justify-content:flex-start">${IC.warn}Examiner les signaux de connexion (${C.int(d.signaux)})</button>
        <button class="btn btn-ghost" data-go="settings" style="justify-content:flex-start">${IC.info}Bandeau de maintenance global</button>
        <button class="btn btn-ghost" data-go="audit" style="justify-content:flex-start">${IC.info}Journal plateforme</button>
      </div></div>
      <div class="card"><div class="card-h"><h3>Accès d’assistance en cours</h3></div><div class="card-b" style="padding:0">${C.table(['Espace', 'Par', 'Motif', 'Fin'],
        act.rows.map(r => `<tr><td class="first"><a class="rowlink" href="#/workspace/${esc(r.espace.id)}/assistance">${esc(r.espace.slug)}</a></td><td data-l="Par">${esc(r.admin)}</td><td class="wrap" data-l="Motif">${esc(r.motif)}</td><td class="mono" data-l="Fin">${C.fdt(r.fin)}</td></tr>`),
        { empty: 'Aucun accès d’assistance en cours.' })}</div></div>
      <div class="card"><div class="card-h"><h3>Système</h3></div><div class="card-b"><dl class="dl-ops">
        <dt>Version</dt><dd class="mono">${esc(s.version || '—')}${s.commit ? ` · commit ${esc(s.commit)}` : ''}</dd>
        <dt>Démarré</dt><dd>${C.fdt(s.startedAt)} · depuis ${dur(s.uptimeSec)}</dd>
        <dt>Base de données</dt><dd>${C.bytes(s.base.taille)} <span class="muted mono t-xs">${esc(s.base.fichier)}</span></dd>
        <dt>Erreurs depuis le démarrage</dt><dd>${s.errors ? `<b class="c-late">${C.int(s.errors)}</b>` : '0'}</dd>
        <dt>Dernière sauvegarde</dt><dd>${s.sauvegarde.le ? `${C.fdt(s.sauvegarde.le)} <span class="muted mono t-xs">${esc(s.sauvegarde.fichier)}</span>` : `<span class="pill pill-sm pill-warn">${esc(s.sauvegarde.message)}</span>`}</dd>
        <dt>Géolocalisation</dt><dd>${s.geoip ? 'Base GeoIP locale' : '— (aucune base locale)'}</dd>
        <dt>Proxy de confiance</dt><dd class="mono">${esc(s.proxyDeConfiance || 'aucun (X-Forwarded-For ignoré)')}</dd>
        <dt>Node.js</dt><dd class="mono">${esc(s.node)}</dd></dl></div></div>
    </div>`;
  $$('[data-go]', el).forEach(b => { const go = () => { location.hash = '#/' + b.dataset.go; }; b.addEventListener('click', go); b.addEventListener('keydown', e => { if (e.key === 'Enter') go(); }); });
};
});
