'use strict';
/* Console plateforme DelaiPay — application monopage sans script inline (CSP script-src 'self').
 * Aucune donnée comptable n'est jamais demandée au serveur par cette interface. */
(function () {
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
(function theme() { let t = null; try { t = localStorage.getItem('dp-theme'); } catch (_) {} if (!t && matchMedia('(prefers-color-scheme: dark)').matches) t = 'dark'; document.documentElement.setAttribute('data-theme', t || 'light'); })();

const IC = {
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 9v4m0 4h.01M10.3 3.9L2 18a2 2 0 001.7 3h16.6a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/></svg>',
  ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12l5 5L20 7"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 6l-6 6 6 6"/></svg>',
  out: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5"/></svg>',
};
const C = window.DPC = { $, $$, esc, IC, state: { me: null }, views: {} };

/* ------------------------------------------------------------------ format */
const pad = n => String(n).padStart(2, '0');
function toDate(s) { if (!s) return null; const d = new Date(/Z$|[+-]\d\d:\d\d$/.test(s) ? s : String(s).replace(' ', 'T') + 'Z'); return isNaN(d) ? null : d; }
C.fdt = s => { const d = toDate(s); return d ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}` : '—'; };
C.fd = s => { if (!s) return '—'; const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : '—'; };
C.money = n => n == null || isNaN(n) ? '—' : Number(n).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/\u202f|\u00a0/g, ' ') + ' <span class="dh">DH</span>';
C.int = n => n == null ? '—' : Number(n).toLocaleString('fr-FR').replace(/\u202f|\u00a0/g, ' ');
C.ago = s => { const d = toDate(s); if (!d) return '—'; const m = Math.round((Date.now() - d) / 60000); if (m < 1) return 'à l’instant'; if (m < 60) return `il y a ${m} min`; const h = Math.round(m / 60); if (h < 48) return `il y a ${h} h`; return C.fdt(s); };
C.bytes = n => n == null ? '—' : n < 1024 ? n + ' o' : n < 1048576 ? (n / 1024).toFixed(1).replace('.', ',') + ' Ko' : (n / 1048576).toFixed(1).replace('.', ',') + ' Mo';

/* ------------------------------------------------------------------ API */
let lastActivity = Date.now(), idleSeconds = 900;
C.api = async function api(method, url, body) {
  const opt = { method, credentials: 'same-origin', headers: { 'X-DP-Console': '1' } };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  let r;
  try { r = await fetch('/api/platform' + url, opt); }
  catch (_) { throw Object.assign(new Error('Serveur injoignable. Vérifiez la connexion puis réessayez.'), { status: 0 }); }
  const data = await r.json().catch(() => ({}));
  if (r.ok) lastActivity = Date.now();
  if (r.status === 401 && C.state.me && !/^\/auth\//.test(url)) { C.state.me = null; showLogin(data.code === 'session_expiree' ? 'Votre session a expiré. Reconnectez-vous.' : null); }
  if (!r.ok) throw Object.assign(new Error(data.error || 'L’opération n’a pas abouti.'), { status: r.status, code: data.code, data });
  return data;
};

/* ------------------------------------------------------------------ toasts & dialogues */
C.toast = function (msg, kind = 'ok') {
  const z = $('#toasts'); z.innerHTML = '';
  const t = document.createElement('div'); t.className = 'toast ' + kind; t.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  t.innerHTML = `<span class="t-ic">${kind === 'err' ? IC.warn : IC.ok}</span><div>${esc(msg)}</div>`;
  z.appendChild(t); setTimeout(() => t.remove(), 5000);
};
/**
 * Dialogue générique. fields : [{name, label, type:'text'|'textarea'|'select'|'number'|'date'|'checkbox', options, required, help, value, placeholder}]
 * typed : texte à saisir pour activer le bouton (destruction). Résout avec les valeurs, ou null si annulé.
 */
C.dialog = function ({ title, body = '', fields = [], confirm = 'Confirmer', danger = false, typed = null, wide = false, cancel = 'Annuler' }) {
  return new Promise(resolve => {
    const scrim = document.createElement('div'); scrim.className = 'scrim';
    const m = document.createElement('div'); m.className = 'modal' + (wide ? ' modal-lg' : ' modal-sm'); m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true');
    const fid = f => 'dlg_' + f.name;
    const fieldHtml = f => {
      const req = f.required ? ' required' : '';
      const help = f.help ? `<small class="fld-help">${esc(f.help)}</small>` : '';
      if (f.type === 'checkbox') return `<div class="fld"><label class="check"><input type="checkbox" id="${fid(f)}" ${f.value ? 'checked' : ''}> <span>${esc(f.label)}</span></label>${help}</div>`;
      let input;
      if (f.type === 'textarea') input = `<textarea class="input-fld" id="${fid(f)}" rows="3" maxlength="${f.max || 500}" placeholder="${esc(f.placeholder || '')}"${req}>${esc(f.value || '')}</textarea>`;
      else if (f.type === 'select') input = `<select class="input-fld" id="${fid(f)}">${f.options.map(o => `<option value="${esc(o.value)}" ${String(o.value) === String(f.value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
      else input = `<input class="input-fld" id="${fid(f)}" type="${f.type || 'text'}" value="${esc(f.value == null ? '' : f.value)}" placeholder="${esc(f.placeholder || '')}" autocomplete="off"${req}${f.min != null ? ` min="${f.min}"` : ''}${f.max != null && f.type === 'number' ? ` max="${f.max}"` : ''}>`;
      return `<div class="fld"><label class="fld-lbl" for="${fid(f)}">${esc(f.label)}${f.required ? '' : ' <span class="muted t-xs">(facultatif)</span>'}</label>${input}${help}</div>`;
    };
    m.innerHTML = `<div class="modal-h"><h3>${esc(title)}</h3></div><div class="modal-b">${body}${fields.map(fieldHtml).join('')}
      ${typed ? `<div class="fld"><label class="fld-lbl" for="dlg_typed">Saisissez « ${esc(typed)} » pour confirmer</label><input class="input-fld" id="dlg_typed" autocomplete="off"></div>` : ''}
      <div class="fld-err hidden" id="dlg_err" role="alert"></div></div>
      <div class="modal-f"><button class="btn btn-ghost" data-x="0">${esc(cancel)}</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-x="1">${esc(confirm)}</button></div>`;
    document.body.append(scrim, m);
    const ok = $('[data-x="1"]', m);
    const close = v => { scrim.remove(); m.remove(); resolve(v); };
    if (typed) { ok.disabled = true; $('#dlg_typed', m).addEventListener('input', e => { ok.disabled = e.target.value.trim() !== typed; }); }
    $('[data-x="0"]', m).addEventListener('click', () => close(null));
    scrim.addEventListener('click', () => close(null));
    m.addEventListener('keydown', e => { if (e.key === 'Escape') close(null); });
    ok.addEventListener('click', () => {
      const v = {};
      for (const f of fields) {
        const el = $('#' + fid(f), m);
        v[f.name] = f.type === 'checkbox' ? el.checked : el.value.trim();
        if (f.required && !v[f.name]) { const e = $('#dlg_err', m); e.textContent = `« ${f.label} » est obligatoire.`; e.classList.remove('hidden'); el.focus(); return; }
      }
      close(v);
    });
    setTimeout(() => { const first = $('input,textarea,select', m); (first || ok).focus(); }, 30);
  });
};
/** Encart « affiché une seule fois » avec bouton Copier (lien d'invitation, réinitialisation, accès support). */
C.onceBox = (label, value, note) => `<div class="once"><div class="t-sm fw-6">${esc(label)}</div>
  <div class="once-row mt-8"><input class="input-fld" readonly value="${esc(value)}" aria-label="${esc(label)}"><button class="btn btn-ghost btn-sm" data-copy="${esc(value)}">${IC.copy}Copier</button></div>
  ${note ? `<small class="fld-help">${esc(note)}</small>` : ''}</div>`;
document.addEventListener('click', e => {
  const b = e.target.closest('[data-copy]'); if (!b) return;
  const v = b.getAttribute('data-copy');
  (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject()).then(() => C.toast('Copié dans le presse-papiers.'))
    .catch(() => { const i = b.parentElement.querySelector('input'); if (i) { i.select(); document.execCommand('copy'); C.toast('Copié.'); } });
});
C.showOnce = (title, html) => C.dialog({ title, body: html, confirm: 'J’ai copié ce lien', cancel: 'Fermer' });

/* ------------------------------------------------------------------ connexion */
function stepHtml(inner) { $('#loginStep').innerHTML = inner; }
function errBox() { return '<div id="lerr" class="login-err hidden" role="alert"></div>'; }
function showErr(msg) { const e = $('#lerr'); if (e) { e.textContent = msg; e.classList.remove('hidden'); } }
async function post(url, body) { return C.api('POST', url, body); }

function showLogin(notice) {
  $('#app').classList.add('hidden'); $('#loginScreen').classList.remove('hidden');
  document.title = 'Console plateforme — DelaiPay';
  stepHtml(`<h1>Connexion à la console</h1><p class="lead">Espace réservé à l’équipe DelaiPay.</p>
    ${notice ? `<div class="note note-info mb-14">${IC.info}<div>${esc(notice)}</div></div>` : ''}${errBox()}
    <form id="pwForm" novalidate>
      <div class="fld"><label class="fld-lbl" for="email">Adresse e-mail</label><input class="input-fld" id="email" type="email" autocomplete="username" required></div>
      <div class="fld"><label class="fld-lbl" for="password">Mot de passe</label><input class="input-fld" id="password" type="password" autocomplete="current-password" required></div>
      <button class="btn btn-primary login-submit" type="submit">Continuer</button>
    </form>`);
  $('#email').focus();
  $('#pwForm').addEventListener('submit', async e => {
    e.preventDefault();
    const email = $('#email').value.trim(), password = $('#password').value;
    if (!email || !password) return showErr('Saisissez votre adresse e-mail et votre mot de passe.');
    try { const r = await post('/auth/login', { email, password }); r.next === 'totp' ? showCode() : showEnrol(); }
    catch (err) { showErr(err.message); $('#password').value = ''; $('#password').focus(); }
  });
}
function showCode(useRecovery) {
  stepHtml(`<h1>Code de vérification</h1><p class="lead">${useRecovery ? 'Saisissez l’un de vos codes de secours (usage unique).' : 'Saisissez le code à 6 chiffres affiché par votre application d’authentification.'}</p>${errBox()}
    <form id="codeForm" novalidate>
      <div class="fld"><label class="fld-lbl" for="code">${useRecovery ? 'Code de secours' : 'Code à 6 chiffres'}</label>
        <input class="input-fld otp-input" id="code" ${useRecovery ? 'autocomplete="off" placeholder="xxxxx-xxxxx"' : 'inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000"'} required></div>
      <button class="btn btn-primary login-submit" type="submit">Vérifier</button>
    </form>
    <p class="mt-14"><button class="linkish" id="swap">${useRecovery ? 'Utiliser l’application d’authentification' : 'Utiliser un code de secours'}</button> · <button class="linkish" id="restart">Recommencer</button></p>`);
  $('#code').focus();
  $('#swap').addEventListener('click', () => showCode(!useRecovery));
  $('#restart').addEventListener('click', () => showLogin());
  $('#codeForm').addEventListener('submit', async e => {
    e.preventDefault();
    const v = $('#code').value.trim();
    try {
      const r = await post('/auth/code', useRecovery ? { recoveryCode: v } : { code: v });
      if (r.method === 'code de secours') C.toast(`Code de secours utilisé. Il vous en reste ${r.recoveryCodesRemaining}.`, r.recoveryCodesRemaining <= 2 ? 'warn' : 'ok');
      boot();
    } catch (err) {
      if (err.code === 'etape_invalide') return showLogin('Étape expirée ou trop d’essais : reconnectez-vous.');
      showErr(err.message); $('#code').value = ''; $('#code').focus();
    }
  });
}
async function showEnrol() {
  let d;
  try { d = await C.api('GET', '/auth/enrolment'); } catch (_) { return showLogin('Étape expirée : reconnectez-vous.'); }
  stepHtml(`<h1>Activez la double authentification</h1><p class="lead">Obligatoire pour la console. Scannez ce QR code avec votre application d’authentification (Google Authenticator, Aegis, 1Password…).</p>${errBox()}
    <div class="qr-box"><div class="qr">${d.qrSvg}</div>
      <div style="min-width:0;flex:1"><div class="t-sm fw-6">Compte</div><div class="t-sm mb-14">${esc(d.email)}</div>
      <div class="t-sm fw-6">Saisie manuelle de la clé</div><div class="secret mt-8">${esc(d.secret)}</div>
      <small class="fld-help">Type : basé sur le temps (TOTP), 6 chiffres, 30 secondes.</small></div></div>
    <form id="enrolForm" novalidate>
      <div class="fld"><label class="fld-lbl" for="code">Code affiché par l’application</label><input class="input-fld otp-input" id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" required></div>
      <button class="btn btn-primary login-submit" type="submit">Activer et continuer</button>
    </form>`);
  $('#code').focus();
  $('#enrolForm').addEventListener('submit', async e => {
    e.preventDefault();
    try { const r = await post('/auth/enrolment', { code: $('#code').value.trim() }); showCodes(r.recoveryCodes, true); }
    catch (err) { if (err.code === 'etape_invalide') return showLogin('Étape expirée ou trop d’essais : reconnectez-vous.'); showErr(err.message); $('#code').value = ''; }
  });
}
function codesHtml(codes) {
  return `<div class="note note-warn">${IC.warn}<div><div class="note-t">Affichés une seule fois</div>Conservez ces 10 codes hors ligne (gestionnaire de mots de passe, coffre). Chacun permet UNE connexion si vous perdez votre téléphone.</div></div>
    <div class="codes" id="codesList">${codes.map(c => `<span>${esc(c)}</span>`).join('')}</div>
    <button class="btn btn-ghost btn-sm" data-copy="${esc(codes.join('\n'))}">${IC.copy}Copier les 10 codes</button>`;
}
function showCodes(codes, thenBoot) {
  stepHtml(`<h1>Codes de secours</h1>${codesHtml(codes)}
    <label class="check mt-14"><input type="checkbox" id="kept"> <span>J’ai conservé ces codes en lieu sûr.</span></label>
    <button class="btn btn-primary login-submit mt-14" id="goOn" disabled>Accéder à la console</button>`);
  $('#kept').addEventListener('change', e => { $('#goOn').disabled = !e.target.checked; });
  $('#goOn').addEventListener('click', () => { if (thenBoot) boot(); });
}
C.codesHtml = codesHtml;

/* ------------------------------------------------------------------ coquille */
const TITLES = { dash: 'Tableau de bord', workspaces: 'Espaces de travail', workspace: 'Espace de travail', 'workspace-new': 'Nouvel espace', sessions: 'Sessions et appareils',
  activity: 'Activité de connexion', audit: 'Journal plateforme', settings: 'Réglages', account: 'Mon compte' };
function parseHash() {
  const h = (location.hash || '#/dash').replace(/^#\/?/, '');
  const [view, ...rest] = h.split('/');
  return { view: C.views[view] ? view : 'dash', params: rest.map(decodeURIComponent) };
}
C.go = (view, ...params) => { location.hash = '#/' + [view, ...params.map(encodeURIComponent)].join('/'); };
async function render() {
  if (!C.state.me) return;
  const { view, params } = parseHash();
  $$('.nav-item').forEach(b => b.toggleAttribute('aria-current', b.dataset.view === view || (/^workspace/.test(view) && b.dataset.view === 'workspaces')));
  $$('.nav-item').forEach(b => { if (b.hasAttribute('aria-current')) b.setAttribute('aria-current', 'page'); });
  $('#crumbView').textContent = TITLES[view] || '';
  document.title = `${TITLES[view] || 'Console'} — Console DelaiPay`;
  const el = $('#view');
  el.innerHTML = '<div class="skel-page"><div class="skel skel-row"></div><div class="skel skel-row"></div><div class="skel skel-row"></div></div>';
  $('#app').classList.remove('nav-open');
  try { await C.views[view](el, params); }
  catch (e) { if (e.status === 401) return; el.innerHTML = `<div class="empty err"><div class="ic">${IC.warn}</div><h4>Affichage impossible</h4><p>${esc(e.message)}</p><div class="actions"><button class="btn btn-ghost" id="retry">Réessayer</button></div></div>`; $('#retry').addEventListener('click', render); }
}
window.addEventListener('hashchange', render);
C.render = render;

function tickIdle() {
  if (!C.state.me) return;
  const left = Math.max(0, idleSeconds - Math.round((Date.now() - lastActivity) / 1000));
  $('#idleTimer').textContent = `Déconnexion auto. dans ${Math.floor(left / 60)}:${pad(left % 60)}`;
  if (left === 0) { C.state.me = null; showLogin('Déconnecté après inactivité.'); }
}
setInterval(tickIdle, 1000);

async function boot() {
  let me;
  try { me = await C.api('GET', '/me'); }
  catch (_) {
    const st = await C.api('GET', '/auth/state').catch(() => ({}));
    if (st.etape === 'mfa') return (showLogin(), showCode());
    if (st.etape === 'enrolement') return (showLogin(), showEnrol());
    return showLogin();
  }
  C.state.me = me; idleSeconds = me.session.idleSeconds; lastActivity = Date.now();
  $('#loginScreen').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#sideName').textContent = me.admin.nom; $('#sideAv').textContent = (me.admin.nom || '··').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  $('#consEnv').textContent = location.host;
  if (me.recoveryCodesRemaining <= 2) C.toast(`Il ne vous reste que ${me.recoveryCodesRemaining} code(s) de secours : régénérez-les dans « Mon compte ».`, 'warn');
  render();
}
$$('.nav-item').forEach(b => b.addEventListener('click', () => C.go(b.dataset.view)));
$('#menuBtn').addEventListener('click', () => { const o = $('#app').classList.toggle('nav-open'); $('#menuBtn').setAttribute('aria-expanded', String(o)); });
$('#logoutBtn').addEventListener('click', async () => { try { await post('/auth/logout', {}); } catch (_) {} C.state.me = null; showLogin('Vous êtes déconnecté.'); });

/* ------------------------------------------------------------------ vues de base */
C.pageHead = (title, sub, actions = '') => `<div class="page-head"><div><h1>${esc(title)}</h1>${sub ? `<p>${sub}</p>` : ''}</div>${actions ? `<div class="actions">${actions}</div>` : ''}</div>`;
C.table = (head, rows, { empty = 'Aucune donnée.', cls = '' } = {}) => rows.length
  ? `<div class="table-wrap ops-wrap"><table class="ops rc ${cls}"><thead><tr>${head.map(h => `<th${h.num ? ' class="num"' : ''}${h.prio ? ` data-prio="${h.prio}"` : ''}>${h.html || esc(h.label || h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`
  : `<div class="card"><div class="empty"><div class="ic">${IC.info}</div><p>${esc(empty)}</p></div></div>`;

const ACTION_FR = {
  admin_plateforme_cree: 'Administrateur plateforme créé', connexion_console: 'Connexion à la console', connexion_console_refusee: 'Connexion à la console refusée',
  verrouillage_console: 'Verrouillage (trop d’essais)', deconnexion_console: 'Déconnexion de la console', enrolement_2fa: 'Double authentification activée',
  enrolement_2fa_refuse: 'Enrôlement 2FA refusé', codes_de_secours_regeneres: 'Codes de secours régénérés', reinitialisation_2fa: 'Double authentification réinitialisée (CLI)',
  admin_plateforme_desactive: 'Administrateur plateforme désactivé', admin_plateforme_active: 'Administrateur plateforme réactivé',
  mot_de_passe_admin_plateforme: 'Mot de passe administrateur remplacé (CLI)', liste_ip_console: 'Liste d’IP de la console modifiée',
};
C.ACTION_FR = ACTION_FR;
function diffHtml(r) {
  const fmt = v => esc(typeof v === 'string' ? v : JSON.stringify(v, null, 1));
  const parts = [];
  if (r.avant != null) parts.push(`<div><span class="k">avant :</span> ${fmt(r.avant)}</div>`);
  if (r.apres != null) parts.push(`<div><span class="k">après :</span> ${fmt(r.apres)}</div>`);
  if (r.details != null) parts.push(`<div><span class="k">détails :</span> ${fmt(r.details)}</div>`);
  return parts.length ? `<details class="row-det"><summary>Voir</summary><div class="diff">${parts.join('')}</div></details>` : '<span class="muted">—</span>';
}
C.auditTable = rows => C.table(['Date', 'Administrateur', 'Action', 'Cible', 'Avant → après', { label: 'IP', prio: 2 }], rows.map(r => `<tr>
  <td class="first mono">${C.fdt(r.created_at)}</td><td data-l="Par">${esc(r.admin_email || '—')}</td>
  <td data-l="Action"><b>${esc(ACTION_FR[r.action] || r.action)}</b></td>
  <td data-l="Cible">${esc(r.cible_libelle || '—')}${r.cible_type ? ` <span class="muted t-xs">${esc(r.cible_type)}</span>` : ''}</td>
  <td class="wrap">${diffHtml(r)}</td><td class="mono muted" data-l="IP" data-prio="2">${esc(r.ip || '—')}</td></tr>`), { empty: 'Aucune entrée.' });

C.views.audit = async (el) => {
  const d = await C.api('GET', '/audit?limit=200');
  el.innerHTML = C.pageHead('Journal plateforme', 'Toutes les actions de la console et de la ligne de commande : qui, quoi, quelle cible, avant → après, adresse IP, heure. <b>Lecture seule</b> : aucune entrée ne peut être modifiée ni supprimée.')
    + C.auditTable(d.rows);
};
C.views.account = async (el) => {
  const me = C.state.me;
  el.innerHTML = C.pageHead('Mon compte', 'Administrateur plateforme.') + `<div class="cons-grid">
    <div class="card"><div class="card-h"><h3>Identité</h3></div><div class="card-b"><dl class="dl-ops">
      <dt>Nom</dt><dd>${esc(me.admin.nom)}</dd><dt>E-mail</dt><dd>${esc(me.admin.email)}</dd>
      <dt>Double authentification</dt><dd><span class="pill pill-ok pill-sm">${IC.ok}Activée</span></dd>
      <dt>Codes de secours restants</dt><dd>${me.recoveryCodesRemaining} / 10</dd>
      <dt>Votre adresse IP</dt><dd class="mono">${esc(me.ip || '—')}</dd>
      <dt>Session</dt><dd>expire au plus tard le ${C.fdt(me.session.expiresAt)} · déconnexion après ${Math.round(me.session.idleSeconds / 60)} min d’inactivité</dd>
    </dl></div></div>
    <div class="card"><div class="card-h"><h3>Codes de secours</h3></div><div class="card-b">
      <p class="t-sm m-0">Régénérer invalide immédiatement les anciens codes. Un code de votre application d’authentification est demandé.</p>
      <div class="mt-14"><button class="btn btn-ghost" id="regen">Régénérer les codes de secours</button></div><div id="newCodes"></div>
      <p class="t-xs muted mt-14">Mot de passe, désactivation et réinitialisation de la 2FA : ligne de commande du serveur (<span class="mono">npm run platform:admin</span>).</p>
    </div></div></div>`;
  $('#regen').addEventListener('click', async () => {
    const v = await C.dialog({ title: 'Régénérer les codes de secours ?', body: '<p class="t-sm">Les 10 codes actuels cesseront de fonctionner.</p>', fields: [{ name: 'code', label: 'Code à 6 chiffres de l’application', required: true }], confirm: 'Régénérer' });
    if (!v) return;
    try { const r = await post('/me/recovery-codes', { code: v.code }); $('#newCodes').innerHTML = '<div class="mt-14">' + codesHtml(r.recoveryCodes) + '</div>'; C.state.me.recoveryCodesRemaining = 10; }
    catch (e) { C.toast(e.message, 'err'); }
  });
};
C.views.dash = async (el) => { el.innerHTML = C.pageHead('Tableau de bord', 'Vue d’ensemble de la plateforme.'); };

document.addEventListener('DOMContentLoaded', () => { for (const f of (window.DPC_EXT || [])) f(C); boot(); });
if (document.readyState !== 'loading') { for (const f of (window.DPC_EXT || [])) f(C); boot(); }
})();
