import { BN } from "@coral-xyz/anchor";
import { VaultConfig, VaultParams } from "@voltr/vault-sdk";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

// ============================================================================
// mUSDX program
// ============================================================================

export const MUSDX_PROGRAM_ID = new PublicKey(
  "5NTrBzBD92B8qRDquvxBihpcxQHmCNqu2WtmoT9RRFpK"
);

// Derived after mUSDX is deployed + initialized. Fill these in after running
// scripts/deploy-musdx.ts.
export const USDX_MINT = new PublicKey(
  "9Gst2E7KovZ9jwecyGqnnhpG1mhHKdyLpJQnZonkCFhA"
);
export let MUSDX_MINT = "3RyhjAivYTA1VyXJUG1qXgCLHq4zBvbD9B6bcrcDnKB9";

// ============================================================================
// Ranger / Voltr adaptor
// ============================================================================

export const LENDING_ADAPTOR_PROGRAM_ID = new PublicKey(
  "aVoLTRCRt3NnnchvLYH6rMYehJHwM5m45RmLBZq7PGz"
);

// ============================================================================
// Ranger / Voltr vault config
// ============================================================================

export const vaultConfig: VaultConfig = {
  maxCap: new BN("18446744073709551615"), // u64::MAX — no cap
  startAtTs: new BN(0), // active immediately
  managerPerformanceFee: 0, // 0% — mUSDX yield is the product, not vault fees
  adminPerformanceFee: 0,
  managerManagementFee: 0,
  adminManagementFee: 0,
  lockedProfitDegradationDuration: new BN(86400), // 24h linear unlock
  redemptionFee: 0,
  issuanceFee: 0,
  withdrawalWaitingPeriod: new BN(0), // instant withdrawals
};

export const vaultParams: VaultParams = {
  config: vaultConfig,
  name: "mUSDX Savings Vault",
  description: "Earn yield on USDX via mUSDX (USDX Savings)",
};

export const lpTokenMetadata = {
  symbol: "rvmUSDX",
  name: "Ranger mUSDX Vault LP",
  uri: "", // fill with hosted JSON if we have time
};

// Asset mint for the vault. Using mUSDX (not raw USDX) so the vault's idle
// balance appreciates as Stable posts yield. Users wrap USDX → mUSDX before
// depositing, or we add a Jupiter swap path.
export const assetTokenProgram = TOKEN_PROGRAM_ID.toBase58();

// ============================================================================
// Save Finance (Solend)
// ============================================================================

export const SAVE_PROGRAM_ID = new PublicKey(
  "So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo"
);

// Fill after creating the Save permissionless pool for mUSDX
export let SAVE_MUSDX_LENDING_MARKET = "";
export let SAVE_MUSDX_RESERVE = "";
export let SAVE_MUSDX_COUNTERPARTY_TA = "";
export let SAVE_MUSDX_COLLATERAL_MINT = "";
export let SAVE_MUSDX_PYTH_ORACLE = "";
export let SAVE_MUSDX_SWITCHBOARD_ORACLE = "";

// ============================================================================
// Addresses filled after vault creation. Updated by scripts.
// ============================================================================

export let VAULT_ADDRESS = "Cee4wn9QKZki7BX25mYBo5S2MBQ63MWakfwm7eyuKsSM";
export let LOOKUP_TABLE_ADDRESS = "";
