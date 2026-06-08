#!/usr/bin/env bash
# Open-source live pipeline on the worker (FAQ §4 self-built structure):
#   ffmpeg(Rolex placeholder) --RTMP--> MediaMTX --HLS--> http://<ip>:8888/live/rolex/index.m3u8
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "=== install ffmpeg + font ==="
apt-get update -qq >/dev/null 2>&1
apt-get install -y -qq ffmpeg curl tar fonts-dejavu-core >/dev/null 2>&1
ffmpeg -version 2>/dev/null | head -1 || { echo "ffmpeg install FAILED"; exit 3; }

echo "=== fetch + start MediaMTX (rtmp :1935, hls :8888) ==="
cd /root
if [ ! -x /root/mediamtx ]; then
  URL=$(curl -s https://api.github.com/repos/bluenviron/mediamtx/releases/latest | grep -o 'https://[^"]*_linux_amd64.tar.gz' | head -1)
  echo "mediamtx url: $URL"
  curl -sL "$URL" -o /root/mediamtx.tar.gz && tar xzf /root/mediamtx.tar.gz -C /root
fi
/root/mediamtx --version 2>/dev/null || echo "mediamtx version unknown"
pkill -f '/root/mediamtx' 2>/dev/null || true; sleep 1
nohup /root/mediamtx > /root/mediamtx.log 2>&1 &
sleep 2
echo "mediamtx pid: $(pgrep -f /root/mediamtx | head -1)"
tail -4 /root/mediamtx.log || true

echo "=== push Rolex placeholder loop -> rtmp://localhost:1935/live/rolex ==="
FONT=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf
pkill -f 'ffmpeg.*rtmp://localhost' 2>/dev/null || true; sleep 1
nohup ffmpeg -hide_banner -loglevel warning -re \
  -f lavfi -i color=c=0x0a0e14:s=1280x720:r=25 \
  -vf "drawtext=fontfile=$FONT:text='ROLEX  EXPLORER 114270':fontcolor=white:fontsize=60:x=(w-text_w)/2:y=270,drawtext=fontfile=$FONT:text='LUMEN  LIVE  AUCTION':fontcolor=0xC8A24B:fontsize=36:x=(w-text_w)/2:y=360,drawtext=fontfile=$FONT:text='%{localtime}':fontcolor=0x8899aa:fontsize=26:x=(w-text_w)/2:y=430" \
  -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p -g 50 -b:v 1500k \
  -f flv rtmp://localhost:1935/live/rolex > /root/ffpush.log 2>&1 &
sleep 4
echo "ffmpeg pid: $(pgrep -f 'ffmpeg.*rtmp' | head -1)"
tail -6 /root/ffpush.log || true
echo "=== local HLS probe on worker ==="
curl -s -o /dev/null -w "local hls http=%{http_code}\n" --max-time 8 http://localhost:8888/live/rolex/index.m3u8
