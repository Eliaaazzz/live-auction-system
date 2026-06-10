// #261-7/8/10 房间社交事件总线。
//
// 用同源 BroadcastChannel 把「弹幕 / 送礼 / 点赞」在同一浏览器里的多个买家端之间
// 同步 —— 正是 Showcase 同框双买家（买家A / 买家B 两个面板）和多标签页的演示拓扑。
// 不走后端、不新增也不改动**冻结的 WS 协议**；跨设备（两台真手机）不在覆盖范围内。
//
// 设计要点：每个买家端各持有自己的 BroadcastChannel 实例。BroadcastChannel 不会把消息
// 回投给「发送者自己的那个实例」，所以本端动作本地即时渲染、不会自己回声；其它端收到后渲染。
// 社交事件携带发送者真实昵称，便于接收端按「自己 = 我 / 他人 = 昵称」做自相对显示。

export type RoomSocialEvent =
  | { t: 'comment'; name: string; text: string; color?: string; avatar?: string }
  | { t: 'gift'; name: string; text: string; color?: string; avatar?: string }
  | { t: 'like'; delta: 1 | -1 };

export interface RoomBus {
  publish: (e: RoomSocialEvent) => void;
  subscribe: (fn: (e: RoomSocialEvent) => void) => () => void;
  close: () => void;
}

const noopBus: RoomBus = { publish: () => {}, subscribe: () => () => {}, close: () => {} };

export function createRoomBus(roomId: string): RoomBus {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return noopBus;
  let ch: BroadcastChannel | null = null;
  try {
    ch = new BroadcastChannel('lumen-room-' + roomId);
  } catch {
    return noopBus;
  }
  const subs = new Set<(e: RoomSocialEvent) => void>();
  ch.onmessage = (ev: MessageEvent) => {
    const e = ev.data as RoomSocialEvent;
    if (e && typeof e.t === 'string') subs.forEach((fn) => fn(e));
  };
  return {
    publish: (e) => { try { ch?.postMessage(e); } catch { /* 通道已关 / 序列化失败：忽略 */ } },
    subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); },
    close: () => { try { ch?.close(); } catch { /* ignore */ } ch = null; subs.clear(); },
  };
}
