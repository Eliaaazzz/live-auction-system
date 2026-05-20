import { pack, unpack } from 'msgpackr';

export type Envelope<T = unknown> = {
  v: 1;
  ch: 'bid' | 'presence' | 'chat' | 'ai';
  t: string;
  auction_id?: string;
  req_id?: string;
  seq?: number;
  ts_ms: number;
  priority?: 'critical' | 'normal' | 'drop_ok';
  body: T;
};

export class WsClient {
  private ws?: WebSocket;
  private listeners = new Map<string, Set<(e: Envelope) => void>>();
  private lastSeq = 0;

  constructor(private url: string, private token: string) {}

  connect() {
    this.ws = new WebSocket(`${this.url}?token=${this.token}`);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onmessage = ev => {
      const env = unpack(new Uint8Array(ev.data as ArrayBuffer)) as Envelope;
      if (env.ch === 'bid' && env.seq && env.seq <= this.lastSeq) return; // stale
      if (env.ch === 'bid' && env.seq) this.lastSeq = env.seq;
      this.listeners.get(env.t)?.forEach(fn => fn(env));
    };
  }

  on(type: string, fn: (e: Envelope) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
    return () => this.listeners.get(type)?.delete(fn);
  }

  send<T>(env: Omit<Envelope<T>, 'ts_ms' | 'v'>) {
    const payload: Envelope<T> = { v: 1, ts_ms: Date.now(), ...env };
    this.ws?.send(pack(payload));
  }

  get lastSeenSeq() { return this.lastSeq; }
}
