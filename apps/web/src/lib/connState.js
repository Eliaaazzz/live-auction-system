// src/lib/connState.js

function normalizeSeqValue(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? value : NaN;
  }

  if (typeof value === 'bigint') {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : NaN;
  }

  if (typeof value === 'boolean' || value === null || value === undefined) return NaN;
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value)) return NaN;
    return Number(value);
  }
  return NaN;
}

export function normalizeSyncStartSeq(lastSeq) {
  const seq = normalizeSeqValue(lastSeq);
  return Number.isSafeInteger(seq) && seq > 0 ? seq : 0;
}

export function makeSyncGap(syncStartSeq, lastSeq) {
  if (typeof syncStartSeq === 'boolean' || typeof lastSeq === 'boolean') return null;
  if (syncStartSeq === null || syncStartSeq === undefined || lastSeq === null || lastSeq === undefined) return null;

  const from = normalizeSeqValue(syncStartSeq);
  const to = normalizeSeqValue(lastSeq);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) return null;
  if (from <= 0 || to <= from) return null;

  return { from: from + 1, to };
}
