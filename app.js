const STORE_KEY = 'brewclub_v2';

// Utility
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

// Auth Logic
function getUser() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || null; }
  catch { return null; }
}

function saveUser(user) {
  localStorage.setItem(STORE_KEY, JSON.stringify(user));
}

async function logoutUser() {
  try {
    await logoutCustomer();
  } catch (error) {
    toast(error.message, 'error');
    return;
  }
  localStorage.removeItem(STORE_KEY);
  window.location.href = 'index.html';
}

// Navbar State updater (dipanggil di setiap halaman)
function updateNav() {
  const user = getUser();
  document.body.classList.toggle('logged-in', !!user);
  
  if (user) {
    const navName = $('#navName');
    const navAvatar = $('#navAvatar');
    if (navName) navName.textContent = user.name.split(' ')[0];
    if (navAvatar) navAvatar.textContent = user.name.charAt(0).toUpperCase();
  }

  // Setup Mobile Menu
  const menuToggle = $('#menuToggle');
  const mobileMenu = $('#mobileMenu');
  if(menuToggle && mobileMenu) {
    menuToggle.addEventListener('click', () => {
      const isOpen = mobileMenu.classList.contains('open');
      mobileMenu.classList.toggle('open', !isOpen);
      menuToggle.textContent = !isOpen ? '✕' : '☰';
    });
  }

  // Logout buttons
  const mmLogout = $('#mmLogout');
  if (mmLogout) mmLogout.addEventListener('click', logoutUser);
}

// QR Code Generator
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

  ctx.fillStyle = '#29491F';
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (inFinder(x, y)) continue;
      if (rand() > 0.52) ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }

  const finder = (px, py) => {
    ctx.fillStyle = '#29491F'; ctx.fillRect(px * cell, py * cell, 7 * cell, 7 * cell);
    ctx.fillStyle = '#FFFFFF'; ctx.fillRect((px + 1) * cell, (py + 1) * cell, 5 * cell, 5 * cell);
    ctx.fillStyle = '#29491F'; ctx.fillRect((px + 2) * cell, (py + 2) * cell, 3 * cell, 3 * cell);
  };
  finder(0, 0); finder(S - 7, 0); finder(0, S - 7);
}

// Toast Notification
let toastTimer;
function toast(msg, type = '') {
  const el = $('#toast');
  if(!el) return;
  el.textContent = msg;
  el.className = 'show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 3000);
}

// Initialize Nav on load
document.addEventListener('DOMContentLoaded', updateNav);