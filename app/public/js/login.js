'use strict';
const form = document.getElementById('loginForm');
const errBox = document.getElementById('err');
const btn = document.getElementById('submitBtn');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ERR_ICO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8v4m0 4h.01"/></svg>';

// Thème : préférence mémorisée, sinon celle du système.
(function theme() {
  let t = null; try { t = localStorage.getItem('dp-theme'); } catch (_) {}
  if (!t && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) t = 'dark';
  document.documentElement.setAttribute('data-theme', t || 'light');
})();

// Identité de l'espace désigné par le nom d'hôte (premium.delaipay.local → « Premium »).
fetch('/api/tenant', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : null).then(t => {
  if (!t) return;
  // Bandeaux de maintenance (plateforme / espace) — information, la connexion reste possible.
  if (t.maintenance && t.maintenance.length) {
    const box = document.createElement('div');
    box.innerHTML = t.maintenance.map(m => `<div class="note note-info mb-14"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg><div><div class="note-t">${m.portee === 'espace' ? 'Maintenance de votre espace' : 'Maintenance DelaiPay'}</div>${esc(m.message)}${m.fin ? ` (fin prévue le ${esc(new Date(m.fin).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }))})` : ''}</div></div>`).join('');
    const n = document.getElementById('notice'); n.parentNode.insertBefore(box, n);
  }
  if (t.deleted) {
    errBox.innerHTML = ERR_ICO + '<span>Cet espace de travail n’est plus disponible.</span>'; errBox.classList.remove('hidden');
    btn.disabled = true; document.querySelectorAll('#loginForm input').forEach(i => { i.disabled = true; });
    return;
  }
  if (t.known) {
    document.getElementById('wsBox').classList.remove('hidden');
    document.getElementById('wsName').textContent = t.displayName;
    const m = document.getElementById('wsMono');
    if (t.logoUrl) { const img = new Image(); img.alt = ''; img.className = 'ws-logo-img'; img.src = t.logoUrl; m.textContent = ''; m.appendChild(img); m.classList.add('has-logo'); }
    else { m.textContent = t.initials; if (t.palette) { m.style.background = t.palette.tenant; m.style.color = t.palette.tenantInk; } }
    if (t.active === false) {
      showNotice('warn', 'Espace de travail désactivé', `L’accès à l’espace ${t.displayName} est suspendu. Contactez DelaiPay pour le réactiver.`);
      btn.disabled = true;
    }
    document.getElementById('loginTitle').textContent = 'Bienvenue';
    document.getElementById('loginLead').textContent = `Connectez-vous à l'espace ${t.displayName} sur DelaiPay.`;
    document.title = `Connexion — ${t.displayName} · DelaiPay`;
  } else if (t.slug) {
    // Sous-domaine d'espace inconnu : on le dit clairement plutôt que d'accepter une connexion ambiguë.
    errBox.innerHTML = ERR_ICO + `<span>Aucun espace de travail ne correspond à l'adresse « ${esc(t.slug)} ». Vérifiez le lien fourni par votre cabinet.</span>`;
    errBox.classList.remove('hidden');
    // P3-7 : formulaire désactivé — aucune connexion possible vers un espace qui n'existe pas.
    btn.disabled = true;
    document.querySelectorAll('#loginForm input').forEach(i => { i.disabled = true; });
  }
}).catch(() => {});

// Motif de retour à la connexion (session expirée, compte désactivé…) — jamais d'échec silencieux.
function showNotice(kind, title, msg) {
  const n = document.getElementById('notice');
  const ico = kind === 'warn' ? '<path d="M12 9v4m0 4h.01M10.3 3.9L2 18a2 2 0 001.7 3h16.6a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/>' : '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>';
  n.className = 'note note-' + (kind === 'warn' ? 'warn' : 'info');
  n.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">${ico}</svg><div><div class="note-t">${esc(title)}</div>${esc(msg)}</div>`;
}
const REASONS = {
  expired: ['info', 'Session expirée', 'Pour votre sécurité, votre session a pris fin. Reconnectez-vous pour reprendre là où vous en étiez — aucune donnée n’a été perdue.'],
  expired_stale: ['info', 'Session expirée', 'Votre session n’est plus valide (elle a peut-être expiré ou l’espace a été réinitialisé). Reconnectez-vous.'],
  user_inactive: ['warn', 'Compte désactivé', 'Votre accès a été désactivé par l’administrateur de votre espace.'],
  workspace_inactive: ['warn', 'Espace désactivé', 'Cet espace de travail est suspendu. Contactez DelaiPay pour le réactiver.'],
  wrong_workspace: ['info', 'Autre espace de travail', 'Vous étiez connecté·e à un autre espace. Connectez-vous avec un compte de cet espace.'],
  logout: ['info', 'Déconnexion effectuée', 'À bientôt sur DelaiPay.'],
  session_ended: ['info', 'Session terminée', 'Votre session a pris fin. Reconnectez-vous.'],
  deconnexion_forcee: ['info', 'Session fermée', 'Votre session a été fermée par un administrateur. Reconnectez-vous.'],
  appareil_revoque: ['warn', 'Appareil retiré', 'L’accès depuis cet appareil a été retiré par un administrateur. Contactez l’administrateur de votre espace.'],
  espace_suspendu: ['warn', 'Espace suspendu', 'Cet espace de travail est suspendu. Contactez DelaiPay pour le réactiver.'],
  espace_supprime: ['warn', 'Espace indisponible', 'Cet espace de travail n’est plus disponible.'],
  compte_desactive: ['warn', 'Compte désactivé', 'Votre accès a été désactivé par l’administrateur de votre espace.'],
};
const reason = new URLSearchParams(location.search).get('reason');
if (REASONS[reason]) showNotice(...REASONS[reason]);
if (reason) { try { history.replaceState(null, '', '/login'); } catch (_) {} }

const pw = document.getElementById('password'), tog = document.getElementById('pwToggle');
tog.addEventListener('click', () => {
  const show = pw.type === 'password'; pw.type = show ? 'text' : 'password';
  tog.setAttribute('aria-pressed', String(show)); tog.setAttribute('aria-label', show ? 'Masquer le mot de passe' : 'Afficher le mot de passe');
  pw.focus();
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errBox.classList.add('hidden');
  const email = document.getElementById('email').value.trim();
  if (!email || !pw.value) { showErr('Saisissez votre adresse e-mail et votre mot de passe.'); return; }
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Connexion…';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ email, password: pw.value }),
    });
    const data = await res.json();
    if (res.status === 429) throw new Error(data.error || 'Trop de tentatives de connexion. Patientez 15 minutes avant de réessayer.');
    if (!res.ok) throw new Error(data.error || 'Échec de la connexion.');
    btn.innerHTML = 'Ouverture de l\'espace…';
    window.location.replace('/');
  } catch (err) {
    showErr(err.message === 'Failed to fetch' ? 'Connexion au service impossible. Vérifiez votre réseau puis réessayez.' : err.message);
    btn.disabled = false; btn.textContent = 'Se connecter';
  }
});
function showErr(msg) { const n = document.getElementById('notice'); if (n) n.classList.add('hidden'); errBox.innerHTML = ERR_ICO + `<span>${esc(msg)}</span>`; errBox.classList.remove('hidden'); }
