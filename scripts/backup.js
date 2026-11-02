"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createClient } = require("@libsql/client");

async function main() {
  if (process.env.TURSO_DATABASE_URL) {
    throw new Error("Backup ini hanya mendukung database SQLite lokal. Gunakan fitur ekspor Turso untuk database jarak jauh.");
  }
  const databasePath = path.resolve(
    process.env.BREWCLUB_DATABASE || path.join(require("node:os").homedir(), ".brewclub", "customers.sqlite3"),
  );
  if (!fs.existsSync(databasePath)) throw new Error(`Database tidak ditemukan: ${databasePath}`);

  const outputDirectory = path.resolve(process.argv[2] || "backups");
  fs.mkdirSync(outputDirectory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(outputDirectory, `customers-${timestamp}.sqlite3`);
  const escapedPath = backupPath.replaceAll("'", "''");
  const client = createClient({ url: pathToFileURL(databasePath).href });
  try {
    await client.execute(`VACUUM INTO '${escapedPath}'`);
  } finally {
    client.close();
  }

  const backup = createClient({ url: pathToFileURL(backupPath).href });
  try {
    const result = await backup.execute("PRAGMA integrity_check");
    if (result.rows.length !== 1 || result.rows[0].integrity_check !== "ok") {
      throw new Error("Pemeriksaan integritas backup gagal.");
    }
  } finally {
    backup.close();
  }
  console.log(`Backup berhasil: ${backupPath}`);
}

main().catch((error) => {
  console.error(`Backup gagal: ${error.message}`);
  process.exitCode = 1;
});
