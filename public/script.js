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

function bindPromoClaims() {
  $$('.claim-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (getUser()) {
        toast('Mengalihkan ke kartu member...', 'success');
        setTimeout(() => { window.location.href = 'pengguna.html'; }, 500);
      } else {
        openPromoLogin();
      }
    });
  });
}

function openPromoLogin() {
  const loginButton = $('#btnLogin');
  if (loginButton) loginButton.click();
  toast('Masuk / daftar dulu untuk klaim promo.', 'error');
}

function buildPromoCard(promo) {
  const card = document.createElement('div');
  card.className = 'promo-card reveal in';

  const badge = document.createElement('div');
  badge.className = `badge${promo.category === 'bundling' ? ' gold' : ''}`;
  badge.textContent = promo.label;
  const title = document.createElement('h3');
  title.textContent = promo.title;
  const description = document.createElement('p');
  description.textContent = promo.description;
  card.append(badge, title, description);

  if (promo.starts_on || promo.ends_on) {
    const validity = document.createElement('small');
    validity.className = 'promo-validity';
    const formatDate = value => new Date(`${value}T12:00:00`).toLocaleDateString('id-ID', {
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    });
    validity.textContent = `Berlaku ${promo.starts_on ? `mulai ${formatDate(promo.starts_on)}` : ''}${promo.starts_on && promo.ends_on ? ' sampai ' : ''}${promo.ends_on ? `hingga ${formatDate(promo.ends_on)}` : ''}`;
    card.append(validity);
  }

  if (promo.price_old || promo.price_new) {
    const prices = document.createElement('div');
    prices.className = 'price-row';
    if (promo.price_old) {
      const oldPrice = document.createElement('span');
      oldPrice.className = 'price-old';
      oldPrice.textContent = promo.price_old;
      prices.append(oldPrice);
    }
    if (promo.price_new) {
      const newPrice = document.createElement('span');
      newPrice.className = 'price-new';
      newPrice.textContent = promo.price_new;
      prices.append(newPrice);
    }
    card.append(prices);
  }

  const button = document.createElement('button');
  button.className = 'btn btn-accent claim-btn';
  button.textContent = promo.category === 'bundling' ? 'Pesan Bundling' : 'Klaim Diskon';
  card.append(button);
  return card;
}

async function loadPublicPromos() {
  const groups = {
    diskon: $('#diskon .promo-grid'),
    bundling: $('#bundling .promo-grid')
  };
  try {
    const response = await fetch('/api/promos');
    const promos = await response.json();
    if (!response.ok) throw new Error(promos.error || 'Promo gagal dimuat.');
    Object.values(groups).forEach(group => group.replaceChildren());
    promos.forEach(promo => {
      if (groups[promo.category]) groups[promo.category].append(buildPromoCard(promo));
    });
    const bundlingCount = promos.filter(promo => promo.category === 'bundling').length;
    $('#bundlingPromoCount').textContent = `${bundlingCount} Paket`;
    bindPromoClaims();
  } catch (error) {
    Object.values(groups).forEach(group => {
      group.replaceChildren();
      const message = document.createElement('p');
      message.className = 'promo-load-error';
      message.textContent = error.message;
      group.append(message);
    });
  }
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
    if ($('#forgotPasswordForm')) $('#forgotPasswordForm').classList.add('hidden');
    if ($('.modal .tabs')) $('.modal .tabs').classList.remove('hidden');
    if($('#loginErr')) $('#loginErr').textContent = '';
    if($('#registerErr')) $('#registerErr').textContent = '';
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
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#loginEmail').value.trim().toLowerCase();
    try {
      await loginCustomer(email, $('#loginPassword').value);
      closeAuth();
      renderUserState();
      toast('Berhasil masuk!', 'success');
      setTimeout(() => { window.location.href = 'pengguna.html'; }, 800);
    } catch (error) {
      $('#loginErr').textContent = error.message;
    }
  });

  $('#registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#regName').value.trim();
    const email = $('#regEmail').value.trim().toLowerCase();
    const phone = $('#regPhone').value.trim();
    const password = $('#regPassword').value;
    const error = $('#registerErr');
    const submitButton = $('#registerForm button[type="submit"]');
    submitButton.disabled = true;
    error.textContent = '';
    try {
      await createCustomer(name, email, phone, password, $('#regConsent').checked);
      closeAuth();
      renderUserState();
      toast('Pendaftaran berhasil!', 'success');
      setTimeout(() => { window.location.href = 'pengguna.html'; }, 800);
    } catch (err) {
      error.textContent = err.message;
    } finally {
      submitButton.disabled = false;
    }
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

  observeReveal();
  loadPublicPromos();
}

/* =========================================================
   LOGIKA HALAMAN PENGGUNA (PENGGUNA.HTML)
   ========================================================= */
async function initAccountPage() {
  let currentUser;
  try {
    const session = await getCustomerSession();
    if (!session.authenticated || !session.customer) {
      removeUser();
      window.location.href = 'login.html';
      return;
    }
    currentUser = session.customer;
    saveUser(currentUser);
    renderUserState();
  } catch (error) {
    console.error('Sesi pelanggan gagal diverifikasi:', error);
    window.location.href = 'login.html';
    return;
  }
  
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

  $('#qrCodeImage').src = '/api/customer/qr';

  // Tombol Logout
  $('#btnLogout').addEventListener('click', async () => {
    try {
      await logoutCustomer();
    } catch (error) {
      toast(error.message, 'error');
      return;
    }
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