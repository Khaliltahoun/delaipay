const form = document.getElementById('loginForm');
const errBox = document.getElementById('err');
const btn = document.getElementById('submitBtn');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errBox.classList.add('hidden');
  btn.disabled = true; btn.textContent = 'Connexion…';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        email: document.getElementById('email').value.trim(),
        password: document.getElementById('password').value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Échec de la connexion.');
    window.location.replace('/');
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.remove('hidden');
    btn.disabled = false; btn.textContent = 'Se connecter';
  }
});
