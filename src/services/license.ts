import type { Tier } from "../core/contract.js";

/** Read-only entitlement check. The free build entitles only the free tier. */
export interface Entitlement {
  readonly tier: Tier;
  isEntitled(tier: Tier): boolean;
}

/**
 * STUB — free-only. This is the premium seam: when premium ships, the real impl
 * drops in HERE (Supabase + Stripe + Ed25519-signed license tokens verified
 * OFFLINE against an embedded public key; periodic online re-check with offline
 * grace). Only license status ever crosses the wire — never user code. Nothing
 * else in the system changes: the loader already gates on `isEntitled(tier)`.
 */
export function createEntitlement(): Entitlement {
  return {
    tier: "free",
    isEntitled: (tier: Tier): boolean => tier === "free",
  };
}
