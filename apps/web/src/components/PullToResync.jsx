// src/components/PullToResync.jsx
//
// F26 · pull-to-refresh = ROOM_JOIN(lastSeq) resync.
//
// Touch / pointer gesture at the top of the room. Pull down past `threshold`
// → calls `onResync`. The ConnectionBar then surfaces the catchup state
// automatically once the gap is detected, so this component owns ONLY the
// gesture + the in-pull affordance.
//
// Visual is intentionally minimal — anti-slop (P10). A small label that
// brightens to cyan once the threshold is crossed. No bouncy spring, no
// confetti, no progress wheel — same engineering register as ConnectionBar.

import React, { useEffect, useRef, useState } from 'react';

export function PullToResync({ onResync, threshold = 64, children }) {
  const startY = useRef(null);
  const [pull, setPull] = useState(0);
  const armedRef = useRef(false);

  useEffect(() => {
    if (pull >= threshold) armedRef.current = true;
  }, [pull, threshold]);

  // Shared reset for end / cancel / mouse-leave / external interrupt.
  // Cancel path (e.g. iOS pull-to-refresh suppression, OS notification
  // sliding in mid-gesture) MUST clear state without firing onResync —
  // otherwise the previously-armed flag would survive into the next pull.
  const reset = () => {
    startY.current = null;
    armedRef.current = false;
    setPull(0);
  };
  const finish = () => {
    const fire = armedRef.current && typeof onResync === 'function';
    reset();
    if (fire) onResync();
  };

  return (
    <div
      style={{ position: 'relative', width: '100%', height: '100%' }}
      onTouchStart={(e) => {
        if (window.scrollY > 0) return;
        startY.current = e.touches[0]?.clientY ?? null;
      }}
      onTouchMove={(e) => {
        if (startY.current == null) return;
        const dy = (e.touches[0]?.clientY ?? 0) - startY.current;
        if (dy > 0 && window.scrollY === 0) {
          setPull(Math.min(threshold * 1.4, dy));
        }
      }}
      onTouchEnd={finish}
      onTouchCancel={reset}        /* #51-H2: iOS abort-mid-pull leaves no residual armed state */
      onMouseDown={(e) => {
        if (window.scrollY > 0) return;
        startY.current = e.clientY;
      }}
      onMouseMove={(e) => {
        if (startY.current == null || e.buttons !== 1) return;
        const dy = e.clientY - startY.current;
        if (dy > 0 && window.scrollY === 0) {
          setPull(Math.min(threshold * 1.4, dy));
        }
      }}
      onMouseUp={finish}
      onMouseLeave={(e) => {
        /* drag-out cancel: only reset if a drag is in progress (left button still down) */
        if (startY.current != null && e.buttons === 1) reset();
      }}
    >
      <div
        aria-hidden
        style={{
          position: 'absolute', top: 0, left: 0, right: 0,
          display: 'flex', justifyContent: 'center',
          pointerEvents: 'none',
          transform: `translateY(${pull - threshold}px)`,
          transition: 'transform 0.1s ease-out',
        }}
      >
        <div
          className="mono"
          style={{
            marginTop: 8,
            fontSize: 10,
            letterSpacing: 0,
            color: pull >= threshold ? 'var(--douyin-cyan)' : 'var(--douyin-ink-muted)',
            transition: 'color 0.1s ease-out',
          }}
        >
          {pull >= threshold ? '松开同步' : '下拉同步'}
        </div>
      </div>
      {children}
    </div>
  );
}

export default PullToResync;
