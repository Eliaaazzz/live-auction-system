# Lumen backend — multi-stage build from the single root module.
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY . .
RUN go mod tidy
RUN CGO_ENABLED=0 go build -trimpath -o /out/lumen ./apps/lumen/cmd/lumen

FROM alpine:3.20
RUN apk add --no-cache ca-certificates wget
WORKDIR /
COPY --from=build /out/lumen /lumen
COPY web /web
ENV WEB_DIR=/web
EXPOSE 8080
ENTRYPOINT ["/lumen"]
CMD ["serve", "--mode=all"]
