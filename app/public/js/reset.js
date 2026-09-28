'use strict';
// Réinitialisation de mot de passe. Le jeton est lu dans le FRAGMENT d'URL (#t=…), jamais envoyé dans une URL,
// puis retiré de la barre d'adresse.
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
(function theme() { let t = null; try { t = localStorage.getItem('dp-theme'); } catch (_) {} if (!t && matchMedia('(prefers-color-scheme: dark)').matches) t = 'dark'; document.documentElement.setAttribute('data-theme', t || 'light'); })();
const token = (new URLSearchParams(location.hash.slice(1))).get('t') || '';
try { history.replaceState(null, '', location.pathname); } catch (_) {}
const post = (url, body) => fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  .then(async r => ({ ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) }));
function fail(title, msg) {
  $('#state').innerHTML = `<div class="ic"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 8v4m0 4h.01"/></svg></div><h4>${esc(title)}</h4><p>${esc(msg)}</p><div class="actions"><a class="btn btn-ghost" href="/login">Aller à la connexion</a></div>`;
  $('#state').classList.add('err');
}
if (!token) fail('Lien incomplet', 'Ouvrez le lien complet qui vous a été transmis.');
else post('/api/password-reset/lookup', { token }).then(r => {
  if (!r.ok) return fail('Lien invalide', r.data.error || 'Ce lien est invalide, expiré ou déjà utilisé.');
  const d = r.data, w = d.workspace || {};
  $('#state').classList.add('hidden'); $('#formBox').classList.remove('hidden');
  $('#wsName').textContent = w.displayName || 'Espace';
  const m = $('#wsMono'); m.textContent = w.initials || 'DP'; if (w.palette) { m.style.background = w.palette.tenant; m.style.color = w.palette.tenantInk; }
  $('#rsMail').textContent = d.email;
  $('#expires').textContent = `Lien valable jusqu’au ${window.DPTime.formatLocal(d.expiresAt, w.fuseau)}.`;
  setTimeout(() => $('#pw').focus(), 30);
}).catch(() => fail('Service momentanément indisponible', 'Réessayez dans quelques instants. Aucune donnée n’a été modifiée.'));

$('#resetForm').addEventListener('submit', async e => {
  e.preventDefault();
  const err = $('#err'); err.classList.add('hidden');
  const show = m => { err.textContent = m; err.classList.remove('hidden'); };
  const pw = $('#pw').value, pw2 = $('#pw2').value;
  if (pw !== pw2) return show('Les deux mots de passe ne correspondent pas.');
  const b = $('#submitBtn'); b.disabled = true; b.textContent = 'Enregistrement…';
  const r = await post('/api/password-reset/complete', { token, password: pw }).catch(() => null);
  if (r && r.ok) { $('#formBox').innerHTML = '<h1>Mot de passe enregistré</h1><p class="lead">Vos sessions précédentes ont été fermées. Connectez-vous avec votre nouveau mot de passe.</p><a class="btn btn-primary login-submit" href="/login">Se connecter</a>'; return; }
  show((r && r.data && r.data.error) || 'L’enregistrement a échoué. Aucune modification n’a été faite ; réessayez.');
  b.disabled = false; b.textContent = 'Enregistrer le mot de passe';
});
