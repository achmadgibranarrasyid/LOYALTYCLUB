"use strict";

const { createDatabaseClient, createHandler } = require("../backend/server");

let client;
let initError;
try {
  client = createDatabaseClient();
} catch (error) {
  initError = error;
}

const handler = initError
  ? function failingHandler(req, res) {
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify({
        error: "Backend gagal memulai karena konfigurasi database tidak valid.",
        detail: initError.message,
      }));
    }
  : createHandler(client, { vercelPathQueryParameter: "__vercel_path" });

module.exports = handler;
module.exports.config = {
  api: {
    bodyParser: false,
  },
};
