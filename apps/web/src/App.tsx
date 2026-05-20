import { useEffect, useState } from 'react';

export function App() {
  const [health, setHealth] = useState<string>('checking...');

  useEffect(() => {
    fetch('/api/healthz')
      .then(r => (r.ok ? setHealth('ok') : setHealth('not ok')))
      .catch(() => setHealth('offline'));
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui', padding: '2rem' }}>
      <h1>Lumen Auction</h1>
      <p>API health: <code>{health}</code></p>
      <p style={{ color: '#888' }}>Sprint 1 — Day 1 scaffold. See README and proto/.</p>
    </main>
  );
}
