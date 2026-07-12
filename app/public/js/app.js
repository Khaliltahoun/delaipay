'use strict';
/* ============================== état & utilitaires ============================== */
const state = { me: null, cabinet: null, clients: [], clientId: null, period: null, view: 'dash' };
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function money(n, dec = 2) {
  if (n == null || isNaN(n)) return '—';
  const neg = n < 0; n = Math.abs(+n);
  let [i, f] = n.toFixed(dec).split('.');
  i = i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return (neg ? '-' : '') + i + (dec ? ',' + f : '');
}
function dateFr(iso) { if (!iso) return '—'; const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : iso; }
function pct(x) { return x == null ? '—' : (x * 100).toFixed(2).replace('.', ',') + ' %'; }

async function api(path, opts = {}) {
  const o = { credentials: 'same-origin', headers: {}, ...opts };
  if (o.body && !(o.body instanceof FormData)) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(o.body); }
  const res = await fetch('/api' + path, o);
  if (res.status === 401) { window.location.href = '/login'; throw new Error('401'); }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || 'Erreur serveur');
  return data;
}
function toast(msg, type = 'ok', title = '') {
  const t = document.createElement('div'); t.className = 'toast ' + type;
  t.innerHTML = (title ? `<b>${esc(title)}</b>` : '') + esc(msg);
  $('#toasts').appendChild(t); setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 4200);
}
const RISK = { ok: ['pill-ok', 'Normal'], app: ['pill-app', 'Approche'], orange: ['pill-orange', 'Attention'], red: ['pill-red', 'Retard'], dred: ['pill-dred', 'Pénalités'] };
function riskPill(r) { const [c, l] = RISK[r] || RISK.ok; return `<span class="pill ${c}"><span class="dot"></span>${l}</span>`; }

/* ============================== overlay (drawer/modal) ============================== */
function closeOverlay() { $('#overlay').innerHTML = ''; }
function drawer(html) {
  $('#overlay').innerHTML = `<div class="scrim" onclick="closeOverlay()"></div><aside class="drawer">${html}</aside>`;
}
function modal(html) {
  $('#overlay').innerHTML = `<div class="scrim" onclick="closeOverlay()"></div><div class="modal">${html}</div>`;
}
window.closeOverlay = closeOverlay;
const XICO = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>`;

/* ============================== bootstrap ============================== */
async function boot() {
  try {
    const me = await api('/me');
    state.me = me.user; state.cabinet = me.cabinet;
  } catch { return; }
  // header/user
  $('#cabName').textContent = state.cabinet.nom;
  $('#sideName').textContent = state.me.nom; $('#sideTitle').textContent = state.me.titre || state.me.role;
  $('#sideAv').textContent = state.me.initiales; $('#topAv').textContent = state.me.initiales;
  // theme
  const th = localStorage.getItem('dp-theme') || 'light';
  $('#app').setAttribute('data-theme', th);
  $('#themeBtn').onclick = () => { const n = $('#app').getAttribute('data-theme') === 'dark' ? 'light' : 'dark'; $('#app').setAttribute('data-theme', n); localStorage.setItem('dp-theme', n); };
  $('#logoutBtn').onclick = async () => { await api('/auth/logout', { method: 'POST' }); window.location.href = '/login'; };
  // nav
  $$('[data-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  // clients
  state.clients = await api('/clients');
  state.clientId = localStorage.getItem('dp-client') || (state.clients[0] && state.clients[0].id) || null;
  if (state.clients.length && !state.clients.find(c => c.id === state.clientId)) state.clientId = state.clients[0].id;
  wireSwitcher(); wireGlobalSearch(); updateSwitcherLabel();
  refreshAlertsBadge();
  setView(location.hash.replace('#', '') || 'dash', { replace: true });
}

const VIEWS = {
  dash: { crumb: 'Tableau de bord', fn: renderDash },
  clients: { crumb: 'Portefeuille clients', fn: renderClients },
  client: { crumb: 'Fiche client', fn: renderClientOverview },
  import: { crumb: 'Import de fichiers', fn: renderImport },
  delais: { crumb: 'Feuille de calcul des délais', fn: renderDelais },
  conv: { crumb: 'Conventions & OCR', fn: renderConv },
  decl: { crumb: 'Déclaration DGI', fn: renderDecl },
  visa: { crumb: 'Générateur de visa', fn: renderVisa },
  alerts: { crumb: "Centre d'alertes", fn: renderAlerts },
  retards: { crumb: 'Factures en retard', fn: renderRetards },
  convmiss: { crumb: 'Conventions manquantes', fn: renderConvMiss },
  cabconv: { crumb: 'Conventions du portefeuille', fn: renderCabConv },
  anomalies: { crumb: 'Anomalies', fn: renderAnomalies },
  taux: { crumb: 'Taux & paramètres', fn: renderTaux },
  audit: { crumb: "Journal d'audit", fn: renderAudit },
};
async function renderView(name) {
  if (!VIEWS[name]) name = 'dash';
  state.view = name;
  $$('.nav-item[data-view]').forEach(b => b.setAttribute('aria-current', b.dataset.view === name ? 'page' : 'false'));
  const c = currentClient();
  $('#crumbView').textContent = (SCOPED.includes(name) && c) ? `${c.name} · ${VIEWS[name].crumb}` : VIEWS[name].crumb;
  updateSwitcherLabel();
  $('#view').innerHTML = `<div class="empty"><div class="spin" style="border-color:rgba(14,77,100,.25);border-top-color:var(--primary)"></div></div>`;
  try { await VIEWS[name].fn(); $$('#view .kpi[data-goto]').forEach(el => el.onclick = () => setView(el.dataset.goto)); } catch (e) { $('#view').innerHTML = `<div class="empty"><h4>Erreur</h4><p>${esc(e.message)}</p></div>`; }
}
// Navigation utilisateur : empile une entrée d'historique (back/forward fonctionnent dans l'app)
function setView(name, opts = {}) {
  if (!VIEWS[name]) name = 'dash';
  const url = location.pathname + '#' + name;
  if (opts.replace || (history.state && history.state.view === name)) history.replaceState({ view: name }, '', url);
  else history.pushState({ view: name }, '', url);
  renderView(name);
}
window.setView = setView;
window.addEventListener('popstate', (e) => {
  const name = (e.state && e.state.view) || location.hash.replace('#', '') || 'dash';
  renderView(name);
});

/* ============================== barre client + période ============================== */
function currentClient() { return state.clients.find(c => c.id === state.clientId) || null; }
const SCOPED = ['delais', 'conv', 'decl', 'visa', 'import', 'client'];

// Barre de période (le client est piloté globalement par le switcher du bandeau)
function clientPeriodBar(periods, showPeriod = true) {
  if (!showPeriod || !periods || !periods.length) return '';
  const perOpts = periods.map(p => `<option value="${p.annee}-${p.trimestre}" ${state.period && state.period.annee === p.annee && state.period.trimestre === p.trimestre ? 'selected' : ''}>Trimestre ${p.trimestre} ${p.annee}</option>`).join('');
  return `<div class="filters" style="margin-bottom:18px"><div class="selctb" style="padding:0 6px 0 12px">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="width:15px;height:15px;color:var(--muted)"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/></svg>
    <select id="perSel" class="input-fld" style="border:0;background:transparent;font-weight:600">${perOpts}</select></div></div>`;
}
function wireClientBar(reRender) {
  const ps = $('#perSel'); if (ps) ps.onchange = () => { const [a, t] = ps.value.split('-'); state.period = { annee: +a, trimestre: +t }; reRender(); };
}

/* ---------- switcher client global (bandeau) ---------- */
function updateSwitcherLabel() { const c = currentClient(); const el = $('#cswName'); if (el) el.textContent = c ? c.name : 'Sélectionner un client'; }
function riskVar(c) { return c.retards === 0 ? 'green' : (c.amende >= 5000 ? 'dred' : 'red'); }
function buildSwitcherList(filter = '') {
  const el = $('#cswList'); if (!el) return;
  const f = filter.trim().toLowerCase();
  if (!state.clients.length) { el.innerHTML = `<div class="csw-empty">Aucun client. Créez-en un dans le portefeuille.</div>`; return; }
  const list = state.clients.filter(c => !f || (c.name || '').toLowerCase().includes(f) || (c.ice || '').includes(f) || (c.if || '').includes(f));
  el.innerHTML = (list.length ? list.map(c => `<button class="csw-item ${c.id === state.clientId ? 'active' : ''}" data-id="${c.id}">
      <span class="dot" style="background:var(--r-${riskVar(c)})"></span>
      <span class="ci-main"><b>${esc(c.name)}</b><small>${esc(c.ice || c.if || '')}${c.retards ? ' · ' + c.retards + ' en retard' : ''}</small></span></button>`).join('')
      : `<div class="csw-empty">Aucun client ne correspond.</div>`)
    + `<div class="csw-all"><button class="csw-item" data-goto="clients"><span class="ci-main"><b>Voir tout le portefeuille →</b></span></button></div>`;
  $$('#cswList .csw-item[data-id]').forEach(b => b.onclick = () => setClient(b.dataset.id));
  const all = $('#cswList .csw-item[data-goto]'); if (all) all.onclick = () => { closeSwitcher(); setView('clients'); };
}
function openSwitcher() { $('#cswPanel').classList.remove('hidden'); $('#clientSwBtn').setAttribute('aria-expanded', 'true'); buildSwitcherList(''); const s = $('#cswSearch'); if (s) { s.value = ''; setTimeout(() => s.focus(), 30); } }
function closeSwitcher() { const p = $('#cswPanel'); if (p) p.classList.add('hidden'); const b = $('#clientSwBtn'); if (b) b.setAttribute('aria-expanded', 'false'); }
function wireSwitcher() {
  $('#clientSwBtn').onclick = e => { e.stopPropagation(); $('#cswPanel').classList.contains('hidden') ? openSwitcher() : closeSwitcher(); };
  $('#cswSearch').oninput = e => buildSwitcherList(e.target.value);
  $('#cswPanel').onclick = e => e.stopPropagation();
  document.addEventListener('click', closeSwitcher);
}
function setClient(id) {
  state.clientId = id; localStorage.setItem('dp-client', id); state.period = null; closeSwitcher(); updateSwitcherLabel();
  if (SCOPED.includes(state.view) && state.view !== 'client') VIEWS[state.view].fn(); else setView('client');
}
/* ---------- recherche globale ---------- */
function wireGlobalSearch() {
  const inp = $('#globalSearch'), box = $('#searchRes'); if (!inp) return;
  const run = () => {
    const f = inp.value.trim().toLowerCase(); if (!f) { box.classList.add('hidden'); return; }
    const res = state.clients.filter(c => (c.name || '').toLowerCase().includes(f) || (c.ice || '').includes(f) || (c.if || '').includes(f)).slice(0, 8);
    box.innerHTML = res.length ? res.map(c => `<div class="sr" data-id="${c.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="width:16px;height:16px;color:var(--muted)"><path d="M3 21h18M5 21V7l7-4 7 4v14"/></svg><b>${esc(c.name)}</b><small>${esc(c.ice || '')}</small></div>`).join('') : `<div class="sr-empty">Aucun client trouvé.</div>`;
    box.classList.remove('hidden');
    $$('#searchRes .sr[data-id]').forEach(d => d.onclick = () => { inp.value = ''; box.classList.add('hidden'); setClient(d.dataset.id); });
  };
  inp.oninput = run;
  inp.onfocus = () => { if (inp.value.trim()) run(); };
  inp.onblur = () => setTimeout(() => box.classList.add('hidden'), 180);
}
async function ensurePeriod() {
  if (!state.clientId) return null;
  const data = await api(`/clients/${state.clientId}/periods`);
  if (!state.period) state.period = data.latest;
  return data.periods;
}
function perQuery() { return state.period ? `?annee=${state.period.annee}&trimestre=${state.period.trimestre}` : ''; }

/* ============================== DASHBOARD ============================== */
async function renderDash() {
  const d = await api('/dashboard');
  const k = d.kpis;
  const evo = d.evolution || [];
  const max = Math.max(1, ...evo.map(e => e.v));
  const pts = evo.map((e, i) => ({ x: 46 + (664 * (evo.length <= 1 ? 0.5 : i / (evo.length - 1))), y: 200 - (150 * e.v / max), m: e.ym.slice(5) }));
  const line = pts.map(p => `${p.x.toFixed(0)},${p.y.toFixed(0)}`).join(' ');
  const area = pts.length ? `M46,200 ${pts.map(p => `L${p.x.toFixed(0)},${p.y.toFixed(0)}`).join(' ')} L710,200 Z` : '';
  const heatColor = (a) => a <= 0 ? 'var(--r-green)' : a < 200 ? 'var(--r-yellow)' : a < 1000 ? 'var(--r-orange)' : a < 4000 ? 'var(--r-red)' : 'var(--r-dred)';

  const seg = d.segmentation || { ok: 0, app: 0, orange: 0, red: 0, dred: 0 };
  const segDefs = [['ok', 'Normal', 'green'], ['app', 'Approche', 'yellow'], ['orange', 'Attention', 'orange'], ['red', 'Retard', 'red'], ['dred', 'Pénalités', 'dred']];
  const segTot = Math.max(1, segDefs.reduce((s, [kk]) => s + (seg[kk] || 0), 0));
  const segBar = segDefs.map(([kk, lbl, col]) => (seg[kk] ? `<div title="${lbl} : ${seg[kk]}" style="width:${(seg[kk] / segTot * 100).toFixed(1)}%;background:var(--r-${col})"></div>` : '').replace(/></g, '> <')).join('') || '<div style="width:100%;background:var(--bg2)"></div>';
  const secTitle = t => `<div style="font-size:11.5px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:28px 0 13px;border-left:3px solid var(--accent);padding-left:10px">${t}</div>`;
  const mini = (lbl, val, unit, sub, col, goto) => `<div class="kpi${goto ? ' clk' : ''}"${goto ? ` data-goto="${goto}"` : ''}><div class="lbl">${lbl}</div><div class="val" style="font-size:22px${col ? ';color:' + col : ''}">${val}${unit ? ` <small>${unit}</small>` : ''}</div><div class="sub">${sub}</div></div>`;
  const GO = `<div class="go">Voir le détail <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M5 12h14M13 6l6 6-6 6"/></svg></div>`;

  $('#view').innerHTML = `
  <div class="page-head"><h1>Tableau de bord exécutif</h1><p>Vue consolidée du portefeuille — conformité, exposition et échéances (période <b>T${d.periode.trimestre} ${d.periode.annee}</b>).</p></div>

  ${secTitle('Portefeuille & activité')}
  <div class="kpi-grid">
    <div class="kpi"><div class="lbl">Clients suivis</div><div class="val">${k.clients}</div><div class="sub">${k.assujettis} assujetti(s) &gt; 2 MDH</div></div>
    <div class="kpi"><div class="lbl">Fournisseurs</div><div class="val">${money(k.fournisseurs, 0)}</div><div class="sub">référencés</div></div>
    <div class="kpi"><div class="lbl">Factures du trimestre</div><div class="val">${money(k.facturesTrim, 0)}</div><div class="sub">achats analysés</div></div>
    <div class="kpi ${k.tauxConformite >= 90 ? '' : 'accent'}"><div class="lbl">Taux de conformité</div><div class="val" style="color:${k.tauxConformite >= 90 ? 'var(--r-green)' : (k.tauxConformite >= 70 ? 'var(--r-orange)' : 'var(--r-red)')}">${String(k.tauxConformite).replace('.', ',')} <small>%</small></div><div class="sub">payées dans les délais</div></div>
  </div>

  ${secTitle('Exposition & risque (loi 69-21)')}
  <div class="kpi-grid">
    <div class="kpi clk" data-goto="retards"><div class="lbl">Factures en retard</div><div class="val" style="color:var(--r-orange)">${money(k.enRetard, 0)}</div>${GO}</div>
    <div class="kpi clk accent" data-goto="retards"><div class="lbl">Montant TTC concerné</div><div class="val">${money(k.montantConcerne)} <small>DH</small></div>${GO}</div>
    <div class="kpi clk accent" data-goto="retards"><div class="lbl">Montant à verser au Trésor</div><div class="val" style="color:var(--r-red)">${money(k.montantAVerser)} <small>DH</small></div>${GO}</div>
    <div class="kpi clk" data-goto="convmiss"><div class="lbl">Conventions manquantes</div><div class="val" style="color:${k.conventionsManquantes ? 'var(--r-dred)' : 'var(--r-green)'}">${k.conventionsManquantes}</div>${GO}</div>
  </div>
  <div class="kpi-grid" style="margin-top:-8px">
    ${mini('Délai moyen de paiement', money(k.dso, 0), 'j', 'DSO (facture → paiement)', '', 'retards')}
    ${mini('Retard moyen', money(k.retardMoyen, 0), 'j', 'au-delà de la convention', k.retardMoyen > 30 ? 'var(--r-orange)' : '', 'retards')}
    ${mini('Conventions valides', k.convValides, '', 'en GED', '', 'cabconv')}
    ${mini('Anomalies ouvertes', k.anomalies, '', 'à traiter', k.anomalies ? 'var(--r-red)' : 'var(--r-green)', 'anomalies')}
  </div>

  ${secTitle('Répartition & échéances')}
  <div class="grid-2-3" style="margin-bottom:18px">
    <div class="card"><div class="card-h"><div><h3>Répartition des factures par risque</h3><div class="sub">segmentation T${d.periode.trimestre} ${d.periode.annee}</div></div></div>
      <div class="card-b">
        <div style="display:flex;height:18px;border-radius:9px;overflow:hidden;background:var(--bg2);gap:2px">${segBar}</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-top:16px">
          ${segDefs.map(([kk, lbl, col]) => `<div style="display:flex;align-items:center;gap:9px"><span style="width:11px;height:11px;border-radius:3px;background:var(--r-${col})"></span><div><b style="font-variant-numeric:tabular-nums">${seg[kk] || 0}</b> <span class="dh" style="font-size:12px">${lbl}</span></div></div>`).join('')}
        </div>
      </div>
    </div>
    <div class="card"><div class="card-h"><div><h3>Échéances déclaratives</h3><div class="sub">dépôts DGI à venir</div></div></div>
      <div class="card-b" style="padding-top:6px">${(d.deadlines || []).map(x => `<div class="dl"><div class="cal"><b>${x.day}</b><small>${esc(x.mon)}</small></div><div><b>${esc(x.label)}</b><div class="dh" style="font-size:12px">${esc(x.sub)}</div></div><div class="cd" style="color:${x.days <= 15 ? 'var(--r-red)' : 'var(--muted)'}">${esc(x.cd)}</div></div>`).join('')}</div>
    </div>
  </div>

  ${secTitle('Tendance & classements')}
  <div class="grid-2-3" style="margin-bottom:18px">
    <div class="card"><div class="card-h"><div><h3>Évolution des amendes</h3><div class="sub">par mois de paiement (DH)</div></div></div>
      <div class="card-b chart"><svg viewBox="0 0 720 240" preserveAspectRatio="none" role="img">
        <line class="axis" x1="46" y1="200" x2="710" y2="200"/><line class="gl" x1="46" y1="150" x2="710" y2="150"/><line class="gl" x1="46" y1="100" x2="710" y2="100"/><line class="gl" x1="46" y1="50" x2="710" y2="50"/>
        ${area ? `<path d="${area}" fill="var(--primary)" fill-opacity="0.08"/><polyline points="${line}" fill="none" stroke="var(--primary)" stroke-width="2.5" stroke-linejoin="round"/>` : '<text class="axtx" x="380" y="110" text-anchor="middle">Aucune donnée</text>'}
        ${pts.map(p => `<circle cx="${p.x.toFixed(0)}" cy="${p.y.toFixed(0)}" r="3" fill="var(--card)" stroke="var(--primary)" stroke-width="2"/><text class="axtx" x="${p.x.toFixed(0)}" y="222" text-anchor="middle">${esc(p.m)}</text>`).join('')}
      </svg></div>
    </div>
    <div class="card"><div class="card-h"><div><h3>Top entreprises à risque</h3></div></div>
      <div class="card-b" style="padding-top:6px">${(d.topRisk || []).filter(t => t.amende > 0).map(t => `<div class="list-row"><div style="flex:1;min-width:0"><b style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.name)}</b><small class="dh mono">${money(t.amt)} DH · ${esc(t.city)}</small></div><b class="mono" style="color:var(--r-red)">${money(t.amende)}</b></div>`).join('') || '<div class="empty" style="padding:24px"><p>Aucune entreprise à risque.</p></div>'}</div>
    </div>
  </div>
  <div class="grid-2-3">
    <div class="card"><div class="card-h"><div><h3>Heatmap du risque</h3><div class="sub">entreprises × mois — amende (DH)</div></div></div>
      <div class="card-b">
        <div class="heat"><div class="hr"><div></div>${(d.heatmapMonths || []).map(m => `<div class="hhead">${esc(m)}</div>`).join('')}</div>
        ${(d.heatmap || []).map(h => `<div class="hr"><div class="hlbl">${esc(h.name)}</div>${h.cells.map(c => `<div class="hc" style="background:${heatColor(c.amende)}">${c.amende ? money(c.amende, 0) : ''}</div>`).join('')}</div>`).join('') || '<div class="dh" style="padding:12px">Aucune donnée.</div>'}
        </div>
        <div class="legend"><span><i style="background:var(--r-green)"></i>Normal</span><span><i style="background:var(--r-yellow)"></i>Approche</span><span><i style="background:var(--r-orange)"></i>Attention</span><span><i style="background:var(--r-red)"></i>Retard</span><span><i style="background:var(--r-dred)"></i>Pénalités</span></div>
      </div>
    </div>
    <div class="card"><div class="card-h"><div><h3>Top fournisseurs à risque</h3><div class="sub">amende cumulée</div></div></div>
      <div class="card-b" style="padding-top:6px">${(d.topFournisseurs || []).filter(t => t.amende > 0).map(t => `<div class="list-row"><div style="flex:1;min-width:0"><b style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.name)}</b><small class="dh mono">${t.nb} facture(s) en retard</small></div><b class="mono" style="color:var(--r-red)">${money(t.amende)}</b></div>`).join('') || '<div class="empty" style="padding:24px"><p>Aucun fournisseur à risque.</p></div>'}</div>
    </div>
  </div>`;
}

/* ============================== CLIENTS ============================== */
async function renderClients() {
  state.clients = await api('/clients'); updateSwitcherLabel();
  if (state._cq == null) state._cq = ''; if (!state._crisk) state._crisk = 'all';
  const pill = (r, l) => `<button class="fpill" data-r="${r}" aria-pressed="${state._crisk === r}">${l}</button>`;
  $('#view').innerHTML = `
  <div class="page-head headrow"><div><h1>Portefeuille clients</h1><p id="clCount"></p></div>
    <button class="btn btn-primary" id="newClient"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 5v14M5 12h14"/></svg>Nouveau client</button></div>
  <div class="filters" style="margin-bottom:14px">
    <div class="search" style="max-width:340px;margin:0;flex:0 0 auto;width:340px"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg><input id="clSearch" placeholder="Rechercher (nom, ICE, ville)…" value="${esc(state._cq)}"></div>
    ${pill('all', 'Tous')}${pill('retard', 'Avec retard')}${pill('ok', 'Conformes')}${pill('assuj', 'Assujetties')}</div>
  <div class="table-wrap"><table style="min-width:940px"><thead><tr>
    <th>Raison sociale</th><th>ICE</th><th>Ville</th><th class="num">CA HT</th><th>Assujettie</th><th>Régime</th><th>Expert</th><th class="num">En retard</th><th class="num">Amende</th><th>Risque</th></tr></thead>
    <tbody id="clRows"></tbody></table></div>`;
  const draw = () => {
    const f = (state._cq || '').trim().toLowerCase();
    let rows = state.clients.filter(c => !f || (c.name || '').toLowerCase().includes(f) || (c.ice || '').includes(f) || (c.if || '').includes(f) || (c.ville || '').toLowerCase().includes(f));
    if (state._crisk === 'retard') rows = rows.filter(c => c.retards > 0);
    else if (state._crisk === 'ok') rows = rows.filter(c => c.retards === 0);
    else if (state._crisk === 'assuj') rows = rows.filter(c => c.assujettie);
    $('#clCount').textContent = `${rows.length} société(s) sur ${state.clients.length} · cliquez une ligne pour ouvrir la fiche client.`;
    $('#clRows').innerHTML = rows.length ? rows.map(c => `<tr class="clickable" data-id="${c.id}">
      <td><b>${esc(c.name)}</b></td><td class="mono dh">${esc(c.ice || '—')}</td><td>${esc(c.ville || '—')}</td>
      <td class="num">${money(c.ca, 0)}</td><td><span class="${c.assujettie ? 'tag-yes' : 'tag-no'}">${c.assujettie ? 'Oui' : 'Non'}</span></td>
      <td class="dh">${esc(c.regime)}</td><td class="dh">${esc(c.expert)}</td>
      <td class="num" style="font-weight:700;color:${c.retards ? 'var(--r-red)' : 'var(--muted)'}">${c.retards}</td>
      <td class="num">${c.amende ? money(c.amende) : '—'}</td><td>${riskPill(c.risk)}</td></tr>`).join('')
      : `<tr><td colspan="10" class="dh" style="text-align:center;padding:26px">Aucun client ne correspond.</td></tr>`;
    $$('#clRows tr[data-id]').forEach(tr => tr.onclick = () => setClient(tr.dataset.id));
  };
  $('#newClient').onclick = clientModal;
  $('#clSearch').oninput = e => { state._cq = e.target.value; draw(); };
  $$('.fpill[data-r]').forEach(b => b.onclick = () => { state._crisk = b.dataset.r; $$('.fpill[data-r]').forEach(x => x.setAttribute('aria-pressed', x.dataset.r === state._crisk)); draw(); });
  draw();
}

/* ============================== FICHE CLIENT (hub) ============================== */
const HUBICON = {
  delais: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 3v18M4 9h16M4 15h16"/>',
  conv: '<path d="M6 2h9l5 5v13a2 2 0 01-2 2H6a2 2 0 01-2-2V4a2 2 0 012-2z"/><path d="M14 2v6h6M9 14l2 2 4-4"/>',
  decl: '<path d="M6 2h9l5 5v13a2 2 0 01-2 2H6a2 2 0 01-2-2V4a2 2 0 012-2z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
  visa: '<path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/>',
  import: '<path d="M12 3v12m0 0l-4-4m4 4l4-4M4 19h16"/>',
};
async function renderClientOverview() {
  if (!state.clientId) return noClient();
  const s = await api(`/clients/${state.clientId}/summary`);
  const e = s.entreprise, k = s.kpis; if (!state.period) state.period = s.periode;
  const ini = (e.raison_sociale || 'CL').replace(/\b(STE|SARL|SA|SAS|SNC|AU)\b/gi, '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || 'CL';
  const card = (v, t, sub) => `<button class="hub-card" data-view="${v}"><div class="hc-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">${HUBICON[v]}</svg></div><b>${t}</b><span class="hc-sub">${sub}</span></button>`;
  $('#view').innerHTML = `
  <div class="hub-head">
    <div class="hub-id">${esc(ini)}</div>
    <div class="hub-meta"><h1>${esc(e.raison_sociale)}</h1>
      <div class="hub-tags">
        <span class="tag">ICE ${esc(e.ice || '—')}</span><span class="tag">IF ${esc(e.if_fiscal || '—')}</span>
        <span class="tag">${esc(e.ville || '—')}</span>
        <span class="tag ${e.assujettie ? 'on' : ''}">${e.assujettie ? 'Assujettie' : 'Non assujettie'}</span>
        <span class="tag">${esc(e.regime)}</span><span class="tag">Visa ${e.type_visa}</span></div></div>
    <div style="display:flex;gap:10px">
      <button class="btn btn-ghost" id="editClient"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg>Modifier</button>
      <button class="btn btn-ghost" id="delClient" style="color:var(--r-red);border-color:rgba(210,69,47,.35)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14"/></svg>Supprimer</button>
    </div>
  </div>
  <div class="kpi-grid">
    <div class="kpi"><div class="lbl">Fournisseurs</div><div class="val">${k.fournisseurs}</div></div>
    <div class="kpi"><div class="lbl">Factures (T${s.periode.trimestre} ${s.periode.annee})</div><div class="val">${k.factures}</div></div>
    <div class="kpi"><div class="lbl">En retard</div><div class="val" style="color:var(--r-orange)">${k.aDeclarer}</div></div>
    <div class="kpi accent"><div class="lbl">Montant TTC concerné</div><div class="val">${money(k.ttcRetard)} <small>DH</small></div></div>
    <div class="kpi accent"><div class="lbl">Amende du trimestre</div><div class="val" style="color:var(--r-red)">${money(k.amende)} <small>DH</small></div></div>
    <div class="kpi"><div class="lbl">Conventions manquantes</div><div class="val" style="color:${k.convManq ? 'var(--r-dred)' : 'var(--r-green)'}">${k.convManq}</div></div>
  </div>
  <h3 style="margin:6px 0 12px;font-size:15px">Modules du client</h3>
  <div class="hub-grid">
    ${card('delais', 'Feuille de calcul des délais', `${k.aDeclarer} en retard · ${money(k.amende)} DH`)}
    ${card('conv', 'Conventions & OCR', `${k.conventions} valide(s)${k.convManq ? ` · ${k.convManq} manquante(s)` : ''}`)}
    ${card('decl', 'Déclaration DGI', `Trimestre ${s.periode.trimestre} ${s.periode.annee}`)}
    ${card('visa', 'Générateur de visa', e.type_visa === 'CAC' ? 'Commissaire aux comptes' : 'Expert-comptable')}
    ${card('import', 'Importer des factures', `${k.factures} facture(s) chargée(s)`)}
  </div>`;
  $$('.hub-card[data-view]').forEach(b => b.onclick = () => setView(b.dataset.view));
  $('#editClient').onclick = () => editClientModal(e);
  $('#delClient').onclick = () => {
    modal(`<div class="modal-h"><h3>Supprimer le client</h3><button class="x" onclick="closeOverlay()">${XICO}</button></div>
    <div class="modal-b"><p style="margin:0 0 8px">Confirmez-vous la suppression de <b>${esc(e.raison_sociale)}</b> ?</p>
      <p class="dh" style="margin:0">Cette action supprime définitivement le client et toutes ses données associées (factures, fournisseurs, conventions, déclarations, visas). Elle est irréversible.</p></div>
    <div class="modal-f"><button class="btn btn-ghost" onclick="closeOverlay()">Annuler</button>
      <button class="btn btn-primary" id="delOk" style="background:var(--r-red)">Supprimer définitivement</button></div>`);
    $('#delOk').onclick = async () => {
      try {
        await api(`/clients/${e.id}`, { method: 'DELETE' });
        closeOverlay(); toast('Client supprimé.', 'ok');
        state.clients = await api('/clients');
        state.clientId = state.clients[0] ? state.clients[0].id : null;
        localStorage.setItem('dp-client', state.clientId || ''); state.period = null;
        updateSwitcherLabel(); refreshAlertsBadge();
        setView(state.clientId ? 'clients' : 'clients');
      } catch (err) { toast(err.message, 'err'); }
    };
  };
}
function editClientModal(e) {
  modal(`<div class="modal-h"><h3>Modifier le client</h3><button class="x" onclick="closeOverlay()">${XICO}</button></div>
  <div class="modal-b"><div class="form-grid">
    <div class="full"><label class="fld-lbl">Raison sociale</label><input class="input-fld" id="e_rs" value="${esc(e.raison_sociale || '')}"></div>
    <div><label class="fld-lbl">ICE</label><input class="input-fld" id="e_ice" value="${esc(e.ice || '')}"></div>
    <div><label class="fld-lbl">IF</label><input class="input-fld" id="e_if" value="${esc(e.if_fiscal || '')}"></div>
    <div><label class="fld-lbl">RC</label><input class="input-fld" id="e_rc" value="${esc(e.rc || '')}"></div>
    <div><label class="fld-lbl">Ville</label><input class="input-fld" id="e_ville" value="${esc(e.ville || '')}"></div>
    <div><label class="fld-lbl">CA HT (DH)</label><input class="input-fld" id="e_ca" type="number" value="${e.ca_ht || 0}"></div>
    <div><label class="fld-lbl">Secteur</label><input class="input-fld" id="e_sec" value="${esc(e.secteur || '')}"></div>
    <div class="full"><label class="fld-lbl">Adresse</label><input class="input-fld" id="e_adr" value="${esc(e.adresse || '')}"></div>
    <div><label class="fld-lbl">Expert responsable</label><input class="input-fld" id="e_exp" value="${esc(e.expert_responsable || '')}"></div>
  </div></div>
  <div class="modal-f"><button class="btn btn-ghost" onclick="closeOverlay()">Annuler</button><button class="btn btn-primary" id="e_save">Enregistrer</button></div>`);
  $('#e_save').onclick = async () => {
    try {
      await api(`/clients/${e.id}`, { method: 'PUT', body: { raison_sociale: $('#e_rs').value, ice: $('#e_ice').value, if_fiscal: $('#e_if').value, rc: $('#e_rc').value, ville: $('#e_ville').value, ca_ht: $('#e_ca').value, secteur: $('#e_sec').value, adresse: $('#e_adr').value, expert_responsable: $('#e_exp').value } });
      closeOverlay(); toast('Client mis à jour.', 'ok'); state.clients = await api('/clients'); renderClientOverview();
    } catch (err) { toast(err.message, 'err'); }
  };
}
function clientModal() {
  modal(`<div class="modal-h"><h3>Nouveau client</h3><button class="x" onclick="closeOverlay()">${XICO}</button></div>
  <div class="modal-b"><div class="form-grid">
    <div class="full"><label class="fld-lbl">Raison sociale *</label><input class="input-fld" id="c_rs"></div>
    <div><label class="fld-lbl">ICE</label><input class="input-fld" id="c_ice"></div>
    <div><label class="fld-lbl">Identifiant fiscal</label><input class="input-fld" id="c_if"></div>
    <div><label class="fld-lbl">RC</label><input class="input-fld" id="c_rc"></div>
    <div><label class="fld-lbl">Ville</label><input class="input-fld" id="c_ville"></div>
    <div><label class="fld-lbl">CA HT (DH)</label><input class="input-fld" id="c_ca" type="number"></div>
    <div><label class="fld-lbl">Exercice</label><input class="input-fld" id="c_ex" type="number" value="2026"></div>
    <div class="full"><label class="fld-lbl">Adresse</label><input class="input-fld" id="c_adr"></div>
    <div><label class="fld-lbl">Secteur</label><input class="input-fld" id="c_sec"></div>
    <div><label class="fld-lbl">Expert responsable</label><input class="input-fld" id="c_exp"></div>
  </div></div>
  <div class="modal-f"><button class="btn btn-ghost" onclick="closeOverlay()">Annuler</button><button class="btn btn-primary" id="c_save">Créer</button></div>`);
  $('#c_save').onclick = async () => {
    const rs = $('#c_rs').value.trim(); if (!rs) return toast('Raison sociale requise.', 'err');
    try {
      const r = await api('/clients', { method: 'POST', body: { raison_sociale: rs, ice: $('#c_ice').value, if_fiscal: $('#c_if').value, rc: $('#c_rc').value, ville: $('#c_ville').value, ca_ht: $('#c_ca').value, exercice_ref: $('#c_ex').value, adresse: $('#c_adr').value, secteur: $('#c_sec').value, expert_responsable: $('#c_exp').value } });
      closeOverlay(); toast('Client créé.', 'ok'); state.clients = await api('/clients'); state.clientId = r.id; renderClients();
    } catch (e) { toast(e.message, 'err'); }
  };
}

/* ============================== DELAIS ============================== */
async function renderDelais() {
  if (!state.clientId) return noClient();
  const periods = await ensurePeriod();
  const data = await api(`/clients/${state.clientId}/delais${perQuery()}`);
  const t = data.totals; state._delais = data;
  const filt = state._filter || 'all';
  const rows = data.rows.filter(r => filt === 'retard' ? r.a_declarer : (filt === 'conv' ? (!r.has_conv && r.delai_applicable >= 120) : true));
  $('#view').innerHTML = `
  ${clientPeriodBar(periods)}
  <div class="page-head headrow"><div><h1>Feuille de calcul des délais</h1><p>${esc(currentClient().name)} — T${data.periode.trimestre} ${data.periode.annee} · calcul automatique des retards et amendes (loi 69-21, mois calendaire).</p></div>
    <div style="display:flex;gap:10px"><button class="btn btn-ghost" id="recompute"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 4v6h6M20 20v-6h-6"/><path d="M20 8a8 8 0 00-14-3M4 16a8 8 0 0014 3"/></svg>Recalculer</button>
    <button class="btn btn-primary" onclick="setView('decl')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 2h9l5 5v13a2 2 0 01-2 2H6a2 2 0 01-2-2V4a2 2 0 012-2z"/><path d="M14 2v6h6"/></svg>Préparer la déclaration</button></div></div>
  <div class="kpi-grid">
    <div class="kpi"><div class="lbl">Factures analysées</div><div class="val">${t.count}</div><div class="sub">dont <b style="color:var(--r-red)">${t.aDeclarer} en retard</b></div></div>
    <div class="kpi accent"><div class="lbl">Montant TTC concerné</div><div class="val">${money(t.ttcRetard)} <small>DH</small></div><div class="sub">factures en retard</div></div>
    <div class="kpi"><div class="lbl">Retard moyen</div><div class="val">${t.retardMoyen} <small>j</small></div><div class="sub">au-delà de la convention</div></div>
    <div class="kpi accent"><div class="lbl">Amende du trimestre</div><div class="val" style="color:var(--r-red)">${money(t.amende)} <small>DH</small></div><div class="sub">à déclarer à la DGI</div></div>
  </div>
  <div class="filters" style="margin-bottom:14px">
    <button class="fpill" data-f="all" aria-pressed="${filt === 'all'}">Toutes<span class="c">${data.rows.length}</span></button>
    <button class="fpill" data-f="retard" aria-pressed="${filt === 'retard'}">Retard &gt; 0<span class="c">${t.aDeclarer}</span></button>
    <button class="fpill" data-f="conv" aria-pressed="${filt === 'conv'}">Convention absente<span class="c">${t.sansConvention}</span></button>
  </div>
  ${rows.length ? `<div class="table-wrap"><table style="min-width:1040px"><thead><tr>
    <th>N° facture</th><th>Fournisseur (IF)</th><th>Nature</th><th class="num">TTC</th><th>Date facture</th><th>Date paiement</th>
    <th class="num">Délai</th><th>Convention</th><th class="num">Retard</th><th>À déclarer</th><th class="num">Amende</th><th>Statut</th></tr></thead>
    <tbody>${rows.map(f => `<tr class="clickable" data-id="${f.id}">
      <td class="mono"><b>${esc(f.numero || '—')}</b></td>
      <td><div class="fournisseur"><b>${esc(f.four || '—')}</b><small>IF ${esc(f.four_if || '—')}</small></div></td>
      <td class="dh">${esc(f.nature || '—')}</td>
      <td class="num">${money(f.ttc)}</td>
      <td class="mono dh">${dateFr(f.date_facture)}</td>
      <td class="mono dh">${dateFr(f.date_paiement)}</td>
      <td class="num">${f.delai_ecoule != null ? f.delai_ecoule + ' j' : '—'}</td>
      <td><span class="badge ${f.delai_applicable >= 120 ? 'b120' : 'b60'}">${f.delai_applicable} j</span></td>
      <td class="retard ${f.retard > 0 ? 'pos' : 'neg'}">${f.retard > 0 ? '+' + f.retard : f.retard}</td>
      <td>${f.a_declarer ? '<span class="pill pill-red" style="font-size:11px"><span class="dot"></span>Oui</span>' : '<span class="tag-no">—</span>'}</td>
      <td class="num" style="font-weight:700">${f.amende ? money(f.amende) : '—'}</td>
      <td>${riskPill(f.risk)}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td colspan="3">Total — ${rows.length} facture(s)</td><td class="num">${money(rows.reduce((s, x) => s + (x.ttc || 0), 0))}</td><td colspan="4"></td><td></td><td></td><td class="num" style="color:var(--r-red)">${money(rows.reduce((s, x) => s + (x.amende || 0), 0))}</td><td></td></tr></tfoot>
  </table></div>` : emptyBox('Aucune facture', 'Importez un journal d\'achats (Excel) pour ce client et cette période.', 'import')}`;
  $$('.fpill').forEach(b => b.onclick = () => { state._filter = b.dataset.f; renderDelais(); });
  wireClientBar(renderDelais);
  $('#recompute').onclick = async () => { await api(`/clients/${state.clientId}/recompute${perQuery()}`, { method: 'POST' }); toast('Recalcul effectué.', 'ok'); renderDelais(); };
  $$('#view tbody tr[data-id]').forEach(tr => tr.onclick = () => factureDrawer(data.rows.find(x => x.id === tr.dataset.id)));
}
function factureDrawer(f) {
  if (!f) return;
  drawer(`<div class="drawer-h"><div><h3>Facture ${esc(f.numero || '')}</h3><div class="s">${esc(f.four || '')} · IF ${esc(f.four_if || '—')}</div></div><button class="x" onclick="closeOverlay()">${XICO}</button></div>
  <div class="drawer-b">
    <div><div class="det-row"><span class="k">Nature</span><span class="v" style="font-variant-numeric:normal">${esc(f.nature || '—')}</span></div>
      <div class="det-row"><span class="k">Montant HT</span><span class="v">${money(f.mht)} DH</span></div>
      <div class="det-row"><span class="k">TVA</span><span class="v">${money(f.tva)} DH</span></div>
      <div class="det-row"><span class="k">Montant TTC</span><span class="v">${money(f.ttc)} DH</span></div>
      <div class="det-row"><span class="k">Date facture</span><span class="v">${dateFr(f.date_facture)}</span></div>
      <div class="det-row"><span class="k">Date paiement</span><span class="v">${dateFr(f.date_paiement)}</span></div>
      <div class="det-row"><span class="k">Date limite légale</span><span class="v">${dateFr(f.date_limite)}</span></div>
    </div>
    <div class="calc">
      <div class="row"><span>Délai écoulé</span><b>${f.delai_ecoule} j</b></div>
      <div class="row"><span>Délai applicable (convention)</span><b>${f.delai_applicable} j</b></div>
      <div class="row"><span>Retard (au-delà du délai)</span><b style="color:${f.retard > 0 ? 'var(--r-red)' : 'var(--r-green)'}">${f.retard > 0 ? '+' + f.retard : f.retard} j</b></div>
      <div class="row"><span>Mois de retard</span><b>${f.n_mois || 0}</b></div>
      <div class="row"><span>Taux directeur BAM (1ᵉʳ mois)</span><b>${f.taux_bam != null ? pct(f.taux_bam) : '—'}</b></div>
      <div class="row"><span>Taux total appliqué</span><b>${f.taux_total ? pct(f.taux_total) : '—'}</b></div>
      <div class="row tot"><span>Amende (trimestre)</span><span>${money(f.amende)} DH</span></div>
    </div>
    <div class="dh" style="font-size:12px">Modèle trimestriel apporté (mois calendaire) : 1ᵉʳ mois de retard au taux directeur BAM, mois suivants à 0,85 %, seuls les mois du trimestre déclaré sont facturés.</div>
  </div>`);
}

/* ============================== IMPORT ============================== */
async function renderImport() {
  if (!state.clientId) return noClient();
  const periods = await ensurePeriod();
  $('#view').innerHTML = `
  ${clientPeriodBar(periods)}
  <div class="page-head"><h1>Import de fichiers</h1><p>Téléversez un journal d'achats (TVA) ou le fichier de calcul des délais au format Excel (.xlsx/.csv). Les fournisseurs, délais, retards et amendes sont calculés automatiquement.</p></div>
  <div class="grid-2-3">
    <div>
      <div class="dropzone" id="dz"><div class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 16V4m0 0l-4 4m4-4l4 4M5 20h14"/></svg></div>
        <b>Glissez vos fichiers ici</b><div style="margin-top:6px">ou cliquez pour parcourir · <b>plusieurs fichiers</b> acceptés · .xlsx, .xls, .csv</div></div>
      <input type="file" id="file" accept=".xlsx,.xls,.csv" class="hidden" multiple>
      <div id="importResult" style="margin-top:18px"></div>
    </div>
    <div class="card"><div class="card-h"><h3>Colonnes reconnues</h3></div><div class="card-b" style="font-size:12.5px;line-height:1.9;color:var(--muted)">
      <b style="color:var(--ink)">Format TVA / achats</b><br>identifiantFiscal, num, des, mht, tva, ttc, if, nom, ice, tx, id, dpai, dfac<br><br>
      <b style="color:var(--ink)">Format DELAI</b><br>… + colonne <b>convention</b> (60/120) utilisée comme délai applicable.<br><br>
      Contrôles automatiques : dates incohérentes, ICE (15 chiffres), TTC = HT+TVA, doublons.
    </div></div>
  </div>
  <div id="docsList" style="margin-top:22px"></div>`;
  wireClientBar(renderImport);
  const dz = $('#dz'), fi = $('#file');
  dz.onclick = () => fi.click();
  dz.ondragover = e => { e.preventDefault(); dz.classList.add('drag'); };
  dz.ondragleave = () => dz.classList.remove('drag');
  dz.ondrop = e => { e.preventDefault(); dz.classList.remove('drag'); if (e.dataTransfer.files.length) doImport(e.dataTransfer.files); };
  fi.onchange = () => { if (fi.files.length) doImport(fi.files); };
  renderDocs();
}
async function renderDocs() {
  const wrap = $('#docsList'); if (!wrap) return;
  const docs = await api(`/clients/${state.clientId}/documents`);
  wrap.innerHTML = `<div class="card"><div class="card-h"><div><h3>Fichiers importés</h3><div class="sub">${docs.length} fichier(s) · ${esc(currentClient().name)}</div></div></div>
    ${docs.length ? `<div class="table-wrap" style="box-shadow:none;border:0"><table style="min-width:640px"><thead><tr><th>Fichier</th><th class="num">Factures</th><th>Importé le</th><th></th></tr></thead>
      <tbody>${docs.map(d => `<tr><td><b>${esc(d.nom)}</b></td><td class="num">${d.nb_factures || 0}</td><td class="mono dh">${esc((d.created_at || '').replace('T', ' ').slice(0, 16))}</td>
        <td style="text-align:right;white-space:nowrap"><a class="btn btn-ghost btn-sm" href="/api/clients/${state.clientId}/documents/${d.id}/download">Télécharger</a>
          <button class="btn btn-ghost btn-sm" style="color:var(--r-red);border-color:rgba(210,69,47,.35)" data-del="${d.id}" data-nb="${d.nb_factures || 0}" data-nom="${esc(d.nom)}">Supprimer</button></td></tr>`).join('')}</tbody></table></div>`
    : '<div class="card-b dh">Aucun fichier importé pour ce client.</div>'}</div>`;
  $$('#docsList [data-del]').forEach(b => b.onclick = () => {
    if (!confirm(`Supprimer « ${b.dataset.nom} » ?\nCela retirera aussi les ${b.dataset.nb} facture(s) importée(s) depuis ce fichier.`)) return;
    api(`/clients/${state.clientId}/documents/${b.dataset.del}`, { method: 'DELETE' })
      .then(r => { toast(`Fichier supprimé (${r.facturesSupprimees} facture(s) retirée(s)).`, 'ok'); renderDocs(); refreshAlertsBadge(); })
      .catch(e => toast(e.message, 'err'));
  });
}
async function doImport(fileList) {
  const files = [...fileList];
  const box = $('#importResult');
  box.innerHTML = `<div class="card"><div class="card-b" style="display:flex;gap:10px;align-items:center"><span class="spin" style="border-color:rgba(14,77,100,.25);border-top-color:var(--primary)"></span>Import de ${files.length} fichier(s) en cours…</div></div>`;
  const fd = new FormData();
  files.forEach(f => fd.append('files', f));
  if (state.period) { fd.append('annee', state.period.annee); fd.append('trimestre', state.period.trimestre); }
  try {
    const r = await api(`/clients/${state.clientId}/import`, { method: 'POST', body: fd });
    const a = r.agg;
    toast(`${a.imported} facture(s) importée(s) depuis ${files.length} fichier(s).`, 'ok', 'Import terminé');
    box.innerHTML = `<div class="card"><div class="card-h"><h3>Résultat de l'import</h3></div><div class="card-b">
        <div class="kpi-grid" style="margin-bottom:10px">
          <div class="kpi"><div class="lbl">Importées</div><div class="val">${a.imported}</div></div>
          <div class="kpi"><div class="lbl">En retard</div><div class="val" style="color:var(--r-red)">${a.aDeclarer}</div></div>
          <div class="kpi"><div class="lbl">Fournisseurs créés</div><div class="val">${a.fournisseursCreated}</div></div>
          <div class="kpi accent"><div class="lbl">Amende estimée</div><div class="val">${money(a.amende)} <small>DH</small></div></div>
        </div>
        ${r.files.map(f => `<div class="list-row"><div style="flex:1"><b>${esc(f.file)}</b> ${f.ok ? `<span class="badge b120">${esc(f.format)}</span>` : '<span class="pill pill-red"><span class="dot"></span>Échec</span>'}
          <div class="dh" style="font-size:12px">${f.ok ? `${f.imported} importée(s) · ${f.duplicates} doublon(s) · ${f.anomalies.length} anomalie(s)` : esc(f.error)}</div></div></div>`).join('')}
        ${a.duplicates ? `<div class="dh" style="margin-top:8px">${a.duplicates} doublon(s) ignoré(s) au total · ${a.anomalies} anomalie(s) détectée(s).</div>` : ''}
        <div style="margin-top:16px;display:flex;gap:10px"><button class="btn btn-primary" onclick="setView('delais')">Voir la feuille de calcul →</button>${a.anomalies ? `<button class="btn btn-ghost" onclick="setView('anomalies')">Voir les anomalies</button>` : ''}</div>
      </div></div>`;
    renderDocs(); refreshAlertsBadge();
  } catch (e) { box.innerHTML = `<div class="card"><div class="card-b" style="color:var(--r-red)">${esc(e.message)}</div></div>`; toast(e.message, 'err'); }
}

/* ============================== CONVENTIONS ============================== */
async function renderConv() {
  if (!state.clientId) return noClient();
  const rows = await api(`/clients/${state.clientId}/conventions`);
  const S = { 'Trouvée': 'pill-ok', 'Bientôt expirée': 'pill-orange', 'Expirée': 'pill-red', 'Absente': 'pill-red' };
  $('#view').innerHTML = `
  ${clientPeriodBar(null, false)}
  <div class="page-head headrow"><div><h1>Conventions &amp; OCR</h1><p>Registre des conventions de délai fournisseurs de ${esc(currentClient().name)}. Le délai de 120 j est appliqué automatiquement aux fournisseurs conventionnés.</p></div>
    <button class="btn btn-primary" id="newConv"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 5v14M5 12h14"/></svg>Nouvelle convention</button></div>
  ${rows.length ? `<div class="table-wrap"><table style="min-width:900px"><thead><tr><th>Fournisseur (ICE)</th><th>Objet</th><th class="num">Délai</th><th>Début</th><th>Fin</th><th>Statut</th><th>Document</th><th></th></tr></thead>
    <tbody>${rows.map(c => `<tr><td><div class="fournisseur"><b>${esc(c.fournisseur || '—')}</b><small>${esc(c.four_ice || c.four_if || '')}</small></div></td>
      <td class="dh">${esc(c.objet || '—')}</td><td class="num"><span class="badge b120">${c.delai} j</span></td>
      <td class="mono dh">${dateFr(c.date_debut)}</td><td class="mono dh">${c.date_fin ? dateFr(c.date_fin) : 'Indéterminée'}</td>
      <td><span class="pill ${S[c.statut] || 'pill-ok'}"><span class="dot"></span>${esc(c.statut)}</span></td>
      <td>${c.fichier ? `<a href="/api/conventions/${c.fichier}/file" target="_blank">Ouvrir</a>` : '<span class="tag-no">—</span>'}</td>
      <td style="text-align:right"><button class="btn btn-ghost btn-sm" style="color:var(--r-red);border-color:rgba(210,69,47,.35)" data-delc="${c.id}" data-four="${esc(c.fournisseur || '')}">Supprimer</button></td></tr>`).join('')}</tbody></table></div>`
    : emptyBox('Aucune convention', 'Ajoutez les conventions de délai (120 j) signées avec les fournisseurs.', null)}`;
  wireClientBar(renderConv);
  $('#newConv').onclick = convModal;
  $$('#view [data-delc]').forEach(b => b.onclick = () => {
    if (!confirm(`Supprimer la convention de « ${b.dataset.four} » ?\nLe délai applicable repassera à 60 j pour ce fournisseur (recalcul automatique des retards).`)) return;
    api(`/clients/${state.clientId}/conventions/${b.dataset.delc}`, { method: 'DELETE' })
      .then(() => { toast('Convention supprimée.', 'ok'); renderConv(); refreshAlertsBadge(); })
      .catch(e => toast(e.message, 'err'));
  });
}
async function convModal() {
  const fours = await api(`/clients/${state.clientId}/fournisseurs`);
  const opts = fours.map(f => `<option value="${f.id}">${esc(f.raison_sociale || f.ice || f.id)}</option>`).join('');
  modal(`<div class="modal-h"><h3>Nouvelle convention</h3><button class="x" onclick="closeOverlay()">${XICO}</button></div>
  <div class="modal-b"><div class="form-grid">
    <div class="full"><label class="fld-lbl">Fournisseur existant</label><select class="input-fld" id="v_four"><option value="">— nouveau fournisseur —</option>${opts}</select></div>
    <div><label class="fld-lbl">Nom (si nouveau)</label><input class="input-fld" id="v_nom"></div>
    <div><label class="fld-lbl">ICE</label><input class="input-fld" id="v_ice"></div>
    <div><label class="fld-lbl">Délai convenu (j)</label><input class="input-fld" id="v_delai" type="number" value="120"></div>
    <div><label class="fld-lbl">Date de fin (option.)</label><input class="input-fld" id="v_fin" type="date"></div>
    <div class="full"><label class="fld-lbl">Fichier (PDF/image scanné)</label><input class="input-fld" id="v_file" type="file" accept=".pdf,.png,.jpg,.jpeg"></div>
  </div><div class="dh" style="margin-top:8px;font-size:12px">💡 L'OCR extraira automatiquement les parties, l'ICE et le délai (module IA — V2). Vous pouvez valider/corriger les champs.</div></div>
  <div class="modal-f"><button class="btn btn-ghost" onclick="closeOverlay()">Annuler</button><button class="btn btn-primary" id="v_save">Enregistrer</button></div>`);
  $('#v_save').onclick = async () => {
    const fd = new FormData();
    fd.append('fournisseur_id', $('#v_four').value);
    fd.append('fournisseur', $('#v_nom').value); fd.append('four_ice', $('#v_ice').value);
    fd.append('delai', $('#v_delai').value || 120);
    if ($('#v_fin').value) fd.append('date_fin', $('#v_fin').value);
    if ($('#v_file').files[0]) fd.append('file', $('#v_file').files[0]);
    try { await api(`/clients/${state.clientId}/conventions`, { method: 'POST', body: fd }); closeOverlay(); toast('Convention enregistrée.', 'ok'); renderConv(); }
    catch (e) { toast(e.message, 'err'); }
  };
}

/* ============================== DECLARATION ============================== */
async function renderDecl() {
  if (!state.clientId) return noClient();
  const periods = await ensurePeriod();
  const d = await api(`/clients/${state.clientId}/declaration${perQuery()}`);
  const e = d.entreprise, dec = d.declaration, L = d.lignes;
  const base = `/api/clients/${state.clientId}/declaration`;
  $('#view').innerHTML = `
  ${clientPeriodBar(periods)}
  <div class="page-head headrow"><div><h1>Déclaration DGI — délais de paiement</h1><p>Formulaire trimestriel · articles 78-3 &amp; 78-4 (loi 15-95).</p></div>
    <div style="display:flex;gap:10px">
      <a class="btn btn-ghost" href="${base}/export.csv${perQuery()}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 2h9l5 5v13a2 2 0 01-2 2H6a2 2 0 01-2-2V4a2 2 0 012-2z"/></svg>CSV</a>
      <a class="btn btn-ghost" href="${base}/export.xml${perQuery()}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18"/></svg>XML EDI</a>
      <button class="btn btn-primary" onclick="setView('visa')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/></svg>Générer le visa</button></div></div>
  <div class="form-doc">
    <div class="doc-band"><div><h2>Déclaration des délais de paiement</h2><div class="official">Direction Générale des Impôts · Royaume du Maroc · Modèle 69-21</div></div><div class="draft">${esc(dec.statut)}</div></div>
    <div class="doc-sec"><h4>En-tête de déclaration</h4><div class="field-grid">
      <div class="field"><label>Année</label><div class="v mono">${dec.annee}</div></div>
      <div class="field"><label>Période</label><div class="v">Trimestre ${dec.trimestre}</div></div>
      <div class="field"><label>Chiffre d'affaires HT</label><div class="v mono">${money(e.ca_ht)} DH</div></div>
      <div class="field"><label>Activité</label><div class="v">${esc(e.secteur || '—')}</div></div></div></div>
    <div class="doc-sec"><h4>Identité du déclarant</h4><div class="field-grid">
      <div class="field"><label>Raison sociale</label><div class="v">${esc(e.raison_sociale)}</div></div>
      <div class="field"><label>Identifiant fiscal (IF)</label><div class="v mono">${esc(e.if_fiscal || '—')}</div></div>
      <div class="field"><label>ICE</label><div class="v mono">${esc(e.ice || '—')}</div></div>
      <div class="field"><label>Registre de commerce</label><div class="v mono">${esc(e.rc || '—')}</div></div>
      <div class="field" style="grid-column:span 2"><label>Adresse</label><div class="v">${esc(e.adresse || '—')}</div></div></div></div>
    <div class="doc-sec"><h4>État des factures payées hors délai (${L.length})</h4>
      <div class="table-wrap" style="box-shadow:none"><table style="min-width:640px"><thead><tr><th>IF fournisseur</th><th>Raison sociale</th><th class="num">TTC</th><th class="num">Non payé</th><th class="num">Payé hors délai</th><th class="num">Retard</th><th class="num">Amende</th></tr></thead>
      <tbody>${L.length ? L.map(l => `<tr><td class="mono dh">${esc(l.if || '—')}</td><td><b>${esc(l.nom || '—')}</b></td><td class="num">${money(l.ttc)}</td><td class="num">${money(l.non_paye)}</td><td class="num">${money(l.hors_delai)}</td><td class="num" style="color:var(--r-red)">+${l.retard} j</td><td class="num" style="font-weight:700">${money(l.amende)}</td></tr>`).join('') : '<tr><td colspan="7" class="dh" style="text-align:center;padding:24px">Aucune facture hors délai sur la période — déclaration « néant ».</td></tr>'}</tbody>
      <tfoot><tr><td colspan="2">Total</td><td class="num">${money(dec.montant_total_ttc)}</td><td class="num">${money(dec.montant_non_paye)}</td><td class="num">${money(dec.montant_paye_hors_delai)}</td><td></td><td class="num" style="color:var(--r-red)">${money(dec.montant_total_amende)}</td></tr></tfoot></table></div></div>
    <div class="pay-band">
      <div><div class="dh" style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Montant à verser</div><div class="amt">${money(dec.montant_a_verser)} DH</div><div class="dh" style="font-size:11.5px">amende ${money(dec.montant_total_amende)} + sanctions ${money(dec.sanctions_retard)}</div></div>
      <div class="visa-box"><div class="st"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 12l2 2 4-4"/></svg></div>
        <div><b style="font-size:13px">Visa ${dec.type_visa === 'CAC' ? 'du commissaire aux comptes' : "de l'expert-comptable"}</b><div class="dh" style="font-size:12px">${esc(state.me.nom)} · en attente de signature</div></div></div>
    </div>
    <div class="doc-sec" style="border-bottom:0;display:flex;justify-content:space-between;color:var(--muted);font-size:12px"><span>Édité le ${dateFr(dec.date_edition)} · DelaiPay</span><span>Référence : art. 78-3 &amp; 78-4 (loi 15-95)</span></div>
  </div>`;
  wireClientBar(renderDecl);
}

/* ============================== VISA ============================== */
async function renderVisa() {
  if (!state.clientId) return noClient();
  const periods = await ensurePeriod();
  const concl = state._concl || 'Sans observation';
  const sign = state._sign || (state.me && state.me.nom) || '';
  const q = `?annee=${state.period.annee}&trimestre=${state.period.trimestre}&conclusion=${encodeURIComponent(concl)}${sign ? `&signataire=${encodeURIComponent(sign)}` : ''}`;
  const v = await api(`/clients/${state.clientId}/visa${q}`);
  const base = `/api/clients/${state.clientId}/visa`;
  const preview = v.blocks.map(b => {
    const runs = (b.runs || []).map(r => { let t = esc(r.t); if (r.u) t = `<u>${t}</u>`; if (r.b) t = `<b>${t}</b>`; return t; }).join('');
    if (!runs) return '<div style="height:9px"></div>';
    return `<p style="text-align:${b.align === 'right' ? 'right' : (b.align === 'left' ? 'left' : 'justify')};margin:0 0 11px">${runs}</p>`;
  }).join('');
  $('#view').innerHTML = `
  ${clientPeriodBar(periods)}
  <div class="page-head"><h1>Générateur de visa</h1><p>Visa ${v.type === 'CAC' ? 'du commissaire aux comptes' : "de l'expert-comptable"} — modèle officiel (loi 69-21) · export <b>Word</b> et <b>PDF</b>.</p></div>
  <div class="grid-2">
    <div class="card"><div class="card-h"><h3>Paramètres du visa</h3></div><div class="card-b">
      <div class="fld"><label class="fld-lbl">Type de professionnel</label><input class="input-fld" value="${esc(v.typeLabel)}" readonly></div>
      <div class="fld"><label class="fld-lbl">Période visée</label><input class="input-fld" value="Trimestre ${v.periode.trimestre} ${v.periode.annee} · ${v.debut} au ${v.fin}" readonly></div>
      <div class="fld"><label class="fld-lbl">Montant visé (factures non payées dans les délais)</label><input class="input-fld mono" value="${money(v.montant_vise)} DH" readonly></div>
      <div class="fld"><label class="fld-lbl">Type de conclusion</label><select class="input-fld" id="conclSel">
        ${['Sans observation', 'Avec observation', 'Avec réserve', 'Refus de visa'].map(o => `<option ${o === concl ? 'selected' : ''}>${o}</option>`).join('')}</select></div>
      <div class="fld"><label class="fld-lbl">Signataire</label><input class="input-fld" id="signInp" value="${esc(sign || v.signataire)}"></div>
      <div class="fld"><label class="fld-lbl">Référence</label><input class="input-fld" value="${esc(v.reference)}" readonly></div>
      <div style="display:flex;gap:10px;margin-top:4px">
        <a class="btn btn-primary" href="${base}/export.docx${q}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 2h9l5 5v13a2 2 0 01-2 2H6a2 2 0 01-2-2V4a2 2 0 012-2z"/><path d="M14 2v6h6"/></svg>Word (.docx)</a>
        <a class="btn btn-gold" href="${base}/export.pdf${q}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 2h9l5 5v13a2 2 0 01-2 2H6a2 2 0 01-2-2V4a2 2 0 012-2z"/><path d="M14 2v6h6M9 13h6M9 17h4"/></svg>PDF</a>
      </div>
    </div></div>
    <div class="card"><div class="card-h"><div><h3>Aperçu — modèle officiel</h3><div class="sub">identique au fichier Word / PDF généré</div></div></div><div class="card-b">
      <div class="doc-preview">${preview}</div>
    </div></div>
  </div>`;
  wireClientBar(renderVisa);
  $('#conclSel').onchange = e => { state._concl = e.target.value; renderVisa(); };
  const si = $('#signInp'); si.onchange = () => { state._sign = si.value; renderVisa(); };
}

/* ============================== ALERTES ============================== */
async function renderAlerts() {
  const d = await api('/alerts');
  $('#view').innerHTML = `
  <div class="page-head"><h1>Centre d'alertes</h1><p>${d.count} alerte(s) · conventions manquantes, anomalies de données et échéances déclaratives.</p></div>
  <div class="card">${d.alerts.length ? d.alerts.map(a => `<div class="alert-row">
    <div class="al-ic ${a.icon}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 9v4m0 4h.01M10.3 3.9L2 18a2 2 0 001.7 3h16.6a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/></svg></div>
    <div class="al-body"><div class="t">${esc(a.titre)} <span class="sev ${a.severite}">${a.severite === 'h' ? 'Élevée' : a.severite === 'm' ? 'Moyenne' : 'Info'}</span></div>
    <div class="m">${esc(a.message)}</div><div class="d">${esc(a.date)}</div></div></div>`).join('') : '<div class="empty"><h4>Aucune alerte</h4><p>Tout est conforme sur votre portefeuille.</p></div>'}</div>`;
}

/* ============================== VUES PORTEFEUILLE (cliquables depuis le dashboard) ============================== */
function goClient(entId, view) { if (!entId) return; state.clientId = entId; localStorage.setItem('dp-client', entId); state.period = null; updateSwitcherLabel(); setView(view || 'client'); }
window.goClient = goClient;

async function renderRetards() {
  const rows = await api('/portfolio/retards');
  const tot = rows.reduce((s, r) => s + (r.montant_amende || 0), 0);
  const ttc = rows.reduce((s, r) => s + (r.ttc || 0), 0);
  $('#view').innerHTML = `
  <div class="page-head"><h1>Factures en retard — portefeuille</h1><p>${rows.length} facture(s) à déclarer sur l'ensemble des clients · TTC concerné <b>${money(ttc)} DH</b> · amende <b>${money(tot)} DH</b>.</p></div>
  ${rows.length ? `<div class="table-wrap"><table style="min-width:1000px"><thead><tr>
    <th>Client</th><th>Fournisseur (IF)</th><th>N° facture</th><th class="num">TTC</th><th>Date facture</th><th>Date paiement</th><th>Conv.</th><th class="num">Retard</th><th class="num">Amende</th><th>Risque</th></tr></thead>
    <tbody>${rows.map(f => `<tr class="clickable" data-ent="${f.ent_id}">
      <td><b>${esc(f.ent)}</b></td><td><div class="fournisseur"><b>${esc(f.four || '—')}</b><small>IF ${esc(f.four_if || '—')}</small></div></td>
      <td class="mono">${esc(f.numero || '—')}</td><td class="num">${money(f.ttc)}</td>
      <td class="mono dh">${dateFr(f.date_facture)}</td><td class="mono dh">${dateFr(f.date_paiement)}</td>
      <td><span class="badge ${f.delai_applicable >= 120 ? 'b120' : 'b60'}">${f.delai_applicable} j</span></td>
      <td class="retard pos">+${f.retard_jours}</td><td class="num" style="font-weight:700">${money(f.montant_amende)}</td><td>${riskPill(f.couleur_risque)}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td colspan="3">Total</td><td class="num">${money(ttc)}</td><td colspan="4"></td><td class="num" style="color:var(--r-red)">${money(tot)}</td><td></td></tr></tfoot></table></div>`
    : emptyBox('Aucune facture en retard', 'Toutes les factures du portefeuille sont dans les délais.', 'dash')}`;
  $$('#view tbody tr[data-ent]').forEach(tr => tr.onclick = () => goClient(tr.dataset.ent, 'delais'));
}

async function renderConvMiss() {
  const rows = await api('/portfolio/conventions-manquantes');
  $('#view').innerHTML = `
  <div class="page-head"><h1>Conventions manquantes</h1><p>${rows.length} fournisseur(s) avec un délai de 120 j appliqué mais <b>sans convention en GED</b> — à régulariser (justificatif requis pour le visa).</p></div>
  ${rows.length ? `<div class="table-wrap"><table style="min-width:820px"><thead><tr><th>Client</th><th>Fournisseur</th><th>ICE / IF</th><th class="num">Factures en retard</th><th class="num">TTC concerné</th><th></th></tr></thead>
    <tbody>${rows.map(r => `<tr class="clickable" data-ent="${r.ent_id}"><td><b>${esc(r.ent)}</b></td><td>${esc(r.four || '—')}</td><td class="mono dh">${esc(r.ice || r.if_fiscal || '—')}</td>
      <td class="num" style="font-weight:700">${r.nb}</td><td class="num">${money(r.ttc)}</td>
      <td><span class="pill pill-orange"><span class="dot"></span>À régulariser</span></td></tr>`).join('')}</tbody></table></div>`
    : emptyBox('Aucune convention manquante', 'Tous les fournisseurs à 120 j disposent d\'une convention valide.', 'dash')}`;
  $$('#view tbody tr[data-ent]').forEach(tr => tr.onclick = () => goClient(tr.dataset.ent, 'conv'));
}

async function renderCabConv() {
  const rows = await api('/portfolio/conventions');
  const S = { 'Trouvée': 'pill-ok', 'Bientôt expirée': 'pill-orange', 'Expirée': 'pill-red' };
  $('#view').innerHTML = `
  <div class="page-head"><h1>Conventions du portefeuille</h1><p>${rows.length} convention(s) valide(s) enregistrée(s) sur l'ensemble des clients.</p></div>
  ${rows.length ? `<div class="table-wrap"><table style="min-width:820px"><thead><tr><th>Client</th><th>Fournisseur (ICE)</th><th class="num">Délai</th><th>Fin</th><th>Statut</th><th>Document</th></tr></thead>
    <tbody>${rows.map(c => `<tr class="clickable" data-ent="${c.ent_id}"><td><b>${esc(c.ent)}</b></td><td><div class="fournisseur"><b>${esc(c.four || '—')}</b><small>${esc(c.four_ice || '')}</small></div></td>
      <td class="num"><span class="badge b120">${c.delai} j</span></td><td class="mono dh">${c.date_fin ? dateFr(c.date_fin) : 'Indéterminée'}</td>
      <td><span class="pill ${S[c.statut] || 'pill-ok'}"><span class="dot"></span>${esc(c.statut)}</span></td>
      <td>${c.fichier ? `<a href="/api/conventions/${c.fichier}/file" target="_blank" onclick="event.stopPropagation()">Ouvrir</a>` : '<span class="tag-no">—</span>'}</td></tr>`).join('')}</tbody></table></div>`
    : emptyBox('Aucune convention', 'Aucune convention enregistrée dans le portefeuille.', 'dash')}`;
  $$('#view tbody tr[data-ent]').forEach(tr => tr.onclick = () => goClient(tr.dataset.ent, 'conv'));
}

async function renderAnomalies() {
  const rows = await api('/anomalies');
  const LBL = { date_incoherente: 'Date incohérente', date_future: 'Date dans le futur', date_manquante: 'Date manquante', montant_incoherent: 'Montant incohérent', doublon: 'Doublon' };
  const ouvertes = rows.filter(r => r.statut === 'ouverte').length;
  $('#view').innerHTML = `
  <div class="page-head"><h1>Anomalies</h1><p>${ouvertes} anomalie(s) ouverte(s) sur ${rows.length} détectée(s) — contrôles automatiques à l'import (dates, ICE, TTC, doublons).</p></div>
  <div class="card">${rows.length ? rows.map(a => `<div class="alert-row">
    <div class="al-ic ${a.gravite === 'haute' ? 'red' : (a.gravite === 'moyenne' ? 'yellow' : 'orange')}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 9v4m0 4h.01M10.3 3.9L2 18a2 2 0 001.7 3h16.6a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/></svg></div>
    <div class="al-body"><div class="t">${esc(LBL[a.type] || 'Anomalie')} <span class="sev ${a.gravite === 'haute' ? 'h' : 'm'}">${esc(a.gravite)}</span>${a.statut !== 'ouverte' ? '<span class="sev l">résolue</span>' : ''}</div>
      <div class="m">${esc(a.details || '')}</div><div class="d">${esc(a.ent || '—')} · ${esc(a.created_at || '')}</div></div>
    ${a.statut === 'ouverte' ? `<button class="btn btn-ghost btn-sm" data-res="${a.id}">Marquer résolue</button>` : ''}</div>`).join('')
    : '<div class="empty"><h4>Aucune anomalie</h4><p>Aucune anomalie détectée sur le portefeuille.</p></div>'}</div>`;
  $$('#view [data-res]').forEach(b => b.onclick = async () => { await api(`/anomalies/${b.dataset.res}/resolve`, { method: 'POST' }); toast('Anomalie résolue.', 'ok'); refreshAlertsBadge(); renderAnomalies(); });
}

/* ============================== TAUX ============================== */
async function renderTaux() {
  const rows = await api('/taux');
  $('#view').innerHTML = `
  <div class="page-head headrow"><div><h1>Taux Bank Al-Maghrib &amp; paramètres</h1><p>Historique du taux directeur appliqué au 1ᵉʳ mois de retard. Le taux en vigueur au mois de retard concerné est utilisé.</p></div>
    <button class="btn btn-primary" id="addTaux"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 5v14M5 12h14"/></svg>Ajouter un taux</button></div>
  <div class="table-wrap"><table style="min-width:560px"><thead><tr><th class="num">Taux</th><th>Début</th><th>Fin</th><th>Référence</th></tr></thead>
  <tbody>${rows.map(t => `<tr><td class="num" style="font-weight:700">${pct(t.taux)}</td><td class="mono dh">${dateFr(t.date_debut)}</td><td class="mono dh">${t.date_fin ? dateFr(t.date_fin) : 'En vigueur'}</td><td class="dh">${esc(t.reference || '—')}</td></tr>`).join('')}</tbody></table></div>
  <div class="card" style="margin-top:18px"><div class="card-b" style="font-size:12.5px;color:var(--muted)">
    <b style="color:var(--ink)">Règle de calcul (confirmée) :</b> découpage par <b>mois calendaire</b>. 1ᵉʳ mois de retard = taux directeur BAM ; chaque mois suivant = <b>0,85 %</b> ; seuls les mois du trimestre déclaré sont facturés.
  </div></div>`;
  $('#addTaux').onclick = () => {
    modal(`<div class="modal-h"><h3>Ajouter un taux</h3><button class="x" onclick="closeOverlay()">${XICO}</button></div>
    <div class="modal-b"><div class="form-grid">
      <div><label class="fld-lbl">Taux (ex. 0.0225)</label><input class="input-fld" id="t_taux" type="number" step="0.0001"></div>
      <div><label class="fld-lbl">Référence</label><input class="input-fld" id="t_ref" placeholder="BAM 2,25 %"></div>
      <div><label class="fld-lbl">Date de début</label><input class="input-fld" id="t_deb" type="date"></div>
      <div><label class="fld-lbl">Date de fin (option.)</label><input class="input-fld" id="t_fin" type="date"></div>
    </div></div><div class="modal-f"><button class="btn btn-ghost" onclick="closeOverlay()">Annuler</button><button class="btn btn-primary" id="t_save">Ajouter</button></div>`);
    $('#t_save').onclick = async () => {
      try { await api('/taux', { method: 'POST', body: { taux: $('#t_taux').value, date_debut: $('#t_deb').value, date_fin: $('#t_fin').value, reference: $('#t_ref').value } }); closeOverlay(); toast('Taux ajouté.', 'ok'); renderTaux(); }
      catch (e) { toast(e.message, 'err'); }
    };
  };
}

/* ============================== AUDIT ============================== */
async function renderAudit() {
  const rows = await api('/audit');
  $('#view').innerHTML = `
  <div class="page-head"><h1>Journal d'audit</h1><p>Traçabilité des actions sensibles (connexions, imports, créations, visas).</p></div>
  <div class="table-wrap"><table style="min-width:640px"><thead><tr><th>Date</th><th>Utilisateur</th><th>Action</th><th>Entité</th><th>Détails</th></tr></thead>
  <tbody>${rows.length ? rows.map(a => `<tr><td class="mono dh">${esc(a.created_at)}</td><td>${esc(a.user_nom || '—')}</td><td><span class="badge">${esc(a.action)}</span></td><td class="dh">${esc(a.entite || '—')}</td><td class="dh" style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.details || '')}</td></tr>`).join('') : '<tr><td colspan="5" class="dh" style="text-align:center;padding:24px">Aucune entrée.</td></tr>'}</tbody></table></div>`;
}

/* ============================== divers ============================== */
function noClient() { $('#view').innerHTML = emptyBox('Aucun client', 'Créez d\'abord un client dans le portefeuille.', 'clients'); }
function emptyBox(title, msg, gotoView) {
  return `<div class="table-wrap"><div class="empty"><div class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 7h18M3 12h18M3 17h18"/></svg></div><h4>${esc(title)}</h4><p>${esc(msg)}</p>${gotoView ? `<button class="btn btn-primary" onclick="setView('${gotoView}')">Continuer</button>` : ''}</div></div>`;
}
async function refreshAlertsBadge() {
  try {
    const d = await api('/alerts');
    const b = $('#alertBadge'), dot = $('#notifDot');
    if (d.count > 0) { b.textContent = d.count; b.classList.remove('hidden'); dot.classList.remove('hidden'); }
    else { b.classList.add('hidden'); dot.classList.add('hidden'); }
  } catch {}
}

boot();
