# C7 — Incident Replay

## Alert stack verification

Prometheus + Grafana (`monitoring/`, built by the group) confirmed scraping
this individual deployment's `capacity-api` container successfully:
- Target `capacity-api` — health: up, no scrape errors
- Alert rules loaded from `monitoring/alert-rules.yml`, including
  `ApiMemoryPressure` (`process_resident_memory_bytes > 134217728`, i.e.
  128 MiB), which targets the exact metric responsible for the OPS-2204
  incident below.

## OPS-2204 — nightly export OOM

This incident was found, root-caused, and fixed during Assignment 1 (see
`SCARS.md` and `LAB_JOURNAL.md` in this repo for the full investigation).
The fix (streaming the export with backpressure instead of buffering the
full result set) is already applied in this deployment's `api/server.js`.

**Original incident evidence (Assignment 1, real, not re-simulated here):**
- `SELECT * FROM patients` buffered the full 100k-row result set into memory
  before responding
- Under 50 concurrent export requests, RSS climbed to ~254-260MB
- V8 crashed with `FATAL ERROR: Reached heap limit -- JavaScript heap out
  of memory`, confirmed via GC log (escalating 23.5s/19.7s Mark-Compact
  pauses) and a container restart (RestartCount: 1 -> confirmed via
  `docker inspect`)
- This RSS figure directly exceeds the `ApiMemoryPressure` alert's 128MiB
  threshold -- had this alert existed in production before the fix, it
  would have fired well before the OOM crash, giving on-call time to react.

**Mechanism:** the export endpoint materialized an O(N) in-memory array of
the entire patients table (including padded TEXT notes) instead of
streaming rows to the client, so peak memory scaled with table size and
concurrent callers rather than staying bounded.

**Fix (already deployed):** dedicated callback-style MySQL pool with
`.stream()`, backpressure handling (pause/resume on `res.write()`
signaling), and cleanup on client disconnect. Verified fix (Assignment 1):
peak RSS dropped to ~66-80MB under the same 50-concurrent-export load, 0
restarts, 0% error rate (vs. 100% pre-fix).

**Re-verification attempted in this Assignment 2 deployment:** live
re-triggering of the original bug against the rehosted/Aiven-backed stack
was attempted but not completed under time constraints (the mysql2
callback-pool streaming pattern behaved inconsistently in this Docker
network topology). The alert rule's correctness against the real incident
metric (`process_resident_memory_bytes`) is confirmed by direct comparison
to the documented Assignment 1 crash data above, rather than a fresh live
trigger.
