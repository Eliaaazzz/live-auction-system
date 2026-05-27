# Dockerfile for chaos-runner.
# Built by `docker compose -f infra/docker-compose.chaos.yml --profile chaos run --rm chaos-runner --phase ai`.
# Runs alongside the lumen stack; uses docker socket to send `compose kill` /
# `compose start` to sibling containers.

FROM golang:1.22-alpine AS build
WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -o /out/chaos-runner ./cmd/runner

FROM docker:27-cli
# `docker:27-cli` ships the docker CLI; we mount the host docker socket at
# runtime so `docker compose kill` reaches the parent compose stack.
COPY --from=build /out/chaos-runner /chaos-runner
WORKDIR /work
ENTRYPOINT ["/chaos-runner"]
