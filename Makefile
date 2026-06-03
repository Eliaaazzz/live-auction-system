# Lumen Auction — T1 targets. Demo path = a sequence of make targets (per #14).
COMPOSE := docker compose -f infra/docker-compose.yml
E2E_AID_FILE := .e2e-auction-id
LOAD_AID_FILE := .load-auction-id
CHAOS_AID_FILE := .chaos-auction-id
CHAOS_TOKEN_FILE := .chaos-buyer-token
WEB_SMOKE_BASE_URL ?= http://localhost:8080
WEB_SMOKE_BASE_URL := $(strip $(WEB_SMOKE_BASE_URL))
WEB_SMOKE_BASE_URL := $(patsubst %/,%,${WEB_SMOKE_BASE_URL})
LOAD_100K_REHEARSAL_ARGS ?= --confirm
DEPLOY_REHEARSAL_TARGET ?= 500
DEPLOY_REHEARSAL_AID ?= auc_demo
DEPLOY_REHEARSAL_100K_TARGET ?= 100000
DEPLOY_REHEARSAL_100K_AID ?= $(DEPLOY_REHEARSAL_AID)
DEPLOY_REHEARSAL_100K_ACK_P95_MAX_MS ?= 800
DEPLOY_REHEARSAL_100K_BROADCAST_P95_MAX_MS ?= 1000
DEPLOY_REHEARSAL_100K_HAMMER_P95_MAX_MS ?= 2000
DEPLOY_REHEARSAL_100K_CATCHUP_P95_MAX_MS ?= 3000
DEPLOY_REHEARSAL_100K_REQUIRE_HAMMER ?= 1
DEPLOY_REHEARSAL_100K_REQUIRE_CATCHUP ?= 1
DEPLOY_REHEARSAL_100K_REPORT_ONLY ?= 0
DEPLOY_REHEARSAL_METRICS ?=
REPEAT_LOAD_SMOKE_ARGS ?=

.PHONY: up down logs seed seed-fresh api-smoke-pr103 web-smoke-check web-smoke-prepare web-smoke web-smoke-ratelimit web-smoke-ratelimit-prepare web-smoke-selfbid web-smoke-selfbid-prepare web-smoke-multitab web-smoke-multitab-prepare web-smoke-vickrey web-smoke-vickrey-prepare e2e-dummy-bid perf-smoke e2e-ai-offline deploy-perf-rehearsal deploy-perf-rehearsal-100k load load-smoke load-100k load-100k-preflight load-100k-rehearse verify verify-evidence build vet test fmt guard review-scripts-check \
        chaos chaos-ai chaos-redis chaos-mysql chaos-ws chaos-timer chaos-smoke _chaos-restart-lumen-default _chaos-restart-lumen-no-timer \
        demo demo-smoke review-pr-dependency review-pr-dependency-json review-queue-all review-queue-all-strict review-issue-candidates review-smoke review-ops-summary review-ops-summary-json review-issue-ref-audit review-root-cause review-root-cause-json review-blocker-priority review-blocker-priority-json review-rest-audit review-rest-audit-json load-smoke-repeat

WEB_SMOKE_AUTO_UP ?= 0
WEB_SMOKE_AUTO_SEED ?= 0
WEB_SMOKE_AUTO_SEED_FORCE ?= 0
WEB_SMOKE_AID ?= $(or $(VERIFY_AID),$(AUCTION_ID),auc_demo)
WEB_SMOKE_AID_EFF = $(or $(strip $(WEB_SMOKE_AID)), $(strip $(VERIFY_AID)), $(strip $(AUCTION_ID)), auc_demo)
WEB_SMOKE_SCHEMA_VERSION ?=
WEB_SMOKE_SCHEMA_ENV = $(if $(strip $(WEB_SMOKE_SCHEMA_VERSION)),WEB_SMOKE_SCHEMA_VERSION="$(WEB_SMOKE_SCHEMA_VERSION)" SCHEMA_VERSION="$(WEB_SMOKE_SCHEMA_VERSION)",)
WEB_SMOKE_ID_ENV = WEB_SMOKE_AID="$(WEB_SMOKE_AID_EFF)" VERIFY_AID="$(WEB_SMOKE_AID_EFF)" AUCTION_ID="$(WEB_SMOKE_AID_EFF)"
REVIEW_REQUIRED_SCRIPTS := \
  scripts/review-pr-dependency.sh \
  scripts/review-project-status.sh \
  scripts/review-open-prs.sh \
  scripts/review-open-issues.sh \
  scripts/review-blocker-digest.sh \
  scripts/review-issue-ref-audit.sh \
  scripts/review-root-cause.sh \
  scripts/review-blocker-priority.sh \
  scripts/review-issue-candidates.sh \
  scripts/review-rest-audit.sh \
  scripts/review-ops-summary.sh \
  scripts/review-queue.sh \
  scripts/review-smoke.sh \
  scripts/smoke-pr103-api.sh

## --- sanity ---
review-scripts-check:
	@missing=0; \
	for script in $(REVIEW_REQUIRED_SCRIPTS); do \
		if [ ! -f "$$script" ]; then \
			echo "FAIL: required script missing: $$script"; missing=1; \
		elif [ ! -x "$$script" ]; then \
			echo "FAIL: required script not executable: $$script"; missing=1; \
		fi; \
	done; \
	if [ "$$missing" != "0" ]; then exit 1; fi

## --- local stack (needs Docker) ---
up:               ## build + start full stack (redis, mysql, lumen, ai-sidecar)
	$(COMPOSE) up -d --build --wait --wait-timeout 300
	@echo "admin:  $(WEB_SMOKE_BASE_URL)/admin.html"
	@echo "mobile: $(WEB_SMOKE_BASE_URL)/room.html?auction=auc_demo"

down:             ## stop stack + wipe volumes
	$(COMPOSE) down -v

logs:
	$(COMPOSE) logs -f lumen

seed:             ## idempotent dev seed (user + product + LIVE auction)
	$(COMPOSE) exec -T lumen /lumen seed

seed-fresh:       ## forced seed for deterministic smoke (rebuild demo redis state)
	$(COMPOSE) exec -T lumen /lumen seed --force

api-smoke-pr103: review-scripts-check ## T10 API smoke: auth/product/auction/evidence/leaderboard/freeze paths and auth-guard checks
	@./scripts/smoke-pr103-api.sh --base-url "$(or $(API_SMOKE_BASE_URL),http://localhost:8080)" $(if $(API_SMOKE_UP),--up,) $(if $(API_SMOKE_DOWN),--down,)

web-smoke-check:  ## T6 preflight for web smoke (health + seed presence)
	@if [ "$(WEB_SMOKE_AUTO_UP)" = "1" ] && ! curl -sf "$(WEB_SMOKE_BASE_URL)/healthz" >/dev/null 2>&1; then \
		echo "INFO: WEB_SMOKE_AUTO_UP=1, starting stack (make up)..."; \
		$(MAKE) up; \
	fi
	@if ! curl -sf "$(WEB_SMOKE_BASE_URL)/healthz" >/dev/null 2>&1; then \
		echo "FAIL: backend not healthy at $(WEB_SMOKE_BASE_URL)/healthz"; \
		echo "Fix: make up"; echo "Hint: make web-smoke-prepare"; exit 1; \
	fi
	@echo "Backend healthy."
	@if [ "$(WEB_SMOKE_AUTO_SEED_FORCE)" = "1" ]; then \
		echo "INFO: WEB_SMOKE_AUTO_SEED_FORCE=1, refreshing demo auction..."; \
		$(MAKE) seed-fresh; \
	elif [ "$(WEB_SMOKE_AUTO_SEED)" = "1" ] && ! curl -sf "$(WEB_SMOKE_BASE_URL)/api/auctions/$(WEB_SMOKE_AID)" >/dev/null 2>&1; then \
		echo "INFO: WEB_SMOKE_AUTO_SEED=1, seeding demo auction..."; \
		$(MAKE) seed; \
	fi
	@if ! curl -sf "$(WEB_SMOKE_BASE_URL)/api/auctions/$(WEB_SMOKE_AID)" >/dev/null 2>&1; then \
		echo "WARN: $(WEB_SMOKE_AID) missing or /api/auctions/$(WEB_SMOKE_AID) unavailable; run make seed."; \
		echo "Hint: make web-smoke-prepare"; \
		exit 1; \
	fi
	@echo "$(WEB_SMOKE_AID) seeded."

web-smoke:        ## T6: run web-side smoke scripts (requires stack up + seed, e.g. make up && make seed)
	@$(MAKE) web-smoke-check WEB_SMOKE_AUTO_UP=$(WEB_SMOKE_AUTO_UP) WEB_SMOKE_AUTO_SEED_FORCE=1 WEB_SMOKE_AID="$(WEB_SMOKE_AID_EFF)" WEB_SMOKE_SCHEMA_VERSION="$(WEB_SMOKE_SCHEMA_VERSION)"
	cd apps/web && $(WEB_SMOKE_ID_ENV) $(WEB_SMOKE_SCHEMA_ENV) npm run -s smoke:all

web-smoke-prepare: ## T6: prepare smoke prerequisites only (make up + make seed)
	@$(MAKE) web-smoke-check WEB_SMOKE_AUTO_UP=1 WEB_SMOKE_AUTO_SEED=1 WEB_SMOKE_AUTO_SEED_FORCE=1 WEB_SMOKE_AID="$(WEB_SMOKE_AID_EFF)" WEB_SMOKE_SCHEMA_VERSION="$(WEB_SMOKE_SCHEMA_VERSION)"

web-smoke-ratelimit: ## T6: run only TC-T6-116 (single-socket burst -> ERR_RATE_LIMITED)
	@$(MAKE) web-smoke-check WEB_SMOKE_AUTO_UP=$(WEB_SMOKE_AUTO_UP) WEB_SMOKE_AUTO_SEED_FORCE=1 WEB_SMOKE_AID="$(WEB_SMOKE_AID_EFF)" WEB_SMOKE_SCHEMA_VERSION="$(WEB_SMOKE_SCHEMA_VERSION)"
	cd apps/web && $(WEB_SMOKE_ID_ENV) $(WEB_SMOKE_SCHEMA_ENV) npm run -s smoke:ratelimit

web-smoke-ratelimit-prepare: ## T6: auto-prepare (up+seed) then run TC-T6-116
	@$(MAKE) web-smoke-ratelimit WEB_SMOKE_AUTO_UP=1 WEB_SMOKE_AUTO_SEED=1 WEB_SMOKE_AUTO_SEED_FORCE=1 WEB_SMOKE_AID="$(WEB_SMOKE_AID_EFF)" WEB_SMOKE_SCHEMA_VERSION="$(WEB_SMOKE_SCHEMA_VERSION)"

web-smoke-selfbid: ## T6: run only TC-T6-115 (seller self-bid rejected)
	@$(MAKE) web-smoke-check WEB_SMOKE_AUTO_UP=$(WEB_SMOKE_AUTO_UP) WEB_SMOKE_AUTO_SEED_FORCE=1 WEB_SMOKE_AID="$(WEB_SMOKE_AID_EFF)" WEB_SMOKE_SCHEMA_VERSION="$(WEB_SMOKE_SCHEMA_VERSION)"
	cd apps/web && $(WEB_SMOKE_ID_ENV) $(WEB_SMOKE_SCHEMA_ENV) npm run -s smoke:selfbid

web-smoke-selfbid-prepare: ## T6: auto-prepare (up+seed) then run TC-T6-115
	@$(MAKE) web-smoke-selfbid WEB_SMOKE_AUTO_UP=1 WEB_SMOKE_AUTO_SEED=1 WEB_SMOKE_AUTO_SEED_FORCE=1 WEB_SMOKE_AID="$(WEB_SMOKE_AID_EFF)" WEB_SMOKE_SCHEMA_VERSION="$(WEB_SMOKE_SCHEMA_VERSION)"

web-smoke-multitab: ## T6: run only TC-T6-113 (same-account bid on tab1 should be visible on tab2)
	@$(MAKE) web-smoke-check WEB_SMOKE_AUTO_UP=$(WEB_SMOKE_AUTO_UP) WEB_SMOKE_AUTO_SEED_FORCE=1 WEB_SMOKE_AID="$(WEB_SMOKE_AID_EFF)" WEB_SMOKE_SCHEMA_VERSION="$(WEB_SMOKE_SCHEMA_VERSION)"
	cd apps/web && $(WEB_SMOKE_ID_ENV) $(WEB_SMOKE_SCHEMA_ENV) npm run -s smoke:multitab

web-smoke-multitab-prepare: ## T6: auto-prepare (up+seed) then run TC-T6-113
	@$(MAKE) web-smoke-multitab WEB_SMOKE_AUTO_UP=1 WEB_SMOKE_AUTO_SEED=1 WEB_SMOKE_AUTO_SEED_FORCE=1 WEB_SMOKE_AID="$(WEB_SMOKE_AID_EFF)" WEB_SMOKE_SCHEMA_VERSION="$(WEB_SMOKE_SCHEMA_VERSION)"

web-smoke-vickrey: ## T6: run only Vickrey/AuctionMode second-price closure smoke
	@$(MAKE) web-smoke-check WEB_SMOKE_AUTO_UP=$(WEB_SMOKE_AUTO_UP) WEB_SMOKE_AUTO_SEED_FORCE=1 WEB_SMOKE_AID="$(WEB_SMOKE_AID_EFF)" WEB_SMOKE_SCHEMA_VERSION="$(WEB_SMOKE_SCHEMA_VERSION)"
	cd apps/web && $(WEB_SMOKE_ID_ENV) $(WEB_SMOKE_SCHEMA_ENV) WEB_SMOKE_USE_PRESET_AUCTION="$(WEB_SMOKE_USE_PRESET_AUCTION)" npm run -s smoke:vickrey

web-smoke-vickrey-prepare: ## T6: auto-prepare (up+seed) then run second-price smoke
	@$(MAKE) web-smoke-vickrey WEB_SMOKE_AUTO_UP=1 WEB_SMOKE_AUTO_SEED=1 WEB_SMOKE_AUTO_SEED_FORCE=1 WEB_SMOKE_USE_PRESET_AUCTION="$(WEB_SMOKE_USE_PRESET_AUCTION)" WEB_SMOKE_AID="$(WEB_SMOKE_AID_EFF)" WEB_SMOKE_SCHEMA_VERSION="$(WEB_SMOKE_SCHEMA_VERSION)"

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

load:             ## T8 P0 gate: 500 connected + 50 active, asserts §4.2 budgets, exit!=0 on breach + Verifier consistent on post-load auctions.
	@# Run the load harness; tee to stdout AND to a log so we can extract the
	@# LOAD_AUCTION_IDS after the run (or legacy LOAD_AUCTION_ID if needed).
	@# The run continues for LOAD_DURATION_SEC. We capture IDs even on failure
	@# so an operator can `make verify VERIFY_AID=<id>` manually.
	@set -e; mkdir -p .load-logs
	@logfile=".load-logs/load-$$(date +%Y%m%dT%H%M%S).log"; \
	set +e; set -o pipefail; $(COMPOSE) --profile tools run --rm --build load 2>&1 | tee "$$logfile"; rc=$$?; set +o pipefail; set -e; \
	auction_ids="$$(grep -m1 '^LOAD_AUCTION_IDS=' $$logfile | sed 's/^LOAD_AUCTION_IDS=//')"; \
	if [ -z "$$auction_ids" ]; then \
		aid="$$(grep -m1 '^LOAD_AUCTION_ID=' $$logfile | sed 's/^LOAD_AUCTION_ID=//')"; \
		auction_ids="$$aid"; \
	else \
		aid="$$(printf '%s' "$$auction_ids" | tr -d '\r' | tr ',' ' ' | awk '{print $$1}')"; \
	fi; \
	auction_ids="$$(printf '%s' "$$auction_ids" | tr -d '\r' | tr ',' ' ')"; \
	if [ -z "$$aid" ]; then \
		echo "make load: FAIL — missing LOAD_AUCTION_IDS (or legacy LOAD_AUCTION_ID) in $$logfile"; \
		exit 2; \
	fi; \
	printf '%s\n' "$$aid" > $(LOAD_AID_FILE); \
	echo "load auction captured: $$aid → $(LOAD_AID_FILE)"; \
	if [ -n "$$auction_ids" ]; then echo "load auction ids: $$auction_ids"; fi; \
	if [ $$rc -ne 0 ]; then echo "make load: FAIL (rc=$$rc) — see $$logfile"; exit $$rc; fi; \
	for aid in $$auction_ids; do \
		if [ -z "$$aid" ]; then continue; fi; \
		echo ">>> make verify (auction $$aid)"; \
		printf '%s\n' "$$aid" > $(LOAD_AID_FILE); \
		$(MAKE) verify VERIFY_AID="$$aid" || exit $$?; \
	done
	@# T8 acceptance §9: Verifier consistent on post-load auctions. CI red if any step fails.
	@# MAXLEN trim guard: load uses a long auction with bounded events (~6k at default), well
	@# under the verifier replay budget — see docs/perf-report.md for the trim/replay alignment.

load-smoke:       ## CI-cheap load smoke: small N, short window, relaxed budgets — exercises the load + verify chain so the harness itself stays a regression net.
	@# Tunables chosen so a GitHub runner (2 vCPU / 7 GiB) finishes in <30 s.
	@set -e; mkdir -p .load-logs
	@logfile=".load-logs/load-smoke-$$(date +%Y%m%dT%H%M%S).log"; \
	set +e; set -o pipefail; $(COMPOSE) --profile tools run --rm --build \
		-e LOAD_OBSERVERS=25 -e LOAD_BIDDERS=5 -e LOAD_DURATION_SEC=10 \
		-e LOAD_BID_INTERVAL_MS=100 \
		-e LOAD_ACK_P95_MS=400 -e LOAD_BROADCAST_P95_MS=800 \
		-e LOAD_HAMMER_P95_MS=2000 -e LOAD_SCRIPT_P99_MS=20 \
		-e LOAD_AUCTION_DUR_SEC=120 -e LOAD_OBSERVER_STAGGER_MS=20 \
	load 2>&1 | tee "$$logfile"; rc=$$?; set +o pipefail; set -e; \
	auction_ids="$$(grep -m1 '^LOAD_AUCTION_IDS=' $$logfile | sed 's/^LOAD_AUCTION_IDS=//')"; \
	if [ -z "$$auction_ids" ]; then \
		aid="$$(grep -m1 '^LOAD_AUCTION_ID=' $$logfile | sed 's/^LOAD_AUCTION_ID=//')"; \
		auction_ids="$$aid"; \
	else \
		aid="$$(printf '%s' "$$auction_ids" | tr -d '\r' | tr ',' ' ' | awk '{print $$1}')"; \
	fi; \
	auction_ids="$$(printf '%s' "$$auction_ids" | tr -d '\r' | tr ',' ' ')"; \
	if [ -z "$$aid" ]; then \
		echo "make load-smoke: FAIL — missing LOAD_AUCTION_IDS (or legacy LOAD_AUCTION_ID) in $$logfile"; \
		exit 2; \
	fi; \
	printf '%s\n' "$$aid" > $(LOAD_AID_FILE); \
	if [ -n "$$auction_ids" ]; then echo "load-smoke auction ids: $$auction_ids"; fi; \
	if [ $$rc -ne 0 ]; then echo "make load-smoke: FAIL (rc=$$rc)"; exit $$rc; fi; \
	for aid in $$auction_ids; do \
		if [ -z "$$aid" ]; then continue; fi; \
		echo ">>> make verify (auction $$aid)"; \
		$(MAKE) verify VERIFY_AID="$$aid" || exit $$?; \
	done

load-smoke-repeat: ## repeat load-smoke with aggregate pass/fail summary and JSON output support
	@./scripts/repeat-load-smoke.sh $(REPEAT_LOAD_SMOKE_ARGS)

load-100k-preflight: ## Super-stretch rehearsal preflight (advisory checks before very large-scale run).
	@if [ "$${LOAD_100K_CONFIRM:-0}" != "1" ] && [ "$${LOAD_100K_CONFIRM:-}" != "true" ]; then \
		echo "load-100k is an enterprise-scale rehearsal, not a P0 gate. Set LOAD_100K_CONFIRM=1 (or true) to run this target."; \
		exit 1; \
	fi
	@echo "Super-stretch rehearsal preflight (non-P0)."
	@echo "- file-descriptor hard limit (ulimit -n): $$(ulimit -n)"
	@ulimit_n=$$(ulimit -n 2>/dev/null || echo 0); \
	if [ "$$ulimit_n" != "unlimited" ] && [ "$$ulimit_n" -lt 131072 ] && [ "$${LOAD_100K_ALLOW_LOW_ULIMIT:-}" != "1" ] && [ "$${LOAD_100K_ALLOW_LOW_ULIMIT:-}" != "true" ]; then \
		echo "FAIL: ulimit -n=$$ulimit_n is below 131072 (super-stretch threshold). Set LOAD_100K_ALLOW_LOW_ULIMIT=1 (or true) to proceed anyway."; \
		exit 1; \
	fi
	@echo "- backlog/port window:" \
	&& if [ -r /proc/sys/net/ipv4/ip_local_port_range ]; then \
			echo "  ip_local_port_range=$$(cat /proc/sys/net/ipv4/ip_local_port_range)"; \
			port_low=$$(awk '{print $$1}' /proc/sys/net/ipv4/ip_local_port_range); \
			port_high=$$(awk '{print $$2}' /proc/sys/net/ipv4/ip_local_port_range); \
			port_count=$$((port_high - port_low + 1)); \
			if [ "$$port_count" -lt 50000 ] && [ "$${LOAD_100K_ALLOW_LOW_EPHEMERAL:-}" != "1" ] && [ "$${LOAD_100K_ALLOW_LOW_EPHEMERAL:-}" != "true" ]; then \
				echo "FAIL: ephemeral range only $$port_count ports, expected >=50000 for 100k rehearsal."; \
				exit 1; \
			fi; \
		else \
			echo "  ip_local_port_range=unavailable (container/non-Linux host)"; \
		fi

load-100k:       ## Super-stretch rehearsal (non-P0): 100k observer + 2k bidders + 4 shards.
	@echo "Super-stretch rehearsal for 100k concurrency requires dedicated load sender + high-limits host."
	@$(MAKE) load-100k-preflight
	@LOAD_OBSERVERS=100000 \
		LOAD_BIDDERS=2000 \
		LOAD_SHARDS=4 \
		LOAD_DURATION_SEC=60 \
		LOAD_BID_INTERVAL_MS=100 \
		LOAD_ACK_P95_MS=800 \
		LOAD_BROADCAST_P95_MS=1000 \
		LOAD_HAMMER_P95_MS=2000 \
		LOAD_SCRIPT_P99_MS=20 \
		LOAD_CATCHUP_P95_MS=3000 \
		LOAD_AUCTION_DUR_SEC=3600 \
		LOAD_OBSERVER_STAGGER_MS=0 \
		LOAD_RESET_METRICS=1 \
		$(MAKE) load

load-100k-rehearse: ## Non-P0 100k rehearsal evidence pack (explicit --confirm required).
	@./scripts/rehearse-load-100k.sh $(LOAD_100K_REHEARSAL_ARGS)

deploy-perf-rehearsal: ## #112: deploy + preflight + server-side SLO gate + optional client observed metrics pack
	@set -eu; \
	if [ -z "$(BASE_URL)" ]; then \
		echo "missing BASE_URL (for example BASE_URL=https://example.com)"; \
		exit 1; \
	fi; \
	out_dir="$(DEPLOY_REHEARSAL_OUT_DIR)"; \
	if [ -z "$$out_dir" ]; then out_dir=".deploy-rehearsal-$$(date +%Y%m%dT%H%M%S)"; fi; \
	echo "deployment rehearsal out_dir=$$out_dir"; \
	BASE_URL="$(BASE_URL)" AID="$(DEPLOY_REHEARSAL_AID)" OUT_DIR="$$out_dir" scripts/deploy-preflight.sh; \
	server_metrics="$(DEPLOY_REHEARSAL_METRICS)"; \
	if [ -z "$$server_metrics" ]; then server_metrics="$$out_dir/metrics/body.txt"; fi; \
	if [ ! -s "$$server_metrics" ]; then \
		echo "missing server metrics artifact: $$server_metrics"; \
		exit 1; \
	fi; \
	perf_out="$$out_dir/perf-gate"; \
	if [ -n "$(PERF_GATE_OUT_DIR)" ]; then perf_out="$(PERF_GATE_OUT_DIR)"; fi; \
	if [ -n "$(PERF_GATE_CLIENT_SUMMARY)" ]; then \
		ACK_P95_MAX_MS="$(ACK_P95_MAX_MS)" \
		BROADCAST_P95_MAX_MS="$(BROADCAST_P95_MAX_MS)" \
		HAMMER_P95_MAX_MS="$(HAMMER_P95_MAX_MS)" \
		CATCHUP_P95_MAX_MS="$(CATCHUP_P95_MAX_MS)" \
		REQUIRE_HAMMER="$(REQUIRE_HAMMER)" \
		REQUIRE_CATCHUP="$(REQUIRE_CATCHUP)" \
		REPORT_ONLY="$(REPORT_ONLY)" \
		scripts/remote-perf-gate.sh --server-metrics "$$server_metrics" --client-summary "$(PERF_GATE_CLIENT_SUMMARY)" --target "$(DEPLOY_REHEARSAL_TARGET)" --out-dir "$$perf_out"; \
	else \
		ACK_P95_MAX_MS="$(ACK_P95_MAX_MS)" \
		BROADCAST_P95_MAX_MS="$(BROADCAST_P95_MAX_MS)" \
		HAMMER_P95_MAX_MS="$(HAMMER_P95_MAX_MS)" \
		CATCHUP_P95_MAX_MS="$(CATCHUP_P95_MAX_MS)" \
		REQUIRE_HAMMER="$(REQUIRE_HAMMER)" \
		REQUIRE_CATCHUP="$(REQUIRE_CATCHUP)" \
		REPORT_ONLY="$(REPORT_ONLY)" \
		scripts/remote-perf-gate.sh --server-metrics "$$server_metrics" --target "$(DEPLOY_REHEARSAL_TARGET)" --out-dir "$$perf_out"; \
	fi; \
	echo "rehearsal artifacts: preflight=$$out_dir manifest/status, perf= $$perf_out"

deploy-perf-rehearsal-100k: ## #112: remote super-stretch target (非 P0) with 默认 10万并发门禁参数
	@$(MAKE) deploy-perf-rehearsal \
		BASE_URL="$(BASE_URL)" \
		DEPLOY_REHEARSAL_TARGET="$(DEPLOY_REHEARSAL_100K_TARGET)" \
		DEPLOY_REHEARSAL_AID="$(DEPLOY_REHEARSAL_100K_AID)" \
		ACK_P95_MAX_MS="$(DEPLOY_REHEARSAL_100K_ACK_P95_MAX_MS)" \
		BROADCAST_P95_MAX_MS="$(DEPLOY_REHEARSAL_100K_BROADCAST_P95_MAX_MS)" \
		HAMMER_P95_MAX_MS="$(DEPLOY_REHEARSAL_100K_HAMMER_P95_MAX_MS)" \
		CATCHUP_P95_MAX_MS="$(DEPLOY_REHEARSAL_100K_CATCHUP_P95_MAX_MS)" \
		REQUIRE_HAMMER="$(DEPLOY_REHEARSAL_100K_REQUIRE_HAMMER)" \
		REQUIRE_CATCHUP="$(DEPLOY_REHEARSAL_100K_REQUIRE_CATCHUP)" \
		REPORT_ONLY="$(DEPLOY_REHEARSAL_100K_REPORT_ONLY)" \
		PERF_GATE_CLIENT_SUMMARY="$(PERF_GATE_CLIENT_SUMMARY)" \
		PERF_GATE_OUT_DIR="$(PERF_GATE_OUT_DIR)"

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
	@all_packages=$$(go list ./...); \
	packages=$$(printf '%s\n' "$$all_packages" | grep -v 'handoff/runs/.*/hidden-tests' || true); \
	if [ -z "$$packages" ]; then \
		echo "FAIL: no go test packages resolved"; \
		exit 1; \
	fi; \
	printf '%s\n' "$$packages" | xargs go test

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
	@echo "--- redis: fresh auction post-recovery ---"
	@$(COMPOSE) exec -T lumen /lumen chaos --phase=setup > .chaos-recover.log
	@grep -m1 '^CHAOS_AID=' .chaos-recover.log | sed 's/^CHAOS_AID=//' > $(CHAOS_AID_FILE)
	@test -s $(CHAOS_AID_FILE) || { echo "FAIL: missing CHAOS_AID from recover setup"; cat .chaos-recover.log; exit 1; }
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
	@echo ">>> [1/6] stack up + seed (seller / product / LIVE auction)"
	$(MAKE) up
	$(MAKE) seed
	@echo ">>> [2/6] section 12.1-3  list -> VLM facts draft -> seller confirm -> freeze rules -> start -> multi-viewer bid -> broadcast"
	$(MAKE) e2e-dummy-bid
	@echo ">>> [3/6] section 12.5  evidence chain -- recompute event_hash (exit!=0 on hash_break)"
	$(MAKE) verify-evidence
	@echo ">>> [4/6] section 12.6  Replay Verifier -- 3-way diff stream/redis/mysql + hash chain (consistent)"
	$(MAKE) verify
	@echo ">>> [5/6] section 12.7  monitoring 500 connected + 50 active -- ack/broadcast p95 + seq gap=0 + post-load verify"
	$(MAKE) load
	@echo ">>> [6/6] section 12.8  5 chaos drills -- ai/redis/mysql/ws/timer degrade + self-heal (chaos-ai proves V9 P3: AI down, bidding continues)"
	$(MAKE) chaos
	@echo "+==============================================================+"
	@echo "|  DEMO PATH GREEN -- every section 12 node asserted via make  |"
	@echo "|  UI: $(WEB_SMOKE_BASE_URL)/admin.html                           |"
	@echo "|      $(WEB_SMOKE_BASE_URL)/room.html?auction=auc_demo           |"
	@echo "+==============================================================+"

demo-smoke: ## T10: CI-cheap demo path (load-smoke + chaos-smoke) — orchestration regression net
	@echo ">>> demo-smoke [1/6] stack up + seed"
	$(MAKE) up
	$(MAKE) seed
	@echo ">>> demo-smoke [2/6] section 12.1-3 e2e roundtrip"
	$(MAKE) e2e-dummy-bid
	@echo ">>> demo-smoke [3/6] section 12.5 evidence hash chain"
	$(MAKE) verify-evidence
	@echo ">>> demo-smoke [4/6] section 12.6 replay verifier"
	$(MAKE) verify
	@echo ">>> demo-smoke [5/6] section 12.7 load-smoke (small N) + section 12.8 chaos-smoke (AI phase)"
	$(MAKE) load-smoke
	$(MAKE) chaos-smoke
	@echo ">>> demo-smoke [6/6] V9 P3 AI offline -> core bidding continues"
	$(MAKE) e2e-ai-offline
	@echo "demo-smoke GREEN -- demo path wiring intact"

## --- review helpers (for Codex/maintainer triage) ---
review-pr-dependency: review-scripts-check ## PR dependency readiness report (human readable, default: open PRs)
	@./scripts/review-pr-dependency.sh

review-pr-dependency-json: review-scripts-check ## PR dependency readiness report (machine JSON)
	@./scripts/review-pr-dependency.sh --json-only

review-queue-all: review-scripts-check ## full review queue in one pass (projects dashboard + issue ref audit + root-cause)
	@./scripts/review-queue.sh --json-only github.com/Eliaaazzz/live-auction-system 20 80 3

review-queue-all-strict: review-scripts-check ## review queue with strict blocker gate (non-zero on any blocker)
	@./scripts/review-queue.sh --strict --json-only github.com/Eliaaazzz/live-auction-system 20 80 3

review-smoke: review-scripts-check ## review script smoke check (JSON contracts + blocker math invariants)
	@./scripts/review-smoke.sh github.com/Eliaaazzz/live-auction-system 20 80 3

review-issue-candidates: review-scripts-check ## unassigned no-open-PR issues whose referenced items are closed/merged
	@./scripts/review-issue-candidates.sh github.com/Eliaaazzz/live-auction-system 80 3

review-ops-summary: review-scripts-check ## one-shot markdown review ops summary (snapshot + candidate issues)
	@./scripts/review-ops-summary.sh github.com/Eliaaazzz/live-auction-system 80 3

review-ops-summary-json: review-scripts-check ## review ops summary in machine JSON
	@./scripts/review-ops-summary.sh --json github.com/Eliaaazzz/live-auction-system 80 3

review-issue-ref-audit: review-scripts-check ## audit references for open issues (open refs vs closed refs)
	@./scripts/review-issue-ref-audit.sh github.com/Eliaaazzz/live-auction-system 80 3

review-rest-audit: review-scripts-check ## REST-only issue audit for API rate-limit fallback
	@./scripts/review-rest-audit.sh github.com/Eliaaazzz/live-auction-system 80 3

review-rest-audit-json: review-scripts-check ## REST-only issue audit in machine JSON
	@./scripts/review-rest-audit.sh --json-only github.com/Eliaaazzz/live-auction-system 80 3

review-root-cause: review-scripts-check ## consolidated review root-cause snapshot (blockers + candidates)
	@./scripts/review-root-cause.sh github.com/Eliaaazzz/live-auction-system 20 80 3

review-root-cause-json: review-scripts-check ## consolidated review root-cause snapshot in JSON
	@./scripts/review-root-cause.sh --json-only github.com/Eliaaazzz/live-auction-system 20 80 3

review-blocker-priority: review-scripts-check ## prioritized blocker list from root-cause (dependency-first)
	@./scripts/review-blocker-priority.sh github.com/Eliaaazzz/live-auction-system 20 80 3

review-blocker-priority-json: review-scripts-check ## prioritized blocker list in JSON
	@./scripts/review-blocker-priority.sh --json-only github.com/Eliaaazzz/live-auction-system 20 80 3
