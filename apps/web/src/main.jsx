import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { mountFrameBudgetGuardrail } from './lib/perf/frameBudget.js';
import { useAuctionStore } from './store/auction.js';
import './styles.css';

// P9: runtime FPS guardrail. No-op if prefers-reduced-motion is already on.
// Flips body.surface-calm when frame budget exceeded — styles.css disables
// decorative @keyframes there. Mount once at app boot, never unmount in prod.
mountFrameBudgetGuardrail();

// T7-3 / issue #70 §4.3: bridge api.js's CustomEvent emitter →
// Zustand store. Keeps lib/api.js free of UI-state coupling; AIBubble /
// AdminConsole / AdminVLMFacts subscribe via the store. Bid path is
// never affected — these events only update observability state.
if (typeof window !== 'undefined') {
  window.addEventListener('lumen:ai-sidecar-ok',      () => useAuctionStore.getState().setAiOk());
  window.addEventListener('lumen:ai-sidecar-offline', () => useAuctionStore.getState().setAiOffline());
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
