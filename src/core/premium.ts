import type { Logger } from "../services/logger.js";
import type { Plugin } from "./contract.js";

/**
 * Open-core premium loader.
 *
 * The free tier ships in this package under MIT. Premium plugins live in a
 * SEPARATE, privately-licensed package that a customer installs alongside it. At
 * startup we optionally load that package and return its plugins for the loader
 * to gate. This is discovery only: the loader's tier gate still decides whether a
 * plugin registers, so premium tools stay dark until {@link Entitlement} allows
 * them. The free build never depends on the premium package (it is resolved at
 * runtime via a non-literal specifier), so its absence is the normal case and is
 * silent; an installed-but-broken package is reported.
 *
 * The premium package's entry point must export `premiumPlugins`: a function
 * returning `Plugin[]` (each with `tier: "premium"`), or a `Plugin[]` directly.
 * Set `EFFICIENT_TOKEN_PREMIUM` to a module specifier (a package name or a file
 * URL) to override the default, e.g. to point at a local build during development.
 */
const DEFAULT_SPECIFIER = "efficient-token-premium";

export async function loadPremiumPlugins(log: Logger): Promise<Plugin[]> {
  const specifier = process.env.EFFICIENT_TOKEN_PREMIUM?.trim() || DEFAULT_SPECIFIER;

  let mod: Record<string, unknown>;
  try {
    // Non-literal specifier on purpose: the public build must not resolve or
    // depend on the premium package.
    mod = (await import(specifier)) as Record<string, unknown>;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    // Not installed is the normal free-tier case, so stay silent. Any other
    // failure means an installed premium package is broken; surface it.
    if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") {
      log.warn(`premium package "${specifier}" failed to load: ${message(err)}`);
    }
    return [];
  }

  try {
    const exported = mod.premiumPlugins ?? mod.default;
    const list = typeof exported === "function" ? (exported as () => unknown)() : exported;
    if (!Array.isArray(list)) {
      log.warn(`premium package "${specifier}" must export premiumPlugins as a function or array; ignoring.`);
      return [];
    }
    const valid = list.filter(isPlugin);
    if (valid.length !== list.length) {
      log.warn(`premium package "${specifier}": ignored ${list.length - valid.length} invalid plugin export(s).`);
    }
    if (valid.length > 0) log.info(`premium: discovered ${valid.length} plugin(s) from "${specifier}"`);
    return valid;
  } catch (err) {
    log.warn(`premium package "${specifier}" failed to initialise: ${message(err)}`);
    return [];
  }
}

/** Structural check so a malformed premium export can't crash registration. */
function isPlugin(x: unknown): x is Plugin {
  if (typeof x !== "object" || x === null) return false;
  const p = x as Record<string, unknown>;
  return (
    typeof p.name === "string" &&
    typeof p.version === "string" &&
    (p.tier === "free" || p.tier === "premium") &&
    Array.isArray(p.tools)
  );
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
