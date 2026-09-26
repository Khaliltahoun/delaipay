'use strict';
/* ============================== état & utilitaires ============================== */
const state = { me: null, cabinet: null, clients: [], clientId: null, period: null, view: 'dash' };
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const debounce = (fn, ms = 140) => { let t; return function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), ms); }; };
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

/* Cache lecture (GET) : navigation entre vues instantanée, dédoublonnage des
 * requêtes en vol. Toute mutation (POST/PUT/DELETE) purge le cache. */
const _cache = new Map();     // path -> { t, data }
const _inflight = new Map();  // path -> Promise
const CACHE_TTL = 15000;      // 15 s de fraîcheur
function invalidateCache() { _cache.clear(); }
// Les données renvoyées sont traitées en lecture seule par les vues (aucune mutation),
// on peut donc partager la référence — pas de clonage (coûteux sur les gros tableaux).

// Erreur d'API lisible : message en clair + statut et code machine (pour réagir sans afficher de code technique).
function apiError(message, status, data) { const e = new Error(plainMsg(message)); e.status = status; e.code = (data && data.code) || null; return e; }
// Messages du moteur d'import : les clés techniques entre « » sont remplacées par leur libellé (aucune clé visible).
const FIELD_FR = { numero: 'N° de facture', date_facture: 'Date de facture', four_nom: 'Fournisseur', four_ice: 'ICE fournisseur', four_if: 'IF fournisseur',
  ttc: 'Montant TTC', mht: 'Montant HT', tva: 'Montant TVA', taux_tva: 'Taux TVA', date_paiement: 'Date de paiement', mode_reglement: 'Mode de paiement',
  designation: 'Nature / désignation', delai_conv: 'Délai convenu', nom: 'Nom fournisseur', iff: 'IF', conv: 'Convention (OUI/NON)', delai: 'Délai conventionnel (jours)',
  debut: 'Date de début', fin: 'Date de fin', ref: 'Référence convention', comm: 'Commentaire' };
function plainMsg(m) {
  return String(m == null ? '' : m).replace(/«\s*([a-z_]+)\s*»/g, (all, k) => FIELD_FR[k] ? `« ${FIELD_FR[k]} »` : all)
    .replace(/^Mapping refusé\s*:/, 'Correspondance des colonnes refusée :').replace(/\s\|\s/g, ' — ');
}
async function api(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const cacheable = method === 'GET' && !opts.noCache && typeof path === 'string';
  if (method !== 'GET') invalidateCache(); // une écriture invalide les lectures

  if (cacheable && !opts.fresh) {
    const hit = _cache.get(path);
    if (hit && (Date.now() - hit.t) < CACHE_TTL) return hit.data;
    if (_inflight.has(path)) return await _inflight.get(path);
  }

  const o = { credentials: 'same-origin', headers: {}, ...opts };
  if (o.body && !(o.body instanceof FormData)) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(o.body); }

  const run = (async () => {
    let res;
    try { res = await fetch('/api' + path, o); }
    catch (_) { throw new Error(method === 'GET' ? 'Connexion au service impossible. Vérifiez votre réseau puis réessayez.' : 'Connexion au service impossible : l’opération n’a pas été enregistrée. Vérifiez votre réseau puis réessayez.'); }
    const ct = res.headers.get('content-type') || '';
    checkSessionFingerprint(res.headers.get('X-DP-Session'));
    const data = ct.includes('json') ? await res.json().catch(() => ({})) : await res.text();
    // Session expirée / compte ou espace désactivé : retour à la connexion AVEC un motif lisible (jamais silencieux).
    if (res.status === 401) { const code = (data && data.code) || 'expired'; window.location.href = '/login?reason=' + encodeURIComponent(code); throw new Error((data && data.error) || 'Session expirée.'); }
    if (!res.ok) {
      if (res.status >= 500) throw new Error(method === 'GET' ? 'Une erreur est survenue côté serveur. Réessayez ; si le problème persiste, contactez le support DelaiPay.' : 'Une erreur est survenue : l’opération n’a pas abouti et aucune donnée n’a été modifiée. Réessayez ou contactez le support.');
      if (res.status === 429) throw apiError((data && data.error) || 'Trop de demandes en peu de temps : patientez quelques instants puis réessayez.', res.status, data);
      if (res.status === 403) throw apiError((data && data.error) || 'Votre rôle ne permet pas cette action. Demandez à un administrateur de l’espace.', res.status, data);
      throw apiError((data && data.error) || 'L’opération n’a pas pu être effectuée. Vérifiez les informations saisies puis réessayez.', res.status, data);
    }
    return data;
  })();

  if (!cacheable) return run;
  _inflight.set(path, run);
  try {
    const data = await run;
    _cache.set(path, { t: Date.now(), data });
    return data;
  } finally { _inflight.delete(path); }
}

/* Identité TOUJOURS dérivée de la session réelle : chaque réponse API porte « id:rôle » de la session.
 * Si l'onglet affiche un autre utilisateur (connexion d'un autre compte dans un autre onglet) ou un rôle
 * périmé, l'état local est jeté et l'application se réhydrate depuis /api/me (rechargement unique). */
let _reloading = false;
function checkSessionFingerprint(fp) {
  if (!fp || !state.me || _reloading) return;
  const [id, role] = fp.split(':');
  if (id !== state.me.id || role !== state.me.role) {
    _reloading = true;
    try { sessionStorage.setItem('dp-session-changed', id !== state.me.id ? 'user' : 'role'); } catch (_) {}
    _cache.clear(); window.location.reload();
  }
}
// Retour sur l'onglet : vérification immédiate de la session (pas d'attente d'une action).
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.me) api('/me', { noCache: true }).catch(() => {}); });

/* Rendu paginé pour les grands tableaux : n'injecte qu'une tranche de lignes à la fois
   (évite de figer l'onglet sur des milliers de <tr>). La vue doit contenir un
   <tbody id="pgBody"> et un conteneur <div id="pgMore">. Clic délégué sur le <tbody>. */
function mountPaged(rows, rowFn, opts = {}) {
  const pageSize = opts.pageSize || 200;
  const tbody = $('#pgBody'), bar = $('#pgMore');
  if (!tbody) return;
  let shown = 0;
  function more() {
    tbody.insertAdjacentHTML('beforeend', rows.slice(shown, shown + pageSize).map(rowFn).join(''));
    shown = Math.min(shown + pageSize, rows.length);
    if (bar) {
      bar.innerHTML = shown < rows.length
        ? `<button class="btn btn-ghost" id="pgBtn">Afficher plus — ${shown} / ${rows.length}</button>`
        : (rows.length > pageSize ? `<span style="color:var(--muted);font-size:var(--fs-sm)">${rows.length} ligne(s) affichée(s)</span>` : '');
      const b = $('#pgBtn'); if (b) b.onclick = more;
    }
  }
  more();
  if (opts.onRow) tbody.onclick = e => {
    if (e.target.closest('a')) return;          // laisser les liens (ex. « Ouvrir ») fonctionner
    const tr = e.target.closest('tr'); if (tr && tbody.contains(tr)) opts.onRow(tr);
  };
}
/* Jeu d'icônes (trait 1,8 — cohérent avec la navigation). Aucune émoji comme icône d'état. */
const IC = {
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 017.5-2"/>',
  cal: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  warn: '<path d="M12 9v4m0 4h.01M10.3 3.9L2 18a2 2 0 001.7 3h16.6a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/>',
  stop: '<circle cx="12" cy="12" r="9"/><path d="M5.7 5.7l12.6 12.6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  checkc: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  doc: '<path d="M6 2h9l5 5v13a2 2 0 01-2 2H6a2 2 0 01-2-2V4a2 2 0 012-2z"/><path d="M14 2v6h6"/>',
  dl: '<path d="M12 3v12m0 0l-4-4m4 4l4-4M5 17v2a2 2 0 002 2h10a2 2 0 002-2v-2"/>',
  up: '<path d="M12 16V4m0 0l-4 4m4-4l4 4M5 20h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  refresh: '<path d="M4 4v6h6M20 20v-6h-6"/><path d="M20 8a8 8 0 00-14-3M4 16a8 8 0 0014 3"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 20a5.5 5.5 0 0111 0"/><path d="M16 5.2a3 3 0 010 5.6M17 20a5.5 5.5 0 00-3-4.9"/>',
  building: '<path d="M3 21h18M5 21V7l7-4 7 4v14M10 21v-4h4v4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/>',
  table: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M4 9h16M4 15h16M10 9v12"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14"/>',
  seal: '<circle cx="12" cy="12" r="9"/><path d="M9 12l2 2 4-4"/>',
  history: '<path d="M3 12a9 9 0 109-9 9 9 0 00-6.4 2.6L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
};
function svgI(name, cls = 'ico') { return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${IC[name] || ''}</svg>`; }

function toast(msg, type = 'ok', title = '') {
  const t = document.createElement('div'); t.className = 'toast ' + type;
  t.setAttribute('role', type === 'err' ? 'alert' : 'status');
  const ico = { ok: 'check', err: 'x', warn: 'warn', info: 'info' }[type] || 'info';
  t.innerHTML = `<span class="t-ic">${svgI(ico, '')}</span><div>${title ? `<b>${esc(title)}</b>` : ''}${esc(msg)}</div><button class="t-x" aria-label="Fermer">×</button>`;
  const kill = () => { t.classList.add('out'); setTimeout(() => t.remove(), 220); };
  t.querySelector('.t-x').onclick = kill;
  $('#toasts').appendChild(t); setTimeout(kill, type === 'err' ? 8000 : 4500);
}
const RISK = { ok: ['pill-ok', 'Normal'], app: ['pill-app', 'Approche'], orange: ['pill-orange', 'Attention'], red: ['pill-red', 'Retard'], dred: ['pill-dred', 'Pénalités'] };
function riskPill(r) { const [c, l] = RISK[r] || RISK.ok; return `<span class="pill ${c}"><span class="dot"></span>${l}</span>`; }

/* ============================== overlay (drawer/modal) ============================== */
let _overlayReturn = null, _overlayOnClose = null;
function closeOverlay() {
  $('#overlay').innerHTML = '';
  const cb = _overlayOnClose; _overlayOnClose = null; if (cb) cb();
  if (_overlayReturn && document.contains(_overlayReturn)) { try { _overlayReturn.focus(); } catch (_) {} }
  _overlayReturn = null;
}
function openOverlay(html, focusSel) {
  _overlayReturn = document.activeElement;
  $('#overlay').innerHTML = html;
  const box = $('#overlay [role="dialog"]');
  const f = (focusSel && $(focusSel, box)) || $('input:not([type=hidden]):not([readonly]),select,textarea', box) || $('.modal-f .btn-primary,.modal-f .btn-danger,.x', box);
  if (f) setTimeout(() => f.focus(), 20);
}
function drawer(html) {
  openOverlay(`<div class="scrim" onclick="closeOverlay()"></div><aside class="drawer" role="dialog" aria-modal="true">${html}</aside>`);
}
function modal(html, cls = '') {
  openOverlay(`<div class="scrim" onclick="closeOverlay()"></div><div class="modal ${cls}" role="dialog" aria-modal="true">${html}</div>`);
}
window.closeOverlay = closeOverlay;
// Clavier : Échap ferme, Tab reste piégé dans la boîte ouverte.
document.addEventListener('keydown', e => {
  const box = $('#overlay [role="dialog"]'); if (!box) return;
  if (e.key === 'Escape') { e.preventDefault(); closeOverlay(); return; }
  if (e.key === 'Tab') {
    const f = $$('button:not([disabled]),a[href],input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])', box).filter(x => x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

/* Dialogues in-app (remplacent les boîtes de dialogue natives du navigateur) — Promesses.
 *   ui.confirm({ title, message, facts:[[k,v]], confirmLabel, tone:'danger'|'warn'|'brand'|'locked' }) → true/false
 *   ui.prompt({ …, label, placeholder, required }) → texte saisi (trim) ou null si annulé */
const ui = {
  _dialog(o, withInput) {
    return new Promise(resolve => {
      let done = false;
      const finish = v => { if (done) return; done = true; _overlayOnClose = null; closeOverlay(); resolve(v); };
      const tone = o.tone || 'brand';
      const icon = o.icon || ({ danger: 'warn', warn: 'warn', locked: 'lock', brand: 'info' }[tone]);
      const tcls = { danger: 'tone-late', warn: 'tone-warn', locked: 'tone-locked', brand: 'tone-brand' }[tone];
      const facts = (o.facts || []).length ? `<div class="dlg-facts">${o.facts.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>` : '';
      const field = withInput ? `<div class="fld mt-16"><label class="fld-lbl" for="dlgIn">${esc(o.label || 'Motif')}${o.required ? ' <span class="c-late">*</span>' : ''}</label>
        <textarea class="input-fld" id="dlgIn" rows="3" placeholder="${esc(o.placeholder || '')}"></textarea><span class="fld-err hidden" id="dlgErr"></span></div>` : '';
      const okCls = tone === 'danger' ? 'btn-danger' : 'btn-primary';
      modal(`<div class="modal-b" style="padding-top:22px">
          <div class="dlg-ic ${tcls}">${svgI(icon, '')}</div>
          <h3 class="dlg-t" id="dlgT">${esc(o.title || 'Confirmer')}</h3>
          <div class="dlg-m">${o.html || (o.message ? `<p>${esc(o.message)}</p>` : '')}</div>${facts}${field}
        </div>
        <div class="modal-f"><button class="btn btn-ghost" id="dlgNo">${esc(o.cancelLabel || 'Annuler')}</button>
          <button class="btn ${okCls}" id="dlgOk">${esc(o.confirmLabel || 'Confirmer')}</button></div>`, 'modal-sm');
      $('#overlay .modal').setAttribute('aria-labelledby', 'dlgT');
      _overlayOnClose = () => { if (!done) { done = true; resolve(withInput ? null : false); } };
      $('#dlgNo').onclick = () => finish(withInput ? null : false);
      $('#dlgOk').onclick = () => {
        if (!withInput) return finish(true);
        const v = ($('#dlgIn').value || '').trim();
        if (o.required && !v) { const er = $('#dlgErr'); er.textContent = 'Ce champ est obligatoire.'; er.classList.remove('hidden'); $('#dlgIn').setAttribute('aria-invalid', 'true'); $('#dlgIn').focus(); return; }
        finish(v);
      };
      if (!withInput) setTimeout(() => { const b = $('#dlgOk'); if (b) b.focus(); }, 30);
    });
  },
  confirm(o) { return ui._dialog(o, false); },
  prompt(o) { return ui._dialog(o, true); },
};
window.ui = ui;
const XICO = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`;

/* ============================== bootstrap ============================== */
async function boot() {
  try {
    const me = await api('/me');
    state.me = me.user; state.cabinet = me.cabinet; state.workspace = me.workspace || null; state.perms = me.permissions || {};
  } catch { return; }
  applyWorkspace();
  // header/user — rôle EFFECTIF (serveur) ; la fonction n'est affichée que si elle n'est pas un simple libellé de rôle
  $('#sideName').textContent = state.me.nom; $('#sideTitle').textContent = state.me.roleLabel || state.me.role;
  try { const why = sessionStorage.getItem('dp-session-changed'); if (why) { sessionStorage.removeItem('dp-session-changed'); setTimeout(() => toast(why === 'user' ? `Session mise à jour : vous êtes connecté·e en tant que ${state.me.nom}.` : `Votre rôle a changé : ${state.me.roleLabel}.`, 'info', 'Session actualisée'), 300); } } catch (_) {}
  $('#sideAv').textContent = state.me.initiales; $('#topAv').textContent = state.me.initiales;
  $('#umName').textContent = state.me.nom || '—'; $('#umMail').textContent = `${state.me.email || ''} · ${state.me.roleLabel || state.me.role}`;
  if (state.me.role === 'lecture') { const b = document.createElement('span'); b.className = 'pill pill-sm pill-locked ro-pill'; b.innerHTML = svgI('lock', '') + 'Lecture seule'; b.title = 'Votre accès permet la consultation et les exports, sans modification.'; $('.top-right').prepend(b); }
  // thème : préférence mémorisée, sinon celle du système
  applyTheme(getTheme());
  $('#themeBtn').onclick = () => { const n = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'; applyTheme(n); try { localStorage.setItem('dp-theme', n); } catch (_) {} closeUserMenu(); };
  $('#logoutBtn').onclick = async () => { try { await api('/auth/logout', { method: 'POST' }); } catch (_) {} window.location.href = '/login?reason=logout'; };
  wireUserMenu(); wireMobileNav();
  PERM_OBSERVER.observe(document.body, { childList: true, subtree: true });
  // nav
  $$('[data-view]').forEach(b => b.addEventListener('click', e => { e.preventDefault(); closeUserMenu(); setView(b.dataset.view); }));
  // clients
  state.clients = await api('/clients');
  state.clientId = localStorage.getItem('dp-client') || (state.clients[0] && state.clients[0].id) || null;
  if (state.clients.length && !state.clients.find(c => c.id === state.clientId)) state.clientId = state.clients[0].id;
  wireSwitcher(); wireGlobalSearch(); updateSwitcherLabel();
  await loadPeriods(); wirePeriodSelector();
  refreshAlertsBadge();
  let first = location.hash.replace('#', '') || 'dash';
  if (first === 'dash' && can('onboarding')) {
    try { const ob = await api('/onboarding'); state.onboarding = ob; if (!ob.complete && !ob.dismissed && ob.facts.clients === 0) first = 'onboarding'; } catch (_) {}
  }
  setView(first, { replace: true });
}

// nav : vue mise en surbrillance dans la barre latérale (les vues filles pointent vers leur parent).
const VIEWS = {
  dash: { crumb: "Vue d'ensemble", fn: renderDash },
  clients: { crumb: 'Clients', fn: renderClients },
  client: { crumb: 'Synthèse du dossier', fn: renderClientOverview },
  import: { crumb: 'Imports', fn: renderImport },
  delais: { crumb: 'Délais de paiement', fn: renderDelais },
  conv: { crumb: 'Conventions', fn: renderConv },
  fournisseurs: { crumb: 'Fournisseurs', fn: renderFournisseurs },
  reseau: { crumb: 'Opérateurs de réseau', fn: renderReseau },
  decl: { crumb: 'Déclaration DGI', fn: renderDecl },
  visa: { crumb: 'Visa', fn: renderVisa },
  exports: { crumb: 'Exports', fn: renderExports },
  onboarding: { crumb: 'Configuration de l’espace', fn: renderOnboarding, nav: 'dash' },
  alerts: { crumb: 'Alertes', fn: renderAlerts },
  retards: { crumb: 'Factures en retard', fn: renderRetards },
  convmiss: { crumb: 'Conventions manquantes', fn: renderConvMiss, nav: 'dash' },
  cabconv: { crumb: 'Conventions du portefeuille', fn: renderCabConv, nav: 'dash' },
  anomalies: { crumb: 'Anomalies', fn: renderAnomalies },
  settings: { crumb: 'Paramètres', fn: () => renderSettings('workspace') },
  taux: { crumb: 'Paramètres · Taux BAM', fn: () => renderSettings('taux'), nav: 'settings' },
  audit: { crumb: "Journal d'audit", fn: renderAudit },
};
let _renderSeq = 0;
async function renderView(name) {
  if (!VIEWS[name]) name = 'dash';
  state.view = name;
  const navKey = VIEWS[name].nav || name;
  $$('.nav-item[data-view]').forEach(b => b.setAttribute('aria-current', b.dataset.view === navKey ? 'page' : 'false'));
  const c = currentClient();
  $('#crumbView').textContent = (SCOPED.includes(name) && c) ? `${c.name} · ${VIEWS[name].crumb}` : VIEWS[name].crumb;
  document.title = `${VIEWS[name].crumb} — ${(state.workspace && state.workspace.displayName) || 'DelaiPay'}`;
  updateSwitcherLabel(); closeMobileNav();
  const seq = ++_renderSeq;
  $('#view').innerHTML = skeleton();
  try {
    await VIEWS[name].fn();
    if (seq === _renderSeq) { const v = $('#view'); v.classList.remove('view-enter'); void v.offsetWidth; v.classList.add('view-enter'); }
    $$('#view .kpi[data-goto], #view [data-goto]').forEach(el => { if (!el.onclick) el.onclick = () => setView(el.dataset.goto); });
    applyPerms();
  } catch (e) {
    if (e && e.code === 'client_introuvable' && seq === _renderSeq) return clientGone();
    if (seq === _renderSeq) {
      $('#view').innerHTML = `<div class="card"><div class="empty err"><div class="ic">${svgI('warn', '')}</div><h4>Impossible d'afficher cette page</h4><p>${esc(e.message)}</p>
        <div class="actions"><button class="btn btn-ghost" id="retryView">${svgI('refresh')}Réessayer</button><button class="btn btn-quiet" onclick="setView('dash')">Vue d'ensemble</button></div></div></div>`;
      const r = $('#retryView'); if (r) r.onclick = () => renderView(name);
    }
  }
  updatePeriodLabel(); updateCtxBanner(); refreshAlertsBadge();
}
// Squelette de chargement (pas de spinner plein écran).
function skeleton() {
  const b = (w, h) => `<div class="skel" style="width:${w};height:${h}px"></div>`;
  return `<div class="skel-page" aria-busy="true" aria-label="Chargement">${b('220px', 12)}${b('340px', 26)}
    <div class="skel-row">${b('100%', 86)}${b('100%', 86)}${b('100%', 86)}${b('100%', 86)}</div>${b('100%', 260)}</div>`;
}

/* ============================== autorisations (reflet de la matrice serveur) ==============================
 * L'interface MASQUE ce qui n'est pas permis ; le serveur, lui, REFUSE (403). Masquer n'est jamais autoriser. */
function can(action) { return !!(state.perms && state.perms[action]); }
function applyPerms(root = document) {
  $$('[data-perm]', root).forEach(el => { if (!can(el.dataset.perm)) el.remove(); });
}
const PERM_OBSERVER = new MutationObserver(muts => { for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) { if (n.matches && n.matches('[data-perm]')) applyPerms(n.parentNode || document); else applyPerms(n); } });

/* ============================== espace de travail, thème, menus ============================== */
function getTheme() {
  let t = null; try { t = localStorage.getItem('dp-theme'); } catch (_) {}
  if (!t && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) t = 'dark';
  return t || 'light';
}
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  const l = $('#themeLbl'); if (l) l.textContent = t === 'dark' ? 'Thème clair' : 'Thème sombre';
}
// Identité de l'espace (tenant) : nom affiché, monogramme, couleur primaire du cabinet.
// La couleur du cabinet ne sert QU'À son identité (monogramme) — jamais aux codes métier.
function applyWorkspace() {
  const w = state.workspace || {}, cab = state.cabinet || {};
  const name = w.displayName || cab.nom || 'Espace de travail';
  $('#cabName').textContent = name;
  $('#wsName').textContent = name;
  $('#wsSub').textContent = w.raisonLegale || 'Espace de travail';
  setMono($('#wsMono'), w); setMono($('#umMono'), w);
  $('#umWs').textContent = name;
  // Variantes accessibles calculées par le serveur (src/brand-color.js) : la couleur du cabinet ne casse jamais le contraste.
  const p = w.palette, rs = document.documentElement.style;
  if (p) { rs.setProperty('--tenant', p.tenant); rs.setProperty('--tenant-ink', p.tenantInk); rs.setProperty('--tenant-line', p.tenantLine); }
  else ['--tenant', '--tenant-ink', '--tenant-line'].forEach(k => rs.removeProperty(k));
}
// Monogramme ou logo de l'espace (logo servi par l'API, image uniquement — jamais de SVG téléversé).
function setMono(el, w) {
  if (!el) return; w = w || {};
  el.classList.toggle('has-logo', !!w.logoUrl); el.style.background = '';
  if (w.logoUrl) { el.innerHTML = `<img class="ws-logo-img" src="${esc(w.logoUrl)}" alt="">`; }
  else el.textContent = w.initials || 'DP';
}
function closeUserMenu() { const m = $('#userMenu'); if (m) m.classList.add('hidden'); const b = $('#topAv'); if (b) b.setAttribute('aria-expanded', 'false'); }
function wireUserMenu() {
  const b = $('#topAv'), m = $('#userMenu');
  b.onclick = e => { e.stopPropagation(); const open = m.classList.contains('hidden'); closeSwitcher(); closePeriodPanel(); m.classList.toggle('hidden', !open); b.setAttribute('aria-expanded', String(open)); };
  m.onclick = e => e.stopPropagation();
  document.addEventListener('click', closeUserMenu);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeUserMenu(); closeSwitcher(); closePeriodPanel(); closeMobileNav(); } });
}
function closeMobileNav() {
  const a = $('#app'); if (!a || !a.classList.contains('nav-open')) return;
  a.classList.remove('nav-open'); const s = $('.nav-scrim'); if (s) s.remove(); $('#menuBtn').setAttribute('aria-expanded', 'false');
}
function wireMobileNav() {
  $('#menuBtn').onclick = e => {
    e.stopPropagation(); const a = $('#app');
    if (a.classList.contains('nav-open')) return closeMobileNav();
    a.classList.add('nav-open'); $('#menuBtn').setAttribute('aria-expanded', 'true');
    const sc = document.createElement('div'); sc.className = 'nav-scrim'; sc.onclick = closeMobileNav; a.appendChild(sc);
  };
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
// Dossier sélectionné qui n'existe plus (supprimé par un collègue, base réinitialisée) : on oublie la sélection.
function forgetClient() {
  const gone = state.clientId; state.clientId = null; state.period = null; state._goneClient = gone || state._goneClient;
  state.clients = state.clients.filter(c => c.id !== gone);
  try { localStorage.removeItem('dp-client'); } catch (_) {}
  invalidateCache(); updateSwitcherLabel();
}
async function clientGone() {
  const c = state.clients.find(x => x.id === state.clientId);
  forgetClient();
  try { state.clients = await api('/clients', { fresh: true }); } catch (_) {}
  toast(`${c ? `Le dossier « ${c.name} »` : 'Ce dossier'} n’existe plus : il a peut-être été supprimé par un collègue. Choisissez un autre client.`, 'warn', 'Dossier indisponible');
  setView('clients', { replace: true });
}
const SCOPED = ['delais', 'conv', 'decl', 'visa', 'import', 'client', 'exports', 'fournisseurs', 'reseau'];

// La période est désormais GLOBALE (bandeau) — ces fonctions sont conservées pour compat mais neutres.
function clientPeriodBar() { return ''; }
function wireClientBar() { /* la période est pilotée globalement (voir sélecteur de période) */ }

/* ---------- switcher client global (bandeau) ---------- */
function updateSwitcherLabel() {
  const c = currentClient(); const el = $('#cswName'); if (el) el.textContent = c ? c.name : 'Sélectionner un client';
  const sc = $('#navScope'); if (sc) { sc.textContent = c ? c.name : 'aucun client'; sc.title = c ? c.name : ''; }
}
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
function openSwitcher() { closePeriodPanel(); closeUserMenu(); $('#cswPanel').classList.remove('hidden'); $('#clientSwBtn').setAttribute('aria-expanded', 'true'); buildSwitcherList(''); const s = $('#cswSearch'); if (s) { s.value = ''; setTimeout(() => s.focus(), 30); } }
function closeSwitcher() { const p = $('#cswPanel'); if (p) p.classList.add('hidden'); const b = $('#clientSwBtn'); if (b) b.setAttribute('aria-expanded', 'false'); }
function wireSwitcher() {
  $('#clientSwBtn').onclick = e => { e.stopPropagation(); $('#cswPanel').classList.contains('hidden') ? openSwitcher() : closeSwitcher(); };
  $('#cswSearch').oninput = debounce(e => buildSwitcherList(e.target.value), 120);
  $('#cswPanel').onclick = e => e.stopPropagation();
  document.addEventListener('click', closeSwitcher);
}
async function setClient(id) {
  state.clientId = id; localStorage.setItem('dp-client', id); closeSwitcher(); updateSwitcherLabel();
  await loadPeriods();                    // recharge les périodes disponibles du nouveau client
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
  inp.oninput = debounce(run, 120);
  inp.onfocus = () => { if (inp.value.trim()) run(); };
  inp.onblur = () => setTimeout(() => box.classList.add('hidden'), 180);
}
/* ============================== PÉRIODE GLOBALE (contexte de travail) ============================== */
const TRI_LABEL = t => `T${t}`;
const PERIOD_STATUT = {
  a_venir: ['À venir', 'st-gray'], ouverte: ['Ouverte', 'st-blue'], en_preparation: ['En préparation', 'st-blue'],
  a_controler: ['À contrôler', 'st-orange'], prete: ['Prête', 'st-green'], validee: ['Validée', 'st-green'],
  declaree: ['Déclarée', 'st-green'], cloturee: ['Clôturée', 'st-gray'], rouverte: ['Rouverte', 'st-orange'],
};
function periodStatutOf(a, t) {
  const p = (state.periods || []).find(x => x.annee === a && x.trimestre === t);
  return p ? p.statut : null;
}
function currentPeriodLocked() {
  const st = state.period && periodStatutOf(state.period.annee, state.period.trimestre);
  return st === 'cloturee' || st === 'declaree';
}
// Charge les périodes disponibles du client courant + fixe la période globale (persistée sinon période de travail).
async function loadPeriods(opts = {}) {
  if (!state.clientId) { state.periods = []; state.periodMeta = null; return; }
  let data;
  try { data = await api(`/clients/${state.clientId}/periods`, opts.fresh ? { fresh: true } : {}); }
  catch (e) { if (e.code === 'client_introuvable') { forgetClient(); state.periods = []; state.periodMeta = null; return; } throw e; }
  state.periods = data.disponibles || data.periods || [];
  state.periodMeta = { travail: data.travail, plusFournie: data.plusFournie };
  // priorité : période mémorisée (si dispo) → sinon période de travail → sinon plus fournie → sinon latest
  const saved = (() => { try { return JSON.parse(localStorage.getItem('dp-period') || 'null'); } catch { return null; } })();
  const has = p => p && state.periods.some(x => x.annee === p.annee && x.trimestre === p.trimestre);
  state.period = has(saved) ? { annee: saved.annee, trimestre: saved.trimestre }
    : (data.travail || data.plusFournie || data.latest || { annee: new Date().getFullYear(), trimestre: Math.floor(new Date().getMonth() / 3) + 1 });
  updatePeriodLabel(); updateCtxBanner();
}
function setPeriod(annee, trimestre, opts = {}) {
  state.period = { annee: +annee, trimestre: +trimestre };
  localStorage.setItem('dp-period', JSON.stringify(state.period));
  closePeriodPanel(); updatePeriodLabel(); updateCtxBanner();
  if (!opts.silent) renderView(state.view);   // rafraîchit la vue courante
}
function updatePeriodLabel() {
  const el = $('#periodLabel'); if (!el || !state.period) return;
  el.textContent = `${TRI_LABEL(state.period.trimestre)} ${state.period.annee}`;
  const st = periodStatutOf(state.period.annee, state.period.trimestre);
  const badge = $('#periodBadge');
  if (badge) { const m = PERIOD_STATUT[st] || ['', '']; const lk = st === 'cloturee' || st === 'declaree'; badge.innerHTML = m[0] ? (lk ? svgI('lock', '') : '') + esc(m[0]) : ''; badge.className = 'period-badge ' + (m[1] || ''); }
}
function updateCtxBanner() {
  const b = $('#ctxBanner'); if (!b) return;
  const c = currentClient();
  if (!c || !state.period || !SCOPED.includes(state.view)) { b.classList.add('hidden'); return; }
  const st = periodStatutOf(state.period.annee, state.period.trimestre);
  const meta = PERIOD_STATUT[st] || ['', 'st-blue'];
  const locked = currentPeriodLocked();
  b.className = 'ctx-banner' + (locked ? ' locked' : '');
  b.innerHTML = `<span class="ctx-client">${svgI('building')}${esc(c.name)}</span><span class="ctx-sep"></span>
    <span class="ctx-per">${svgI('cal')}Période <b>${TRI_LABEL(state.period.trimestre)} ${state.period.annee}</b>
    ${st ? `<span class="period-badge ${meta[1] || ''}">${locked ? svgI('lock', '') : ''}${esc((PERIOD_STATUT[st] || [''])[0])}</span>` : ''}</span>
    ${locked ? `<span class="ctx-lock">${svgI('lock')}Lecture seule — les montants de cette période sont figés</span>` : ''}`;
  b.classList.remove('hidden');
}
/* ---------- panneau du sélecteur de période ---------- */
function openPeriodPanel() {
  const panel = $('#periodPanel'); if (!panel) return;
  closeSwitcher(); closeUserMenu();
  buildPeriodList(); panel.classList.remove('hidden'); $('#periodBtn').setAttribute('aria-expanded', 'true');
}
function closePeriodPanel() { const p = $('#periodPanel'); if (p) p.classList.add('hidden'); const b = $('#periodBtn'); if (b) b.setAttribute('aria-expanded', 'false'); }
function buildPeriodList() {
  const cur = $('#perCur'); if (cur && state.period) cur.textContent = `${state.period.annee} ${TRI_LABEL(state.period.trimestre)}`;
  const list = $('#perList'); if (!list) return;
  const items = (state.periods || []).slice().sort((a, b) => (b.annee - a.annee) || (b.trimestre - a.trimestre));
  list.innerHTML = items.length ? items.map(p => {
    const m = PERIOD_STATUT[p.statut] || ['', ''];
    const active = state.period && state.period.annee === p.annee && state.period.trimestre === p.trimestre;
    return `<button class="pp-item ${active ? 'active' : ''}" data-a="${p.annee}" data-t="${p.trimestre}">
      <span><b>${p.annee} ${TRI_LABEL(p.trimestre)}</b> <small>${p.nbFactures} fact.</small></span>
      <span class="period-badge ${m[1] || ''}">${m[0]}</span></button>`;
  }).join('') : `<div class="pp-empty">Aucune donnée. Choisissez un trimestre via ← →.</div>`;
  $$('#perList .pp-item').forEach(b => b.onclick = () => setPeriod(+b.dataset.a, +b.dataset.t));
  buildPeriodActions();
}
// Statut clair de la période active + action de clôture / réouverture (admin uniquement).
function buildPeriodActions() {
  const box = $('#perActions'); if (!box || !state.period) return;
  const st = periodStatutOf(state.period.annee, state.period.trimestre);
  const locked = st === 'cloturee' || st === 'declaree';
  const m = PERIOD_STATUT[st] || ['Ouverte', 'st-blue'];
  const isAdmin = state.me && state.me.role === 'admin';
  const per = `${TRI_LABEL(state.period.trimestre)} ${state.period.annee}`;
  box.className = 'pp-actions' + (locked ? ' locked' : '');
  box.innerHTML = `
    <div class="pp-status ${locked ? 'locked' : ''}">
      <span class="pp-line">${svgI(locked ? 'lock' : 'cal', '')}<span>Période <b>${per}</b></span><span class="period-badge ${m[1] || ''}" style="margin-left:auto">${esc(m[0] || (locked ? 'Clôturée' : 'Ouverte'))}</span></span>
      ${locked ? '<small>Lecture seule : montants, déclaration et exports figés. Création, modification et import refusés.</small>' : '<small>Modifiable : saisie, import et recalcul autorisés.</small>'}
      <small id="perHist"></small>
    </div>
    ${isAdmin
      ? (locked
          ? `<button class="btn btn-ghost btn-sm" id="perReopen">${svgI('unlock')}Rouvrir la période…</button>`
          : `<button class="btn btn-ghost btn-sm" id="perClose">${svgI('lock')}Clôturer ${per}…</button>`)
      : `<small class="pp-note">${locked ? 'Réouverture' : 'Clôture'} réservée à un administrateur.</small>`}`;
  const cb = $('#perClose'); if (cb) cb.onclick = closePeriodAction;
  const rb = $('#perReopen'); if (rb) rb.onclick = reopenPeriodAction;
  // Dernière action tracée (qui / quand) — lecture seule depuis le journal d'audit.
  if (state.clientId && st) periodDetail().then(d => {
    const h = $('#perHist'); const last = d && d.historique && d.historique[0]; if (!h || !last) return;
    h.textContent = `${last.action === 'cloture' ? 'Clôturée' : 'Rouverte'} le ${dateTimeFr(last.date)}${last.par ? ' par ' + last.par : ''}.`;
  }).catch(() => {});
}
// Détail + historique d'une période (endpoint existant, lecture seule).
function periodDetail(p = state.period) {
  return api(`/clients/${state.clientId}/periods/${p.annee}/${p.trimestre}/summary`, { fresh: true });
}
function dateTimeFr(s) { if (!s) return '—'; const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]} à ${m[4]}:${m[5]}` : dateFr(s); }
// VISA-1 : vérifications en attente lues avant la clôture ; la case d'accusé vit dans le dialogue (retiré à sa
// fermeture), son état est donc mémorisé à chaque changement.
async function closeVerifPrep() {
  let vf = { total: 0 }; try { vf = await api(`/clients/${state.clientId}/verifications${perQuery()}`, { fresh: true }); } catch (_) {}
  window._lastAckVerif = false;
  const onAck = ev => { if (ev.target && ev.target.id === 'ackVerif') window._lastAckVerif = ev.target.checked; };
  document.addEventListener('change', onAck);
  return { vf, onAck };
}
async function closePeriodAction() {
  const p = state.period; if (!p) return;
  closePeriodPanel();
  let d = null; try { d = await periodDetail(p); } catch (_) {}
  const k = (d && d.kpis) || {};
  const { vf, onAck } = await closeVerifPrep();
  const ok = await ui.confirm({
    tone: 'locked', icon: 'lock', title: `Clôturer ${TRI_LABEL(p.trimestre)} ${p.annee} — ${currentClient() ? currentClient().name : ''}`,
    html: `<p>La clôture <b>fige définitivement</b> la déclaration, les montants, les pénalités et tous les exports de cette période.</p>
      <p>La période passe en <b>lecture seule</b> : aucune saisie, modification ni import. Une réouverture ultérieure exigera un administrateur et un motif, inscrits au journal d'audit.</p>
      ${vf.total ? `<div class="note note-warn mt-12">${svgI('warn')}<div><div class="note-t">Vérifications en attente — ${vf.total}</div>${verifList(vf)}
        <label class="check mt-8"><input type="checkbox" id="ackVerif"> Je clôture en connaissance de ces points en attente (consigné au journal d’audit).</label></div></div>` : ''}`,
    facts: d ? [['Factures', String(k.factures ?? '—')], ['En retard (à déclarer)', String(k.aDeclarer ?? '—')], ['Montant TTC concerné', money(k.ttcRetard) + ' DH'], ['Amende du trimestre', money(k.amende) + ' DH']] : [],
    confirmLabel: `Clôturer ${TRI_LABEL(p.trimestre)} ${p.annee}`,
  });
  document.removeEventListener('change', onAck);
  state._ackVerif = !!window._lastAckVerif;
  if (!ok) return;
  if (vf.total && !state._ackVerif) { toast('Cochez la case confirmant que vous clôturez en connaissance des vérifications en attente.', 'warn', 'Clôture non effectuée'); return; }
  try {
    await api(`/clients/${state.clientId}/periods/${p.annee}/${p.trimestre}/close${perQuery()}`, { method: 'POST', body: { ackVerifications: !!state._ackVerif } });
    toast(`Période ${p.annee} ${TRI_LABEL(p.trimestre)} clôturée (lecture seule).`, 'ok', 'Clôture');
    closePeriodPanel(); await loadPeriods(); renderView(state.view);
  } catch (e) { toast(e.message, 'err', 'Clôture impossible'); }
}
async function reopenPeriodAction() {
  const p = state.period; if (!p) return;
  closePeriodPanel();
  const motif = await ui.prompt({
    tone: 'warn', icon: 'unlock', title: `Rouvrir ${TRI_LABEL(p.trimestre)} ${p.annee} — action administrative`,
    html: `<p>La réouverture <b>dégèle</b> la période : les montants pourront de nouveau être recalculés et les exports ne seront plus figés.</p><p>Le motif est <b>obligatoire</b> et sera inscrit au journal d'audit avec votre nom et la date.</p>`,
    label: 'Motif de réouverture', placeholder: 'Ex. : régularisation d\'une convention signée reçue après clôture', required: true, confirmLabel: 'Rouvrir la période',
  });
  if (motif == null) return;                       // annulé
  if (!motif.trim()) { toast('Motif de réouverture obligatoire.', 'err', 'Réouverture'); return; }
  try {
    await api(`/clients/${state.clientId}/periods/${p.annee}/${p.trimestre}/reopen${perQuery()}`, { method: 'POST', body: { motif: motif.trim() } });
    toast(`Période ${p.annee} ${TRI_LABEL(p.trimestre)} rouverte (motif enregistré).`, 'ok', 'Réouverture');
    closePeriodPanel(); await loadPeriods(); renderView(state.view);
  } catch (e) { toast(e.message, 'err', 'Réouverture impossible'); }
}
function wirePeriodSelector() {
  const btn = $('#periodBtn'); if (!btn) return;
  btn.onclick = e => { e.stopPropagation(); $('#periodPanel').classList.contains('hidden') ? openPeriodPanel() : closePeriodPanel(); };
  $('#periodPanel').onclick = e => e.stopPropagation();
  document.addEventListener('click', closePeriodPanel);
  $('#perPrev').onclick = () => { const p = state.period; const np = p.trimestre === 1 ? { annee: p.annee - 1, trimestre: 4 } : { annee: p.annee, trimestre: p.trimestre - 1 }; setPeriod(np.annee, np.trimestre); };
  $('#perNext').onclick = () => { const p = state.period; const np = p.trimestre === 4 ? { annee: p.annee + 1, trimestre: 1 } : { annee: p.annee, trimestre: p.trimestre + 1 }; setPeriod(np.annee, np.trimestre); };
  $('#perWork').onclick = () => { const w = (state.periodMeta || {}).travail; if (w) setPeriod(w.annee, w.trimestre); };
  $('#perData').onclick = () => { const d = (state.periodMeta || {}).plusFournie; if (d) setPeriod(d.annee, d.trimestre); };
}
// Relit les périodes disponibles (source unique : /clients/:id/periods) SANS changer la période active.
async function refreshPeriodsKeep() {
  const cur = state.period ? { ...state.period } : null;
  await loadPeriods({ fresh: true });
  if (cur) { state.period = cur; updatePeriodLabel(); updateCtxBanner(); }
}
async function ensurePeriod() { if (!state.periods) await loadPeriods(); return state.periods || []; }
function perQuery() { return state.period ? `?annee=${state.period.annee}&trimestre=${state.period.trimestre}` : ''; }
// Bandeau « lecture seule » à insérer en tête des vues scoped quand la période est clôturée.
function lockBanner() { return currentPeriodLocked() ? `<div class="lock-note">${svgI('lock')}<span>Période <b>${TRI_LABEL(state.period.trimestre)} ${state.period.annee}</b> clôturée : données, déclaration et exports sont figés. Aucune saisie, modification ni import n'est possible.</span></div>` : ''; }

/* ============================== DASHBOARD ============================== */
async function renderDash() {
  await ensurePeriod();
  const [d, audits, ob] = await Promise.all([api('/dashboard' + perQuery()), api('/audit').catch(() => []), api('/onboarding', { fresh: true }).catch(() => null)]);
  state.onboarding = ob;
  const k = d.kpis;
  const cal = d.calendrier || {};
  const per = `${TRI_LABEL(d.periode.trimestre)} ${d.periode.annee}`;
  const ws = (state.workspace && state.workspace.displayName) || (state.cabinet && state.cabinet.nom) || '';
  const evo = d.evolution || [];
  const max = Math.max(1, ...evo.map(e => e.v));
  const pts = evo.map((e, i) => ({ x: 60 + (630 * (evo.length <= 1 ? 0.5 : i / (evo.length - 1))), y: 200 - (150 * e.v / max), m: e.ym.slice(5) + '/' + e.ym.slice(2, 4), v: e.v }));
  const line = pts.map(p => `${p.x.toFixed(0)},${p.y.toFixed(0)}`).join(' ');
  const area = pts.length ? `M46,200 ${pts.map(p => `L${p.x.toFixed(0)},${p.y.toFixed(0)}`).join(' ')} L710,200 Z` : '';
  const heatColor = (a) => a <= 0 ? 'var(--ok)' : a < 200 ? 'var(--watch)' : a < 1000 ? 'var(--warn)' : a < 4000 ? 'var(--late)' : 'var(--severe)';

  const seg = d.segmentation || { ok: 0, app: 0, orange: 0, red: 0, dred: 0 };
  const segDefs = [['ok', 'Dans les délais', 'ok'], ['app', 'Approche', 'watch'], ['orange', 'Attention', 'warn'], ['red', 'Retard', 'late'], ['dred', 'Pénalités', 'severe']];
  const segTot = segDefs.reduce((s, [kk]) => s + (seg[kk] || 0), 0);
  const segBar = segTot ? segDefs.map(([kk, lbl, col]) => seg[kk] ? `<i title="${lbl} : ${seg[kk]}" style="width:${(seg[kk] / segTot * 100).toFixed(1)}%;background:var(--${col})"></i>` : '').join('') : '';
  const conf = +k.tauxConformite || 0;
  const confTone = conf >= 90 ? 'ok' : conf >= 70 ? 'warn' : 'late';
  const jours = cal.joursAvantEcheance;
  const joursTone = jours == null ? 'muted' : jours < 0 ? 'late' : jours <= 15 ? 'warn' : 'ok';

  // Dossier actif : statut réel de la période pour le client sélectionné (périodes chargées du client).
  const c = currentClient();
  const cst = c ? periodStatutOf(d.periode.annee, d.periode.trimestre) : null;
  const cMeta = PERIOD_STATUT[cst] || null;
  const cLocked = cst === 'cloturee' || cst === 'declaree';

  // Actions requises — uniquement des compteurs réels > 0 (jamais de chiffre inventé).
  const todo = [];
  if (k.enRetard) todo.push({ tone: 'late', ic: 'clock', t: `${money(k.enRetard, 0)} facture(s) en retard à déclarer`, s: `${money(k.montantConcerne)} DH TTC concernés · ${per}`, n: money(k.montantAVerser) + ' DH', go: 'retards' });
  if (k.conventionsManquantes) todo.push({ tone: 'severe', ic: 'doc', t: `${k.conventionsManquantes} fournisseur(s) sans convention justificative`, s: 'Délai de 120 j appliqué sans convention enregistrée — justificatif requis pour le visa', n: String(k.conventionsManquantes), go: 'convmiss' });
  if (k.anomalies) todo.push({ tone: 'warn', ic: 'warn', t: `${k.anomalies} anomalie(s) de données ouvertes`, s: 'Dates, montants, doublons potentiels détectés à l\'import', n: String(k.anomalies), go: 'anomalies' });
  if (jours != null && jours >= 0 && jours <= 30) todo.push({ tone: jours <= 15 ? 'late' : 'warn', ic: 'cal', t: `Échéance de dépôt ${per} dans ${jours} jour(s)`, s: `Dépôt SIMPL avant le ${dateFr(cal.echeance)}`, n: `J-${jours}`, go: 'decl' });
  if (c && cst && !cLocked && jours != null && jours < 0) todo.push({ tone: 'locked', ic: 'lock', t: `${per} de ${c.name} n'est pas clôturée`, s: `Échéance de dépôt dépassée (${dateFr(cal.echeance)}) — clôturer après dépôt pour figer la déclaration`, n: esc((cMeta || [''])[0]), go: 'client' });

  const ACT = { login: 'Connexion', import: 'Import de factures', import_confirme: 'Import confirmé', import_analyse: 'Fichier analysé', annulation_import: 'Import annulé',
    create: 'Création', update: 'Modification', delete: 'Suppression', cloture_periode: 'Période clôturée', reouverture_periode: 'Période rouverte', recalcul: 'Recalcul',
    revue_doublon: 'Revue de doublon', classification_fournisseur: 'Classification réseau', import_conventions: 'Import de conventions', export: 'Export' };
  const acts = (audits || []).filter(a => a.action !== 'login').slice(0, 6);

  $('#view').innerHTML = `
  <div class="page-head headrow">
    <div><div class="eyebrow">${esc(ws)} · Vue d'ensemble du cabinet</div>
      <h1>Trimestre ${per}</h1>
      <p>Du ${dateFr(cal.date_debut)} au ${dateFr(cal.date_fin)} · traitement en <span style="text-transform:capitalize">${esc(cal.mois_traitement || '—')}</span> ${esc(cal.annee_traitement || '')} · échéance SIMPL le <b>${dateFr(cal.echeance)}</b>
        ${jours != null ? `<span class="pill pill-sm ${joursTone === 'ok' ? 'pill-ok' : joursTone === 'warn' ? 'pill-warn' : 'pill-late'}" style="margin-left:6px">${jours < 0 ? `échue depuis ${-jours} j` : `J-${jours}`}</span>` : ''}</p></div>
    <div class="actions"><button class="btn btn-ghost" data-goto="clients">${svgI('building')}Clients</button><button class="btn btn-primary" data-goto="retards">${svgI('table')}Factures en retard</button></div>
  </div>

  ${onboardingBanner(ob)}
  <div class="hero">
    <div class="hero-main">
      <div class="lbl">Montant TTC concerné · ${per}</div>
      <div class="big">${money(k.montantConcerne)}<small>DH</small></div>
      <div class="expl">Factures du portefeuille payées hors délai ou impayées, à déclarer à la DGI : <b>${money(k.enRetard, 0)}</b> facture(s).</div>
      <div class="hero-sub"><span class="k">Montant à verser au Trésor</span><span class="v penalty">${money(k.montantAVerser)} <small>DH</small></span></div>
      <div class="hero-foot">
        <span>Taux de conformité <b style="color:var(--${confTone})">${String(conf).replace('.', ',')} %</b></span>
        <span>Délai moyen de paiement <b>${money(k.dso, 0)} j</b></span>
        <span>Retard moyen <b>${money(k.retardMoyen, 0)} j</b></span>
      </div>
    </div>
    <div class="metrics">
      <button class="metric" data-goto="clients"><span class="lbl">Clients suivis ${svgI('arrow', 'arrow')}</span><span class="val">${k.clients}</span><span class="sub">${k.assujettis} assujetti(s) (CA HT &gt; 2 MDH)</span></button>
      <div class="metric"><span class="lbl">Factures du trimestre</span><span class="val">${money(k.facturesTrim, 0)}</span><span class="sub">achats analysés · ${money(k.fournisseurs, 0)} fournisseurs</span></div>
      <button class="metric" data-goto="retards"><span class="lbl">En retard ${svgI('arrow', 'arrow')}</span><span class="val" style="color:${k.enRetard ? 'var(--late)' : 'var(--ok)'}">${money(k.enRetard, 0)}</span><span class="sub">à déclarer à la DGI</span></button>
      <button class="metric" data-goto="anomalies"><span class="lbl">Anomalies ouvertes ${svgI('arrow', 'arrow')}</span><span class="val" style="color:${k.anomalies ? 'var(--warn)' : 'var(--ok)'}">${k.anomalies}</span><span class="sub">contrôles d'import à traiter</span></button>
    </div>
  </div>

  <div class="grid-2-3 mt-14">
    <div class="card"><div class="card-h"><div><h3>Actions requises</h3><div class="sub">calculées sur les données réelles du cabinet</div></div>${todo.length ? `<span class="pill pill-sm pill-late">${todo.length}</span>` : ''}</div>
      <div class="todo">${todo.length ? todo.map(x => `<button class="todo-item" data-goto="${x.go}"><span class="ti-ic tone-${x.tone}">${svgI(x.ic, '')}</span>
        <span class="ti-body"><b>${esc(x.t)}</b><small>${esc(x.s)}</small></span><span class="ti-n">${x.n}</span>${svgI('chev', 'ti-go')}</button>`).join('')
        : `<div class="todo-empty"><span class="ti-ic tone-ok" style="width:32px;height:32px;border-radius:8px;display:grid;place-items:center">${svgI('check', '')}</span><span>Aucune action en attente pour ${per}.</span></div>`}</div>
    </div>
    <div class="card"><div class="card-h"><div><h3>Dossier actif</h3><div class="sub">client sélectionné dans la barre supérieure</div></div></div>
      <div class="card-b">${c ? `
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px"><div class="hub-id" style="width:40px;height:40px;font-size:var(--fs-md)">${esc(initialsOf(c.name))}</div>
          <div style="min-width:0"><b style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(c.name)}</b><small class="dh mono">${esc(c.ice || c.if || '')}</small></div></div>
        <div class="det-row"><span class="k">Période</span><span class="v">${per}</span></div>
        <div class="det-row"><span class="k">Statut</span><span class="v">${cMeta ? `<span class="period-badge ${cMeta[1]}">${cLocked ? svgI('lock', '') : ''}${esc(cMeta[0])}</span>` : '<span class="dh">aucune donnée sur la période</span>'}</span></div>
        <div class="det-row" style="border-bottom:0"><span class="k">Saisie</span><span class="v">${cLocked ? 'Lecture seule — montants figés' : 'Ouverte à la saisie et à l\'import'}</span></div>
        <div class="actions mt-12"><button class="btn btn-ghost btn-sm" data-goto="client">Ouvrir le dossier</button><button class="btn btn-quiet btn-sm" data-goto="delais">Délais de paiement</button></div>`
        : `<div class="empty" style="padding:20px"><p>Aucun client. Créez un premier dossier dans « Clients ».</p></div>`}</div>
    </div>
  </div>

  <div class="section-title"><h2>Exposition du trimestre</h2><span class="sub">factures ${per} par niveau de risque</span></div>
  <div class="grid-2-3">
    <div class="card"><div class="card-b">
      <div class="meter" style="height:10px">${segBar || '<i style="width:100%;background:var(--surface-3)"></i>'}</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;margin-top:16px">
        ${segDefs.map(([kk, lbl, col]) => `<div style="display:flex;align-items:center;gap:9px"><span style="width:10px;height:10px;border-radius:3px;background:var(--${col})"></span><div><b class="mono">${seg[kk] || 0}</b> <span class="dh t-sm">${lbl}</span></div></div>`).join('')}
      </div>
      <div class="hint mt-16">${svgI('info')}<span>Taux de conformité = factures payées du trimestre réglées dans le délai applicable (légal, conventionnel ou réseau).</span></div>
    </div></div>
    <div class="card"><div class="card-h"><div><h3>Échéances déclaratives</h3><div class="sub">dépôts SIMPL à venir</div></div></div>
      <div class="card-b py-4">${(d.deadlines || []).map(x => `<div class="dl"><div class="cal"><b>${x.day}</b><small>${esc(x.mon)}</small></div><div><b>${esc(x.label)}</b><div class="dh t-sm">${esc(x.sub)}</div></div><div class="cd" style="color:${x.days <= 15 ? 'var(--late)' : 'var(--muted)'}">${esc(x.cd)}</div></div>`).join('')}</div>
    </div>
  </div>

  <div class="section-title"><h2>Tendance et concentration</h2><span class="sub">historique complet du cabinet — toutes périodes confondues</span></div>
  <div class="grid-2-3 mb-14">
    <div class="card"><div class="card-h"><div><h3>Amendes par mois de paiement</h3><div class="sub">DH · factures à déclarer, toutes périodes</div></div></div>
      <div class="card-b chart">${pts.length > 1 ? `<svg viewBox="0 0 720 240" preserveAspectRatio="none" role="img" aria-label="Évolution des amendes par mois">
        <line class="axis" x1="46" y1="200" x2="710" y2="200"/><line class="gl" x1="46" y1="150" x2="710" y2="150"/><line class="gl" x1="46" y1="100" x2="710" y2="100"/><line class="gl" x1="46" y1="50" x2="710" y2="50"/>
        <text class="axtx" x="40" y="54" text-anchor="end">${money(max, 0)}</text><text class="axtx" x="40" y="204" text-anchor="end">0</text>
        <path d="${area}" fill="var(--brand-500)" fill-opacity="0.08"/><polyline points="${line}" fill="none" stroke="var(--brand-500)" stroke-width="2" stroke-linejoin="round"/>
        ${pts.map(p => `<circle cx="${p.x.toFixed(0)}" cy="${p.y.toFixed(0)}" r="3.5" fill="var(--surface)" stroke="var(--brand-500)" stroke-width="2"><title>${esc(p.m)} : ${money(p.v)} DH</title></circle><text class="axtx" x="${p.x.toFixed(0)}" y="222" text-anchor="middle">${esc(p.m)}</text>`).join('')}
      </svg>` : `<div class="empty" style="padding:36px 10px"><p>Pas assez de mois de paiement pour tracer une tendance.</p></div>`}</div>
    </div>
    <div class="card"><div class="card-h"><div><h3>Fournisseurs à surveiller</h3><div class="sub">amende cumulée, toutes périodes</div></div></div>
      <div class="card-b py-4">${(d.topFournisseurs || []).filter(t => t.amende > 0).map(t => `<div class="list-row"><div style="flex:1;min-width:0"><b style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.name)}</b><small class="dh mono">${t.nb} facture(s) en retard</small></div><b class="mono amount-late">${money(t.amende)}</b></div>`).join('') || '<div class="empty p-24"><p>Aucun fournisseur en retard.</p></div>'}</div>
    </div>
  </div>
  <div class="grid-2-3">
    <div class="card"><div class="card-h"><div><h3>Carte de chaleur</h3><div class="sub">clients les plus exposés × 6 mois précédant la fin de ${per} — amende (DH)</div></div></div>
      <div class="card-b">
        ${(d.heatmap || []).length ? `<div class="heat"><div class="hr"><div></div>${(d.heatmapMonths || []).map(m => `<div class="hhead">${esc(m)}</div>`).join('')}</div>
        ${(d.heatmap || []).map(h => `<div class="hr"><div class="hlbl" title="${esc(h.name)}">${esc(h.name)}</div>${h.cells.map(c2 => `<div class="hc" style="background:${heatColor(c2.amende)}" title="${esc(c2.label)} : ${money(c2.amende)} DH">${c2.amende ? money(c2.amende, 0) : ''}</div>`).join('')}</div>`).join('')}</div>
        <div class="legend"><span><i style="background:var(--ok)"></i>Aucune</span><span><i style="background:var(--watch)"></i>&lt; 200</span><span><i style="background:var(--warn)"></i>&lt; 1 000</span><span><i style="background:var(--late)"></i>&lt; 4 000</span><span><i style="background:var(--severe)"></i>≥ 4 000</span></div>`
        : '<div class="empty p-24"><p>Aucun client exposé.</p></div>'}
      </div>
    </div>
    <div class="card"><div class="card-h"><div><h3>Activité récente</h3><div class="sub">journal d'audit du cabinet</div></div><button class="btn btn-quiet btn-sm" data-goto="audit">Tout voir</button></div>
      <div class="card-b py-4">${acts.length ? acts.map(a => `<div class="act"><span class="a-dot" style="background:${/cloture|delete|annulation/.test(a.action) ? 'var(--locked)' : /reouverture/.test(a.action) ? 'var(--warn)' : 'var(--brand-500)'}"></span>
        <div class="a-body"><b>${esc(ACT[a.action] || a.action)}</b>${a.entite ? ` <span class="dh">· ${esc(a.entite)}</span>` : ''}<div class="dh t-xs">${esc(a.user_nom || '—')}</div></div><span class="a-time">${esc(dateTimeFr(a.created_at))}</span></div>`).join('')
        : '<div class="empty p-24"><p>Aucune activité enregistrée.</p></div>'}</div>
    </div>
  </div>`;
}
// Bandeau de reprise de la configuration (espace non terminé) — progression réelle.
function onboardingBanner(ob) {
  // P3-1 : un espace qui a déjà des factures n'est plus « en configuration » (l'onboarding reste accessible).
  // ONB-3 : « Terminer plus tard » ne masque plus la bannière — elle reste jusqu'à la fin de la configuration.
  if (!ob || ob.complete || !can('onboarding') || (!ob.started && !ob.dismissed && ob.facts && ob.facts.factures > 0)) return '';
  const next = ob.steps.find(x => x.status === 'todo' && x.key !== 'bienvenue') || ob.steps[ob.steps.length - 1];
  const ws = (state.workspace && state.workspace.displayName) || '';
  return `<div class="card ob-banner mb-14"><div class="card-b" style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">
    <div class="dlg-ic tone-brand m-0">${svgI('bolt', '')}</div>
    <div style="flex:1;min-width:240px"><h3 style="font-size:var(--fs-lg);margin-bottom:2px">${ob.facts.clients ? 'Terminez la configuration de ' : 'Bienvenue dans l’espace '}${esc(ws)}</h3>
      <div class="dh t-sm">Prochaine étape : <b style="color:var(--ink)">${esc(next.label)}</b> · ${ob.progress} % terminé</div>
      <div class="meter" style="margin-top:8px;max-width:360px"><i style="width:${ob.progress}%;background:var(--brand-500)"></i></div></div>
    <div class="actions"><button class="btn btn-primary" onclick="resumeOnboarding('${esc(next.key)}')">${ob.progress ? 'Reprendre' : 'Commencer'} la configuration</button></div>
  </div></div>`;
}
// NEW-4 : « Reprendre » ouvre l'étape annoncée par la bannière (la prochaine étape incomplète), pas la dernière visitée.
window.resumeOnboarding = function (key) { state._obStep = key || null; setView('onboarding'); };
/* ============================== ONBOARDING (8 étapes, capacités réelles uniquement) ============================== */
const OB_ICON = { bienvenue: 'bolt', cabinet: 'building', client: 'users', factures: 'up', conventions: 'doc', reseau: 'info', periode: 'cal', pret: 'checkc' };
async function renderOnboarding(stepKey) {
  const ob = await api('/onboarding', { fresh: true }); state.onboarding = ob;
  // Périodes relues depuis la source unique (/clients/:id/periods) à chaque affichage : un import récent est vu.
  if (state.clientId) await refreshPeriodsKeep().catch(() => {});
  const editable = can('onboarding');
  const key = stepKey || state._obStep || ob.current || 'bienvenue';
  const idx = Math.max(0, ob.steps.findIndex(x => x.key === key));
  const st = ob.steps[idx];
  state._obStep = st.key;
  if (editable && ob.current !== st.key) api('/onboarding', { method: 'PUT', body: { current: st.key } }).catch(() => {});
  const ws = state.workspace || {};
  const f = ob.facts;
  const go = (k) => `<button class="btn btn-primary" data-ob-next="${k}">Continuer ${svgI('arrow')}</button>`;
  const skip = st.optional && st.status === 'todo' ? `<button class="btn btn-quiet" data-ob-skip="${st.key}">Passer cette étape</button>` : '';
  const nextKey = (ob.steps[idx + 1] || {}).key;
  const doneNote = t => `<div class="note note-ok">${svgI('checkc')}<div>${t}</div></div>`;
  let body = '';
  if (st.key === 'bienvenue') body = `
    <h2 class="ob-title">Bienvenue dans DelaiPay${ws.displayName ? ' — ' + esc(ws.displayName) : ''}</h2>
    <p class="ob-lead">En quelques étapes, votre espace sera prêt à calculer les retards de paiement (loi 69-21), préparer la déclaration trimestrielle et générer le visa.</p>
    <ul class="ob-points"><li>${svgI('lock')}<span>Vos données sont <b>isolées</b> de tout autre cabinet.</span></li><li>${svgI('check')}<span>Rien n'est enregistré sans votre validation : chaque import est contrôlé puis confirmé.</span></li><li>${svgI('history')}<span>Vous pouvez interrompre à tout moment et reprendre plus tard.</span></li></ul>
    <div class="actions">${go(nextKey)}</div>`;
  else if (st.key === 'cabinet') body = `
    <h2 class="ob-title">Configurez votre cabinet</h2>
    <p class="ob-lead">Nom affiché, raison sociale, logo et contact : ils identifient votre espace pour toute l'équipe.</p>
    ${st.status === 'done' ? doneNote('Identité de l’espace renseignée. Vous pouvez l’ajuster à tout moment dans Paramètres.') : ''}
    <div class="form-grid mw-640">
      <div><label class="fld-lbl" for="ob_name">Nom de l'espace</label><input class="input-fld" id="ob_name" value="${esc(ws.nomAffiche || ws.displayName || '')}"></div>
      <div><label class="fld-lbl" for="ob_legal">Raison sociale</label><input class="input-fld" id="ob_legal" value="${esc(ws.raisonLegale || '')}" placeholder="Ex. Cabinet Exemple SARL"></div>
      <div><label class="fld-lbl" for="ob_mail">E-mail de contact</label><input class="input-fld" id="ob_mail" type="email" value="${esc(ws.contactEmail || '')}"></div>
      <div><label class="fld-lbl" for="ob_logo">Logo (optionnel)</label><input class="input-fld" id="ob_logo" type="file" accept="image/png,image/jpeg,image/webp"><span class="fld-help">PNG, JPEG ou WebP, 1 Mo maximum.</span></div>
    </div>
    <div class="actions mt-18"><button class="btn btn-primary" id="ob_save" data-perm="manage_workspace">Enregistrer et continuer ${svgI('arrow')}</button>${st.status === 'done' || !can('manage_workspace') ? go(nextKey).replace('btn-primary', 'btn-ghost') : ''}</div>
    ${can('manage_workspace') ? '' : `<div class="hint mt-12">${svgI('info')}<span>Seul un administrateur peut modifier l'identité de l'espace.</span></div>`}`;
  else if (st.key === 'client') body = `
    <h2 class="ob-title">Créez votre premier dossier client</h2>
    <p class="ob-lead">Un dossier = une entreprise dont vous suivez les délais de paiement fournisseurs. Le chiffre d'affaires détermine l'assujettissement et le type de visa.</p>
    ${f.clients ? doneNote(`${f.clients} dossier(s) client déjà créé(s).`) + `<div class="actions">${go(nextKey)}</div>` : `
    <div class="form-grid mw-640">
      <div class="full"><label class="fld-lbl" for="ob_rs">Raison sociale *</label><input class="input-fld" id="ob_rs" placeholder="Ex. STE ATLAS DISTRIBUTION SARL"></div>
      <div><label class="fld-lbl" for="ob_ice">ICE</label><input class="input-fld mono" id="ob_ice" inputmode="numeric" maxlength="15"></div>
      <div><label class="fld-lbl" for="ob_if">Identifiant fiscal</label><input class="input-fld mono" id="ob_if"></div>
      <div><label class="fld-lbl" for="ob_ville">Ville</label><input class="input-fld" id="ob_ville"></div>
      <div><label class="fld-lbl" for="ob_ca">CA HT (DH)</label><input class="input-fld mono" id="ob_ca" type="number" min="0"></div>
    </div>
    <div class="actions mt-18"><button class="btn btn-primary" id="ob_client">Créer le dossier et continuer ${svgI('arrow')}</button></div>`}`;
  else if (st.key === 'factures') {
    const op = ob.periode;
    body = `
    <h2 class="ob-title">Importez vos factures (journal TVA / achats)</h2>
    <p class="ob-lead">L'assistant analyse votre fichier Excel, CSV ou XML SIMPL, propose la correspondance des colonnes et <b>bloque</b> toute correspondance incohérente avant le moindre enregistrement.</p>
    ${f.factures ? doneNote(`${f.factures} facture(s) importée(s) dans l'espace.`) : ''}
    ${!f.clients ? `<div class="note note-warn">${svgI('warn')}<div>Créez d'abord un dossier client.</div></div>`
      : !op ? `<div class="note note-danger">${svgI('stop')}<div><div class="note-t">Trimestre non choisi</div>Choisissez d'abord le trimestre à traiter : les factures y seront rattachées.</div></div>
        <div class="actions"><button class="btn btn-primary" data-ob-goto="periode">${svgI('cal')}Choisir le trimestre</button></div>`
      : `<div class="note note-info">${svgI('cal')}<div>Les factures seront importées dans <b>${TRI_LABEL(op.trimestre)} ${op.annee}</b>. Des lignes datées d'un autre trimestre exigeront une confirmation explicite.
          <button class="btn-link" data-ob-goto="periode">Changer de trimestre</button></div></div>
        <div class="actions"><button class="btn btn-primary" id="ob_import">${svgI('up')}Importer dans ${TRI_LABEL(op.trimestre)} ${op.annee}</button>${f.factures ? go(nextKey).replace('btn-primary', 'btn-ghost') : ''}</div>`}`;
  }
  else if (st.key === 'conventions') body = `
    <h2 class="ob-title">Ajoutez vos conventions de délai</h2>
    <p class="ob-lead">Sans convention, le délai légal de 60 jours s'applique. Une convention signée (jusqu'à 120 jours) se saisit une à une ou s'importe depuis une liste Excel ; le justificatif est archivé tel quel.</p>
    ${f.conventions ? doneNote(`${f.conventions} convention(s) enregistrée(s).`) : ''}
    <div class="actions"><button class="btn btn-primary" id="ob_conv" ${f.clients ? '' : 'disabled'}>${svgI('doc')}Ouvrir les conventions</button>${f.conventions ? go(nextKey).replace('btn-primary', 'btn-ghost') : ''}${skip}</div>`;
  else if (st.key === 'reseau') body = `
    <h2 class="ob-title">Vérifiez les opérateurs réseau</h2>
    <p class="ob-lead">Télécoms, eau, électricité : DelaiPay repère les fournisseurs probables. <b>Rien n'est appliqué sans votre confirmation</b> (délai de 30 jours et exclusion des tableaux déclaratifs).</p>
    ${!f.factures ? `<div class="note note-info">${svgI('info')}<div>Importez d'abord des factures : la détection s'appuie sur vos fournisseurs réels.</div></div>`
      : f.reseauPropose ? `<div class="note note-warn">${svgI('warn')}<div><b>${f.reseauPropose}</b> fournisseur(s) à examiner — bouton « Réseau ? — confirmer » dans la feuille des délais.</div></div>`
      : doneNote(`Aucun fournisseur en attente de confirmation${f.reseauConfirme ? ` · ${f.reseauConfirme} opérateur(s) confirmé(s)` : ''}.`)}
    <div class="actions"><button class="btn btn-primary" id="ob_reseau" ${f.factures ? '' : 'disabled'}>${svgI('table')}Ouvrir la feuille des délais</button>${st.status !== 'todo' ? go(nextKey).replace('btn-primary', 'btn-ghost') : ''}${skip}</div>`;
  else if (st.key === 'periode') {
    const per = state.periods || [];
    const w = (state.periodMeta && state.periodMeta.travail) || state.period || { annee: new Date().getFullYear(), trimestre: 1 };
    // Trimestre de travail (calendrier déclaratif) et les 3 précédents — calculés, jamais figés en dur.
    const cands = []; let q = { annee: w.annee, trimestre: w.trimestre };
    for (let i = 0; i < 4; i++) { cands.push(q); q = q.trimestre === 1 ? { annee: q.annee - 1, trimestre: 4 } : { annee: q.annee, trimestre: q.trimestre - 1 }; }
    for (const p of per) if (!cands.some(c => c.annee === p.annee && c.trimestre === p.trimestre)) cands.push({ annee: p.annee, trimestre: p.trimestre });
    const chosen = ob.periode || null;
    body = `
    <h2 class="ob-title">Choisissez le trimestre à traiter</h2>
    <p class="ob-lead">Toute l'application travaille sur <b>une période (trimestre) active</b>, toujours affichée en haut de l'écran. Les factures que vous importerez ensuite y seront rattachées.</p>
    ${f.clients ? `<div class="ob-periods">${cands.map(c => { const p = per.find(x => x.annee === c.annee && x.trimestre === c.trimestre); const on = chosen && chosen.annee === c.annee && chosen.trimestre === c.trimestre;
        return `<button class="pp-item ${on ? 'active' : ''}" data-ob-per="${c.annee}-${c.trimestre}"><span><b>${TRI_LABEL(c.trimestre)} ${c.annee}</b> <small>${p ? `${p.nbFactures} facture(s)` : 'aucune facture'}${w.annee === c.annee && w.trimestre === c.trimestre ? ' · trimestre en cours de traitement' : ''}</small></span>${p ? `<span class="period-badge ${(PERIOD_STATUT[p.statut] || ['', ''])[1]}">${esc((PERIOD_STATUT[p.statut] || [p.statut])[0])}</span>` : ''}</button>`; }).join('')}</div>
      ${chosen ? doneNote(`Trimestre retenu : <b>${TRI_LABEL(chosen.trimestre)} ${chosen.annee}</b>.`) + `<div class="actions">${go(nextKey)}</div>` : ''}`
      : `<div class="note note-warn">${svgI('warn')}<div>Créez d'abord un dossier client.</div></div>`}`;
  } else if (st.key === 'pret') {
    const req = ob.steps.filter(x => !x.optional && !['bienvenue', 'pret'].includes(x.key));
    body = `
    <h2 class="ob-title">${ob.readyToFinish ? 'Votre espace est prêt' : 'Presque prêt'}</h2>
    <p class="ob-lead">${ob.readyToFinish ? 'Les étapes indispensables sont terminées. Vous pouvez maintenant contrôler les délais, préparer la déclaration et générer le visa.' : 'Terminez les étapes indispensables ci-dessous pour finaliser la configuration.'}</p>
    <div class="ob-summary">${ob.steps.filter(x => !['bienvenue', 'pret'].includes(x.key)).map(x => `<div class="list-row"><span class="ti-ic tone-${x.status === 'done' ? 'ok' : x.status === 'skipped' ? 'locked' : 'warn'}" style="width:26px;height:26px;border-radius:50%;display:grid;place-items:center">${svgI(x.status === 'done' ? 'check' : x.status === 'skipped' ? 'chev' : 'warn', '')}</span><span style="flex:1">${esc(x.label)}${x.optional ? ' <span class="dh">(optionnelle)</span>' : ''}</span><button class="btn btn-quiet btn-sm" data-ob-goto="${x.key}">${x.status === 'done' ? 'Revoir' : 'Ouvrir'}</button></div>`).join('')}</div>
    <div class="actions mt-18"><button class="btn btn-primary" id="ob_finish" ${ob.readyToFinish ? '' : 'disabled'}>${svgI('check')}Terminer la configuration</button></div>`;
  }
  $('#view').innerHTML = `
  <div class="ob-wrap">
    <aside class="ob-rail" aria-label="Étapes">
      <div class="eyebrow">Configuration de l'espace</div>
      <div class="meter" style="margin:6px 0 14px"><i style="width:${ob.progress}%;background:var(--brand-500)"></i></div>
      <ol class="ob-steps">${ob.steps.map((x, i) => `<li><button class="ob-step ${x.key === st.key ? 'cur' : ''} is-${x.status}" data-ob-goto="${x.key}" ${x.key === st.key ? 'aria-current="step"' : ''}>
        <span class="ob-n">${x.status === 'done' ? svgI('check', '') : x.status === 'skipped' ? '–' : i + 1}</span><span class="ob-l">${esc(x.label)}${x.optional ? '<small>optionnelle</small>' : ''}</span></button></li>`).join('')}</ol>
      <button class="btn btn-quiet btn-sm" id="ob_later" style="margin-top:10px">Terminer plus tard</button>
    </aside>
    <section class="card ob-main"><div class="card-b">
      <div class="ob-ic tone-brand">${svgI(OB_ICON[st.key] || 'info', '')}</div>
      <div class="eyebrow">Étape ${idx + 1} sur ${ob.steps.length}${st.optional ? ' · optionnelle' : ''}</div>
      ${body}
      ${editable ? '' : `<div class="note note-locked mt-16">${svgI('lock')}<div>Votre rôle ne permet pas de modifier la configuration ; vous pouvez consulter la progression.</div></div>`}
    </div></section>
  </div>`;
  const goto = k => renderOnboarding(k);
  $$('[data-ob-goto]').forEach(b => b.onclick = () => goto(b.dataset.obGoto));
  $$('[data-ob-next]').forEach(b => b.onclick = async () => { if (editable && st.key === 'bienvenue') await api('/onboarding', { method: 'PUT', body: { step: 'bienvenue', status: 'done' } }).catch(() => {}); goto(b.dataset.obNext); });
  $$('[data-ob-skip]').forEach(b => b.onclick = async () => { try { await api('/onboarding', { method: 'PUT', body: { step: b.dataset.obSkip, status: 'skipped' } }); goto(nextKey); } catch (e) { toast(e.message, 'err'); } });
  const later = $('#ob_later'); if (later) later.onclick = async () => { if (editable) await api('/onboarding', { method: 'PUT', body: { dismissed: true } }).catch(() => {}); toast('Vous pourrez reprendre la configuration depuis la vue d’ensemble.', 'info', 'Configuration enregistrée'); setView('dash'); };
  const save = $('#ob_save'); if (save) save.onclick = async () => {
    save.disabled = true;
    try {
      const r = await api('/workspace', { method: 'PUT', body: { nomAffiche: $('#ob_name').value, raisonLegale: $('#ob_legal').value, contactEmail: $('#ob_mail').value } });
      state.workspace = { ...state.workspace, ...r.workspace };
      const lf = $('#ob_logo').files[0];
      if (lf) { const fd = new FormData(); fd.append('file', lf); const r2 = await api('/workspace/logo', { method: 'POST', body: fd }); state.workspace = { ...state.workspace, ...r2.workspace }; }
      applyWorkspace(); await api('/onboarding', { method: 'PUT', body: { step: 'cabinet', status: 'done' } }); goto(nextKey);
    } catch (e) { toast(e.message, 'err', 'Configuration non enregistrée'); save.disabled = false; }
  };
  const oc = $('#ob_client'); if (oc) oc.onclick = async () => {
    const rs = $('#ob_rs').value.trim(); if (!rs) { $('#ob_rs').setAttribute('aria-invalid', 'true'); toast('La raison sociale est obligatoire.', 'err'); return; }
    oc.disabled = true;
    try { const r = await api('/clients', { method: 'POST', body: { raison_sociale: rs, ice: $('#ob_ice').value, if_fiscal: $('#ob_if').value, ville: $('#ob_ville').value, ca_ht: $('#ob_ca').value } });
      state.clients = await api('/clients'); state.clientId = r.id; try { localStorage.setItem('dp-client', r.id); } catch (_) {} updateSwitcherLabel(); await loadPeriods(); goto(nextKey); }
    catch (e) { toast(e.message, 'err', 'Dossier non créé'); oc.disabled = false; }
  };
  const oi = $('#ob_import'); if (oi) oi.onclick = () => { const op = ob.periode; if (op) setPeriod(op.annee, op.trimestre, { silent: true }); setView('import'); };
  const ocv = $('#ob_conv'); if (ocv) ocv.onclick = () => setView('conv');
  const orz = $('#ob_reseau'); if (orz) orz.onclick = () => setView('delais');
  $$('[data-ob-per]').forEach(b => b.onclick = async () => {
    const [a, t] = b.dataset.obPer.split('-');
    try { await api('/onboarding', { method: 'PUT', body: { periode: { annee: +a, trimestre: +t } } }); setPeriod(+a, +t, { silent: true }); renderOnboarding('periode'); }
    catch (e) { toast(e.message, 'err'); }
  });
  const fin = $('#ob_finish'); if (fin) fin.onclick = async () => {
    try { await api('/onboarding', { method: 'PUT', body: { complete: true } });
      modal(`<div class="modal-b" style="padding-top:26px;text-align:center"><div class="dlg-ic tone-ok" style="margin:0 auto 14px">${svgI('checkc', '')}</div>
        <h3 class="dlg-t">Configuration terminée</h3><p class="dlg-m">L'espace ${esc(ws.displayName || '')} est prêt. La période active est ${state.period ? TRI_LABEL(state.period.trimestre) + ' ' + state.period.annee : 'sélectionnée en haut de l’écran'}.</p></div>
        <div class="modal-f" style="justify-content:center"><button class="btn btn-primary" id="ob_done">Accéder à la vue d'ensemble</button></div>`, 'modal-sm');
      $('#ob_done').onclick = () => { closeOverlay(); setView('dash'); };
    } catch (e) { toast(e.message, 'err'); }
  };
}
function initialsOf(name) { return (String(name || 'CL').replace(/\b(STE|SARL|SA|SAS|SNC|AU)\b/gi, '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase()) || 'CL'; }

/* ============================== CLIENTS ============================== */
async function renderClients() {
  await ensurePeriod();   // « En retard » / « Amende » du portefeuille reflètent la période ACTIVE
  state.clients = await api('/clients' + perQuery()); updateSwitcherLabel();
  if (state._cq == null) state._cq = ''; if (!state._crisk) state._crisk = 'all';
  const pill = (r, l) => `<button class="fpill" data-r="${r}" aria-pressed="${state._crisk === r}">${l}</button>`;
  if (!state._csort) state._csort = { k: 'name', dir: 1 };
  const th = (k, lbl, cls = '') => `<th class="${cls}" data-sort="${k}" ${state._csort.k === k ? `aria-sort="${state._csort.dir > 0 ? 'ascending' : 'descending'}"` : ''}>${lbl}<span class="sort">${state._csort.k === k ? (state._csort.dir > 0 ? '▲' : '▼') : '↕'}</span></th>`;
  $('#view').innerHTML = `
  <div class="page-head headrow"><div><div class="eyebrow">Cabinet</div><h1>Clients</h1><p id="clCount"></p></div>
    <button class="btn btn-primary" id="newClient" data-perm="create_client">${svgI('plus')}Nouveau client</button></div>
  <div class="toolbar">
    <div class="filters">${pill('all', 'Tous')}${pill('retard', 'Avec retard')}${pill('ok', 'Conformes')}${pill('assuj', 'Assujetties')}</div>
    <div class="search" style="display:block;flex:0 1 320px;margin:0">${svgI('search')}<input id="clSearch" placeholder="Rechercher (nom, ICE, ville)…" value="${esc(state._cq)}" aria-label="Filtrer les clients"></div></div>
  <div class="table-wrap"><table class="dense rc"><thead><tr>
    ${th('name', 'Raison sociale')}<th>ICE</th>${th('ville', 'Ville')}${th('ca', 'CA HT', 'num')}<th data-prio="2">Assujettie</th><th data-prio="3">Régime</th><th data-prio="3">Expert</th>${th('retards', 'En retard', 'num')}${th('amende', 'Amende', 'num')}<th>Risque</th></tr></thead>
    <tbody id="clRows"></tbody></table></div>`;
  const draw = () => {
    const f = (state._cq || '').trim().toLowerCase();
    let rows = state.clients.filter(c => !f || (c.name || '').toLowerCase().includes(f) || (c.ice || '').includes(f) || (c.if || '').includes(f) || (c.ville || '').toLowerCase().includes(f));
    if (state._crisk === 'retard') rows = rows.filter(c => c.retards > 0);
    else if (state._crisk === 'ok') rows = rows.filter(c => c.retards === 0);
    else if (state._crisk === 'assuj') rows = rows.filter(c => c.assujettie);
    const { k: sk, dir } = state._csort;
    rows = rows.slice().sort((a, b) => { const x = a[sk], y = b[sk]; return (typeof x === 'number' || typeof y === 'number') ? ((+x || 0) - (+y || 0)) * dir : String(x || '').localeCompare(String(y || ''), 'fr') * dir; });
    $('#clCount').textContent = `${rows.length} société(s) sur ${state.clients.length} · « En retard » et « Amende » pour la période ${state.period ? state.period.annee + ' ' + TRI_LABEL(state.period.trimestre) : 'active'} · cliquez une ligne pour ouvrir la fiche client.`;
    $('#clRows').innerHTML = rows.length ? rows.map(c => `<tr class="clickable" data-id="${c.id}">
      <td data-rc="t"><b>${esc(c.name)}</b></td><td class="mono dh" data-rc="m" data-label="ICE">${esc(c.ice || '—')}</td><td data-rc="m">${esc(c.ville || '—')}</td>
      <td class="num" data-rc="m" data-label="CA HT">${money(c.ca, 0)}</td><td data-prio="2"><span class="${c.assujettie ? 'tag-yes' : 'tag-no'}">${c.assujettie ? 'Oui' : 'Non'}</span></td>
      <td class="dh" data-prio="3">${esc(c.regime)}</td><td class="dh" data-prio="3">${esc(c.expert)}</td>
      <td class="num amount ${c.retards ? 'amount-late' : 'dim'}" data-rc="s" data-label="En retard">${c.retards}</td>
      <td class="num" data-rc="a">${c.amende ? money(c.amende) : '—'}</td><td class="col-act" data-rc="s">${riskPill(c.risk)}</td></tr>`).join('')
      : `<tr><td colspan="10"><div class="empty" style="padding:32px"><div class="ic">${svgI('search', '')}</div><h4>${state.clients.length ? 'Aucun client ne correspond' : 'Aucun client pour le moment'}</h4><p>${state.clients.length ? 'Modifiez la recherche ou le filtre.' : (can('create_client') ? 'Créez un premier dossier client pour commencer le suivi des délais.' : 'Un administrateur ou un comptable du cabinet doit créer le premier dossier client.')}</p></div></td></tr>`;
    $$('#clRows tr[data-id]').forEach(tr => tr.onclick = () => setClient(tr.dataset.id));
  };
  if ($('#newClient')) $('#newClient').onclick = clientModal;
  $('#clSearch').oninput = debounce(e => { state._cq = e.target.value; draw(); }, 120);
  $$('#view th[data-sort]').forEach(h => h.onclick = () => { const k = h.dataset.sort; state._csort = { k, dir: state._csort.k === k ? -state._csort.dir : (['ca', 'retards', 'amende'].includes(k) ? -1 : 1) }; renderClients(); });
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
  await ensurePeriod();   // garantit state.period (période ACTIVE) et les périodes du client courant
  const s = await api(`/clients/${state.clientId}/summary${perQuery()}`);   // fiche = période sélectionnée
  const e = s.entreprise, k = s.kpis;
  const ini = initialsOf(e.raison_sociale);
  const card = (v, t, sub) => `<button class="hub-card" data-view="${v}"><div class="hc-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">${HUBICON[v] || IC.dl}</svg></div><b>${t}</b><span class="hc-sub">${sub}</span></button>`;
  $('#view').innerHTML = `
  <div class="hub-head">
    <div class="hub-id">${esc(ini)}</div>
    <div class="hub-meta"><h1>${esc(e.raison_sociale)}</h1>
      <div class="hub-tags">
        <span class="tag">ICE ${esc(e.ice || '—')}</span><span class="tag">IF ${esc(e.if_fiscal || '—')}</span>
        <span class="tag">${esc(e.ville || '—')}</span>
        <span class="tag ${e.assujettie ? 'on' : ''}">${e.assujettie ? 'Assujettie' : 'Non assujettie'}</span>
        <span class="tag">${esc(e.regime)}</span><span class="tag">Visa ${e.type_visa}</span></div></div>
    <div class="actions">
      <button class="btn btn-ghost" id="editClient" data-perm="edit_client">${svgI('edit')}Modifier</button>
      <button class="btn btn-danger-ghost" id="delClient" data-perm="delete_client">${svgI('trash')}Supprimer</button>
    </div>
  </div>
  <div class="hero">
    <div class="hero-main">
      <div class="lbl">Montant TTC concerné · T${s.periode.trimestre} ${s.periode.annee}</div>
      <div class="big">${money(k.ttcRetard)}<small>DH</small></div>
      <div class="expl"><b>${k.aDeclarer}</b> facture(s) en retard sur <b>${k.factures}</b>, à déclarer à la DGI.</div>
      <div class="hero-sub"><span class="k">Amende du trimestre</span><span class="v penalty">${money(k.amende)} <small>DH</small></span></div>
      <div class="hero-foot"><span>Fournisseurs <b>${k.fournisseurs}</b></span><span>Conventions valides <b>${k.conventions}</b></span>
        <span>Conventions manquantes <b style="color:${k.convManq ? 'var(--severe)' : 'var(--ok)'}">${k.convManq}</b></span>
        <button class="btn-link" data-goto="anomalies">Anomalies à traiter <b style="color:${k.anomalies ? 'var(--warn)' : 'var(--ok)'}">${k.anomalies}</b>${k.anomaliesDetail && k.anomaliesDetail.aVerifier ? ` (dont ${k.anomaliesDetail.aVerifier} à vérifier)` : ''}</button></div>
    </div>
    <div class="card" id="perCard"><div class="card-h"><div><h3>Période ${TRI_LABEL(s.periode.trimestre)} ${s.periode.annee}</h3><div class="sub">statut, clôture et traçabilité</div></div></div>
      <div class="card-b" id="perCardBody"><div class="skel" style="height:90px"></div></div></div>
  </div>
  <div class="section-title"><h2>Modules du dossier</h2></div>
  <div class="hub-grid">
    ${card('delais', 'Feuille de calcul des délais', `${k.aDeclarer} en retard · ${money(k.amende)} DH`)}
    ${card('conv', 'Conventions', `${k.conventions} valide(s)${k.convManq ? ` · ${k.convManq} manquante(s)` : ''}`)}
    ${card('decl', 'Déclaration DGI', `Trimestre ${s.periode.trimestre} ${s.periode.annee}`)}
    ${card('visa', 'Générateur de visa', e.type_visa === 'CAC' ? 'Commissaire aux comptes' : 'Expert-comptable')}
    ${card('import', 'Importer des factures', `${k.factures} facture(s) chargée(s)`)}
    ${card('exports', 'Exports', 'Excel, CSV, XML EDI, Word et PDF')}
  </div>`;
  $$('.hub-card[data-view]').forEach(b => b.onclick = () => setView(b.dataset.view));
  renderPeriodCard(s.periode);
  if ($('#editClient')) $('#editClient').onclick = () => editClientModal(e);
  if ($('#delClient')) $('#delClient').onclick = () => {
    modal(`<div class="modal-h"><h3>Supprimer définitivement ${esc(e.raison_sociale)} ?</h3><button class="x" onclick="closeOverlay()">${XICO}</button></div>
    <div class="modal-b"><div class="note note-danger">${svgI('warn')}<div><div class="note-t">Action irréversible</div>Le dossier et toutes ses données seront supprimés :</div></div>
      <div class="dlg-facts"><div><span>Fournisseurs</span><b>${k.fournisseurs}</b></div><div><span>Conventions valides</span><b>${k.conventions}</b></div><div><span>Factures, déclarations, visas, fichiers</span><b>toutes les périodes</b></div></div>
      <label class="fld-lbl mt-12" for="delName">Pour confirmer, saisissez le nom du client : <b>${esc(e.raison_sociale)}</b></label>
      <input class="input-fld" id="delName" autocomplete="off" spellcheck="false"></div>
    <div class="modal-f"><button class="btn btn-ghost" onclick="closeOverlay()">Annuler</button>
      <button class="btn btn-danger" id="delOk" disabled>Supprimer définitivement</button></div>`, 'modal-sm');
    const norm = v => String(v || '').trim().replace(/\s+/g, ' ').toUpperCase();
    $('#delName').oninput = ev => { $('#delOk').disabled = norm(ev.target.value) !== norm(e.raison_sociale); };
    setTimeout(() => { const i = $('#delName'); if (i) i.focus(); }, 30);
    $('#delOk').onclick = async () => {
      if (norm($('#delName').value) !== norm(e.raison_sociale)) return;
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
// Carte « Période » de la fiche : statut, dates de clôture / réouverture, motif, auteur (journal d'audit).
async function renderPeriodCard(p) {
  const body = $('#perCardBody'); if (!body) return;
  let d; try { d = await periodDetail(p); } catch (e) { body.innerHTML = `<div class="dh">${esc(e.message)}</div>`; return; }
  const pr = d.periode; const locked = pr.verrouillee;
  const m = PERIOD_STATUT[pr.statut] || [pr.statutLabel || pr.statut, 'st-blue'];
  const isAdmin = state.me && state.me.role === 'admin';
  const hist = (pr.historique || []);
  body.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
      <span class="period-badge ${m[1]}" style="font-size:var(--fs-sm);padding:3px 10px">${locked ? svgI('lock', '') : ''}${esc(m[0])}</span>
      <span class="dh t-sm">${locked ? 'Montants, déclaration et exports figés' : 'Saisie et import autorisés'}</span></div>
    ${hist.length ? `<div class="hist">${hist.slice(0, 3).map(h => `<div class="hist-i"><span class="h-ic ${h.action === 'cloture' ? 'tone-locked' : 'tone-warn'}">${svgI(h.action === 'cloture' ? 'lock' : 'unlock', '')}</span>
      <div class="h-b"><b>${h.action === 'cloture' ? 'Clôturée' : 'Rouverte'}</b> par ${esc(h.par || '—')}<small>${esc(dateTimeFr(h.date))}</small>${h.motif ? `<q>${esc(h.motif)}</q>` : ''}</div></div>`).join('')}</div>`
      : `<div class="dh t-sm">Aucune clôture enregistrée pour cette période.</div>`}
    <div class="actions mt-12">${isAdmin
      ? (locked ? `<button class="btn btn-ghost btn-sm" id="pcReopen">${svgI('unlock')}Rouvrir…</button>` : `<button class="btn btn-ghost btn-sm" id="pcClose">${svgI('lock')}Clôturer la période…</button>`)
      : `<span class="pp-note">Clôture et réouverture réservées à un administrateur.</span>`}</div>`;
  const a = $('#pcClose'); if (a) a.onclick = closePeriodAction;
  const b = $('#pcReopen'); if (b) b.onclick = reopenPeriodAction;
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
// Libellés lisibles de l'état de paiement à la clôture (aucun jargon technique).
const ETAT_PAIEMENT_LABEL = {
  paye: 'Payée', impaye_cloture: 'Impayée à la clôture', paye_apres_cloture: 'Payée après la clôture',
  facture_hors_periode: 'Hors trimestre', paiement_anterieur: 'Paiement avant la facture (à vérifier)',
};
// Phrase d'explication (infobulle) selon l'état.
function etatTip(f) {
  const fin = f.arrete_au ? dateFr(f.arrete_au) : '';
  switch (f.etat_paiement) {
    case 'impaye_cloture': return `Facture non payée à la clôture : le délai est calculé jusqu'au dernier jour du trimestre (${fin}).`;
    case 'paye_apres_cloture': return `Paiement postérieur à la clôture — calcul arrêté au ${fin}.`;
    case 'facture_hors_periode': return `Facture datée après la fin du trimestre : elle n'appartient pas à cette période.`;
    case 'paiement_anterieur': return `Date de paiement antérieure à la date de facture — à vérifier.`;
    default: return f.date_paiement ? `Facture payée le ${dateFr(f.date_paiement)}.` : '';
  }
}
// Petit badge d'état affiché sous le délai constaté (uniquement quand ce n'est pas un simple « payée »).
function etatMini(f) {
  const m = { impaye_cloture: ['pill-orange', 'impayée à la clôture'], paye_apres_cloture: ['pill-app', 'payée après clôture'], facture_hors_periode: ['pill-red', 'hors trimestre'], paiement_anterieur: ['pill-red', 'à vérifier'] };
  const e = m[f.etat_paiement];
  return e ? `<div style="margin-top:3px"><span class="pill pill-sm ${e[0]}">${e[1]}</span></div>` : '';
}
const DUP_MOTIF_FR = 'Facture identique déjà présente — gardée pour vérification (paiement partiel / facture scindée ?)';
// Badge « doublon » dans la feuille de délais, selon l'état de revue (jamais destructif) :
//  potentiel → « Doublon ? » (avertissement léger) · confirme → « Doublon confirmé » · faux_positif → aucune alerte principale.
function doublonBadge(f) {
  const st = f.statut_doublon || (f.doublon_potentiel ? 'potentiel' : 'aucun');
  if (st === 'potentiel')
    return ` <span class="pill pill-sm pill-warn" title="${esc(f.motif_doublon || DUP_MOTIF_FR)} — cliquez la ligne pour vérifier.">Doublon ?</span>`;
  if (st === 'confirme')
    return ` <span class="pill pill-sm pill-late" title="Doublon confirmé lors de la revue — facture conservée (aucune suppression).">Doublon confirmé</span>`;
  return ''; // faux_positif → pas d'alerte principale (indication discrète dans le détail)
}
// Badge « opérateur de réseau » (délai 30 j + exclusion déclarative).
function reseauBadge(f) {
  if (f.operateur_reseau) {
    const tip = "Cette facture appartient à un opérateur de télécommunications, d'eau ou d'électricité. Son délai applicable est de 30 jours et elle est exclue des tableaux déclaratifs concernés.";
    return ` <span class="pill pill-sm pill-info" title="${tip}">Réseau — 30 j</span>${f.hors_tableau ? ' <span class="pill pill-sm pill-info pill-outline" title="Facture volontairement exclue des tableaux déclaratifs (conservée en suivi interne).">Hors tableau déclaratif</span>' : ''}`;
  }
  // Proposition réseau non confirmée : badge + confirmation en un clic (opérateur télécom/eau/électricité → 30 j + exclusion).
  if (f.reseau_statut === 'propose' && f.four_id) {
    const tip = `Fournisseur possiblement opérateur de réseau${f.reseau_categorie ? ' (' + esc(f.reseau_categorie) + ')' : ''}${f.reseau_ambigu ? ' — à vérifier (nom générique)' : ''}. Confirmer applique le délai de 30 jours et l'exclusion déclarative.`;
    return ` <button class="btn btn-ghost btn-xs reseau-confirm" data-perm="classify_network" data-four="${f.four_id}" data-fournom="${esc(f.four || '')}" title="${tip}" onclick="event.stopPropagation();confirmReseau(this)" style="color:var(--info)">Réseau ? — confirmer</button>`;
  }
  return '';
}
// Confirme un fournisseur comme opérateur de réseau (délai 30 j + exclusion déclarative) via l'endpoint de classification.
window.confirmReseau = async function (btn) {
  const fourId = btn.dataset.four, nom = btn.dataset.fournom || 'ce fournisseur';
  const ok = await ui.confirm({ tone: 'brand', icon: 'bolt', title: `Confirmer « ${nom} » comme opérateur de réseau ?`,
    html: `<p>Règle spéciale des opérateurs de télécommunications, d'eau ou d'électricité :</p>`,
    facts: [['Délai appliqué', '30 jours'], ['Tableaux déclaratifs', 'Exclu (suivi interne conservé)'], ['Recalcul', 'Périodes non clôturées uniquement']],
    confirmLabel: 'Confirmer la classification' });
  if (!ok) return;
  btn.disabled = true; btn.textContent = '…';
  try {
    await api(`/clients/${state.clientId}/fournisseurs/${fourId}/classification`, { method: 'PATCH', body: { operateur_reseau: true, statut: 'confirme', categorie_fournisseur: 'autre_operateur_reseau' } });
    toast('Opérateur de réseau confirmé (30 j + exclusion).', 'ok', 'Classification réseau');
    renderView(state.view); refreshAlertsBadge();
  } catch (e) { toast(e.message, 'err'); btn.disabled = false; btn.textContent = btn.dataset.label || 'Réseau ? — confirmer'; }
};
// Export Excel de la feuille de délais pour un filtre donné (toutes / retard / convention absente).
async function exportDelais(filter, btn) {
  const orig = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = 'Export…'; }
  try {
    const qs = perQuery(), sep = qs ? '&' : '?';
    const res = await fetch(`/api/clients/${state.clientId}/delais/export.xlsx${qs}${sep}filter=${filter}`, { credentials: 'same-origin' });
    if (res.status === 401) { window.location.href = '/login'; return; }
    if (!res.ok) throw new Error('Export impossible.');
    const blob = await res.blob();
    const m = (res.headers.get('content-disposition') || '').match(/filename="?([^"]+)"?/);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = m ? m[1] : `delais_${filter}.xlsx`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
    toast('Fichier Excel généré.', 'ok', 'Export feuille de délais');
  } catch (e) { toast(e.message || 'Export impossible.', 'err'); }
  finally { if (btn) { btn.disabled = false; btn.innerHTML = orig; } }
}
async function renderDelais() {
  if (!state.clientId) return noClient();
  const periods = await ensurePeriod();
  const data = await api(`/clients/${state.clientId}/delais${perQuery()}`);
  const t = data.totals; state._delais = data;
  const filt = state._filter || 'all';
  const rows = data.rows.filter(r => filt === 'retard' ? r.a_declarer : (filt === 'conv' ? (!r.has_conv && r.delai_applicable >= 120) : true));
  const locked = currentPeriodLocked();
  const FL = { all: 'Toutes', retard: 'Retard > 0', conv: 'Convention absente' };
  $('#view').innerHTML = `
  ${clientPeriodBar(periods)}${lockBanner()}
  <div class="page-head headrow"><div><div class="eyebrow">${esc(currentClient().name)} · T${data.periode.trimestre} ${data.periode.annee}</div><h1>Délais de paiement</h1><p>Calcul automatique des retards et amendes — loi 69-21, découpage au mois calendaire.</p></div>
    <div class="actions"><button class="btn btn-ghost" id="recompute" data-perm="import" ${locked ? 'disabled title="Période clôturée : montants figés, aucun recalcul"' : ''}>${svgI('refresh')}Recalculer</button>
    <button class="btn btn-primary" onclick="setView('decl')">${svgI('doc')}Préparer la déclaration</button></div></div>
  <div class="stat-strip">
    <div class="stat lead"><div class="l">Montant TTC concerné</div><div class="v">${money(t.ttcRetard)}<small>DH</small></div></div>
    <div class="stat late"><div class="l">En retard (à déclarer)</div><div class="v">${t.aDeclarer}</div></div>
    <div class="stat"><div class="l">Factures analysées</div><div class="v">${t.count}</div></div>
    <div class="stat"><div class="l">Retard moyen</div><div class="v">${t.retardMoyen}<small>j</small></div></div>
    <div class="stat severe"><div class="l">Amende du trimestre</div><div class="v">${money(t.amende)}<small>DH</small></div></div>
  </div>
  <div class="toolbar">
    <div class="filters">${[['all', 'Toutes', data.rows.length], ['retard', 'Retard &gt; 0', t.aDeclarer], ['conv', 'Convention absente', t.sansConvention]].map(([k, label, count]) => `<button class="fpill" data-f="${k}" aria-pressed="${filt === k}">${label}<span class="c">${count}</span></button>`).join('')}</div>
    <div class="actions"><span class="dh t-sm">Exporter en Excel :</span>${['all', 'retard', 'conv'].map(k => `<button class="btn btn-ghost btn-sm xls-export" data-x="${k}" title="Exporter « ${FL[k]} » en Excel">${svgI('dl')}${FL[k]}</button>`).join('')}</div>
  </div>
  ${(() => { const hv = data.rows.filter(r => r.conv_hors_validite).length; return hv ? `<div class="note note-warn">${svgI('warn')}<div><div class="note-t">Convention appliquée hors de sa période de validité — à confirmer</div>${hv} facture(s) : le calcul applique la convention en vigueur (règle actuelle, selon son statut) alors que ses dates ne couvrent pas ce trimestre. Question ouverte pour l’expert-comptable ; montants inchangés.</div></div>` : ''; })()}
  ${rows.length ? `<div class="hint">${svgI('info')}<span>Facture non payée à la clôture : le délai est calculé jusqu'au dernier jour du trimestre. Cliquez une ligne pour le détail du calcul.</span></div>
  <div class="table-wrap"><table class="dense rc"><thead><tr>
    <th>N° facture</th><th>Fournisseur (IF)</th><th data-prio="3">Nature</th><th class="num">TTC</th><th data-prio="1">Date facture</th><th>Date paiement</th>
    <th data-prio="3">Arrêté au</th><th class="num" data-prio="2">Délai constaté</th><th>Délai autorisé</th><th class="num">Retard</th><th data-prio="2">À déclarer</th><th class="num">Amende</th><th class="col-act">Statut</th></tr></thead>
    <tbody id="pgBody"></tbody>
    <tfoot><tr><td>Total — ${rows.length} facture(s)</td><td></td><td data-prio="3"></td><td class="num" data-label="TTC">${money(rows.reduce((s, x) => s + (x.ttc || 0), 0))}</td><td data-prio="1"></td><td></td><td data-prio="3"></td><td data-prio="2"></td><td></td><td></td><td data-prio="2"></td><td class="num amount-late" data-label="Amende">${money(rows.reduce((s, x) => s + (x.amende || 0), 0))}</td><td class="col-act"></td></tr></tfoot>
  </table></div><div id="pgMore" class="table-foot"></div>` : emptyBox('Aucune facture sur cette période', `Aucune facture n'est rattachée à T${data.periode.trimestre} ${data.periode.annee} pour ce client. Importez un journal d'achats ou choisissez une autre période.`, locked ? null : 'import', 'Importer un journal', 'table')}`;
  $$('.fpill').forEach(b => b.onclick = () => { state._filter = b.dataset.f; renderDelais(); });
  $$('.xls-export').forEach(b => b.onclick = () => exportDelais(b.dataset.x, b));
  wireClientBar(renderDelais);
  if ($('#recompute')) $('#recompute').onclick = async () => { if (locked) return; await api(`/clients/${state.clientId}/recompute${perQuery()}`, { method: 'POST' }); toast('Recalcul effectué.', 'ok'); renderDelais(); };
  if (rows.length) mountPaged(rows, f => `<tr class="clickable" data-id="${f.id}">
      <td class="mono" data-rc="m" data-label="N°"><b>${esc(f.numero || '—')}</b></td>
      <td data-rc="t"><div class="fournisseur" title="${esc(f.four || '')}"><b>${esc(f.four || '—')}</b><small>IF ${esc(f.four_if || '—')}</small></div></td>
      <td class="dh" data-prio="3"><span class="clip" title="${esc(f.nature || '')}">${esc(f.nature || '—')}</span></td>
      <td class="num" data-rc="a">${money(f.ttc)}</td>
      <td class="mono dh" data-prio="1" data-rc="m" data-label="Facture">${dateFr(f.date_facture)}</td>
      <td class="mono dh" data-rc="m" data-label="Paiement">${dateFr(f.date_paiement)}</td>
      <td class="mono dh" data-prio="3" title="${esc(etatTip(f))}">${f.arrete_au ? dateFr(f.arrete_au) : '—'}</td>
      <td class="num" data-prio="2" title="${esc(etatTip(f))}">${f.delai_ecoule != null ? f.delai_ecoule + ' j' : '—'}${etatMini(f)}</td>
      <td data-rc="s"><div class="cell-stack"><span class="badge ${f.operateur_reseau ? 'b30' : (f.has_conv || f.delai_applicable >= 120 ? 'b120' : 'b60')}">${f.delai_applicable} j ${f.operateur_reseau ? '<small>réseau</small>' : (!f.has_conv && f.delai_applicable === 60 ? '<small>légal</small>' : '')}</span>${f.delai_ecoule > 60 && !f.operateur_reseau ? (f.has_conv
        ? (f.conv_hors_validite ? ' <span class="pill pill-sm pill-warn" title="Convention appliquée au calcul (règle LOT 4) alors que ses dates ne couvrent pas ce trimestre — question ouverte pour l’expert-comptable.">conv. hors validité</span>' : ' <span class="pill pill-sm pill-ok" title="Convention disponible">conv.</span>')
        : (f.four_id && !locked
          ? ` <button class="btn btn-ghost btn-xs link-ink" data-perm="manage_conventions" title="Ce fournisseur a une convention signée : l'enregistrer en un clic" aria-label="Enregistrer la convention signée de ${esc(f.four || 'ce fournisseur')}" data-four="${f.four_id}" data-fournom="${esc(f.four || '')}" data-delai="${f.delai_ecoule}" onclick="event.stopPropagation();convExpress(this)">+ Conv.</button>`
          : ' <span class="pill pill-sm pill-late" title="Aucune convention pour ce fournisseur">sans conv.</span>')) : ''}</div>${(reseauBadge(f) + doublonBadge(f)).trim() ? `<div class="cell-stack">${reseauBadge(f)}${doublonBadge(f)}</div>` : ''}</td>
      <td class="retard ${f.retard > 0 ? 'pos' : 'neg'}" data-rc="s" data-label="Retard">${f.retard == null ? '—' : (f.retard > 0 ? '+' + f.retard : f.retard)}</td>
      <td data-prio="2">${f.a_declarer ? '<span class="pill pill-sm pill-late"><span class="dot"></span>Oui</span>' : '<span class="tag-no">—</span>'}</td>
      <td class="num amount" data-rc="s" data-label="Amende">${f.amende ? money(f.amende) : '—'}</td>
      <td class="col-act" data-rc="s">${riskPill(f.risk)}</td></tr>`,
    { onRow: tr => factureDrawer(data.rows.find(x => x.id === tr.dataset.id)) });
}
function factureDrawer(f) {
  if (!f) return;
  drawer(`<div class="drawer-h"><div><h3>Facture ${esc(f.numero || '')}</h3><div class="s">${esc(f.four || '')} · IF ${esc(f.four_if || '—')}</div></div><button class="x" onclick="closeOverlay()">${XICO}</button></div>
  <div class="drawer-b">
    <div><div class="det-row"><span class="k">Nature</span><span class="v fvn-n">${esc(f.nature || '—')}</span></div>
      <div class="det-row"><span class="k">Montant HT</span><span class="v">${money(f.mht)} DH</span></div>
      <div class="det-row"><span class="k">TVA</span><span class="v">${money(f.tva)} DH</span></div>
      <div class="det-row"><span class="k">Montant TTC</span><span class="v">${money(f.ttc)} DH</span></div>
      <div class="det-row"><span class="k">Date facture</span><span class="v">${dateFr(f.date_facture)}</span></div>
      <div class="det-row"><span class="k">Date paiement</span><span class="v">${dateFr(f.date_paiement)}</span></div>
      <div class="det-row"><span class="k">Date limite légale</span><span class="v">${dateFr(f.date_limite)}</span></div>
      <div class="det-row"><span class="k">Date d'arrêté retenue</span><span class="v">${f.arrete_au ? dateFr(f.arrete_au) : '—'}</span></div>
      <div class="det-row"><span class="k">État</span><span class="v fvn-n">${esc(ETAT_PAIEMENT_LABEL[f.etat_paiement] || '—')}</span></div>
    </div>
    ${etatTip(f) ? `<div class="dh" style="font-size:var(--fs-sm);margin:6px 0 2px">${esc(etatTip(f))}</div>` : ''}
    <div class="calc">
      <div class="row"><span>Délai constaté (arrêté − date de facture)</span><b>${f.delai_ecoule != null ? f.delai_ecoule + ' j' : '—'}</b></div>
      <div class="row"><span>Délai autorisé (convention / légal)</span><b>${f.delai_applicable} j</b></div>
      <div class="row"><span>Jours de retard (constaté − autorisé)</span><b style="color:${f.retard > 0 ? 'var(--late)' : 'var(--ok)'}">${f.retard == null ? '—' : (f.retard > 0 ? '+' + f.retard : f.retard) + ' j'}</b></div>
      <div class="row"><span>Mois de retard</span><b>${f.n_mois || 0}</b></div>
      <div class="row"><span>Taux directeur BAM (1ᵉʳ mois)</span><b>${f.taux_bam != null ? pct(f.taux_bam) : '—'}</b></div>
      <div class="row"><span>Taux total appliqué</span><b>${f.taux_total ? pct(f.taux_total) : '—'}</b></div>
      <div class="row tot"><span>Amende (trimestre)</span><span>${money(f.amende)} DH</span></div>
    </div>
    <div class="dh t-sm">Modèle trimestriel apporté (mois calendaire) : 1ᵉʳ mois de retard au taux directeur BAM, mois suivants à 0,85 %, seuls les mois du trimestre déclaré sont facturés.</div>
    ${f.conv_hors_validite ? `<div class="note note-warn mt-12">${svgI('warn')}<div><div class="note-t">Convention appliquée hors de sa période de validité — à confirmer</div>Convention du ${dateFr(f.conv_hors_validite.debut)}${f.conv_hors_validite.fin ? ' au ' + dateFr(f.conv_hors_validite.fin) : ''} : ses dates ne couvrent pas ce trimestre, mais le calcul l’applique (règle actuelle, selon son statut). Question ouverte pour l’expert-comptable.</div></div>` : ''}
    ${doublonDrawer(f)}
  </div>`);
}

// Bloc « Revue du doublon » dans le détail facture (actions non destructives).
function doublonDrawer(f) {
  const st = f.statut_doublon || (f.doublon_potentiel ? 'potentiel' : 'aucun');
  if (!f.doublon_potentiel && st === 'aucun') return ''; // facture non concernée
  const meta = f.date_revue_doublon ? `<div class="dh" style="font-size:var(--fs-xs);margin-top:6px">Revue enregistrée le ${dateFr(f.date_revue_doublon)}.</div>` : '';
  const A = (act, label, primary) => `<button class="btn ${primary ? 'btn-primary' : 'btn-ghost'} btn-sm" data-perm="review_duplicates" onclick="reviewDoublon(this)" data-fid="${f.id}" data-act="${act}">${esc(label)}</button>`;
  let title, note, actions;
  if (st === 'confirme') {
    title = '<span class="pill pill-red"><span class="dot"></span>Doublon confirmé</span>';
    note = 'Doublon confirmé lors de la revue. La facture reste enregistrée et incluse dans les calculs — aucune suppression, aucune fusion.';
    actions = A('faux_positif', 'Requalifier en faux positif') + ' ' + A('potentiel', 'Rouvrir l’alerte');
  } else if (st === 'faux_positif') {
    title = '<span class="pill pill-ok"><span class="dot"></span>Alerte vérifiée — faux positif</span>';
    note = 'Alerte vérifiée — faux positif : ce n’est pas un doublon (paiement partiel, facture scindée ou échéance distincte). L’alerte principale n’est plus affichée.';
    actions = A('confirme', 'Requalifier en doublon') + ' ' + A('potentiel', 'Rouvrir l’alerte');
  } else { // potentiel
    title = '<span class="pill pill-orange"><span class="dot"></span>Doublon ?</span>';
    note = esc(f.motif_doublon || DUP_MOTIF_FR) + ' La facture est conservée : rien n’est supprimé tant que vous n’avez pas tranché.';
    actions = A('confirme', 'Confirmer le doublon', true) + ' ' + A('faux_positif', 'Marquer comme faux positif');
  }
  return `<div class="calc mt-14" id="dupReview">
    <div class="row" style="align-items:center"><span>Revue du doublon</span><b>${title}</b></div>
    <div class="dh" style="font-size:var(--fs-sm);margin:6px 0">${note}</div>${meta}
    <div id="dupActions" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">${actions}</div>
  </div>`;
}

// Revue d'un doublon : confirmation, appel API PATCH, toast, rafraîchissement de la ligne.
window.reviewDoublon = async function (btn) {
  const fid = btn.dataset.fid, act = btn.dataset.act;
  const ASK = { confirme: 'confirmer ce doublon', faux_positif: 'marquer cette alerte comme faux positif', potentiel: 'rouvrir l’alerte de doublon' };
  const ok = await ui.confirm({ tone: act === 'confirme' ? 'warn' : 'brand', title: `Voulez-vous ${ASK[act] || 'modifier la revue'} ?`,
    message: 'Aucune facture ne sera supprimée ni fusionnée : seule la qualification de l\'alerte change, et elle est tracée.', confirmLabel: 'Enregistrer la revue' });
  if (!ok) return;
  const box = $('#dupActions'), btns = box ? $$('button', box) : [btn];
  btns.forEach(b => { b.disabled = true; }); btn.textContent = '…';
  try {
    await api(`/clients/${state.clientId}/factures/${fid}/doublon`, { method: 'PATCH', body: { statut: act } });
    const MSG = { confirme: 'Doublon confirmé.', faux_positif: 'Marqué comme faux positif.', potentiel: 'Alerte rouverte.' };
    toast(MSG[act] || 'Revue enregistrée.', 'ok', 'Revue du doublon');
    await renderDelais(); refreshAlertsBadge();
    const nf = ((state._delais && state._delais.rows) || []).find(x => x.id === fid);
    if (nf) factureDrawer(nf); else closeOverlay();
  } catch (e) {
    toast(e.message, 'err');
    btns.forEach(b => { b.disabled = false; });
  }
};

// Enregistrement express d'une convention depuis la feuille de délais : le comptable
// sait que le fournisseur a une convention signée → 1 clic pour la créer (PDF différé).
window.convExpress = function (btn) {
  const fourId = btn.dataset.four, nom = btn.dataset.fournom || 'ce fournisseur', ecoule = btn.dataset.delai;
  modal(`<div class="modal-h"><h3>Convention présente</h3><button class="x" onclick="closeOverlay()">${XICO}</button></div>
  <div class="modal-b">
    <p class="dh" style="margin-bottom:12px">Enregistrer la convention de délai de paiement signée avec <b>${esc(nom)}</b>.
    Le document PDF pourra être ajouté ensuite dans la rubrique <b>Conventions</b> (statut « Document manquant »).</p>
    <div class="form-grid"><div><label class="fld-lbl">Délai convenu (jours)</label>
      <input class="input-fld" id="ce_delai" type="number" min="1" max="120" value="120">
      <div class="dh" style="font-size:var(--fs-xs);margin-top:4px">Délai réellement écoulé sur cette facture : <b>${esc(ecoule)} j</b>. Indiquez le délai figurant dans la convention (120 j maximum — plafond légal).</div>
    </div></div>
  </div>
  <div class="modal-f"><button class="btn btn-ghost" onclick="closeOverlay()">Annuler</button><button class="btn btn-primary" id="ce_save">Créer la convention</button></div>`);
  $('#ce_save').onclick = async () => {
    const d = parseInt($('#ce_delai').value, 10);
    if (!(d > 0 && d <= 120)) { toast('Indiquez un délai valide entre 1 et 120 jours.', 'err'); return; }
    const b = $('#ce_save'); b.disabled = true; b.textContent = 'Création…';
    try {
      await api(`/clients/${state.clientId}/conventions`, { method: 'POST', body: { fournisseur_id: fourId, delai: d } });
      closeOverlay();
      toast(`Convention (${d} j) enregistrée pour ${nom}. Ajoutez le PDF dans « Conventions ».`, 'ok', 'Convention créée');
      renderDelais(); refreshAlertsBadge();
    } catch (e) { toast(e.message, 'err'); b.disabled = false; b.textContent = 'Créer la convention'; }
  };
};

/* ============================== FOURNISSEURS & RÉSEAU (lecture — aucune nouvelle règle) ==============================
 * Les montants viennent des lignes de la feuille des délais (même calcul, même période) ; rien n'est recalculé ici. */
const RESEAU_CAT = { telecom: 'Télécommunications', societe_regionale_multiservices: 'Société régionale multiservices',
  regie_distribution: 'Eau & électricité', autre_operateur_reseau: 'Opérateur de réseau' };
function delaiBadge(d, reseau, conv) {
  return `<span class="badge ${reseau ? 'b30' : (conv || d >= 120 ? 'b120' : 'b60')}">${d} j${reseau ? ' <small>réseau</small>' : (conv ? ' <small>conv.</small>' : (d === 60 ? ' <small>légal</small>' : ''))}</span>`;
}
async function renderFournisseurs() {
  if (!state.clientId) return noClient();
  await ensurePeriod();
  const [fours, data] = await Promise.all([api(`/clients/${state.clientId}/fournisseurs`), api(`/clients/${state.clientId}/delais${perQuery()}`)]);
  const agg = new Map();
  for (const r of data.rows) {
    const a = agg.get(r.four_id) || { n: 0, ttc: 0, late: 0, amende: 0, delai: r.delai_applicable, reseau: !!r.operateur_reseau, conv: !!r.has_conv };
    a.n++; a.ttc += r.ttc || 0; if (r.a_declarer) a.late++; a.amende += r.amende || 0; agg.set(r.four_id, a);
  }
  const rows = fours.map(f => { const a = agg.get(f.id); return { ...f, per: a || null,
    delai: f.delai_regle, reseau: f.source_regle === 'operateur_reseau', conv: f.source_regle === 'convention', sansJustif: !!f.sans_convention_justificative, sourceLabel: f.source_label }; })
    .sort((x, y) => ((y.per && y.per.amende) || 0) - ((x.per && x.per.amende) || 0) || ((y.per && y.per.ttc) || 0) - ((x.per && x.per.ttc) || 0) || String(x.raison_sociale || '').localeCompare(String(y.raison_sociale || ''), 'fr'));
  const withInv = rows.filter(r => r.per), late = rows.filter(r => r.per && r.per.late), sansConv = rows.filter(r => r.sansJustif); // définition unique côté serveur (src/anomalies.js — CONV-1)
  const P = `T${data.periode.trimestre} ${data.periode.annee}`;
  $('#view').innerHTML = `
  <div class="page-head headrow"><div><div class="eyebrow">${esc(currentClient().name)} · ${P}</div><h1>Fournisseurs</h1>
    <p>Délai appliqué à chaque fournisseur et son exposition sur la période, issus du même calcul que la feuille des délais.</p></div>
    <div class="actions"><button class="btn btn-ghost" onclick="setView('conv')">${svgI('doc')}Conventions</button><button class="btn btn-ghost" onclick="setView('reseau')">${svgI('bolt')}Opérateurs de réseau</button></div></div>
  <div class="stat-strip">
    <div class="stat"><div class="l">Fournisseurs du dossier</div><div class="v">${rows.length}</div></div>
    <div class="stat"><div class="l">Avec factures en ${P}</div><div class="v">${withInv.length}</div></div>
    <div class="stat late"><div class="l">Avec factures à déclarer</div><div class="v">${late.length}</div></div>
    <div class="stat ${sansConv.length ? 'severe' : ''}"><div class="l">Sans convention justificative</div><div class="v">${sansConv.length}</div></div></div>
  ${rows.length ? `<div class="table-wrap"><table class="dense rc"><thead><tr><th>Fournisseur</th><th data-prio="2">ICE / IF</th><th>Délai appliqué</th><th class="num">Factures</th><th class="num">TTC ${P}</th><th class="num">À déclarer</th><th class="num">Amende</th><th class="col-act"><span class="sr-only">Actions</span></th></tr></thead>
    <tbody id="pgBody"></tbody>
    <tfoot><tr><td>Total — ${rows.length} fournisseur(s)</td><td data-prio="2"></td><td></td><td class="num" data-label="Factures">${data.rows.length}</td><td class="num" data-label="TTC">${money(withInv.reduce((t, r) => t + r.per.ttc, 0))}</td><td class="num" data-label="À déclarer">${late.reduce((t, r) => t + r.per.late, 0)}</td><td class="num amount-late" data-label="Amende">${money(withInv.reduce((t, r) => t + r.per.amende, 0))}</td><td class="col-act"></td></tr></tfoot></table></div><div id="pgMore" class="table-foot"></div>`
    : emptyBox('Aucun fournisseur', 'Les fournisseurs apparaissent automatiquement à l’import des factures du client.', 'import', 'Importer des factures', 'table')}`;
  if (rows.length) mountPaged(rows, r => `<tr>
      <td data-rc="t"><div class="fournisseur"><b>${esc(r.raison_sociale || '—')}</b>${r.sansJustif ? '<small class="amount-late">Sans convention justificative</small>' : ''}</div></td>
      <td class="mono dh" data-prio="2">${esc(r.ice || '—')}<br><small>IF ${esc(r.if_fiscal || '—')}</small></td>
      <td data-rc="s">${delaiBadge(r.delai, r.reseau, r.conv)}${r.sansJustif ? `<div class="t-xs dh mt-8" title="${esc(r.sourceLabel)}">Source : délai fournisseur importé, sans convention</div>` : ''}</td>
      <td class="num" data-rc="m" data-label="Factures">${r.per ? r.per.n : '—'}</td>
      <td class="num" data-rc="a">${r.per ? money(r.per.ttc) : '—'}</td>
      <td class="num ${r.per && r.per.late ? 'amount-late' : 'dim'}" data-rc="s" data-label="À déclarer">${r.per ? r.per.late : '—'}</td>
      <td class="num amount" data-rc="s" data-label="Amende">${r.per && r.per.amende ? money(r.per.amende) : '—'}</td>
      <td class="col-act" data-rc="s">${r.per ? `<button class="btn btn-quiet btn-sm" onclick="setView('delais')">Factures</button>` : ''}</td></tr>`);
}
async function renderReseau() {
  if (!state.clientId) return noClient();
  const [fours, sim] = await Promise.all([api(`/clients/${state.clientId}/fournisseurs`), api(`/clients/${state.clientId}/reseau/simulation`)]);
  const confirmed = fours.filter(f => f.operateur_reseau && f.statut_classification === 'confirme');
  const props = sim.candidats || [];
  $('#view').innerHTML = `
  <div class="page-head"><div class="eyebrow">${esc(currentClient().name)} · toutes périodes</div><h1>Opérateurs de réseau</h1>
    <p>Télécommunications, eau et électricité : délai spécifique de <b>30 jours</b> et exclusion des tableaux déclaratifs, une fois la classification <b>confirmée</b>. Un nom seul ne suffit jamais : chaque proposition doit être vérifiée.</p></div>
  <div class="stat-strip"><div class="stat ${props.length ? 'warn' : ''}"><div class="l">Propositions à vérifier</div><div class="v">${props.length}</div></div>
    <div class="stat"><div class="l">Opérateurs confirmés</div><div class="v">${confirmed.length}</div></div></div>
  <div class="section-title"><h2>À vérifier</h2><span class="sub">détectés sur le nom du fournisseur — aucun effet tant que ce n’est pas confirmé</span></div>
  ${props.length ? `<div class="table-wrap"><table class="dense rc"><thead><tr><th>Fournisseur</th><th>Catégorie proposée</th><th class="num">Factures</th><th class="num">TTC</th><th>Délai actuel → proposé</th><th class="col-act"><span class="sr-only">Action</span></th></tr></thead><tbody>
    ${props.map(p => `<tr><td data-rc="t"><div class="fournisseur"><b>${esc(p.fournisseur || '—')}</b><small>${esc(p.ice || p.if_fiscal || '')}${p.ambigu ? ' · nom générique — à vérifier' : ''}</small></div></td>
      <td data-rc="m">${esc(RESEAU_CAT[p.categorie] || p.categorie || '—')}</td>
      <td class="num" data-rc="m" data-label="Factures">${p.nbFactures || 0}</td><td class="num" data-rc="a">${money(p.ttc || 0)}</td>
      <td data-rc="s">${p.delaiActuel} j → <b>${p.delaiPropose} j</b></td>
      <td class="col-act" data-rc="s"><button class="btn btn-ghost btn-sm" data-perm="classify_network" data-four="${p.fournisseur_id}" data-fournom="${esc(p.fournisseur || '')}" data-label="Vérifier et confirmer" onclick="confirmReseau(this)">Vérifier et confirmer</button></td></tr>`).join('')}
    </tbody></table></div>` : `<div class="card"><div class="empty"><div class="ic">${svgI('checkc', '')}</div><h4>Aucune proposition en attente</h4><p>Aucun fournisseur de ce dossier ne ressemble à un opérateur de réseau non confirmé.</p></div></div>`}
  <div class="section-title"><h2>Confirmés</h2><span class="sub">délai de 30 jours appliqué</span></div>
  ${confirmed.length ? `<div class="table-wrap"><table class="dense rc"><thead><tr><th>Fournisseur</th><th>Catégorie</th><th>Délai</th><th>Tableaux déclaratifs</th></tr></thead><tbody>
    ${confirmed.map(f => `<tr><td data-rc="t"><div class="fournisseur"><b>${esc(f.raison_sociale || '—')}</b><small>${esc(f.ice || f.if_fiscal || '')}</small></div></td>
      <td data-rc="m">${esc(RESEAU_CAT[f.categorie_fournisseur] || 'Opérateur de réseau')}</td><td data-rc="a">${delaiBadge(30, true, false)}</td>
      <td data-rc="s">${f.hors_tableau_declaratif ? '<span class="pill pill-sm pill-info">Exclu (suivi interne conservé)</span>' : '<span class="pill pill-sm pill-locked">Inclus</span>'}</td></tr>`).join('')}
    </tbody></table></div>` : `<div class="card"><div class="empty"><div class="ic">${svgI('info', '')}</div><h4>Aucun opérateur confirmé</h4><p>Les délais standards (convention ou 60 jours) s’appliquent à tous les fournisseurs de ce dossier.</p></div></div>`}`;
}

/* ============================== IMPORT ============================== */
/* ============================== ASSISTANT D'IMPORT (6 étapes) ============================== */
const WIZ_STEPS = ['Fichier', 'Analyse & correspondance', 'Validation & aperçu', 'Résultat'];
async function renderImport() {
  if (!state.clientId) return noClient();
  await ensurePeriod();
  state.wizKind = 'factures';
  state.wiz = { step: 'upload' };
  drawWizard();
  renderDocs();
}
// Assistant d'import des CONVENTIONS — RÉUTILISE le même composant de mapping que les factures.
function openConvWizard() {
  if (!state.clientId) return noClient();
  state.wizKind = 'conventions';
  state.wiz = { step: 'upload' };
  drawWizard();
}
window.openConvWizard = openConvWizard;
function wizIsConv() { return state.wizKind === 'conventions'; }
function wizStepIndex() { return { upload: 0, map: 1, preview: 2, done: 3 }[state.wiz.step] || 0; }
function wizScaffold(inner) {
  const steps = `<ol class="wiz-steps" aria-label="Étapes de l'import" style="list-style:none;padding:0">${WIZ_STEPS.map((s, i) => `<li class="ws ${wizStepIndex() > i ? 'done' : ''} ${wizStepIndex() === i ? 'cur' : ''}" ${wizStepIndex() === i ? 'aria-current="step"' : ''}><i>${wizStepIndex() > i ? '✓' : i + 1}</i>${s}</li>`).join('<li class="ws-sep" aria-hidden="true"></li>')}</ol>`;
  if (wizIsConv()) {
    return `<div class="page-head headrow"><div><div class="eyebrow">${esc(currentClient().name)} · Conventions</div><h1>Import des conventions</h1><p>Analyse → correspondance libre des colonnes → aperçu → confirmation. <b>Rien n'est enregistré avant votre validation.</b></p></div>
      <div><button class="btn btn-ghost" onclick="setView('conv')">Retour aux conventions</button></div></div>
      ${steps}<div id="wizBody">${inner}</div>`;
  }
  return `${lockBanner()}
  <div class="page-head"><div class="eyebrow">${esc(currentClient().name)} · ${TRI_LABEL(state.period.trimestre)} ${state.period.annee}</div><h1>Import de factures</h1><p>Assistant contrôlé : analyse du fichier, correspondance des colonnes, contrôle de cohérence et aperçu. <b>Rien n'est enregistré avant votre confirmation</b> — un import peut ensuite être annulé.</p></div>
  ${steps}
  <div id="wizBody">${inner}</div>
  <div id="docsList" style="margin-top:26px"></div>`;
}
function drawWizard() {
  const conv = wizIsConv();
  const locked = !conv && currentPeriodLocked();
  const step = state.wiz.step;
  let inner = '';
  if (!can('import')) {
    inner = `<div class="card"><div class="empty"><div class="ic">${svgI('lock', '')}</div><h4>Accès en lecture seule</h4><p>Votre rôle permet de consulter et d'exporter les données, pas d'en importer. Demandez à un administrateur de l'espace si vous avez besoin de ce droit.</p></div></div>`;
  } else if (locked) {
    inner = `<div class="card"><div class="empty"><div class="ic">${svgI('lock', '')}</div><h4>Import impossible sur une période clôturée</h4><p>La période <b>${TRI_LABEL(state.period.trimestre)} ${state.period.annee}</b> est figée. Choisissez une autre période ou demandez une réouverture motivée à un administrateur.</p></div></div>`;
  } else if (step === 'upload') {
    const ctx = conv
      ? `<span>Client <b>${esc(currentClient().name)}</b></span><span>Colonnes libres : nom fournisseur, ICE, IF, RC, convention, délai conventionnel…</span>`
      : `<span>Client <b>${esc(currentClient().name)}</b></span><span>Période de rattachement <b>${TRI_LABEL(state.period.trimestre)} ${state.period.annee}</b></span>`;
    const fmts = (conv ? ['XLSX', 'XLS'] : ['XLSX', 'XLS', 'CSV', 'XML SIMPL']).map(f => `<span class="badge">${f}</span>`).join('');
    inner = `<div class="card"><div class="card-b">
      <div class="wiz-ctx">${ctx}</div>
      <div class="dropzone" id="dz" role="button" tabindex="0" aria-label="Choisir un fichier à importer"><div class="ic">${svgI('up', '')}</div>
        <b>Déposez votre fichier ici</b><div style="margin-top:6px">ou cliquez pour parcourir · un fichier à la fois, analysé avant tout enregistrement</div><div class="fmt">${fmts}</div></div>
      <input type="file" id="file" accept="${conv ? '.xlsx,.xls' : '.xlsx,.xls,.csv,.xml'}" class="hidden">
    </div></div>`;
  } else if (step === 'map') { inner = wizMapHtml(); }
  else if (step === 'preview') { inner = wizPreviewHtml(); }
  else if (step === 'done') { inner = wizDoneHtml(); }
  $('#view').innerHTML = wizScaffold(inner);
  if (step === 'upload' && !locked && can('import')) {
    const dz = $('#dz'), fi = $('#file');
    dz.onclick = () => fi.click();
    dz.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fi.click(); } };
    dz.ondragover = e => { e.preventDefault(); dz.classList.add('drag'); };
    dz.ondragleave = () => dz.classList.remove('drag');
    dz.ondrop = e => { e.preventDefault(); dz.classList.remove('drag'); if (e.dataTransfer.files.length) wizAnalyze(e.dataTransfer.files[0]); };
    fi.onchange = () => { if (fi.files.length) wizAnalyze(fi.files[0]); };
  }
  if (step === 'map') wizWireMap();
  if (step === 'preview') wizWirePreview();
  if (step === 'done') wizWireDone();
  if (!conv) renderDocs();
}
async function wizAnalyze(file) {
  $('#wizBody').innerHTML = `<div class="card"><div class="card-b row-12"><span class="spin"></span><div><b>Analyse de « ${esc(file.name)} »</b><div class="dh t-sm">Détection des feuilles, de la ligne d'en-tête et des colonnes — aucune donnée n'est encore enregistrée.</div></div></div></div>`;
  try {
    const fd = new FormData(); fd.append('file', file);
    if (wizIsConv()) fd.append('kind', 'conventions');
    const a = await api(`/clients/${state.clientId}/import/analyze`, { method: 'POST', body: fd });
    if (a.xml && !wizIsConv()) { // relevé XML : mapping implicite → import direct via route legacy
      state.wiz = { step: 'preview', token: a.token, sourceName: a.sourceName, xml: true, analyse: a, sheet: null, headerRow: 0, mapping: {} };
      return wizPreview(); // preview gérera le cas XML côté serveur ? → on route vers confirm direct
    }
    const sug = a.feuilles.find(f => f.nom === a.suggestion) || a.feuilles[0];
    if (!sug) { toast(`Aucune feuille exploitable détectée dans ce fichier. Vérifiez qu'il contient ${wizIsConv() ? 'une liste de fournisseurs / conventions' : 'un tableau de factures'}.`, 'err', 'Fichier non reconnu'); state.wiz = { step: 'upload' }; drawWizard(); return; }
    state.wiz = { step: 'map', token: a.token, sourceName: a.sourceName, analyse: a, sheet: sug.nom, headerRow: sug.ligneEntete, mapping: sheetMapping(sug), requireNumero: false };
    drawWizard();
  } catch (e) { toast(e.message, 'err'); state.wiz = { step: 'upload' }; drawWizard(); }
}
function sheetMapping(sheet) { const m = {}; for (const [k, v] of Object.entries(sheet.mapping || {})) m[k] = v.col; return m; }
function curSheet() { return state.wiz.analyse.feuilles.find(f => f.nom === state.wiz.sheet) || state.wiz.analyse.feuilles[0]; }
function wizMapHtml() {
  const a = state.wiz.analyse, sheet = curSheet();
  const champs = a.champs;
  // .filter(Boolean) : tolérance aux colonnes vides/nulles (en-têtes lacunaires).
  const colOpts = (sel) => `<option value="">— non mappé —</option>` + (sheet.colonnes || []).filter(Boolean).map(c => `<option value="${c.index}" ${sel == c.index ? 'selected' : ''}>${esc(c.label || ('Colonne ' + (c.index + 1)))}</option>`).join('');
  const autoM = sheet.mapping || {};
  const lowN = champs.filter(ch => autoM[ch.key] && autoM[ch.key].confidence < 0.5).length;
  const missN = champs.filter(ch => ch.requis && state.wiz.mapping[ch.key] == null).length;
  return `<div class="card"><div class="card-h"><div><h3>Correspondance des colonnes — ${esc(state.wiz.sourceName || '')}</h3><div class="sub">Vérifiez chaque correspondance proposée · champs requis marqués <span class="c-late">*</span></div></div>
      <div class="selctb"><label class="dh" for="wizSheet" style="font-size:var(--fs-sm);white-space:nowrap">Feuille</label><select id="wizSheet">${a.feuilles.map(f => `<option value="${esc(f.nom)}" ${f.nom === state.wiz.sheet ? 'selected' : ''}>${esc(f.nom)}${f.ignoree ? ' (grand-livre — ignorée)' : ''} · ${f.nbLignes} lignes</option>`).join('')}</select></div></div>
    <div class="card-b">
      ${missN ? `<div class="note note-danger">${svgI('stop')}<div><div class="note-t">${missN} champ(s) requis sans colonne</div>Associez une colonne à chaque champ marqué * avant de passer à l'aperçu.</div></div>` : ''}
      ${lowN ? `<div class="note note-warn">${svgI('warn')}<div><div class="note-t">${lowN} correspondance(s) à faible confiance</div>La colonne proposée ressemble peu au champ attendu. Vérifiez l'aperçu des valeurs à droite avant de continuer.</div></div>` : ''}
      <div class="map-head"><span>Champ DelaiPay</span><span>Colonne du fichier</span><span>Confiance · aperçu des valeurs</span></div>
      <div class="map-grid">${champs.map(ch => {
        const auto = autoM[ch.key]; const conf = auto ? Math.round(auto.confidence * 100) : 0;
        const confCls = conf >= 85 ? 'cf-high' : conf >= 50 ? 'cf-med' : 'cf-low';
        const sel = state.wiz.mapping[ch.key];
        const rowCls = ch.requis && (sel == null || sel === '') ? 'missing' : (auto && conf < 50 ? 'low' : '');
        return `<div class="map-row ${rowCls}">
          <div class="map-field">${esc(ch.label)}${ch.requis ? '<span class="req" title="Champ requis">*</span>' : ''}</div>
          <div class="map-pick"><select data-field="${ch.key}" class="mapsel">${colOpts(sel)}</select></div>
          <div class="map-conf">${auto ? `<span class="cf ${confCls}" title="${conf >= 85 ? 'Confiance élevée' : conf >= 50 ? 'Confiance moyenne : vérifiez' : 'Confiance faible : à vérifier impérativement'}">${conf} %</span>` : (sel != null && sel !== '' ? '<span class="cf cf-med">manuel</span>' : '<span class="dh t-xs">non associé</span>')}
            ${auto && auto.apercu && auto.apercu.length ? `<span class="map-sample" title="${esc(auto.apercu.join(' · '))}">${esc(auto.apercu.slice(0, 3).join(' · '))}</span>` : ''}</div>
        </div>`;
      }).join('')}</div>
      ${wizIsConv() ? '' : `<label class="wiz-opt"><input type="checkbox" id="wizReqNum" ${state.wiz.requireNumero ? 'checked' : ''}> Exiger un n° de facture (sinon référence technique générée + anomalie)</label>`}
      <div class="wiz-actions"><button class="btn btn-ghost" id="wizBack">Changer de fichier</button><span class="grow"></span><button class="btn btn-primary" id="wizToPreview">Contrôler et prévisualiser ${svgI('arrow')}</button></div>
    </div></div>`;
}
function wizWireMap() {
  $('#wizSheet').onchange = e => { state.wiz.sheet = e.target.value; const s = curSheet(); state.wiz.headerRow = s.ligneEntete; state.wiz.mapping = sheetMapping(s); drawWizard(); };
  $$('#wizBody .mapsel').forEach(sel => sel.onchange = () => { const v = sel.value; if (v === '') delete state.wiz.mapping[sel.dataset.field]; else state.wiz.mapping[sel.dataset.field] = +v; });
  const rq = $('#wizReqNum'); if (rq) rq.onchange = e => state.wiz.requireNumero = e.target.checked;
  $('#wizBack').onclick = () => { state.wiz = { step: 'upload' }; drawWizard(); };
  $('#wizToPreview').onclick = () => wizPreview();
}
async function wizPreview() {
  // Contrôle des champs requis — déduits des champs déclarés par l'analyse (générique factures / conventions).
  const champs = (state.wiz.analyse && state.wiz.analyse.champs) || [];
  const req = champs.filter(c => c.requis).map(c => c.key);
  const missing = req.filter(k => state.wiz.mapping[k] == null);
  if (missing.length && !state.wiz.xml) { toast('Champs requis non mappés : ' + missing.map(k => (champs.find(c => c.key === k) || {}).label || k).join(', '), 'err'); return; }
  state.wiz.step = 'preview';
  $('#view').innerHTML = wizScaffold(`<div class="card"><div class="card-b row-12"><span class="spin"></span><div><b>Contrôle de cohérence et aperçu</b><div class="dh t-sm">Chaque ligne est vérifiée (montants, dates, fournisseur, doublons) — rien n'est encore enregistré.</div></div></div></div>`);
  try {
    const body = { token: state.wiz.token, sheetName: state.wiz.sheet, headerRow: state.wiz.headerRow, mapping: state.wiz.mapping, sourceName: state.wiz.sourceName };
    const pv = wizIsConv()
      ? await api(`/clients/${state.clientId}/conventions/preview`, { method: 'POST', body })
      : await api(`/clients/${state.clientId}/import/preview${perQuery()}`, { method: 'POST', body: { ...body, requireNumero: state.wiz.requireNumero } });
    state.wiz.preview = pv; drawWizard();
  } catch (e) { toast(e.message, 'err'); state.wiz.step = 'map'; drawWizard(); }
}
function wizPreviewHtml() {
  if (wizIsConv()) return wizConvPreviewHtml();
  const pv = state.wiz.preview || { stats: {}, apercu: {} }; const s = pv.stats;
  const mism = s.autrePeriode > 0;
  const val = pv.validation || { ok: true, errors: [], warnings: [] };
  const blocked = !val.ok;
  const rowsHtml = (arr, cls) => (arr || []).slice(0, 8).map(l => `<tr class="${cls}"><td class="mono"><b>Ligne ${l.ligne}</b></td><td>${esc(LIGNE_STATUT_FR[l.statut] || l.statut)}</td><td>${esc(l.motif || (l.avertissements || []).join(', ') || '—')}</td><td class="dh">${esc((l.brut || []).filter(Boolean).slice(0, 5).join(' · ')).slice(0, 90)}</td></tr>`).join('');
  const valBox = blocked
    ? `<div class="note note-danger" role="alert">${svgI('stop')}<div><div class="note-t">Correspondance incohérente — import bloqué</div>
        La protection anti-corruption a détecté des colonnes qui ne correspondent pas aux champs attendus. Aucune donnée ne peut être enregistrée tant que ce n'est pas corrigé.
        <ul>${[...(val.errors || []), ...(val.warnings || [])].map(e => `<li>${esc(plainMsg(e.message))}</li>`).join('')}</ul>
        <div class="mt-8"><b>Comment corriger :</b> revenez à l'étape « Correspondance » et associez la bonne colonne à chaque champ signalé.</div></div></div>`
    : (val.warnings && val.warnings.length ? `<div class="note note-warn">${svgI('warn')}<div><div class="note-t">Points à vérifier avant de confirmer</div><ul>${val.warnings.map(e => `<li>${esc(plainMsg(e.message))}</li>`).join('')}</ul></div></div>` : '');
  const cohBox = (pv.sommeBruteTtc != null && !blocked)
    ? `<div class="note note-info">${svgI('info')}<div>Contrôle de cohérence : total TTC retenu (lignes valides) <b class="mono">${money(s.totalTtc)} DH</b> · somme brute de la colonne TTC associée <b class="mono">${money(pv.sommeBruteTtc)} DH</b>. Un écart s'explique par les lignes ignorées ou rejetées ci-dessous.</div></div>`
    : '';
  return `<div class="card"><div class="card-h"><div><h3>Validation et aperçu — ${esc(state.wiz.sourceName)}</h3><div class="sub">Feuille « ${esc(pv.feuille || '')} » · rattachement ${TRI_LABEL(state.period.trimestre)} ${state.period.annee} · rien n'est encore enregistré</div></div></div>
    <div class="card-b">
      ${valBox}
      <div class="stat-strip">
        <div class="stat"><div class="l">Lignes analysées</div><div class="v">${s.total || 0}</div></div>
        <div class="stat ok"><div class="l">Valides</div><div class="v">${s.valides || 0}</div></div>
        <div class="stat"><div class="l">Ignorées</div><div class="v">${s.ignorees || 0}</div></div>
        <div class="stat ${s.rejetees ? 'late' : ''}"><div class="l">Rejetées</div><div class="v">${s.rejetees || 0}</div></div>
        <div class="stat ${s.doublons ? 'warn' : ''}"><div class="l">Doublons potentiels</div><div class="v">${s.doublons || 0}</div></div>
        <div class="stat"><div class="l">Total TTC (valides)</div><div class="v">${money(s.totalTtc)}<small>DH</small></div></div>
      </div>
      ${cohBox}
      ${mism ? `<div class="note ${s.memePeriode ? 'note-warn' : 'note-danger'}" role="alert">${svgI(s.memePeriode ? 'cal' : 'stop')}<div><div class="note-t">${s.memePeriode ? `${s.autrePeriode} ligne(s) ne relèvent pas de ${TRI_LABEL(state.period.trimestre)} ${state.period.annee}` : `Aucune ligne ne relève de ${TRI_LABEL(state.period.trimestre)} ${state.period.annee}`}</div>
        ${s.memePeriode ? 'Critère : trimestre de la date de paiement (date de facture si la facture n’est pas payée). Elles seraient rattachées à cette période (la période d’origine est conservée).' : 'Critère : trimestre de la date de paiement. Ce fichier semble concerner un autre trimestre : choisissez le bon trimestre dans la barre de période, puis relancez l’import.'}
        <label class="check mt-8"><input type="checkbox" id="wizAckPer" ${state.wiz.accepteHorsPeriode ? 'checked' : ''}> Je confirme le rattachement de ces ${s.autrePeriode} ligne(s) à <b>${TRI_LABEL(state.period.trimestre)} ${state.period.annee}</b></label></div></div>` : ''}
      ${s.doublons ? `<div class="note note-warn">${svgI('warn')}<div>${s.doublons} doublon(s) potentiel(s) : ces factures sont <b>conservées</b> et signalées « Doublon ? » dans la feuille de délais pour revue (paiement partiel ou facture scindée possible). Rien n'est supprimé.</div></div>` : ''}
      ${s.rejetees ? `<h4 class="sub-h">Lignes rejetées — numéro de ligne réel du fichier</h4><div class="table-wrap flat"><table><thead><tr><th>Ligne</th><th>Statut</th><th>Motif</th><th>Données</th></tr></thead><tbody>${rowsHtml(pv.apercu.rejetees, 'rej')}</tbody></table></div>` : ''}
      ${s.ignorees ? `<details class="mt-12"><summary class="dh" style="cursor:pointer">${s.ignorees} ligne(s) ignorée(s) (total, sous-total, ligne vide…)</summary><div class="table-wrap flat mt-8"><table><thead><tr><th>Ligne</th><th>Statut</th><th>Motif</th><th>Données</th></tr></thead><tbody>${rowsHtml(pv.apercu.ignorees, 'ign')}</tbody></table></div></details>` : ''}
      <div class="wiz-actions"><button class="btn btn-ghost" id="wizBack2">Revenir à la correspondance</button><span class="grow"></span>
        <button class="btn btn-primary" id="wizConfirm" ${(!s.valides || blocked || (mism && !state.wiz.accepteHorsPeriode)) ? 'disabled' : ''} title="${blocked ? 'Corrigez la correspondance incohérente pour continuer' : (mism && !state.wiz.accepteHorsPeriode ? 'Confirmez d’abord le rattachement des lignes hors période' : '')}">${svgI('check')}Confirmer l'import dans ${TRI_LABEL(state.period.trimestre)} ${state.period.annee} (${s.valides || 0} facture${(s.valides || 0) > 1 ? 's' : ''})</button></div>
    </div></div>`;
}
// Prévisualisation de l'import des CONVENTIONS (mapping libre) — vrais numéros de ligne dans les erreurs.
function wizConvPreviewHtml() {
  const r = state.wiz.preview || {};
  const lignes = (r.lignes || []);
  const probl = lignes.filter(l => l.statut === 'rejetee' || l.statut === 'a_verifier' || l.statut === 'conflit');
  const rowsHtml = (arr) => arr.slice(0, 12).map(l => `<tr class="${l.statut === 'rejetee' ? 'rej' : 'ign'}"><td class="mono">Ligne ${l.ligne}</td><td>${esc(CONV_STATUT_LABEL[l.statut] || l.statut)}</td><td>${esc(l.fournisseur || '—')}</td><td>${esc(l.motif || '—')}</td></tr>`).join('');
  return `<div class="card"><div class="card-h"><h3>Prévisualisation — ${esc(state.wiz.sourceName)}</h3><div class="sub">Feuille « ${esc(state.wiz.sheet || '')} » · ${esc(currentClient().name)} · aucune donnée enregistrée</div></div>
    <div class="card-b">
      <div class="stat-strip">
        <div class="stat"><div class="l">Lignes analysées</div><div class="v">${r.analyzed || 0}</div></div>
        <div class="stat ok"><div class="l">Conventions à créer</div><div class="v">${r.conventionsCreated || 0}</div></div>
        <div class="stat"><div class="l">Sans convention</div><div class="v">${r.withoutConvention || 0}</div></div>
        <div class="stat ${r.duplicates ? 'warn' : ''}"><div class="l">Doublons</div><div class="v">${r.duplicates || 0}</div></div>
        <div class="stat ${r.conflicts ? 'warn' : ''}"><div class="l">Conflits</div><div class="v">${r.conflicts || 0}</div></div>
        <div class="stat ${r.toReview ? 'warn' : ''}"><div class="l">À vérifier</div><div class="v">${r.toReview || 0}</div></div>
        <div class="stat ${r.rejected ? 'late' : ''}"><div class="l">Rejetées</div><div class="v">${r.rejected || 0}</div></div>
        <div class="stat"><div class="l">Ignorées</div><div class="v">${r.ignored || 0}</div></div>
      </div>
      ${r.conflicts ? `<div class="note note-warn">${svgI('warn')}<div><div class="note-t">${r.conflicts} conflit(s)</div>Une convention différente existe déjà pour ces fournisseurs : elle n'est <b>jamais écrasée</b>. Vérifiez les lignes ci-dessous.</div></div>` : ''}
      ${probl.length ? `<h4 class="sub-h">Lignes à corriger — numéro de ligne réel du fichier Excel</h4><div class="table-wrap flat"><table><thead><tr><th>Ligne</th><th>Statut</th><th>Fournisseur</th><th>Motif</th></tr></thead><tbody>${rowsHtml(probl)}</tbody></table></div>` : `<div class="note note-ok">${svgI('checkc')}<div>Aucune anomalie détectée sur ce fichier.</div></div>`}
      <div class="wiz-actions"><button class="btn btn-ghost" id="wizBack2">Revenir à la correspondance</button><span class="grow"></span>
        <button class="btn btn-primary" id="wizConfirm" ${!(r.conventionsCreated || r.withoutConvention) ? 'disabled' : ''}>${svgI('check')}Confirmer l'import (${r.conventionsCreated || 0} convention${(r.conventionsCreated || 0) > 1 ? 's' : ''})</button></div>
    </div></div>`;
}
function wizWirePreview() {
  $('#wizBack2').onclick = () => { state.wiz.step = 'map'; state.wiz.accepteHorsPeriode = false; drawWizard(); };
  const ack = $('#wizAckPer'); if (ack) ack.onchange = () => { state.wiz.accepteHorsPeriode = ack.checked; const c = $('#wizConfirm'); if (c) c.disabled = !ack.checked; };
  const c = $('#wizConfirm'); if (c) c.onclick = () => wizConfirm();
}
async function wizConfirm() {
  const btn = $('#wizConfirm'); if (btn) { btn.disabled = true; btn.textContent = 'Import en cours…'; }
  try {
    const body = { token: state.wiz.token, sheetName: state.wiz.sheet, headerRow: state.wiz.headerRow, mapping: state.wiz.mapping, sourceName: state.wiz.sourceName };
    if (wizIsConv()) {
      const r = await api(`/clients/${state.clientId}/conventions/confirm`, { method: 'POST', body });
      state.wiz.result = r; state.wiz.step = 'done'; drawWizard();
      toast(`${r.conventionsCreated || 0} convention(s) créée(s).`, 'ok', 'Import confirmé');
      refreshAlertsBadge();
    } else {
      const r = await api(`/clients/${state.clientId}/import/confirm${perQuery()}`, { method: 'POST', body: { ...body, requireNumero: state.wiz.requireNumero, strictPeriode: true, accepteHorsPeriode: !!state.wiz.accepteHorsPeriode } });
      await refreshPeriodsKeep();   // la nouvelle période importée apparaît immédiatement (sélecteur, onboarding)
      state.wiz.result = r; state.wiz.step = 'done'; drawWizard();
      toast(`${r.imported} facture(s) importée(s).`, 'ok', 'Import confirmé');
      refreshAlertsBadge();
    }
  } catch (e) { toast(e.message, 'err'); if (btn) { btn.disabled = false; btn.textContent = 'Confirmer l\'import'; } }
}
function wizDoneHtml() {
  const r = state.wiz.result || {};
  if (wizIsConv()) {
    return `<div class="card"><div class="card-b">
      <div class="result-hero"><div class="dlg-ic tone-ok">${svgI('checkc', '')}</div><div><h3 class="t-xl">Import des conventions terminé</h3><div class="dh">${r.conventionsCreated || 0} convention(s) créée(s) · délais appliqués aux périodes non clôturées.</div></div></div>
      <div class="stat-strip">
        <div class="stat ok"><div class="l">Conventions créées</div><div class="v">${r.conventionsCreated || 0}</div></div>
        <div class="stat"><div class="l">Sans convention</div><div class="v">${r.withoutConvention || 0}</div></div>
        <div class="stat ${r.duplicates ? 'warn' : ''}"><div class="l">Doublons</div><div class="v">${r.duplicates || 0}</div></div>
        <div class="stat ${r.conflicts ? 'warn' : ''}"><div class="l">Conflits</div><div class="v">${r.conflicts || 0}</div></div>
        <div class="stat ${r.rejected ? 'late' : ''}"><div class="l">Rejetées</div><div class="v">${r.rejected || 0}</div></div>
        <div class="stat"><div class="l">Périodes recalculées</div><div class="v">${r.recompute || 0}</div></div>
      </div>
      <div class="hint">${svgI('lock')}<span>Les périodes clôturées ne sont jamais recalculées : leurs montants restent figés.</span></div>
      <div class="wiz-actions">
        <button class="btn btn-primary" onclick="setView('conv')">Voir les conventions ${svgI('arrow')}</button>
        <button class="btn btn-ghost" onclick="setView('delais')">Feuille de délais</button>
        <button class="btn btn-ghost" id="wizNew">Importer un autre fichier</button>
      </div></div></div>`;
  }
  return `<div class="card"><div class="card-b">
      <div class="result-hero"><div class="dlg-ic tone-ok">${svgI('checkc', '')}</div><div><h3 class="t-xl">Import terminé</h3><div class="dh">${r.imported || 0} facture(s) enregistrée(s) sur ${TRI_LABEL(state.period.trimestre)} ${state.period.annee} · retards et amendes calculés.</div></div></div>
      <div class="stat-strip">
        <div class="stat ok"><div class="l">Factures créées</div><div class="v">${r.imported || 0}</div></div>
        <div class="stat"><div class="l">Ignorées</div><div class="v">${r.ignored || 0}</div></div>
        <div class="stat ${r.rejected ? 'late' : ''}"><div class="l">Rejetées</div><div class="v">${r.rejected || 0}</div></div>
        <div class="stat ${r.duplicates ? 'warn' : ''}"><div class="l">Doublons potentiels</div><div class="v">${r.duplicates || 0}</div></div>
        <div class="stat"><div class="l">TTC importé</div><div class="v">${money(r.totalTtc)}<small>DH</small></div></div>
      </div>
      <div class="wiz-actions">
        ${state.onboarding && !state.onboarding.complete ? `<button class="btn btn-primary" onclick="setView('onboarding')">Revenir à la configuration ${svgI('arrow')}</button>` : ''}
        <button class="btn ${state.onboarding && !state.onboarding.complete ? 'btn-ghost' : 'btn-primary'}" onclick="setView('delais')">Voir les délais de paiement ${svgI('arrow')}</button>
        ${(r.rejected || r.ignored || r.duplicates) ? `<a class="btn btn-ghost" href="/api/imports/${r.importId}/rejections.csv">${svgI('dl')}Rapport des rejets (CSV)</a>` : ''}
        <button class="btn btn-ghost" id="wizNew">Importer un autre fichier</button><span class="grow"></span>
        <button class="btn btn-danger-ghost" id="wizCancel" data-perm="import">Annuler cet import</button>
      </div></div></div>`;
}
function wizWireDone() {
  $('#wizNew').onclick = () => { state.wiz = { step: 'upload' }; drawWizard(); };
  const cancel = $('#wizCancel'); if (!cancel) return;
  cancel.onclick = async () => {
    const r = state.wiz.result; if (!r) return;
    if (!await ui.confirm({ tone: 'danger', title: 'Annuler cet import ?', message: `Les ${r.imported} facture(s) créée(s) par cet import seront retirées. Le fichier source est conservé et l'annulation est tracée.`, confirmLabel: 'Annuler l\'import' })) return;
    try { const x = await api(`/clients/${state.clientId}/import/${r.importId}/cancel`, { method: 'POST', body: {} }); toast(`Import annulé (${x.facturesSupprimees} facture(s) retirée(s)).`, 'ok'); state.wiz = { step: 'upload' }; drawWizard(); refreshAlertsBadge(); }
    catch (e) { toast(e.message, 'err'); }
  };
}
async function renderDocs() {
  const wrap = $('#docsList'); if (!wrap) return;
  const docs = await api(`/clients/${state.clientId}/documents${perQuery()}`);
  const locked = currentPeriodLocked();
  wrap.innerHTML = `<div class="card"><div class="card-h"><div><h3>Historique des imports</h3><div class="sub">${docs.length} fichier(s) · ${esc(currentClient().name)} · ${TRI_LABEL(state.period.trimestre)} ${state.period.annee}</div></div></div>
    ${docs.length ? `<div class="table-wrap flat b-0"><table style="min-width:640px"><thead><tr><th>Fichier</th><th class="num">Factures</th><th>Importé le</th><th></th></tr></thead>
      <tbody>${docs.map(d => `<tr><td><b>${esc(d.nom)}</b></td><td class="num">${d.nb_factures || 0}</td><td class="mono dh">${esc(dateTimeFr((d.created_at || '').replace('T', ' ')))}</td>
        <td style="text-align:right;white-space:nowrap"><a class="btn btn-quiet btn-sm" href="/api/clients/${state.clientId}/documents/${d.id}/download">${svgI('dl')}Télécharger</a>
          ${d.import_lot_id ? `<a class="btn btn-quiet btn-sm" href="/api/imports/${d.import_lot_id}/rejections.csv">Rejets</a>` : ''}
          ${locked ? '' : `<button class="btn btn-danger-ghost btn-sm" data-perm="import" data-del="${d.id}" data-nb="${d.nb_factures || 0}" data-nom="${esc(d.nom)}">Supprimer</button>`}</td></tr>`).join('')}</tbody></table></div>`
    : `<div class="card-b dh">Aucun fichier importé pour cette période.</div>`}</div>`;
  $$('#docsList [data-del]').forEach(b => b.onclick = async () => {
    if (!await ui.confirm({ tone: 'danger', title: `Supprimer « ${b.dataset.nom} » ?`, message: `Les ${b.dataset.nb} facture(s) importée(s) depuis ce fichier seront également retirées.`, confirmLabel: 'Supprimer le fichier' })) return;
    api(`/clients/${state.clientId}/documents/${b.dataset.del}`, { method: 'DELETE' })
      .then(r => { toast(`Fichier supprimé (${r.facturesSupprimees} facture(s) retirée(s)).`, 'ok'); renderDocs(); refreshAlertsBadge(); })
      .catch(e => toast(e.message, 'err'));
  });
}

/* ============================== CONVENTIONS ============================== */
// Libellés lisibles (jamais de jargon technique côté experte-comptable).
const LIGNE_STATUT_FR = { valide: 'Valide', rejetee: 'Rejetée', ignoree: 'Ignorée', a_verifier: 'À vérifier', doublon: 'Doublon potentiel', conflit: 'Conflit à vérifier', hors_periode: 'Hors période' };
const CONV_STATUT_LABEL = { creee: 'Convention créée', doublon: 'Doublon (déjà présente)', conflit: 'Conflit à vérifier', sans_convention: 'Sans convention', a_verifier: 'À vérifier', rejetee: 'Rejetée', ignoree: 'Ignorée' };
async function renderConv() {
  if (!state.clientId) return noClient();
  const rows = await api(`/clients/${state.clientId}/conventions${perQuery()}`);
  const S = { 'Trouvée': ['pill-ok', 'En vigueur'], 'Bientôt expirée': ['pill-warn', 'Expire bientôt'], 'Expirée': ['pill-late', 'Expirée'], 'Absente': ['pill-late', 'Absente'] };
  const SRC = { convention: ['conv', 'convention'], operateur_reseau: ['b30', 'réseau'], standard: ['b60', 'légal'] };
  const applied = rows.filter(c => c.appliquee).length, missingDoc = rows.filter(c => !c.fichier).length;
  const rule = c => { const r = c.regle_fournisseur; if (!r) return '<span class="dh">—</span>';
    const [cls, lbl] = SRC[r.source] || ['b60', r.source];
    if (c.appliquee && c.hors_validite) return `<span class="pill pill-sm pill-warn" title="Le calcul applique la convention en vigueur selon son statut (règle LOT 4), mais ses dates ne couvrent pas la période consultée. Question ouverte pour l’expert-comptable.">${svgI('warn', '')}Appliquée hors de sa période de validité — à confirmer</span>`;
    if (c.appliquee) return `<span class="pill pill-sm pill-ok">${svgI('check', '')}Appliquée</span>`;
    return `<span class="dh t-sm">Non appliquée — règle en vigueur : </span><span class="badge ${cls}">${r.delai} j <small>${lbl}</small></span>`; };
  $('#view').innerHTML = `
  ${clientPeriodBar(null, false)}
  <div class="page-head headrow"><div><div class="eyebrow">${esc(currentClient().name)}</div><h1>Conventions fournisseurs</h1><p>Conventions de délai de paiement et justificatifs signés. <b>Les documents sont archivés : aucune extraction automatique n'est effectuée</b> — le délai est toujours celui que vous saisissez.</p></div>
    <div class="actions">
      <a class="btn btn-quiet" href="/api/conventions/template.xlsx" title="Fichier Excel prêt à remplir">${svgI('dl')}Modèle Excel</a>
      <button class="btn btn-ghost" id="impConv" data-perm="manage_conventions" title="Assistant : associez librement les colonnes de votre fichier Excel">${svgI('up')}Importer une liste</button>
      <button class="btn btn-primary" id="newConv" data-perm="manage_conventions">${svgI('plus')}Nouvelle convention</button></div></div>
  ${rows.length ? `<div class="stat-strip">
      <div class="stat"><div class="l">Conventions enregistrées</div><div class="v">${rows.length}</div></div>
      <div class="stat ok"><div class="l">Appliquées au calcul</div><div class="v">${applied}</div></div>
      <div class="stat ${missingDoc ? 'warn' : ''}"><div class="l">Justificatif manquant</div><div class="v">${missingDoc}</div></div></div>
    <div class="hint">${svgI('info')}<span>Règle appliquée à un fournisseur : <b>opérateur de réseau confirmé (30 j)</b> › <b>convention en vigueur la plus récente</b> › <b>délai légal (60 j)</b>. La colonne « Règle » indique si la convention est celle réellement utilisée.</span></div>
    <div class="table-wrap"><table class="dense rc"><thead><tr><th>Fournisseur (ICE)</th><th class="num">Délai convenu</th><th>Règle</th><th data-prio="2">Validité</th><th>Statut</th><th>Justificatif</th><th class="col-act"><span class="sr-only">Actions</span></th></tr></thead>
    <tbody>${rows.map(c => { const st = S[c.statut] || ['pill-ok', c.statut]; return `<tr data-conv-id="${c.id}" class="${state._convFocus === c.id ? 'row-focus' : ''}"><td data-rc="t"><div class="fournisseur"><b>${esc(c.fournisseur || '—')}</b><small>${esc(c.four_ice || c.four_if || '')}</small></div></td>
      <td class="num" data-rc="a"><span class="badge conv">${c.delai} j</span></td>
      <td data-rc="s">${rule(c)}</td>
      <td class="dh nowrap" data-prio="2">${c.date_debut ? `<span class="mono">${dateFr(c.date_debut)}</span> → ` : ''}${c.date_fin ? `<span class="mono">${dateFr(c.date_fin)}</span>` : 'Durée indéterminée'}</td>
      <td data-rc="s"><span class="pill pill-sm ${st[0]}"><span class="dot"></span>${esc(st[1])}</span></td>
      <td data-rc="s">${c.fichier
        ? `<a href="/api/conventions/${c.fichier}/file" target="_blank" rel="noopener">${svgI('doc')} Voir</a> <button class="btn btn-quiet btn-xs" data-perm="manage_conventions" data-replacepdf="${c.id}">Remplacer</button>`
        : `<span class="pill pill-sm pill-warn">Manquant</span> <button class="btn btn-ghost btn-xs" data-perm="manage_conventions" data-addpdf="${c.id}">Ajouter</button>`}</td>
      <td class="col-act" data-rc="s"><button class="btn btn-ghost btn-sm" data-perm="manage_conventions" data-editc="${c.id}">Modifier</button> <button class="btn btn-quiet btn-sm row-del" data-perm="manage_conventions" data-delc="${c.id}" data-four="${esc(c.fournisseur || '')}" title="Supprimer la convention de ${esc(c.fournisseur || 'ce fournisseur')}">${svgI('trash')}<span>Supprimer</span></button></td></tr>`; }).join('')}</tbody></table></div>`
    : emptyBox('Aucune convention', 'Importez la liste des conventions depuis Excel ou ajoutez-les une à une. Sans convention, le délai légal de 60 jours s\'applique.', null, null, 'doc')}`;
  wireClientBar(renderConv);
  if ($('#newConv')) $('#newConv').onclick = convModal;
  // Import via l'ASSISTANT (mapping libre des colonnes) — même composant que l'import TVA.
  if ($('#impConv')) $('#impConv').onclick = () => openConvWizard();
  $$('#view [data-addpdf]').forEach(b => b.onclick = () => attachConvPdf(b, b.dataset.addpdf, false));
  $$('#view [data-editc]').forEach(b => b.onclick = () => editConvModal(rows.find(x => x.id === b.dataset.editc)));
  if (state._convFocus) { const tr = $(`#view tr[data-conv-id="${state._convFocus}"]`); if (tr) setTimeout(() => tr.scrollIntoView({ block: 'center' }), 60); state._convFocus = null; }
  $$('#view [data-replacepdf]').forEach(b => b.onclick = async () => {
    if (await ui.confirm({ tone: 'warn', title: 'Remplacer le justificatif ?', message: 'Le document déjà rattaché à cette convention sera remplacé par le nouveau fichier.', confirmLabel: 'Choisir le nouveau fichier' })) attachConvPdf(b, b.dataset.replacepdf, true);
  });
  $$('#view [data-delc]').forEach(b => b.onclick = async () => {
    if (!await ui.confirm({ tone: 'danger', title: `Supprimer la convention de « ${b.dataset.four} » ?`, message: 'Le délai applicable redeviendra celui de la règle suivante (réseau ou légal 60 j). Les retards des périodes non clôturées seront recalculés ; les périodes clôturées restent figées.', confirmLabel: 'Supprimer la convention' })) return;
    api(`/clients/${state.clientId}/conventions/${b.dataset.delc}`, { method: 'DELETE' })
      .then(() => { toast('Convention supprimée.', 'ok'); renderConv(); refreshAlertsBadge(); })
      .catch(e => toast(e.message, 'err'));
  });
}

// Ajout / remplacement d'un document (PDF/JPEG/PNG — archivé, jamais analysé), avec loader et bouton désactivé.
function attachConvPdf(btn, convId, replace) {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png';
  inp.onchange = async () => {
    if (!inp.files[0]) return;
    const old = btn.innerHTML; btn.disabled = true; btn.innerHTML = 'Envoi…';
    const fd = new FormData(); fd.append('file', inp.files[0]);
    try {
      await api(`/clients/${state.clientId}/conventions/${convId}/file${replace ? '?replace=1' : ''}`, { method: 'POST', body: fd });
      toast(replace ? 'Document remplacé.' : 'Document ajouté à la convention.', 'ok'); renderConv();
    } catch (e) { toast(e.message, 'err', 'Ajout du document'); btn.disabled = false; btn.innerHTML = old; }
  };
  inp.click();
}

// Rapport d'import lisible : synthèse chiffrée + lignes à corriger + export CSV.
function showConvImportReport(r) {
  const col = { ok: 'var(--r-green)', warn: 'var(--r-orange)', bad: 'var(--r-red)' };
  const tile = (n, lbl, cls) => `<div class="kpi" style="padding:12px 14px;min-width:130px"><div class="val" style="font-size:var(--fs-2xl)${cls && n ? ';color:' + col[cls] : ''}">${n}</div><div class="lbl fw-6">${lbl}</div></div>`;
  const problems = (r.lignes || []).filter(l => l.statut !== 'ignoree');
  const rowsHtml = problems.length ? problems.map(l => `<tr>
      <td class="mono">${l.ligne}</td><td>${esc(l.fournisseur || '—')}</td>
      <td><span class="pill ${l.statut === 'rejetee' || l.statut === 'conflit' ? 'pill-red' : l.statut === 'a_verifier' ? 'pill-orange' : 'pill-ok'}">${esc(CONV_STATUT_LABEL[l.statut] || l.statut)}</span></td>
      <td>${esc(l.motif || '')}</td><td class="mono dh">${esc(l.delaiRecu || '')}</td><td class="mono dh">${esc(l.conventionRecu || '')}</td></tr>`).join('')
    : `<tr><td colspan="6" class="dh" style="text-align:center;padding:14px">Aucune ligne à corriger.</td></tr>`;
  modal(`<div class="modal-h"><h3>Résultat de l'import des conventions</h3><button class="x" onclick="closeOverlay()">${XICO}</button></div>
  <div class="modal-b">
    <div class="stat-row" style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:6px">
      ${tile(r.analyzed, 'Lignes analysées')}
      ${tile(r.conventionsCreated, 'Conventions créées', 'ok')}
      ${tile(r.suppliersCreated, 'Fournisseurs créés')}
      ${tile(r.suppliersFound, 'Fournisseurs existants')}
      ${tile(r.duplicates, 'Doublons')}
      ${tile(r.conflicts, 'Conflits', r.conflicts ? 'warn' : '')}
      ${tile(r.withoutConvention, 'Sans convention')}
      ${tile(r.toReview, 'À vérifier', r.toReview ? 'warn' : '')}
      ${tile(r.rejected, 'Rejetées', r.rejected ? 'bad' : '')}
      ${tile(r.ignored, 'Ignorées')}
    </div>
    ${r.conventionsCreated ? `<p class="dh" style="margin:8px 0">✔ ${r.conventionsCreated} convention(s) créée(s). Ajoutez les PDF signés depuis la liste (statut « Document manquant »).</p>` : ''}
    ${r.truncated ? `<p class="dh" style="margin:8px 0;color:var(--r-orange)">Liste des lignes tronquée à 1000 — utilisez l'export CSV pour la liste complète.</p>` : ''}
    <div class="table-wrap" style="max-height:320px;overflow:auto"><table style="min-width:720px"><thead><tr><th>Ligne</th><th>Fournisseur</th><th>Statut</th><th>Motif</th><th>Délai reçu</th><th>Convention reçue</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>
  </div>
  <div class="modal-f"><button class="btn btn-ghost" id="convCsv">Télécharger le rapport (CSV)</button><button class="btn btn-primary" onclick="closeOverlay()">Fermer</button></div>`);
  $('#convCsv').onclick = () => downloadConvReportCsv(r);
  // Fermer le modal recharge la liste (les nouvelles conventions apparaissent).
  const ov = $('#overlay'); if (ov) { const closeBtns = ov.querySelectorAll('.x, .btn-primary, .scrim'); closeBtns.forEach(b => b.addEventListener('click', () => renderConv(), { once: true })); }
}
function downloadConvReportCsv(r) {
  const cell = v => { let s = String(v == null ? '' : v); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  const head = ['Ligne Excel', 'Fournisseur', 'Statut', 'Motif', 'Délai reçu', 'Convention reçue'];
  const lines = [head.map(cell).join(';')];
  for (const l of (r.lignes || [])) lines.push([l.ligne, l.fournisseur, CONV_STATUT_LABEL[l.statut] || l.statut, l.motif, l.delaiRecu, l.conventionRecu].map(cell).join(';'));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = 'rapport_import_conventions.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
// Modifier les dates d'une convention (tracé à l'audit : ancien → nouveau). Le justificatif se remplace par « Ajouter / Remplacer ».
function editConvModal(c) {
  if (!c) return;
  const v = x => (x ? String(x).slice(0, 10) : '');
  modal(`<div class="modal-h"><h3>Modifier la convention — ${esc(c.fournisseur || '')}</h3><button class="x" onclick="closeOverlay()">${XICO}</button></div>
  <div class="modal-b"><div class="form-grid">
    <div><label class="fld-lbl" for="e_sig">Date de signature</label><input class="input-fld" id="e_sig" type="date" value="${v(c.date_signature)}"></div>
    <div><label class="fld-lbl" for="e_deb">Date d’effet (début)</label><input class="input-fld" id="e_deb" type="date" value="${v(c.date_debut)}"></div>
    <div><label class="fld-lbl" for="e_fin">Date de fin</label><input class="input-fld" id="e_fin" type="date" value="${v(c.date_fin)}"></div>
    <div><label class="fld-lbl">Justificatif</label><div class="t-sm mt-8">${c.fichier ? 'Présent — utilisez « Remplacer » dans la liste.' : '<span class="c-late">Manquant</span> — utilisez « Ajouter » dans la liste.'}</div></div>
  </div><div class="hint mt-12">${svgI('info')}<span>Les dates servent à la vérification des anomalies. Le calcul des délais et des amendes n’en dépend pas (la convention en vigueur s’applique selon son statut). Chaque modification est inscrite au journal d’audit.</span></div></div>
  <div class="modal-f"><button class="btn btn-ghost" onclick="closeOverlay()">Annuler</button><button class="btn btn-primary" id="e_save">Enregistrer</button></div>`);
  $('#e_save').onclick = async () => {
    try {
      const r = await api(`/clients/${state.clientId}/conventions/${c.id}`, { method: 'PATCH', body: { date_signature: $('#e_sig').value, date_debut: $('#e_deb').value, date_fin: $('#e_fin').value } });
      closeOverlay(); toast(r.unchanged ? 'Aucune modification.' : 'Dates de la convention enregistrées.', 'ok', 'Convention'); state._convFocus = c.id; renderConv(); refreshAlertsBadge();
    } catch (e) { toast(e.message, 'err', 'Modification refusée'); }
  };
}
async function convModal() {
  const fours = await api(`/clients/${state.clientId}/fournisseurs`);
  const opts = fours.map(f => `<option value="${f.id}">${esc(f.raison_sociale || f.ice || f.id)}</option>`).join('');
  modal(`<div class="modal-h"><h3>Nouvelle convention</h3><button class="x" onclick="closeOverlay()">${XICO}</button></div>
  <div class="modal-b"><div class="form-grid">
    <div class="full"><label class="fld-lbl">Fournisseur existant</label><select class="input-fld" id="v_four"><option value="">— nouveau fournisseur —</option>${opts}</select></div>
    <div><label class="fld-lbl">Nom (si nouveau)</label><input class="input-fld" id="v_nom"></div>
    <div><label class="fld-lbl">ICE</label><input class="input-fld" id="v_ice"></div>
    <div><label class="fld-lbl">Délai convenu (j) — obligatoire</label><input class="input-fld" id="v_delai" type="number" min="1" max="120" step="1" placeholder="entier 1 à 120"></div>
    <div><label class="fld-lbl" for="v_sig">Date de signature</label><input class="input-fld" id="v_sig" type="date"></div>
    <div><label class="fld-lbl" for="v_deb">Date d’effet (début)</label><input class="input-fld" id="v_deb" type="date"></div>
    <div><label class="fld-lbl" for="v_fin">Date de fin (option.)</label><input class="input-fld" id="v_fin" type="date"></div>
    <div class="full"><label class="fld-lbl">Justificatif — document signé (PDF, JPEG ou PNG)</label><input class="input-fld" id="v_file" type="file" accept=".pdf,.png,.jpg,.jpeg"></div>
  </div><div class="hint mt-12">${svgI('doc')}<span>Le document est archivé tel quel. Les informations (délai, dates, identifiants) doivent être saisies manuellement — aucune extraction automatique n'est effectuée.</span></div></div>
  <div class="modal-f"><button class="btn btn-ghost" onclick="closeOverlay()">Annuler</button><button class="btn btn-primary" id="v_save">Enregistrer</button></div>`);
  $('#v_save').onclick = async () => {
    // Délai OBLIGATOIRE et EXPLICITE : entier 1..120. Jamais de valeur par défaut (aucune extraction).
    const raw = ($('#v_delai').value || '').trim();
    if (!/^\d{1,3}$/.test(raw) || +raw < 1 || +raw > 120) {
      toast('Saisissez le délai conventionnel : un entier entre 1 et 120 jours. Aucune valeur n\'est extraite automatiquement du document.', 'err', 'Délai obligatoire');
      return;
    }
    const fd = new FormData();
    fd.append('fournisseur_id', $('#v_four').value);
    fd.append('fournisseur', $('#v_nom').value); fd.append('four_ice', $('#v_ice').value);
    fd.append('delai', raw);
    for (const [k, id] of [['date_signature', '#v_sig'], ['date_debut', '#v_deb'], ['date_fin', '#v_fin']]) if ($(id).value) fd.append(k, $(id).value);
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
  const locked = currentPeriodLocked();
  $('#view').innerHTML = `
  ${clientPeriodBar(periods)}
  ${locked ? `<div class="note note-locked">${svgI('lock')}<div><div class="note-t">Déclaration figée</div>La période est clôturée : ce tableau et ses exports CSV / XML reproduisent exactement l'état arrêté à la clôture, quelles que soient les modifications postérieures.</div></div>` : ''}
  <div class="page-head headrow"><div><div class="eyebrow">${esc(e.raison_sociale)} · T${dec.trimestre} ${dec.annee}</div><h1>Déclaration DGI — délais de paiement</h1><p>Formulaire trimestriel · articles 78-3 &amp; 78-4 (loi 15-95).</p></div>
    <div class="actions">
      <a class="btn btn-ghost" href="${base}/export.csv${perQuery()}">${svgI('dl')}CSV</a>
      <a class="btn btn-ghost" href="${base}/export.xml${perQuery()}">${svgI('dl')}XML EDI</a>
      <button class="btn btn-primary" onclick="setView('visa')">${svgI('seal')}Générer le visa</button></div></div>
  <div class="form-doc">
    <div class="doc-band"><div><h2>Déclaration des délais de paiement</h2><div class="official">Direction Générale des Impôts · Royaume du Maroc · Loi 69-21</div></div><div class="draft">${locked ? 'Figée · ' : ''}${esc(dec.statut)}</div></div>
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
      <div class="table-wrap flat"><table class="dense rc"><thead><tr><th>IF fournisseur</th><th>Raison sociale</th><th class="num">TTC</th><th class="num">Non payé</th><th class="num">Payé hors délai</th><th class="num">Retard</th><th class="num">Amende</th></tr></thead>
      <tbody>${L.length ? L.map(l => `<tr><td class="mono dh" data-rc="m" data-label="IF">${esc(l.if || '—')}</td><td data-rc="t"><b>${esc(l.nom || '—')}</b></td><td class="num" data-rc="a">${money(l.ttc)}</td><td class="num" data-rc="m" data-label="Non payé">${money(l.non_paye)}</td><td class="num" data-rc="m" data-label="Hors délai">${money(l.hors_delai)}</td><td class="num amount-late" data-rc="s" data-label="Retard">+${l.retard} j</td><td class="num amount" data-rc="s" data-label="Amende">${money(l.amende)}</td></tr>`).join('') : '<tr><td colspan="7" class="dh ta-c p-24">Aucune facture hors délai sur la période — déclaration « néant ».</td></tr>'}</tbody>
      <tfoot><tr><td colspan="2">Total</td><td class="num" data-label="TTC">${money(dec.montant_total_ttc)}</td><td class="num" data-label="Non payé">${money(dec.montant_non_paye)}</td><td class="num" data-label="Hors délai">${money(dec.montant_paye_hors_delai)}</td><td></td><td class="num amount-late" data-label="Amende">${money(dec.montant_total_amende)}</td></tr></tfoot></table></div></div>
    ${d.exclusions && d.exclusions.nbFactures ? `<div class="doc-sec"><h4>Factures d'opérateurs de réseau exclues du tableau (non comptées dans les totaux)</h4>
      <div class="dh t-sm">${d.exclusions.nbFactures} facture(s) · ${d.exclusions.nbFournisseurs} fournisseur(s) · TTC ${money(d.exclusions.ttc)} DH — <b>${esc(d.exclusions.motif)}</b>. Ces factures restent visibles dans le suivi interne (feuille de délais) mais sont volontairement exclues des tableaux déclaratifs.</div></div>` : ''}
    <div class="pay-band">
      <div><div class="eyebrow m-0">Montant à verser</div><div class="amt">${money(dec.montant_a_verser)} DH</div><div class="dh t-xs">amende ${money(dec.montant_total_amende)} + sanctions ${money(dec.sanctions_retard)}</div></div>
      <div class="visa-box"><div class="st"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 12l2 2 4-4"/></svg></div>
        <div><b class="t-md">Visa ${dec.type_visa === 'CAC' ? 'du commissaire aux comptes' : "de l'expert-comptable"}</b><div class="dh t-sm">${esc(state.me.nom)} · en attente de signature</div></div></div>
    </div>
    <div class="doc-sec" style="border-bottom:0;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;color:var(--muted);font-size:var(--fs-sm)"><span>Édité le ${dateFr(dec.date_edition)} · DelaiPay</span><span>Référence : art. 78-3 &amp; 78-4 (loi 15-95)</span></div>
  </div>`;
  wireClientBar(renderDecl);
}

/* ============================== VISA ============================== */
// Vérifications en attente d'un trimestre (VISA-1) — affichées avant le choix de conclusion et avant une clôture.
function verifList(v) {
  const it = [['ouvertes', 'anomalie(s) ouverte(s)', 'anomalies'], ['aVerifier', 'anomalie(s) couverte(s) par une convention, à vérifier', 'anomalies'],
    ['convManquantes', 'fournisseur(s) sans convention justificative', 'fournisseurs'], ['horsValidite', 'facture(s) avec une convention appliquée hors de sa période de validité', 'delais']];
  return `<ul class="verif-list">${it.filter(([k]) => v[k] > 0).map(([k, l, go]) => `<li><b>${v[k]}</b> ${l} <button class="btn-link" onclick="setView('${go}')">Voir</button></li>`).join('')}</ul>`;
}
async function renderVisa() {
  if (!state.clientId) return noClient();
  const periods = await ensurePeriod();
  // VISA-1 : aucune conclusion présélectionnée ; le choix vaut pour CE dossier et CE trimestre uniquement.
  const key = `${state.clientId}|${state.period.annee}|${state.period.trimestre}`;
  const concl = state._concl && state._concl.key === key ? state._concl.value : '';
  const sign = state._sign || (state.me && state.me.nom) || '';
  const q = `?annee=${state.period.annee}&trimestre=${state.period.trimestre}${concl ? `&conclusion=${encodeURIComponent(concl)}` : ''}${sign ? `&signataire=${encodeURIComponent(sign)}` : ''}`;
  const v = await api(`/clients/${state.clientId}/visa${q}`, { fresh: true });
  const base = `/api/clients/${state.clientId}/visa`;
  const vf = v.verifications || { total: 0 };
  const preview = v.blocks ? v.blocks.map(b => {
    const runs = (b.runs || []).map(r => { let t = esc(r.t); if (r.u) t = `<u>${t}</u>`; if (r.b) t = `<b>${t}</b>`; return t; }).join('');
    if (!runs) return '<div style="height:9px"></div>';
    return `<p style="text-align:${b.align === 'right' ? 'right' : (b.align === 'left' ? 'left' : 'justify')};margin:0 0 11px">${runs}</p>`;
  }).join('') : `<div class="empty"><div class="ic">${svgI('seal', '')}</div><h4>Choisissez la conclusion</h4><p>L’aperçu et les fichiers Word / PDF sont produits après votre choix explicite de conclusion.</p></div>`;
  $('#view').innerHTML = `
  ${clientPeriodBar(periods)}
  ${lockBanner()}
  <div class="page-head"><div class="eyebrow">${esc(currentClient().name)} · T${v.periode.trimestre} ${v.periode.annee}</div><h1>Visa ${v.type === 'CAC' ? 'du commissaire aux comptes' : "de l'expert-comptable"}</h1><p>Modèle officiel (loi 69-21) · l’aperçu est identique aux fichiers générés. Aucune conclusion n’est proposée par défaut.</p></div>
  ${vf.total ? `<div class="note note-warn">${svgI('warn')}<div><div class="note-t">Points à examiner avant de conclure — ${vf.total}</div>${verifList(vf)}</div></div>`
    : `<div class="note note-ok">${svgI('checkc')}<div><div class="note-t">Aucune vérification en attente sur ce trimestre</div>Anomalies, conventions et périodes de validité : rien à traiter.</div></div>`}
  <div class="grid-2">
    <div class="card"><div class="card-h"><h3>Paramètres du visa</h3></div><div class="card-b">
      <div class="fld"><label class="fld-lbl">Période visée</label><input class="input-fld" value="Trimestre ${v.periode.trimestre} ${v.periode.annee}${v.debut ? ` · ${v.debut} au ${v.fin}` : ''}" readonly></div>
      <div class="fld"><label class="fld-lbl">Montant visé (factures non payées dans les délais)</label><input class="input-fld mono" value="${money(v.montant_vise)} DH" readonly></div>
      <div class="fld"><label class="fld-lbl" for="conclSel">Type de conclusion <span class="c-late">*</span></label><select class="input-fld" id="conclSel" ${concl ? '' : 'aria-invalid="true"'}>
        <option value="" ${concl ? '' : 'selected'} disabled>— Choisissez une conclusion —</option>
        ${(v.conclusions || []).map(o => `<option ${o === concl ? 'selected' : ''}>${o}</option>`).join('')}</select>
        ${vf.total && concl === 'Sans observation' ? `<span class="fld-help c-late">${vf.total} point(s) restent à examiner sur ce trimestre : confirmez que « Sans observation » est bien votre conclusion.</span>` : ''}</div>
      <div class="fld"><label class="fld-lbl">Signataire</label><input class="input-fld" id="signInp" value="${esc(sign || v.signataire || '')}"></div>
      ${v.reference ? `<div class="fld"><label class="fld-lbl">Référence</label><input class="input-fld" value="${esc(v.reference)}" readonly></div>` : ''}
      <div class="actions" style="margin-top:4px">
        ${concl ? `<a class="btn btn-primary" href="${base}/export.docx${q}">${svgI('dl')}Word (.docx)</a><a class="btn btn-ghost" href="${base}/export.pdf${q}">${svgI('dl')}PDF</a>`
          : `<button class="btn btn-primary" disabled title="Choisissez d’abord la conclusion">${svgI('dl')}Word (.docx)</button><button class="btn btn-ghost" disabled>${svgI('dl')}PDF</button>`}
      </div>
    </div></div>
    <div class="card"><div class="card-h"><div><h3>Aperçu — modèle officiel</h3><div class="sub">identique au fichier Word / PDF généré</div></div></div><div class="card-b">
      <div class="doc-preview">${preview}</div>
    </div></div>
  </div>`;
  wireClientBar(renderVisa);
  $('#conclSel').onchange = e => { state._concl = { key, value: e.target.value }; renderVisa(); };
  const si = $('#signInp'); si.onchange = () => { state._sign = si.value; renderVisa(); };
}

/* ============================== ALERTES ============================== */
const GRAVITE_FR = { haute: 'Haute', moyenne: 'Moyenne', basse: 'Basse' };
const sevCls = g => (g === 'haute' ? 'h' : g === 'basse' ? 'l' : 'm');
async function renderAlerts(shown = 50) {
  const d = await api('/alerts', { fresh: true });
  const icon = a => a.type === 'echeance' ? 'cal' : a.type === 'convention' ? 'doc' : 'warn';
  const tone = a => a.statut === 'a_verifier' ? 'info' : a.gravite === 'haute' ? 'red' : 'orange';
  const list = d.alerts.slice(0, shown);
  $('#view').innerHTML = `
  <div class="page-head"><div class="eyebrow">Cabinet</div><h1>Alertes</h1><p><b>${d.count}</b> alerte(s) · conventions manquantes, anomalies à traiter et échéances déclaratives${d.count > list.length ? ` — ${list.length} affichée(s)` : ''}.</p></div>
  <div class="card">${d.alerts.length ? list.map(a => `<div class="alert-row${a.statut === 'a_verifier' ? ' is-verif' : ''}">
    <div class="al-ic ${tone(a)}">${svgI(icon(a), '')}</div>
    <div class="al-body"><div class="t">${esc(a.titre)} <span class="sev ${a.statut === 'a_verifier' ? 'muted' : sevCls(a.gravite)}">${esc(GRAVITE_FR[a.gravite] || 'Moyenne')}</span></div>
    <div class="m">${esc(a.message)}</div><div class="d">${esc(a.date)}</div></div></div>`).join('')
    + (d.count > list.length ? `<div class="table-foot"><button class="btn btn-ghost" id="alMore">Voir plus — ${list.length} / ${d.count}</button></div>` : '')
    : `<div class="empty"><div class="ic">${svgI('checkc', '')}</div><h4>Aucune alerte</h4><p>Aucun point d'attention sur le portefeuille.</p></div>`}</div>`;
  const m = $('#alMore'); if (m) m.onclick = () => renderAlerts(shown + 50);
}

/* ============================== VUES PORTEFEUILLE (cliquables depuis le dashboard) ============================== */
async function goClient(entId, view) { if (!entId) return; state.clientId = entId; localStorage.setItem('dp-client', entId); state.period = null; updateSwitcherLabel(); await loadPeriods(); setView(view || 'client'); }
window.goClient = goClient;

async function renderRetards() {
  const rows = await api('/portfolio/retards');
  const tot = rows.reduce((s, r) => s + (r.montant_amende || 0), 0);
  const ttc = rows.reduce((s, r) => s + (r.ttc || 0), 0);
  $('#view').innerHTML = `
  <div class="page-head"><div class="eyebrow">Cabinet · toutes périodes</div><h1>Factures en retard</h1><p>${rows.length} facture(s) à déclarer sur l'ensemble des clients · TTC concerné <b>${money(ttc)} DH</b> · amende <b>${money(tot)} DH</b>.</p></div>
  ${rows.length ? `<div class="table-wrap"><table class="dense rc"><thead><tr>
    <th>Client</th><th>Fournisseur (IF)</th><th>N° facture</th><th class="num">TTC</th><th data-prio="2">Date facture</th><th>Date paiement</th><th data-prio="3">Conv.</th><th class="num">Retard</th><th class="num">Amende</th><th class="col-act">Risque</th></tr></thead>
    <tbody id="pgBody"></tbody>
    <tfoot><tr><td>Total</td><td></td><td></td><td class="num" data-label="TTC">${money(ttc)}</td><td data-prio="2"></td><td></td><td data-prio="3"></td><td></td><td class="num amount-late" data-label="Amende">${money(tot)}</td><td class="col-act"></td></tr></tfoot></table></div>
    <div id="pgMore" class="table-foot"></div>`
    : emptyBox('Aucune facture en retard', 'Toutes les factures du portefeuille sont dans les délais.', 'dash', "Vue d'ensemble", 'checkc')}`;
  if (rows.length) mountPaged(rows, f => `<tr class="clickable" data-ent="${f.ent_id}">
      <td data-rc="m"><b>${esc(f.ent)}</b></td><td data-rc="t"><div class="fournisseur"><b>${esc(f.four || '—')}</b><small>IF ${esc(f.four_if || '—')}</small></div></td>
      <td class="mono" data-rc="m" data-label="N°">${esc(f.numero || '—')}</td><td class="num" data-rc="a">${money(f.ttc)}</td>
      <td class="mono dh" data-prio="2">${dateFr(f.date_facture)}</td><td class="mono dh" data-rc="m" data-label="Paiement">${dateFr(f.date_paiement)}</td>
      <td data-prio="3"><span class="badge ${f.delai_applicable >= 120 ? 'b120' : 'b60'}">${f.delai_applicable} j</span></td>
      <td class="retard pos" data-rc="s" data-label="Retard">+${f.retard_jours}</td><td class="num amount" data-rc="s" data-label="Amende">${money(f.montant_amende)}</td><td class="col-act" data-rc="s">${riskPill(f.couleur_risque)}</td></tr>`,
    { onRow: tr => goClient(tr.dataset.ent, 'delais') });
}

async function renderConvMiss() {
  const rows = await api('/portfolio/conventions-manquantes');
  $('#view').innerHTML = `
  <div class="page-head"><div class="eyebrow">Cabinet</div><h1>Conventions manquantes</h1><p>${rows.length} fournisseur(s) avec un délai de 120 j appliqué mais <b>sans convention en GED</b> — à régulariser (justificatif requis pour le visa).</p></div>
  ${rows.length ? `<div class="table-wrap"><table class="dense rc"><thead><tr><th>Client</th><th>Fournisseur</th><th data-prio="2">ICE / IF</th><th class="num">Factures en retard</th><th class="num">TTC concerné</th><th class="col-act">Statut</th></tr></thead>
    <tbody>${rows.map(r => `<tr class="clickable" data-ent="${r.ent_id}"><td data-rc="m"><b>${esc(r.ent)}</b></td><td data-rc="t">${esc(r.four || '—')}</td><td class="mono dh" data-prio="2">${esc(r.ice || r.if_fiscal || '—')}</td>
      <td class="num fw-6" data-rc="s" data-label="En retard">${r.nb}</td><td class="num" data-rc="a">${money(r.ttc)}</td>
      <td class="col-act" data-rc="s"><span class="pill pill-sm pill-severe"><span class="dot"></span>Justificatif requis</span></td></tr>`).join('')}</tbody></table></div>`
    : emptyBox('Aucune convention manquante', 'Tous les fournisseurs à 120 j disposent d\'une convention valide.', 'dash', "Vue d'ensemble", 'checkc')}`;
  $$('#view tbody tr[data-ent]').forEach(tr => tr.onclick = () => goClient(tr.dataset.ent, 'conv'));
}

async function renderCabConv() {
  const rows = await api('/portfolio/conventions');
  const S = { 'Trouvée': 'pill-ok', 'Bientôt expirée': 'pill-warn', 'Expirée': 'pill-late' };
  $('#view').innerHTML = `
  <div class="page-head"><div class="eyebrow">Cabinet</div><h1>Conventions du portefeuille</h1><p>${rows.length} convention(s) valide(s) enregistrée(s) sur l'ensemble des clients.</p></div>
  ${rows.length ? `<div class="table-wrap"><table class="dense rc"><thead><tr><th>Client</th><th>Fournisseur (ICE)</th><th class="num">Délai</th><th>Fin</th><th>Statut</th><th class="col-act">Document</th></tr></thead>
    <tbody id="pgBody"></tbody></table></div><div id="pgMore" class="table-foot"></div>`
    : emptyBox('Aucune convention', 'Aucune convention enregistrée dans le portefeuille.', 'dash', "Vue d'ensemble", 'doc')}`;
  if (rows.length) mountPaged(rows, c => `<tr class="clickable" data-ent="${c.ent_id}"><td data-rc="m"><b>${esc(c.ent)}</b></td><td data-rc="t"><div class="fournisseur"><b>${esc(c.four || '—')}</b><small>${esc(c.four_ice || '')}</small></div></td>
      <td class="num" data-rc="a"><span class="badge b120">${c.delai} j</span></td><td class="mono dh" data-rc="m" data-label="Fin">${c.date_fin ? dateFr(c.date_fin) : 'Indéterminée'}</td>
      <td data-rc="s"><span class="pill pill-sm ${S[c.statut] || 'pill-ok'}"><span class="dot"></span>${esc(c.statut === 'Trouvée' ? 'En vigueur' : c.statut)}</span></td>
      <td class="col-act" data-rc="s">${c.fichier ? `<a href="/api/conventions/${c.fichier}/file" target="_blank" onclick="event.stopPropagation()">Ouvrir</a>` : '<span class="tag-no">—</span>'}</td></tr>`,
    { onRow: tr => goClient(tr.dataset.ent, 'conv') });
}

// Anomalies — statuts et compteurs issus de src/anomalies.js (source unique). Levée = VALIDATION humaine (INC 2.1-C).
const ANO_LBL = { date_incoherente: 'Date incohérente', date_future: 'Date dans le futur', date_manquante: 'Date manquante', montant_incoherent: 'Montant incohérent', doublon: 'Doublon', doublon_potentiel: 'Doublon potentiel', convention_absente: 'Convention absente (délai > 60 j)' };
function anoMessage(a) {
  if (a.type !== 'convention_absente') return a.details || '';
  // Le texte d'origine « SANS convention… » n'est plus affiché tel quel : la situation réelle est décrite à part (ANO-8).
  const m = String(a.details || '').match(/^(Facture [^:]+:\s*délai (?:de )?\d+ j \(> 60 j\))\s*(?:SANS|sans) convention(?: enregistrée)? pour (?:le fournisseur )?(.+?)\.?$/);
  return m ? `${m[1]} — ${m[2]}` : (a.details || '');
}
function anoSituation(a) {
  const T = a.annee ? `T${a.trimestre} ${a.annee}` : 'cette facture';
  return ({ aucune: 'Aucune convention valide enregistrée pour ce fournisseur.',
    non_datee: `Une convention est enregistrée pour ce fournisseur, mais sans dates : impossible de vérifier qu’elle couvre ${T}. Complétez ses dates (Conventions › Modifier).`,
    trimestre_inconnu: 'Une convention est enregistrée ; le trimestre de cette anomalie n’est pas connu (import historique) : vérification manuelle nécessaire.',
    hors_periode: `La convention enregistrée ne couvre pas ${T} (dates de validité) : convention absente pour cette période.` })[a.situation] || '';
}
function anoFacts(a) {
  const c = a.convention || {}, f = a.facture || {};
  const cell = (k, v) => `<div><span>${esc(k)}</span><b>${v}</b></div>`;
  return `<div class="ano-facts">${cell('Facture', f.date_facture ? dateFr(f.date_facture) : '—')}${cell('Paiement', f.date_paiement ? dateFr(f.date_paiement) : 'non payée')}
    ${cell('Signature', c.date_signature ? dateFr(c.date_signature) : '—')}${cell('Effet', c.date_debut ? dateFr(c.date_debut) : '—')}
    ${cell('Enregistrée le', c.enregistree_le ? dateFr(String(c.enregistree_le).slice(0, 10)) : '—')}${cell('Justificatif', c.justificatif ? 'Présent' : '<span class="c-late">Manquant</span>')}</div>
    ${(c.avertissements || []).length ? `<div class="ano-warns">${c.avertissements.map(w => `<span class="pill pill-sm pill-warn">${svgI('warn', '')}${esc(w)}</span>`).join('')}</div>` : ''}`;
}
// Validation d'une levée : convention et facture nommées, justificatif consultable, signature rétroactive à accuser explicitement.
function leverModal(a) {
  const c = a.convention, f = a.facture || {};
  const retro = c.signature_retroactive;
  modal(`<div class="modal-h"><h3>Valider la levée — facture ${esc(f.numero || '')}</h3><button class="x" onclick="closeOverlay()">${XICO}</button></div>
  <div class="modal-b">
    <p class="m-0">La convention de <b>${c.delai} j</b> ${esc(a.fournisseur_nom ? 'avec ' + a.fournisseur_nom : '')} couvre ${a.annee ? `T${a.trimestre} ${a.annee}` : 'la période'}.
      Seule l’alerte « convention absente » sera levée : le retard et la pénalité éventuels restent déclarés.</p>
    ${anoFacts(a)}
    <p class="mt-8"><a href="/api/conventions/${c.id}/file" target="_blank" rel="noopener">${svgI('doc')} Ouvrir le justificatif signé${c.justificatif_nom ? ' (' + esc(c.justificatif_nom) + ')' : ''}</a></p>
    ${retro ? `<div class="note note-danger mt-12">${svgI('warn')}<div><div class="note-t">Signature rétroactive</div>La convention est signée le <b>${dateFr(c.date_signature)}</b>,
      ${[f.date_facture && c.date_signature > f.date_facture ? `après la facture (${dateFr(f.date_facture)})` : '', a.annee ? `${(c.avertissements || []).includes('Signée après la fin du trimestre') ? 'après la fin du trimestre' : ''}` : ''].filter(Boolean).join(' et ')}.
      <label class="check mt-8"><input type="checkbox" id="lvAck"> J’ai pris connaissance de cette signature rétroactive et je valide la levée en connaissance de cause.</label></div></div>` : ''}
    <label class="fld-lbl mt-12" for="lvCom">Commentaire (facultatif)</label><textarea class="input-fld" id="lvCom" rows="2" placeholder="Ex. original signé vérifié"></textarea>
  </div>
  <div class="modal-f"><button class="btn btn-ghost" onclick="closeOverlay()">Annuler</button><button class="btn btn-primary" id="lvOk" ${retro ? 'disabled' : ''}>Valider la levée</button></div>`);
  const ack = $('#lvAck'); if (ack) ack.onchange = () => { $('#lvOk').disabled = !ack.checked; };
  $('#lvOk').onclick = async () => {
    try { await api(`/anomalies/${a.id}/levee`, { method: 'POST', body: { commentaire: $('#lvCom').value, ackRetroactif: !!(ack && ack.checked) } });
      closeOverlay(); toast('Levée validée et inscrite au journal d’audit.', 'ok', 'Anomalie levée'); refreshAlertsBadge(); renderAnomalies(); }
    catch (e) { toast(e.message, 'err', 'Levée refusée'); }
  };
}
async function renderAnomalies() {
  const d = await api('/anomalies', { fresh: true });
  const n = d.counts, rows = d.rows;
  const admin = state.me && state.me.role === 'admin';
  const line = a => {
    const st = a.statut_calc, verif = st === 'a_verifier', levee = st === 'levee', conv = a.convention;
    const title = esc(ANO_LBL[a.type] || 'Anomalie') + (verif ? ' — couverte par une convention, à vérifier' : levee ? ' — levée' : '');
    const badge = levee ? '<span class="sev muted">levée</span>' : st === 'resolue' ? `<span class="sev ${a.sans_justification ? 'm' : 'muted'}">${a.sans_justification ? 'résolue sans justification' : 'résolue'}</span>`
      : `<span class="sev ${verif ? 'muted' : sevCls(a.gravite)}">${esc(GRAVITE_FR[a.gravite] || a.gravite || '')}</span>${verif ? '<span class="sev info">à vérifier</span>' : ''}`;
    const maintenus = (verif || levee) && a.facture && a.facture.a_declarer && a.facture.montant_amende > 0
      ? `<div class="m ano-keep">${svgI('clock', '')}Retard et pénalité maintenus : ${money(a.facture.montant_amende)} DH déclarés (la levée ne concerne que l’alerte « convention absente »).</div>` : '';
    const lock = a.periode_verrouillee && (verif || levee) ? `<div class="m ano-lock">${svgI('lock', '')}T${a.trimestre} ${a.annee} est clôturée : lecture seule, la levée ne peut être ni validée ni annulée.</div>` : '';
    const resolu = st === 'resolue' ? (a.sans_justification
      ? `<div class="m"><span class="pill pill-sm pill-warn">${svgI('warn', '')}Résolue sans justification</span> <span class="dh t-sm">résolution antérieure, sans motif enregistré — à revoir</span></div>`
      : `<div class="m levee-m">${svgI('checkc', '')}Résolue${a.resolue_le ? ' le ' + dateFr(String(a.resolue_le).slice(0, 10)) : ''}${a.resolue_par_nom ? ' par ' + esc(a.resolue_par_nom) : ''} — « ${esc(a.motif_resolution)} »</div>`) : '';
    const valid = levee ? `<div class="m levee-m">${svgI('checkc', '')}Levée validée le ${dateFr(String(a.levee_validee_le).slice(0, 10))} par ${esc(a.levee_validee_par_nom || '—')}${a.levee_commentaire ? ` — « ${esc(a.levee_commentaire)} »` : ''}.</div>` : '';
    const acts = [];
    if (verif && !a.periode_verrouillee && can('manage_conventions')) acts.push(conv && conv.justificatif
      ? `<button class="btn btn-primary btn-sm" data-lever="${a.id}">Valider la levée</button>`
      : `<button class="btn btn-ghost btn-sm" disabled title="Ajoutez d’abord le justificatif signé de la convention">Valider la levée</button>`);
    if (levee && admin && !a.periode_verrouillee) acts.push(`<button class="btn btn-quiet btn-sm" data-unlever="${a.id}">Annuler la levée</button>`);
    if (st === 'ouverte' && a.type !== 'convention_absente' && !a.periode_verrouillee && can('manage_conventions')) acts.push(`<button class="btn btn-ghost btn-sm" data-res="${a.id}">Marquer résolue</button>`);
    return `<div class="alert-row ${verif ? 'is-verif' : ''} ${levee || st === 'resolue' ? 'is-levee' : ''}">
      <div class="al-ic ${levee || st === 'resolue' ? 'info' : verif ? 'info' : a.gravite === 'haute' ? 'red' : 'orange'}">${svgI(levee || st === 'resolue' ? 'check' : verif ? 'info' : 'warn', '')}</div>
      <div class="al-body"><div class="t">${title} ${badge}</div>
        <div class="m">${esc(anoMessage(a))}</div>
        ${a.type === 'convention_absente' && !verif && !levee && a.situation ? `<div class="m ano-sit">${esc(anoSituation(a))}</div>` : ''}
        ${(verif || levee) && conv ? anoFacts(a) + `<div class="m"><button class="btn-link" data-conv-ent="${a.ent_id}" data-conv-id="${conv.id}">Voir la convention (${conv.delai} j)</button>${conv.justificatif ? ` · <a href="/api/conventions/${conv.id}/file" target="_blank" rel="noopener">${svgI('doc')} Ouvrir le justificatif signé</a>` : ''}</div>` : ''}
        ${maintenus}${valid}${resolu}${lock}
        <div class="d">${esc(a.ent || '—')} · ${esc(String(a.created_at || '').slice(0, 10))}${a.annee ? ` · T${a.trimestre} ${a.annee}` : ''}</div></div>
      ${acts.length ? `<div class="al-acts">${acts.join('')}</div>` : ''}</div>`;
  };
  $('#view').innerHTML = `
  <div class="page-head"><div class="eyebrow">Contrôle</div><h1>Anomalies</h1><p><b>${n.aTraiter}</b> anomalie(s) à traiter${n.aVerifier ? ` (dont <b>${n.aVerifier}</b> couverte(s) par une convention, à vérifier)` : ''} · ${n.levees} levée(s) validée(s) · ${n.resolues} résolue(s) — sur ${rows.length} détectée(s).</p></div>
  <div class="card">${rows.length ? rows.map(line).join('') : `<div class="empty"><div class="ic">${svgI('checkc', '')}</div><h4>Aucune anomalie</h4><p>Aucune anomalie détectée sur le portefeuille.</p></div>`}</div>`;
  $$('#view [data-res]').forEach(b => b.onclick = async () => {
    const a = rows.find(x => x.id === b.dataset.res);
    const motif = await ui.prompt({ tone: 'warn', title: `Marquer résolue : ${ANO_LBL[a.type] || 'anomalie'} ?`, html: `<p>${esc(anoMessage(a))}</p>`,
      facts: [['Client', a.ent || '—'], ['Période', a.annee ? `T${a.trimestre} ${a.annee}` : 'non renseignée']], label: 'Motif de la résolution', required: true,
      placeholder: 'Ex. paiement partiel confirmé par le relevé bancaire', confirmLabel: 'Marquer résolue' });
    if (!motif) return;
    try { await api(`/anomalies/${a.id}/resolve`, { method: 'POST', body: { motif } }); toast('Anomalie résolue — motif inscrit au journal d’audit.', 'ok'); refreshAlertsBadge(); renderAnomalies(); }
    catch (e) { toast(e.message, 'err', 'Résolution refusée'); }
  });
  $$('#view [data-conv-ent]').forEach(b => b.onclick = () => { state._convFocus = b.dataset.convId; goClient(b.dataset.convEnt, 'conv'); });
  $$('#view [data-lever]').forEach(b => b.onclick = () => leverModal(rows.find(x => x.id === b.dataset.lever)));
  $$('#view [data-unlever]').forEach(b => b.onclick = async () => {
    const motif = await ui.prompt({ tone: 'warn', title: 'Annuler la levée de cette anomalie ?', message: 'L’anomalie redeviendra « à vérifier » et sera de nouveau comptée.', label: 'Motif de l’annulation', required: true, confirmLabel: 'Annuler la levée' });
    if (!motif) return;
    try { await api(`/anomalies/${b.dataset.unlever}/levee`, { method: 'DELETE', body: { motif } }); toast('Levée annulée — motif inscrit au journal d’audit.', 'ok', 'Anomalie'); refreshAlertsBadge(); renderAnomalies(); }
    catch (e) { toast(e.message, 'err', 'Annulation refusée'); }
  });
}

/* ============================== PARAMÈTRES (espace · utilisateurs · sécurité · taux · compte) ============================== */
async function renderSettings(tab = 'workspace') {
  const tabs = [['workspace', 'Espace de travail'], ...(can('manage_users') ? [['users', 'Utilisateurs']] : []), ['security', 'Sécurité'], ['taux', 'Taux Bank Al-Maghrib'], ['compte', 'Mon compte']];
  if (!tabs.some(t => t[0] === tab)) tab = 'workspace';
  state._settingsTab = tab;
  $('#view').innerHTML = `
  <div class="page-head headrow"><div><div class="eyebrow">${esc((state.workspace && state.workspace.displayName) || '')} · Administration</div><h1>Paramètres</h1><p>Identité de l'espace, utilisateurs, sécurité, taux de référence et compte.</p></div>
    ${can('onboarding') ? `<div class="actions"><button class="btn btn-ghost" onclick="resumeOnboarding(null)">${svgI('bolt')}Configuration de l’espace</button></div>` : ''}</div>
  <div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button class="tab" role="tab" data-tab="${k}" aria-selected="${k === tab}">${l}</button>`).join('')}</div>
  <div id="setBody"></div>`;
  $$('.tab[data-tab]').forEach(b => b.onclick = () => { if (b.dataset.tab === 'taux') return setView('taux'); if (state.view !== 'settings') return setView('settings'); renderSettings(b.dataset.tab); });
  const box = $('#setBody');
  const fn = { taux: renderTaux, compte: renderAccount, users: renderUsers, security: renderSecurity }[tab] || renderWorkspace;
  try { await fn(box); }
  catch (e) {  // jamais d'onglet vide : message explicite + action
    box.innerHTML = `<div class="card"><div class="empty err"><div class="ic">${svgI('warn', '')}</div><h4>Cette section n'a pas pu être chargée</h4><p>${esc(e.message)}</p>
      <div class="actions"><button class="btn btn-ghost" id="setRetry">${svgI('refresh')}Réessayer</button></div></div></div>`;
    const r = $('#setRetry'); if (r) r.onclick = () => renderSettings(tab);
  }
}
async function renderWorkspace(box) {
  const d = await api('/workspace', { fresh: true });
  const w = d.workspace || {}; const isAdmin = can('manage_workspace');
  const ro = isAdmin ? '' : 'readonly disabled';
  const opt = (arr, v, lbl = x => x) => arr.map(x => `<option value="${esc(x)}" ${x === v ? 'selected' : ''}>${esc(lbl(x))}</option>`).join('');
  const LOC = { 'fr-MA': 'Français (Maroc)', 'fr-FR': 'Français (France)', 'ar-MA': 'العربية (المغرب)', 'en-US': 'English (US)' };
  const TZ = { 'Africa/Casablanca': 'Casablanca (GMT+1)', 'Europe/Paris': 'Paris', UTC: 'UTC' };
  const monoHtml = (bg) => w.logoUrl ? `<div class="ws-mono has-logo" style="width:56px;height:56px;border-radius:12px;background:${bg}"><img class="ws-logo-img" src="${esc(w.logoUrl)}" alt="Logo actuel"></div>`
    : `<div class="ws-mono" style="width:56px;height:56px;border-radius:12px;font-size:var(--fs-xl);background:var(--tenant);color:var(--tenant-ink)">${esc(w.initials || 'DP')}</div>`;
  box.innerHTML = `<div class="settings-grid">
    <div class="stack">
      <div class="card"><div class="card-h"><div><h3>Identité</h3><div class="sub">Affichée dans la navigation, sur la page de connexion et l'accueil</div></div>${isAdmin ? '' : '<span class="pill pill-sm pill-locked">Lecture seule</span>'}</div>
        <div class="card-b"><div class="form-grid">
          <div><label class="fld-lbl" for="w_name">Nom de l'espace</label><input class="input-fld" id="w_name" maxlength="80" value="${esc(w.nomAffiche || '')}" placeholder="${esc(w.nom || '')}" ${ro}>
            <span class="fld-help">Vide : « ${esc(w.nom || '')} » est utilisé.</span></div>
          <div><label class="fld-lbl" for="w_legal">Raison sociale</label><input class="input-fld" id="w_legal" maxlength="160" value="${esc(w.raisonLegale || '')}" placeholder="Ex. Cabinet Exemple SARL" ${ro}></div>
          <div class="full"><label class="fld-lbl">Logo</label>
            <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
              <div class="logo-proof"><span class="lp light">${monoHtml('#fff')}</span><span class="lp dark">${monoHtml('#0C2A36')}</span></div>
              ${isAdmin ? `<div class="actions"><label class="btn btn-ghost btn-sm" for="w_logo">${svgI('up')}${w.logoUrl ? 'Remplacer' : 'Téléverser un logo'}</label>
                <input type="file" id="w_logo" accept="image/png,image/jpeg,image/webp" class="sr-only">
                ${w.logoUrl ? `<button class="btn btn-quiet btn-sm" id="w_logo_rm">Retirer</button>` : ''}</div>` : ''}
            </div><span class="fld-help">PNG, JPEG ou WebP · 1 Mo maximum · de préférence carré, fond transparent. Le SVG n'est pas accepté (sécurité). Aperçu sur fond clair et sombre.</span></div>
          <div><label class="fld-lbl" for="w_color">Couleur de l'espace</label><div class="color-row"><input type="color" id="w_colorPick" value="${esc(w.primaryColor || '#15475A')}" ${ro} aria-label="Choisir la couleur">
            <input class="input-fld mono" id="w_color" value="${esc(w.primaryColor || '')}" placeholder="#15475A" maxlength="7" ${ro}></div>
            <span class="fld-help">Réservée à l'identité de l'espace (monogramme) — jamais aux statuts métier. Ajustée automatiquement si elle nuit à la lisibilité.</span><span class="fld-help" id="w_colorHint" role="status"></span></div>
        </div></div></div>
      <div class="card"><div class="card-h"><div><h3>Localisation</h3><div class="sub">Préférences enregistrées pour l'espace</div></div></div><div class="card-b"><div class="form-grid">
        <div><label class="fld-lbl" for="w_locale">Langue et format</label><select class="input-fld" id="w_locale" ${ro}>${opt(d.options.locales, w.locale, x => LOC[x] || x)}</select></div>
        <div><label class="fld-lbl" for="w_devise">Devise</label><select class="input-fld" id="w_devise" ${ro}>${opt(d.options.devises, w.devise, x => x === 'MAD' ? 'Dirham marocain (MAD)' : x)}</select></div>
        <div><label class="fld-lbl" for="w_tz">Fuseau horaire</label><select class="input-fld" id="w_tz" ${ro}>${opt(d.options.fuseaux, w.fuseauHoraire, x => TZ[x] || x)}</select></div>
      </div><div class="hint mt-12">${svgI('info')}<span>L'interface est aujourd'hui en français, les montants en dirhams et les dates à l'heure du Maroc ; ces préférences préparent les versions suivantes.</span></div></div></div>
      <div class="card"><div class="card-h"><div><h3>Contacts</h3><div class="sub">Coordonnées du cabinet</div></div></div><div class="card-b"><div class="form-grid">
        <div><label class="fld-lbl" for="w_mail">E-mail de contact</label><input class="input-fld" id="w_mail" type="email" value="${esc(w.contactEmail || '')}" ${ro}></div>
        <div><label class="fld-lbl" for="w_tel">Téléphone</label><input class="input-fld" id="w_tel" value="${esc(w.contactTelephone || '')}" ${ro}></div>
        <div class="full"><label class="fld-lbl" for="w_adr">Adresse</label><input class="input-fld" id="w_adr" maxlength="240" value="${esc(w.adresse || '')}" ${ro}></div>
      </div></div>${isAdmin ? `<div class="card-f"><button class="btn btn-primary" id="w_save">Enregistrer les modifications</button></div>` : ''}</div>
    </div>
    <div class="stack">
      <div class="card"><div class="card-h"><h3>Aperçu</h3></div><div class="card-b"><div class="preview-ws"><div class="pv-side">
                    <div class="ws-card m-0"><div class="ws-mono ${w.logoUrl ? 'has-logo' : ''}" id="pvMono" style="${w.logoUrl ? '' : 'background:var(--tenant);color:var(--tenant-ink)'}">${w.logoUrl ? `<img class="ws-logo-img" src="${esc(w.logoUrl)}" alt="">` : esc(w.initials || 'DP')}</div><div class="ws-meta"><b id="pvName">${esc(w.displayName || '')}</b><small>${esc(w.raisonLegale || 'Espace de travail')}</small></div></div>
          <div class="powered-by pv-powered"><img src="/assets/brand/delaipay-symbol-dark-bg.svg" alt="" width="14" height="14">Propulsé par <b>DelaiPay</b></div></div>
        <div class="pv-body">Chaque cabinet dispose de son espace, de ses données cloisonnées et de ses utilisateurs, dans une interface DelaiPay commune.</div></div></div></div>
      <div class="card"><div class="card-h"><div><h3>Espace</h3><div class="sub">informations d'abonnement</div></div></div><div class="card-b">
        <dl class="kv"><dt>Adresse</dt><dd><span class="code">${esc(w.slug || '—')}.delaipay.com</span></dd><dt>Statut</dt><dd>${w.active === false ? '<span class="pill pill-sm pill-late">Désactivé</span>' : '<span class="pill pill-sm pill-ok">Actif</span>'}</dd>
          <dt>Créé le</dt><dd>${esc(dateFr(w.createdAt))}</dd>${w.updatedAt ? `<dt>Modifié le</dt><dd>${esc(dateTimeFr(w.updatedAt))}</dd>` : ''}</dl>
        <div class="hint mt-12">${svgI('info')}<span>L'adresse publique sera active à l'ouverture de la plateforme en ligne. Pour la changer, contactez DelaiPay.</span></div></div></div>
    </div></div>`;
  if (!isAdmin) return;
  const pick = $('#w_colorPick'), col = $('#w_color');
  // Aperçu en direct avec les MÊMES variantes accessibles que le serveur (texte ≥ 4,5:1).
  const preview = v => { if (w.logoUrl || !window.brandColor) return; const p = window.brandColor.tenantPalette(v); const el = $('#pvMono'); el.style.background = p.tenant; el.style.color = p.tenantInk;
    const hint = $('#w_colorHint'); if (hint) hint.textContent = p.corrected ? `Couleur ajustée à ${p.tenant} pour rester lisible.` : ''; };
  pick.oninput = () => { col.value = pick.value.toUpperCase(); preview(pick.value); };
  col.oninput = () => { if (/^#[0-9a-f]{6}$/i.test(col.value)) { pick.value = col.value; preview(col.value); } };
  $('#w_name').oninput = e => { $('#pvName').textContent = e.target.value || w.nom || ''; };
  const lf = $('#w_logo'); if (lf) lf.onchange = async () => {
    const f = lf.files[0]; if (!f) return;
    if (f.size > 1024 * 1024) { toast('Le logo dépasse 1 Mo. Réduisez-le puis réessayez.', 'err', 'Logo refusé'); return; }
    const fd = new FormData(); fd.append('file', f);
    try { const r = await api('/workspace/logo', { method: 'POST', body: fd }); state.workspace = { ...state.workspace, ...publicPart(r.workspace) }; applyWorkspace(); toast('Logo mis à jour.', 'ok', 'Espace de travail'); renderSettings('workspace'); }
    catch (e) { toast(e.message, 'err', 'Logo refusé'); }
  };
  const rm = $('#w_logo_rm'); if (rm) rm.onclick = async () => {
    if (!await ui.confirm({ tone: 'warn', title: 'Retirer le logo ?', message: 'Le monogramme de l’espace sera affiché à la place.', confirmLabel: 'Retirer le logo' })) return;
    try { const r = await api('/workspace/logo', { method: 'DELETE' }); state.workspace = { ...state.workspace, ...publicPart(r.workspace) }; applyWorkspace(); renderSettings('workspace'); } catch (e) { toast(e.message, 'err'); }
  };
  $('#w_save').onclick = async () => {
    const b = $('#w_save'); b.disabled = true; b.innerHTML = '<span class="spin"></span>Enregistrement…';
    try {
      const r = await api('/workspace', { method: 'PUT', body: { nomAffiche: $('#w_name').value, raisonLegale: $('#w_legal').value, primaryColor: col.value.trim(), locale: $('#w_locale').value, devise: $('#w_devise').value, fuseauHoraire: $('#w_tz').value, contactEmail: $('#w_mail').value, contactTelephone: $('#w_tel').value, adresse: $('#w_adr').value } });
      state.workspace = { ...state.workspace, ...publicPart(r.workspace) }; applyWorkspace(); toast("Identité de l'espace enregistrée.", 'ok', 'Espace de travail'); renderSettings('workspace');
    } catch (e) { toast(e.message + ' Aucune modification n’a été enregistrée.', 'err', 'Enregistrement impossible'); b.disabled = false; b.textContent = 'Enregistrer les modifications'; }
  };
}
function publicPart(w) { return w || {}; }

/* ---------- Utilisateurs & invitations (administrateur) ---------- */
const ROLE_INFO = {
  admin: ['Administrateur', 'Tout, y compris l’espace, les utilisateurs, la clôture et la réouverture des périodes.'],
  collaborateur: ['Comptable', 'Clients, imports, conventions, réseau, doublons et exports — sans administration ni clôture.'],
  lecture: ['Lecture seule', 'Consultation et exports uniquement ; aucune modification possible.'],
};
async function renderUsers(box) {
  const d = await api('/users', { fresh: true });
  const roleSel = (u) => `<select class="input-fld role-sel" data-role="${u.id}" data-nom="${esc(u.nom || u.email)}" ${u.id === state.me.id ? 'disabled title="Vous ne pouvez pas modifier votre propre rôle"' : ''}>${Object.entries(ROLE_INFO).map(([k, [l]]) => `<option value="${k}" ${u.role === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  const INV = { en_attente: ['pill-brand', 'En attente'], acceptee: ['pill-ok', 'Acceptée'], revoquee: ['pill-locked', 'Révoquée'], expiree: ['pill-warn', 'Expirée'] };
  const pending = d.invitations.filter(i => i.statut === 'en_attente');
  box.innerHTML = `
  <div class="toolbar"><div class="dh t-md">${d.users.filter(u => u.actif).length} utilisateur(s) actif(s) · ${pending.length} invitation(s) en attente</div>
    <button class="btn btn-primary" id="invBtn">${svgI('plus')}Inviter un utilisateur</button></div>
  <div class="table-wrap mb-18"><table class="dense rc"><thead><tr><th>Utilisateur</th><th>Rôle</th><th>Statut</th><th>Dernière connexion</th><th class="col-act"><span class="sr-only">Actions</span></th></tr></thead>
    <tbody>${d.users.map(u => `<tr><td data-rc="t"><div class="fournisseur"><b>${esc(u.nom || '—')}${u.id === state.me.id ? ' <span class="dh">(vous)</span>' : ''}</b><small>${esc(u.email)}</small></div></td>
      <td data-rc="s">${roleSel(u)}</td>
      <td data-rc="s">${u.actif ? '<span class="pill pill-sm pill-ok">Actif</span>' : '<span class="pill pill-sm pill-locked">Désactivé</span>'}</td>
      <td class="dh" data-rc="m" data-label="Dernière connexion">${u.derniere_connexion ? esc(dateTimeFr(u.derniere_connexion)) : 'Jamais'}</td>
      <td class="col-act" data-rc="s">${u.id === state.me.id ? '' : `<button class="btn ${u.actif ? 'btn-quiet row-del' : 'btn-ghost'} btn-sm" data-toggle="${u.id}" data-actif="${u.actif ? 1 : 0}" data-nom="${esc(u.nom || u.email)}">${u.actif ? 'Désactiver' : 'Réactiver'}</button>`}</td></tr>`).join('')}</tbody></table></div>
  <div class="grid-2">
    <div class="card"><div class="card-h"><div><h3>Invitations</h3><div class="sub">valables 7 jours, à usage unique</div></div></div>
      ${d.invitations.length ? `<div class="table-wrap flat b-0"><table style="min-width:520px"><thead><tr><th>E-mail</th><th>Rôle</th><th>Statut</th><th>Expire</th><th></th></tr></thead><tbody>
        ${d.invitations.map(i => { const st = INV[i.statut] || ['', i.statut]; return `<tr><td>${esc(i.email)}</td><td class="dh">${esc((ROLE_INFO[i.role] || [i.role])[0])}</td><td><span class="pill pill-sm ${st[0]}">${st[1]}</span></td><td class="dh mono">${esc(dateFr(i.expires_at))}</td>
          <td style="text-align:right">${i.statut === 'en_attente' ? `<button class="btn btn-quiet btn-sm" data-revoke="${i.id}" data-mail="${esc(i.email)}">Révoquer</button>` : ''}</td></tr>`; }).join('')}</tbody></table></div>`
        : `<div class="empty" style="padding:28px"><p>Aucune invitation envoyée. Invitez une collaboratrice ou un collaborateur pour partager l'espace.</p></div>`}</div>
    <div class="card"><div class="card-h"><h3>Rôles</h3></div><div class="card-b">
      ${Object.entries(ROLE_INFO).map(([k, [l, t]]) => `<div class="list-row" style="align-items:flex-start"><span class="pill pill-sm ${k === 'admin' ? 'pill-brand' : k === 'lecture' ? 'pill-locked' : 'pill-ok'}" style="min-width:108px;justify-content:center">${l}</span><span class="dh t-sm">${t}</span></div>`).join('')}
      <div class="hint mt-10">${svgI('lock')}<span>Chaque droit est vérifié par le serveur : masquer un bouton ne donne ni ne retire aucun accès.</span></div></div></div>
  </div>`;
  $('#invBtn').onclick = inviteModal;
  $$('[data-role]').forEach(sel => sel.onchange = async () => {
    const prev = [...sel.options].find(o => o.defaultSelected); const role = sel.value;
    if (!await ui.confirm({ tone: role === 'admin' ? 'warn' : 'brand', title: `Changer le rôle de ${sel.dataset.nom || 'cet utilisateur'} en « ${ROLE_INFO[role][0]} » ?`, message: ROLE_INFO[role][1], confirmLabel: 'Changer le rôle' })) { if (prev) sel.value = prev.value; return; }
    try { await api(`/users/${sel.dataset.role}`, { method: 'PATCH', body: { role } }); toast('Rôle mis à jour. Il s’applique dès la prochaine action de l’utilisateur.', 'ok', 'Utilisateurs'); renderUsers(box); }
    catch (e) { toast(e.message, 'err', 'Modification refusée'); if (prev) sel.value = prev.value; }
  });
  $$('[data-toggle]').forEach(b => b.onclick = async () => {
    const on = b.dataset.actif === '1';
    if (!await ui.confirm({ tone: on ? 'danger' : 'brand', title: `${on ? 'Désactiver' : 'Réactiver'} ${b.dataset.nom} ?`, message: on ? 'Son accès est coupé immédiatement, y compris la session en cours. Ses actions passées restent dans le journal d’audit.' : 'L’utilisateur pourra de nouveau se connecter avec son mot de passe.', confirmLabel: on ? 'Désactiver l’accès' : 'Réactiver' })) return;
    try { await api(`/users/${b.dataset.toggle}`, { method: 'PATCH', body: { actif: !on } }); toast(on ? 'Accès désactivé.' : 'Accès réactivé.', 'ok', 'Utilisateurs'); renderUsers(box); }
    catch (e) { toast(e.message, 'err', 'Modification refusée'); }
  });
  $$('[data-revoke]').forEach(b => b.onclick = async () => {
    if (!await ui.confirm({ tone: 'warn', title: `Révoquer l’invitation de ${b.dataset.mail} ?`, message: 'Le lien ne permettra plus de créer un accès.', confirmLabel: 'Révoquer' })) return;
    try { await api(`/invitations/${b.dataset.revoke}`, { method: 'DELETE' }); renderUsers(box); } catch (e) { toast(e.message, 'err'); }
  });
}
function inviteModal() {
  modal(`<div class="modal-h"><h3>Inviter un utilisateur</h3><button class="x" onclick="closeOverlay()" aria-label="Fermer">${XICO}</button></div>
  <div class="modal-b" id="invBody"><div class="form-grid">
    <div class="full"><label class="fld-lbl" for="i_mail">Adresse e-mail professionnelle</label><input class="input-fld" id="i_mail" type="email" placeholder="prenom.nom@cabinet.ma"></div>
    <div class="full"><label class="fld-lbl">Rôle</label>${Object.entries(ROLE_INFO).map(([k, [l, t]]) => `<label class="check" style="align-items:flex-start;padding:8px 0"><input type="radio" name="i_role" value="${k}" ${k === 'collaborateur' ? 'checked' : ''}><span><b>${l}</b><br><span class="dh t-sm">${t}</span></span></label>`).join('')}</div>
  </div></div>
  <div class="modal-f" id="invFoot"><button class="btn btn-ghost" onclick="closeOverlay()">Annuler</button><button class="btn btn-primary" id="i_send">Créer l'invitation</button></div>`);
  $('#i_send').onclick = async () => {
    const email = $('#i_mail').value.trim(), role = ($('input[name="i_role"]:checked') || {}).value;
    const b = $('#i_send'); b.disabled = true;
    try {
      const r = await api('/invitations', { method: 'POST', body: { email, role } });
      const link = `${location.origin}/invite#t=${r.invitation.token}`;
      $('#invBody').innerHTML = `<div class="note note-ok">${svgI('checkc')}<div><div class="note-t">Invitation créée pour ${esc(r.invitation.email)}</div>Transmettez ce lien à la personne invitée. <b>Il n'est affiché qu'une seule fois</b> et expire le ${esc(dateFr(r.invitation.expires_at))}.</div></div>
        <label class="fld-lbl" for="i_link">Lien d'invitation</label><div class="color-row"><input class="input-fld mono" id="i_link" readonly value="${esc(link)}"><button class="btn btn-ghost" id="i_copy">Copier</button></div>
        <div class="hint mt-10">${svgI('info')}<span>L'envoi automatique par e-mail sera proposé ultérieurement. Le lien donne accès à cet espace uniquement.</span></div>`;
      $('#invFoot').innerHTML = `<button class="btn btn-primary" id="i_done">Terminé</button>`;
      $('#i_copy').onclick = async () => { try { await navigator.clipboard.writeText(link); toast('Lien copié.', 'ok'); } catch (_) { $('#i_link').select(); } };
      $('#i_done').onclick = () => { closeOverlay(); renderSettings('users'); };
    } catch (e) { toast(e.message, 'err', 'Invitation impossible'); b.disabled = false; }
  };
}
function renderSecurity(box) {
  box.innerHTML = `<div class="grid-2">
    <div class="card"><div class="card-h"><h3>Accès et sessions</h3></div><div class="card-b">
      <dl class="kv"><dt>Connexion</dt><dd>E-mail et mot de passe, limitée aux comptes de cet espace sur son adresse dédiée</dd>
        <dt>Session</dt><dd>12 heures, cookie inaccessible aux scripts de la page</dd>
        <dt>Contrôle</dt><dd>Rôle, statut du compte et de l'espace revérifiés à chaque action</dd>
        <dt>Tentatives</dt><dd>Connexion limitée en cas d'essais répétés</dd>
        <dt>Mots de passe</dt><dd>10 caractères minimum, stockés hachés (jamais en clair)</dd></dl></div></div>
    <div class="card"><div class="card-h"><h3>Traçabilité</h3></div><div class="card-b">
      <p class="dh" style="margin:0 0 12px;font-size:var(--fs-md)">Connexions, imports, conventions, clôtures et réouvertures, exports, invitations et changements de rôle sont inscrits au journal d'audit de l'espace.</p>
      <button class="btn btn-ghost" data-goto="audit">${svgI('history')}Ouvrir le journal d'audit</button>
      <div class="hint" style="margin:14px 0 0">${svgI('info')}<span>Double authentification et connexion d'entreprise (SSO) : prévues dans une version ultérieure.</span></div></div></div></div>`;
  $$('#setBody [data-goto]').forEach(el => el.onclick = () => setView(el.dataset.goto));
}
function renderAccount(box) {
  const m = state.me || {};
  box.innerHTML = `<div class="card mw-640"><div class="card-h"><h3>Mon compte</h3></div><div class="card-b">
    <dl class="kv"><dt>Nom</dt><dd>${esc(m.nom || '—')}</dd><dt>E-mail</dt><dd>${esc(m.email || '—')}</dd>${m.titre && !Object.values(ROLE_INFO).some(r => r[0] === m.titre) ? `<dt>Fonction</dt><dd>${esc(m.titre)}</dd>` : ''}
      <dt>Rôle</dt><dd>${esc(m.roleLabel || m.role)} — ${esc((ROLE_INFO[m.role] || ['', ''])[1])}</dd>
      <dt>Espace</dt><dd>${esc((state.workspace && state.workspace.displayName) || '—')}</dd></dl>
  </div></div>
  <div class="card" style="max-width:640px;margin-top:14px"><div class="card-h"><div><h3>Mot de passe</h3><div class="sub">10 caractères minimum, avec au moins une lettre et un chiffre</div></div></div><div class="card-b"><div class="form-grid">
    <div class="full"><label class="fld-lbl" for="p_cur">Mot de passe actuel</label><input class="input-fld" id="p_cur" type="password" autocomplete="current-password"></div>
    <div><label class="fld-lbl" for="p_new">Nouveau mot de passe</label><input class="input-fld" id="p_new" type="password" autocomplete="new-password"></div>
    <div><label class="fld-lbl" for="p_new2">Confirmation</label><input class="input-fld" id="p_new2" type="password" autocomplete="new-password"></div>
  </div></div><div class="card-f"><button class="btn btn-primary" id="p_save">Changer le mot de passe</button></div></div>`;
  $('#p_save').onclick = async () => {
    const cur = $('#p_cur').value, n1 = $('#p_new').value, n2 = $('#p_new2').value;
    if (n1 !== n2) return toast('La confirmation ne correspond pas au nouveau mot de passe.', 'err', 'Mot de passe');
    try { await api('/me/password', { method: 'PUT', body: { current: cur, next: n1 } }); toast('Mot de passe modifié.', 'ok', 'Mon compte'); ['#p_cur', '#p_new', '#p_new2'].forEach(x => { $(x).value = ''; }); }
    catch (e) { toast(e.message, 'err', 'Mot de passe inchangé'); }
  };
}
async function renderTaux(box = $('#view')) {
  const rows = await api('/taux');
  const isAdmin = can('manage_rates');
  box.innerHTML = `
  <div class="toolbar"><div class="dh" style="font-size:var(--fs-md);max-width:70ch">Historique du taux directeur appliqué au 1ᵉʳ mois de retard. Le taux en vigueur au mois de retard concerné est utilisé.</div>
    ${isAdmin ? `<button class="btn btn-primary" id="addTaux">${svgI('plus')}Ajouter un taux</button>` : ''}</div>
  <div class="table-wrap"><table style="min-width:560px"><thead><tr><th class="num">Taux</th><th>Début</th><th>Fin</th><th>Référence</th></tr></thead>
  <tbody>${rows.map(t => `<tr><td class="num fw-6">${pct(t.taux)}</td><td class="mono dh">${dateFr(t.date_debut)}</td><td class="mono dh">${t.date_fin ? dateFr(t.date_fin) : '<span class="pill pill-sm pill-ok">En vigueur</span>'}</td><td class="dh">${esc(t.reference || '—')}</td></tr>`).join('')}</tbody></table></div>
  <div class="note note-info mt-16">${svgI('info')}<div><b>Règle de calcul (confirmée) :</b> découpage par <b>mois calendaire</b>. 1ᵉʳ mois de retard = taux directeur BAM ; chaque mois suivant = <b>0,85 %</b> ; seuls les mois du trimestre déclaré sont facturés.</div></div>`;
  const add = $('#addTaux'); if (!add) return;
  add.onclick = () => {
    modal(`<div class="modal-h"><h3>Ajouter un taux</h3><button class="x" onclick="closeOverlay()" aria-label="Fermer">${XICO}</button></div>
    <div class="modal-b"><div class="form-grid">
      <div><label class="fld-lbl">Taux (ex. 0.0225)</label><input class="input-fld" id="t_taux" type="number" step="0.0001"></div>
      <div><label class="fld-lbl">Référence</label><input class="input-fld" id="t_ref" placeholder="BAM 2,25 %"></div>
      <div><label class="fld-lbl">Date de début</label><input class="input-fld" id="t_deb" type="date"></div>
      <div><label class="fld-lbl">Date de fin (option.)</label><input class="input-fld" id="t_fin" type="date"></div>
    </div></div><div class="modal-f"><button class="btn btn-ghost" onclick="closeOverlay()">Annuler</button><button class="btn btn-primary" id="t_save">Ajouter</button></div>`);
    $('#t_save').onclick = async () => {
      try { await api('/taux', { method: 'POST', body: { taux: $('#t_taux').value, date_debut: $('#t_deb').value, date_fin: $('#t_fin').value, reference: $('#t_ref').value } }); closeOverlay(); toast('Taux ajouté.', 'ok'); renderSettings('taux'); }
      catch (e) { toast(e.message, 'err'); }
    };
  };
}

/* ============================== EXPORTS (centre des livrables — routes existantes uniquement) ============================== */
async function renderExports() {
  if (!state.clientId) return noClient();
  await ensurePeriod();
  const c = currentClient(), p = state.period, per = `${TRI_LABEL(p.trimestre)} ${p.annee}`;
  const locked = currentPeriodLocked();
  const decl = `/api/clients/${state.clientId}/declaration`, vq = `?annee=${p.annee}&trimestre=${p.trimestre}`;
  const item = (fmt, cls, title, sub, action) => `<div class="exp"><span class="fmt-ic ${cls}">${fmt}</span><div class="e-b"><b>${title}</b><small>${sub}</small>${action}</div></div>`;
  $('#view').innerHTML = `
  <div class="page-head"><div class="eyebrow">${esc(c.name)} · ${per}</div><h1>Exports</h1><p>Tous les livrables de la période active. Chaque fichier reproduit <b>exactement</b> ce qu'affiche l'écran correspondant ; chaque export de déclaration, de feuille de délais ou de visa est inscrit au journal d'audit.</p></div>
  ${locked ? `<div class="note note-locked">${svgI('lock')}<div><div class="note-t">Période clôturée — livrables figés</div>Les exports de ${per} reproduisent l'état arrêté à la clôture, quelles que soient les modifications ultérieures.</div></div>` : ''}
  <div class="section-title mt-0"><h2>Déclaration DGI</h2><span class="sub">tableau des factures payées hors délai</span></div>
  <div class="exp-grid">
    ${item('CSV', 'csv', 'Déclaration — CSV', 'Tableau déclaratif, séparateur « ; », montants à 2 décimales.', `<a class="btn btn-ghost btn-sm" href="${decl}/export.csv${perQuery()}">${svgI('dl')}Télécharger</a>`)}
    ${item('XML', 'xml', 'Déclaration — XML EDI', 'Format d’échange, exclusions réseau tracées.', `<a class="btn btn-ghost btn-sm" href="${decl}/export.xml${perQuery()}">${svgI('dl')}Télécharger</a>`)}
  </div>
  <div class="section-title"><h2>Feuille de calcul des délais</h2><span class="sub">Excel, par filtre</span></div>
  <div class="exp-grid">
    ${item('XLSX', 'xls', 'Toutes les factures', 'Détail du calcul facture par facture.', `<button class="btn btn-ghost btn-sm xls-export" data-x="all">${svgI('dl')}Télécharger</button>`)}
    ${item('XLSX', 'xls', 'Factures en retard', 'Uniquement les factures à déclarer.', `<button class="btn btn-ghost btn-sm xls-export" data-x="retard">${svgI('dl')}Télécharger</button>`)}
    ${item('XLSX', 'xls', 'Conventions absentes', 'Délai de 120 j appliqué sans convention.', `<button class="btn btn-ghost btn-sm xls-export" data-x="conv">${svgI('dl')}Télécharger</button>`)}
  </div>
  <div class="section-title"><h2>Visa</h2><span class="sub">modèle officiel — conclusion à choisir explicitement</span></div>
  <div class="exp-grid">
    ${item('DOCX', 'doc', 'Visa — Word', 'Modifiable avant signature.', `<a class="btn btn-ghost btn-sm" href="/api/clients/${state.clientId}/visa/export.docx${vq}">${svgI('dl')}Télécharger</a>`)}
    ${item('PDF', 'pdf', 'Visa — PDF', 'Une page A4, prête à signer.', `<a class="btn btn-ghost btn-sm" href="/api/clients/${state.clientId}/visa/export.pdf${vq}">${svgI('dl')}Télécharger</a>`)}
    ${item(svgI('seal', ''), '', 'Paramétrer le visa', 'Conclusion, signataire et aperçu.', `<button class="btn btn-quiet btn-sm" onclick="setView('visa')">Ouvrir le générateur</button>`)}
  </div>
  <div class="section-title"><h2>Modèles</h2></div>
  <div class="exp-grid">${item('XLSX', 'xls', 'Modèle de liste de conventions', 'Fichier prêt à remplir (exemples fictifs).', `<a class="btn btn-ghost btn-sm" href="/api/conventions/template.xlsx">${svgI('dl')}Télécharger</a>`)}</div>`;
  $$('.xls-export').forEach(b => b.onclick = () => exportDelais(b.dataset.x, b));
}

/* ============================== AUDIT ============================== */
const ROLE_FR = { admin: 'Administrateur', collaborateur: 'Comptable', lecture: 'Lecture seule' };
const ENTITE_LBL = { utilisateur: 'Utilisateur', entreprise: 'Client', facture: 'Facture', convention: 'Convention', fournisseur: 'Fournisseur', declaration: 'Déclaration',
  periode: 'Période', import_lot: 'Import', document: 'Fichier', espace_travail: 'Espace de travail', invitation: 'Invitation', taux_bam: 'Taux BAM', visa: 'Visa', export: 'Export', anomalie: 'Anomalie' };
const DET_KEY = { email: 'E-mail', role: 'Rôle', avant: 'Avant', apres: 'Après', nom: 'Nom', actif: 'Actif', annee: 'Année', trimestre: 'Trimestre', statut: 'Statut',
  factures: 'Factures', imported: 'Factures importées', file: 'Fichier', taille: 'Taille', taux: 'Taux', motif: 'Motif', nb: 'Lignes', exclues: 'Exclues', figee: 'Période figée',
  format: 'Format', slug: 'Adresse', admin: 'Administrateur', raison: 'Motif', operateur_reseau: 'Opérateur de réseau', date_debut: 'Début', delai: 'Délai (j)', entreprise: 'Client' };
const HIDDEN_DET = new Set(['id', 'importId', 'utilisateur', 'facture', 'token', 'hash']);
function detVal(k, v) {
  if (v == null || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Oui' : 'Non';
  if ((k === 'role' || k === 'avant' || k === 'apres') && ROLE_FR[v]) return ROLE_FR[v];
  if (k === 'trimestre') return 'T' + v;
  if (typeof v === 'object') return Object.entries(v).filter(([kk]) => !HIDDEN_DET.has(kk)).map(([kk, vv]) => `${DET_KEY[kk] || kk.replace(/_/g, ' ')} : ${detVal(kk, vv)}`).join(', ');
  return String(v);
}
function auditDetails(raw) {
  if (!raw) return '';
  let o; try { o = JSON.parse(raw); } catch (_) { return String(raw); }
  if (o == null || typeof o !== 'object') return String(o);
  return Object.entries(o).filter(([k]) => !HIDDEN_DET.has(k)).map(([k, v]) => `${DET_KEY[k] || k.replace(/_/g, ' ')} : ${detVal(k, v)}`).join(' · ');
}
const AUDIT_LBL = { login: 'Connexion', import: 'Import de factures', import_confirme: 'Import confirmé', import_analyse: 'Fichier analysé', annulation_import: 'Import annulé',
  create: 'Création', update: 'Modification', delete: 'Suppression', cloture_periode: 'Clôture de période', reouverture_periode: 'Réouverture de période', recalcul: 'Recalcul',
  revue_doublon: 'Revue de doublon', classification_fournisseur: 'Classification réseau', import_conventions: 'Import de conventions', export: 'Export',
  connexion_refusee: 'Connexion refusée', verrouillage_connexion: 'Connexion verrouillée' };
async function renderAudit() {
  const rows = await api('/audit');
  const tone = a => /cloture/.test(a) ? 'pill-locked' : /reouverture|connexion_refusee/.test(a) ? 'pill-warn' : /delete|annulation|verrouillage/.test(a) ? 'pill-late' : a === 'login' ? '' : 'pill-brand';
  $('#view').innerHTML = `
  <div class="page-head"><div class="eyebrow">Contrôle</div><h1>Journal d'audit</h1><p>Traçabilité des actions sensibles : connexions, imports, conventions, clôtures et réouvertures, exports. Les 100 dernières entrées.</p></div>
  <div class="table-wrap"><table class="dense rc"><thead><tr><th>Date</th><th>Utilisateur</th><th>Action</th><th data-prio="2">Objet</th><th>Détails</th></tr></thead>
  <tbody>${rows.length ? rows.map(a => { const det = auditDetails(a.details); return `<tr><td class="mono dh nowrap" data-rc="m">${esc(dateTimeFr(a.created_at))}</td><td data-rc="m">${esc(a.user_nom || '—')}</td><td data-rc="t"><span class="pill pill-sm ${tone(a.action)}">${esc(AUDIT_LBL[a.action] || a.action)}</span></td><td class="dh" data-prio="2">${esc(ENTITE_LBL[a.entite] || a.entite || '—')}</td><td class="dh audit-det" data-rc="s" title="${esc(det)}">${esc(det)}</td></tr>`; }).join('') : '<tr><td colspan="5" class="dh ta-c p-24">Aucune entrée.</td></tr>'}</tbody></table></div>`;
}

/* ============================== divers ============================== */
function noClient() {
  if (state.clients.length) { $('#view').innerHTML = emptyBox('Aucun dossier sélectionné', 'Choisissez un client dans la barre supérieure ou dans la liste pour afficher ses délais, conventions et déclarations.', 'clients', 'Choisir un client', 'building'); return; }
  if (!can('create_client')) { $('#view').innerHTML = emptyBox('Aucun dossier client pour le moment', 'Cet espace ne contient encore aucun client. Un administrateur ou un comptable du cabinet doit le créer ; il apparaîtra ici automatiquement.', null, null, 'building'); return; }
  $('#view').innerHTML = emptyBox('Aucun dossier client', 'Créez un premier client dans « Clients » pour accéder à ses délais, conventions et déclarations.', 'clients', 'Ouvrir les clients', 'building');
}
function emptyBox(title, msg, gotoView, ctaLabel, icon = 'table') {
  return `<div class="card"><div class="empty"><div class="ic">${svgI(icon, '')}</div><h4>${esc(title)}</h4><p>${esc(msg)}</p>${gotoView ? `<div class="actions"><button class="btn btn-primary" onclick="setView('${gotoView}')">${esc(ctaLabel || 'Continuer')}</button></div>` : ''}</div></div>`;
}
// Badges de la barre latérale — « Alertes » = nombre de lignes de la page Alertes ; « Anomalies » = anomalies à traiter
// (ouvertes + à vérifier), même source que tous les compteurs (src/anomalies.js). Toujours relus sans cache.
async function refreshAlertsBadge() {
  try {
    const [d, n] = await Promise.all([api('/alerts', { fresh: true }), api('/anomalies/counts', { fresh: true })]);
    const set = (el, v) => { if (!el) return; el.textContent = v; el.classList.toggle('hidden', !(v > 0)); };
    set($('#alertBadge'), d.count); set($('#anoBadge'), n.aTraiter);
    const dot = $('#notifDot'); if (dot) dot.classList.toggle('hidden', !(d.count > 0));
  } catch {}
}

boot();
