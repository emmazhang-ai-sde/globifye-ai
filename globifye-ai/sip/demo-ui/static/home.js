/* Landing chooser: greet the user and offer the two views. */
const $ = (id) => document.getElementById(id);

fetch('/api/me').then(async (res) => {
  if (!res.ok) { location.href = '/login.html'; return; }
  const me = await res.json();
  $('user-name').textContent = me.name;
  $('company').textContent = me.company;
  $('home-company').textContent = me.company;
});

$('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login.html';
});
