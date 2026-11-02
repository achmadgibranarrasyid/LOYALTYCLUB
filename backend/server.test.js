"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { createDatabaseClient, createHandler, generateMemberQr, hashPassword, initializeDatabase, verifyPassword } = require("./server");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function close(server, client) {
  return new Promise((resolve, reject) => {
    server.close(async (error) => {
      try {
        await client.close();
        if (error) reject(error);
        else resolve();
      } catch (closeError) {
        reject(closeError);
      }
    });
  });
}

test("API, QR membership, admin claims, and static-file allowlist work", async (t) => {
  const client = createDatabaseClient({ databaseUrl: "file::memory:" });
  await initializeDatabase(client);
  const app = http.createServer(createHandler(client, {
    allowStatic: true,
    vercelPathQueryParameter: "__vercel_path",
  }));
  const origin = await listen(app);
  const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    ADMIN_USERNAME: process.env.ADMIN_USERNAME,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
  };
  process.env.NODE_ENV = "test";
  process.env.ADMIN_USERNAME = "test-admin";
  process.env.ADMIN_PASSWORD = "Test-admin-password-2026";
  t.after(async () => {
    Object.entries(originalEnv).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
    await close(app, client);
  });

  const request = async (route, { method = "GET", payload, cookie, originHeader = origin } = {}) => {
    const headers = {};
    if (originHeader) headers.Origin = originHeader;
    if (cookie) headers.Cookie = cookie;
    if (payload !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${origin}${route}`, {
      method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const contentType = response.headers.get("content-type") || "";
    const body = contentType.includes("application/json")
      ? await response.json()
      : contentType.includes("image/png")
        ? Buffer.from(await response.arrayBuffer())
        : await response.text();
    return { response, body };
  };

  const health = await request("/api/health");
  assert.equal(health.response.status, 200);
  assert.deepEqual(health.body, { status: "ok" });

  const home = await request("/");
  assert.equal(home.response.status, 200);
  assert.match(home.response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  const blocked = await request("/backend/server.js");
  assert.equal(blocked.response.status, 404);
  const privateFiles = await Promise.all([
    request("/README.md"),
    request("/.env.example"),
    request("/api/[...path].js"),
  ]);
  privateFiles.forEach(({ response }) => assert.equal(response.status, 404));

  const noOrigin = await request("/api/customers", {
    method: "POST",
    originHeader: null,
    payload: {},
  });
  assert.equal(noOrigin.response.status, 403);
  const unauthenticatedAdmin = await request("/api/admin/customers");
  assert.equal(unauthenticatedAdmin.response.status, 401);

  const rewrittenAdminSession = await request("/api/index?__vercel_path=admin/session");
  assert.equal(rewrittenAdminSession.response.status, 200);
  assert.deepEqual(rewrittenAdminSession.body, { authenticated: false, username: null });

  const registration = await request("/api/customers", {
    method: "POST",
    payload: {
      name: "Node Customer",
      email: "node-customer@example.invalid",
      phone: "08123456789",
      password: "Customer-password-2026",
      consent: true,
    },
  });
  assert.equal(registration.response.status, 201);
  assert.match(registration.body.id, /^BC-[A-F0-9]{16}$/);
  const customerCookie = registration.response.headers.get("set-cookie").split(";", 1)[0];
  assert.match(registration.response.headers.get("set-cookie"), /HttpOnly/);

  const qr = await request("/api/customer/qr", { cookie: customerCookie });
  assert.equal(qr.response.status, 200);
  assert.equal(qr.response.headers.get("content-type"), "image/png");
  assert.equal(qr.response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(qr.body.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const storedQr = await client.execute({
    sql: "SELECT qr_code FROM customers WHERE member_id = ?",
    args: [registration.body.id],
  });
  assert.deepEqual(Buffer.from(storedQr.rows[0].qr_code), qr.body);

  const login = await request("/api/customer/login", {
    method: "POST",
    payload: { email: "NODE-CUSTOMER@example.invalid", password: "Customer-password-2026" },
  });
  assert.equal(login.response.status, 200);
  assert.equal(login.body.id, registration.body.id);
  const duplicate = await request("/api/customers", {
    method: "POST",
    payload: {
      name: "Duplicate",
      email: "NODE-CUSTOMER@example.invalid",
      phone: "08123456789",
      password: "Customer-password-2026",
      consent: true,
    },
  });
  assert.equal(duplicate.response.status, 409);

  const adminLogin = await request("/api/admin/login", {
    method: "POST",
    payload: { username: "test-admin", password: "Test-admin-password-2026" },
  });
  assert.equal(adminLogin.response.status, 200);
  const adminCookie = adminLogin.response.headers.get("set-cookie").split(";", 1)[0];
  const adminCustomers = await request("/api/admin/customers?q=node-customer", { cookie: adminCookie });
  assert.equal(adminCustomers.response.status, 200);
  assert.equal(adminCustomers.body.length, 1);

  const today = new Date().toISOString().slice(0, 10);
  const promoCreate = await request("/api/admin/promos", {
    method: "POST",
    cookie: adminCookie,
    payload: {
      category: "diskon",
      label: "TEST 10%",
      title: "Node Test Promo",
      description: "Promo integration test.",
      price_old: "",
      price_new: "",
      starts_on: today,
      ends_on: today,
    },
  });
  assert.equal(promoCreate.response.status, 201);
  const claim = await request("/api/admin/claims", {
    method: "POST",
    cookie: adminCookie,
    payload: { member_id: registration.body.id, promo_id: Number(promoCreate.body.id) },
  });
  assert.equal(claim.response.status, 201);
  assert.equal(claim.body.member_id, registration.body.id);
  const analytics = await request("/api/admin/analytics", { cookie: adminCookie });
  assert.equal(analytics.response.status, 200);
  assert.equal(analytics.body.total_claims, 1);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const failedLogin = await request("/api/admin/login", {
      method: "POST",
      payload: { username: "test-admin", password: "Wrong-password-2026" },
    });
    assert.equal(failedLogin.response.status, 401);
  }
  const rateLimited = await request("/api/admin/login", {
    method: "POST",
    payload: { username: "test-admin", password: "Wrong-password-2026" },
  });
  assert.equal(rateLimited.response.status, 429);
});

test("scrypt hashes remain compatible and malformed hashes fail closed", async () => {
  const legacyPythonHash = "scrypt$32768$00112233445566778899aabbccddeeff$4b52bafafcf4d3e3f7e918c49344bbe16b934fc2018d05d73ee7df63a3b7f4bb14a47bd5f8679d3d6695d626d5b611414bf5e8ffdb9ab111be0924915d1bcae3";
  assert.equal(await verifyPassword("legacy-password-2026", legacyPythonHash), true);
  const password = "legacy-password-2026";
  const encoded = await hashPassword(password);
  assert.equal(await verifyPassword(password, encoded), true);
  assert.equal(await verifyPassword("wrong-password", encoded), false);
  assert.equal(await verifyPassword(password, "scrypt$999999$bad$hash"), false);
});

test("QR generator produces a PNG", async () => {
  const png = await generateMemberQr("BC-0123456789ABCDEF");
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
});

test("Vercel requires persistent Turso credentials", () => {
  assert.throws(
    () => createDatabaseClient({ env: { VERCEL: "1" } }),
    /TURSO_DATABASE_URL dan TURSO_AUTH_TOKEN wajib diatur di Vercel/,
  );
  assert.throws(
    () => createDatabaseClient({ databaseUrl: "libsql://db.example", env: {} }),
    /TURSO_AUTH_TOKEN wajib untuk database Turso jarak jauh/,
  );
});

test("password reset only reports success after the email provider accepts the message", async (t) => {
  const client = createDatabaseClient({ databaseUrl: "file::memory:" });
  await initializeDatabase(client);
  const customer = await client.execute({
    sql: `INSERT INTO customers (member_id, name, email, phone, joined)
          VALUES (?, ?, ?, ?, ?) RETURNING id`,
    args: ["BC-RESET-EMAIL", "Reset Email", "reset-email@example.invalid", "08123456789", Date.now()],
  });
  const app = http.createServer(createHandler(client));
  const origin = await listen(app);
  const originalEnv = {
    BASE_URL: process.env.BASE_URL,
    EMAIL_FROM: process.env.EMAIL_FROM,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
  };
  const originalFetch = globalThis.fetch;
  process.env.BASE_URL = origin;
  process.env.EMAIL_FROM = "BrewClub <verified@example.com>";
  process.env.RESEND_API_KEY = "test-resend-key";
  t.after(async () => {
    globalThis.fetch = originalFetch;
    Object.entries(originalEnv).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
    await close(app, client);
  });

  let providerStatus = 200;
  let deliveredEmail;
  globalThis.fetch = async (url, options) => {
    if (url !== "https://api.resend.com/emails") return originalFetch(url, options);
    deliveredEmail = JSON.parse(options.body);
    return new Response(providerStatus === 200 ? '{"id":"email-test"}' : '{"message":"domain not verified"}', {
      status: providerStatus,
      headers: { "Content-Type": "application/json" },
    });
  };
  const request = () => originalFetch(`${origin}/api/customer/forgot-password`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "reset-email@example.invalid" }),
  });

  const success = await request();
  assert.equal(success.status, 202);
  assert.equal(deliveredEmail.to[0], "reset-email@example.invalid");
  assert.match(deliveredEmail.text, /reset-password\.html#token=/);
  const savedToken = await client.execute("SELECT token_hash FROM password_reset_tokens");
  assert.equal(savedToken.rows.length, 1);

  providerStatus = 403;
  const failure = await request();
  assert.equal(failure.status, 502);
  assert.match((await failure.json()).error, /Periksa konfigurasi Resend/);
  const clearedToken = await client.execute("SELECT COUNT(*) AS count FROM password_reset_tokens");
  assert.equal(Number(clearedToken.rows[0].count), 1);
  const remainingToken = await client.execute("SELECT token_hash FROM password_reset_tokens");
  assert.equal(remainingToken.rows[0].token_hash, savedToken.rows[0].token_hash);
});

test("legacy SQLite customer and promo tables are migrated without losing member data", async () => {
  const client = createDatabaseClient({ databaseUrl: "file::memory:" });
  try {
    await client.batch([
      `CREATE TABLE customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        email TEXT NOT NULL COLLATE NOCASE UNIQUE,
        phone TEXT NOT NULL,
        joined INTEGER NOT NULL
      )`,
      `CREATE TABLE promos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        label TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        price_old TEXT NOT NULL DEFAULT '',
        price_new TEXT NOT NULL DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1
      )`,
      "INSERT INTO customers (member_id, name, email, phone, joined) VALUES ('BC-LEGACY', 'Legacy Member', 'legacy@example.invalid', '08123456789', 1762063200000)",
    ], "write");
    await initializeDatabase(client);
    await initializeDatabase(client);

    const migrated = await client.execute("SELECT member_id, name, qr_code FROM customers WHERE member_id = 'BC-LEGACY'");
    assert.equal(migrated.rows[0].name, "Legacy Member");
    assert.deepEqual(Buffer.from(migrated.rows[0].qr_code).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const promos = await client.execute("SELECT COUNT(*) AS count FROM promos");
    assert.equal(Number(promos.rows[0].count), 6);
  } finally {
    await client.close();
  }
});
