'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { promisify } = require('node:util');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATABASE_PATH = path.resolve(
  process.env.BREWCLUB_DATABASE || path.join(os.homedir(), '.brewclub', 'customers.sqlite3')
);
const MAX_REQUEST_SIZE = 16_384;
const SESSION_COOKIES = { admin: 'brewclub_admin', customer: 'brewclub_customer' };
const SESSION_DURATION = 8 * 60 * 60;
const RESET_TOKEN_DURATION = 60 * 60 * 1000;
const PASSWORD_MIN_LENGTH = 12;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_PATTERN = /^\+?[\d\s()-]{8,30}$/;
const loginAttempts = new Map();
const scrypt = promisify(crypto.scrypt);
const INITIAL_PROMOS = [
  ['diskon', 'DISKON 20%', 'Diskon 20% Semua Pastry', 'Berlaku untuk croissant, danish, cinnamon roll, dan pastry lainnya.', '', ''],
  ['diskon', 'DISKON 15%', 'Diskon 15% Signature Latte', 'Nikmati potongan harga untuk minuman latte andalan kami.', '', ''],
  ['diskon', 'BUY 1 GET 1', 'Diskon 50% Kopi Kedua', 'Khusus pemesanan di hari Jumat. Berlaku untuk semua varian kopi.', '', ''],
  ['bundling', 'HEMAT 30%', 'Paket Ngopi Pagi', '1 Americano dingin/panas + 1 Butter Croissant.', 'Rp 50.000', 'Rp 35.000'],
  ['bundling', 'HEMAT 40%', 'Paket Berdua', '2 Signature Latte + 2 Potong Cake pilihan.', 'Rp 140.000', 'Rp 99.000'],
  ['bundling', 'HEMAT 25%', 'Paket WFH', '1 Kopi Susu + 1 Snack Box + 1 Air Mineral.', 'Rp 65.000', 'Rp 45.000']
];

function openDatabase(databasePath = DATABASE_PATH) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  return new DatabaseSync(databasePath);
}

function initializeDatabase(databasePath = DATABASE_PATH) {
  const database = openDatabase(databasePath);
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        email TEXT NOT NULL COLLATE NOCASE UNIQUE,
        phone TEXT NOT NULL,
        joined INTEGER NOT NULL,
        password_hash TEXT,
        consent_at INTEGER,
        privacy_policy_version TEXT
      );
      CREATE TABLE IF NOT EXISTS promos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL CHECK (category IN ('diskon', 'bundling')),
        label TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        price_old TEXT NOT NULL DEFAULT '',
        price_new TEXT NOT NULL DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS promo_claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        promo_id INTEGER,
        promo_title TEXT NOT NULL,
        member_id TEXT NOT NULL,
        customer_name TEXT NOT NULL,
        claimed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY,
        role TEXT NOT NULL CHECK (role IN ('admin', 'customer')),
        username TEXT,
        member_id TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions (expires_at);
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        token_hash TEXT PRIMARY KEY,
        customer_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      );
    `);

    const customerColumns = new Set(
      database.prepare('PRAGMA table_info(customers)').all().map(column => column.name)
    );
    if (!customerColumns.has('password_hash')) {
      database.exec('ALTER TABLE customers ADD COLUMN password_hash TEXT');
    }
    if (!customerColumns.has('consent_at')) database.exec('ALTER TABLE customers ADD COLUMN consent_at INTEGER');
    if (!customerColumns.has('privacy_policy_version')) {
      database.exec('ALTER TABLE customers ADD COLUMN privacy_policy_version TEXT');
    }

    const promoColumns = new Set(
      database.prepare('PRAGMA table_info(promos)').all().map(column => column.name)
    );
    if (!promoColumns.has('starts_on')) database.exec('ALTER TABLE promos ADD COLUMN starts_on TEXT');
    if (!promoColumns.has('ends_on')) database.exec('ALTER TABLE promos ADD COLUMN ends_on TEXT');

    const seeded = database.prepare(
      "SELECT 1 FROM app_settings WHERE key = 'initial_promos_seeded'"
    ).get();
    const promoCount = database.prepare('SELECT COUNT(*) AS count FROM promos').get().count;
    if (!seeded && promoCount === 0) {
      const insert = database.prepare(`
        INSERT INTO promos (category, label, title, description, price_old, price_new)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const promo of INITIAL_PROMOS) insert.run(...promo);
    }
    database.prepare(
      "INSERT OR IGNORE INTO app_settings (key, value) VALUES ('initial_promos_seeded', '1')"
    ).run();
    database.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(Date.now());
    database.prepare('DELETE FROM password_reset_tokens WHERE expires_at <= ? OR used_at IS NOT NULL')
      .run(Date.now());
  } finally {
    database.close();
  }
}

function sendJson(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    ...headers
  });
  response.end(body);
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

function hasValidOrigin(request) {
  const origin = request.headers.origin;
  if (typeof origin !== 'string') return false;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      continue;
    }
  }
  return cookies;
}

function sessionTokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function getSession(database, request, role) {
  const token = parseCookies(request.headers.cookie)[SESSION_COOKIES[role]];
  if (!token) return null;
  const session = database.prepare(`
    SELECT role, username, member_id, expires_at
    FROM auth_sessions WHERE token_hash = ? AND role = ? AND expires_at > ?
  `).get(sessionTokenHash(token), role, Date.now());
  return session || null;
}

function requireSession(database, request, response, role, mutation = false) {
  if (mutation && !hasValidOrigin(request)) {
    sendError(response, 403, 'Asal request tidak diizinkan.');
    return null;
  }
  const session = getSession(database, request, role);
  if (!session) {
    sendError(response, 401, `Sesi ${role === 'admin' ? 'admin' : 'pelanggan'} berakhir. Silakan masuk kembali.`);
    return null;
  }
  return session;
}

function createSession(database, role, username = null, memberId = null) {
  database.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(Date.now());
  const token = crypto.randomBytes(32).toString('base64url');
  const createdAt = Date.now();
  database.prepare(`
    INSERT INTO auth_sessions (token_hash, role, username, member_id, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    sessionTokenHash(token),
    role,
    username,
    memberId,
    createdAt,
    createdAt + SESSION_DURATION * 1000
  );
  return token;
}

function sessionCookie(token, role, request, maxAge = SESSION_DURATION) {
  const secure = process.env.NODE_ENV === 'production' ||
    (process.env.TRUST_PROXY === '1' && request.headers['x-forwarded-proto'] === 'https');
  return [
    `${SESSION_COOKIES[role]}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
    ...(secure ? ['Secure'] : [])
  ].join('; ');
}

function getClientAddress(request) {
  if (process.env.TRUST_PROXY === '1') {
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  }
  return request.socket.remoteAddress || 'unknown';
}

function rateLimitKey(request, key) {
  const client = getClientAddress(request);
  return `${key}:${client}`;
}

function isRateLimited(request, key, limit, windowMs) {
  const mapKey = rateLimitKey(request, key);
  const now = Date.now();
  let attempt = loginAttempts.get(mapKey);
  if (!attempt || now - attempt.started >= windowMs) {
    attempt = { started: now, count: 0 };
    loginAttempts.set(mapKey, attempt);
  }
  return attempt.count >= limit;
}

function recordRateLimitAttempt(request, key, windowMs) {
  const mapKey = rateLimitKey(request, key);
  const now = Date.now();
  let attempt = loginAttempts.get(mapKey);
  if (!attempt || now - attempt.started >= windowMs) {
    attempt = { started: now, count: 0 };
    loginAttempts.set(mapKey, attempt);
  }
  attempt.count += 1;
  if (loginAttempts.size > 10_000) {
    for (const [entryKey, value] of loginAttempts) {
      if (now - value.started >= 60 * 60 * 1000) loginAttempts.delete(entryKey);
    }
  }
}

function clearRateLimit(request, key) {
  loginAttempts.delete(rateLimitKey(request, key));
}

function hashResetToken(token) {
  return sessionTokenHash(token);
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$32768$${salt.toString('hex')}$${derived.toString('hex')}`;
}

async function verifyPassword(password, encodedHash) {
  const [, cost, saltHex, hashHex] = encodedHash.split('$');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length, {
    N: Number(cost),
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024
  });
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function validatePassword(password) {
  return typeof password === 'string' &&
    password.length >= PASSWORD_MIN_LENGTH &&
    password.length <= 128 &&
    !/[\u0000-\u001f\u007f]/.test(password);
}

function getCustomerFromSession(database, session) {
  return database.prepare(`
    SELECT member_id AS id, name, email, phone, joined
    FROM customers WHERE member_id = ?
  `).get(session.member_id);
}

async function sendPasswordResetEmail(email, token) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  const baseUrl = process.env.BASE_URL;
  if (!apiKey || !from || !baseUrl) return false;
  const resetUrl = new URL('/reset-password.html', baseUrl);
  resetUrl.searchParams.set('token', token);
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject: 'Atur ulang kata sandi BrewClub',
      text: `Gunakan tautan berikut untuk mengatur ulang kata sandi BrewClub. Tautan berlaku 1 jam dan hanya dapat digunakan sekali:\n\n${resetUrl}\n\nJika Anda tidak meminta pengaturan ulang, abaikan email ini.`
    }),
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    const errorDetail = await response.text();
    throw new Error(`Layanan email menolak reset kata sandi (${response.status}): ${errorDetail}`);
  }
}

async function readJson(request, response) {
  if (request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    sendError(response, 415, 'Content-Type harus application/json.');
    return null;
  }
  const contentLength = Number(request.headers['content-length'] || 0);
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0 || contentLength > MAX_REQUEST_SIZE) {
    sendError(response, 413, 'Ukuran data tidak valid atau terlalu besar.');
    return null;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_SIZE) {
      sendError(response, 413, 'Ukuran data tidak valid atau terlalu besar.');
      return null;
    }
    chunks.push(chunk);
  }
  try {
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!payload || Array.isArray(payload) || typeof payload !== 'object') {
      sendError(response, 400, 'Data harus berupa objek.');
      return null;
    }
    return payload;
  } catch {
    sendError(response, 400, 'Format JSON tidak valid.');
    return null;
  }
}

function getSearchQuery(url) {
  return (url.searchParams.get('q') || '').trim().slice(0, 100);
}

function escapeLike(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function customerQuery(search = '') {
  let sql = 'SELECT member_id, name, email, phone, joined FROM customers';
  let parameters = [];
  if (search) {
    sql += String.raw` WHERE member_id LIKE ? ESCAPE '\'
      OR name LIKE ? ESCAPE '\'
      OR email LIKE ? ESCAPE '\'
      OR phone LIKE ? ESCAPE '\'`;
    const pattern = `%${escapeLike(search)}%`;
    parameters = [pattern, pattern, pattern, pattern];
  }
  sql += ' ORDER BY joined DESC';
  return { sql, parameters };
}

function safeCsvValue(value) {
  const text = String(value ?? '');
  return /^[\s]*[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

function sendCsv(response, customers) {
  const quote = value => `"${safeCsvValue(value).replaceAll('"', '""')}"`;
  const lines = [
    ['ID Member', 'Nama', 'Email', 'WhatsApp', 'Bergabung'].map(quote).join(','),
    ...customers.map(customer => [
      customer.member_id,
      customer.name,
      customer.email,
      customer.phone,
      new Date(customer.joined).toLocaleDateString('sv-SE')
    ].map(quote).join(','))
  ];
  const body = Buffer.from(`\uFEFF${lines.join('\r\n')}`, 'utf8');
  response.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="pelanggan-brewclub.csv"',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  response.end(body);
}

function listPromos(database, activeOnly) {
  if (!activeOnly) return database.prepare('SELECT * FROM promos ORDER BY category, id').all();
  const today = new Date().toLocaleDateString('sv-SE');
  return database.prepare(`
    SELECT * FROM promos
    WHERE active = 1
      AND (starts_on IS NULL OR starts_on = '' OR starts_on <= ?)
      AND (ends_on IS NULL OR ends_on = '' OR ends_on >= ?)
    ORDER BY category, id
  `).all(today, today);
}

function promoDate(value) {
  if (typeof value !== 'string' || !value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? false : value;
}

function savePromo(database, payload, promoId = null) {
  const { category, label, title, description } = payload;
  const priceOld = payload.price_old ?? '';
  const priceNew = payload.price_new ?? '';
  const rawStarts = payload.starts_on ?? '';
  const rawEnds = payload.ends_on ?? '';
  if (!['diskon', 'bundling'].includes(category)) {
    return { status: 400, error: 'Kategori promo tidak valid.' };
  }
  if (![label, title, description, priceOld, priceNew, rawStarts, rawEnds].every(
    value => typeof value === 'string'
  )) {
    return { status: 400, error: 'Data promo tidak valid.' };
  }
  const values = [label.trim(), title.trim(), description.trim(), priceOld.trim(), priceNew.trim()];
  if (!values[0] || values[0].length > 40 || !values[1] || values[1].length > 120 ||
      !values[2] || values[2].length > 500) {
    return { status: 400, error: 'Label, judul, atau deskripsi promo tidak valid.' };
  }
  if (values[3].length > 40 || values[4].length > 40) {
    return { status: 400, error: 'Harga maksimal 40 karakter.' };
  }
  const startsOn = rawStarts.trim();
  const endsOn = rawEnds.trim();
  const start = startsOn ? promoDate(startsOn) : null;
  const end = endsOn ? promoDate(endsOn) : null;
  if (start === false || end === false) return { status: 400, error: 'Tanggal promo harus valid.' };
  if (start && end && start > end) {
    return { status: 400, error: 'Tanggal berakhir tidak boleh sebelum tanggal mulai.' };
  }

  if (promoId === null) {
    const result = database.prepare(`
      INSERT INTO promos (category, label, title, description, price_old, price_new, active, starts_on, ends_on)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(category, ...values, start, end);
    promoId = Number(result.lastInsertRowid);
  } else {
    const result = database.prepare(`
      UPDATE promos SET category = ?, label = ?, title = ?, description = ?,
        price_old = ?, price_new = ?, starts_on = ?, ends_on = ? WHERE id = ?
    `).run(category, ...values, start, end, promoId);
    if (Number(result.changes) === 0) return { status: 404, error: 'Promo tidak ditemukan.' };
  }
  return { status: promoId && payload._method === 'POST' ? 201 : 200, promo: database.prepare(
    'SELECT * FROM promos WHERE id = ?'
  ).get(promoId) };
}

function getAnalytics(database) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - 6);
  const startTimestamp = start.getTime();
  const total = database.prepare('SELECT COUNT(*) AS count FROM promo_claims').get().count;
  const lastWeek = database.prepare(
    'SELECT COUNT(*) AS count FROM promo_claims WHERE claimed_at >= ?'
  ).get(startTimestamp).count;
  const dailyRows = database.prepare(`
    SELECT date(claimed_at / 1000, 'unixepoch', 'localtime') AS day, COUNT(*) AS count
    FROM promo_claims WHERE claimed_at >= ? GROUP BY day
  `).all(startTimestamp);
  const countsByDay = new Map(dailyRows.map(row => [row.day, row.count]));
  const daily = Array.from({ length: 7 }, (_, offset) => {
    const day = new Date(start);
    day.setDate(day.getDate() + offset);
    const isoDate = day.toLocaleDateString('sv-SE');
    return { date: isoDate, count: countsByDay.get(isoDate) || 0 };
  });
  const topPromos = database.prepare(`
    SELECT promo_title AS title, COUNT(*) AS count FROM promo_claims
    GROUP BY promo_title ORDER BY count DESC, title LIMIT 5
  `).all();
  return { total_claims: total, last_7_days: lastWeek, daily, top_promos: topPromos };
}

function asyncRoute(handler) {
  return async (request, response) => {
    try {
      await handler(request, response);
    } catch (error) {
      console.error('Kesalahan backend:', error);
      if (!response.headersSent) sendError(response, 500, 'Permintaan gagal diproses.');
      else response.destroy(error);
    }
  };
}

function createServer() {
  initializeDatabase();
  return http.createServer(asyncRoute(async (request, response) => {
    let url;
    try {
      url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    } catch {
      sendError(response, 400, 'Alamat request tidak valid.');
      return;
    }
    const pathname = url.pathname;
    const method = request.method;

    if (method === 'GET' && pathname === '/api/health') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }
    if (!pathname.startsWith('/api/')) {
      if (method === 'GET' || method === 'HEAD') serveStatic(request, response, url);
      else sendError(response, 405, 'Metode request tidak diizinkan.');
      return;
    }

    const database = openDatabase();
    try {
      if (method === 'GET' && pathname === '/api/promos') {
        sendJson(response, 200, listPromos(database, true));
      } else if (method === 'GET' && pathname === '/api/admin/session') {
        const session = getSession(database, request, 'admin');
        sendJson(response, 200, {
          authenticated: Boolean(session),
          username: session?.username || null
        });
      } else if (method === 'GET' && pathname === '/api/customer/session') {
        const session = getSession(database, request, 'customer');
        sendJson(response, 200, {
          authenticated: Boolean(session),
          customer: session ? getCustomerFromSession(database, session) || null : null
        });
      } else if (method === 'POST' && pathname === '/api/admin/login') {
        if (!hasValidOrigin(request)) {
          sendError(response, 403, 'Asal request tidak diizinkan.');
          return;
        }
        const payload = await readJson(request, response);
        if (!payload) return;
        const username = process.env.ADMIN_USERNAME || 'admin';
        const password = process.env.ADMIN_PASSWORD || '';
        if (password.length < 12) {
          sendError(response, 503, 'Atur ADMIN_PASSWORD minimal 12 karakter sebelum login admin.');
          return;
        }
        if (isRateLimited(request, 'admin-login', 5, 300_000)) {
          sendError(response, 429, 'Terlalu banyak percobaan. Coba lagi dalam 5 menit.');
          return;
        }
        if (typeof payload.username !== 'string' || typeof payload.password !== 'string') {
          sendError(response, 400, 'Username dan kata sandi wajib diisi.');
          return;
        }
        const validUsername = payload.username.length === username.length &&
          crypto.timingSafeEqual(
            crypto.createHash('sha256').update(payload.username).digest(),
            crypto.createHash('sha256').update(username).digest()
          );
        const passwordBuffer = Buffer.from(password);
        const suppliedBuffer = Buffer.from(payload.password);
        const validPassword = suppliedBuffer.length === passwordBuffer.length &&
          crypto.timingSafeEqual(suppliedBuffer, passwordBuffer);
        if (!validUsername || !validPassword) {
          recordRateLimitAttempt(request, 'admin-login', 300_000);
          sendError(response, 401, 'Username atau kata sandi salah.');
          return;
        }
        clearRateLimit(request, 'admin-login');
        const token = createSession(database, 'admin', username);
        sendJson(response, 200, { authenticated: true, username }, {
          'Set-Cookie': sessionCookie(token, 'admin', request)
        });
      } else if (
        method === 'POST' &&
        (pathname === '/api/admin/logout' || pathname === '/api/customer/logout')
      ) {
        const role = pathname.includes('/admin/') ? 'admin' : 'customer';
        if (!hasValidOrigin(request)) {
          sendError(response, 403, 'Asal request tidak diizinkan.');
          return;
        }
        const cookies = parseCookies(request.headers.cookie);
        const token = cookies[SESSION_COOKIES[role]];
        if (token) {
          database.prepare('DELETE FROM auth_sessions WHERE token_hash = ? AND role = ?')
            .run(sessionTokenHash(token), role);
        }
        sendJson(response, 200, { ok: true }, {
          'Set-Cookie': sessionCookie('', role, request, 0)
        });
      } else if (method === 'POST' && pathname === '/api/customers') {
        if (!hasValidOrigin(request)) {
          sendError(response, 403, 'Asal request tidak diizinkan.');
          return;
        }
        if (isRateLimited(request, 'customer-register', 10, 60 * 60 * 1000)) {
          sendError(response, 429, 'Terlalu banyak percobaan pendaftaran. Coba lagi nanti.');
          return;
        }
        recordRateLimitAttempt(request, 'customer-register', 60 * 60 * 1000);
        const payload = await readJson(request, response);
        if (!payload) return;
        const { name, email, phone, password, consent } = payload;
        if (![name, email, phone].every(value => typeof value === 'string')) {
          sendError(response, 400, 'Nama, email, dan nomor WhatsApp wajib diisi.');
          return;
        }
        if (!validatePassword(password)) {
          sendError(response, 400, `Kata sandi harus ${PASSWORD_MIN_LENGTH}–128 karakter.`);
          return;
        }
        if (consent !== true) {
          sendError(response, 400, 'Persetujuan Kebijakan Privasi wajib diberikan.');
          return;
        }
        const cleanName = name.trim();
        const cleanEmail = email.trim().toLowerCase();
        const cleanPhone = phone.trim();
        if (!cleanName || cleanName.length > 100) {
          sendError(response, 400, 'Nama wajib diisi dan maksimal 100 karakter.');
          return;
        }
        if (cleanEmail.length > 254 || !EMAIL_PATTERN.test(cleanEmail)) {
          sendError(response, 400, 'Format email tidak valid.');
          return;
        }
        if (!PHONE_PATTERN.test(cleanPhone)) {
          sendError(response, 400, 'Format nomor WhatsApp tidak valid.');
          return;
        }
        const joined = Date.now();
        const memberId = `BC-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
        const passwordHash = await hashPassword(password);
        try {
          database.prepare(`
            INSERT INTO customers (
              member_id, name, email, phone, joined, password_hash, consent_at, privacy_policy_version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(memberId, cleanName, cleanEmail, cleanPhone, joined, passwordHash, joined, '2026-11-01');
        } catch (error) {
          if (error.errcode === 2067) {
            sendError(response, 409, 'Email ini sudah terdaftar.');
            return;
          }
          throw error;
        }
        const customer = { id: memberId, name: cleanName, email: cleanEmail, phone: cleanPhone, joined };
        const token = createSession(database, 'customer', null, memberId);
        sendJson(response, 201, customer, {
          'Set-Cookie': sessionCookie(token, 'customer', request)
        });
      } else if (method === 'POST' && pathname === '/api/customer/login') {
        if (!hasValidOrigin(request)) {
          sendError(response, 403, 'Asal request tidak diizinkan.');
          return;
        }
        if (isRateLimited(request, 'customer-login', 10, 15 * 60 * 1000)) {
          sendError(response, 429, 'Terlalu banyak percobaan masuk. Coba lagi dalam 15 menit.');
          return;
        }
        const payload = await readJson(request, response);
        if (!payload) return;
        if (typeof payload.email !== 'string' || typeof payload.password !== 'string') {
          sendError(response, 400, 'Email dan kata sandi wajib diisi.');
          return;
        }
        const email = payload.email.trim().toLowerCase();
        const customer = database.prepare(`
          SELECT member_id AS id, name, email, phone, joined, password_hash
          FROM customers WHERE email = ?
        `).get(email);
        const passwordValid = validatePassword(payload.password);
        let matches = false;
        if (customer?.password_hash && passwordValid) {
          matches = await verifyPassword(payload.password, customer.password_hash);
        } else {
          await hashPassword(passwordValid ? payload.password : crypto.randomBytes(24).toString('hex'));
        }
        if (!customer || !customer.password_hash || !matches) {
          recordRateLimitAttempt(request, 'customer-login', 15 * 60 * 1000);
          sendError(response, 401, 'Email atau kata sandi salah. Jika memiliki akun lama, gunakan fitur Lupa kata sandi.');
          return;
        }
        clearRateLimit(request, 'customer-login');
        const token = createSession(database, 'customer', null, customer.id);
        const { password_hash: _passwordHash, ...publicCustomer } = customer;
        sendJson(response, 200, publicCustomer, {
          'Set-Cookie': sessionCookie(token, 'customer', request)
        });
      } else if (method === 'POST' && pathname === '/api/customer/forgot-password') {
        if (!hasValidOrigin(request)) {
          sendError(response, 403, 'Asal request tidak diizinkan.');
          return;
        }
        if (isRateLimited(request, 'customer-reset', 5, 60 * 60 * 1000)) {
          sendError(response, 429, 'Terlalu banyak permintaan. Coba lagi nanti.');
          return;
        }
        recordRateLimitAttempt(request, 'customer-reset', 60 * 60 * 1000);
        if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM || !process.env.BASE_URL) {
          sendError(response, 503, 'Layanan pemulihan kata sandi belum dikonfigurasi.');
          return;
        }
        const payload = await readJson(request, response);
        if (!payload) return;
        if (typeof payload.email !== 'string' || !EMAIL_PATTERN.test(payload.email.trim())) {
          sendError(response, 400, 'Format email tidak valid.');
          return;
        }
        const customer = database.prepare('SELECT id, email FROM customers WHERE email = ?')
          .get(payload.email.trim().toLowerCase());
        if (customer) {
          database.prepare('DELETE FROM password_reset_tokens WHERE expires_at <= ? OR used_at IS NOT NULL')
            .run(Date.now());
          const resetToken = crypto.randomBytes(32).toString('base64url');
          const createdAt = Date.now();
          database.prepare(`
            INSERT INTO password_reset_tokens (token_hash, customer_id, created_at, expires_at)
            VALUES (?, ?, ?, ?)
          `).run(hashResetToken(resetToken), customer.id, createdAt, createdAt + RESET_TOKEN_DURATION);
          try {
            await sendPasswordResetEmail(customer.email, resetToken);
          } catch (error) {
            database.prepare('DELETE FROM password_reset_tokens WHERE token_hash = ?')
              .run(hashResetToken(resetToken));
            console.error('Gagal mengirim email pemulihan kata sandi:', error.message);
            sendJson(response, 202, {
              message: 'Jika email terdaftar, tautan pengaturan ulang akan dikirim.'
            });
            return;
          }
        }
        sendJson(response, 202, {
          message: 'Jika email terdaftar, tautan pengaturan ulang akan dikirim.'
        });
      } else if (method === 'POST' && pathname === '/api/customer/reset-password') {
        if (!hasValidOrigin(request)) {
          sendError(response, 403, 'Asal request tidak diizinkan.');
          return;
        }
        if (isRateLimited(request, 'customer-reset-confirm', 10, 15 * 60 * 1000)) {
          sendError(response, 429, 'Terlalu banyak percobaan. Coba lagi nanti.');
          return;
        }
        recordRateLimitAttempt(request, 'customer-reset-confirm', 15 * 60 * 1000);
        const payload = await readJson(request, response);
        if (!payload) return;
        if (typeof payload.token !== 'string' || !validatePassword(payload.password)) {
          sendError(response, 400, `Tautan atau kata sandi tidak valid. Kata sandi harus ${PASSWORD_MIN_LENGTH}–128 karakter.`);
          return;
        }
        const reset = database.prepare(`
          SELECT token_hash, customer_id FROM password_reset_tokens
          WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
        `).get(hashResetToken(payload.token), Date.now());
        if (!reset) {
          sendError(response, 400, 'Tautan pengaturan ulang tidak valid atau sudah kedaluwarsa.');
          return;
        }
        const passwordHash = await hashPassword(payload.password);
        const updatePassword = database.prepare(
          'UPDATE customers SET password_hash = ? WHERE id = ?'
        );
        const consumeToken = database.prepare(
          'UPDATE password_reset_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL'
        );
        database.exec('BEGIN IMMEDIATE');
        try {
          const updated = updatePassword.run(passwordHash, reset.customer_id);
          const consumed = consumeToken.run(Date.now(), reset.token_hash);
          if (Number(updated.changes) !== 1 || Number(consumed.changes) !== 1) {
            throw new Error('Tautan reset kata sandi sudah digunakan.');
          }
          database.prepare('DELETE FROM auth_sessions WHERE member_id = ? AND role = ?')
            .run(database.prepare('SELECT member_id FROM customers WHERE id = ?').get(reset.customer_id).member_id, 'customer');
          database.exec('COMMIT');
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
        sendJson(response, 200, { message: 'Kata sandi berhasil diperbarui. Silakan masuk.' });
      } else if (method === 'GET' && pathname.startsWith('/api/admin/')) {
        if (!requireSession(database, request, response, 'admin')) return;
        if (pathname === '/api/admin/promos') {
          sendJson(response, 200, listPromos(database, false));
        } else if (pathname === '/api/admin/customers') {
          const { sql, parameters } = customerQuery(getSearchQuery(url));
          sendJson(response, 200, database.prepare(sql).all(...parameters));
        } else if (pathname === '/api/admin/customers.csv') {
          const { sql, parameters } = customerQuery(getSearchQuery(url));
          sendCsv(response, database.prepare(sql).all(...parameters));
        } else if (pathname === '/api/admin/claims') {
          const claims = database.prepare(`
            SELECT id, promo_id, promo_title, member_id, customer_name, claimed_at
            FROM promo_claims ORDER BY claimed_at DESC LIMIT 500
          `).all();
          sendJson(response, 200, claims);
        } else if (pathname === '/api/admin/analytics') {
          sendJson(response, 200, getAnalytics(database));
        } else {
          sendError(response, 404, 'Endpoint tidak ditemukan.');
        }
      } else if (method === 'POST' && pathname.startsWith('/api/admin/')) {
        if (!requireSession(database, request, response, 'admin', true)) return;
        if (pathname === '/api/admin/promos') {
          const payload = await readJson(request, response);
          if (!payload) return;
          const result = savePromo(database, { ...payload, _method: 'POST' });
          if (result.error) sendError(response, result.status, result.error);
          else sendJson(response, 201, result.promo);
        } else if (pathname === '/api/admin/claims') {
          const payload = await readJson(request, response);
          if (!payload) return;
          if (typeof payload.member_id !== 'string' || !payload.member_id.trim() ||
              !Number.isInteger(payload.promo_id) || payload.promo_id <= 0) {
            sendError(response, 400, 'Pelanggan dan promo wajib dipilih.');
            return;
          }
          const customer = database.prepare(
            'SELECT member_id, name FROM customers WHERE member_id = ?'
          ).get(payload.member_id.trim());
          if (!customer) {
            sendError(response, 404, 'Pelanggan tidak ditemukan.');
            return;
          }
          const today = new Date().toLocaleDateString('sv-SE');
          const promo = database.prepare(`
            SELECT id, title FROM promos
            WHERE id = ? AND active = 1
              AND (starts_on IS NULL OR starts_on = '' OR starts_on <= ?)
              AND (ends_on IS NULL OR ends_on = '' OR ends_on >= ?)
          `).get(payload.promo_id, today, today);
          if (!promo) {
            sendError(response, 400, 'Promo tidak aktif atau di luar masa berlaku.');
            return;
          }
          const claimedAt = Date.now();
          const result = database.prepare(`
            INSERT INTO promo_claims (promo_id, promo_title, member_id, customer_name, claimed_at)
            VALUES (?, ?, ?, ?, ?)
          `).run(promo.id, promo.title, customer.member_id, customer.name, claimedAt);
          sendJson(response, 201, {
            id: Number(result.lastInsertRowid),
            promo_id: promo.id,
            promo_title: promo.title,
            member_id: customer.member_id,
            customer_name: customer.name,
            claimed_at: claimedAt
          });
        } else {
          sendError(response, 404, 'Endpoint tidak ditemukan.');
        }
      } else if (method === 'PUT' && /^\/api\/admin\/promos\/\d+$/.test(pathname)) {
        if (!requireSession(database, request, response, 'admin', true)) return;
        const payload = await readJson(request, response);
        if (!payload) return;
        const result = savePromo(database, payload, Number(pathname.split('/').at(-1)));
        if (result.error) sendError(response, result.status, result.error);
        else sendJson(response, 200, result.promo);
      } else if (method === 'PATCH' && /^\/api\/admin\/promos\/\d+\/active$/.test(pathname)) {
        if (!requireSession(database, request, response, 'admin', true)) return;
        const payload = await readJson(request, response);
        if (!payload) return;
        if (typeof payload.active !== 'boolean') {
          sendError(response, 400, 'Status promo tidak valid.');
          return;
        }
        const promoId = Number(pathname.split('/').at(-2));
        const result = database.prepare('UPDATE promos SET active = ? WHERE id = ?')
          .run(Number(payload.active), promoId);
        if (Number(result.changes) === 0) sendError(response, 404, 'Promo tidak ditemukan.');
        else sendJson(response, 200, { ok: true });
      } else if (method === 'DELETE' && /^\/api\/admin\/promos\/\d+$/.test(pathname)) {
        if (!requireSession(database, request, response, 'admin', true)) return;
        const promoId = Number(pathname.split('/').at(-1));
        const result = database.prepare('DELETE FROM promos WHERE id = ?').run(promoId);
        if (Number(result.changes) === 0) sendError(response, 404, 'Promo tidak ditemukan.');
        else sendJson(response, 200, { ok: true });
      } else if (pathname.startsWith('/api/')) {
        sendError(response, 404, 'Endpoint tidak ditemukan.');
      } else {
        sendError(response, 404, 'Endpoint tidak ditemukan.');
      }
    } finally {
      database.close();
    }
  }));
}

function serveStatic(request, response, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    sendError(response, 400, 'Alamat file tidak valid.');
    return;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';
  const filePath = path.resolve(ROOT_DIR, `.${pathname}`);
  if (filePath !== ROOT_DIR && !filePath.startsWith(`${ROOT_DIR}${path.sep}`)) {
    sendError(response, 403, 'Akses file tidak diizinkan.');
    return;
  }
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      sendError(response, 404, 'File tidak ditemukan.');
      return;
    }
    throw error;
  }
  if (!stat.isFile()) {
    sendError(response, 404, 'File tidak ditemukan.');
    return;
  }
  const contentTypes = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain; charset=utf-8'
  };
  response.writeHead(200, {
    'Content-Type': contentTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    ...(process.env.NODE_ENV === 'production' ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {})
  });
  if (request.method === 'HEAD') response.end();
  else fs.createReadStream(filePath).pipe(response);
}

if (require.main === module) {
  if (process.env.NODE_ENV === 'production' && (process.env.ADMIN_PASSWORD || '').length < 12) {
    console.error('ADMIN_PASSWORD wajib diatur (minimal 12 karakter) untuk production.');
    process.exit(1);
  }
  if (process.env.NODE_ENV === 'production' && !process.env.BASE_URL?.startsWith('https://')) {
    console.error('BASE_URL HTTPS wajib diatur untuk production.');
    process.exit(1);
  }
  const server = createServer();
  const port = Number(process.env.PORT || 8000);
  const host = process.env.HOST || '0.0.0.0';
  server.listen(port, host, () => {
    console.log(`BrewClub berjalan di http://127.0.0.1:${port}`);
    if ((process.env.ADMIN_PASSWORD || '').length < 12) {
      console.warn('Login admin belum aktif: set ADMIN_PASSWORD (minimal 12 karakter) lalu mulai ulang server.');
    }
  });
  server.on('error', error => {
    console.error('Server gagal dijalankan:', error.message);
    process.exitCode = 1;
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}

module.exports = { createServer, initializeDatabase };
