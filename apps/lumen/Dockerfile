# Lumen — multi-stage build from the single root module.

# Stage 1: build the designed React frontend (apps/web). Served by lumen as
# WEB_DIR so `make up` serves the real product, not the T1 placeholder HTML.
# node_modules is .dockerignored, so `npm ci` installs clean Linux deps (the
# host's macOS esbuild binary would otherwise break the build).
FROM node:20-alpine AS webbuild
WORKDIR /web-src
COPY apps/web/package.json apps/web/package-lock.json ./
# `npm install` (not `npm ci`): the lockfile is known-incomplete (vitest 4
# nests its own vite/esbuild vs the top-level vite 5), so `npm ci`'s strict
# check fails on Linux — the CI `web` job uses `npm install` for the same reason.
RUN npm install --no-audit --no-fund
COPY apps/web/ ./
# Vite inlines VITE_* at build time. The deployed bundle MUST hit the real
# backend (same-origin /api + /ws), NOT the inline demo data — without this the
# whole app ships in mock mode (frozen room, no WS, dead bid button). #106.
ENV VITE_USE_MOCK_DATA=false
ENV VITE_API_BASE=/api
ENV VITE_WS_BASE=/ws
RUN npm run build

# Stage 2: build the Go backend.
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY . .
RUN go mod tidy
RUN CGO_ENABLED=0 go build -trimpath -o /out/lumen ./apps/lumen/cmd/lumen

FROM alpine:3.20
RUN apk add --no-cache ca-certificates wget
WORKDIR /
COPY --from=build /out/lumen /lumen
COPY --from=webbuild /web-src/dist /web
ENV WEB_DIR=/web
EXPOSE 8080
ENTRYPOINT ["/lumen"]
CMD ["serve", "--mode=all"]
