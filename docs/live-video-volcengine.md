# Volcengine Live video push/pull runbook

> **Status:** stretch / bonus item (FAQ §4, optional). The live room already simulates the feed
> (CSS sheen, styles.css #110); this turns it into a **real** RTMP→HLS stream.
> 🔒 **Video is NON-authoritative** (frozen in CLAUDE.md): display only, it never gates bids or state.
> If no stream is configured or live, the room silently falls back to the simulated sheen — the
> millisecond-level auction is unaffected (HLS latency of a few seconds is fine).
> ⚠️ **Volcengine Live has a hard dependency on a domain name** — B0 is the critical path (real-name review takes 1–3 days). Start it FIRST.

## B0 — Domain name (team lead, critical path, do it today)
Domestic live push/pull platforms verify domain ownership + CNAME onboarding + auth scheduling, so **a domain is mandatory**.
1. Register one (through Volcengine Domain Service or an existing registrar): check availability at `https://www.volcengine.com/product/domain-service/search`; `.top/.xyz` are cheap, `.com/.cn` look more professional.
2. Fill in the registrant plus a **real-name template** → review (1 business day, 2–3 days if slow). **Prepare the real-name template in advance.**
3. Plan 2 subdomains: `push.<domain>` (ingest) and `play.<domain>` (playback).
> ⏳ While the review is pending you can work on Part A cloud deployment in parallel (it needs no domain).

## B1–B5 — Volcengine Video Live (console)
Path: Products & Services → Video Services → Video Live. The official flow: enable the service → add accelerated domains → configure CNAME → enable HTTPS → configure value-added services → generate push/pull URLs → push → pull.
- **B1 Enable the service.**
- **B2 Add accelerated domains**: add `push.<domain>` (ingest type) and `play.<domain>` (playback type).
- **B3 Configure CNAME**: in the domain's DNS, CNAME the push/play subdomains to the targets Volcengine gives you → wait for propagation (30min–2h).
- **B4 Enable HTTPS** (on the play domain, for https playback) and **configure value-added services** (make sure **HLS** and **HTTP-FLV** output are on; transcoding/recording as needed).
- **B5 URL generator**: `AppName=live`, `StreamName=<auctionId>`, set an expiry → you get:
  - **Push** (seller/OBS): `rtmp://push.<domain>/live/<auctionId>?<sign>`
  - **Pull** (viewers): HLS `https://play.<domain>/live/<auctionId>.m3u8` (plus HTTP-FLV `.flv`)
  - Note down the **auth SignKey** (primary/backup keys) — the backend signs URLs with it.

## B6 — The backend mints per-auction URLs (env config)
The backend ships each auction's push/play URL as an **additive field** on `RoomSnapshotRules` (the same pattern as `reserveCents` in #60; see the video-feature PR for the code). `StreamName = auctionId` (deterministic, no extra stream creation needed). Configure in `infra/.env.prod`:
```bash
VOLCENGINE_LIVE_PUSH_DOMAIN=push.<domain>
VOLCENGINE_LIVE_PLAY_DOMAIN=play.<domain>
VOLCENGINE_LIVE_SIGN_KEY=<the SignKey from the Volcengine URL generator>
```
After restarting lumen:
- The play URL (HLS) automatically appears in `ROOM_SNAPSHOT.rules.livePlayUrl` → the frontend plays it.
- The signed push URL is shown to the **seller** in the Admin console when they start the auction, to paste into OBS.
- If any of the three env vars is empty → `livePlayUrl` is not sent → the room falls back to the simulated sheen (the demo does not hard-depend on a live feed).

## B7 — Seller pushes the stream (OBS Studio)
1. Install OBS (`https://obsproject.com/`).
2. Settings → Stream → Service "Custom":
   - **Server**: `rtmp://push.<domain>/live`
   - **Stream key**: `<auctionId>?<sign>` (copy it from the Admin console).
3. Capture a camera/screen → "Start Streaming". (The FFmpeg equivalent: `ffmpeg -re -i <src> -c copy -f flv "rtmp://push.<domain>/live/<auctionId>?<sign>"`.)

## B8 — Viewers pull the stream (frontend hls.js)
The render path is already in place (`<video src={videoUrl}>` in `mobile.jsx`); the video-feature PR adds: `store/auction.js` reads `livePlayUrl` from the snapshot → `LiveRoomRoute.jsx` passes `videoUrl` → `mobile.jsx` attaches the `.m3u8` with **hls.js** (Safari/iOS play it natively; Chrome/Firefox/Edge need hls.js). `hls.js` is added to `apps/web/package.json`. Low-latency FLV is optional (flv.js).

## B9 — Full-chain verification
1. Configure the B6 env vars on the backend and restart; create and start an auction.
2. Push to `rtmp://push.<domain>/live/<auctionId>` from OBS per B7.
3. Open that auction's room in a browser → you should see the **real live feed** (hls.js playing the `.m3u8`).
4. Bidding stays millisecond-level (video is non-authoritative and unaffected by HLS's multi-second latency).
5. Stop the OBS stream → the room falls back to the simulated sheen and **does not crash**.

## Verification checklist
- ✅ The CNAME has propagated; the URL generator produces push/play URLs; OBS pushes successfully (the stream shows as online under "Stream Management" in the Volcengine console).
- ✅ The room plays the real stream, and falls back to the sheen when `livePlayUrl` is empty.
- ✅ Video is non-authoritative throughout: killing the stream or high latency never affects bidding, state, or seq.
- ✅ Low-latency stretch (optional): HTTP-FLV (flv.js) or a WebRTC pull URL, taking latency from HLS's several seconds down to sub-second.
