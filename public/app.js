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