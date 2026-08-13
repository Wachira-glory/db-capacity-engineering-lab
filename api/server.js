'use strict';

/**
 * server.js
 * -----------------------------------------------------------------------------
 * Express API for the Regional Health admissions & patient-lookup service.
 *
 * Endpoints:
 *   GET  /api/patients/recent        Recent patients widget
 *   GET  /api/patients/search        Patient lookup by last name
 *   POST /api/hospitals/:id/admit    Admit a patient (decrement bed count)
 *   GET  /api/patients/export        Full patient export for the analytics team
 *   GET  /api/audit/ping             Mongo audit-store health probe
 *   GET  /metrics                    Prometheus metrics
 */

const express = require('express');
const client = require('prom-client');
const { getPool, getStreamPool, getMongo } = require('./database');

// OPS-2202 P0 follow-up (Rob's review): raising connectionLimit alone fixed
// the starvation mechanism but couldn't clear the ticket's SLO under a
// 2000-VU burst -- a bigger pool just let more requests queue, so p95 got
// WORSE (5.31s -> 27.43s) even with 0 pool starvation. Real fix is
// admission control: track in-flight DB-bound requests and fail fast with
// 503 past a bound, instead of letting everyone wait in an ever-growing
// queue. This trades "a fraction of requests get a fast, clear rejection"
// for "everyone gets a slow response eventually" -- the standard shed-load
// pattern for absorbing bursts beyond real capacity.
// Tightened to match connectionLimit (20) after testing showed 40 let
// admitted requests still queue behind the pool -- p95 for successful
// requests stayed at ~29.65s even with admission control active, because
// the admission cap wasn't actually tied to real serving capacity.
const MAX_INFLIGHT_DB_REQUESTS = 20;
let inFlightDbRequests = 0;

function withAdmissionControl(handler) {
  return async (req, res, next) => {
    if (inFlightDbRequests >= MAX_INFLIGHT_DB_REQUESTS) {
      res.set('Retry-After', '1');
      return res.status(503).json({
        error: 'SERVICE_OVERLOADED',
        message: 'Too many in-flight requests, please retry shortly.',
      });
    }
    inFlightDbRequests += 1;
    try {
      await handler(req, res, next);
    } finally {
      inFlightDbRequests -= 1;
    }
  };
}

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);

// ---------------------------------------------------------------------------
// Prometheus metrics
// ---------------------------------------------------------------------------
const register = new client.Registry();
register.setDefaultLabels({ app: 'capacity-api' });

// Default process/GC/heap metrics.
client.collectDefaultMetrics({ register, gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5] });

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

const dbErrorsTotal = new client.Counter({
  name: 'db_errors_total',
  help: 'Total number of database errors by type',
  labelNames: ['route', 'code'],
  registers: [register],
});

// Per-request timing + counting middleware
app.use((req, res, next) => {
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    const route = req.route ? req.baseUrl + req.route.path : req.path;
    const labels = { method: req.method, route, status_code: res.statusCode };
    end(labels);
    httpRequestsTotal.inc(labels);
  });
  next();
});

// ---------------------------------------------------------------------------
// Health & metrics
// ---------------------------------------------------------------------------
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// ---------------------------------------------------------------------------
// Recent patients widget
// ---------------------------------------------------------------------------
app.get('/api/patients/recent', withAdmissionControl(async (_req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query(
      'SELECT * FROM patients ORDER BY id DESC LIMIT 50'
    );
    res.json({ count: rows.length, data: rows });
  } catch (err) {
    dbErrorsTotal.inc({ route: '/api/patients/recent', code: err.code || 'UNKNOWN' });
    res.status(500).json({ error: err.code || 'ERROR', message: err.message });
  }
}));

// ---------------------------------------------------------------------------
// Patient lookup by last name
// ---------------------------------------------------------------------------
app.get('/api/patients/search', async (req, res) => {
  const lastName = req.query.lastName || '';
  try {
    const pool = getPool();
    // OPS-2201 fix: the index (idx_patients_last_name) fixed the lookup, but
    // common surnames still match thousands of rows with no cap, so every
    // search serialized and transferred the entire match set. Cap results --
    // no user needs 10,000 rows rendered for one search.
    const [rows] = await pool.query(
      'SELECT * FROM patients WHERE last_name = ? LIMIT 100',
      [lastName]
    );
    res.json({ count: rows.length, lastName, data: rows });
  } catch (err) {
    dbErrorsTotal.inc({ route: '/api/patients/search', code: err.code || 'UNKNOWN' });
    res.status(500).json({ error: err.code || 'ERROR', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Admit a patient to a hospital (decrement available beds).
// We update the bed count, then notify the regional bed registry that the
// count changed before finalizing, so the two systems stay consistent.
// ---------------------------------------------------------------------------
// OPS-2203 fix: the row lock was held across notifyBedRegistry's ~500ms
// call, serializing every concurrent admit to the same hospital and pushing
// waiters past innodb-lock-wait-timeout=5s (ER_LOCK_WAIT_TIMEOUT). Fix:
// commit the DB change immediately with a single guarded atomic UPDATE (no
// explicit transaction needed -- one statement is already atomic), then
// notify the registry AFTER the lock is released. This shrinks the critical
// section from ~500ms to single-digit ms.
app.post('/api/hospitals/:id/admit', async (req, res) => {
  const hospitalId = Number(req.params.id);
  const pool = getPool();
  try {
    const [result] = await pool.query(
      'UPDATE hospitals SET available_beds = available_beds - 1 WHERE id = ? AND available_beds > 0',
      [hospitalId]
    );

    if (result.affectedRows === 0) {
      return res.status(409).json({ error: 'NO_BEDS_AVAILABLE', hospitalId });
    }

    // Notify the external registry AFTER the row lock is released -- a
    // slow downstream call should never hold a database lock. Production:
    // an outbox table + retry worker instead of fire-and-forget.
    notifyBedRegistry(hospitalId).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('bed registry notify failed', hospitalId, err);
    });

    res.json({ status: 'admitted', hospitalId });
  } catch (err) {
    dbErrorsTotal.inc({ route: '/api/hospitals/:id/admit', code: err.code || 'UNKNOWN' });
    res.status(500).json({ error: err.code || 'ERROR', message: err.message });
  }
});

// Stand-in for the external registry client used by the admit flow.
function notifyBedRegistry(_hospitalId) {
  return new Promise((r) => setTimeout(r, 500));
}

// ---------------------------------------------------------------------------
// Full patient export for the analytics/ETL team.
// ---------------------------------------------------------------------------
// OPS-2204 fix: SELECT * loaded all 100,000 rows into one JS array, then
// res.json() serialized the whole thing into one giant string -- both had
// to coexist in memory at peak (~254-260MB, confirmed via GC log), blowing
// past the container's 160MB budget and V8's own --max-old-space-size=256
// ceiling (FATAL ERROR: JavaScript heap out of memory). Fix: stream rows to
// the response as NDJSON as they arrive from MySQL, so memory stays O(1)
// (one row's worth) regardless of table size or concurrent callers.
// OPS-2204 fix, revised: initial streaming attempt still OOM'd (confirmed
// via docker stats: memory hit 159.9/160MiB right at the cgroup limit) --
// res.write() was called without checking its return value, so when a
// client's TCP receive buffer filled up (res.write() returns false), the
// MySQL row stream kept flowing and Node's internal write buffer grew
// unbounded per response. With 50 concurrent exports, that's 50 unbounded
// buffers -- same O(N) problem via a different path. Fix: pause the MySQL
// row stream when res.write() signals backpressure (returns false), resume
// on the response's 'drain' event. This caps in-flight memory to roughly
// one MySQL read-buffer's worth per connection, regardless of how slow the
// client is or how many concurrent exports are running.
// OPS-2204 fix, corrected: the promise-wrapped pool has no working .stream()
// path -- attempting to reach it via .connection silently hung forever with
// zero bytes sent and no error (confirmed: 60s curl timeout, empty logs).
// mysql2's streaming API only works on the plain callback-style pool, so we
// use a dedicated small pool (getStreamPool) just for this route, with
// backpressure handling (pause/resume on write drain) to keep memory O(1)
// regardless of table size or concurrent callers.
app.get('/api/patients/export', (_req, res) => {
  // eslint-disable-next-line no-console
  console.log('export request received');
  const streamPool = getStreamPool();
  res.setHeader('Content-Type', 'application/x-ndjson');

  const dbStream = streamPool.query('SELECT * FROM patients').stream({ highWaterMark: 200 });

  // If the client disconnects mid-stream (e.g. a cancelled request or a
  // timed-out k6 VU), destroy the DB stream so its connection returns to
  // the pool instead of staying checked out indefinitely.
  res.on('close', () => {
    if (!res.writableEnded) {
      dbStream.destroy();
    }
  });

  dbStream.on('data', (row) => {
    const ok = res.write(JSON.stringify(row) + '\n');
    if (!ok) {
      dbStream.pause();
      res.once('drain', () => dbStream.resume());
    }
  });

  dbStream.on('end', () => res.end());

  dbStream.on('error', (err) => {
    dbErrorsTotal.inc({ route: '/api/patients/export', code: err.code || 'UNKNOWN' });
    if (!res.headersSent) {
      res.status(500).json({ error: err.code || 'ERROR', message: err.message });
    } else {
      res.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Mongo audit-store health probe
// ---------------------------------------------------------------------------
app.get('/api/audit/ping', async (_req, res) => {
  try {
    const db = await getMongo();
    const result = await db.command({ ping: 1 });
    res.json({ mongo: result });
  } catch (err) {
    res.status(500).json({ error: 'MONGO_ERROR', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`capacity-api listening on :${PORT} (metrics at /metrics)`);
});
