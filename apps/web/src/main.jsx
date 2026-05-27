import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { mountFrameBudgetGuardrail } from './lib/perf/frameBudget.js';
import './styles.css';

// P9: runtime FPS guardrail. No-op if prefers-reduced-motion is already on.
// Flips body.surface-calm when frame budget exceeded — styles.css disables
// decorative @keyframes there. Mount once at app boot, never unmount in prod.
mountFrameBudgetGuardrail();

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
