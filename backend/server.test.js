"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { createDatabaseClient, createHandler, hashPassword, initializeDatabase, verifyPassword } = require("./server");

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

test("API, manual loyalty, admin tiers and claims, and static-file allowlist work", async (t) => {
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
    const body = contentType.includes("application/json") ? await response.json() : await response.text();
    return { response, body };
  };

  const health = await request("/api/health");
  assert.equal(health.response.status, 200);
  assert.deepEqual(health.body, { status: "ok" });

  const home = await request("/");
  assert.equal(home.response.status, 200);
  assert.match(home.response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.doesNotMatch(home.body, /QR Code|QR MEMBER/i);
  assert.match(home.body, /src="MONT%20NEON%20BOX\.png"/);
  const logo = await fetch(`${origin}/MONT%20NEON%20BOX.png`);
  assert.equal(logo.status, 200);
  assert.equal(logo.headers.get("content-type"), "image/png");
  assert.deepEqual(
    [...new Uint8Array(await logo.arrayBuffer()).slice(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
  );
  const adminPage = await request("/admin.html");
  assert.equal(adminPage.response.status, 200);
  assert.match(adminPage.body, /src="MONT%20NEON%20BOX\.png"/);
  assert.match(adminPage.body, /id="tierSettingsForm"/);
  assert.match(adminPage.body, /id="spendBaselineForm"/);
  assert.doesNotMatch(adminPage.body, /id="tierName"|id="tierId"/);
  const memberAccount = await request("/akun.html");
  assert.equal(memberAccount.response.status, 200);
  assert.match(memberAccount.body, /src="MONT%20NEON%20BOX\.png"/);
  assert.match(memberAccount.body, /id="mEmail"/);
  assert.match(memberAccount.body, /id="mPhone"/);
  assert.doesNotMatch(memberAccount.body, /QR Code|qrCodeImage/i);
  const legacyMemberPage = await request("/pengguna.html");
  assert.equal(legacyMemberPage.response.status, 200);
  assert.match(legacyMemberPage.body, /url=akun\.html/);
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
  const unauthenticatedSpend = await request("/api/admin/spend/record", {
    method: "POST",
    payload: { member_id: "BC-UNKNOWN", amount: 1000 },
  });
  assert.equal(unauthenticatedSpend.response.status, 401);

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
  assert.equal(registration.body.email, "node-customer@example.invalid");
  assert.equal(registration.body.phone, "08123456789");
  const customerCookie = registration.response.headers.get("set-cookie").split(";", 1)[0];
  assert.match(registration.response.headers.get("set-cookie"), /HttpOnly/);

  const removedQr = await request("/api/customer/qr", { cookie: customerCookie });
  assert.equal(removedQr.response.status, 404);
  const customerColumns = await client.execute("PRAGMA table_info(customers)");
  assert.equal(customerColumns.rows.some(column => column.name === "qr_code"), false);

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
  assert.equal(adminCustomers.body[0].name, "Node Customer");
  assert.equal("tier_name" in adminCustomers.body[0], true);
  const customerCsv = await request("/api/admin/customers.csv", { cookie: adminCookie });
  assert.match(customerCsv.body, /"Nama","Email","WhatsApp","Bergabung","Total transaksi","Poin","Tier"/);
  assert.doesNotMatch(customerCsv.body, /ID Member/);
  const unauthenticatedClaimLookup = await request("/api/admin/claim-customers?q=08123456789");
  assert.equal(unauthenticatedClaimLookup.response.status, 401);
  const claimLookupByPhone = await request("/api/admin/claim-customers?q=08123456789", { cookie: adminCookie });
  assert.equal(claimLookupByPhone.response.status, 200);
  assert.deepEqual(claimLookupByPhone.body, [{
    member_id: registration.body.id,
    name: "Node Customer",
    email: "node-customer@example.invalid",
    phone: "08123456789",
  }]);
  const claimLookupByEmail = await request("/api/admin/claim-customers?q=node-customer@example.invalid", { cookie: adminCookie });
  assert.equal(claimLookupByEmail.body[0].email, "node-customer@example.invalid");
  const claimLookupByName = await request("/api/admin/claim-customers?q=Node Customer", { cookie: adminCookie });
  assert.equal(claimLookupByName.response.status, 200);
  assert.equal(claimLookupByName.body[0].name, "Node Customer");
  const tooShortClaimLookup = await request("/api/admin/claim-customers?q=N", { cookie: adminCookie });
  assert.deepEqual(tooShortClaimLookup.body, []);
  const privateLoyalty = await request("/api/customer/loyalty");
  assert.equal(privateLoyalty.response.status, 401);
  const emptyLoyalty = await request("/api/customer/loyalty", { cookie: customerCookie });
  assert.equal(emptyLoyalty.response.status, 200);
  assert.equal(emptyLoyalty.body.points_balance, 0);
  assert.equal(emptyLoyalty.body.total_spend, 0);
  assert.equal(emptyLoyalty.body.tier.name, "Bronze");
  assert.equal(emptyLoyalty.body.next_tier.name, "Silver");

  const automatedPoints = await request("/api/admin/points/earn", {
    method: "POST",
    cookie: adminCookie,
    payload: { member_id: registration.body.id, amount: 100000 },
  });
  assert.equal(automatedPoints.response.status, 404);
  const manualPoints = await request("/api/admin/points/adjust", {
    method: "POST",
    cookie: adminCookie,
    payload: { member_id: registration.body.id, action: "add", points: 13, reason: "Kompensasi uji" },
  });
  assert.equal(manualPoints.response.status, 201);
  assert.equal(manualPoints.body.points_balance, 13);

  const tierList = await request("/api/admin/tiers", { cookie: adminCookie });
  assert.deepEqual(tierList.body.map(tier => [tier.name, Number(tier.min_spend)]), [
    ["Bronze", 0],
    ["Silver", 1_000_000],
    ["Gold", 5_000_000],
  ]);
  const invalidTierSettings = await request("/api/admin/tiers/settings", {
    method: "POST",
    cookie: adminCookie,
    payload: { silver_min_spend: 300_000, gold_min_spend: 300_000 },
  });
  assert.equal(invalidTierSettings.response.status, 400);
  const tierSettings = await request("/api/admin/tiers/settings", {
    method: "POST",
    cookie: adminCookie,
    payload: { silver_min_spend: 100_000, gold_min_spend: 300_000 },
  });
  assert.equal(tierSettings.response.status, 200);
  assert.deepEqual(tierSettings.body.map(tier => [tier.name, Number(tier.min_spend)]), [
    ["Bronze", 0],
    ["Silver", 100_000],
    ["Gold", 300_000],
  ]);
  const baseline = await request("/api/admin/spend/baseline", {
    method: "POST",
    cookie: adminCookie,
    payload: { member_id: registration.body.id, amount: 150_000 },
  });
  assert.equal(baseline.response.status, 201);
  assert.equal(baseline.body.total_spend, 150_000);
  assert.equal(baseline.body.tier, "Silver");
  const customerSession = await request("/api/customer/session", { cookie: customerCookie });
  assert.equal(customerSession.body.customer.tier_name, "Silver");
  assert.equal(customerSession.body.customer.total_spend, 150_000);
  const spend = await request("/api/admin/spend/record", {
    method: "POST",
    cookie: adminCookie,
    payload: { member_id: registration.body.id, amount: 200_000, description: "Pembelian uji" },
  });
  assert.equal(spend.response.status, 201);
  assert.equal(spend.body.total_spend, 350_000);
  assert.equal(spend.body.tier, "Gold");
  const customerLoyalty = await request("/api/customer/loyalty", { cookie: customerCookie });
  assert.equal(customerLoyalty.body.total_spend, 350_000);
  assert.equal(customerLoyalty.body.tier.name, "Gold");
  assert.equal(customerLoyalty.body.next_tier, null);
  const lowerBaseline = await request("/api/admin/spend/baseline", {
    method: "POST",
    cookie: adminCookie,
    payload: { member_id: registration.body.id, amount: 50_000 },
  });
  assert.equal(lowerBaseline.body.tier, "Bronze");
  const manualTierAssignment = await request("/api/admin/customers/tier", {
    method: "POST",
    cookie: adminCookie,
    payload: { member_id: registration.body.id, tier_id: null },
  });
  assert.equal(manualTierAssignment.response.status, 404);
  assert.equal((await request("/api/admin/customers", { cookie: adminCookie })).body[0].total_spend, 50_000);

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
  assert.equal(Object.hasOwn(claim.body, "points_awarded"), false);
  assert.equal((await request("/api/customer/loyalty", { cookie: customerCookie })).body.points_balance, 13);

  const rewards = [];
  for (const payload of [
    { name: "Minuman Gratis", type: "free_drink", description: "Pilih menu reguler", points_cost: 4 },
    { name: "Diskon Rp10.000", type: "discount", points_cost: 4, discount_amount: 10000 },
    { name: "Merchandise", type: "custom", description: "Tumbler BrewClub", points_cost: 5 },
  ]) {
    rewards.push(await request("/api/admin/rewards", {
      method: "POST",
      cookie: adminCookie,
      payload,
    }));
  }
  rewards.forEach(({ response }) => assert.equal(response.status, 201));
  const updatedReward = await request(`/api/admin/rewards/${rewards[2].body.id}`, {
    method: "PUT",
    cookie: adminCookie,
    payload: { name: "Merchandise BrewClub", type: "custom", description: "Tumbler edisi baru", points_cost: 5 },
  });
  assert.equal(updatedReward.response.status, 200);
  const disabledReward = await request(`/api/admin/rewards/${rewards[2].body.id}/active`, {
    method: "PATCH",
    cookie: adminCookie,
    payload: { active: false },
  });
  assert.equal(disabledReward.response.status, 200);
  assert.equal((await request("/api/customer/loyalty", { cookie: customerCookie })).body.rewards.length, 2);
  const enabledReward = await request(`/api/admin/rewards/${rewards[2].body.id}/active`, {
    method: "PATCH",
    cookie: adminCookie,
    payload: { active: true },
  });
  assert.equal(enabledReward.response.status, 200);
  const loyalty = await request("/api/customer/loyalty", { cookie: customerCookie });
  assert.equal(loyalty.body.points_balance, 13);
  assert.equal(loyalty.body.transactions.length, 1);
  assert.equal(loyalty.body.rewards.length, 3);
  const adminLedger = await request("/api/admin/points/transactions", { cookie: adminCookie });
  assert.equal(adminLedger.response.status, 200);
  assert.equal(adminLedger.body.length, 1);

  for (const reward of rewards) {
    const redemption = await request("/api/admin/rewards/redeem", {
      method: "POST",
      cookie: adminCookie,
      payload: { member_id: registration.body.id, reward_id: Number(reward.body.id) },
    });
    assert.equal(redemption.response.status, 201);
  }
  const exhaustedRedemption = await request("/api/admin/rewards/redeem", {
    method: "POST",
    cookie: adminCookie,
    payload: { member_id: registration.body.id, reward_id: Number(rewards[2].body.id) },
  });
  assert.equal(exhaustedRedemption.response.status, 400);
  assert.equal((await request("/api/customer/loyalty", { cookie: customerCookie })).body.points_balance, 0);

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
        joined INTEGER NOT NULL,
        qr_code BLOB
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

    const migrated = await client.execute("SELECT member_id, name, email, phone, points_balance, total_spend, tier_id FROM customers WHERE member_id = 'BC-LEGACY'");
    assert.equal(migrated.rows[0].name, "Legacy Member");
    assert.equal(migrated.rows[0].email, "legacy@example.invalid");
    assert.equal(migrated.rows[0].phone, "08123456789");
    assert.equal(Number(migrated.rows[0].points_balance), 0);
    assert.equal(Number(migrated.rows[0].total_spend), 0);
    assert.notEqual(migrated.rows[0].tier_id, null);
    const migratedColumns = await client.execute("PRAGMA table_info(customers)");
    assert.equal(migratedColumns.rows.some(column => column.name === "qr_code"), false);
    const promos = await client.execute("SELECT COUNT(*) AS count FROM promos");
    assert.equal(Number(promos.rows[0].count), 6);
  } finally {
    await client.close();
  }
});

test("legacy purchase amounts and tier thresholds migrate once", async () => {
  const client = createDatabaseClient({ databaseUrl: "file::memory:" });
  try {
    await client.batch([
      `CREATE TABLE customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        email TEXT NOT NULL COLLATE NOCASE UNIQUE,
        phone TEXT NOT NULL,
        joined INTEGER NOT NULL,
        points_balance INTEGER NOT NULL DEFAULT 0,
        tier_id INTEGER
      )`,
      `CREATE TABLE loyalty_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id TEXT NOT NULL,
        type TEXT NOT NULL,
        points_delta INTEGER NOT NULL,
        description TEXT NOT NULL,
        purchase_amount INTEGER,
        reward_id INTEGER,
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE loyalty_tiers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      )`,
      "INSERT INTO customers (member_id, name, email, phone, joined) VALUES ('BC-HISTORY', 'History Member', 'history@example.invalid', '08123456789', 1762063200000)",
      "INSERT INTO loyalty_transactions (member_id, type, points_delta, description, purchase_amount, created_at) VALUES ('BC-HISTORY', 'purchase', 0, 'Pembelian lama', 6000000, 1762063200000)",
    ], "write");
    await initializeDatabase(client);

    const migrated = await client.execute({
      sql: `SELECT customers.total_spend, loyalty_tiers.name AS tier_name
            FROM customers LEFT JOIN loyalty_tiers ON loyalty_tiers.id = customers.tier_id
            WHERE customers.member_id = 'BC-HISTORY'`,
    });
    assert.equal(Number(migrated.rows[0].total_spend), 6_000_000);
    assert.equal(migrated.rows[0].tier_name, "Gold");
    const historyCount = await client.execute("SELECT COUNT(*) AS count FROM customer_spend_transactions");
    assert.equal(Number(historyCount.rows[0].count), 1);

    await client.execute("UPDATE loyalty_tiers SET min_spend = 2000000 WHERE name = 'Silver'");
    await client.execute("UPDATE loyalty_tiers SET min_spend = 8000000 WHERE name = 'Gold'");
    await initializeDatabase(client);
    const retainedThresholds = await client.execute(
      "SELECT name, min_spend FROM loyalty_tiers WHERE name IN ('Silver', 'Gold') ORDER BY min_spend",
    );
    assert.deepEqual(retainedThresholds.rows.map(tier => [tier.name, Number(tier.min_spend)]), [
      ["Silver", 2_000_000],
      ["Gold", 8_000_000],
    ]);
    const retainedHistoryCount = await client.execute("SELECT COUNT(*) AS count FROM customer_spend_transactions");
    assert.equal(Number(retainedHistoryCount.rows[0].count), 1);
    await client.execute("UPDATE loyalty_tiers SET min_spend = 0");
    await initializeDatabase(client);
    const repairedThresholds = await client.execute(
      "SELECT name, min_spend FROM loyalty_tiers WHERE name IN ('Bronze', 'Silver', 'Gold') ORDER BY min_spend",
    );
    assert.deepEqual(repairedThresholds.rows.map(tier => [tier.name, Number(tier.min_spend)]), [
      ["Bronze", 0],
      ["Silver", 1_000_000],
      ["Gold", 5_000_000],
    ]);
  } finally {
    await client.close();
  }
});
