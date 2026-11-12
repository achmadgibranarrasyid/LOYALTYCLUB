"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createClient } = require("@libsql/client");

const ROOT_DIR = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const PUBLIC_STATIC_FILES = new Set([
  "akun.html",
  "admin.html",
  "admin.js",
  "app.js",
  "customer-api.js",
  "index.html",
  "login.html",
  "mont-logo.svg",
  "MONT NEON BOX.png",
  "pengguna.html",
  "privacy.html",
  "reset-password.html",
  "script.js",
  "style.css",
]);
const MAX_REQUEST_SIZE = 16_384;
const PASSWORD_MIN_LENGTH = 12;
const ADMIN_PASSWORD_MIN_LENGTH = 16;
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;
const RESET_TOKEN_DURATION_MS = 60 * 60 * 1000;
const PRIVACY_POLICY_VERSION = "2026-11-04";
const RATE_LIMITS = {
  "admin-login": [5, 5 * 60 * 1000],
  "customer-register": [10, 60 * 60 * 1000],
  "customer-login": [10, 15 * 60 * 1000],
  "customer-reset": [5, 60 * 60 * 1000],
  "customer-reset-confirm": [10, 15 * 60 * 1000],
};
const INITIAL_PROMOS = [
  ["diskon", "DISKON 20%", "Diskon 20% Semua Pastry", "Berlaku untuk croissant, danish, cinnamon roll, dan pastry lainnya.", "", ""],
  ["diskon", "DISKON 15%", "Diskon 15% Signature Latte", "Nikmati potongan harga untuk minuman latte andalan kami.", "", ""],
  ["diskon", "BUY 1 GET 1", "Diskon 50% Kopi Kedua", "Khusus pemesanan di hari Jumat. Berlaku untuk semua varian kopi.", "", ""],
  ["bundling", "HEMAT 30%", "Paket Ngopi Pagi", "1 Americano dingin/panas + 1 Butter Croissant.", "Rp 50.000", "Rp 35.000"],
  ["bundling", "HEMAT 40%", "Paket Berdua", "2 Signature Latte + 2 Potong Cake pilihan.", "Rp 140.000", "Rp 99.000"],
  ["bundling", "HEMAT 25%", "Paket WFH", "1 Kopi Susu + 1 Snack Box + 1 Air Mineral.", "Rp 65.000", "Rp 45.000"],
];
const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};
const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};
const SECURE_HEADERS = {
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

function nowMs() {
  return Date.now();
}

function sessionTokenHash(token) {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }, (error, derived) => {
      if (error) return reject(error);
      resolve(`scrypt$32768$${salt.toString("hex")}$${derived.toString("hex")}`);
    });
  });
}

function verifyPassword(password, encodedHash) {
  const [algorithm, cost, saltHex, hashHex, ...extra] = String(encodedHash || "").split("$");
  if (algorithm !== "scrypt" || cost !== "32768" || extra.length || !/^[0-9a-f]{32}$/i.test(saltHex) || !/^[0-9a-f]{128}$/i.test(hashHex)) {
    return Promise.resolve(false);
  }
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, Buffer.from(saltHex, "hex"), 64, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }, (error, derived) => {
      if (error) return reject(error);
      const expected = Buffer.from(hashHex, "hex");
      resolve(crypto.timingSafeEqual(derived, expected));
    });
  });
}

function validatePassword(password) {
  return typeof password === "string"
    && password.length >= PASSWORD_MIN_LENGTH
    && password.length <= 128
    && !/[\x00-\x1f\x7f]/.test(password);
}

function createDatabaseClient(options = {}) {
  const env = options.env || process.env;
  const databaseUrl = options.databaseUrl || env.TURSO_DATABASE_URL;
  const authToken = options.authToken || env.TURSO_AUTH_TOKEN;
  if (env.VERCEL && (!databaseUrl || !authToken)) {
    throw new Error("TURSO_DATABASE_URL dan TURSO_AUTH_TOKEN wajib diatur di Vercel.");
  }
  if (databaseUrl) {
    if (/^(libsql|https?):\/\//i.test(databaseUrl) && !authToken) {
      throw new Error("TURSO_AUTH_TOKEN wajib untuk database Turso jarak jauh.");
    }
    return createClient({
      url: databaseUrl,
      authToken,
    });
  }
  const databasePath = path.resolve(
    options.databasePath || env.MONT_DATABASE || path.join(os.homedir(), ".mont", "customers.sqlite3"),
  );
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  return createClient({ url: pathToFileURL(databasePath).href });
}

async function initializeDatabase(client) {
  await client.batch([
    `CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      phone TEXT NOT NULL,
      joined INTEGER NOT NULL,
      password_hash TEXT,
      consent_at INTEGER,
      privacy_policy_version TEXT,
      points_balance INTEGER NOT NULL DEFAULT 0,
      tier_id INTEGER,
      total_spend INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS promos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL CHECK (category IN ('diskon', 'bundling')),
      label TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      price_old TEXT NOT NULL DEFAULT '',
      price_new TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1
    )`,
    "CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    `CREATE TABLE IF NOT EXISTS promo_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      promo_id INTEGER,
      promo_title TEXT NOT NULL,
      member_id TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      claimed_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS loyalty_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('purchase', 'promo_claim', 'adjustment', 'redemption')),
      points_delta INTEGER NOT NULL,
      description TEXT NOT NULL,
      purchase_amount INTEGER,
      reward_id INTEGER,
      created_at INTEGER NOT NULL
    )`,
    "CREATE INDEX IF NOT EXISTS loyalty_transactions_member_time ON loyalty_transactions (member_id, created_at DESC)",
    `CREATE TABLE IF NOT EXISTS loyalty_rewards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('free_drink', 'discount', 'custom')),
      description TEXT NOT NULL DEFAULT '',
      points_cost INTEGER NOT NULL CHECK (points_cost > 0),
      discount_amount INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS loyalty_tiers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      min_spend INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS customer_spend_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('purchase', 'baseline', 'correction')),
      amount_delta INTEGER NOT NULL,
      description TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    "CREATE INDEX IF NOT EXISTS customer_spend_transactions_member_time ON customer_spend_transactions (member_id, created_at DESC)",
    `CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK (role IN ('admin', 'customer')),
      username TEXT,
      member_id TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`,
    "CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions (expires_at)",
    `CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token_hash TEXT PRIMARY KEY,
      customer_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS auth_attempts (
      attempt_key TEXT PRIMARY KEY,
      window_started INTEGER NOT NULL,
      attempt_count INTEGER NOT NULL
    )`,
  ], "write");

  const customerColumns = await client.execute("PRAGMA table_info(customers)");
  const existingCustomerColumns = new Set(customerColumns.rows.map((row) => row.name));
  const needsSpendBackfill = !existingCustomerColumns.has("total_spend");
  for (const [column, definition] of [
    ["password_hash", "TEXT"],
    ["consent_at", "INTEGER"],
    ["privacy_policy_version", "TEXT"],
    ["points_balance", "INTEGER NOT NULL DEFAULT 0"],
    ["tier_id", "INTEGER"],
    ["total_spend", "INTEGER NOT NULL DEFAULT 0"],
  ]) {
    if (!existingCustomerColumns.has(column)) {
      try {
        await client.execute(`ALTER TABLE customers ADD COLUMN ${column} ${definition}`);
      } catch (error) {
        if (!/duplicate column/i.test(error.message)) throw error;
      }
    }
  }
  if (existingCustomerColumns.has("qr_code")) {
    await client.execute("ALTER TABLE customers DROP COLUMN qr_code");
  }
  const promoColumns = await client.execute("PRAGMA table_info(promos)");
  const existingPromoColumns = new Set(promoColumns.rows.map((row) => row.name));
  for (const column of ["starts_on", "ends_on"]) {
    if (!existingPromoColumns.has(column)) {
      try {
        await client.execute(`ALTER TABLE promos ADD COLUMN ${column} TEXT`);
      } catch (error) {
        if (!/duplicate column/i.test(error.message)) throw error;
      }
    }
  }
  const tierColumns = await client.execute("PRAGMA table_info(loyalty_tiers)");
  if (!tierColumns.rows.some((row) => row.name === "min_spend")) {
    await client.execute("ALTER TABLE loyalty_tiers ADD COLUMN min_spend INTEGER NOT NULL DEFAULT 0");
  }
  if (needsSpendBackfill) {
    await client.execute(`
      UPDATE customers
      SET total_spend = COALESCE((
        SELECT SUM(purchase_amount) FROM loyalty_transactions
        WHERE loyalty_transactions.member_id = customers.member_id
          AND loyalty_transactions.type = 'purchase'
          AND purchase_amount > 0
      ), 0)
    `);
    await client.execute(`
      INSERT INTO customer_spend_transactions (member_id, type, amount_delta, description, created_at)
      SELECT member_id, 'purchase', purchase_amount, description, created_at
      FROM loyalty_transactions
      WHERE type = 'purchase' AND purchase_amount > 0
    `);
  }

  await client.executeMultiple(`
    CREATE TRIGGER IF NOT EXISTS loyalty_transactions_validate
    BEFORE INSERT ON loyalty_transactions
    BEGIN
      SELECT CASE
        WHEN NOT EXISTS (SELECT 1 FROM customers WHERE member_id = NEW.member_id)
        THEN RAISE(ABORT, 'LOYALTY_CUSTOMER_NOT_FOUND')
      END;
      SELECT CASE
        WHEN (SELECT points_balance + NEW.points_delta FROM customers WHERE member_id = NEW.member_id) < 0
        THEN RAISE(ABORT, 'LOYALTY_INSUFFICIENT_POINTS')
      END;
    END;
    CREATE TRIGGER IF NOT EXISTS loyalty_transactions_apply
    AFTER INSERT ON loyalty_transactions
    BEGIN
      UPDATE customers
      SET points_balance = points_balance + NEW.points_delta
      WHERE member_id = NEW.member_id;
    END;
  `);

  const seeded = await client.execute("SELECT 1 FROM app_settings WHERE key = 'initial_promos_seeded'");
  const promoCount = await client.execute("SELECT COUNT(*) AS count FROM promos");
  if (seeded.rows.length === 0 && Number(promoCount.rows[0].count) === 0) {
    const statements = INITIAL_PROMOS.map((promo) => ({
      sql: `INSERT INTO promos (category, label, title, description, price_old, price_new)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: promo,
    }));
    statements.push({
      sql: "INSERT OR IGNORE INTO app_settings (key, value) VALUES ('initial_promos_seeded', '1')",
      args: [],
    });
    await client.batch(statements, "write");
  } else {
    await client.execute(
      "INSERT OR IGNORE INTO app_settings (key, value) VALUES ('initial_promos_seeded', '1')",
    );
  }
  for (const [name, minSpend] of [["Bronze", 0], ["Silver", 1_000_000], ["Gold", 5_000_000]]) {
    await client.execute({
      sql: "INSERT OR IGNORE INTO loyalty_tiers (name, description, min_spend, created_at) VALUES (?, '', ?, ?)",
      args: [name, minSpend, nowMs()],
    });
  }
  const tierThresholds = await client.execute(
    "SELECT name, min_spend FROM loyalty_tiers WHERE name IN ('Bronze', 'Silver', 'Gold')",
  );
  const thresholds = new Map(tierThresholds.rows.map((tier) => [String(tier.name).toLowerCase(), Number(tier.min_spend)]));
  if (thresholds.get("bronze") !== 0 || !Number.isSafeInteger(thresholds.get("silver"))
    || !Number.isSafeInteger(thresholds.get("gold")) || thresholds.get("silver") < 1
    || thresholds.get("gold") <= thresholds.get("silver")) {
    for (const [name, minSpend] of [["Bronze", 0], ["Silver", 1_000_000], ["Gold", 5_000_000]]) {
      await client.execute("UPDATE loyalty_tiers SET min_spend = ? WHERE name = ?", [minSpend, name]);
    }
  }
  await synchronizeCustomerTiers(client);
  await client.execute("DELETE FROM app_settings WHERE key = 'loyalty_settings'");
  await client.execute("DELETE FROM auth_sessions WHERE expires_at <= ?", [nowMs()]);
  await client.execute(
    "DELETE FROM password_reset_tokens WHERE expires_at <= ? OR used_at IS NOT NULL",
    [nowMs()],
  );
}

function parseCookies(header = "") {
  const cookies = {};
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    try {
      cookies[name] = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      continue;
    }
  }
  return cookies;
}

function getClientAddress(req) {
  if (process.env.VERCEL || process.env.TRUST_PROXY === "1") {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.length < 512) {
      const addresses = forwarded.split(",").map((address) => address.trim());
      return process.env.VERCEL ? addresses[0] : addresses[addresses.length - 1];
    }
  }
  return req.socket?.remoteAddress || "unknown";
}

function hasValidOrigin(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || !host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function setSecurityHeaders(res) {
  for (const [name, value] of Object.entries(SECURE_HEADERS)) {
    res.setHeader(name, value);
  }
  if (process.env.NODE_ENV === "production" || process.env.VERCEL) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
}

function sendJson(res, status, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    ...JSON_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    ...headers,
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function sendCookie(res, token, role, maxAge = SESSION_DURATION_MS / 1000) {
  const name = role === "admin" ? "mont_admin" : "mont_customer";
  const parts = [
    `${name}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
  ];
  if (process.env.NODE_ENV === "production" || process.env.VERCEL) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

async function readJson(req) {
  const contentType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    const error = new Error("Content-Type harus application/json.");
    error.status = 415;
    throw error;
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_REQUEST_SIZE) {
      const error = new Error("Ukuran data tidak valid atau terlalu besar.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (length === 0) {
    const error = new Error("Data JSON wajib diisi.");
    error.status = 400;
    throw error;
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Format JSON tidak valid.");
    error.status = 400;
    throw error;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    const error = new Error("Data harus berupa objek.");
    error.status = 400;
    throw error;
  }
  return payload;
}

async function isRateLimited(client, action, address) {
  const [limit, windowMs] = RATE_LIMITS[action];
  const key = `${action}:${address}`;
  const result = await client.execute({
    sql: "SELECT window_started, attempt_count FROM auth_attempts WHERE attempt_key = ?",
    args: [key],
  });
  const row = result.rows[0];
  if (!row || nowMs() - Number(row.window_started) >= windowMs) return false;
  return Number(row.attempt_count) >= limit;
}

async function recordRateAttempt(client, action, address) {
  const [, windowMs] = RATE_LIMITS[action];
  const key = `${action}:${address}`;
  const now = nowMs();
  await client.execute({
    sql: `INSERT INTO auth_attempts (attempt_key, window_started, attempt_count)
          VALUES (?, ?, 1)
          ON CONFLICT(attempt_key) DO UPDATE SET
            window_started = CASE
              WHEN excluded.window_started - auth_attempts.window_started >= ? THEN excluded.window_started
              ELSE auth_attempts.window_started
            END,
            attempt_count = CASE
              WHEN excluded.window_started - auth_attempts.window_started >= ? THEN 1
              ELSE auth_attempts.attempt_count + 1
            END`,
    args: [key, now, windowMs, windowMs],
  });
  await client.execute("DELETE FROM auth_attempts WHERE window_started < ?", [now - 60 * 60 * 1000]);
}

async function clearRateLimit(client, action, address) {
  await client.execute("DELETE FROM auth_attempts WHERE attempt_key = ?", [`${action}:${address}`]);
}

async function getSession(client, req, role) {
  const cookieName = role === "admin" ? "mont_admin" : "mont_customer";
  const token = parseCookies(req.headers.cookie)[cookieName];
  if (!token) return null;
  const result = await client.execute({
    sql: `SELECT role, username, member_id, expires_at FROM auth_sessions
          WHERE token_hash = ? AND role = ? AND expires_at > ?`,
    args: [sessionTokenHash(token), role, nowMs()],
  });
  return result.rows[0] || null;
}

async function requireSession(client, req, res, role, mutation = false) {
  if (mutation && !hasValidOrigin(req)) {
    sendError(res, 403, "Asal request tidak diizinkan.");
    return null;
  }
  const session = await getSession(client, req, role);
  if (!session) {
    sendError(res, 401, `Sesi ${role === "admin" ? "admin" : "pelanggan"} berakhir. Silakan masuk kembali.`);
    return null;
  }
  return session;
}

async function createSession(client, role, { username = null, memberId = null } = {}) {
  const now = nowMs();
  const token = crypto.randomBytes(32).toString("base64url");
  await client.execute("DELETE FROM auth_sessions WHERE expires_at <= ?", [now]);
  await client.execute({
    sql: `INSERT INTO auth_sessions
          (token_hash, role, username, member_id, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [sessionTokenHash(token), role, username, memberId, now, now + SESSION_DURATION_MS],
  });
  return token;
}

async function createCustomerSessionPayload(client, session) {
  const result = await client.execute({
    sql: `SELECT customers.member_id AS id, customers.name, customers.email, customers.phone,
                 customers.joined, customers.points_balance, customers.total_spend, customers.tier_id,
                 loyalty_tiers.name AS tier_name, loyalty_tiers.description AS tier_description
          FROM customers LEFT JOIN loyalty_tiers ON loyalty_tiers.id = customers.tier_id
          WHERE customers.member_id = ?`,
    args: [session.member_id],
  });
  return result.rows[0] || null;
}

async function recordSpend(client, memberId, amount, description, type, setTotal = false) {
  const customer = await client.execute(
    "SELECT total_spend FROM customers WHERE member_id = ?",
    [memberId],
  );
  if (!customer.rows.length) throw Object.assign(new Error("Pelanggan tidak ditemukan."), { status: 404 });
  const currentSpend = Number(customer.rows[0].total_spend);
  const nextSpend = setTotal ? amount : currentSpend + amount;
  if (!Number.isSafeInteger(nextSpend) || nextSpend < 0 || nextSpend > 1_000_000_000_000) {
    throw Object.assign(new Error("Total nominal transaksi maksimal Rp1.000.000.000.000."), { status: 400 });
  }
  const delta = nextSpend - currentSpend;
  await client.batch([
    {
      sql: `INSERT INTO customer_spend_transactions (member_id, type, amount_delta, description, created_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [memberId, type, delta, description, nowMs()],
    },
    {
      sql: "UPDATE customers SET total_spend = ? WHERE member_id = ?",
      args: [nextSpend, memberId],
    },
    {
      sql: `UPDATE customers
            SET tier_id = (
              SELECT id FROM loyalty_tiers
              WHERE active = 1 AND name IN ('Bronze', 'Silver', 'Gold')
                AND min_spend <= customers.total_spend
              ORDER BY min_spend DESC LIMIT 1
            )
            WHERE member_id = ?`,
      args: [memberId],
    },
  ], "write");
  const tier = await getTierForSpend(client, nextSpend);
  return { total_spend: nextSpend, tier: tier ? tier.name : null };
}

async function listTiers(client) {
  const result = await client.execute(
    `SELECT tiers.id, tiers.name, tiers.description, tiers.active, tiers.min_spend,
            COUNT(customers.id) AS member_count
     FROM loyalty_tiers AS tiers
     LEFT JOIN customers ON customers.tier_id = tiers.id
     GROUP BY tiers.id
     ORDER BY CASE tiers.name WHEN 'Bronze' THEN 0 WHEN 'Silver' THEN 1 WHEN 'Gold' THEN 2 ELSE 3 END,
              tiers.min_spend`,
  );
  return result.rows;
}

async function getTierForSpend(client, spend) {
  const result = await client.execute({
    sql: `SELECT id, name, description, min_spend FROM loyalty_tiers
          WHERE active = 1 AND name IN ('Bronze', 'Silver', 'Gold') AND min_spend <= ?
          ORDER BY min_spend DESC LIMIT 1`,
    args: [spend],
  });
  return result.rows[0] || null;
}

async function synchronizeCustomerTiers(client, memberId = null) {
  const silver = await client.execute("SELECT min_spend FROM loyalty_tiers WHERE name = 'Silver'");
  const gold = await client.execute("SELECT min_spend FROM loyalty_tiers WHERE name = 'Gold'");
  if (Number(gold.rows[0].min_spend) <= Number(silver.rows[0].min_spend)) {
    throw Object.assign(new Error("Ambang Gold harus lebih besar daripada ambang Silver."), { status: 400 });
  }
  const statement = {
    sql: `UPDATE customers
          SET tier_id = (
            SELECT id FROM loyalty_tiers
            WHERE active = 1 AND name IN ('Bronze', 'Silver', 'Gold')
              AND min_spend <= customers.total_spend
            ORDER BY min_spend DESC LIMIT 1
          )
          ${memberId ? "WHERE member_id = ?" : ""}`,
    args: memberId ? [memberId] : [],
  };
  await client.execute(statement);
}

async function saveTierSettings(client, payload) {
  const silverMinSpend = payload.silver_min_spend;
  const goldMinSpend = payload.gold_min_spend;
  if (!Number.isSafeInteger(silverMinSpend) || !Number.isSafeInteger(goldMinSpend)
    || silverMinSpend < 1 || goldMinSpend <= silverMinSpend || goldMinSpend > 1_000_000_000_000) {
    throw Object.assign(new Error("Ambang Silver harus lebih dari Rp0 dan ambang Gold harus lebih besar daripada Silver."), { status: 400 });
  }
  await client.batch([
    {
      sql: "UPDATE loyalty_tiers SET min_spend = ? WHERE name = 'Silver'",
      args: [silverMinSpend],
    },
    {
      sql: "UPDATE loyalty_tiers SET min_spend = ? WHERE name = 'Gold'",
      args: [goldMinSpend],
    },
    {
      sql: `UPDATE customers
            SET tier_id = (
              SELECT id FROM loyalty_tiers
              WHERE active = 1 AND name IN ('Bronze', 'Silver', 'Gold')
                AND min_spend <= customers.total_spend
              ORDER BY min_spend DESC LIMIT 1
            )`,
      args: [],
    },
  ], "write");
  return listTiers(client);
}

function pointsTransactionStatement(memberId, delta, type, description, options = {}) {
  return {
    sql: `INSERT INTO loyalty_transactions
          (member_id, type, points_delta, description, purchase_amount, reward_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      memberId,
      type,
      delta,
      description,
      options.purchaseAmount || null,
      options.rewardId || null,
      nowMs(),
    ],
  };
}

async function recordPointsTransaction(client, memberId, delta, type, description, options = {}) {
  try {
    const results = await client.batch([
      pointsTransactionStatement(memberId, delta, type, description, options),
      { sql: "SELECT points_balance FROM customers WHERE member_id = ?", args: [memberId] },
    ], "write");
    return Number(results[1].rows[0].points_balance);
  } catch (error) {
    if (error.message.includes("LOYALTY_CUSTOMER_NOT_FOUND")) {
      throw Object.assign(new Error("Pelanggan tidak ditemukan."), { status: 404 });
    }
    if (error.message.includes("LOYALTY_INSUFFICIENT_POINTS")) {
      throw Object.assign(new Error("Poin pelanggan tidak mencukupi."), { status: 400 });
    }
    throw error;
  }
}

function csvEscape(value) {
  let text = value == null ? "" : String(value);
  if (/^[\s]*[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

async function sendCustomerCsv(client, res, search) {
  const customers = await customerSearch(client, search);
  const rows = [["Nama", "Email", "WhatsApp", "Bergabung", "Total transaksi", "Poin", "Tier"]];
  for (const customer of customers) {
    rows.push([
      customer.name,
      customer.email,
      customer.phone,
      new Date(Number(customer.joined)).toISOString().slice(0, 10),
      customer.total_spend,
      customer.points_balance,
      customer.tier_name || "",
    ]);
  }
  const body = Buffer.from(`\uFEFF${rows.map((row) => row.map(csvEscape).join(",")).join("\r\n")}`, "utf8");
  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": 'attachment; filename="pelanggan-mont.csv"',
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

async function customerSearch(client, rawSearch) {
  const search = String(rawSearch || "").trim().slice(0, 100);
  if (!search) {
    const result = await client.execute(
      `SELECT customers.member_id, customers.name, customers.email, customers.phone, customers.joined,
              customers.points_balance, customers.total_spend, customers.tier_id, loyalty_tiers.name AS tier_name
       FROM customers LEFT JOIN loyalty_tiers ON loyalty_tiers.id = customers.tier_id
       ORDER BY customers.joined DESC`,
    );
    return result.rows;
  }
  const escaped = search.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_");
  const pattern = `%${escaped}%`;
  const result = await client.execute({
    sql: `SELECT customers.member_id, customers.name, customers.email, customers.phone, customers.joined,
                 customers.points_balance, customers.total_spend, customers.tier_id, loyalty_tiers.name AS tier_name
          FROM customers LEFT JOIN loyalty_tiers ON loyalty_tiers.id = customers.tier_id
          WHERE customers.name LIKE ? ESCAPE '!'
             OR customers.email LIKE ? ESCAPE '!'
             OR customers.phone LIKE ? ESCAPE '!'
          ORDER BY customers.joined DESC`,
    args: [pattern, pattern, pattern],
  });
  return result.rows;
}

async function claimCustomerLookup(client, rawSearch) {
  const search = String(rawSearch || "").trim().slice(0, 100);
  if (search.length < 2) return [];
  const escaped = search.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_");
  const pattern = `%${escaped}%`;
  const result = await client.execute({
    sql: `SELECT member_id, name, email, phone FROM customers
          WHERE name LIKE ? ESCAPE '!'
             OR email LIKE ? ESCAPE '!'
             OR phone LIKE ? ESCAPE '!'
          ORDER BY name COLLATE NOCASE, joined DESC LIMIT 10`,
    args: [pattern, pattern, pattern],
  });
  return result.rows;
}

async function listPromos(client, activeOnly) {
  if (!activeOnly) {
    const result = await client.execute("SELECT * FROM promos ORDER BY category, id");
    return result.rows;
  }
  const today = new Date().toISOString().slice(0, 10);
  const result = await client.execute({
    sql: `SELECT * FROM promos WHERE active = 1
          AND (starts_on IS NULL OR starts_on = '' OR starts_on <= ?)
          AND (ends_on IS NULL OR ends_on = '' OR ends_on >= ?)
          ORDER BY category, id`,
    args: [today, today],
  });
  return result.rows;
}

function validatePromoDate(value) {
  if (typeof value !== "string" || !value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value ? false : value;
}

async function savePromo(client, payload, promoId = null) {
  const category = payload.category;
  if (!["diskon", "bundling"].includes(category)) throw Object.assign(new Error("Kategori promo tidak valid."), { status: 400 });
  const values = ["label", "title", "description", "price_old", "price_new"].map((key) => payload[key] ?? "");
  if (!values.every((value) => typeof value === "string")) throw Object.assign(new Error("Data promo tidak valid."), { status: 400 });
  const normalized = values.map((value) => value.trim());
  if (!normalized[0] || normalized[0].length > 40 || !normalized[1] || normalized[1].length > 120 || !normalized[2] || normalized[2].length > 500) {
    throw Object.assign(new Error("Label, judul, atau deskripsi promo tidak valid."), { status: 400 });
  }
  if (normalized[3].length > 40 || normalized[4].length > 40) throw Object.assign(new Error("Harga maksimal 40 karakter."), { status: 400 });
  const rawStart = payload.starts_on ?? "";
  const rawEnd = payload.ends_on ?? "";
  if (typeof rawStart !== "string" || typeof rawEnd !== "string") throw Object.assign(new Error("Tanggal promo tidak valid."), { status: 400 });
  const startsOn = validatePromoDate(rawStart.trim());
  const endsOn = validatePromoDate(rawEnd.trim());
  if (startsOn === false || endsOn === false) throw Object.assign(new Error("Tanggal promo harus valid."), { status: 400 });
  if (startsOn && endsOn && startsOn > endsOn) throw Object.assign(new Error("Tanggal berakhir tidak boleh sebelum tanggal mulai."), { status: 400 });
  if (promoId === null) {
    const inserted = await client.execute({
      sql: `INSERT INTO promos
            (category, label, title, description, price_old, price_new, active, starts_on, ends_on)
            VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?) RETURNING *`,
      args: [category, ...normalized, startsOn, endsOn],
    });
    return { status: 201, promo: inserted.rows[0] };
  }
  const updated = await client.execute({
    sql: `UPDATE promos SET category = ?, label = ?, title = ?, description = ?,
          price_old = ?, price_new = ?, starts_on = ?, ends_on = ? WHERE id = ? RETURNING *`,
    args: [category, ...normalized, startsOn, endsOn, promoId],
  });
  if (updated.rows.length === 0) throw Object.assign(new Error("Promo tidak ditemukan."), { status: 404 });
  return { status: 200, promo: updated.rows[0] };
}

async function saveReward(client, payload, rewardId = null) {
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  const description = typeof payload.description === "string" ? payload.description.trim() : "";
  const type = payload.type;
  const pointsCost = payload.points_cost;
  const discountAmount = type === "discount" ? payload.discount_amount : 0;
  if (!name || name.length > 100 || description.length > 240
    || !["free_drink", "discount", "custom"].includes(type)
    || !Number.isSafeInteger(pointsCost) || pointsCost < 1 || pointsCost > 1_000_000
    || !Number.isSafeInteger(discountAmount) || discountAmount < 0 || discountAmount > 100_000_000
    || (type === "discount" && discountAmount < 1)) {
    throw Object.assign(new Error("Nama, tipe, poin, atau nilai reward tidak valid."), { status: 400 });
  }
  if (rewardId === null) {
    const inserted = await client.execute({
      sql: `INSERT INTO loyalty_rewards (name, type, description, points_cost, discount_amount, created_at)
            VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
      args: [name, type, description, pointsCost, discountAmount, nowMs()],
    });
    return { status: 201, reward: inserted.rows[0] };
  }
  const updated = await client.execute({
    sql: `UPDATE loyalty_rewards SET name = ?, type = ?, description = ?, points_cost = ?, discount_amount = ?
          WHERE id = ? RETURNING *`,
    args: [name, type, description, pointsCost, discountAmount, rewardId],
  });
  if (updated.rows.length === 0) throw Object.assign(new Error("Reward tidak ditemukan."), { status: 404 });
  return { status: 200, reward: updated.rows[0] };
}

async function listRewards(client, activeOnly = false) {
  const result = await client.execute(
    `SELECT id, name, type, description, points_cost, discount_amount, active
     FROM loyalty_rewards ${activeOnly ? "WHERE active = 1" : ""}
     ORDER BY points_cost, id`,
  );
  return result.rows;
}

async function getCustomerLoyalty(client, memberId) {
  const [customer, transactions, rewards] = await Promise.all([
    client.execute(
      `SELECT customers.points_balance, customers.total_spend,
              loyalty_tiers.name, loyalty_tiers.description
       FROM customers LEFT JOIN loyalty_tiers ON loyalty_tiers.id = customers.tier_id
       WHERE customers.member_id = ?`,
      [memberId],
    ),
    client.execute(
      `SELECT type, points_delta, description, purchase_amount, created_at
       FROM loyalty_transactions WHERE member_id = ? ORDER BY created_at DESC, id DESC LIMIT 50`,
      [memberId],
    ),
    listRewards(client, true),
  ]);
  if (customer.rows.length === 0) throw Object.assign(new Error("Pelanggan tidak ditemukan."), { status: 404 });
  const totalSpend = Number(customer.rows[0].total_spend);
  const nextTierResult = await client.execute({
    sql: `SELECT name, min_spend FROM loyalty_tiers
          WHERE active = 1 AND name IN ('Bronze', 'Silver', 'Gold') AND min_spend > ?
          ORDER BY min_spend LIMIT 1`,
    args: [totalSpend],
  });
  return {
    points_balance: Number(customer.rows[0].points_balance),
    total_spend: totalSpend,
    tier: customer.rows[0].name ? {
      name: customer.rows[0].name,
      description: customer.rows[0].description,
    } : null,
    next_tier: nextTierResult.rows[0] || null,
    transactions: transactions.rows,
    rewards,
  };
}

async function getAnalytics(client) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 6);
  const startTimestamp = start.getTime();
  const [total, lastWeek, dailyRows, topPromos] = await Promise.all([
    client.execute("SELECT COUNT(*) AS count FROM promo_claims"),
    client.execute("SELECT COUNT(*) AS count FROM promo_claims WHERE claimed_at >= ?", [startTimestamp]),
    client.execute(
      `SELECT date(claimed_at / 1000, 'unixepoch', 'localtime') AS day, COUNT(*) AS count
       FROM promo_claims WHERE claimed_at >= ? GROUP BY day`,
      [startTimestamp],
    ),
    client.execute(
      `SELECT promo_title AS title, COUNT(*) AS count FROM promo_claims
       GROUP BY promo_title ORDER BY count DESC, title LIMIT 5`,
    ),
  ]);
  const byDay = new Map(dailyRows.rows.map((row) => [row.day, Number(row.count)]));
  const daily = Array.from({ length: 7 }, (_, offset) => {
    const day = new Date(start);
    day.setDate(start.getDate() + offset);
    const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    return { date, count: byDay.get(date) || 0 };
  });
  return {
    total_claims: Number(total.rows[0].count),
    last_7_days: Number(lastWeek.rows[0].count),
    daily,
    top_promos: topPromos.rows.map((row) => ({ ...row, count: Number(row.count) })),
  };
}

async function sendPasswordResetEmail(email, token) {
  const { RESEND_API_KEY, EMAIL_FROM, BASE_URL } = process.env;
  if (!RESEND_API_KEY || !EMAIL_FROM || !BASE_URL) {
    throw Object.assign(new Error("Layanan pemulihan kata sandi belum dikonfigurasi."), { status: 503 });
  }
  const resetUrl = new URL("reset-password.html", `${BASE_URL.replace(/\/+$/, "")}/`);
  resetUrl.hash = `token=${encodeURIComponent(token)}`;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: [email],
      subject: "Atur ulang kata sandi MONT",
      text: `Gunakan tautan berikut untuk mengatur ulang kata sandi MONT. Tautan berlaku 1 jam dan hanya dapat digunakan sekali:\n\n${resetUrl}\n\nJika Anda tidak meminta pengaturan ulang, abaikan email ini.`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw Object.assign(
      new Error(`Layanan email menolak reset kata sandi (${response.status}). Periksa konfigurasi Resend dan alamat pengirim.`),
      { status: 502 },
    );
  }
}

async function registerCustomer(client, req, res) {
  if (!hasValidOrigin(req)) return sendError(res, 403, "Asal request tidak diizinkan.");
  const address = getClientAddress(req);
  if (await isRateLimited(client, "customer-register", address)) return sendError(res, 429, "Terlalu banyak percobaan pendaftaran. Coba lagi nanti.");
  await recordRateAttempt(client, "customer-register", address);
  const payload = await readJson(req);
  const { name, email, phone, password, consent } = payload;
  if (![name, email, phone].every((value) => typeof value === "string")) return sendError(res, 400, "Nama, email, dan nomor WhatsApp wajib diisi.");
  if (!validatePassword(password)) return sendError(res, 400, `Kata sandi harus ${PASSWORD_MIN_LENGTH}–128 karakter.`);
  if (consent !== true) return sendError(res, 400, "Persetujuan Kebijakan Privasi wajib diberikan.");
  const cleanName = name.trim();
  const cleanEmail = email.trim().toLowerCase();
  const cleanPhone = phone.trim();
  if (!cleanName || cleanName.length > 100) return sendError(res, 400, "Nama wajib diisi dan maksimal 100 karakter.");
  if (cleanEmail.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) return sendError(res, 400, "Format email tidak valid.");
  if (!/^\+?[\d\s()-]{8,30}$/.test(cleanPhone)) return sendError(res, 400, "Format nomor WhatsApp tidak valid.");

  const joined = nowMs();
  const memberId = `BC-${crypto.randomBytes(8).toString("hex").toUpperCase()}`;
  const passwordHash = await hashPassword(password);
  try {
    await client.execute({
      sql: `INSERT INTO customers
            (member_id, name, email, phone, joined, password_hash, consent_at, privacy_policy_version)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [memberId, cleanName, cleanEmail, cleanPhone, joined, passwordHash, joined, PRIVACY_POLICY_VERSION],
    });
  } catch (error) {
    if (/UNIQUE constraint failed: customers.email|customers\.email/i.test(error.message)) return sendError(res, 409, "Email ini sudah terdaftar.");
    throw error;
  }
  await synchronizeCustomerTiers(client, memberId);
  const token = await createSession(client, "customer", { memberId });
  sendJson(res, 201, { id: memberId, name: cleanName, email: cleanEmail, phone: cleanPhone, joined }, {
    "Set-Cookie": sessionCookie(token, "customer"),
  });
}

function sessionCookie(token, role, maxAge = SESSION_DURATION_MS / 1000) {
  const name = role === "admin" ? "mont_admin" : "mont_customer";
  const parts = [`${name}=${encodeURIComponent(token)}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAge}`];
  if (process.env.NODE_ENV === "production" || process.env.VERCEL) parts.push("Secure");
  return parts.join("; ");
}

async function customerLogin(client, req, res) {
  if (!hasValidOrigin(req)) return sendError(res, 403, "Asal request tidak diizinkan.");
  const address = getClientAddress(req);
  if (await isRateLimited(client, "customer-login", address)) return sendError(res, 429, "Terlalu banyak percobaan masuk. Coba lagi dalam 15 menit.");
  const payload = await readJson(req);
  if (typeof payload.email !== "string" || typeof payload.password !== "string") return sendError(res, 400, "Email dan kata sandi wajib diisi.");
  const customerResult = await client.execute({
    sql: `SELECT customers.member_id AS id, customers.name, customers.email, customers.phone,
                 customers.joined, customers.points_balance, customers.total_spend,
                 customers.password_hash, customers.tier_id,
                 loyalty_tiers.name AS tier_name, loyalty_tiers.description AS tier_description
          FROM customers LEFT JOIN loyalty_tiers ON loyalty_tiers.id = customers.tier_id
          WHERE customers.email = ?`,
    args: [payload.email.trim().toLowerCase()],
  });
  const customer = customerResult.rows[0];
  let matches = false;
  if (customer?.password_hash && validatePassword(payload.password)) {
    matches = await verifyPassword(payload.password, customer.password_hash);
  } else if (!validatePassword(payload.password)) {
    await hashPassword(crypto.randomBytes(24).toString("hex"));
  }
  if (!matches) {
    await recordRateAttempt(client, "customer-login", address);
    return sendError(res, 401, "Email atau kata sandi salah. Jika memiliki akun lama, gunakan fitur Lupa kata sandi.");
  }
  await clearRateLimit(client, "customer-login", address);
  const token = await createSession(client, "customer", { memberId: customer.id });
  const { password_hash: _passwordHash, ...safeCustomer } = customer;
  sendJson(res, 200, safeCustomer, { "Set-Cookie": sessionCookie(token, "customer") });
}

async function forgotPassword(client, req, res) {
  if (!hasValidOrigin(req)) return sendError(res, 403, "Asal request tidak diizinkan.");
  const address = getClientAddress(req);
  if (await isRateLimited(client, "customer-reset", address)) return sendError(res, 429, "Terlalu banyak permintaan. Coba lagi nanti.");
  await recordRateAttempt(client, "customer-reset", address);
  const payload = await readJson(req);
  if (typeof payload.email !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(payload.email.trim())) return sendError(res, 400, "Format email tidak valid.");
  const customerResult = await client.execute({
    sql: "SELECT id, email FROM customers WHERE email = ?",
    args: [payload.email.trim().toLowerCase()],
  });
  const customer = customerResult.rows[0];
  if (customer) {
    const token = crypto.randomBytes(32).toString("base64url");
    const tokenHash = sessionTokenHash(token);
    const current = nowMs();
    await client.execute("DELETE FROM password_reset_tokens WHERE expires_at <= ? OR used_at IS NOT NULL", [current]);
    await client.execute({
      sql: "INSERT INTO password_reset_tokens (token_hash, customer_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
      args: [tokenHash, customer.id, current, current + RESET_TOKEN_DURATION_MS],
    });
    try {
      await sendPasswordResetEmail(customer.email, token);
    } catch (error) {
      await client.execute("DELETE FROM password_reset_tokens WHERE token_hash = ?", [tokenHash]);
      if (error.status) return sendError(res, error.status, error.message);
      console.error("Gagal mengirim email pemulihan kata sandi:", error.message);
      return sendError(res, 502, "Email reset gagal dikirim. Periksa konfigurasi Resend dan coba lagi.");
    }
  }
  sendJson(res, 202, { message: "Jika email terdaftar, tautan pengaturan ulang akan dikirim." });
}

async function resetPassword(client, req, res) {
  if (!hasValidOrigin(req)) return sendError(res, 403, "Asal request tidak diizinkan.");
  const address = getClientAddress(req);
  if (await isRateLimited(client, "customer-reset-confirm", address)) return sendError(res, 429, "Terlalu banyak percobaan. Coba lagi nanti.");
  await recordRateAttempt(client, "customer-reset-confirm", address);
  const payload = await readJson(req);
  if (typeof payload.token !== "string" || !validatePassword(payload.password)) {
    return sendError(res, 400, `Tautan atau kata sandi tidak valid. Kata sandi harus ${PASSWORD_MIN_LENGTH}–128 karakter.`);
  }
  const tokenHash = sessionTokenHash(payload.token);
  const current = nowMs();
  const passwordHash = await hashPassword(payload.password);
  const transaction = await client.transaction("write");
  try {
    const resetResult = await transaction.execute({
      sql: `SELECT token_hash, customer_id FROM password_reset_tokens
            WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
      args: [tokenHash, current],
    });
    const reset = resetResult.rows[0];
    if (!reset) {
      await transaction.rollback();
      return sendError(res, 400, "Tautan pengaturan ulang tidak valid atau sudah kedaluwarsa.");
    }
    await transaction.execute({
      sql: "UPDATE customers SET password_hash = ? WHERE id = ?",
      args: [passwordHash, reset.customer_id],
    });
    await transaction.execute({
      sql: "UPDATE password_reset_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL",
      args: [current, reset.token_hash],
    });
    const customer = await transaction.execute("SELECT member_id FROM customers WHERE id = ?", [reset.customer_id]);
    await transaction.execute("DELETE FROM auth_sessions WHERE member_id = ? AND role = 'customer'", [customer.rows[0].member_id]);
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
  sendJson(res, 200, { message: "Kata sandi berhasil diperbarui. Silakan masuk." });
}

async function loginAdmin(client, req, res) {
  if (!hasValidOrigin(req)) return sendError(res, 403, "Asal request tidak diizinkan.");
  const username = process.env.ADMIN_USERNAME || "admin";
  const password = process.env.ADMIN_PASSWORD || "";
  if (password.length < ADMIN_PASSWORD_MIN_LENGTH) return sendError(res, 503, `Atur ADMIN_PASSWORD minimal ${ADMIN_PASSWORD_MIN_LENGTH} karakter sebelum login admin.`);
  const address = getClientAddress(req);
  if (await isRateLimited(client, "admin-login", address)) return sendError(res, 429, "Terlalu banyak percobaan masuk. Coba lagi dalam 5 menit.");
  const payload = await readJson(req);
  if (typeof payload.username !== "string" || typeof payload.password !== "string") return sendError(res, 400, "Username dan kata sandi wajib diisi.");
  const supplied = Buffer.from(payload.username);
  const expected = Buffer.from(username);
  const validUsername = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  const suppliedPassword = Buffer.from(payload.password);
  const expectedPassword = Buffer.from(password);
  const validPassword = suppliedPassword.length === expectedPassword.length && crypto.timingSafeEqual(suppliedPassword, expectedPassword);
  if (!validUsername || !validPassword) {
    await recordRateAttempt(client, "admin-login", address);
    return sendError(res, 401, "Username atau kata sandi salah.");
  }
  await clearRateLimit(client, "admin-login", address);
  const token = await createSession(client, "admin", { username });
  sendJson(res, 200, { authenticated: true, username }, { "Set-Cookie": sessionCookie(token, "admin") });
}

async function logout(client, req, res, role) {
  if (!hasValidOrigin(req)) return sendError(res, 403, "Asal request tidak diizinkan.");
  const name = role === "admin" ? "mont_admin" : "mont_customer";
  const token = parseCookies(req.headers.cookie)[name];
  if (token) {
    await client.execute("DELETE FROM auth_sessions WHERE token_hash = ? AND role = ?", [sessionTokenHash(token), role]);
  }
  sendJson(res, 200, { ok: true }, { "Set-Cookie": sessionCookie("", role, 0) });
}

async function handleAdminGet(client, req, res, pathname, query) {
  if (pathname === "/api/admin/promos") return sendJson(res, 200, await listPromos(client, false));
  if (pathname === "/api/admin/customers") return sendJson(res, 200, await customerSearch(client, query.get("q")));
  if (pathname === "/api/admin/claim-customers") {
    return sendJson(res, 200, await claimCustomerLookup(client, query.get("q")));
  }
  if (pathname === "/api/admin/customers.csv") return sendCustomerCsv(client, res, query.get("q"));
  if (pathname === "/api/admin/tiers") return sendJson(res, 200, await listTiers(client));
  if (pathname === "/api/admin/rewards") return sendJson(res, 200, await listRewards(client));
  if (pathname === "/api/admin/points/transactions") {
    const transactions = await client.execute(
      `SELECT customers.name AS customer_name, ledger.type, ledger.points_delta,
              ledger.description, ledger.created_at
       FROM loyalty_transactions AS ledger
       LEFT JOIN customers ON customers.member_id = ledger.member_id
       ORDER BY ledger.id DESC LIMIT 200`,
    );
    return sendJson(res, 200, transactions.rows);
  }
  if (pathname === "/api/admin/claims") {
    const claims = await client.execute(
      `SELECT id, promo_id, promo_title, customer_name, claimed_at
       FROM promo_claims ORDER BY claimed_at DESC LIMIT 500`,
    );
    return sendJson(res, 200, claims.rows);
  }
  if (pathname === "/api/admin/analytics") return sendJson(res, 200, await getAnalytics(client));
  return sendError(res, 404, "Endpoint tidak ditemukan.");
}

async function handleAdminPost(client, req, res, pathname) {
  const payload = await readJson(req);
  if (pathname === "/api/admin/tiers/settings") {
    return sendJson(res, 200, await saveTierSettings(client, payload));
  }
  if (pathname === "/api/admin/spend/record" || pathname === "/api/admin/spend/baseline") {
    const memberId = typeof payload.member_id === "string" ? payload.member_id.trim() : "";
    const baseline = pathname.endsWith("/baseline");
    const amount = payload.amount;
    const description = typeof payload.description === "string" ? payload.description.trim() : "";
    if (!memberId || !Number.isSafeInteger(amount) || amount < (baseline ? 0 : 1)
      || amount > 1_000_000_000_000 || description.length > 200) {
      return sendError(res, 400, "Pelanggan, nominal, atau keterangan transaksi tidak valid.");
    }
    const result = await recordSpend(
      client,
      memberId,
      amount,
      description || (baseline ? "Penetapan total transaksi historis" : "Transaksi belanja"),
      baseline ? "baseline" : "purchase",
      baseline,
    );
    return sendJson(res, 201, { member_id: memberId, ...result });
  }
  if (pathname === "/api/admin/rewards") {
    const saved = await saveReward(client, payload);
    return sendJson(res, saved.status, saved.reward);
  }
  if (pathname === "/api/admin/rewards/redeem") {
    const memberId = typeof payload.member_id === "string" ? payload.member_id.trim() : "";
    const rewardId = payload.reward_id;
    if (!memberId || !Number.isSafeInteger(rewardId) || rewardId < 1) {
      return sendError(res, 400, "Pelanggan dan reward wajib dipilih.");
    }
    const result = await client.execute(
      "SELECT id, name, points_cost FROM loyalty_rewards WHERE id = ? AND active = 1",
      [rewardId],
    );
    const reward = result.rows[0];
    if (!reward) return sendError(res, 404, "Reward tidak aktif atau tidak ditemukan.");
    const balance = await recordPointsTransaction(
      client,
      memberId,
      -Number(reward.points_cost),
      "redemption",
      `Penukaran reward: ${reward.name}`,
      { rewardId },
    );
    return sendJson(res, 201, { reward_id: rewardId, member_id: memberId, points_spent: Number(reward.points_cost), points_balance: balance });
  }
  if (pathname === "/api/admin/points/adjust") {
    const memberId = typeof payload.member_id === "string" ? payload.member_id.trim() : "";
    const points = payload.points;
    const action = payload.action;
    const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
    if (!memberId || !Number.isSafeInteger(points) || points < 1 || points > 1_000_000
      || !["add", "deduct"].includes(action) || !reason || reason.length > 200) {
      return sendError(res, 400, "Pelanggan, jumlah poin, tindakan, dan alasan yang valid wajib diisi.");
    }
    const delta = action === "add" ? points : -points;
    const balance = await recordPointsTransaction(
      client,
      memberId,
      delta,
      "adjustment",
      `Penyesuaian admin: ${reason}`,
    );
    return sendJson(res, 201, { member_id: memberId, points_delta: delta, points_balance: balance });
  }
  if (pathname === "/api/admin/promos") {
    const saved = await savePromo(client, payload);
    return sendJson(res, saved.status, saved.promo);
  }
  if (pathname === "/api/admin/claims") {
    const memberId = typeof payload.member_id === "string" ? payload.member_id.trim() : "";
    const promoId = payload.promo_id;
    if (!memberId || !Number.isInteger(promoId) || promoId <= 0) return sendError(res, 400, "Pelanggan dan promo wajib dipilih.");
    const customerResult = await client.execute("SELECT member_id, name FROM customers WHERE member_id = ?", [memberId]);
    const customer = customerResult.rows[0];
    if (!customer) return sendError(res, 404, "Pelanggan tidak ditemukan.");
    const today = new Date().toISOString().slice(0, 10);
    const promoResult = await client.execute({
      sql: `SELECT id, title FROM promos WHERE id = ? AND active = 1
            AND (starts_on IS NULL OR starts_on = '' OR starts_on <= ?)
            AND (ends_on IS NULL OR ends_on = '' OR ends_on >= ?)`,
      args: [promoId, today, today],
    });
    const promo = promoResult.rows[0];
    if (!promo) return sendError(res, 400, "Promo tidak aktif atau di luar masa berlaku.");
    const claimedAt = nowMs();
    const statements = [{
        sql: `INSERT INTO promo_claims
              (promo_id, promo_title, member_id, customer_name, claimed_at)
              VALUES (?, ?, ?, ?, ?) RETURNING id`,
        args: [promo.id, promo.title, customer.member_id, customer.name, claimedAt],
      }];
    const results = await client.batch(statements, "write");
    return sendJson(res, 201, {
      id: results[0].rows[0].id,
      promo_id: promo.id,
      promo_title: promo.title,
      member_id: customer.member_id,
      customer_name: customer.name,
      claimed_at: claimedAt,
    });
  }
  return sendError(res, 404, "Endpoint tidak ditemukan.");
}

async function handleApi(client, req, res) {
  let parsed;
  try {
    parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch {
    return sendError(res, 400, "Alamat request tidak valid.");
  }
  const pathname = parsed.pathname;
  const method = req.method;
  const query = parsed.searchParams;

  if (method === "GET" && pathname === "/api/health") {
    await client.execute("SELECT 1");
    return sendJson(res, 200, { status: "ok" });
  }
  if (method === "GET" && pathname === "/api/promos") return sendJson(res, 200, await listPromos(client, true));
  if (method === "GET" && pathname === "/api/admin/session") {
    const session = await getSession(client, req, "admin");
    return sendJson(res, 200, { authenticated: Boolean(session), username: session?.username || null });
  }
  if (method === "GET" && pathname === "/api/customer/session") {
    const session = await getSession(client, req, "customer");
    return sendJson(res, 200, {
      authenticated: Boolean(session),
      customer: session ? await createCustomerSessionPayload(client, session) : null,
    });
  }
  if (method === "GET" && pathname === "/api/customer/loyalty") {
    const session = await requireSession(client, req, res, "customer");
    if (!session) return;
    return sendJson(res, 200, await getCustomerLoyalty(client, session.member_id));
  }
  if (method === "POST" && pathname.startsWith("/api/admin/")) {
    if (pathname === "/api/admin/login") return loginAdmin(client, req, res);
    if (pathname === "/api/admin/logout") return logout(client, req, res, "admin");
  }
  if (method === "POST" && pathname === "/api/customer/logout") return logout(client, req, res, "customer");
  if (method === "POST" && pathname === "/api/customers") return registerCustomer(client, req, res);
  if (method === "POST" && pathname === "/api/customer/login") return customerLogin(client, req, res);
  if (method === "POST" && pathname === "/api/customer/forgot-password") return forgotPassword(client, req, res);
  if (method === "POST" && pathname === "/api/customer/reset-password") return resetPassword(client, req, res);

  if (pathname.startsWith("/api/admin/")) {
    const methodIsAdminRead = method === "GET";
    const promoMatch = pathname.match(/^\/api\/admin\/promos\/(\d+)$/);
    const activeMatch = pathname.match(/^\/api\/admin\/promos\/(\d+)\/active$/);
    const rewardMatch = pathname.match(/^\/api\/admin\/rewards\/(\d+)$/);
    const rewardActiveMatch = pathname.match(/^\/api\/admin\/rewards\/(\d+)\/active$/);
    if (methodIsAdminRead) {
      const session = await requireSession(client, req, res, "admin");
      if (!session) return;
      return handleAdminGet(client, req, res, pathname, query);
    }
    if (method === "POST") {
      const session = await requireSession(client, req, res, "admin", true);
      if (!session) return;
      return handleAdminPost(client, req, res, pathname);
    }
    if (method === "PUT" && promoMatch) {
      const session = await requireSession(client, req, res, "admin", true);
      if (!session) return;
      const result = await savePromo(client, await readJson(req), Number(promoMatch[1]));
      return sendJson(res, result.status, result.promo);
    }
    if (method === "PUT" && rewardMatch) {
      const session = await requireSession(client, req, res, "admin", true);
      if (!session) return;
      const result = await saveReward(client, await readJson(req), Number(rewardMatch[1]));
      return sendJson(res, result.status, result.reward);
    }
    if (method === "PATCH" && activeMatch) {
      const session = await requireSession(client, req, res, "admin", true);
      if (!session) return;
      const payload = await readJson(req);
      if (typeof payload.active !== "boolean") return sendError(res, 400, "Status promo tidak valid.");
      const result = await client.execute("UPDATE promos SET active = ? WHERE id = ?", [Number(payload.active), Number(activeMatch[1])]);
      if (Number(result.rowsAffected) === 0) return sendError(res, 404, "Promo tidak ditemukan.");
      return sendJson(res, 200, { ok: true });
    }
    if (method === "PATCH" && rewardActiveMatch) {
      const session = await requireSession(client, req, res, "admin", true);
      if (!session) return;
      const payload = await readJson(req);
      if (typeof payload.active !== "boolean") return sendError(res, 400, "Status reward tidak valid.");
      const result = await client.execute(
        "UPDATE loyalty_rewards SET active = ? WHERE id = ?",
        [Number(payload.active), Number(rewardActiveMatch[1])],
      );
      if (Number(result.rowsAffected) === 0) return sendError(res, 404, "Reward tidak ditemukan.");
      return sendJson(res, 200, { ok: true });
    }
    if (method === "DELETE" && promoMatch) {
      const session = await requireSession(client, req, res, "admin", true);
      if (!session) return;
      const result = await client.execute("DELETE FROM promos WHERE id = ?", [Number(promoMatch[1])]);
      if (Number(result.rowsAffected) === 0) return sendError(res, 404, "Promo tidak ditemukan.");
      return sendJson(res, 200, { ok: true });
    }
    if (method === "DELETE" && rewardMatch) {
      const session = await requireSession(client, req, res, "admin", true);
      if (!session) return;
      const result = await client.execute("DELETE FROM loyalty_rewards WHERE id = ?", [Number(rewardMatch[1])]);
      if (Number(result.rowsAffected) === 0) return sendError(res, 404, "Reward tidak ditemukan.");
      return sendJson(res, 200, { ok: true });
    }
  }
  return sendError(res, 404, "Endpoint tidak ditemukan.");
}

function decodeStaticPath(pathname) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

function serveStatic(req, res) {
  const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  let relative = decodeStaticPath(parsed.pathname);
  if (relative === null) return sendError(res, 400, "Alamat file tidak valid.");
  if (relative === "/") relative = "/index.html";
  if (relative.endsWith("/")) relative += "index.html";
  const fileName = relative.replace(/^\/+/, "");
  if (!PUBLIC_STATIC_FILES.has(fileName)) return sendError(res, 404, "File tidak ditemukan.");
  const filePath = path.join(PUBLIC_DIR, fileName);
  if (!fs.existsSync(filePath)) return sendError(res, 404, "File tidak ditemukan.");
  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": CONTENT_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
    "Content-Length": body.length,
    "Cache-Control": "no-cache",
    ...SECURE_HEADERS,
    ...(process.env.NODE_ENV === "production" ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" } : {}),
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

function createHandler(client, options = {}) {
  let initialized;
  return async function handler(req, res) {
    setSecurityHeaders(res);
    try {
      if (!initialized) initialized = initializeDatabase(client);
      await initialized;
      let url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (options.vercelPathQueryParameter && url.pathname === "/api/index") {
        const vercelPath = url.searchParams.get(options.vercelPathQueryParameter);
        if (vercelPath !== null) {
          url.searchParams.delete(options.vercelPathQueryParameter);
          const routePath = `/api/${vercelPath.replace(/^\/+/, "")}`;
          req.url = `${routePath}${url.search}`;
          url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
        }
      }
      if (url.pathname.startsWith("/api/")) {
        await handleApi(client, req, res);
      } else if (options.allowStatic) {
        if (req.method !== "GET" && req.method !== "HEAD") return sendError(res, 405, "Metode request tidak diizinkan.");
        serveStatic(req, res);
      } else {
        sendError(res, 404, "Endpoint tidak ditemukan.");
      }
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      if (error.status) return sendError(res, error.status, error.message);
      console.error("Kesalahan backend MONT:", error.message);
      sendError(res, 500, "Permintaan gagal diproses.");
    }
  };
}

function createLocalServer(options = {}) {
  const client = options.client || createDatabaseClient(options);
  const handler = createHandler(client, { allowStatic: true });
  const server = http.createServer(handler);
  server.montClient = client;
  server.on("close", () => client.close());
  return server;
}

async function main() {
  const port = Number(process.env.PORT || 8000);
  const server = createLocalServer();
  try {
    await initializeDatabase(server.montClient);
  } catch (error) {
    console.error("Database MONT gagal dibuka:", error.message);
    server.close();
    process.exitCode = 1;
    return;
  }
  server.listen(port, process.env.HOST || "0.0.0.0", () => {
    console.log(`MONT Node.js berjalan pada port ${port}`);
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Server MONT gagal dijalankan:", error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  createDatabaseClient,
  createHandler,
  createLocalServer,
  hashPassword,
  initializeDatabase,
  sessionTokenHash,
  verifyPassword,
};
