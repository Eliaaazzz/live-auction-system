#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  SRS_HOST=<ecs-public-ip-or-host> STREAM_KEY=<stream-key> scripts/srs-smoke-check.sh

Optional:
  PUSH_SMOKE=1                  Start a generated FFmpeg RTMP stream before checking HLS.
  PUSH_SECONDS=30               FFmpeg generated stream duration when PUSH_SMOKE=1.
  HLS_WARMUP_SECONDS=8          Wait time after starting FFmpeg before fetching HLS.
  RTMP_URL=<url>                Override derived rtmp://<SRS_HOST>:1935/live/<STREAM_KEY>.
  HLS_URL=<url>                 Override derived http://<SRS_HOST>:8081/live/<STREAM_KEY>.m3u8.
  SRS_COMPOSE_FILE=<path>       Compose file to snapshot with docker compose ps.
  ARTIFACT_DIR=<path>           Evidence directory. Defaults to /tmp/lumen-srs-smoke-<timestamp>.

This helper does not read .env files and does not call any cloud provider API.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

need() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "missing required tool: $name" >&2
    exit 2
  fi
}

need curl

stream_key="${STREAM_KEY:-}"
srs_host="${SRS_HOST:-}"
if [[ -z "$stream_key" ]]; then
  echo "STREAM_KEY is required" >&2
  usage >&2
  exit 2
fi
if [[ -z "$srs_host" && -z "${HLS_URL:-}" ]]; then
  echo "SRS_HOST is required unless HLS_URL is set" >&2
  usage >&2
  exit 2
fi

rtmp_url="${RTMP_URL:-rtmp://${srs_host}:1935/live/${stream_key}}"
hls_url="${HLS_URL:-http://${srs_host}:8081/live/${stream_key}.m3u8}"
push_smoke="${PUSH_SMOKE:-0}"
push_seconds="${PUSH_SECONDS:-30}"
hls_warmup_seconds="${HLS_WARMUP_SECONDS:-8}"
compose_file="${SRS_COMPOSE_FILE:-infra/srs/compose.yml}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
artifact_dir="${ARTIFACT_DIR:-/tmp/lumen-srs-smoke-${timestamp}}"

mkdir -p "$artifact_dir"

redact_url() {
  local url="$1"
  printf '%s\n' "$url" | sed -E 's#(rtmp://[^/]+/live/).*#\1<stream-key>#; s#(https?://[^/]+/live/).*#\1<stream-key>.m3u8#'
}

{
  echo "timestamp_utc=${timestamp}"
  echo "artifact_dir=${artifact_dir}"
  echo "push_smoke=${push_smoke}"
  echo "hls_url=$(redact_url "$hls_url")"
  echo "rtmp_url=$(redact_url "$rtmp_url")"
} >"${artifact_dir}/summary.env"

if command -v docker >/dev/null 2>&1 && [[ -f "$compose_file" ]]; then
  docker compose -f "$compose_file" ps >"${artifact_dir}/docker-compose-ps.txt" 2>&1 || true
fi

ffmpeg_pid=""
cleanup() {
  if [[ -n "$ffmpeg_pid" ]] && kill -0 "$ffmpeg_pid" >/dev/null 2>&1; then
    kill "$ffmpeg_pid" >/dev/null 2>&1 || true
    wait "$ffmpeg_pid" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [[ "$push_smoke" == "1" ]]; then
  need ffmpeg
  ffmpeg -hide_banner -loglevel info -re \
    -f lavfi -i testsrc=size=1280x720:rate=30 \
    -f lavfi -i sine=frequency=1000:sample_rate=48000 \
    -t "$push_seconds" \
    -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p \
    -c:a aac -b:a 128k \
    -f flv "$rtmp_url" >"${artifact_dir}/ffmpeg-push.log" 2>&1 &
  ffmpeg_pid="$!"
  sleep "$hls_warmup_seconds"
fi

curl -fsS --max-time 10 -D "${artifact_dir}/hls-headers.txt" \
  "$hls_url" -o "${artifact_dir}/playlist.m3u8"

if command -v ffprobe >/dev/null 2>&1; then
  ffprobe -hide_banner -v info -i "$hls_url" >"${artifact_dir}/ffprobe.txt" 2>&1 || true
fi

{
  echo "status=pass"
  echo "playlist_bytes=$(wc -c <"${artifact_dir}/playlist.m3u8" | tr -d ' ')"
  echo "headers=${artifact_dir}/hls-headers.txt"
  echo "playlist=${artifact_dir}/playlist.m3u8"
  [[ -f "${artifact_dir}/ffprobe.txt" ]] && echo "ffprobe=${artifact_dir}/ffprobe.txt"
  [[ -f "${artifact_dir}/ffmpeg-push.log" ]] && echo "ffmpeg_log=${artifact_dir}/ffmpeg-push.log"
} | tee -a "${artifact_dir}/summary.env"

echo "SRS smoke evidence written to ${artifact_dir}"
