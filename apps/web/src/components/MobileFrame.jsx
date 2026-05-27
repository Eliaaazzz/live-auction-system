// src/components/MobileFrame.jsx
// Minimal mobile-shaped container — caps width on desktop, full-bleed on phones.
// Replaces the starter `IOSDevice` used in mockup mode.

import React from 'react';

export function MobileFrame({ children, maxWidth = 420, maxHeight = 892 }) {
  return (
    <div style={{
      width: '100%', minHeight: '100vh',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: '#06070d', padding: '24px 16px', boxSizing: 'border-box',
    }}>
      <div style={{
        position: 'relative',
        width: '100%', maxWidth,
        height: '100vh', maxHeight,
        borderRadius: 28, overflow: 'hidden',
        background: 'var(--douyin-ink)',
        boxShadow: '0 30px 80px rgba(0,0,0,.5), 0 0 0 1.5px rgba(255,255,255,.04)',
      }}>
        {children}
      </div>
    </div>
  );
}

export default MobileFrame;
