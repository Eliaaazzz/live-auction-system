# Self-hosted SRS live-video runbook

Scope: issue #121 primary video path. This is the no-domain fallback for the demo cloud plan: run an open-source media server on ECS, push real OBS/FFmpeg video into it, and let the auction room play the resulting HLS URL.

## Contract

- SRS is display-only. It must not adjudicate bids, close auctions, write auction state, or affect Redis Lua / Redis Stream / Replay Verifier behavior.
- The authoritative auction path remains: API / WebSocket -> Redis Lua bid adjudicator -> Redis Stream event log -> Timer Worker close -> MySQL projection / evidence.
- `livePlayUrl` is an additive presentation field. If it is absent or unreachable, the room must fall back to the simulated live feed and bidding must continue.
- `pushUrl` is operator-only material for seller/admin consoles. Do not expose stream keys in public room snapshots.
- This runbook contains no secrets and no cloud-provider credentials.

## Topology

```text
OBS or FFmpeg
  -> rtmp://<ECS_PUBLIC_IP>:1935/live/<streamKey>
SRS on ECS
  -> HLS:      http://<ECS_PUBLIC_IP>:8081/live/<streamKey>.m3u8
  -> HTTP-FLV: http://<ECS_PUBLIC_IP>:8081/live/<streamKey>.flv
Viewer room
  -> hls.js loads livePlayUrl when present
```

Run SRS on the same ECS for MVP/demo simplicity. If media load starts to distort bid SLO measurements, move SRS to a second ECS or CDN-backed provider and keep the same `livePlayUrl` contract.

## ECS security group

Open only what the rehearsal needs, and close demo-only ports afterward.

| Port | Purpose | Exposure rule |
|---|---|---|
| `80` / `443` | Lumen app and WebSocket | public demo endpoint |
| `1935` | RTMP ingest | restrict to operator IPs when possible |
| `8081` | HLS / HTTP-FLV playback | public during demo window |
| `3306` / `6379` | MySQL / Redis | private VPC only, never public |

Record teardown with `scripts/deploy-teardown-checklist.sh` after rehearsal or demo.

## Start SRS

From the repository root on the ECS host:

```bash
docker compose -f infra/srs/compose.yml up -d
```

Optional bind overrides:

```bash
SRS_RTMP_BIND=10.0.0.12:1935 SRS_HLS_BIND=0.0.0.0:8081 \
  docker compose -f infra/srs/compose.yml up -d
```

## Push a smoke stream with FFmpeg

Use a generated test pattern when OBS is not available:

```bash
export ECS_PUBLIC_IP=<ecs-public-ip>
export STREAM_KEY=auction-demo-$(date +%Y%m%d%H%M%S)

ffmpeg -re \
  -f lavfi -i testsrc=size=1280x720:rate=30 \
  -f lavfi -i sine=frequency=1000:sample_rate=48000 \
  -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p \
  -c:a aac -b:a 128k \
  -f flv "rtmp://${ECS_PUBLIC_IP}:1935/live/${STREAM_KEY}"
```

Expected playback URLs:

```text
http://<ecs-public-ip>:8081/live/<streamKey>.m3u8
http://<ecs-public-ip>:8081/live/<streamKey>.flv
```

## Push with OBS

OBS settings:

| Field | Value |
|---|---|
| Service | Custom |
| Server | `rtmp://<ECS_PUBLIC_IP>:1935/live` |
| Stream Key | `<streamKey>` |

Use the generated `streamKey` for the auction being demonstrated. Treat the RTMP URL as operator-only material.

## Wire into Lumen

When the backend live-video contract is enabled:

- Generate a per-auction `streamKey` before the live room opens.
- Return `pushUrl=rtmp://<ECS_PUBLIC_IP>:1935/live/<streamKey>` only to seller/admin surfaces.
- Return `livePlayUrl=http://<ECS_PUBLIC_IP>:8081/live/<streamKey>.m3u8` in the public room snapshot.
- Keep the Volcengine Live path interchangeable by emitting a different `livePlayUrl` later; do not change frontend playback semantics.

## Verification checklist

Capture evidence under `/tmp/lumen-srs-smoke-<timestamp>/`.

- `docker compose -f infra/srs/compose.yml ps` shows SRS running.
- FFmpeg or OBS pushes to `rtmp://<ECS_PUBLIC_IP>:1935/live/<streamKey>` without reconnect loops.
- Browser or `ffprobe` can read `http://<ECS_PUBLIC_IP>:8081/live/<streamKey>.m3u8`.
- Auction room renders the live feed when `livePlayUrl` is present.
- Killing FFmpeg or blocking `8081` makes the room fall back without breaking bid placement.
- A normal bid/load smoke still uses Redis Lua and returns ordered bid events.
- Replay Verifier output is unchanged by video activity.
- Teardown closes `1935` and `8081` unless another rehearsal is scheduled.

## 100k-readiness boundary

The 100k proof is about auction correctness and bid fanout, not media fanout through Lumen. SRS must stay outside the auction hot path:

- Do not proxy HLS segments through the Lumen API or WebSocket gateway.
- Do not include video fetch latency in bid ack/broadcast SLOs.
- Run load tests with video disabled first, then repeat a smaller video-on rehearsal to prove the fallback and user experience.
- If a 100k viewer media demo is required, use a separate media fleet/CDN and keep the same `livePlayUrl` field.
