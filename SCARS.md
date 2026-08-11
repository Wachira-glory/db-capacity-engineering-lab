# Scar Log — Regional Health

## OPS-2201 -- Patient search unusably slow at shift change

- **S -- Symptom:** Search by last name collapsed under concurrency:
  p95=32.42s (baseline 87.99ms), RPS dropped to 6.9/s (baseline 48.3/s) with
  200 concurrent nurses searching "Smith" at shift change.
- **C -- Cause:** Two stacked mechanisms. (1) No index on `last_name` forced
  a full table scan of all 100,000 rows per search (confirmed via
  EXPLAIN ANALYZE: "Table scan on patients rows=100000"). (2) Once indexed,
  a second mechanism surfaced: the query had no LIMIT, so a common surname
  (10,000 matching rows) still serialized and transferred the full match set
  every request (data_received=1.5GB for the run).
- **A -- Action:** Added `CREATE INDEX idx_patients_last_name ON patients
  (last_name)` (persisted in seed.sh) and capped the query with `LIMIT 100`
  in server.js.
- **R -- Result:** p95 32.42s -> 722.75ms (~45x), RPS 6.9/s -> 343.7/s
  (~50x), data_received 1.5GB -> ~350MB (~4.5x). Honest gap: still above the
  ticket's own SLO (p95<300ms) -- Little's Law (N=200, lambda=308/s ->
  W=0.649s) points to the connection pool (connectionLimit=2) as the
  remaining bottleneck, which is OPS-2202's mechanism, left untouched here.
- **Scar / lesson:** An index fix can be correct and still not be the whole
  story -- always re-measure after the "obvious" fix instead of assuming
  cost = 0. A dashboard alert on `http_requests_total` rate falling sharply
  while `http_request_duration` p95 spikes, filtered to `/api/patients/search`,
  would have caught this before a ticket was filed.
- **Evidence:** [LAB_JOURNAL.md, Investigation OPS-2201](./LAB_JOURNAL.md),
  commits `e7e876d`, `6f29c53`, `evidence/OPS-2201-before.png`,
  `evidence/OPS-2201-after.png`.

## OPS-2202 -- Whole app freezes during registration surges, DB "idle"

- **S -- Symptom:** Under a 2000-VU surge, even the trivial /api/patients/recent
  call collapsed: p95=5.31s (baseline 87.99ms), max=12.22s, while mysql-db CPU
  stayed at 24.65% (not saturated) and capacity-api CPU hit 134% (>1 core).
- **C -- Cause:** Connection-pool starvation in the app tier, not a database
  problem. `connectionLimit: 2` in database.js capped concurrent query
  execution at 2 no matter how many requests arrived. Confirmed directly:
  `SHOW STATUS LIKE 'Threads_running'` returned 2 during the surge, proving
  the DB was only ever asked to do 2 things at once while 2000 VUs waited in
  an unbounded app-tier queue (queueLimit: 0).
- **A -- Action:** Raised connectionLimit 2 -> 20 (Little's Law sizing) and
  set queueLimit -- tuned across 3 iterations (200 -> 62.57% errors, 500 ->
  28.38% errors, 3000 -> 1.86%-17.86% errors across repeated runs) to bound
  the queue instead of leaving it unbounded.
- **R -- Result:** Threads_running confirmed climbing under the new pool
  (mechanism fixed). Error rate improved from queue-rejection failures but
  never fully stabilized under 5% at this burst size; p95 got WORSE (15-30s
  vs original 5.31s) because a bigger pool just lets more requests queue
  instead of failing fast. RPS never moved from ~400-470/s regardless of
  pool size -- steady-state throughput was never the bottleneck, only what
  happens to excess demand.
- **Scar / lesson:** Fixing a confirmed mechanism does not guarantee the
  ticket's SLOs pass -- a bigger pool trades one failure mode (silent
  hanging) for another (queue depth vs error rate) without adding real
  capacity. True graceful degradation needs upstream admission control
  (rate limiting, fast 503+Retry-After) that this ticket didn't implement.
  A dashboard alert on `Threads_running` sustained at the pool's max while
  `http_requests_total` throughput stays flat would catch this before a
  ticket is filed -- exactly the DB-idle-but-stalled paradox this ticket
  describes.
- **Evidence:** [LAB_JOURNAL.md, Investigation OPS-2202](./LAB_JOURNAL.md),
  `evidence/OPS-2202-before.png`, `evidence/OPS-2202-after.png`.

## OPS-2203 -- Bed admissions fail under concurrent load to the same hospital

- **S -- Symptom:** Concurrent admits to the same hospital collapsed: p95 up
  to 57.63s (baseline 87.99ms), error rate 46%-98% across runs, throughput
  ~3.56 successful admits/sec. One-at-a-time admits and different-hospital
  admits were unaffected.
- **C -- Cause:** The admit handler held an exclusive row lock on the
  hospital's row across a ~500ms simulated external call
  (notifyBedRegistry) before committing. Confirmed directly via
  `performance_schema.data_locks`: one transaction GRANTED the lock
  (LOCK_DATA=1), ~19 others WAITING on the identical row. Waiters exceeding
  innodb-lock-wait-timeout=5s failed with ER_LOCK_WAIT_TIMEOUT (confirmed in
  Grafana's DB-errors panel).
- **A -- Action:** Removed the wrapping transaction; replaced with a single
  guarded atomic UPDATE (`WHERE id=? AND available_beds>0`) and moved the
  registry notification to run AFTER the write, outside the lock.
- **R -- Result:** RPS 3.56/s -> 301.4/s (~85x), p95 57.63s -> 2.04s (~28x),
  error rate 46-98% -> 6.59%. Honest gap: still short of the ticket's own
  SLOs (p95<1000ms, error<5%) -- remaining errors cluster at test-start
  burst, not ongoing contention.
- **Scar / lesson:** Never hold a database lock across a network call to an
  external system -- the lock's duration should match the DB work, not the
  slowest dependency in the request. A dashboard alert on
  `sys.innodb_lock_waits` row count sustained above a small threshold, or on
  ER_LOCK_WAIT_TIMEOUT rate, would catch this before a ticket is filed.
- **Evidence:** [LAB_JOURNAL.md, Investigation OPS-2203](./LAB_JOURNAL.md),
  `evidence/OPS-2203-before.png`, `evidence/OPS-2203-after.png`.

