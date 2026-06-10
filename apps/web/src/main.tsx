import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import { useAuctionStore } from './backend/store/auction.js';
import './index.css';

// AI sidecar health → store. lib/api.js draftFacts() dispatches these window
// events on success/failure (it stays UI-state-agnostic by design); wire them to
// the store here so the AdminVLMFacts / AIBubble offline badge reflects reality.
// The bid path is never gated on this value (V9 P3: AI is non-authoritative).
if (typeof window !== 'undefined') {
  window.addEventListener('lumen:ai-sidecar-ok', () => useAuctionStore.getState().setAiOk());
  window.addEventListener('lumen:ai-sidecar-offline', () => useAuctionStore.getState().setAiOffline());
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>
);
