# Lumen Auction — T1 targets. Demo path = a sequence of make targets (per #14).
COMPOSE := docker compose -f infra/docker-compose.yml

.PHONY: up down logs seed e2e-dummy-bid verify build vet test fmt guard

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
	@if git grep -nE 'ep-[0-9]{8}'; then echo "FAIL: real DOUBAO endpoint id present"; exit 1; fi
	@echo "guards passed"
