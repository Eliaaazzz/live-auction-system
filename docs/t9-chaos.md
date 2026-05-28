# T9 Chaos Drills — Lumen Auction (V9 §10)

> **Goal**: 5 fault drills proving the demo path degrades safely and self-heals
> with no seq gap. Exit evidence is **assertable logs** (per §10) + a recording
> for demo day (out of CI scope).
>
> Source harness: `apps/lumen/internal/server/chaos.go` (`lumen chaos --phase=...`).
> Orchestrator: `Makefile` — `make chaos` runs all five; `make chaos-<phase>`
> runs one in isolation. CI runs the cheap one (`chaos-smoke` = AI phase).

---

## 1. The 5 phases (V9 plan §10)

| # | Phase | Fault | Degrade assertion | Recovery assertion | Verifier? |
|---|---|---|---|---|---|
| 1 | `chaos-ai` | `docker compose stop ai-sidecar` | `make e2e-dummy-bid` → exit 0 (bid path independent of AI) | `start` + bid exit 0 | — |
| 2 | `chaos-redis` | `docker compose stop redis` | bid → `BID_REJECTED { code: "ERR_AUCTION_PAUSED" }` | `start redis` + `restart lumen` → fresh auction → `OK_ACCEPTED` | ✓ (post-recovery aid) |
| 3 | `chaos-mysql` | `docker compose stop mysql` | 2 more bids → `BID_ACCEPTED` (Redis hot path unaffected) | `start mysql` → wait `events-count >= 3` (persistence drains) | ✓ (original aid) |
| 4 | `chaos-ws` | `docker compose stop lumen` | host `curl /healthz` refused | `start lumen` → catchup w/ `lastSeq=1` → `ROOM_SNAPSHOT.seq >= 1` (no gap), then `OK_ACCEPTED` | ✓ (original aid) |
| 5 | `chaos-timer` | recreate lumen w/ `LUMEN_CHAOS_DISABLE_TIMER=1` | auction state stays `LIVE` past `endAtMs` AND bid → `ERR_AFTER_END` | recreate without env → state → `SOLD` within scan tick | ✓ (original aid) |

> V9 §6 hard rule ⑦: "Redis 挂 显式 `ERR_AUCTION_PAUSED`". The Redis drill is
> the direct test of that contract. The mapping lives in
> `apps/lumen/internal/server/ws.go::bidErrCode` — any non-`NOSCRIPT` EVALSHA
> transport error → `CodeErrPaused`.

---

## 2. Run

```bash
# all five drills, in order, ~3-4 min wall-clock
make up
make chaos

# or one at a time
make chaos-ai
make chaos-redis
make chaos-mysql
make chaos-ws
make chaos-timer

# cheap CI gate (AI only, ~30s) — kept as a regression net so a future
# refactor that breaks the chaos harness fails CI loudly.
make chaos-smoke
```

Each phase prints `CHAOS_OK phase=<name> ...` for every passing assertion and
`CHAOS_FAIL phase=<name> err=...` + non-zero exit on the first failure.
Successful drills end with `✓ chaos[N/5] <phase> PASSED · <one-line summary>`.

---

## 3. What the assertion log looks like (Redis drill)

```
=== chaos[2/5] redis ===
--- redis: setup pre-fault auction ---
CHAOS_AID=auc_abc123
CHAOS_OK phase=bid-expect aid=auc_abc123 code=OK_ACCEPTED observed=BID_ACCEPTED
CHAOS_OK phase=setup aid=auc_abc123 durationMs=600000
redis: pre-fault aid=auc_abc123
--- redis: stop ---
[+] Stopping 1/1
 ✔ Container infra-redis-1 Stopped
--- redis: bid-expect ERR_AUCTION_PAUSED ---
CHAOS_OK phase=bid-expect aid=auc_abc123 code=ERR_AUCTION_PAUSED observed=BID_REJECTED
--- redis: start + restart lumen (script cache reload) ---
[+] Running 1/1
 ✔ Container infra-redis-1 Started
[+] Running 1/1
 ✔ Container infra-lumen-1 Started
--- redis: fresh auction post-recovery ---
CHAOS_AID=auc_def456
CHAOS_OK phase=bid-expect aid=auc_def456 code=OK_ACCEPTED observed=BID_ACCEPTED
--- redis: verify recovered auction ---
verifier: aid=auc_def456 status=consistent ...
✓ chaos[2/5] redis PASSED · degrade=ERR_AUCTION_PAUSED · recover=fresh-auction-consistent
```

---

## 4. Why each drill is shaped this way

### 4.1 AI (`chaos-ai`)
- Already wired as `make e2e-ai-offline` (T7-5 gate). T9 reuses it as
  phase 1 so we don't duplicate the orchestration. V9 P3: "AI 不参与
  bid acceptance" — the e2e drill proves the bid path stays green with
  the sidecar stopped.

### 4.2 Redis (`chaos-redis`)
- The dev `redis` service in `infra/docker-compose.yml` has **no volume**
  → restarting Redis is data-loss (deliberate; production deploy would
  add an AOF-everysec volume per V9 §3). So "recovery" means a **fresh
  auction works**, not "the original auction resumes". The drill
  reflects this: setup → degrade on aid A → start redis + restart lumen
  (script cache also flushed) → setup on aid B → verify B.
- Verifier runs on the *post-recovery* auction since the pre-fault
  auction's state Hashes were lost with Redis. This still proves the
  three-way consistency contract; the pre-fault data loss is a known
  limitation called out in the dev compose, not a chaos finding.

### 4.3 MySQL (`chaos-mysql`)
- V9 hot-path invariant: "MySQL 不在出价热路径" — bids during the MySQL
  outage **must still ack**. The drill places 2 bids while MySQL is
  down and asserts they ack. The persistence worker's idempotency
  projection (`auction_events` `UNIQUE(auction_id, seq)`) handles the
  resumption; the drill polls `events-count` until all 3 events have
  drained, then runs the Verifier for the three-way consistency proof.

### 4.4 WS gateway (`chaos-ws`)
- Stopping `lumen` simulates a single-gateway outage (T5 splits
  gateway horizontally; this drill remains valid on the multi-gateway
  topology because the assertion is "an observer that misses events
  during an outage MUST get them back via catchup").
- The catchup assertion is the **key seq-gap proof**: ROOM_JOIN with
  `lastSeq=1` after restart must return `ROOM_SNAPSHOT.seq >= 1`
  (covers the warm bid) — i.e. either an XRANGE replay of events 2+
  (if any) or a snapshot fallback (`gap > 200`). For this drill the
  only event is the seq=1 warm bid; the snapshot's `currentPriceCents`
  matches.

### 4.5 Timer Worker (`chaos-timer`)
- Setup creates a 5s-duration auction (override via `--duration-ms`).
- The `LUMEN_CHAOS_DISABLE_TIMER=1` env knob (apps/lumen/internal/server/server.go)
  skips the `runTimerWorker` goroutine at startup. Default behaviour
  unchanged (fail-closed: only `"1"` disables; any other value keeps
  the timer on). The drill toggles the env via
  `LUMEN_CHAOS_DISABLE_TIMER=1 docker compose up -d --no-deps --force-recreate lumen`.
- "Auction expires but stays LIVE" is the degrade signal — confirmed
  via REST `/api/auctions/{id}.status == "LIVE"` past `endAtMs`, plus
  `place_bid.lua` returning `ERR_AFTER_END` (the Lua boundary check is
  intact; only the terminal-event writer is gone).
- Recovery: recreate the container without the env. The 100ms
  `timerScanInterval` + `closeDue` writes `AUCTION_SOLD` (the warm bid
  wins) within seconds; `state-expect SOLD` polls up to 10s.

---

## 5. CI

`chaos-smoke` runs only the AI phase (it reuses `make e2e-ai-offline`
which is already a CI gate). Adding the other four drills to CI would
roughly triple the e2e job wall-clock (each does a docker-compose
restart) — they are **gates for the demo runbook**, not regression
gates. The chaos harness's own correctness is covered by:

- `apps/lumen/internal/server/chaos_test.go` — unit tests for the
  dispatch validation + the pure helpers (no live stack).
- The existing `e2e-ai-offline` (run on every PR) — exercises
  `dialAndJoin` / bid roundtrip / docker `stop`+`start` cleanly.
- The 4 non-CI drills SHOULD be run locally before any PR that
  touches: `apps/lumen/internal/store/store.go`, `place_bid.lua`,
  `close_auction.lua`, `runTimerWorker`, or `Hub.subscribe`.

---

## 6. Demo runbook (T10)

The demo录像 per §10 "录像" line: record one terminal session running
`make chaos` end-to-end. The single command produces a continuous
~3-4 min log proving all five drills pass. Recording sources:

- Local terminal (OBS / asciicast / phone camera). 30-second
  highlights are fine; the full log is the artifact.
- `make chaos-redis` shown solo is the most demo-friendly clip — the
  `ERR_AUCTION_PAUSED` line on screen is the V9 §6 hard rule made
  visible.

---

## 7. Known limitations / out-of-scope

- **Single-box compose only.** The current drills run on
  `infra/docker-compose.yml`. Multi-gateway (T5) split is a future
  follow-up; the WS drill assertion ("missed events return via
  catchup") transfers as-is when gateways are stopped one at a time.
- **No partial-network partitions.** We stop full services; we do not
  inject packet loss or latency. This matches the demo runbook the
  five-component drill list calls for. Latency injection is Stretch
  (Toxiproxy) — not in T9.
- **Recording is manual.** Producing the demo video is a T10
  deliverable; this doc gives the runbook. The chaos harness itself
  is fully scripted.
