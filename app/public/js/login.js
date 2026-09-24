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
  if (t.known) {
    document.getElementById('wsBox').classList.remove('hidden');
    document.getElementById('wsName').textContent = t.displayName;
    const m = document.getElementById('wsMono'); m.textContent = t.initials;
    if (t.primaryColor) m.style.background = t.primaryColor;
    document.getElementById('loginTitle').textContent = 'Bienvenue';
    document.getElementById('loginLead').textContent = `Connectez-vous à l'espace ${t.displayName} sur DelaiPay.`;
    document.title = `Connexion — ${t.displayName} · DelaiPay`;
  } else if (t.slug) {
    // Sous-domaine d'espace inconnu : on le dit clairement plutôt que d'accepter une connexion ambiguë.
    errBox.innerHTML = ERR_ICO + `<span>Aucun espace de travail ne correspond à l'adresse « ${esc(t.slug)} ». Vérifiez le lien fourni par votre cabinet.</span>`;
    errBox.classList.remove('hidden');
  }
}).catch(() => {});

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
    if (!res.ok) throw new Error(data.error || 'Échec de la connexion.');
    btn.innerHTML = 'Ouverture de l\'espace…';
    window.location.replace('/');
  } catch (err) {
    showErr(err.message);
    btn.disabled = false; btn.textContent = 'Se connecter';
  }
});
function showErr(msg) { errBox.innerHTML = ERR_ICO + `<span>${esc(msg)}</span>`; errBox.classList.remove('hidden'); }
