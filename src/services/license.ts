import type { Tier } from "../core/contract.js";

/** Entitlement check. The free build entitles just the free tier. */
export interface Entitlement {
  readonly tier: Tier;
  isEntitled(tier: Tier): boolean;
}

/**
 * Free-only stub, and the premium seam. When premium ships, the real
 * implementation drops in here: Supabase plus Stripe plus Ed25519-signed license
 * tokens verified offline against an embedded public key, with a periodic online
 * re-check and offline grace. Only license status crosses the wire, never user
 * code. Nothing else in the system changes, since the loader already gates on
 * `isEntitled(tier)`.
 */
export function createEntitlement(): Entitlement {
  return {
    tier: "free",
    isEntitled: (tier: Tier): boolean => tier === "free",
  };
}
