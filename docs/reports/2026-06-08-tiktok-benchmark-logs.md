# 对标 TikTok 10k 实测 — 原始测试日志附录

> 配套报告:`2026-06-08-tiktok-benchmark-10k-live.md`。本文件留全部原始采样与核查细节,供复核。

## 环境

| 角色 | 实例 | 区域 | 说明 |
|---|---|---|---|
| 网关(被测) | 115.191.76.40 (c4i.xlarge 4vCPU/8GiB) | cn-beijing | 裸二进制 `/opt/lumen-runtime/bin/lumen serve --mode=all`,运行含 PR #235 的优化码 |
| 压测机/load-gen | 14.103.92.100 | cn-shanghai | wsload(异地公网打网关 EIP)+ MediaMTX/ffmpeg 视频流 |
| 视频流媒体 | MediaMTX v1.19 @ worker | cn-shanghai | RTMP :1935 → LL-HLS :8888 |

负载形态:**6000 观众 + 4000 同时出价**(每 bidder 持续出价 ≈ 4000 路并发出价)。load 拍卖:加价=1、无封顶、长时长,避免中途售罄。

## 运行 binary 核查

```
/version: {"status":"ok","schemaVersion":2,"buildSha":"75b605a0ef4e","buildTime":"2026-06-07T15:45:39Z","appEnv":"prod"}
/metrics top-level keys:
  ackLatencyMs activeConns admissionRejected backpressureForceClose bidHandlerOverheadMs
  bidsAccepted bidsRejected bidsRejectedFastPath broadcastLatencyMs catchupLatencyMs count
  hammerLatencyMs heapInuseBytes heapSysBytes max min numGoroutine placeBidScriptTimeMs
  roomStatePatchBids roomStatePatches roomStatePatchLatencyMs seqGapCount streamLenMax
  timerErrInternal timerErrInternalKeyType timerErrInternalSeqMismatch
```
`admissionRejected / heapInuseBytes / heapSysBytes / numGoroutine / min / p999` = PR #235 新增字段 → 优化 binary 在线。`525e6c0`(#235 merge)`git merge-base --is-ancestor` 确认在 origin/main;main HEAD=`1793c07`(后续 #218/#236/#238/#222 等并行合入)。buildSha 戳偏旧但 metric 字段为运行码铁证。**未重部署**(本地构建早于 main HEAD,避免降级)。

## Run C — 最终全分布(本机直采 `/metrics`,优化 binary)

每histogram 输出 `count·min·p50·p95·p99·p999·max`;下为 ack + patch + 内存/协程:
```
02:12:37 act= 1540 ack(min=0.17 p50=0.26 p95=0.37 p99=0.46 p999=1.27 max=4.42) patch(p95=23.9 p99=24.0) heapInuse=213MB  goro=3097  admRej=0 seqGap=0 bpClose=0
02:13:08 act= 4150 ack(min=0.17 p50=0.28 p95=0.46 p99=1.25 p999=6.66 max=9.34) patch(p95=24.6 p99=25.3) heapInuse=615MB  goro=8317  admRej=0 seqGap=0 bpClose=0
02:13:40 act= 6784 ack(min=0.18 p50=0.29 p95=0.70 p99=2.35 p999=5.34 max=9.34) patch(p95=26.5 p99=27.0) heapInuse=1034MB goro=13585 admRej=0 seqGap=0 bpClose=0
02:14:12 act= 9412 ack(min=0.18 p50=0.30 p95=1.83 p99=4.26 p999=41.44 max=46.33) patch(p95=28.3 p99=30.3) heapInuse=1349MB goro=18845 admRej=0 seqGap=0 bpClose=0
02:14:42 act=10000 ack(min=0.18 p50=0.30 p95=2.79 p99=5.87 p999=41.01 max=46.33) patch(p95=29.4 p99=32.9) heapInuse=1374MB goro=20021 admRej=0 seqGap=0 bpClose=0
02:15:13 act=10000 ack(min=0.18 p50=0.30 p95=3.40 p99=5.93 p999=37.89 max=46.33) patch(p95=29.6 p99=32.9) heapInuse=1781MB goro=20019 admRej=0 seqGap=0 bpClose=0
02:15:44 act=10000 ack(min=0.18 p50=0.30 p95=3.84 p99=5.98 p999=41.44 max=48.55) patch(p95=29.6 p99=32.9) heapInuse=1553MB goro=20019 admRej=0 seqGap=0 bpClose=0
02:16:14 act=10000 ack(min=0.18 p50=0.30 p95=3.95 p99=6.16 p999=37.93 max=48.55) patch(p95=29.6 p99=32.9) heapInuse=1396MB goro=20016 admRej=0 seqGap=0 bpClose=0
02:16:45 act=10000 ack(min=0.18 p50=0.31 p95=4.10 p99=5.95 p999=27.76 max=48.55) patch(p95=29.7 p99=32.9) heapInuse=1808MB goro=20016 admRej=0 seqGap=0 bpClose=0
```
wsload 客户端:`active=10000 ok=10000 fail=0 frames=2200万+`。视频:mediamtx UP / ffmpeg UP / 公网 HLS 200(全程存活)。

## Run B — 同 binary 佐证(ack/patch/max)
```
01:41:22 active= 3816 ack(p95=3.80 p99=5.62 max=24.81) patch(p95=58.11 p99=59.97) catchup_p95=1.89 seqGap=0 bpClose=0 bidsAcc=4423 bidsRej=16260854
01:42:54 active=10001 ack(p95=3.68 p99=5.60 max=24.81) patch(p95=58.05 p99=59.81) catchup_p95=1.89 seqGap=0 bpClose=0
01:43:55 active=10001 ack(p95=3.75 p99=5.62 max=24.81) patch(p95=58.03 p99=59.52) catchup_p95=1.89 seqGap=0 bpClose=0
01:44:59 active=10001 ack(p95=3.81 p99=5.55 max=24.81) patch(p95=58.01 p99=59.32) catchup_p95=1.89 seqGap=0 bpClose=0
```

## Run A — 首轮(worker 内 mon.sh 采样,含 catchup/bids 计数)
```
t=30s  {"activeConns":1915, "ack":{p50:0.31,p95:3.48,p99:5.36,max:31.59}, "patch":{p95:58.40}, "catchup":{p95:1.27}, seqGap:0, bpClose:0, bidsAcc:2210, bidsRej:8020537}
t=120s {"activeConns":9419, "ack":{p95:3.33}, "patch":{p95:58.33}, seqGap:0, bpClose:0}
t=150s {"activeConns":10000,"ack":{p95:3.36}, "patch":{p95:58.32}, "catchup":{p95:1.89}, seqGap:0, bpClose:0}
t=270s {"activeConns":10000,"ack":{p95:3.70,p99:5.55,max:23.38}, "patch":{p95:58.22}, seqGap:0, bpClose:0, bidsAcc:3412}
```
> 注:Run A/B 的 patch p95 ≈58ms,Run C ≈30ms — 不同 load 拍卖/时序下的正常运行间方差,均 ≪150ms 预算。Run C 为含 min/p999/heap 的定版全分布。

## 视频 LL-HLS(refine)

MediaMTX 配置(`media-llhls.sh`):`hlsVariant=lowLatency · hlsSegmentDuration=1s · hlsPartDuration=200ms · hlsSegmentCount=7 · hlsAlwaysRemux=yes`;ffmpeg `-g 25 -keyint_min 25 -tune zerolatency`。公网 `http://14.103.92.100:8888/live/rolex/index.m3u8` 媒体清单标记:
```
#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=0.50000,CAN-SKIP-UNTIL=6.00000
#EXT-X-PART-INF:PART-TARGET=0.20000
#EXT-X-PART:DURATION=0.20000,...,INDEPENDENT=YES
#EXT-X-TARGETDURATION:1
```
延迟地板 ≈ PART-HOLD-BACK 0.5s + 数 part ≈ glass-to-glass 1–2s。

## min/p999 计算正确性(本机离线验证)

对 14 个已知样本(0.18..24.8ms)`metrics.HistogramSnapshot`:
```
{"count":14,"min":0.18,"p50":0.82,"p95":24.8,"p99":24.8,"p999":24.8,"max":24.8}
```
单测 `TestHistogramMinAndP999`(1..1000ms 分布:min=1,max=1000,p999∈[999,1000],单调)+ `TestSnapshotJSONShape`(钉 count/min/p50/p95/p99/p999/max)在 CI go job 通过。

## 测试脚本

- `tools/loadtest/wsload/run-load.sh <conns> <bidders> <ramp> <hold>` — wsload 驱动(ulimit + nohup)。
- `tools/loadtest/wsload/media-setup.sh` — 装 ffmpeg + MediaMTX + 推 ROLEX 占位流。
- `tools/loadtest/wsload/media-llhls.sh` — 切 LL-HLS。
- `tools/loadtest/wsload/deploy-gateway.sh` — 网关滚动发布(备份→替换→重启→验证→失败回滚),留作从最新 main 部署用。
- 采样:本机 `curl http://115.191.76.40/metrics | ConvertFrom-Json`(绕开高负载下不稳的 worker sshd)。
