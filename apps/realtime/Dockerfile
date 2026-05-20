FROM golang:1.23-alpine AS builder
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download || true
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/gateway ./cmd/gateway

FROM alpine:3.20
RUN apk add --no-cache ca-certificates && adduser -D -u 1000 lumen
USER lumen
COPY --from=builder /out/gateway /usr/local/bin/gateway
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/gateway"]
