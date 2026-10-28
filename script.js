/* =========================================================
   STORAGE & HELPERS
   ========================================================= */
const STORE_KEY = 'brewclub_v3';
const $  = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

function getUser() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || null; }
  catch { return null; }
}

function saveUser(user) {
  localStorage.setItem(STORE_KEY, JSON.stringify(user));
}

function removeUser() {
  localStorage.removeItem(STORE_KEY);
}

/* =========================================================
   QR GENERATOR
   ========================================================= */
function drawQR(canvas, seedStr) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const S = 25;
  const size = canvas.width;
  const cell = size / S;
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, size, size);

  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const rand = () => {
    h ^= h << 13; h >>>= 0; h ^= h >> 17; h ^= h << 5; h >>>= 0;
    return h / 4294967296;
  };

  const inFinder = (x, y) => (x < 8 && y < 8) || (x >= S - 8 && y < 8) || (x < 8 && y >= S - 8);

  ctx.fillStyle = '#1E1611';
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (inFinder(x, y)) continue;
      if (rand() > 0.52) ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }

  const finder = (px, py) => {
    ctx.fillStyle = '#1E1611'; ctx.fillRect(px * cell, py * cell, 7 * cell, 7 * cell);
    ctx.fillStyle = '#FFFFFF'; ctx.fillRect((px + 1) * cell, (py + 1) * cell, 5 * cell, 5 * cell);
    ctx.fillStyle = '#1E1611'; ctx.fillRect((px + 2) * cell, (py + 2) * cell, 3 * cell, 3 * cell);
  };
  finder(0, 0); finder(S - 7, 0); finder(0, S - 7);
}

/* =========================================================
   TOAST
   ========================================================= */
let toastTimer;
function toast(msg, type = '') {
  const el = $('#toast');
  if(!el) return;
  el.textContent = msg;
  el.className = 'show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 3000);
}

/* =========================================================
   REVEAL ANIMATION
   ========================================================= */
let io;
function observeReveal() {
  if (!('IntersectionObserver' in window)) {
    $$('.reveal').forEach(el => el.classList.add('in'));
    return;
  }
  if (!io) {
    io = new IntersectionObserver(entries => {
      entries.forEach(en => {
        if (en.isIntersecting) {
          en.target.classList.add('in');
          io.unobserve(en.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
  }
  $$('.reveal:not(.in)').forEach(el => io.observe(el));
}

/* =========================================================
   LOGIKA HALAMAN UTAMA (INDEX)
   ========================================================= */
function initIndexPage() {
  const authModal = $('#authModal');
  
  function openAuth(tab = 'login') {
    authModal.classList.add('open');
    document.body.style.overflow = 'hidden';
    switchTab(tab);
  }
  function closeAuth() {
    authModal.classList.remove('open');
    document.body.style.overflow = '';
    if($('#loginErr')) $('#loginErr').textContent = '';
  }
  function switchTab(name) {
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    $('#loginForm').classList.toggle('hidden', name !== 'login');
    $('#registerForm').classList.toggle('hidden', name !== 'register');
    if($('#loginErr')) $('#loginErr').textContent = '';
  }

  // Auth Events
  $('#btnLogin').addEventListener('click', () => openAuth('login'));
  $('#btnJoin').addEventListener('click', () => openAuth('register'));
  $('#heroJoin').addEventListener('click', () => openAuth('register'));
  $('#ctaJoin').addEventListener('click', () => openAuth('register'));
  $('#closeAuth').addEventListener('click', closeAuth);
  authModal.addEventListener('click', (e) => { if (e.target === authModal) closeAuth(); });
  $$('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  // Form Submit
  $('#loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const email = $('#loginEmail').value.trim().toLowerCase();
    const existingUser = getUser();
    if (!existingUser) {
      $('#loginErr').textContent = 'Belum ada akun. Silakan daftar dulu.';
      return;
    }
    if (email !== existingUser.email) {
      $('#loginErr').textContent = 'Email tidak cocok dengan akun yang terdaftar.';
      return;
    }
    closeAuth();
    renderUserState();
    toast('Berhasil masuk!', 'success');
    setTimeout(() => { window.location.href = 'pengguna.html'; }, 800);
  });

  $('#registerForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('#regName').value.trim();
    const email = $('#regEmail').value.trim().toLowerCase();
    const phone = $('#regPhone').value.trim();
    const newUser = { id: 'BC-' + Math.floor(1000 + Math.random() * 9000), name, email, phone, joined: Date.now() };
    saveUser(newUser);
    closeAuth();
    renderUserState();
    toast('Pendaftaran berhasil!', 'success');
    setTimeout(() => { window.location.href = 'pengguna.html'; }, 800);
  });

  // Mobile Menu
  const menuToggle = $('#menuToggle');
  const mobileMenu = $('#mobileMenu');
  if (menuToggle && mobileMenu) {
    menuToggle.addEventListener('click', () => {
      const isOpen = mobileMenu.classList.contains('open');
      mobileMenu.classList.toggle('open', !isOpen);
      menuToggle.textContent = !isOpen ? '✕' : '☰';
    });
    $('#mmLogin').addEventListener('click', () => { mobileMenu.classList.remove('open'); menuToggle.textContent='☰'; openAuth('login'); });
    $('#mmJoin').addEventListener('click', () => { mobileMenu.classList.remove('open'); menuToggle.textContent='☰'; openAuth('register'); });
  }

  // Promo Claim Buttons
  $$('.claim-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (getUser()) {
        toast('Mengalihkan ke kartu member...', 'success');
        setTimeout(() => { window.location.href = 'pengguna.html'; }, 500);
      } else {
        openAuth('login');
        toast('Masuk / daftar dulu untuk klaim promo.', 'error');
      }
    });
  });

  // Render Hero QR
  drawQR($('#heroQr'), 'BC-2481-andi@example.com');
  observeReveal();
}

/* =========================================================
   LOGIKA HALAMAN PENGGUNA (PENGGUNA.HTML)
   ========================================================= */
function initAccountPage() {
  const currentUser = getUser();
  
  // Proteksi Halaman: Jika belum login, tendang ke index
  if (!currentUser) {
    window.location.href = 'index.html';
    return;
  }

  // Isi Data Profil
  $('#profileName').textContent = currentUser.name;
  $('#profileAvatar').textContent = currentUser.name.charAt(0).toUpperCase();
  $('#cardName').textContent = currentUser.name;
  $('#cardId').textContent = 'ID · ' + currentUser.id;

  // Format Tanggal Bergabung
  const joinDate = new Date(currentUser.joined).toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
  $('#profileJoinDate').textContent = joinDate;

  // Render QR Code
  drawQR($('#qrCanvas'), currentUser.id + currentUser.email);

  // Tombol Logout
  $('#btnLogout').addEventListener('click', () => {
    removeUser();
    toast('Berhasil keluar...', 'success');
    setTimeout(() => { window.location.href = 'index.html'; }, 800);
  });
}

/* =========================================================
   GLOBAL STATE & INIT
   ========================================================= */
function renderUserState() {
  const user = getUser();
  document.body.classList.toggle('logged-in', !!user);
  
  if (user) {
    const navName = $('#navName');
    const navAvatar = $('#navAvatar');
    if (navName) navName.textContent = user.name.split(' ')[0];
    if (navAvatar) navAvatar.textContent = user.name.charAt(0).toUpperCase();
  }
}

// Cek Halaman Apa yang Sedang Dibuka
document.addEventListener('DOMContentLoaded', () => {
  renderUserState();
  
  if (document.body.classList.contains('page-account')) {
    initAccountPage();
  } else {
    initIndexPage();
  }
});