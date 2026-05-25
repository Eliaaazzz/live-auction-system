# Lumen Auction — T1 targets. Demo path = a sequence of make targets (per #14).
COMPOSE := docker compose -f infra/docker-compose.yml
E2E_AID_FILE := .e2e-auction-id

.PHONY: up down logs seed e2e-dummy-bid perf-smoke verify verify-evidence build vet test fmt guard

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

verify:           ## replay-verifier skeleton: expect "consistent"
	@aid="$(VERIFY_AID)"; \
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
