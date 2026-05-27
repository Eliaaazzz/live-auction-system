# Lumen Auction — T1 targets. Demo path = a sequence of make targets (per #14).
COMPOSE := docker compose -f infra/docker-compose.yml
E2E_AID_FILE := .e2e-auction-id
LOAD_AID_FILE := .load-auction-id

.PHONY: up down logs seed e2e-dummy-bid perf-smoke e2e-ai-offline load load-smoke verify verify-evidence build vet test fmt guard

## --- local stack (needs Docker) ---
up:               ## build + start full stack (redis, mysql, lumen, ai-sidecar)
	$(COMPOSE) up -d --build --wait --wait-timeout 300
	@echo "admin:  http://localhost:8080/admin.html"
	@echo "mobile: http://localhost:8080/room.html?auction=auc_demo"

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
	set +e; $(COMPOSE) --profile tools run --rm --build load 2>&1 | tee "$$logfile"; rc=$$?; set -e; \
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
	set +e; $(COMPOSE) --profile tools run --rm --build \
		-e LOAD_OBSERVERS=25 -e LOAD_BIDDERS=5 -e LOAD_DURATION_SEC=10 \
		-e LOAD_BID_INTERVAL_MS=100 \
		-e LOAD_ACK_P95_MS=400 -e LOAD_BROADCAST_P95_MS=800 \
		-e LOAD_HAMMER_P95_MS=2000 -e LOAD_SCRIPT_P99_MS=20 \
		-e LOAD_AUCTION_DUR_SEC=120 -e LOAD_OBSERVER_STAGGER_MS=20 \
		load 2>&1 | tee "$$logfile"; rc=$$?; set -e; \
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
