"use strict";

const { createDatabaseClient, createHandler } = require("../backend/server");

const client = createDatabaseClient();
const handler = createHandler(client, { vercelPathQueryParameter: "__vercel_path" });

module.exports = handler;
module.exports.config = {
  api: {
    bodyParser: false,
  },
};
