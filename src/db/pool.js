'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // A request must never wait forever for a connection (a starved pool used to hang silently).
  max: Number(process.env.DB_POOL_MAX) || 20,
  connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS) || 10000,
});

module.exports = pool;