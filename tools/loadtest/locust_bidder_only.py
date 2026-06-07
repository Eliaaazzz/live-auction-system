# Locust bidder-only WebSocket load test for Lumen.
#
# Purpose: prove that N concurrent users are not just connected, but actually
# drive the BID_PLACE -> BID_ACCEPTED/BID_REJECTED hot path on one LIVE auction.
#
# Usage:
#   $env:LOAD_AUCTION_ID="auc_..."
#   $env:TOKENS_FILE="C:\path\to\tokens.txt"
#   $env:BIDS_PER_BIDDER="1"
#   python -m locust -f tools/loadtest/locust_bidder_only.py --headless \
#     --host ws://115.191.76.40 -u 1000 -r 100 -t 90s --only-summary
#
# Tokens are one per line, produced by POST /api/login or /api/dev-login.

import itertools
import json
import os
import time

import requests
import websocket  # websocket-client; gevent-patched by Locust
from locust import User, between, events, task
from locust.exception import StopUser


_HERE = os.path.dirname(os.path.abspath(__file__))


def _read_first(*paths):
    for p in paths:
        if p and os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                return f.read().strip(), p
    return "", paths[0] if paths else ""


def _load_tokens():
    candidates = [
        os.environ.get("TOKENS_FILE", ""),
        ".k6-tokens",
        os.path.join(_HERE, ".k6-tokens"),
    ]
    for p in candidates:
        if p and os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                toks = [ln.strip() for ln in f if ln.strip()]
            if toks:
                return toks, p
    return [], ""


_AID = os.environ.get("LOAD_AUCTION_ID", "").strip()
if not _AID:
    _AID, _ = _read_first(".k6-aid", os.path.join(_HERE, ".k6-aid"))

_TOKENS, _tokens_path = _load_tokens()
if not _AID or not _TOKENS:
    raise SystemExit("missing LOAD_AUCTION_ID/.k6-aid or TOKENS_FILE/.k6-tokens")

_counter = itertools.count()
_BIDS_PER_BIDDER = int(os.environ.get("BIDS_PER_BIDDER", "1"))
_BID_INTERVAL_MS = int(os.environ.get("BID_INTERVAL_MS", "1000"))
_ACK_TIMEOUT_SEC = float(os.environ.get("ACK_TIMEOUT_SEC", "5"))
_CONNECT_TIMEOUT_SEC = float(os.environ.get("CONNECT_TIMEOUT_SEC", "20"))
_START_PRICE = int(os.environ.get("LOAD_START_CENTS", "100000"))
_BID_START_DELAY_SEC = float(os.environ.get("BID_START_DELAY_SEC", "0"))
_BID_COMMAND = os.environ.get("BID_COMMAND", "ws").strip().lower()
_HTTP_HOST_ENV = os.environ.get("HTTP_HOST", "").strip()
_STOP_AFTER_BID = os.environ.get("STOP_AFTER_BID", "0").strip().lower() in ("1", "true", "yes")
_PROCESS_START = time.time()


def _fire(env, name, ms, exc=None, length=0, request_type="WS"):
    env.events.request.fire(
        request_type=request_type,
        name=name,
        response_time=ms,
        response_length=length,
        exception=exc,
        context={},
    )


def _runner_stopping(env):
    r = getattr(env, "runner", None)
    return r is not None and getattr(r, "state", "") in ("stopping", "stopped", "cleanup")


class BidderOnly(User):
    wait_time = between(max(_BID_INTERVAL_MS / 1000.0, 0.001), max(_BID_INTERVAL_MS / 1000.0, 0.001))

    def on_start(self):
        self.n = next(_counter)
        self.token = _TOKENS[self.n % len(_TOKENS)]
        self.uid = self.token.split(".", 1)[0]
        self.cur = _START_PRICE
        self.ws = None
        self.http_host = _HTTP_HOST_ENV or self.host.replace("wss://", "https://", 1).replace("ws://", "http://", 1)
        self.sent = 0
        self.done = False
        self.pending_amount = None
        self.pending_since = None
        t0 = time.time()
        try:
            self.ws = websocket.create_connection(
                f"{self.host}/ws?token={self.token}",
                timeout=_CONNECT_TIMEOUT_SEC,
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
                        "serverTimeMs": int(time.time() * 1000),
                        "data": {"auctionId": _AID},
                    }
                )
            )
            _fire(self.environment, "room_join", 0)
        except Exception as e:  # noqa: BLE001
            _fire(self.environment, "room_join", 0, exc=e)
            raise StopUser()

    def on_stop(self):
        try:
            if self.ws:
                self.ws.close()
        except Exception:  # noqa: BLE001
            pass

    def _apply(self, raw):
        try:
            env = json.loads(raw)
        except Exception:  # noqa: BLE001
            return None
        data = env.get("data") or {}
        cents = data.get("currentPriceCents")
        if env.get("type") == "BID_ACCEPTED":
            cents = data.get("amountCents") or cents
        if cents:
            try:
                self.cur = max(self.cur, int(cents))
            except (TypeError, ValueError):
                pass
        return env

    def _next_amount(self):
        # Wall-clock microseconds are globally increasing enough for distributed
        # Locust workers and stay below 2^53, avoiding Lua double precision drift.
        wall_us = time.time_ns() // 1000
        return max(self.cur + 1, wall_us + (self.n % 1000))

    def _read_once(self):
        try:
            self.ws.settimeout(2.0)
            raw = self.ws.recv()
            env = self._apply(raw)
            if env and self._record_late_outcome(env, raw):
                return
            _fire(self.environment, "frame_recv", 0, length=len(raw))
        except websocket.WebSocketTimeoutException:
            pass
        except Exception as e:  # noqa: BLE001
            if not _runner_stopping(self.environment):
                _fire(self.environment, "recv_err", 0, exc=e)
            raise StopUser()

    def _record_late_outcome(self, env, raw):
        if not self.pending_amount or not self.pending_since:
            return False
        data = env.get("data") or {}
        typ = env.get("type")
        elapsed_ms = (time.time() - self.pending_since) * 1000
        if typ == "BID_ACCEPTED" and data.get("userId") == self.uid and str(data.get("amountCents")) == self.pending_amount:
            _fire(self.environment, "late_bid_ack", elapsed_ms, length=len(raw))
            self.pending_amount = None
            self.pending_since = None
            return True
        if typ == "BID_REJECTED":
            code = data.get("code") or "UNKNOWN"
            _fire(self.environment, f"late_bid_rejected:{code}", elapsed_ms, length=len(raw))
            self.pending_amount = None
            self.pending_since = None
            return True
        return False

    def _bid_once(self):
        amount = str(self._next_amount())
        self.sent += 1
        t0 = time.time()
        self.pending_amount = amount
        self.pending_since = t0
        if _BID_COMMAND == "http":
            self._bid_once_http(amount, t0)
            return
        try:
            self.ws.send(
                json.dumps(
                    {
                        "schemaVersion": 2,
                        "type": "BID_PLACE",
                        "auctionId": _AID,
                        "serverTimeMs": int(t0 * 1000),
                        "data": {
                            "clientBidId": f"locbid_{os.getpid()}_{self.n}_{self.sent}_{time.time_ns()}",
                            "amountCents": amount,
                        },
                    }
                )
            )
            _fire(self.environment, "bid_send", 0)
        except Exception as e:  # noqa: BLE001
            _fire(self.environment, "bid_send", 0, exc=e)
            raise StopUser()

        deadline = t0 + _ACK_TIMEOUT_SEC
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
            data = env.get("data") or {}
            typ = env.get("type")
            if typ == "BID_ACCEPTED" and data.get("userId") == self.uid and str(data.get("amountCents")) == amount:
                _fire(self.environment, "bid_ack", (time.time() - t0) * 1000)
                self.pending_amount = None
                self.pending_since = None
                return
            if typ == "BID_ACCEPTED" and data.get("userId") == self.uid:
                _fire(self.environment, "self_ack_amount_mismatch", 0, length=len(raw))
                continue
            if typ == "BID_ACCEPTED":
                _fire(self.environment, "other_bid_accepted", 0, length=len(raw))
                continue
            if typ == "ROOM_STATE_PATCH":
                _fire(self.environment, "patch_before_outcome", 0, length=len(raw))
                continue
            if typ == "BID_REJECTED":
                code = data.get("code") or "UNKNOWN"
                _fire(self.environment, f"bid_rejected:{code}", (time.time() - t0) * 1000)
                self.pending_amount = None
                self.pending_since = None
                return
            _fire(self.environment, "pre_outcome_frame", 0, length=len(raw))

        _fire(self.environment, "bid_no_ack", (time.time() - t0) * 1000, exc=Exception("no ack in timeout"))

    def _bid_once_http(self, amount, t0):
        payload = {
            "clientBidId": f"locbid_{os.getpid()}_{self.n}_{self.sent}_{time.time_ns()}",
            "amountCents": amount,
        }
        try:
            resp = requests.post(
                f"{self.http_host}/api/auctions/{_AID}/bids",
                headers={"Authorization": f"Bearer {self.token}"},
                json=payload,
                timeout=_ACK_TIMEOUT_SEC,
            )
        except Exception as e:  # noqa: BLE001
            _fire(self.environment, "bid_command", (time.time() - t0) * 1000, exc=e, request_type="HTTP")
            return

        elapsed = (time.time() - t0) * 1000
        if resp.status_code >= 500:
            _fire(self.environment, "bid_command", elapsed, exc=Exception(f"HTTP {resp.status_code}"), length=len(resp.content), request_type="HTTP")
            return
        try:
            env = resp.json()
        except Exception as e:  # noqa: BLE001
            _fire(self.environment, "bid_command", elapsed, exc=e, length=len(resp.content), request_type="HTTP")
            return

        self._apply(resp.text)
        data = env.get("data") or {}
        typ = env.get("type")
        if typ == "BID_ACCEPTED" and data.get("userId") == self.uid and str(data.get("amountCents")) == amount:
            _fire(self.environment, "bid_ack", elapsed, length=len(resp.content), request_type="HTTP")
            self.pending_amount = None
            self.pending_since = None
            return
        if typ == "BID_REJECTED":
            code = data.get("code") or "UNKNOWN"
            _fire(self.environment, f"bid_rejected:{code}", elapsed, length=len(resp.content), request_type="HTTP")
            self.pending_amount = None
            self.pending_since = None
            return
        _fire(self.environment, "bid_unexpected_response", elapsed, exc=Exception(typ or "missing type"), length=len(resp.content), request_type="HTTP")

    @task
    def bid_or_hold(self):
        if not self.ws:
            raise StopUser()
        if _BID_START_DELAY_SEC > 0 and time.time() < _PROCESS_START + _BID_START_DELAY_SEC:
            self._read_once()
            return
        if _BIDS_PER_BIDDER == 0 or self.sent < _BIDS_PER_BIDDER:
            self._bid_once()
            if _BIDS_PER_BIDDER > 0 and self.sent >= _BIDS_PER_BIDDER:
                self.done = True
                if _STOP_AFTER_BID:
                    raise StopUser()
            return
        self._read_once()
