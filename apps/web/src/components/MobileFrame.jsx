// src/components/MobileFrame.jsx
// Minimal mobile-shaped container — a phone-shaped card on desktop/tablet,
// full-bleed (edge-to-edge, no radius/shadow) on real phones via the
// `.lumen-frame-*` media query in styles.css. Replaces the starter
// `IOSDevice` used in mockup mode.

import React from 'react';

export function MobileFrame({ children, maxWidth = 420, maxHeight = 892 }) {
  // maxWidth/maxHeight feed the desktop card via CSS vars; the ≤480px media
  // query drops the caps so phones get the whole viewport.
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
