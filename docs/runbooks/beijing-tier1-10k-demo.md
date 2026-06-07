# Beijing Tier-1 10k Runbook · 万人并发验证手册 (issue #231)

> **Goal:** produce a credible **10,000 concurrent WebSocket auction** proof for
> the ByteDance mentor demo **without** the public-IP self-dial that failed every
> Beijing run so far — and drive a live capacity panel on screen.
>
> **What this proves:** the production `lumen` gateway holds 10k live sessions
> over a **real network path** (independent in-VPC worker → private LB → gateway)
> with the V9 §4.2 budgets met and the correctness invariants intact.
>
> **What it does *not* claim:** 10k from the *public internet*. That is the
> Tier-2 step (one extra out-of-VPC worker → public LB); see §8. Keep the two
> claims separate when you narrate.

---

## 1. Why Tier-1 (the #231 lesson in three lines)

Issue #231 showed the app was never the bottleneck: the same production binary
held **10k on loopback (Test C)** and **10k on the private IP (Test D)** with
server ack p95 ≈ 0.5 ms, `seqGapCount=0`, Replay Verifier consistent. Every
*failure* (Locust public, wsload public) was **connection establishment over the
gateway's own public EIP** — a NAT hairpin self-dial that Alibaba/Volcengine ECS
will not route. The fix is not a code change to the auction model; it is to stop
self-dialing the EIP and instead drive load from an **independent worker over a
private path**.

---

## 2. Topology

```
        ┌─────────────────────────── Beijing VPC ───────────────────────────┐
        │                                                                    │
        │   ┌──────────────────┐        private        ┌──────────────────┐  │
        │   │  load worker ECS │  ws://<private-lb>:80  │  gateway ECS     │  │
        │   │  wsload-linux    │ ────────────────────▶ │  lumen (prod)    │  │
        │   │  (NEW, Tier-1)   │                        │  Redis + MySQL   │  │
        │   └──────────────────┘                        └──────────────────┘  │
        │            │                                          ▲             │
        │            └──────── wsdash.py watches /metrics ──────┘             │
        └────────────────────────────────────────────────────────────────────┘
                       ✗  NEVER: worker ──▶ ws://<public-EIP>  (hairpin, #231)
```

- **NEW infra to provision (the only Tier-1 cost):**
  1. **1 load-worker ECS** in the **same VPC** as the gateway (e.g. 4 vCPU / 8 GiB
     is plenty; wsload drives 10k in ~200 MB). Bump `ulimit -n` to ≥ 1048576.
  2. **1 private/internal LB** (Alibaba SLB / Volcengine CLB, **internal** address)
     in front of the gateway `:80`, with WebSocket upgrade allowed and a long
     idle/tunnel timeout (≥ 900s). Targeting the gateway **private IP** directly
     also works and skips the LB, but the LB is the production-correct shape and
     the one to demo.

---

## 3. Pre-flight checklist (before you spend a 10k ramp)

- [ ] Worker ECS is in the gateway VPC and can reach the **private** LB/IP.
- [ ] `ulimit -n` on the worker ≥ 1048576 (`ulimit -n 1048576`).
- [ ] Gateway `/version` returns the expected build (`curl http://<private-lb>/version`).
- [ ] You have **≥ 10,000 production buyer tokens** (see §5). Do **not** re-enable
      `/api/dev-login`.
- [ ] A **fresh LIVE load auction** exists with `endAtMs` well in the future (§4).

---

## 4. Step 1 — seed a fresh LIVE load auction (on the gateway)

A stale `auc_load_*` row that still shows `LIVE` but is past `endAtMs` only
produces `ERR_AFTER_END` rejects — not a bidding proof (see the 2026-06-06
readiness report). Always seed fresh:

```bash
# on the gateway host (adjust to your prod runtime exec path)
docker compose -f infra/docker-compose.prod.yml exec lumen \
  /lumen seed-load --duration-sec 1800
# → capture the printed auction id:
export LOAD_AUCTION_ID=auc_load_xxxxxxxxxxxxxxxxx
```

Confirm it is LIVE and not expired:

```bash
curl -s "http://<private-lb>/api/auctions/$LOAD_AUCTION_ID" | \
  jq '{status, endAtMs, currentPriceCents}'
```

---

## 5. Step 2 — mint ≥ 10,000 production buyer tokens (no dev-login)

Production keeps `/api/dev-login` disabled (good). Mint ordinary buyer tokens via
the public `/api/login` path into a **non-tracked** file (never print or commit
tokens):

```bash
mkdir -p /opt/lumen-load && cd /opt/lumen-load
# NOTE: `seq` yields integers only — the {} substitution into `sh -c` is safe
# here. Never adapt this to substitute user-supplied strings into the shell.
seq 1 10000 | xargs -P 80 -I{} sh -c '
  curl -s http://<private-lb>/api/login \
    -H "content-type: application/json" \
    -d "{\"nickname\":\"load-{}\"}" | jq -r .token' \
  > tokens-current.txt
sort -u tokens-current.txt | grep -E "^user_.+\..+" > t && mv t tokens-current.txt
chmod 600 tokens-current.txt
ls -la tokens-current.txt   # confirm 600 BEFORE proceeding
wc -l tokens-current.txt    # expect >= 10000
```

> `tokens-current.txt` holds live credentials — keep it on the worker only and
> never commit it. The repo root `.gitignore` ignores `tokens-current.txt` and
> `tokens-*.txt` (added with this runbook) as a safety net, but the real rule is
> simple: **keep tokens at `/opt/lumen-load/` (outside the repo tree) and never
> print them.** Do not re-enable `/api/dev-login`.

---

## 6. Step 3 — build + ship wsload, then run 10k over the **private** path

On your dev box (or the worker, if it has Go):

```bash
tools/loadtest/wsload/build-linux.sh          # → tools/loadtest/wsload/wsload-linux
scp tools/loadtest/wsload/wsload-linux  root@<worker>:/opt/lumen-load/
scp tools/loadtest/wsdash.py            root@<worker>:/opt/lumen-load/   # optional, can run on gateway
```

On the **worker**, run wsload against the **private** LB/IP. The built-in
preflight (issue #231) probes 20 connections first and **aborts in seconds** if
the path can't establish them — so a misconfigured LB or an accidental public-IP
target fails fast instead of burning a 10k ramp:

```bash
cd /opt/lumen-load
ulimit -n 1048576
./wsload-linux \
  -host ws://<private-lb>:80 \
  -aid  "$LOAD_AUCTION_ID" \
  -tokens tokens-current.txt \
  -conns 9900 -bidders 100 \
  -ramp 120s -hold 600s
```

- If the preflight aborts pointing at a **public IP** → you targeted the EIP;
  switch `-host` to the private LB/IP (that is the whole point of #231).
- To override in a controlled experiment: `-preflight=warn` (proceed) or
  `-preflight=off` (skip). Default `abort` is correct for the real run.

---

## 7. Step 4 — live capacity panel + evidence capture

**During the hold window**, on the gateway (or any host that can reach
`/metrics`), drive the live demo panel:

```bash
python3 wsdash.py --target http://<private-lb> --target-conns 10000 --interval 2
```

The headline turns **green `10000 READY [PASS]`** only when `activeConns ≥ 10000`
**and** every §4.2 latency gate holds **and** `seqGapCount == 0` **and**
`backpressureForceClose == 0`. That single line is the demo money shot.

Capture no-secret evidence in parallel (for the report / fallback):

```bash
# machine-readable metrics stream for the artifact bundle
python3 wsdash.py --target http://<private-lb> --json >> metrics-window.jsonl &
# host snapshots on BOTH gateway and worker during the hold
ss -s ; sar -n DEV 1 5 ; pidstat 1 5
```

---

## 8. Step 5 — settle + Replay Verifier (the correctness proof)

After the hold ends and the auction settles:

```bash
# on the gateway host
docker compose -f infra/docker-compose.prod.yml exec lumen \
  /lumen verify --auction "$LOAD_AUCTION_ID"
# expect: consistent — stream == mysql == snapshot_seq, no mismatch/hash_break
```

---

## 9. Pass criteria — the Tier-1 bar

| Source | Metric | Gate |
|---|---|---|
| wsload (worker aggregate) | `connect_ok` | **= 10000** |
| wsload | `connect_fail` / `closed_early` | **= 0** |
| server `/metrics` | `activeConns` | **≥ 10000** (held ≥ 5 min) |
| server `/metrics` | `ackLatencyMs.p95` | **< 80 ms** |
| server `/metrics` | `broadcastLatencyMs.p95` | **< 150 ms** |
| server `/metrics` | `roomStatePatchLatencyMs.p95` | **< 150 ms** |
| server `/metrics` | `catchupLatencyMs.p95` | **< 1 s** |
| server `/metrics` | `seqGapCount` | **= 0** |
| server `/metrics` | `backpressureForceClose` | **= 0** |
| Replay Verifier | `stream == mysql == snapshot_seq` | **consistent** |

If any line fails, report **"10k connection+fanout held; <failing line> not met"**
with the named bottleneck — do not round up to a clean pass.

---

## 10. Live demo script · 现场 3 分钟动线

1. **同一个生产进程**: `curl http://<private-lb>/version` — show it matches the
   evidence build. "演示用的就是生产二进制。"
2. **拉起负载**: kick off the wsload run (or have it already at hold). Switch to
   `wsdash.py` — narrate `activeConns` climbing to **10,000**, ack p95 sub-ms,
   broadcast p95 ≪ 150 ms. "连接扇出已经到万人，服务端裁决依然亚毫秒。"
3. **正确性锤击**: point at `seqGapCount=0` and `backpressureForceClose=0` while
   bids hammer. "万人争抢，价格单调、恰好一个赢家、零序号空洞。"
4. **可审计**: run `/lumen verify` → `consistent`. "Stream / Redis / MySQL 三方一致 + hash 链。"
5. **诚实边界**: "连接扇出与竞价裁决在 10k 已实证；公网独立 worker 是 Tier-2，方案
   就绪（私网 LB 已在链路上，加一台 VPC 外机器即可）。"

---

## 11. Demo fallback (always have this ready)

- Pre-record a clean Tier-1 run (terminal with `wsdash.py` going green +
  `/lumen verify` consistent) the day before. If the live network misbehaves,
  play the recording and show the captured `metrics-window.jsonl`.
- Keep a no-secret evidence tarball (wsload log + `metrics-window.jsonl` + host
  snapshots + verifier output). Tokens, env files, and keys are **excluded**.

---

## 12. Scaling past Tier-1

- **Tier-2 (public proof):** add **one** out-of-VPC / other-region ECS worker and
  point `-host` at the gateway's **public LB** (a real CLB/ALB, *not* the raw
  EIP — that is what hairpins). Same pass bar; this is the "真公网万人" trophy.
- **Multi-worker scale-out (100k path):** shard tokens with
  `tools/loadtest/wsload/split-tokens.sh` and fan out across workers; the
  automated multi-worker SSH wrapper lands in PR #229
  (`scripts/beijing-wsload-remote-10k-evidence.sh`) — use it once merged.
