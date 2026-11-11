# Slice 0 spike results

Measured 2026-11-11 with `node v22.23.4`, V8 `12.4.254.21-node.57`. Scripts: `spikes/jwt-sign.mjs`, `spikes/parse-50-lines.mjs`, `spikes/serialize-300-rows.mjs`. Tests: `node --test spikes/spikes.test.mjs` (6 pass, behaviour only, no timing).

## Read this first: these are a Node proxy

The spikes run in Node, which uses the same V8 engine family as workerd. They do not run in workerd. CPU is read with `process.cpuUsage()` (user+system, all threads of the process), so it includes GC and any threadpool work. The numbers do not prove that the Workers Free 10 ms CPU limit holds. Only a deployed Worker can (see Outstanding).

Method: "cold" is the first call in a fresh `node` process. It still benefits from module load and, for the JWT spike, from key generation having run first. A real cold isolate also pays script parse and JIT warm-up inside the request, so it is likely slower than these cold numbers. "Warm" is 200 further calls in the same process. Cold range is from 3 separate process runs per script. Single-run timings in this sandbox are noisy (max values spike 2 to 3 times the mean).

## 1. JWT mint on a token-cache miss (PEM parse, importKey, sign, assemble)

Correctness: assertion verified with `crypto.subtle.verify` against the public key (verify=true in all 3 runs, and in tests).

| Run | Cold CPU ms (3 runs) | Warm mean | p50 | p95 | max |
| --- | --- | --- | --- | --- | --- |
| CPU | 4.344, 4.687, 5.848 (range 4.3 to 5.8) | 1.24 to 1.30 | 1.13 to 1.24 | 1.57 to 1.72 | 3.3 to 4.5 |
| Wall | 3.263, 3.524, 4.514 | 1.23 to 1.31 | 1.17 to 1.26 | 1.50 to 1.62 | 2.1 to 4.2 |

Budget 10 ms. A cold mint uses roughly 40 to 60% of it in this proxy; a warm one about 13%.

Which is closer to Workers billing: uncertain. Node may run RSA sign on a threadpool thread, and `cpuUsage` counts every thread, so it is the better proxy for total compute. In these runs CPU came out slightly above wall time, which suggests the work is mostly on-thread and the two are close. Workers bills CPU time of the isolate and excludes I/O wait, which matches CPU more than wall. Treat CPU as the figure to use, and treat both as unconfirmed.

Design meaning: a mint is affordable once per invocation but is a large share of the budget when cold. The `system_kv` cache (55-minute TTL) earns its keep: with it, a normal 15-minute cron tick pays a D1 read instead of roughly 1.3 to 5 ms of CPU, and the mint never lands in the same invocation as a heavy step on most ticks. A cache miss combined with intake work in one invocation is the risky case (see below).

## 2. 50-line intake CPU work (SHA-256 x50, JSON.parse of 17.9 KB, validate, merge-key, 150 D1 param rows)

Input was 50 valid items producing 150 statements (3 per item). No network, no D1, no Gemini call.

| Run | Cold CPU ms (3 runs) | Warm mean | p50 | p95 | max |
| --- | --- | --- | --- | --- | --- |
| CPU | 8.746, 8.409, 11.327 (range 8.4 to 11.3) | 2.13 to 2.40 | 1.83 to 2.09 | 3.21 to 4.10 | 10.6 to 15.2 |

Design meaning:
- Warm, the pure compute for 50 lines is about 2 ms, well inside 10 ms. Cold it is 8.4 to 11.3 ms, at or over budget by itself in this proxy, before counting anything else.
- This work is not the only CPU in the invocation. Request/response handling, the Gemini and enrichment `fetch` calls (TLS, body read, JSON.parse of the real response), the Docs API calls and D1 round trips are not measured here, and all of them consume some CPU. So the true cold total is higher than these numbers.
- Therefore the 25-line cap should stay. At 25 lines the compute is about half (linear guess, not measured), and the margin is needed for the unmeasured overhead. 50 lines might fit warm, but cold it does not leave headroom, so this spike gives no support for raising the cap.
- The p95/max warm outliers (up to 15 ms) are likely GC or scheduler noise in the sandbox; they do show one-off spikes can exceed 10 ms.

## 3. Sheets serialise (3 tabs, 26 columns, each tab gets all rows, then `JSON.stringify`)

Worst-case shape: the same row set is written to all three tabs. Real tabs are subsets (Active_Queue, Curated_Lists), so real cost should be lower. "Cold" for the 1000-row case is not a true cold: it ran after the 300-row case in the same process.

| Rows | Body KB | Cold CPU ms (3 runs) | Warm mean | p50 | p95 | max |
| --- | --- | --- | --- | --- | --- | --- |
| 300 | 583 | 3.683, 3.858, 4.311 | 1.85 to 2.00 | 1.68 to 1.75 | 2.59 to 2.84 | 5.2 to 6.8 |
| 1000 | 1944 | 12.483, 9.334, 11.399 (not truly cold) | 5.74 to 6.55 | 5.46 to 6.06 | 6.67 to 9.51 | 14.2 to 16.4 |

Extrapolation (linear, from the 1000-row warm means, not measured): warm mean passes 5 ms at about 763 to 871 rows, so roughly 800 rows. Cold behaviour is worse: the cold 300-row run is already 3.7 to 4.3 ms.

Design meaning:
- 300 rows is fine on its own (about 2 ms warm, 4 ms cold). Around 800 library rows serialisation alone takes half the budget warm; at about 1000 rows it is at or over 10 ms cold.
- The nightly grooming/backup job should not build the entire body in one invocation as the library grows. Before the library passes roughly 500 rows, cap rows per invocation and write in chunks across ticks, or write only changed rows. This is a recommendation from proxy data; revisit with real Worker numbers.
- The body is large: 583 KB for 300 rows with all rows on 3 tabs. Check the Sheets request size limit when this is built.

## Caveats

- Node is a proxy, not workerd. Scheduling, GC and the crypto implementation differ (Node uses OpenSSL, workerd uses BoringSSL), so RSA numbers may differ in particular.
- Cold isolates are slower than these cold numbers, since script load and JIT warm-up are paid in the request.
- Unmeasured CPU: Gemini/enrichment/Docs `fetch` overhead, D1 calls, Hono routing, Drizzle query building, real response parsing.
- Sandbox timing noise is high; maxima are single outliers, not a distribution tail to trust.
- Synthetic data: string lengths are realistic guesses, not taken from real rows.

## Outstanding: needs a deployed Worker

1. Deploy through the normal GitHub Actions merge to `main` (never `wrangler deploy` locally) a Worker that runs the JWT mint and the 50-line and 300-row workloads with the same code.
2. Trigger it via the cron or a route, then read CPU time with `wrangler tail --format json` (each event has `outcome` and `cpuTime`; `outcome` of `exceededCpu` means the limit was hit) or the Workers observability / metrics page (CPU time percentiles).
3. Record cold (first request after deploy) and warm numbers, and compare against this file. Repeat at 25 and 50 lines, and at 300 and 800 rows.
4. Update the intake cap and Sheets chunk-size decision from those numbers.
