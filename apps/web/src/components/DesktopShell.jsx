// src/components/DesktopShell.jsx
// Lightweight desktop chrome wrapper — used by admin routes.

import React from 'react';

export function DesktopShell({ title, children }) {
  return (
    <div style={{
      // Fixed viewport height: admin pages manage their own internal scroll
      // (height:100% + overflow:auto). minHeight alone left the flex child at
      // content height — visible as a dead band under light-themed pages.
      width: '100%', height: '100dvh',
      background: '#06070d', display: 'flex', flexDirection: 'column',
    }}>
      <div style={{
        flexShrink: 0, height: 36, padding: '0 18px',
        display: 'flex', alignItems: 'center', gap: 12,
        background: 'linear-gradient(180deg, #1a1d28, #14171f)',
        borderBottom: '1px solid rgba(255,255,255,.06)',
        position: 'sticky', top: 0, zIndex: 50,
      }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <span style={{ width: 11, height: 11, borderRadius: 6, background: '#ff5f57' }}/>
          <span style={{ width: 11, height: 11, borderRadius: 6, background: '#febc2e' }}/>
          <span style={{ width: 11, height: 11, borderRadius: 6, background: '#28c840' }}/>
        </div>
        <span style={{
          fontSize: 12, color: '#9aa0b4', fontFamily: 'var(--font-sans)',
          fontWeight: 500, letterSpacing: '.02em',
        }}>{title}</span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>{children}</div>
    </div>
  );
}

export default DesktopShell;
