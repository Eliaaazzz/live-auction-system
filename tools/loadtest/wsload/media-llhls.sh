#!/usr/bin/env bash
# Refine the live pipeline to TikTok-class low latency: MediaMTX Low-Latency HLS
# (CMAF parts) + small GOP. Target glass-to-glass ~1-3s (vs standard HLS ~6-10s).
set -uo pipefail
CFG=/root/mediamtx.yml
cp -a "$CFG" "${CFG}.bak.$(date +%s)" 2>/dev/null || true
set_key() { local k="$1" v="$2"; if grep -qE "^#?[[:space:]]*${k}:" "$CFG"; then sed -i -E "s|^#?[[:space:]]*${k}:.*|${k}: ${v}|" "$CFG"; else echo "${k}: ${v}" >> "$CFG"; fi; }
set_key hlsVariant lowLatency
set_key hlsSegmentCount 7
set_key hlsSegmentDuration 1s
set_key hlsPartDuration 200ms
set_key hlsAlwaysRemux yes
echo "=== hls keys now ==="; grep -E '^hls(Variant|SegmentCount|SegmentDuration|PartDuration|AlwaysRemux):' "$CFG"

echo "=== restart MediaMTX ==="
pkill -f '/root/mediamtx' 2>/dev/null || true; sleep 1
nohup /root/mediamtx "$CFG" > /root/mediamtx.log 2>&1 &
sleep 2; echo "mediamtx pid: $(pgrep -f /root/mediamtx | head -1)"; tail -3 /root/mediamtx.log || true

echo "=== re-push Rolex (small GOP -g 25 = 1s keyframe, aligns LL parts) ==="
FONT=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf
pkill -f 'ffmpeg.*rtmp://localhost' 2>/dev/null || true; sleep 1
nohup ffmpeg -hide_banner -loglevel warning -re -f lavfi -i color=c=0x0a0e14:s=1280x720:r=25 \
  -vf "drawtext=fontfile=$FONT:text='ROLEX  EXPLORER 114270':fontcolor=white:fontsize=60:x=(w-text_w)/2:y=270,drawtext=fontfile=$FONT:text='LUMEN LIVE AUCTION  LL-HLS':fontcolor=0xC8A24B:fontsize=34:x=(w-text_w)/2:y=360,drawtext=fontfile=$FONT:text='%{localtime}':fontcolor=0x8899aa:fontsize=26:x=(w-text_w)/2:y=430" \
  -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p -g 25 -keyint_min 25 -sc_threshold 0 -b:v 1500k \
  -f flv rtmp://localhost:1935/live/rolex > /root/ffpush.log 2>&1 &
sleep 6
echo "ffmpeg pid: $(pgrep -f 'ffmpeg.*rtmp' | head -1)"
echo "=== LL-HLS markers (EXT-X-PART / PART-INF / SERVER-CONTROL = low latency on) ==="
curl -s -L -c /tmp/cj -b /tmp/cj --max-time 8 http://localhost:8888/live/rolex/index.m3u8 | head -8
echo "--- media playlist LL markers ---"
curl -s -L -c /tmp/cj -b /tmp/cj --max-time 8 "http://localhost:8888/live/rolex/$(curl -s -L -c /tmp/cj -b /tmp/cj --max-time 6 http://localhost:8888/live/rolex/index.m3u8 | grep -m1 'stream.m3u8')" 2>/dev/null | grep -E 'SERVER-CONTROL|PART-INF|EXT-X-PART|TARGETDURATION' | head -6
