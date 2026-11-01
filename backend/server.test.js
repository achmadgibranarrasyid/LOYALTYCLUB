'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { after, test } = require('node:test');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'brewclub-node-test-'));
process.env.BREWCLUB_DATABASE = path.join(temporaryDirectory, 'customers.sqlite3');
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'BrewClub-test-password-2026';
process.env.RESEND_API_KEY = 'test-resend-key';
process.env.EMAIL_FROM = 'BrewClub <test@example.invalid>';
process.env.BASE_URL = 'https://brewclub.example.invalid';

const { createServer, initializeDatabase } = require('./server');
const server = createServer();
let origin;
let adminCookie;

after(async () => {
  if (server.listening) {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('database migration preserves existing customer and promo data', () => {
  const legacyPath = path.join(temporaryDirectory, 'legacy.sqlite3');
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec(`
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      phone TEXT NOT NULL,
      joined INTEGER NOT NULL
    );
    CREATE TABLE promos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      label TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      price_old TEXT NOT NULL DEFAULT '',
      price_new TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1
    );
    INSERT INTO customers (member_id, name, email, phone, joined)
      VALUES ('BC-LEGACY', 'Legacy Customer', 'legacy@example.invalid', '08123456789', 1);
    INSERT INTO promos (category, label, title, description)
      VALUES ('diskon', 'OLD', 'Legacy Promo', 'Preserve this promo.');
  `);
  legacy.close();

  initializeDatabase(legacyPath);
  const migrated = new DatabaseSync(legacyPath);
  const promoColumns = new Set(migrated.prepare('PRAGMA table_info(promos)').all().map(row => row.name));
  const customerColumns = new Set(migrated.prepare('PRAGMA table_info(customers)').all().map(row => row.name));
  assert(promoColumns.has('starts_on'));
  assert(promoColumns.has('ends_on'));
  assert(customerColumns.has('password_hash'));
  assert(customerColumns.has('consent_at'));
  assert(customerColumns.has('privacy_policy_version'));
  assert.equal(migrated.prepare('SELECT name FROM customers WHERE member_id = ?').get('BC-LEGACY').name, 'Legacy Customer');
  assert.equal(migrated.prepare('SELECT title FROM promos WHERE id = 1').get().title, 'Legacy Promo');
  assert.equal(migrated.prepare('SELECT COUNT(*) AS count FROM promos').get().count, 1);
  assert(migrated.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'promo_claims'").get());
  migrated.close();

  const backupDirectory = path.join(temporaryDirectory, 'backups');
  execFileSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'backup.js'),
    backupDirectory
  ], {
    env: { ...process.env, BREWCLUB_DATABASE: legacyPath },
    stdio: 'pipe'
  });
  const backupPath = path.join(backupDirectory, fs.readdirSync(backupDirectory)[0]);
  const backup = new DatabaseSync(backupPath, { readOnly: true });
  assert.equal(backup.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  assert.equal(backup.prepare('SELECT name FROM customers WHERE member_id = ?')
    .get('BC-LEGACY').name, 'Legacy Customer');
  backup.close();
});

async function request(pathname, options = {}, authenticated = false) {
  const headers = { ...(options.headers || {}) };
  if (options.method && options.method !== 'GET') headers.Origin = origin;
  if (authenticated && adminCookie) headers.Cookie = adminCookie;
  const response = await fetch(`${origin}${pathname}`, { ...options, headers });
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json')
    ? await response.json()
    : await response.text();
  return { response, body };
}

function jsonBody(payload) {
  return {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  };
}

function formatLocalDate(date) {
  return date.toLocaleDateString('sv-SE');
}

test('Node backend supports customer, promo, claim and admin workflows', async () => {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;

  const health = await request('/api/health');
  assert.equal(health.body.status, 'ok');
  const page = await request('/admin.html');
  assert.equal(page.response.status, 200);
  assert.match(page.response.headers.get('content-type'), /text\/html/);

  const logo = await request('/mont-logo.svg');
  assert.equal(logo.response.status, 200);
  assert.match(logo.response.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(logo.body, /#29491f/);
  const stylesheet = await request('/style.css');
  assert.equal(stylesheet.response.status, 200);
  assert.match(stylesheet.body, /--bg:#F2F2C0/);
  assert.match(stylesheet.body, /--accent:#F15A24/);

  const denied = await request('/api/admin/customers');
  assert.equal(denied.response.status, 401);

  const created = await request('/api/customers', {
    method: 'POST',
    ...jsonBody({
      name: 'Node Test Customer',
      email: 'node-test@example.invalid',
      phone: '08123456789',
      password: 'Customer-password-2026',
      consent: true
    })
  });
  assert.equal(created.response.status, 201);
  assert.match(created.body.id, /^BC-[A-F0-9]{16}$/);
  const registeredCustomerCookie = created.response.headers.get('set-cookie').split(';', 1)[0];
  assert.match(created.response.headers.get('set-cookie'), /HttpOnly/);

  const customerSession = await request('/api/customer/session', {
    headers: { Cookie: registeredCustomerCookie }
  });
  assert.equal(customerSession.body.authenticated, true);
  assert.equal(customerSession.body.customer.id, created.body.id);

  const secondServer = createServer();
  await new Promise((resolve, reject) => {
    secondServer.once('error', reject);
    secondServer.listen(0, '127.0.0.1', resolve);
  });
  try {
    const secondOrigin = `http://127.0.0.1:${secondServer.address().port}`;
    const persistedSessionResponse = await fetch(`${secondOrigin}/api/customer/session`, {
      headers: { Cookie: registeredCustomerCookie }
    });
    const persistedSession = await persistedSessionResponse.json();
    assert.equal(persistedSession.authenticated, true);
    assert.equal(persistedSession.customer.id, created.body.id);
  } finally {
    await new Promise((resolve, reject) => {
      secondServer.close(error => error ? reject(error) : resolve());
    });
  }

  const duplicate = await request('/api/customers', {
    method: 'POST',
    ...jsonBody({
      name: 'Duplicate',
      email: 'NODE-TEST@example.invalid',
      phone: '08123456789',
      password: 'Customer-password-2026',
      consent: true
    })
  });
  assert.equal(duplicate.response.status, 409);

  const missingConsent = await request('/api/customers', {
    method: 'POST',
    ...jsonBody({
      name: 'No Consent',
      email: 'no-consent@example.invalid',
      phone: '08123456789',
      password: 'Customer-password-2026',
      consent: false
    })
  });
  assert.equal(missingConsent.response.status, 400);

  const customerLogin = await request('/api/customer/login', {
    method: 'POST',
    ...jsonBody({ email: 'node-test@example.invalid', password: 'Customer-password-2026' })
  });
  assert.equal(customerLogin.response.status, 200);
  assert.equal(customerLogin.body.id, created.body.id);
  assert.equal(customerLogin.body.member_id, undefined);
  const customerLoginCookie = customerLogin.response.headers.get('set-cookie').split(';', 1)[0];

  const login = await request('/api/admin/login', {
    method: 'POST',
    ...jsonBody({ username: 'admin', password: process.env.ADMIN_PASSWORD })
  });
  assert.equal(login.response.status, 200);
  adminCookie = login.response.headers.get('set-cookie').split(';', 1)[0];
  assert.match(login.response.headers.get('set-cookie'), /HttpOnly/);

  const listedCustomers = await request('/api/admin/customers?q=Node%20Test', {}, true);
  assert.equal(listedCustomers.body.length, 1);
  assert.equal(listedCustomers.body[0].member_id, created.body.id);

  const csv = await request('/api/admin/customers.csv?q=Node%20Test', {}, true);
  assert.equal(csv.response.status, 200);
  assert.match(csv.response.headers.get('content-type'), /text\/csv/);
  assert.match(csv.body, /Node Test Customer/);

  const initialPromos = await request('/api/admin/promos', {}, true);
  assert.equal(initialPromos.body.length, 6);

  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const promo = await request('/api/admin/promos', {
    method: 'POST',
    ...jsonBody({
      category: 'diskon',
      label: 'TEST 10%',
      title: 'Node Test Promo',
      description: 'Promo untuk pengujian.',
      price_old: '',
      price_new: '',
      starts_on: formatLocalDate(today),
      ends_on: formatLocalDate(tomorrow)
    })
  }, true);
  assert.equal(promo.response.status, 201);
  assert.equal(promo.body.title, 'Node Test Promo');

  const publicPromos = await request('/api/promos');
  assert(publicPromos.body.some(item => item.id === promo.body.id));

  const invalidDate = await request('/api/admin/promos', {
    method: 'POST',
    ...jsonBody({
      category: 'diskon', label: 'X', title: 'Invalid', description: 'Invalid date',
      starts_on: '2026-W01-1'
    })
  }, true);
  assert.equal(invalidDate.response.status, 400);

  const claim = await request('/api/admin/claims', {
    method: 'POST',
    ...jsonBody({ member_id: created.body.id, promo_id: promo.body.id })
  }, true);
  assert.equal(claim.response.status, 201);
  assert.equal(claim.body.customer_name, 'Node Test Customer');

  const claims = await request('/api/admin/claims', {}, true);
  assert.equal(claims.body.length, 1);
  const analytics = await request('/api/admin/analytics', {}, true);
  assert.equal(analytics.body.total_claims, 1);
  assert.equal(analytics.body.daily.length, 7);
  assert.equal(analytics.body.top_promos[0].title, 'Node Test Promo');

  let resetToken;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    if (String(input) === 'https://api.resend.com/emails') {
      const email = JSON.parse(options.body);
      resetToken = new URL(email.text.match(/https:\/\/\S+/)[0]).searchParams.get('token');
      return new Response('{}', { status: 200 });
    }
    return originalFetch(input, options);
  };
  try {
    const resetRequested = await request('/api/customer/forgot-password', {
      method: 'POST',
      ...jsonBody({ email: 'node-test@example.invalid' })
    });
    assert.equal(resetRequested.response.status, 202);
    assert.equal(typeof resetToken, 'string');
    const reset = await request('/api/customer/reset-password', {
      method: 'POST',
      ...jsonBody({ token: resetToken, password: 'New-customer-password-2026' })
    });
    assert.equal(reset.response.status, 200);
    const replay = await request('/api/customer/reset-password', {
      method: 'POST',
      ...jsonBody({ token: resetToken, password: 'Another-customer-password-2026' })
    });
    assert.equal(replay.response.status, 400);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const revokedCustomerSession = await request('/api/customer/session', {
    headers: { Cookie: customerLoginCookie }
  });
  assert.equal(revokedCustomerSession.body.authenticated, false);
  const oldPasswordLogin = await request('/api/customer/login', {
    method: 'POST',
    ...jsonBody({ email: 'node-test@example.invalid', password: 'Customer-password-2026' })
  });
  assert.equal(oldPasswordLogin.response.status, 401);
  const newPasswordLogin = await request('/api/customer/login', {
    method: 'POST',
    ...jsonBody({ email: 'node-test@example.invalid', password: 'New-customer-password-2026' })
  });
  assert.equal(newPasswordLogin.response.status, 200);
  const newPasswordCookie = newPasswordLogin.response.headers.get('set-cookie').split(';', 1)[0];
  await request('/api/customer/logout', {
    method: 'POST',
    ...jsonBody({}),
    headers: { 'Content-Type': 'application/json', Cookie: newPasswordCookie }
  });
  const loggedOutCustomer = await request('/api/customer/session', {
    headers: { Cookie: newPasswordCookie }
  });
  assert.equal(loggedOutCustomer.body.authenticated, false);

  const inactive = await request(`/api/admin/promos/${promo.body.id}/active`, {
    method: 'PATCH',
    ...jsonBody({ active: false })
  }, true);
  assert.equal(inactive.response.status, 200);
  const promosAfterDeactivation = await request('/api/promos');
  assert(!promosAfterDeactivation.body.some(item => item.id === promo.body.id));

  const update = await request(`/api/admin/promos/${promo.body.id}`, {
    method: 'PUT',
    ...jsonBody({
      category: 'bundling',
      label: 'TEST UPDATE',
      title: 'Updated Node Test Promo',
      description: 'Promo yang diperbarui.',
      price_old: 'Rp 20.000',
      price_new: 'Rp 18.000',
      starts_on: '',
      ends_on: ''
    })
  }, true);
  assert.equal(update.response.status, 200);
  assert.equal(update.body.title, 'Updated Node Test Promo');

  const removed = await request(`/api/admin/promos/${promo.body.id}`, {
    method: 'DELETE'
  }, true);
  assert.equal(removed.response.status, 200);

  await request('/api/admin/logout', {
    method: 'POST',
    ...jsonBody({})
  }, true);
  adminCookie = null;
  const loggedOut = await request('/api/admin/customers');
  assert.equal(loggedOut.response.status, 401);
});
