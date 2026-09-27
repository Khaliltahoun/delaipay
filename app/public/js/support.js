'use strict';
// Échange du lien d'assistance (jeton dans le FRAGMENT d'URL, retiré aussitôt de la barre d'adresse).
(function () {
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const token = (new URLSearchParams(location.hash.slice(1))).get('t') || '';
  try { history.replaceState(null, '', location.pathname); } catch (_) {}
  const fail = msg => { $('#state').classList.add('err'); $('#state').innerHTML = `<div class="ic"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 8v4m0 4h.01"/></svg></div><h4>Accès impossible</h4><p>${esc(msg)}</p>`; };
  if (!token) return fail('Lien incomplet : ouvrez-le depuis la console DelaiPay.');
  fetch('/api/support/exchange', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })
    .then(async r => ({ ok: r.ok, d: await r.json().catch(() => ({})) }))
    .then(({ ok, d }) => { if (ok) window.location.replace('/'); else fail(d.error || 'Lien invalide ou expiré.'); })
    .catch(() => fail('Service momentanément indisponible.'));
})();
