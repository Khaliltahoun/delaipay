'use strict';
// Acceptation d'invitation. Le jeton est lu dans le FRAGMENT d'URL (#t=…) : il n'est jamais envoyé
// au serveur dans une URL, puis retiré de la barre d'adresse.
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
(function theme() { let t = null; try { t = localStorage.getItem('dp-theme'); } catch (_) {} if (!t && matchMedia('(prefers-color-scheme: dark)').matches) t = 'dark'; document.documentElement.setAttribute('data-theme', t || 'light'); })();
const token = (new URLSearchParams(location.hash.slice(1))).get('t') || '';
try { history.replaceState(null, '', location.pathname); } catch (_) {}
// P3-13 : un second lien ouvert dans le même onglet ne change que le fragment — on relit le nouveau jeton.
window.addEventListener('hashchange', () => { if (/[#&]t=/.test(location.hash)) location.reload(); });
const post = (url, body) => fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  .then(async r => ({ ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) }));
function fail(title, msg) {
  $('#state').innerHTML = `<div class="ic"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 8v4m0 4h.01"/></svg></div><h4>${esc(title)}</h4><p>${esc(msg)}</p><div class="actions"><a class="btn btn-ghost" href="/login">Aller à la connexion</a></div>`;
  $('#state').classList.add('err');
}
if (!token) fail('Lien d’invitation incomplet', 'Ouvrez le lien complet reçu de l’administrateur de votre cabinet.');
else post('/api/invitations/lookup', { token }).then(r => {
  if (!r.ok) return fail('Invitation invalide', r.data.error || 'Cette invitation est invalide, expirée ou déjà utilisée. Demandez-en une nouvelle à votre administrateur.');
  const d = r.data, w = d.workspace || {};
  $('#state').classList.add('hidden'); $('#formBox').classList.remove('hidden');
  $('#wsName').textContent = w.displayName || 'Espace';
  const m = $('#wsMono');
  if (w.logoUrl) { m.innerHTML = ''; const img = new Image(); img.src = w.logoUrl; img.alt = ''; img.className = 'ws-logo-img'; m.appendChild(img); m.classList.add('has-logo'); }
  else { m.textContent = w.initials || 'DP'; if (w.palette) { m.style.background = w.palette.tenant; m.style.color = w.palette.tenantInk; } }
  $('#invMail').textContent = d.email; $('#invRole').textContent = d.roleLabel || d.role;
  $('#expires').textContent = `Invitation valable jusqu’au ${String(d.expiresAt || '').slice(0, 10).split('-').reverse().join('/')}.`;
  document.title = `Invitation — ${w.displayName || ''} · DelaiPay`;
  setTimeout(() => $('#nom').focus(), 30);
}).catch(() => fail('Service momentanément indisponible', 'Réessayez dans quelques instants. Aucune donnée n’a été modifiée.'));

$('#inviteForm').addEventListener('submit', async e => {
  e.preventDefault();
  const err = $('#err'); err.classList.add('hidden');
  const show = m => { err.textContent = m; err.classList.remove('hidden'); };
  const nom = $('#nom').value.trim(), pw = $('#pw').value, pw2 = $('#pw2').value;
  if (!nom) return show('Indiquez votre nom complet.');
  if (pw !== pw2) return show('Les deux mots de passe ne correspondent pas.');
  const b = $('#submitBtn'); b.disabled = true; b.textContent = 'Création de votre accès…';
  const r = await post('/api/invitations/accept', { token, nom, password: pw }).catch(() => null);
  if (r && r.ok) { b.textContent = 'Ouverture de l’espace…'; window.location.replace('/'); return; }
  show((r && r.data && r.data.error) || 'La création de l’accès a échoué. Aucun compte n’a été créé ; réessayez.');
  b.disabled = false; b.textContent = 'Créer mon accès';
});
