const DEFAULT_AUCTION_ID = 'auc_demo';

export function resolveAuctionId({ scriptName } = {}) {
  const explicit = process.env.VERIFY_AID || process.env.AUCTION_ID;
  if (explicit) {
    return explicit;
  }

  const name = scriptName ? `[${scriptName}]` : '[smoke script]';
  console.warn(
    `${name} no VERIFY_AID or AUCTION_ID found, falling back to ${DEFAULT_AUCTION_ID} ` +
      '(legacy dev default). Set VERIFY_AID=<auction-id> for explicit intent.',
  );
  return DEFAULT_AUCTION_ID;
}
