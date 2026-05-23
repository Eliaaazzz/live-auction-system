# Lumen Auction — T1 targets. Demo path = a sequence of make targets (per #14).
COMPOSE := docker compose -f infra/docker-compose.yml

.PHONY: up down logs seed e2e-dummy-bid verify build vet test fmt guard

## --- local stack (needs Docker) ---
up:               ## build + start full stack (redis, mysql, lumen, ai-sidecar)
	$(COMPOSE) up -d --build --wait --wait-timeout 300
	@echo "admin:  http://localhost:8080/admin"
	@echo "mobile: http://localhost:8080/room?auction=auc_demo"

down:             ## stop stack + wipe volumes
	$(COMPOSE) down -v

logs:
	$(COMPOSE) logs -f lumen

seed:             ## idempotent dev seed (user + product + DRAFT auction + rules)
	$(COMPOSE) exec -T lumen /lumen seed

e2e-dummy-bid:    ## T1 acceptance: full roundtrip, exit 0 on success
	$(COMPOSE) --profile tools run --rm e2e

verify:           ## replay-verifier skeleton: expect "consistent"
	$(COMPOSE) --profile tools run --rm verifier

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
	@PAT='ep-20260514111437''-7crsm'; if git grep -n "$$PAT"; then echo "FAIL: leaked DOUBAO_ENDPOINT_ID present"; exit 1; fi
	@echo "guards passed"
