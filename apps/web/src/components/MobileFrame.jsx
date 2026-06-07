// src/components/MobileFrame.jsx
// Mobile-shaped container. Phones get a full-bleed, edge-to-edge surface (the
// meeting flagged a visible white border from the old desktop-card padding);
// ≥480px brings back the centred phone card for desktop preview. The layout
// + media query live in styles.css (.lumen-frame-outer / .lumen-frame-inner)
// so the breakpoint is real CSS, not JS width-sniffing.

import React from 'react';

export function MobileFrame({ children, maxWidth = 420, maxHeight = 892 }) {
  return (
    <div className="lumen-frame-outer">
      <div
        className="lumen-frame-inner"
        style={{ '--frame-max-w': `${maxWidth}px`, '--frame-max-h': `${maxHeight}px` }}
      >
        {children}
      </div>
    </div>
  );
}

export default MobileFrame;
