# 🧾 On-Call Lab Journal — Regional Health

**Engineer:** Glory Wachira  **Date:** August 11, 2026

This is your investigation notebook. You are on call for the Regional Health
platform and working the [incident queue](./incidents/README.md). For each
incident you will:

1. **Hypothesis** — from the ticket symptoms alone, predict the cause *before*
   you run anything.
2. **Observation** — record real evidence: k6 output, Grafana/Prometheus
   metrics, `EXPLAIN ANALYZE` plans, lock views, `docker stats`, container logs.
3. **Root cause & mechanism** — explain *why* it happens. Name the database/OS
   mechanic yourself and show the capacity math.
4. **Fix & verify** — make the change, re-run the reproduction, and record the
   before/after.

> There is no answer key. A claim without evidence isn't a diagnosis. "It felt
> slow" is not an observation; `p(95)=1840ms, http_req_failed=32%` is.

---

## How to capture evidence

- **k6:** copy the summary block (`http_req_duration`, `http_req_failed`,
  `iterations`, `vus`).
- **MySQL:** `docker compose exec mysql-db mysql -uroot -plabpassword capacity_lab`
  then run `EXPLAIN ANALYZE ...`, `SHOW CREATE TABLE ...`,
  `SHOW ENGINE INNODB STATUS\G`, or query `performance_schema` / `sys`.
- **Metrics:** Grafana panels or raw Prometheus at http://localhost:9090.
- **Memory / restarts:** `docker stats`, `docker compose logs -f capacity-api`.

Useful Prometheus queries:
```promql
# Throughput (req/s) by route
sum(rate(http_requests_total[1m])) by (route)

# p95 latency by route
histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[1m])) by (le, route))

# Application heap in use
nodejs_heap_size_used_bytes

# DB errors by code
sum(rate(db_errors_total[1m])) by (code)
```

---

## Baseline — steady state (do this first)
*Run:* `k6 run load-tests/00-baseline.js` (healthy system, no incident)

Capture the control group you'll compare every incident against.

| Metric              | Value |
|---------------------|-------|
| Requests/sec (RPS)  | 48.3 |
| p50 latency         | 9.09ms |
| p95 latency         | 87.99ms |
| p99 latency         | not reported by k6's default summary (only avg/min/med/max/p90/p95) |
| Error rate          | 0.00% |
| Peak API heap used  | 95.7 MB (RSS, from Grafana "API memory vs container limit" panel) |

> SLOs you'll hold the incidents to (target p95, max error rate, RPS floor):
> p95 < 200ms, error rate < 1%, RPS floor ~45 req/s -- matches the thresholds
> already asserted in `00-baseline.js`.

![baseline](./evidence/baseline.png)

---

## Investigation — OPS-2201
*Ticket:* [Patient name search unusably slow at shift change](./incidents/OPS-2201.md)
*Reproduce:* `k6 run load-tests/reproduce-OPS-2201.js`

### Hypothesis
> From the symptoms alone (fast when isolated, collapses under concurrent
> searches, other endpoints unaffected), I think the cause is a full table
> scan on `last_name` because there's no index on that column, so every
> search reads all ~100,000 rows -- cheap once, expensive under concurrency.

### Observation (evidence)
> Investigate how the database executes the search. Paste what you find:
> ```
> EXPLAIN ANALYZE SELECT * FROM patients WHERE last_name = 'Smith';
> -> Filter: (patients.last_name = 'Smith')  (cost=10294 rows=9837) (actual time=0.194..170 rows=10000 loops=1)
>     -> Table scan on patients  (cost=10294 rows=98373) (actual time=0.123..146 rows=100000 loops=1)
> ```
| Metric (under load) | Value | vs. baseline |
|---------------------|-------|--------------|
| p95 latency         | 32.42s | ~368x worse (baseline 87.99ms) |
| RPS                 | 6.9/s | ~7x lower (baseline 48.3/s) |
| Error rate          | 0.00% (but see note below) |
| Rows examined / req | 100,000 (full table scan) | baseline /recent scans 0 extra rows -- PK order, LIMIT 50 |

> Note: 0% error rate is misleading -- every request eventually returned 200,
> nothing timed out. The damage is entirely in latency: p95 blew past the
> 300ms SLO by over 100x (32.42s vs 300ms threshold). The ticket's "sometimes
> it errors out" doesn't reproduce here; the honest finding is worse -- it
> never errors, it just becomes unusable.

### Root cause & mechanism
> Mechanism: full table scan. `last_name` has no index (only the `id` primary
> key does), so `WHERE last_name = ?` forces MySQL to read every row in the
> table and filter in memory -- confirmed by EXPLAIN ANALYZE: "Table scan on
> patients ... rows=100000". Cost is O(N) per query regardless of how
> selective the search is. At low concurrency this is masked -- a single
> 100k-row scan still completes in well under a second. Under 200 concurrent
> VUs, every one of those O(N) scans competes for the same CPU and the
> app's DB connection pool (connectionLimit=2), so scans queue behind each
> other instead of running in parallel -- turning a ~150ms scan into
> minutes of queued wait per request (p95=32.42s observed).
> Ideal: an index on `last_name` turns this into an index range seek --
> O(log N) to find the start of the matching range, then O(k) to read the k
> matching rows (~10,000 for "Smith"), instead of O(N)=100,000 rows examined
> for every search regardless of match count.

### Fix & verify
> Change 1: `CREATE INDEX idx_patients_last_name ON patients (last_name)`.
> Confirmed via EXPLAIN ANALYZE -- plan changed from "Table scan on patients
> rows=100000" to "Index lookup on patients using idx_patients_last_name
> rows=10000". Re-ran reproduce-OPS-2201.js: p95 got WORSE (32.42s -> 46.09s).
> The index fixed the lookup but exposed a second mechanism: the endpoint has
> no LIMIT, so a common surname (10,000 matching rows, confirmed via
> `SELECT COUNT(*)`) still serializes and transfers all 10,000 full rows per
> request -- data_received was 1.5GB for the run.
>
> Change 2: added `LIMIT 100` to the search query in server.js.
> Re-run evidence:
> New p95: 722.75ms (confirming re-run; earlier run showed 826.68ms) -- both
> from 46.09s pre-fix, from 32.42s original -- ~45-56x faster
> New RPS: 343.7/s (confirming re-run; earlier run showed 308.3/s) -- from
> 6.8/s pre-fix, from 6.9/s original -- ~45-50x higher
> data_received: 367MB / 331MB across the two confirming runs (from 1.5GB) -- ~4.5x less
>
> Evidence: ![before](./evidence/OPS-2201-before.png) ![after](./evidence/OPS-2201-after.png)
> Error rate: 0.00% throughout
>
> Trade-off / honest gap: the ticket's own SLO (p(95)<300ms) is still NOT met
> (826ms > 300ms threshold). Little's Law check: N=200 VUs, measured
> throughput=308.3 req/s -> W = N/lambda = 200/308.3 = 0.649s, which matches
> the observed avg latency (641ms) almost exactly -- this points to queueing
> time against `connectionLimit: 2` in database.js as the remaining
> bottleneck, not query execution time. That pool limit is the specific
> subject of OPS-2202 and is left untouched here so that ticket's evidence
> (DB looks idle under pool starvation) still reproduces cleanly later. This
> ticket's evidence supports two mechanisms (missing index, unbounded result
> set) and both were fixed with large, real improvement -- the remaining gap
> is a separate, already-identified mechanism outside this ticket's scope.

---

## Investigation — OPS-2202
*Ticket:* [Whole app freezes during surges, DB looks idle](./incidents/OPS-2202.md)
*Reproduce:* `k6 run load-tests/reproduce-OPS-2202.js`

### Hypothesis
> Given the query is trivial and the DB is idle yet requests pile up, I think
> the bottleneck is the application-tier MySQL connection pool
> (connectionLimit: 2 in database.js) because only 2 queries can execute
> concurrently no matter how cheap each one is -- a burst of 2000 requests
> queues waiting for a free connection, so the database itself stays idle
> (it's only ever running <=2 queries) while the app appears frozen.

### Observation (evidence)
> Where is time spent between request arrival and query execution? Capture the
> error codes and any queue/timeout evidence from logs and metrics:
> ```
> docker stats during surge:
>   mysql-db      CPU 24.65%   MEM 410MiB/7.61GiB
>   capacity-api  CPU 134.10%  MEM 96.24MiB/160MiB
>
> SHOW STATUS LIKE 'Threads_connected'; -> 3
> SHOW STATUS LIKE 'Threads_running';   -> 2   (matches connectionLimit=2)
> ```
| Metric                    | Value | vs. baseline |
|---------------------------|-------|--------------|
| Successful RPS (plateau)  | 469.8/s (mean over run) | ~9.7x higher raw throughput, but see latency |
| p95 / p99 latency         | p95=5.31s, max=12.22s | ~60x worse (baseline p95=87.99ms) |
| Error / timeout rate      | 0.00% -- ticket claims "500s", not observed here | contradicts ticket wording |
| Avg service time per query (s) | ~3.72s avg http_req_duration | baseline avg ~20ms |

### Root cause & mechanism
> Confirmed: connection-pool starvation, not a database performance problem.
> `Threads_running=2` during the surge proves the DB is only ever executing 2
> queries concurrently, no matter how many of the 2000 VUs are waiting --
> this is `connectionLimit: 2` in database.js acting as a hard admission gate
> in the app tier, upstream of the database entirely. mysql-db CPU (24.65%)
> stayed low because it genuinely only had 2 things to do at once; capacity-api
> CPU (134.10%, >1 core) was high because the app process itself is burning
> cycles managing a huge in-memory queue of waiting requests (queueLimit: 0 =
> unbounded queueing, so nothing gets rejected, everything just waits longer).
>
> Little's Law: N = lambda * W. Measured service time per query is short
> (baseline shows ~20ms avg for this same query with no contention). With
> C=2 concurrent "servers" (pooled connections) and W~=0.02s per query,
> theoretical max throughput = C/W = 2/0.02 = 100 req/s. Observed plateau
> was ~470 req/s in the k6 summary, but that's requests *completed* over the
> full 33s window including the long queue wait -- the true steady-state
> admission rate into the DB is capped at ~100/s, and the other ~2000
> concurrent callers are simply queued in Node's event loop / mysql2's
> internal queue the whole time, which is exactly why latency (not
> throughput) is what balloons: avg http_req_duration=3.72s is almost
> entirely queueing time, not query execution time.
> - Measured avg service time W ~= 0.02s (per query, low contention)
> - Target throughput target ~= 470 req/s (observed demand)
> - Required capacity C = lambda * W = 470 * 0.02 ~= 9-10 connections
> Making the pool arbitrarily large eventually stops helping because MySQL
> itself has a real capacity ceiling (CPU cores, max_connections, lock/latch
> contention) -- past some C, adding more concurrent connections just moves
> the queue from the app tier into the database tier instead of eliminating
> it, and can make things worse via context-switching and contention.

### Fix & verify
> Change 1: raised connectionLimit 2 -> 20 in database.js, based on Little's
> Law sizing (target ~470 req/s, W~0.02s -> ~10 connections needed, sized up
> with headroom to 20). Verified fix: Threads_connected/Threads_running
> climbed under load (proof the pool is now actually being used), mysql-db
> CPU stayed low (24-30%), confirming the DB itself was never the ceiling.
>
> Change 2 (correction after re-testing): initial queueLimit=200 was far too
> small for a 2000-VU burst -- caused 15,146 db_errors_total (queue-limit
> rejections surfaced as client-side EOF/500s), error rate spiked to 62.57%.
> Raised queueLimit to 3000. Re-run: error rate down to 1.86% -- but p95
> latency got WORSE (5.31s original -> 27.43s with connectionLimit=20 +
> queueLimit=3000). Checked and ruled out other ceilings: capacity-api CPU
> only ~20.5% (not saturated), MySQL max_connections=151 (far above the 20
> we use), ulimit -n=1024 (plenty of file descriptors). None of those are the
> constraint.
>
> New RPS: ~417-470/s (did not meaningfully improve across any pool size
> tested -- 2, 20 all land in the same 400-700/s band)
> New error rate: 1.86% (down from 62.57% with the too-small queue, and
> better than the 0%-but-catastrophically-slow original -- trade-off below)
> New p95: 27.43s (worse than original 5.31s under this specific 2000-VU
> burst size, even though the SLO for error rate now passes)
>
> Trade-off / honest finding: connectionLimit=2 was a real, confirmed
> mechanism (Threads_running pinned at 2 while 2000 requests waited) and
> raising it is the correct fix for the *mechanism* the ticket describes --
> but under a burst this large (2000 concurrent), no reasonable pool size
> alone avoids a queue; it only changes whether that queue is silent
> (unbounded queueLimit, requests hang) or bounded (requests get rejected
> once full). The real fix this points to is upstream admission control --
> a rate limiter or a fast 503-with-Retry-After once queue depth exceeds a
> sane bound -- so a burst degrades gracefully (some requests fast-fail
> immediately) instead of either hanging indefinitely or piling into a huge
> queue that makes every request equally slow. That's flagged as a follow-up
> beyond this ticket's scope, not implemented here.

---

## Investigation — OPS-2203
*Ticket:* [Bed admissions fail with DB errors under load](./incidents/OPS-2203.md)
*Reproduce:* `k6 run load-tests/reproduce-OPS-2203.js`

### Hypothesis
> Given one-at-a-time works but concurrent admits to the *same* hospital fail,
> I think the cause is _____________________________________________________
> and the failure will show up as ______ (a DB error? a timeout? a stall?) ___.

### Observation (evidence)
> While the reproduction runs, inspect concurrent writers to one row:
> ```sql
> SELECT * FROM performance_schema.data_locks\G
> SELECT * FROM sys.innodb_lock_waits\G
> SHOW ENGINE INNODB STATUS\G   -- TRANSACTIONS section
> ```
> Paste the most telling waiter/blocker rows and the failure signature you saw
> (a DB error + code, a timeout, or stalled/near-zero throughput):
> ```
>
> ```
| Metric                     | Value | vs. baseline |
|----------------------------|-------|--------------|
| p95 / p99 latency          |       |              |
| Max successful admits/sec  |       |              |
| DB error(s) + code         |       |              |
| Error rate                 |       |              |

### Root cause & mechanism
> Explain why concurrency cannot beat serialization on a single hot row. If the
> critical section is held for W seconds per admit, what is the theoretical max
> throughput for that one row, regardless of how many callers pile on?
> 1 / W = ______ admits/sec. Where does the time in the critical section go, and
> which of the transactional guarantees is enforcing the wait? ________________

### Fix & verify
> The change you made (consider: shrinking the critical section, moving slow
> work out of the transaction, atomic guarded updates, reducing contention on
> the hot row): _____________________________________________________________
> Re-measured throughput / error rate: ______________________________________

---

## Investigation — OPS-2204
*Ticket:* [Nightly export crashes the service repeatedly](./incidents/OPS-2204.md)
*Reproduce:* `k6 run load-tests/reproduce-OPS-2204.js`

### Hypothesis
> Given memory spikes right before each restart and only the big export is
> affected, I think the cause is ___________________________________________
> because __________________________________________________________________.

### Observation (evidence)
> Watch `nodejs_heap_size_used_bytes`, GC pauses, and restarts:
> ```bash
> docker stats
> docker compose logs -f capacity-api
> ```
| Metric                          | Value |
|---------------------------------|-------|
| Approx. payload size per request|       |
| Peak heap before crash          |       |
| Time-to-first-crash             |       |
| Container restart count         |       |
| GC pause trend                  |       |

> Paste the crash / exit log lines:
> ```
>
> ```

### Root cause & mechanism
> Estimate per-row size, then the full payload: rows × bytes/row = ______ MB.
> With C concurrent callers, peak resident memory ≈ ______ MB — compare to the
> container's memory budget (160MB locally / 256MB in prod). Explain what happens
> to GC frequency, CPU, and
> throughput as live heap approaches the limit, and why the current approach
> uses O(N) memory while a better one could use far less. ____________________

### Fix & verify
> The change you made (consider: bounding how much of the result set is in
> memory at once, streaming to the response, sensible page sizes, compression):
> ____________________________________________________________________________
> Re-run evidence — new peak heap: ______  restarts: ______  error rate: ______

---

## Post-incident review (synthesis)

> Rank the four incidents by **blast radius** (threat to overall availability at
> scale), justified with your measured numbers:
> 1. ____________________________________________________________________
> 2. ____________________________________________________________________
> 3. ____________________________________________________________________
> 4. ____________________________________________________________________
>
> If you could ship only **one** fix before a launch, which and why?
> ____________________________________________________________________________
>
> For each incident, what alert or dashboard would have caught it in production
> *before* a user filed a ticket? ____________________________________________
