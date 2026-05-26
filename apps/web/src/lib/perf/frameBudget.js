// src/lib/perf/frameBudget.js
//
// P9 frame-budget auto-degrade (project-blueprint.md §4 P9).
//
// Samples requestAnimationFrame intervals; when the rolling mean stays above
// `degradeThresholdMs` (default 22ms → ~45fps) for `degradeWindow` frames in
// a row, flips `document.body` into "calm" mode by toggling `.surface-calm`.
// Recovers when mean falls back under `recoverThresholdMs` for the same
// window.
//
// This is a *budget guardrail*, not a benchmark. The point isn't to measure;
// it's to make sure decorative atmosphere never threatens the WS handler
// (broadcast p95 < 150ms SLO).
//
// Mount once at app root (App.jsx). No-op when prefers-reduced-motion already
// engaged (CSS already disables decorative motion via the media query at the
// bottom of src/styles.css, so a runtime guardrail would just be redundant
// work). Returns an unmount fn for tests.
//
// Pairs with src/styles.css `.surface-calm .lumen-*` block that flips every
// decorative `@keyframes` animation to `animation: none`.

/**
 * @typedef {Object} Options
 * @property {number} [degradeThresholdMs=22]  per-frame ms; above this is "bad"
 * @property {number} [recoverThresholdMs=17]  per-frame ms; below this is "good"
 * @property {number} [degradeWindow=30]       bad frames in a row → degrade
 * @property {number} [recoverWindow=60]       good frames in a row → recover
 */

/**
 * Mount the frame-budget guardrail. Idempotent — calling twice with no
 * unmount in between just installs a second rAF loop; prefer the unmount fn.
 *
 * @param {Options} [opts]
 * @returns {() => void} unmount
 */
export function mountFrameBudgetGuardrail(opts = {}) {
  const {
    degradeThresholdMs = 22,
    recoverThresholdMs = 17,
    degradeWindow = 30,
    recoverWindow = 60,
  } = opts;

  if (
    typeof window === 'undefined' ||
    typeof document === 'undefined' ||
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  ) {
    return () => {};
  }

  let last = performance.now();
  let badCount = 0;
  let goodCount = 0;
  let rafId = 0;
  let calm = false;

  const tick = (t) => {
    const dt = t - last;
    last = t;
    if (dt > degradeThresholdMs) {
      badCount += 1;
      goodCount = 0;
    } else if (dt < recoverThresholdMs) {
      goodCount += 1;
      badCount = 0;
    } else {
      // ambivalent zone — decay both slowly
      if (badCount > 0) badCount -= 1;
      if (goodCount > 0) goodCount -= 1;
    }
    if (!calm && badCount >= degradeWindow) {
      document.body.classList.add('surface-calm');
      calm = true;
      badCount = 0;
    } else if (calm && goodCount >= recoverWindow) {
      document.body.classList.remove('surface-calm');
      calm = false;
      goodCount = 0;
    }
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(rafId);
}
