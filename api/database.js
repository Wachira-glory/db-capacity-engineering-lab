'use strict';

/**
 * database.js
 * -----------------------------------------------------------------------------
 * Connection factories for MySQL and MongoDB.
 */

const mysql = require('mysql2/promise');
const mysqlCallback = require('mysql2');
const { MongoClient } = require('mongodb');

// ---------------------------------------------------------------------------
// Environment configuration (with defaults for local runs)
// ---------------------------------------------------------------------------
// Built lazily via getMysqlConfig(), not at module-load time: secrets.js
// sets process.env.MYSQL_* during boot AFTER this module is first required,
// so a plain object here would capture the stale defaults instead of the
// real, resolved credentials.
function getMysqlConfig() {
  return {
  host: process.env.MYSQL_HOST || 'mysql-db',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || 'labpassword',
  database: process.env.MYSQL_DATABASE || 'capacity_lab',

  // OPS-2202 fix: Threads_running stayed at 2 during a 2000-VU surge while
  // capacity-api CPU hit 134% managing an unbounded queue -- connectionLimit
  // was the bottleneck, not the DB. Little's Law (lambda~470/s, W~0.02s)
  // suggested ~10 connections; sized up with headroom. queueLimit caps how
  // many requests wait for a connection before failing fast (503-style
  // rejection) instead of queueing indefinitely and ballooning latency.
  // OPS-2202 fix, revised: queueLimit=200 caused 15,146 db_errors_total
  // (mysql2 queue-limit rejections, surfaced as EOF/500s) under a 2000-VU
  // surge -- far more callers than the queue allowed. Raised connectionLimit
  // is validated (Threads_running climbed under load, mysql-db CPU stayed
  // low); queueLimit set high enough to absorb a realistic surge rather than
  // hard-reject mid-storm. Real backpressure belongs at a layer that can
  // return 503 with Retry-After, not a silent client-side queue drop --
  // flagged as a follow-up, not solved by this ticket alone.
  // OPS-2202 fix, final: connectionLimit=20 fixes the confirmed mechanism
  // (Threads_running pinned at 2 while requests queued). queueLimit tested
  // at 200 (62.57% errors -- too small) and 3000 (1.86% errors but p95=27.43s
  // -- queue absorbs everything, so nothing fails fast, and total wait grows
  // unbounded). Settled on 500: bounded enough that a genuine overload sheds
  // load instead of making every caller wait equally long, generous enough
  // to absorb a realistic burst without wholesale rejection. A queue can't
  // fix a service-rate ceiling -- true graceful degradation needs upstream
  // admission control (rate limiting / fast 503), flagged as a follow-up.
  waitForConnections: true,
  connectionLimit: 20,
  queueLimit: 500,
  connectTimeout: 10_000,
  maxIdle: 2,
  idleTimeout: 60_000,
  enableKeepAlive: true,

  // Assignment 2: Aiven requires TLS. rejectUnauthorized: false since we're
  // not pinning Aiven's CA cert here -- fine for this lab, a production
  // setup would supply the real CA bundle instead.
  ssl:
    process.env.MYSQL_HOST && process.env.MYSQL_HOST.includes('aivencloud.com')
      ? { rejectUnauthorized: false }
      : undefined,
  };
}

const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongo-db:27017';
const MONGO_DB_NAME = process.env.MONGO_DB || 'capacity_lab';

// ---------------------------------------------------------------------------
// MySQL pool (singleton)
// ---------------------------------------------------------------------------
let pool;

function getPool() {
  if (!pool) {
    pool = mysql.createPool(getMysqlConfig());
  }
  return pool;
}

// OPS-2204: mysql2's promise-wrapped pool does not expose .stream() -- there
// is no reliable way to reach the underlying callback connection through it.
// Streaming requires the plain callback-style mysql2 API, so we keep a
// separate small pool just for that.
let streamPool;

function getStreamPool() {
  if (!streamPool) {
    streamPool = mysqlCallback.createPool({ ...getMysqlConfig(), connectionLimit: 5 });
  }
  return streamPool;
}

// ---------------------------------------------------------------------------
// MongoDB client (singleton, lazily connected)
// ---------------------------------------------------------------------------
let mongoClient;
let mongoDb;

async function getMongo() {
  if (!mongoDb) {
    mongoClient = new MongoClient(MONGO_URI, {
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 5_000,
    });
    await mongoClient.connect();
    mongoDb = mongoClient.db(MONGO_DB_NAME);
  }
  return mongoDb;
}

// ---------------------------------------------------------------------------
// Graceful shutdown helpers
// ---------------------------------------------------------------------------
async function closeAll() {
  if (pool) {
    try { await pool.end(); } catch (_) { /* ignore */ }
    pool = undefined;
  }
  if (mongoClient) {
    try { await mongoClient.close(); } catch (_) { /* ignore */ }
    mongoClient = undefined;
    mongoDb = undefined;
  }
}

module.exports = {
  getMysqlConfig,
  MONGO_URI,
  MONGO_DB_NAME,
  getPool,
  getStreamPool,
  getMongo,
  closeAll,
};
