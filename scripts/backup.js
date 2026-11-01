'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const databasePath = path.resolve(
  process.env.BREWCLUB_DATABASE || path.join(os.homedir(), '.brewclub', 'customers.sqlite3')
);
const backupDirectory = path.resolve(process.argv[2] || './backups');
const timestamp = new Date().toISOString().replaceAll(':', '-');
const destination = path.join(backupDirectory, `brewclub-${timestamp}.sqlite3`);
const temporaryDestination = `${destination}.tmp`;

fs.mkdirSync(backupDirectory, { recursive: true });
const database = new DatabaseSync(databasePath, { readOnly: true });
try {
  const image = database.serialize();
  fs.writeFileSync(temporaryDestination, image, { flag: 'wx' });
} finally {
  database.close();
}

try {
  const verify = new DatabaseSync(temporaryDestination, { readOnly: true });
  try {
    const result = verify.prepare('PRAGMA quick_check').get();
    if (result.quick_check !== 'ok') {
      throw new Error(`Pemeriksaan integritas backup gagal: ${result.quick_check}`);
    }
  } finally {
    verify.close();
  }
  fs.renameSync(temporaryDestination, destination);
  console.log(`Backup berhasil dibuat: ${destination}`);
} catch (error) {
  if (fs.existsSync(temporaryDestination)) fs.unlinkSync(temporaryDestination);
  throw error;
}
