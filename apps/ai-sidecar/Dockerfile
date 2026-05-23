# AI sidecar (mock in T1) — separate image so chaos drills can kill it alone.
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY . .
RUN go mod tidy
RUN CGO_ENABLED=0 go build -trimpath -o /out/sidecar ./apps/ai-sidecar/cmd/sidecar

FROM alpine:3.20
RUN apk add --no-cache ca-certificates wget
COPY --from=build /out/sidecar /sidecar
EXPOSE 8090
ENTRYPOINT ["/sidecar"]
