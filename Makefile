# Lumen Auction — T1 targets. Demo path = a sequence of make targets (per #14).
COMPOSE := docker compose -f infra/docker-compose.yml
E2E_AID_FILE := .e2e-auction-id
LOAD_AID_FILE := .load-auction-id
CHAOS_AID_FILE := .chaos-auction-id
CHAOS_TOKEN_FILE := .chaos-buyer-token

.PHONY: up down logs seed e2e-dummy-bid perf-smoke e2e-ai-offline load load-smoke verify verify-evidence build vet test fmt guard \
        chaos chaos-ai chaos-redis chaos-mysql chaos-ws chaos-timer chaos-smoke _chaos-restart-lumen-default _chaos-restart-lumen-no-timer \
        demo demo-smoke demo-auction demo-sudden-death demo-sealed demo-vickrey \
        k6 k6-setup k6-run

## --- local stack (needs Docker) ---
up:               ## build + start full stack (redis, mysql, lumen, ai-sidecar)
	$(COMPOSE) up -d --build --wait --wait-timeout 300
	@echo "seller admin : http://localhost:8080/admin"
	@echo "buyer room   : http://localhost:8080/room/auc_demo  (run 'make seed' first)"

down:             ## stop stack + wipe volumes
	$(COMPOSE) down -v

logs:
	$(COMPOSE) logs -f lumen

seed:             ## idempotent dev seed (user + product + LIVE auction)
	$(COMPOSE) exec -T lumen /lumen seed

e2e-dummy-bid:    ## T1 acceptance: full roundtrip, exit 0 on success
	@out="$$( $(COMPOSE) --profile tools run --rm --build e2e )"; \
	code=$$?; printf '%s\n' "$$out"; \
	if [ $$code -ne 0 ]; then exit $$code; fi; \
	aid="$$(printf '%s\n' "$$out" | sed -n 's/^E2E_AUCTION_ID=//p' | tail -n1)"; \
	test -n "$$aid" || { echo "missing E2E_AUCTION_ID from e2e output"; exit 1; }; \
	printf '%s\n' "$$aid" > $(E2E_AID_FILE)

perf-smoke:       ## T2 perf floor-check: ack/broadcast p95 vs §4.2 fallback budgets
	$(COMPOSE) --profile tools run --rm --build perf-smoke

e2e-ai-offline:   ## T7-5 chaos gate: kill ai-sidecar, assert bid path still green (V9 P3)
	@# Per issue #70 §4.5: prove AI-down does NOT block bidding.
	@# Two-phase test:
	@#   1. Stop ai-sidecar → run e2e-dummy-bid → must exit 0 (bid path
	@#      is independent of AI per V9 P3)
	@#   2. Restart ai-sidecar → run e2e-dummy-bid → must exit 0 (recovery)
	@# Uses `stop` (not `kill`) so docker-compose state stays clean and
	@# the start path restores the container without rebuild.
	@echo "=== T7-5 phase 1: stop ai-sidecar ==="
	$(COMPOSE) stop ai-sidecar
	@# Belt-and-suspenders (Elia review nit 1): assert sidecar is
	@# actually down before running the phase-1 bid. Without this,
	@# a typo in the container name (`stop` exits 0 silently) would
	@# leave AI running and the "AI-down green" claim a false-green.
	@# Allow 5s for the SIGTERM → process-exit propagation.
	@stopped=0; \
	for i in 1 2 3 4 5; do \
		if ! curl -sf http://localhost:8090/healthz >/dev/null 2>&1; then stopped=1; break; fi; \
		sleep 1; \
	done; \
	if [ "$$stopped" != "1" ]; then echo "FAIL: ai-sidecar still responding on :8090 after stop"; exit 1; fi
	@echo "=== T7-5 phase 1: run e2e-dummy-bid (expect exit 0 with AI down) ==="
	$(MAKE) e2e-dummy-bid
	@echo "=== T7-5 phase 2: restart ai-sidecar ==="
	$(COMPOSE) start ai-sidecar
	@# Wait briefly for /healthz to flip back up. The sidecar boots in
	@# ~2s in docker; give it 10s of slack on slow CI runners.
	@# Port 8090 per infra/docker-compose.yml (SIDECAR_ADDR=:8090);
	@# /healthz endpoint per apps/ai-sidecar/cmd/sidecar/main.go.
	@# Elia review nit 2: hard-fail on no recovery (don't fall through
	@# to phase-2 bid which would silently retest "AI still down").
	@recovered=0; \
	for i in 1 2 3 4 5; do \
		if curl -sf http://localhost:8090/healthz >/dev/null 2>&1; then recovered=1; break; fi; \
		echo "waiting for ai-sidecar healthz ($$i)"; sleep 2; \
	done; \
	if [ "$$recovered" != "1" ]; then echo "FAIL: ai-sidecar did not recover after start"; exit 1; fi
	@echo "=== T7-5 phase 2: run e2e-dummy-bid (expect exit 0 after recovery) ==="
	$(MAKE) e2e-dummy-bid
	@echo "✓ T7-5 PASSED · bid path stayed green throughout AI down + recovery"

load:             ## T8 P0 gate: 500 connected + 50 active, asserts §4.2 budgets, exit!=0 on breach + Verifier consistent on the post-load auction.
	@# Run the load harness; tee to stdout AND to a log so we can extract the
	@# LOAD_AUCTION_ID after the run (the harness prints it within the first
	@# second; the run continues for LOAD_DURATION_SEC). We capture the id even
	@# on failure so an operator can `make verify VERIFY_AID=<id>` manually.
	@set -e; mkdir -p .load-logs
	@logfile=".load-logs/load-$$(date +%Y%m%dT%H%M%S).log"; \
	set +e; bash -c 'set -o pipefail; $(COMPOSE) --profile tools run --rm --build load 2>&1 | tee "$$1"' _ "$$logfile"; rc=$$?; set -e; \
	aid="$$(grep -m1 '^LOAD_AUCTION_ID=' $$logfile | sed 's/^LOAD_AUCTION_ID=//')"; \
	if [ -n "$$aid" ]; then printf '%s\n' "$$aid" > $(LOAD_AID_FILE); echo "load auction captured: $$aid → $(LOAD_AID_FILE)"; fi; \
	if [ $$rc -ne 0 ]; then echo "make load: FAIL (rc=$$rc) — see $$logfile"; exit $$rc; fi
	@# T8 acceptance §9: Verifier consistent on the post-load auction. CI red if either step fails.
	@# MAXLEN trim guard: load uses a long auction with bounded events (~6k at default), well
	@# under the verifier replay budget — see docs/perf-report.md for the trim/replay alignment.
	@$(MAKE) verify VERIFY_AID="$$(cat $(LOAD_AID_FILE))"

load-smoke:       ## CI-cheap load smoke: small N, short window, relaxed budgets — exercises the load + verify chain so the harness itself stays a regression net.
	@# Tunables chosen so a GitHub runner (2 vCPU / 7 GiB) finishes in <30 s.
	@set -e; mkdir -p .load-logs
	@logfile=".load-logs/load-smoke-$$(date +%Y%m%dT%H%M%S).log"; \
	set +e; bash -c 'set -o pipefail; $(COMPOSE) --profile tools run --rm --build \
		-e LOAD_OBSERVERS=25 -e LOAD_BIDDERS=5 -e LOAD_DURATION_SEC=10 \
		-e LOAD_BID_INTERVAL_MS=100 \
		-e LOAD_ACK_P95_MS=400 -e LOAD_BROADCAST_P95_MS=800 \
		-e LOAD_HAMMER_P95_MS=2000 -e LOAD_SCRIPT_P99_MS=20 \
		-e LOAD_AUCTION_DUR_SEC=120 -e LOAD_OBSERVER_STAGGER_MS=20 \
		load 2>&1 | tee "$$1"' _ "$$logfile"; rc=$$?; set -e; \
	aid="$$(grep -m1 '^LOAD_AUCTION_ID=' $$logfile | sed 's/^LOAD_AUCTION_ID=//')"; \
	if [ -n "$$aid" ]; then printf '%s\n' "$$aid" > $(LOAD_AID_FILE); fi; \
	if [ $$rc -ne 0 ]; then echo "make load-smoke: FAIL (rc=$$rc)"; exit $$rc; fi
	@$(MAKE) verify VERIFY_AID="$$(cat $(LOAD_AID_FILE))"

verify:           ## T6 replay-verifier: 3-way diff (stream/mysql/snapshot) + hash chain; exit!=0 on mismatch_at_seq or hash_break_at_seq
	@aid="$(VERIFY_AID)"; \
	if [ -z "$$aid" ] && [ -f "$(LOAD_AID_FILE)" ]; then aid="$$(cat $(LOAD_AID_FILE))"; fi; \
	if [ -z "$$aid" ] && [ -f "$(E2E_AID_FILE)" ]; then aid="$$(cat $(E2E_AID_FILE))"; fi; \
	$(COMPOSE) --profile tools run --rm --build -e VERIFY_AID="$$aid" verifier

verify-evidence:  ## T4 evidence gate: recompute event_hash chain; exit!=0 on hash_break
	@aid="$(VERIFY_AID)"; \
	if [ -z "$$aid" ] && [ -f "$(E2E_AID_FILE)" ]; then aid="$$(cat $(E2E_AID_FILE))"; fi; \
	$(COMPOSE) exec -T lumen /lumen verify-evidence --auction "$$aid"

## --- pure Go (needs Go toolchain; used by CI) ---
build:
	go build ./...

vet:
	go vet ./...

test:
	go test ./...

fmt:
	gofmt -l -w .

guard:            ## cheap CI guards (git grep scans tracked files incl. binaries)
	@if git grep -nI '_v2' -- '*.lua'; then echo "FAIL: *_v2.lua naming is banned (V9)"; exit 1; fi
	@if git grep -nE 'ep-[0-9]{8}'; then echo "FAIL: real DOUBAO endpoint id present"; exit 1; fi
	@echo "guards passed"

## --- T9 chaos drills (V9 plan §10) ---
## Each phase: inject fault → assert degrade → recover → assert recovery (no seq gap) → optional verify.
## Logs are the artifact: every assertion prints `CHAOS_OK phase=... ` (success) or `CHAOS_FAIL phase=... ` (failure)
## and the harness exits non-zero on any miss. Recording for the demo is generated separately (out of CI scope).

chaos: chaos-ai chaos-redis chaos-mysql chaos-ws chaos-timer
	@echo "✓ T9 PASSED · 5/5 chaos drills (ai/redis/mysql/ws/timer)"

chaos-ai:        ## phase 1: AI sidecar — bid path independent of AI (reuses T7-5 e2e-ai-offline gate)
	@echo "=== chaos[1/5] ai-sidecar ==="
	$(MAKE) e2e-ai-offline
	@echo "✓ chaos[1/5] ai-sidecar PASSED"

chaos-redis:     ## phase 2: Redis — bid -> ERR_AUCTION_PAUSED under outage; fresh auction recovers post-restart
	@# Sequence:
	@#  1. setup auction A (warm 1 bid; seq=1 baseline) → captures CHAOS_AID + CHAOS_BUYER_TOKEN
	@#  2. stop redis → bid_expect ERR_AUCTION_PAUSED (V9 §6 hard rule ⑦)
	@#  3. start redis + restart lumen (script cache + state Hashes were lost; this
	@#     mirrors the demo runbook — Redis dev compose has no volume so the post-
	@#     restart contract is "fresh auction works", not "old auction resumes")
	@#  4. setup a FRESH auction B → expect OK_ACCEPTED (proves Redis hot path recovers)
	@#  5. verify B (3-way diff + hash chain → consistent)
	@echo "=== chaos[2/5] redis ==="
	@echo "--- redis: setup pre-fault auction ---"
	@$(COMPOSE) exec -T lumen /lumen chaos --phase=setup > .chaos-setup.log
	@grep -m1 '^CHAOS_AID=' .chaos-setup.log | sed 's/^CHAOS_AID=//' > $(CHAOS_AID_FILE)
	@grep -m1 '^CHAOS_BUYER_TOKEN=' .chaos-setup.log | sed 's/^CHAOS_BUYER_TOKEN=//' > $(CHAOS_TOKEN_FILE)
	@test -s $(CHAOS_AID_FILE) || { echo "FAIL: missing CHAOS_AID"; cat .chaos-setup.log; exit 1; }
	@echo "redis: pre-fault aid=$$(cat $(CHAOS_AID_FILE))"
	@echo "--- redis: stop ---"
	$(COMPOSE) stop redis
	@# Allow up to 15s for the lumen Redis pool to surface the outage as an
	@# EVALSHA transport error mapped to ERR_AUCTION_PAUSED. (go-redis dial
	@# default ~5s + JOIN snapshot block ~5s + bid EvalSha block ~5s = 15s
	@# ceiling.)
	@echo "--- redis: bid-expect ERR_AUCTION_PAUSED ---"
	@$(COMPOSE) exec -T lumen /lumen chaos --phase=bid-expect \
		--aid="$$(cat $(CHAOS_AID_FILE))" --token="$$(cat $(CHAOS_TOKEN_FILE))" \
		--code=ERR_AUCTION_PAUSED --timeout-ms=20000
	@echo "--- redis: start + restart lumen (script cache reload) ---"
	$(COMPOSE) start redis
	$(COMPOSE) restart lumen
	@for i in 1 2 3 4 5 6 7 8 9 10; do \
		if curl -sf http://localhost:8080/healthz >/dev/null 2>&1; then break; fi; \
		echo "waiting for lumen healthz ($$i)"; sleep 2; \
	done
	@echo "--- redis: fresh auction post-recovery (setup warms 1 bid → seq=1) ---"
	@$(COMPOSE) exec -T lumen /lumen chaos --phase=setup > .chaos-recover.log
	@grep -m1 '^CHAOS_AID=' .chaos-recover.log | sed 's/^CHAOS_AID=//' > $(CHAOS_AID_FILE)
	@test -s $(CHAOS_AID_FILE) || { echo "FAIL: missing CHAOS_AID from recover setup"; cat .chaos-recover.log; exit 1; }
	@# Wait for the warm bid to drain Stream → MySQL before verifying. After the
	@# redis wipe + lumen restart the persistence worker re-establishes its
	@# consumer group from scratch, so the projection of seq=1 lags the bid by a
	@# tick; verifying immediately races it (mismatch_at_seq=1, stream=1 mysql=0).
	@# Mirrors the chaos-mysql drain wait.
	@echo "--- redis: wait for persistence drain (events-count >= 1) ---"
	@$(COMPOSE) exec -T lumen /lumen chaos --phase=wait-events --aid="$$(cat $(CHAOS_AID_FILE))" --want-seq=1 --timeout-ms=30000
	@echo "--- redis: verify recovered auction (3-way diff + hash chain) ---"
	@$(MAKE) verify VERIFY_AID="$$(cat $(CHAOS_AID_FILE))"
	@echo "✓ chaos[2/5] redis PASSED · degrade=ERR_AUCTION_PAUSED · recover=fresh-auction-consistent"

chaos-mysql:     ## phase 3: MySQL — bid path stays alive (Redis hot path); persistence drains post-restart
	@# Sequence:
	@#  1. setup auction A (seq=1 baseline) → captures CHAOS_AID + CHAOS_BUYER_TOKEN
	@#     (token reuse avoids devLogin during the outage; devLogin writes to MySQL)
	@#  2. stop mysql → 2 more bids using cached token → expect OK_ACCEPTED
	@#     (Redis-only hot path is unaffected per V9 §3 "MySQL 不在出价热路径")
	@#  3. start mysql → wait-events until events-count >= 3 (persistence catches up)
	@#  4. verify A (consistent across stream/snapshot/mysql — the persistence
	@#     worker's idempotency is the gate)
	@echo "=== chaos[3/5] mysql ==="
	@$(COMPOSE) exec -T lumen /lumen chaos --phase=setup > .chaos-setup.log
	@grep -m1 '^CHAOS_AID=' .chaos-setup.log | sed 's/^CHAOS_AID=//' > $(CHAOS_AID_FILE)
	@grep -m1 '^CHAOS_BUYER_TOKEN=' .chaos-setup.log | sed 's/^CHAOS_BUYER_TOKEN=//' > $(CHAOS_TOKEN_FILE)
	@test -s $(CHAOS_AID_FILE) || { echo "FAIL: missing CHAOS_AID"; cat .chaos-setup.log; exit 1; }
	@echo "mysql: aid=$$(cat $(CHAOS_AID_FILE))"
	@echo "--- mysql: stop ---"
	$(COMPOSE) stop mysql
	@echo "--- mysql: bid still accepted (Redis hot path) ---"
	@$(COMPOSE) exec -T lumen /lumen chaos --phase=bid-expect \
		--aid="$$(cat $(CHAOS_AID_FILE))" --token="$$(cat $(CHAOS_TOKEN_FILE))" \
		--code=OK_ACCEPTED --timeout-ms=10000
	@$(COMPOSE) exec -T lumen /lumen chaos --phase=bid-expect \
		--aid="$$(cat $(CHAOS_AID_FILE))" --token="$$(cat $(CHAOS_TOKEN_FILE))" \
		--code=OK_ACCEPTED --timeout-ms=10000
	@echo "--- mysql: start + wait for persistence drain ---"
	$(COMPOSE) start mysql
	@for i in 1 2 3 4 5 6 7 8 9 10; do \
		if $(COMPOSE) exec -T mysql mysqladmin ping -h 127.0.0.1 -uroot -prootpw >/dev/null 2>&1; then break; fi; \
		echo "waiting for mysql ($$i)"; sleep 2; \
	done
	@# Persistence worker projects Stream → MySQL on a short tick. 3 events
	@# should drain within seconds; allow 30s slack on slow runners.
	@$(COMPOSE) exec -T lumen /lumen chaos --phase=wait-events --aid="$$(cat $(CHAOS_AID_FILE))" --want-seq=3 --timeout-ms=30000
	@echo "--- mysql: verify (consistent across stream/redis/mysql post-recovery) ---"
	@$(MAKE) verify VERIFY_AID="$$(cat $(CHAOS_AID_FILE))"
	@echo "✓ chaos[3/5] mysql PASSED · bids OK during outage · persistence drained · verifier consistent"

chaos-ws:        ## phase 4: WS gateway — connect-fails under outage; catchup post-restart proves no seq gap
	@# Sequence:
	@#  1. setup auction A (seq=1) → captures CHAOS_AID + CHAOS_BUYER_TOKEN
	@#  2. stop lumen → assert /healthz curl fails (degrade observed from the host)
	@#  3. start lumen → catchup-expect with lastSeq=1 → ROOM_SNAPSHOT.seq >= 1 (no gap)
	@#  4. fresh bid post-recovery accepted (using the cached buyer token)
	@#  5. verify A
	@echo "=== chaos[4/5] ws-gateway ==="
	@$(COMPOSE) exec -T lumen /lumen chaos --phase=setup > .chaos-setup.log
	@grep -m1 '^CHAOS_AID=' .chaos-setup.log | sed 's/^CHAOS_AID=//' > $(CHAOS_AID_FILE)
	@grep -m1 '^CHAOS_BUYER_TOKEN=' .chaos-setup.log | sed 's/^CHAOS_BUYER_TOKEN=//' > $(CHAOS_TOKEN_FILE)
	@test -s $(CHAOS_AID_FILE) || { echo "FAIL: missing CHAOS_AID"; cat .chaos-setup.log; exit 1; }
	@echo "ws: aid=$$(cat $(CHAOS_AID_FILE))"
	@echo "--- ws: stop lumen ---"
	$(COMPOSE) stop lumen
	@echo "--- ws: assert /healthz refused (degrade observed) ---"
	@if curl -sf http://localhost:8080/healthz >/dev/null 2>&1; then \
		echo "FAIL: lumen still serving /healthz after stop"; exit 1; \
	fi
	@echo "ws: gateway confirmed down"
	@echo "--- ws: start lumen ---"
	$(COMPOSE) start lumen
	@for i in 1 2 3 4 5 6 7 8 9 10; do \
		if curl -sf http://localhost:8080/healthz >/dev/null 2>&1; then break; fi; \
		echo "waiting for lumen healthz ($$i)"; sleep 2; \
	done
	@echo "--- ws: catchup with lastSeq=1 (proves no seq gap across the outage) ---"
	@$(COMPOSE) exec -T lumen /lumen chaos --phase=catchup-expect --aid="$$(cat $(CHAOS_AID_FILE))" --last-seq=1 --want-seq=1
	@echo "--- ws: fresh bid post-recovery ---"
	@$(COMPOSE) exec -T lumen /lumen chaos --phase=bid-expect \
		--aid="$$(cat $(CHAOS_AID_FILE))" --token="$$(cat $(CHAOS_TOKEN_FILE))" \
		--code=OK_ACCEPTED
	@$(MAKE) verify VERIFY_AID="$$(cat $(CHAOS_AID_FILE))"
	@echo "✓ chaos[4/5] ws-gateway PASSED · stopped→/healthz refused · started→catchup → no seq gap"

chaos-timer:     ## phase 5: Timer Worker — LIVE outlives endAtMs while disabled; hammers within 1s after re-enable
	@# Sequence:
	@#  1. setup auction A with a SHORT duration (5s) → seq=1, captures aid + token
	@#  2. stop lumen + recreate with LUMEN_CHAOS_DISABLE_TIMER=1 → wait healthz
	@#  3. sleep past endAtMs (5s + grace)
	@#  4. assert state still LIVE (timer skipped → terminal event never written)
	@#     AND late bid → ERR_AFTER_END (Lua boundary check is intact)
	@#  5. stop + recreate WITHOUT the env → timer back on → scan tick (100ms)
	@#     fires hammerDue → close_auction.lua writes AUCTION_SOLD
	@#  6. state-expect SOLD within scan tick + persistence projection
	@#  7. verify A
	@echo "=== chaos[5/5] timer ==="
	@$(COMPOSE) exec -T lumen /lumen chaos --phase=setup --duration-ms=5000 > .chaos-setup.log
	@grep -m1 '^CHAOS_AID=' .chaos-setup.log | sed 's/^CHAOS_AID=//' > $(CHAOS_AID_FILE)
	@grep -m1 '^CHAOS_BUYER_TOKEN=' .chaos-setup.log | sed 's/^CHAOS_BUYER_TOKEN=//' > $(CHAOS_TOKEN_FILE)
	@test -s $(CHAOS_AID_FILE) || { echo "FAIL: missing CHAOS_AID"; cat .chaos-setup.log; exit 1; }
	@echo "timer: aid=$$(cat $(CHAOS_AID_FILE)) (durationMs=5000)"
	@echo "--- timer: stop lumen + recreate with LUMEN_CHAOS_DISABLE_TIMER=1 ---"
	$(COMPOSE) stop lumen
	@# Force recreate so the new env var sticks. --no-deps avoids cascading
	@# restarts on healthy services.
	LUMEN_CHAOS_DISABLE_TIMER=1 $(COMPOSE) up -d --no-deps --force-recreate lumen
	@for i in 1 2 3 4 5 6 7 8 9 10; do \
		if curl -sf http://localhost:8080/healthz >/dev/null 2>&1; then break; fi; \
		echo "waiting for lumen healthz ($$i)"; sleep 2; \
	done
	@echo "--- timer: sleep past endAtMs (5s) + grace (3s) — timer is OFF so no hammer ---"
	@sleep 8
	@echo "--- timer: assert auction still LIVE (no hammer fired) AND late bid → ERR_AFTER_END ---"
	@$(COMPOSE) exec -T lumen /lumen chaos --phase=state-expect --aid="$$(cat $(CHAOS_AID_FILE))" --state=LIVE --timeout-ms=2000
	@$(COMPOSE) exec -T lumen /lumen chaos --phase=bid-expect \
		--aid="$$(cat $(CHAOS_AID_FILE))" --token="$$(cat $(CHAOS_TOKEN_FILE))" \
		--code=ERR_AFTER_END
	@echo "--- timer: restart lumen WITHOUT the env (timer back on) ---"
	$(COMPOSE) stop lumen
	$(COMPOSE) up -d --no-deps --force-recreate lumen
	@for i in 1 2 3 4 5 6 7 8 9 10; do \
		if curl -sf http://localhost:8080/healthz >/dev/null 2>&1; then break; fi; \
		echo "waiting for lumen healthz ($$i)"; sleep 2; \
	done
	@echo "--- timer: state-expect SOLD (timer re-armed → scan tick → hammerDue → close_auction.lua) ---"
	@$(COMPOSE) exec -T lumen /lumen chaos --phase=state-expect --aid="$$(cat $(CHAOS_AID_FILE))" --state=SOLD --timeout-ms=15000
	@$(MAKE) verify VERIFY_AID="$$(cat $(CHAOS_AID_FILE))"
	@echo "✓ chaos[5/5] timer PASSED · disabled→LIVE-past-endAtMs · re-enabled→SOLD within scan tick"

chaos-smoke:     ## CI-cheap chaos check: AI phase only (already wired, ~30s) — keeps the harness a regression net
	@echo "=== chaos-smoke (AI phase) ==="
	@$(MAKE) chaos-ai

## --- T10 demo orchestration (V9 §12 demo 动线 / §4.4 验收) ---
## The whole point of T10: the demo path is a SEQUENCE OF MAKE TARGETS, not a
## screen recording (§4.4 "每个 demo 节点须有对应 make 验证命令"). `make demo`
## runs the full §12 path end-to-end as one assertable run; it is green iff every
## node holds. That green run IS the T10 exit evidence ("3-min demo path = e2e
## suite green"). Each sub-target already exits non-zero on any failed assertion,
## and make aborts on the first failure — so a partial demo path can never report
## success. Needs Docker (full local stack). Leaves the stack UP afterward so you
## can show the admin/room UI live; run `make down` to tear down.

demo: ## T10: full §12 demo path as ONE assertable run (needs Docker; leaves stack up)
	@echo "+==============================================================+"
	@echo "|  Lumen Auction - T10 demo path (V9 plan section 12)          |"
	@echo "+==============================================================+"
	@echo ">>> [1/7] stack up + seed (seller / product / LIVE auction)"
	$(MAKE) up
	$(MAKE) seed
	@echo ">>> [2/7] section 12.1-3  list -> VLM facts draft -> seller confirm -> freeze rules -> start -> multi-viewer bid -> broadcast"
	$(MAKE) e2e-dummy-bid
	@echo ">>> [3/7] section 12.4-5  anti-snipe extend (AUCTION_EXTENDED) -> hammer (AUCTION_SOLD) -> evidence card (events_hash)"
	$(MAKE) demo-auction
	@echo ">>> [4/7] section 12.5  evidence chain -- recompute event_hash (exit!=0 on hash_break)"
	$(MAKE) verify-evidence
	@echo ">>> [5/7] section 12.6  Replay Verifier -- 3-way diff stream/redis/mysql + hash chain (consistent)"
	$(MAKE) verify
	@echo ">>> [6/7] section 12.7  monitoring 500 connected + 50 active -- ack/broadcast p95 + seq gap=0 + post-load verify"
	$(MAKE) load
	@echo ">>> [7/7] section 12.8  5 chaos drills -- ai/redis/mysql/ws/timer degrade + self-heal (chaos-ai proves V9 P3: AI down, bidding continues)"
	$(MAKE) chaos
	@echo "+==============================================================+"
	@echo "|  DEMO PATH GREEN -- every section 12 node asserted via make  |"
	@echo "|  UI: http://localhost:8080/admin            (seller console) |"
	@echo "|      http://localhost:8080/room/auc_demo    (buyer room)     |"
	@echo "+==============================================================+"

demo-auction:     ## T10 §12.4-5: anti-snipe extend -> hammer -> evidence on one auction (asserted)
	@# Drives the parts RunE2E stops short of: an in-window bid that extends the
	@# countdown (AUCTION_EXTENDED), a competing snipe that extends again, then —
	@# once bidding stops — the Timer Worker hammering to AUCTION_SOLD, and the
	@# evidence card publishing the hash-chain head. Runs inside the lumen
	@# container (mirrors `make chaos`), targeting its own :8080.
	@echo "=== demo-auction (section 12.4-5: anti-snipe -> hammer -> evidence) ==="
	$(COMPOSE) exec -T lumen /lumen demo-auction

demo-sudden-death: ## issue #114: SUDDEN_DEATH mode — a bid does NOT extend; hammer at original endAtMs (asserted)
	@echo "=== demo-sudden-death (mode #114: anti-snipe OFF -> no extend -> hammer -> evidence) ==="
	$(COMPOSE) exec -T lumen /lumen demo-sudden-death

demo-sealed: ## issue #114: SEALED_FIRST mode — hidden bids -> reveal at close -> winner pays own bid (asserted)
	@echo "=== demo-sealed (mode #114: hidden bids -> AUCTION_REVEALED -> AUCTION_SOLD -> evidence) ==="
	$(COMPOSE) exec -T lumen /lumen demo-sealed

demo-vickrey: ## issue #114: VICKREY mode — sealed bids; winner pays the 2nd-highest (asserted)
	@echo "=== demo-vickrey (mode #114: hidden bids -> winner pays 2nd-price -> evidence) ==="
	$(COMPOSE) exec -T lumen /lumen demo-vickrey

demo-smoke: ## T10: CI-cheap demo path (demo-auction + load-smoke + chaos-smoke) — orchestration regression net
	@echo ">>> demo-smoke [1/7] stack up + seed"
	$(MAKE) up
	$(MAKE) seed
	@echo ">>> demo-smoke [2/7] section 12.1-3 e2e roundtrip"
	$(MAKE) e2e-dummy-bid
	@echo ">>> demo-smoke [3/7] section 12.4-5 anti-snipe extend -> hammer -> evidence"
	$(MAKE) demo-auction
	@echo ">>> demo-smoke [4/7] section 12.5 evidence hash chain"
	$(MAKE) verify-evidence
	@echo ">>> demo-smoke [5/7] section 12.6 replay verifier"
	$(MAKE) verify
	@echo ">>> demo-smoke [6/7] section 12.7 load-smoke (small N) + section 12.8 chaos-smoke (AI phase)"
	$(MAKE) load-smoke
	$(MAKE) chaos-smoke
	@echo ">>> demo-smoke [7/7] V9 P3 AI offline -> core bidding continues"
	$(MAKE) e2e-ai-offline
	@echo "demo-smoke GREEN -- demo path wiring intact"

## --- T10 k6 stress (high-concurrency simulator, beyond V9 §4.2 stretch) ---
## V9 §4.2 stretch lane is 1k connected + 100 active. `make k6` drives 5000
## concurrent WS sessions (default) — proves the system holds 5×stretch
## *connection* scale, with the bid path bounded by Lua hot-path throughput.
## Not in CI (3-min run, needs k6 binary); operator-run + nightly schedule.
##
## See tools/loadtest/README.md for tunables (N_OBSERVERS / N_BIDDERS /
## DURATION / RAMP).
##
## Prerequisites:
##   - make up (stack live on :8080)
##   - k6 v1.4+ in PATH (https://k6.io/docs/get-started/installation/)
##   - python (json parser in setup script)

k6:               ## T10 stretch: 5k concurrent WS — full pipeline (setup + run)
	$(MAKE) k6-setup
	$(MAKE) k6-run

k6-setup:         ## stage 1: create auction + dev-login N_USERS buyer tokens
	@N_USERS=$${N_USERS:-5000} bash tools/loadtest/k6-setup.sh

k6-run:           ## stage 2: run k6 scenarios against the pre-staged AID + tokens
	@test -f .k6-aid || { echo "missing .k6-aid — run make k6-setup first"; exit 1; }
	@test -f .k6-tokens || { echo "missing .k6-tokens — run make k6-setup first"; exit 1; }
	@# tools/loadtest/.k6-tokens is the script-relative copy k6 open() needs;
	@# keep the repo-root file authoritative + copy into the script dir for k6.
	@cp .k6-tokens tools/loadtest/.k6-tokens
	k6 run \
		-e TOKENS=.k6-tokens \
		-e AID=$$(cat .k6-aid) \
		-e N_OBSERVERS=$${N_OBSERVERS:-4950} \
		-e N_BIDDERS=$${N_BIDDERS:-50} \
		-e DURATION=$${DURATION:-60s} \
		-e RAMP=$${RAMP:-15s} \
		--summary-trend-stats="avg,p(50),p(95),p(99),max" \
		tools/loadtest/k6-ws.js
	@echo "k6 done — server-side delta:"
	@curl -s http://localhost:8080/metrics | python -m json.tool | head -40
