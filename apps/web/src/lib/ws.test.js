// src/lib/ws.test.js
//
// Tests for the URL composition helper. Full RoomClient lifecycle
// (reconnect, heartbeat, schema-mismatch) is covered by smoke-wire.mjs
// against a real backend — too brittle to mock the entire WebSocket
// state machine here.

import { describe, it, expect } from 'vitest';
import { buildRoomUrl } from './ws.js';

describe('buildRoomUrl', () => {
  it('appends auction + token as query params', () => {
    const url = buildRoomUrl('ws://localhost:8080', 'auc_demo', 'jwt-token');
    expect(url).toBe('ws://localhost:8080/ws?auction=auc_demo&token=jwt-token');
  });

  it('rewrites http→ws (handles VITE_WS_BASE set to an http URL)', () => {
    const url = buildRoomUrl('http://localhost:8080', 'auc1', 't1');
    expect(url.startsWith('ws://')).toBe(true);
  });

  it('rewrites https→wss', () => {
    const url = buildRoomUrl('https://api.example.com', 'auc1', 't1');
    expect(url.startsWith('wss://')).toBe(true);
  });

  it('strips trailing slashes on the base', () => {
    const url = buildRoomUrl('ws://localhost:8080///', 'auc1', 't1');
    expect(url).toBe('ws://localhost:8080/ws?auction=auc1&token=t1');
  });

  it('URL-encodes special chars in auctionId and token', () => {
    const url = buildRoomUrl('ws://localhost:8080', 'auc with space', 'tok&special');
    expect(url).toContain('auction=auc+with+space');
    expect(url).toContain('token=tok%26special');
  });

  it('handles a null token (cleared session) by sending empty string', () => {
    const url = buildRoomUrl('ws://localhost:8080', 'auc1', null);
    expect(url).toContain('token=');
  });
});
