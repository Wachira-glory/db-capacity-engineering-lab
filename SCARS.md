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

