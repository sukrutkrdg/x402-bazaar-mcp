/**
 * Optional guarded wallet mode (AGENT_SAFE=1 next to AGENT_PRIVATE_KEY).
 *
 * In plain wallet mode every 402 the agent reaches is signed. Here payments go
 * through Agent Safe (@deepfirstsearch/agent-pay) instead, and are refused
 * before anything is signed unless:
 *
 *   - the request goes to https://402.com.tr (the origin the client contacts,
 *     not one the catalog or the 402 names), and the 402 pays the Bazaar's
 *     own address in USDC on Base;
 *   - the price is at most AGENT_SAFE_MAX_PER_CALL_USD (default 0.15);
 *   - the window's budget, AGENT_SAFE_BUDGET_USD per AGENT_SAFE_WINDOW_HOURS
 *     (default 1.00 per 24 h), still covers it.
 *
 * An unconfirmed payment is never signed twice: the same proof is resent, and
 * after it expires the USDC contract is asked whether it was used. The Builder
 * Code extension is echoed exactly like the plain wallet mode does. Every
 * decision is written to a hash-chained audit log (AGENT_SAFE_AUDIT_LOG).
 *
 * None of this is loaded unless AGENT_SAFE=1.
 */

// The Bazaar's own origin and payee. Set here, never read from the catalog or
// from a 402: a catalog entry or a 402 that points elsewhere is refused.
const BAZAAR_ORIGIN = "https://402.com.tr";
const BAZAAR_PAY_TO = "0x973a31858f4d2125f48c880542da11a2796f12d6";
const BASE = "eip155:8453";

function usd(name, fallback) {
  const raw = (process.env[name] ?? fallback).trim();
  if (!/^\d+(\.\d{1,6})?$/.test(raw)) throw new Error(`${name} must be a USD amount like 0.15 (got "${raw}")`);
  const [whole, frac = ""] = raw.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
}

function hours(name, fallback) {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(n) || n <= 0 || n > 24 * 31) throw new Error(`${name} must be a number of hours between 0 and 744`);
  return n;
}

// 150000n -> "$0.15", 1000000n -> "$1.00", 2000n -> "$0.002"
const fmt = (atomic) => `$${(Number(atomic) / 1e6).toFixed(6).replace(/0{1,4}$/, "")}`;

/**
 * Builds the guarded paying fetch. Throws at startup (never at payment time) if
 * the package is missing or a setting is invalid.
 */
export async function createGuardedFetch({ privateKey, builderCode }) {
  let sdk;
  try {
    sdk = await import("@deepfirstsearch/agent-pay");
  } catch {
    throw new Error(
      "AGENT_SAFE=1 needs @deepfirstsearch/agent-pay. Run `npx -p x402-bazaar-mcp -p @deepfirstsearch/agent-pay x402-bazaar-mcp`, or `npm i @deepfirstsearch/agent-pay`.",
    );
  }
  const { createAgentPay, MerchantRegistry, AuditLog, usdcAuthorizationCheck, PaymentDeniedError, PaymentBlockedError } = sdk;
  const [{ privateKeyToAccount }, { createPublicClient, http }, { base }] = await Promise.all([
    import("viem/accounts"),
    import("viem"),
    import("viem/chains"),
  ]);

  const maxPerCall = usd("AGENT_SAFE_MAX_PER_CALL_USD", "0.15");
  const budget = usd("AGENT_SAFE_BUDGET_USD", "1.00");
  const windowMs = hours("AGENT_SAFE_WINDOW_HOURS", "24") * 3_600_000;
  if (maxPerCall === 0n || budget === 0n) throw new Error("AGENT_SAFE_MAX_PER_CALL_USD and AGENT_SAFE_BUDGET_USD must be above 0");

  const registry = new MerchantRegistry([
    {
      origin: BAZAAR_ORIGIN,
      payTo: BAZAAR_PAY_TO,
      network: BASE,
      maxPerTx: maxPerCall,
      label: "x402 Bazaar",
      // Same attribution as the plain wallet mode: the Bazaar's declared code, plus this server's as `s`.
      echoExtensions: ["builder-code"],
      builderCodes: [builderCode],
    },
  ]);
  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ chain: base, transport: http(process.env.AGENT_SAFE_RPC_URL || undefined) });
  const pay = createAgentPay({
    registry,
    policy: { allowedNetworks: [BASE] },
    payer: () => account,
    session: { readsUntrustedInput: true, accessesSensitiveData: false, canPay: true },
    audit: new AuditLog(process.env.AGENT_SAFE_AUDIT_LOG || undefined),
    confirmAuthorization: usdcAuthorizationCheck({ [BASE]: publicClient }),
  });

  // Sealed at startup and renewed per window, from the settings above only.
  const seal = () => pay.commitPlan([{ origin: BAZAAR_ORIGIN, maxSpend: budget }], windowMs);
  let plan = seal();
  const currentPlan = () => {
    if (Date.now() >= plan.expiresAt) plan = seal();
    return plan;
  };

  return {
    summary: `Agent Safe on: pays only ${BAZAAR_ORIGIN}, up to ${fmt(maxPerCall)} per call and ${fmt(budget)} per ${windowMs / 3_600_000} h`,
    fetch: (target, opts) => pay.fetch(target, opts, { plan: currentPlan() }),
    /** A refusal or block from the guard, as text for the agent; undefined for any other error. */
    explain(err) {
      if (err instanceof PaymentDeniedError) {
        return `Agent Safe refused this payment (${err.code}, ${err.action}): ${err.reasons.join("; ")}. Nothing was signed.`;
      }
      if (err instanceof PaymentBlockedError) {
        return `Agent Safe held this payment (${err.code}, ${err.action}): ${err.message}`;
      }
      return undefined;
    },
  };
}
