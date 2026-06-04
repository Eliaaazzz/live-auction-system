# Locust WebSocket load test for the Lumen live-auction gateway.
#
# Drives REAL concurrent WS sessions against a running stack to exercise the
# gateway's connection handling + broadcast fan-out (the path touched by #118).
#
# Prereqs:
#   1. stack up:   docker compose -f infra/docker-compose.yml up -d --build --wait
#   2. seed:       N_USERS=600 ./tools/loadtest/k6-setup.sh   (writes .k6-tokens + .k6-aid)
#   3. run (from repo root so the .k6-* files resolve):
#        python -m locust -f tools/loadtest/locustfile.py --headless \
#          -u 600 -r 60 -t 60s --host ws://localhost:8080 --only-summary
#
# Model: weighted 9:1 observers:bidders.
#   - Observer: connect → ROOM_JOIN → read broadcasts (the fan-out receivers).
#   - Bidder:   connect → ROOM_JOIN → bid current+1, measure ack RTT.
# Each phase fires a Locust request event so the summary reports connect time,
# broadcast-recv rate, and bid-ack p50/p95/p99 + failures.

import itertools
import json
import os
import time

import websocket  # websocket-client (gevent-patched by locust at startup)
from locust import User, between, events, task
from locust.exception import StopUser

# ── load the pre-staged auction id + buyer tokens (from k6-setup.sh) ──
_HERE = os.path.dirname(os.path.abspath(__file__))


def _read_first(*paths):
    for p in paths:
        if os.path.exists(p):
            with open(p) as f:
                return f.read().strip(), p
    return "", paths[0]


_AID, _aid_path = _read_first(".k6-aid", os.path.join(_HERE, ".k6-aid"))


def _load_tokens():
    for p in (".k6-tokens", os.path.join(_HERE, ".k6-tokens")):
        if os.path.exists(p):
            with open(p) as f:
                toks = [ln.strip() for ln in f if ln.strip()]
            if toks:
                return toks
    return []


_TOKENS = _load_tokens()
if not _TOKENS or not _AID:
    raise SystemExit(
        "missing .k6-tokens / .k6-aid — run `N_USERS=600 ./tools/loadtest/k6-setup.sh` first"
    )

_counter = itertools.count()
_START_PRICE = 100000  # matches k6-setup.sh startPriceCents


def _fire(env, name, ms, exc=None, length=0):
    env.events.request.fire(
        request_type="WS",
        name=name,
        response_time=ms,
        response_length=length,
        exception=exc,
        context={},
    )


def _runner_stopping(env):
    # Once Locust is stopping, a blocked recv can surface local socket teardown
    # noise as BrokenPipe/ConnectionReset. Do not count that as a server failure.
    r = getattr(env, "runner", None)
    return r is not None and getattr(r, "state", "") in ("stopping", "stopped", "cleanup")


class _WSBase(User):
    abstract = True

    def on_start(self):
        self.n = next(_counter)
        self.token = _TOKENS[self.n % len(_TOKENS)]
        self.uid = self.token.split(".")[0]
        self.cur = _START_PRICE
        self.ws = None
        t0 = time.time()
        try:
            self.ws = websocket.create_connection(
                f"{self.host}/ws?token={self.token}",
                timeout=15,
                # Match the Go wsload harness: non-browser clients send no
                # Origin. websocket-client otherwise emits Origin: http://<host>,
                # which fails when Docker-network hosts differ from FRONTEND_ORIGIN.
                suppress_origin=True,
            )
            _fire(self.environment, "connect", (time.time() - t0) * 1000)
        except Exception as e:  # noqa: BLE001
            _fire(self.environment, "connect", (time.time() - t0) * 1000, exc=e)
            raise StopUser()
        try:
            self.ws.send(
                json.dumps(
                    {
                        "schemaVersion": 2,
                        "type": "ROOM_JOIN",
                        "auctionId": _AID,
                        "serverTimeMs": int(t0 * 1000),
                        "data": {"auctionId": _AID},
                    }
                )
            )
        except Exception as e:  # noqa: BLE001
            _fire(self.environment, "room_join", 0, exc=e)
            raise StopUser()

    def _apply(self, raw):
        try:
            env = json.loads(raw)
        except Exception:  # noqa: BLE001
            return None
        d = env.get("data") or {}
        c = d.get("currentPriceCents") or (
            d.get("amountCents") if env.get("type") == "BID_ACCEPTED" else None
        )
        if c:
            try:
                self.cur = max(self.cur, int(c))
            except (TypeError, ValueError):
                pass
        return env

    def on_stop(self):
        try:
            if self.ws:
                self.ws.close()
        except Exception:  # noqa: BLE001
            pass


class Observer(_WSBase):
    weight = 9
    wait_time = between(0.2, 0.6)

    @task
    def read(self):
        if not self.ws:
            raise StopUser()
        try:
            self.ws.settimeout(2.0)
            raw = self.ws.recv()
            self._apply(raw)
            _fire(self.environment, "broadcast_recv", 0, length=len(raw))
        except websocket.WebSocketTimeoutException:
            pass  # quiet room window — fine
        except Exception as e:  # noqa: BLE001
            if not _runner_stopping(self.environment):
                _fire(self.environment, "recv_err", 0, exc=e)
            raise StopUser()


class Bidder(_WSBase):
    weight = 1
    wait_time = between(0.4, 0.9)

    @task
    def bid(self):
        if not self.ws:
            raise StopUser()
        amt = self.cur + 1
        t0 = time.time()
        try:
            self.ws.send(
                json.dumps(
                    {
                        "schemaVersion": 2,
                        "type": "BID_PLACE",
                        "auctionId": _AID,
                        "serverTimeMs": int(t0 * 1000),
                        "data": {"clientBidId": f"loc_{self.n}_{amt}", "amountCents": str(amt)},
                    }
                )
            )
        except Exception as e:  # noqa: BLE001
            _fire(self.environment, "bid_send", 0, exc=e)
            raise StopUser()

        deadline = t0 + 3.0
        while time.time() < deadline:
            try:
                self.ws.settimeout(max(0.05, deadline - time.time()))
                raw = self.ws.recv()
            except websocket.WebSocketTimeoutException:
                break
            except Exception as e:  # noqa: BLE001
                if not _runner_stopping(self.environment):
                    _fire(self.environment, "recv_err", 0, exc=e)
                raise StopUser()
            env = self._apply(raw)
            if not env:
                continue
            t = env.get("type")
            d = env.get("data") or {}
            if t == "BID_ACCEPTED" and d.get("userId") == self.uid and str(d.get("amountCents")) == str(amt):
                _fire(self.environment, "bid_ack", (time.time() - t0) * 1000)
                return
            if t == "BID_REJECTED":
                # Contention rejects are expected, but keep the machine code
                # visible so abnormal rejects cannot hide in one aggregate bucket.
                code = d.get("code") or "UNKNOWN"
                _fire(self.environment, f"bid_rejected:{code}", (time.time() - t0) * 1000)
                return
        _fire(self.environment, "bid_no_ack", (time.time() - t0) * 1000, exc=Exception("no ack in 3s"))
