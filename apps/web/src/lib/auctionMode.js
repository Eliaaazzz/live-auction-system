export function resolveAuctionMode(input) {
  const maybeMode = typeof input === 'string'
    ? input
    : (input?.auctionMode ?? input?.mode);
  if (typeof maybeMode !== 'string') return null;

  const normalized = maybeMode
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_')
    .replace(/_+/g, '_');
  if (!normalized) return null;

  if (normalized === 'english') {
    return 'first_price';
  }
  if (normalized === 'second' || normalized === 'secondprice' || normalized === 'vickrey') {
    return 'second_price';
  }
  if (normalized === 'first' || normalized === 'firstprice') {
    return 'first_price';
  }
  return normalized;
}
