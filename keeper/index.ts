/**
 * keeper/index.ts — Production keeper server for the leveraged mUSDX vault.
 *
 * Monitors vault for deposits and withdrawal requests, executes leverage
 * operations via the lev_musdx_adaptor program.
 *
 * Modes:
 *   npx ts-node keeper/index.ts server       — start webhook server
 *   npx ts-node keeper/index.ts deposit      — deploy idle USDX into leverage loop
 *   npx ts-node keeper/index.ts unwind       — one close_leverage_step
 *   npx ts-node keeper/index.ts unwind-all   — full unwind
 *   npx ts-node keeper/index.ts status       — print current position
 */

import * as dotenv from "dotenv";
dotenv.config();

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
  SYSVAR_CLOCK_PUBKEY,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
} from "@solana/spl-token";
import { createHash } from "crypto";
import express from "express";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as path from "path";

// =============================================================================
// Supabase
// =============================================================================

const SUPABASE_PROJECT_ID = process.env.STABLE_AGENTS_SUPABASE_PROJECT_ID || "";
const SUPABASE_URL = process.env.STABLE_AGENTS_SUPABASE_PROJECT_URL || `https://${SUPABASE_PROJECT_ID}.supabase.co`;
const SUPABASE_KEY = process.env.STABLE_AGENTS_SUPABASE_SERVICE_ROLE || process.env.STABLE_AGENTS_SUPABASE_ANON_PUBLIC || "";

let db: SupabaseClient | null = null;

function getDb(): SupabaseClient {
  if (!db) {
    if (!SUPABASE_PROJECT_ID || !SUPABASE_KEY) {
      log("WARN", "Supabase not configured — running without database");
    }
    db = createClient(SUPABASE_URL, SUPABASE_KEY);
  }
  return db;
}

async function logOperation(
  type: string,
  status: string,
  txSig?: string,
  error?: string,
  amounts?: { usdx?: number; usdc?: number; musdx?: number },
  leverageBefore?: number,
  leverageAfter?: number
) {
  try {
    const d = getDb();
    await d.from("operations").insert({
      operation_type: type,
      status,
      tx_signature: txSig || null,
      error_message: error || null,
      usdx_amount: amounts?.usdx || null,
      usdc_amount: amounts?.usdc || null,
      musdx_amount: amounts?.musdx || null,
      leverage_bps_before: leverageBefore || null,
      leverage_bps_after: leverageAfter || null,
    });
  } catch (e: any) {
    log("WARN", "Failed to log operation to DB", { error: e.message });
  }
}

async function savePositionSnapshot(
  collateral: number,
  debt: number,
  leverage: number,
  idleUsdx: number = 0
) {
  try {
    const d = getDb();
    await d.from("position_snapshots").insert({
      musdx_collateral: collateral,
      usdc_debt: debt,
      current_leverage_bps: leverage,
      idle_usdx: idleUsdx,
    });
  } catch (e: any) {
    log("WARN", "Failed to save snapshot to DB", { error: e.message });
  }
}

async function createPendingAction(
  type: string,
  targetAmount?: number
): Promise<number | null> {
  try {
    const d = getDb();
    const { data } = await d
      .from("pending_actions")
      .insert({
        action_type: type,
        status: "in_progress",
        target_amount: targetAmount || null,
      })
      .select("id")
      .single();
    return data?.id || null;
  } catch (e: any) {
    log("WARN", "Failed to create pending action", { error: e.message });
    return null;
  }
}

async function updatePendingAction(
  id: number,
  status: string,
  stepsCompleted?: number,
  error?: string
) {
  try {
    const d = getDb();
    const update: any = { status, updated_at: new Date().toISOString() };
    if (stepsCompleted !== undefined) update.steps_completed = stepsCompleted;
    if (error) update.error_message = error;
    await d.from("pending_actions").update(update).eq("id", id);
  } catch (e: any) {
    log("WARN", "Failed to update pending action", { error: e.message });
  }
}

async function resumePendingActions() {
  try {
    const d = getDb();
    const { data } = await d
      .from("pending_actions")
      .select("*")
      .eq("status", "in_progress")
      .order("created_at", { ascending: true });

    if (data && data.length > 0) {
      log("INFO", `Found ${data.length} incomplete actions to resume`);
      for (const action of data) {
        log("INFO", `Resuming ${action.action_type} (id: ${action.id})`);
        try {
          const connection = getConnection();
          const keeper = getKeeper();
          if (action.action_type === "deploy") {
            await executeDeposit(connection, keeper);
          } else if (action.action_type === "unwind_all") {
            await executeFullUnwind(connection, keeper);
          }
          await updatePendingAction(action.id, "completed");
        } catch (e: any) {
          await updatePendingAction(action.id, "failed", undefined, e.message);
          log("ERROR", `Failed to resume action ${action.id}`, {
            error: e.message,
          });
        }
      }
    }
  } catch (e: any) {
    log("WARN", "Failed to check pending actions", { error: e.message });
  }
}

// =============================================================================
// Constants
// =============================================================================

const ADAPTOR_PROGRAM = new PublicKey(
  "Bjepyh9UYAsJJkQ9meiVSXfgZXQFNZUn5ihqLysekpDr"
);
const MUSDX_PROGRAM = new PublicKey(
  "5NTrBzBD92B8qRDquvxBihpcxQHmCNqu2WtmoT9RRFpK"
);
const VAULT = new PublicKey(
  "CpLxaSioYMjJscmX4gH13iAkrxrMLJTH1PXYQMMeuKB5"
);
const CONFIG_PDA = new PublicKey(
  "62cwM9us4WVVaXRQLtsG7NjYGTGJokzPkTQwS3SgYGrC"
);
const SAVE_OBLIGATION = new PublicKey(
  "HQsY3RjLS7tMVoWrUYqLwfXeMwfeah8QMHdYGeXcZtkS"
);
const SAVE_PROGRAM = new PublicKey(
  "So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo"
);
const LENDING_MARKET = new PublicKey(
  "7JoeENZjr1zGuocJ3d8eHxPzs6xSZKNwxQycHeRDiDCf"
);
const USDX_MINT = new PublicKey(
  "9Gst2E7KovZ9jwecyGqnnhpG1mhHKdyLpJQnZonkCFhA"
);
const MUSDX_MINT = new PublicKey(
  "3RyhjAivYTA1VyXJUG1qXgCLHq4zBvbD9B6bcrcDnKB9"
);
const USDC_MINT = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);
const MUSDX_COLLATERAL_MINT = new PublicKey(
  "Guftqij3rRD9U2Q3LRwxzDYXzq6J4fy1bwY5fqvQzc4p"
);
const JUPITER_V6_PROGRAM = new PublicKey(
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
);

// Save reserve addresses
const MUSDX_RESERVE = new PublicKey(
  "5PB8Aww4nbn8rP2WNaBL6mxMyPwh3Pi5CU2bfRbzy1tK"
);
const MUSDX_RESERVE_LIQUIDITY_SUPPLY = new PublicKey(
  "8hNBSQU2ELd4YN598MUtyjrFj8WR2to5EBCss8fooLXz"
);
const MUSDX_RESERVE_FEE_RECEIVER = new PublicKey(
  "6iUSMNJHXW1Un1EcDNqtqYYNQzt3EKT5n7EGpSPpWKmb"
);
const MUSDX_RESERVE_COLLATERAL_SUPPLY = new PublicKey(
  "H7pGfV3seH4a6sQNj46QWtxT1NtpVMbAtYN4HMHZJA99"
);
// mUSDX reserve pyth oracle: repointed to USDC's Pyth Pull feed since mUSDX
// pegs 1:1 to USDX (≈ $1). Pyth Pull feeds have abundant permissionless
// crankers, so this removes the Switchboard crank dependency that was
// blocking the leverage loop.
const MUSDX_RESERVE_PYTH_ORACLE = new PublicKey(
  "Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"
);
const MUSDX_RESERVE_SWITCHBOARD_ORACLE = new PublicKey(
  "DcXQmwQ1bz177STVkLqubbb5ohjTVnJzMB2PTQkWvbmQ"
);
const USDC_RESERVE = new PublicKey(
  "3oemZuoHXVFmXsNJakU1BcrArnQEtapCau6B7SBpcFTq"
);
const USDC_RESERVE_LIQUIDITY_SUPPLY = new PublicKey(
  "DAxZ7hPmJoc1vDqR75Fp1tFntxvJevpiwXbSnYt6bFQy"
);
const USDC_RESERVE_FEE_RECEIVER = new PublicKey(
  "5Gdxn4yquneifE6uk9tK8X4CqHfWKjW2BvYU25hAykwP"
);
const USDC_RESERVE_PYTH_ORACLE = new PublicKey(
  "Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"
);
const USDC_RESERVE_SWITCHBOARD_ORACLE = new PublicKey(
  "nu11111111111111111111111111111111111111111"
);
const LENDING_MARKET_AUTHORITY = new PublicKey(
  "GDzcMzrtkr9DRJ6dhV7uo2jkHA3oNzAfKENtgM8ccHiS"
);

// mUSDX program PDAs
const [MUSDX_STATE] = PublicKey.findProgramAddressSync(
  [Buffer.from("state")],
  MUSDX_PROGRAM
);
const [MUSDX_USDX_VAULT] = PublicKey.findProgramAddressSync(
  [Buffer.from("usdx_vault")],
  MUSDX_PROGRAM
);
const [MUSDX_MINT_PDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("musdx_mint")],
  MUSDX_PROGRAM
);

// Strategy ATAs (owned by CONFIG_PDA)
const STRATEGY_USDX_ATA = getAssociatedTokenAddressSync(
  USDX_MINT,
  CONFIG_PDA,
  true
);
const STRATEGY_MUSDX_ATA = getAssociatedTokenAddressSync(
  MUSDX_MINT,
  CONFIG_PDA,
  true
);
const STRATEGY_USDC_ATA = getAssociatedTokenAddressSync(
  USDC_MINT,
  CONFIG_PDA,
  true
);
const STRATEGY_COLLATERAL_ATA = getAssociatedTokenAddressSync(
  MUSDX_COLLATERAL_MINT,
  CONFIG_PDA,
  true
);

// Jupiter API base URL
const JUPITER_API_BASE = "https://lite-api.jup.ag/swap/v1";

// Health check interval: 30 minutes
const HEALTH_CHECK_INTERVAL_MS = 30 * 60 * 1000;

// Maximum transaction retry attempts
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

// Default slippage in bps for Jupiter quotes
const DEFAULT_SLIPPAGE_BPS = 100;

// Minimum USDX amount to trigger deposit (1 USDX = 1_000_000 lamports)
const MIN_DEPOSIT_THRESHOLD = 100_000; // 0.1 USDX minimum

// =============================================================================
// Config state layout offsets (after 8-byte discriminator)
// =============================================================================

interface ConfigState {
  admin: PublicKey;
  voltrVault: PublicKey;
  saveObligation: PublicKey;
  keeper: PublicKey;
  pendingAdmin: PublicKey;
  pendingAdminEffectiveAt: bigint;
  targetLeverageBps: number;
  maxLeverageBps: number;
  maxSlippageBps: number;
  minSwapPriceBps: number;
  loopIterationCap: number;
  paused: boolean;
  musdxCollateralAmount: bigint;
  usdcDebtAmount: bigint;
  currentLeverageBps: number;
  lastRefreshTs: bigint;
  bump: number;
}

function parseConfigState(data: Buffer): ConfigState {
  let offset = 8; // skip discriminator

  const admin = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;
  const voltrVault = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;
  const saveObligation = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;
  const keeper = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;
  const pendingAdmin = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;
  const pendingAdminEffectiveAt = data.readBigInt64LE(offset);
  offset += 8;
  const targetLeverageBps = data.readUInt16LE(offset);
  offset += 2;
  const maxLeverageBps = data.readUInt16LE(offset);
  offset += 2;
  const maxSlippageBps = data.readUInt16LE(offset);
  offset += 2;
  const minSwapPriceBps = data.readUInt16LE(offset);
  offset += 2;
  const loopIterationCap = data.readUInt8(offset);
  offset += 1;
  const paused = data.readUInt8(offset) !== 0;
  offset += 1;
  const musdxCollateralAmount = data.readBigUInt64LE(offset);
  offset += 8;
  const usdcDebtAmount = data.readBigUInt64LE(offset);
  offset += 8;
  const currentLeverageBps = data.readUInt16LE(offset);
  offset += 2;
  const lastRefreshTs = data.readBigInt64LE(offset);
  offset += 8;
  const bump = data.readUInt8(offset);

  return {
    admin,
    voltrVault,
    saveObligation,
    keeper,
    pendingAdmin,
    pendingAdminEffectiveAt,
    targetLeverageBps,
    maxLeverageBps,
    maxSlippageBps,
    minSwapPriceBps,
    loopIterationCap,
    paused,
    musdxCollateralAmount,
    usdcDebtAmount,
    currentLeverageBps,
    lastRefreshTs,
    bump,
  };
}

// =============================================================================
// Anchor discriminator helper
// =============================================================================

function anchorDisc(name: string): Buffer {
  return createHash("sha256")
    .update(`global:${name}`)
    .digest()
    .slice(0, 8);
}

// =============================================================================
// Logging
// =============================================================================

function log(level: string, msg: string, data?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}]`;
  if (data) {
    console.log(`${prefix} ${msg}`, JSON.stringify(data));
  } else {
    console.log(`${prefix} ${msg}`);
  }
}

function logInfo(msg: string, data?: Record<string, unknown>): void {
  log("info", msg, data);
}

function logWarn(msg: string, data?: Record<string, unknown>): void {
  log("warn", msg, data);
}

function logError(msg: string, data?: Record<string, unknown>): void {
  log("error", msg, data);
}

// =============================================================================
// Keypair loading
// =============================================================================

function loadKeypair(filePath: string): Keypair {
  const resolved = filePath.startsWith("~")
    ? path.join(process.env.HOME!, filePath.slice(1))
    : filePath;
  const data = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(data));
}

// =============================================================================
// Connection + Keeper setup
// =============================================================================

function getConnection(): Connection {
  const apiKey = process.env.USDX_LOOP_VAULT_ALCHEMY_RPC_API_KEY;
  if (!apiKey) {
    throw new Error("USDX_LOOP_VAULT_ALCHEMY_RPC_API_KEY not set in environment");
  }
  const rpcUrl = `https://solana-mainnet.g.alchemy.com/v2/${apiKey}`;
  return new Connection(rpcUrl, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60_000,
  });
}

function getKeeper(): Keypair {
  const keypairPath = process.env.KEEPER_KEYPAIR_PATH;
  if (!keypairPath) {
    throw new Error("KEEPER_KEYPAIR_PATH not set in environment");
  }
  return loadKeypair(keypairPath);
}

// =============================================================================
// Transaction helpers
// =============================================================================

async function sendWithRetry(
  connection: Connection,
  ixs: TransactionInstruction[],
  signers: Keypair[],
  computeUnits?: number,
  addressLookupTables?: PublicKey[]
): Promise<string> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const tx = new Transaction();

      // Add compute budget if specified
      if (computeUnits) {
        tx.add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits })
        );
        // Add a priority fee for faster inclusion
        tx.add(
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 })
        );
      }

      for (const ix of ixs) {
        tx.add(ix);
      }

      // Use versioned transaction with address lookup tables for Jupiter routes
      const { blockhash } = await connection.getLatestBlockhash("confirmed");

      // Load any address lookup tables
      let lookupTables: AddressLookupTableAccount[] = [];
      if (addressLookupTables && addressLookupTables.length > 0) {
        for (const altAddr of addressLookupTables) {
          const alt = await connection.getAddressLookupTable(altAddr);
          if (alt.value) lookupTables.push(alt.value);
        }
      }

      const messageV0 = new TransactionMessage({
        payerKey: signers[0].publicKey,
        recentBlockhash: blockhash,
        instructions: tx.instructions,
      }).compileToV0Message(lookupTables);
      const vtx = new VersionedTransaction(messageV0);
      vtx.sign(signers);

      const rawTx = vtx.serialize();
      const sig = await connection.sendRawTransaction(rawTx, {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });

      logInfo(`Transaction sent, polling for confirmation...`, { signature: sig });

      // Poll for confirmation instead of using websocket
      for (let poll = 0; poll < 30; poll++) {
        await sleep(2000);
        const status = await connection.getSignatureStatus(sig);
        if (status?.value?.confirmationStatus === "confirmed" || status?.value?.confirmationStatus === "finalized") {
          if (status.value.err) {
            throw new Error(`Transaction confirmed but failed: ${JSON.stringify(status.value.err)}`);
          }
          logInfo(`Transaction confirmed`, { signature: sig, attempt });
          return sig;
        }
      }
      throw new Error(`Transaction confirmation timeout: ${sig}`);
    } catch (err: any) {
      const errMsg =
        err?.message || err?.toString() || "unknown error";
      logError(`Transaction attempt ${attempt}/${MAX_RETRIES} failed`, {
        error: errMsg,
        logs: err?.logs?.slice(-10),
      });

      if (attempt === MAX_RETRIES) {
        throw new Error(
          `Transaction failed after ${MAX_RETRIES} attempts: ${errMsg}`
        );
      }

      // Wait before retry with exponential backoff
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }

  throw new Error("Unreachable");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// Jupiter API
// =============================================================================

interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  routePlan: any[];
  [key: string]: any;
}

interface JupiterSwapInstruction {
  programId: string;
  accounts: Array<{
    pubkey: string;
    isSigner: boolean;
    isWritable: boolean;
  }>;
  data: string;
}

interface JupiterSwapInstructionsResponse {
  tokenLedgerInstruction?: JupiterSwapInstruction;
  computeBudgetInstructions: JupiterSwapInstruction[];
  setupInstructions: JupiterSwapInstruction[];
  swapInstruction: JupiterSwapInstruction;
  cleanupInstruction?: JupiterSwapInstruction;
  addressLookupTableAddresses: string[];
  error?: string;
}

async function getJupiterQuote(
  inputMint: PublicKey,
  outputMint: PublicKey,
  amount: bigint,
  slippageBps: number = DEFAULT_SLIPPAGE_BPS
): Promise<JupiterQuote> {
  const url =
    `${JUPITER_API_BASE}/quote?` +
    `inputMint=${inputMint.toBase58()}` +
    `&outputMint=${outputMint.toBase58()}` +
    `&amount=${amount.toString()}` +
    `&slippageBps=${slippageBps}` +
    `&maxAccounts=30`;

  logInfo(`Fetching Jupiter quote`, {
    inputMint: inputMint.toBase58(),
    outputMint: outputMint.toBase58(),
    amount: amount.toString(),
  });

  const resp = await fetch(url);
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Jupiter quote failed (${resp.status}): ${body}`);
  }

  const quote: JupiterQuote = await resp.json();
  logInfo(`Jupiter quote received`, {
    inAmount: quote.inAmount,
    outAmount: quote.outAmount,
  });

  return quote;
}

async function getJupiterSwapInstructions(
  quote: JupiterQuote,
  userPublicKey: PublicKey
): Promise<JupiterSwapInstructionsResponse> {
  const url = `${JUPITER_API_BASE}/swap-instructions`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: userPublicKey.toBase58(),
      wrapAndUnwrapSol: false,
      dynamicComputeUnitLimit: true,
      dynamicSlippage: true,
      prioritizationFeeLamports: "auto",
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Jupiter swap-instructions failed (${resp.status}): ${body}`);
  }

  const result: JupiterSwapInstructionsResponse = await resp.json();
  if (result.error) {
    throw new Error(`Jupiter swap-instructions error: ${result.error}`);
  }

  return result;
}

/**
 * Convert a Jupiter swap instruction response into the data blob and
 * remaining accounts needed by our adaptor's open_leverage_step /
 * close_leverage_step instructions.
 *
 * The adaptor forwards the raw Jupiter instruction via CPI. The
 * `remaining_accounts` for our instruction are the accounts from the
 * Jupiter swap instruction.
 */
function extractJupiterRouteData(
  swapIx: JupiterSwapInstruction
): {
  data: Buffer;
  accounts: Array<{
    pubkey: PublicKey;
    isSigner: boolean;
    isWritable: boolean;
  }>;
} {
  const data = Buffer.from(swapIx.data, "base64");
  const accounts = swapIx.accounts.map((a) => ({
    pubkey: new PublicKey(a.pubkey),
    isSigner: false, // our adaptor signs via PDA, not the individual route accounts
    isWritable: a.isWritable,
  }));

  return { data, accounts };
}

// =============================================================================
// Read on-chain state
// =============================================================================

async function readConfigState(connection: Connection): Promise<ConfigState> {
  const accountInfo = await connection.getAccountInfo(CONFIG_PDA);
  if (!accountInfo) {
    throw new Error(`Config PDA ${CONFIG_PDA.toBase58()} not found on-chain`);
  }
  return parseConfigState(accountInfo.data as Buffer);
}

async function getTokenBalance(
  connection: Connection,
  ata: PublicKey
): Promise<bigint> {
  try {
    const account = await getAccount(connection, ata);
    return account.amount;
  } catch {
    return 0n;
  }
}

// =============================================================================
// Instruction builders
// =============================================================================

function buildDepositCollateralIx(
  depositor: PublicKey,
  usdcAmount: bigint,
  jupiterData: Buffer,
  jupiterAccounts: Array<{
    pubkey: PublicKey;
    isSigner: boolean;
    isWritable: boolean;
  }>
): TransactionInstruction {
  const disc = anchorDisc("deposit_collateral");

  // usdc_amount (u64) + jupiter_data (Vec<u8>: 4-byte len + bytes)
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(usdcAmount);

  const jupLenBuf = Buffer.alloc(4);
  jupLenBuf.writeUInt32LE(jupiterData.length);

  const data = Buffer.concat([disc, amountBuf, jupLenBuf, jupiterData]);

  const keys = [
    { pubkey: CONFIG_PDA, isSigner: false, isWritable: true },
    { pubkey: depositor, isSigner: true, isWritable: false },
    { pubkey: STRATEGY_USDC_ATA, isSigner: false, isWritable: true },
    { pubkey: STRATEGY_USDX_ATA, isSigner: false, isWritable: true },
    { pubkey: STRATEGY_MUSDX_ATA, isSigner: false, isWritable: true },
    { pubkey: STRATEGY_COLLATERAL_ATA, isSigner: false, isWritable: true },
    { pubkey: USDC_MINT, isSigner: false, isWritable: false },
    { pubkey: USDX_MINT, isSigner: false, isWritable: false },
    { pubkey: MUSDX_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: MUSDX_STATE, isSigner: false, isWritable: true },
    { pubkey: MUSDX_MINT_PDA, isSigner: false, isWritable: true },
    { pubkey: MUSDX_USDX_VAULT, isSigner: false, isWritable: true },
    { pubkey: JUPITER_V6_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: SAVE_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: SAVE_OBLIGATION, isSigner: false, isWritable: true },
    { pubkey: LENDING_MARKET, isSigner: false, isWritable: false },
    { pubkey: LENDING_MARKET_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: MUSDX_RESERVE, isSigner: false, isWritable: true },
    { pubkey: MUSDX_RESERVE_LIQUIDITY_SUPPLY, isSigner: false, isWritable: true },
    { pubkey: MUSDX_COLLATERAL_MINT, isSigner: false, isWritable: true },
    { pubkey: MUSDX_RESERVE_COLLATERAL_SUPPLY, isSigner: false, isWritable: true },
    { pubkey: MUSDX_RESERVE_FEE_RECEIVER, isSigner: false, isWritable: true },
    { pubkey: MUSDX_RESERVE_PYTH_ORACLE, isSigner: false, isWritable: false },
    { pubkey: MUSDX_RESERVE_SWITCHBOARD_ORACLE, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
    // Jupiter route accounts follow as remaining_accounts
    ...jupiterAccounts,
  ];

  return new TransactionInstruction({
    programId: ADAPTOR_PROGRAM,
    keys,
    data,
  });
}

function buildOpenLeverageStepIx(
  keeper: PublicKey,
  usdcBorrowAmount: bigint,
  jupiterData: Buffer,
  jupiterAccounts: Array<{
    pubkey: PublicKey;
    isSigner: boolean;
    isWritable: boolean;
  }>
): TransactionInstruction {
  const disc = anchorDisc("open_leverage_step");

  // Serialize: usdc_borrow_amount (u64) + jupiter_data (Vec<u8>: 4-byte len + bytes)
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(usdcBorrowAmount);

  const jupLenBuf = Buffer.alloc(4);
  jupLenBuf.writeUInt32LE(jupiterData.length);

  const data = Buffer.concat([disc, amountBuf, jupLenBuf, jupiterData]);

  const keys = [
    { pubkey: CONFIG_PDA, isSigner: false, isWritable: true },
    { pubkey: keeper, isSigner: true, isWritable: false },
    { pubkey: STRATEGY_USDX_ATA, isSigner: false, isWritable: true },
    { pubkey: STRATEGY_MUSDX_ATA, isSigner: false, isWritable: true },
    { pubkey: STRATEGY_USDC_ATA, isSigner: false, isWritable: true },
    { pubkey: STRATEGY_COLLATERAL_ATA, isSigner: false, isWritable: true },
    { pubkey: USDX_MINT, isSigner: false, isWritable: false },
    { pubkey: MUSDX_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: MUSDX_STATE, isSigner: false, isWritable: true },
    { pubkey: MUSDX_MINT_PDA, isSigner: false, isWritable: true },
    { pubkey: MUSDX_USDX_VAULT, isSigner: false, isWritable: true },
    { pubkey: SAVE_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: SAVE_OBLIGATION, isSigner: false, isWritable: true },
    // Save's fork updates the lending_market's rate_limiter during borrow.
    { pubkey: LENDING_MARKET, isSigner: false, isWritable: true },
    { pubkey: LENDING_MARKET_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: MUSDX_RESERVE, isSigner: false, isWritable: true },
    {
      pubkey: MUSDX_RESERVE_LIQUIDITY_SUPPLY,
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: MUSDX_COLLATERAL_MINT,
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: MUSDX_RESERVE_COLLATERAL_SUPPLY,
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: MUSDX_RESERVE_FEE_RECEIVER,
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: MUSDX_RESERVE_PYTH_ORACLE,
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: MUSDX_RESERVE_SWITCHBOARD_ORACLE,
      isSigner: false,
      isWritable: false,
    },
    { pubkey: USDC_RESERVE, isSigner: false, isWritable: true },
    {
      pubkey: USDC_RESERVE_LIQUIDITY_SUPPLY,
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: USDC_RESERVE_FEE_RECEIVER,
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: USDC_RESERVE_PYTH_ORACLE,
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: USDC_RESERVE_SWITCHBOARD_ORACLE,
      isSigner: false,
      isWritable: false,
    },
    { pubkey: JUPITER_V6_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
    // remaining_accounts from Jupiter
    ...jupiterAccounts,
  ];

  return new TransactionInstruction({
    programId: ADAPTOR_PROGRAM,
    keys,
    data,
  });
}

function buildCloseLeverageStepIx(
  keeper: PublicKey,
  collateralWithdrawAmount: bigint,
  jupiterData: Buffer,
  jupiterAccounts: Array<{
    pubkey: PublicKey;
    isSigner: boolean;
    isWritable: boolean;
  }>
): TransactionInstruction {
  const disc = anchorDisc("close_leverage_step");

  // Serialize: collateral_withdraw_amount (u64) + jupiter_data (Vec<u8>)
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(collateralWithdrawAmount);

  const jupLenBuf = Buffer.alloc(4);
  jupLenBuf.writeUInt32LE(jupiterData.length);

  const data = Buffer.concat([disc, amountBuf, jupLenBuf, jupiterData]);

  const keys = [
    { pubkey: CONFIG_PDA, isSigner: false, isWritable: true },
    { pubkey: keeper, isSigner: true, isWritable: false },
    { pubkey: STRATEGY_USDX_ATA, isSigner: false, isWritable: true },
    { pubkey: STRATEGY_MUSDX_ATA, isSigner: false, isWritable: true },
    { pubkey: STRATEGY_USDC_ATA, isSigner: false, isWritable: true },
    { pubkey: STRATEGY_COLLATERAL_ATA, isSigner: false, isWritable: true },
    { pubkey: SAVE_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: SAVE_OBLIGATION, isSigner: false, isWritable: true },
    // Save's fork updates the lending_market's rate_limiter on withdraw+redeem.
    { pubkey: LENDING_MARKET, isSigner: false, isWritable: true },
    { pubkey: LENDING_MARKET_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: MUSDX_RESERVE, isSigner: false, isWritable: true },
    {
      pubkey: MUSDX_RESERVE_LIQUIDITY_SUPPLY,
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: MUSDX_COLLATERAL_MINT,
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: MUSDX_RESERVE_COLLATERAL_SUPPLY,
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: MUSDX_RESERVE_PYTH_ORACLE,
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: MUSDX_RESERVE_SWITCHBOARD_ORACLE,
      isSigner: false,
      isWritable: false,
    },
    { pubkey: USDC_RESERVE, isSigner: false, isWritable: true },
    {
      pubkey: USDC_RESERVE_LIQUIDITY_SUPPLY,
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: USDC_RESERVE_PYTH_ORACLE,
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: USDC_RESERVE_SWITCHBOARD_ORACLE,
      isSigner: false,
      isWritable: false,
    },
    { pubkey: JUPITER_V6_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
    // remaining_accounts from Jupiter
    ...jupiterAccounts,
  ];

  return new TransactionInstruction({
    programId: ADAPTOR_PROGRAM,
    keys,
    data,
  });
}

// =============================================================================
// Core operations
// =============================================================================

/**
 * Calculate the USDC borrow amount for a single leverage step.
 * Given current collateral/debt and target leverage, computes how much
 * additional USDC to borrow in one iteration.
 */
function calculateBorrowAmount(config: ConfigState): bigint {
  const collateral = config.musdxCollateralAmount;
  const debt = config.usdcDebtAmount;
  const targetLevBps = BigInt(config.targetLeverageBps);

  // Current equity = collateral - debt
  const equity = collateral - debt;
  if (equity <= 0n) {
    return 0n;
  }

  // Target total collateral at desired leverage:
  // targetLeverageBps stores leverage * 100 (400 = 4x), so divide by 100
  const targetCollateral = (equity * targetLevBps) / 100n;

  if (targetCollateral <= collateral) {
    return 0n; // already at or above target
  }

  // Additional collateral needed
  const additionalNeeded = targetCollateral - collateral;

  // We borrow USDC 1:1 in value to the additional mUSDX we want to add.
  // Since mUSDX and USDC are both ~$1, borrow amount = additional needed.
  // Cap at a reasonable per-step maximum to avoid tx size / slippage issues.
  const maxPerStep = equity / 2n; // at most 50% of equity per step
  const borrowAmount = additionalNeeded < maxPerStep ? additionalNeeded : maxPerStep;

  return borrowAmount > 0n ? borrowAmount : 0n;
}

/**
 * Calculate the collateral withdraw amount for a single deleverage step.
 */
function calculateWithdrawAmount(config: ConfigState): bigint {
  const collateral = config.musdxCollateralAmount;
  const debt = config.usdcDebtAmount;

  if (debt === 0n) {
    return 0n; // no debt to unwind
  }

  // Withdraw enough collateral to repay some debt.
  // Be conservative: withdraw at most 40% of collateral per step to keep
  // the position healthy during unwinding.
  const maxWithdraw = (collateral * 40n) / 100n;

  // We want to withdraw enough to repay at least some debt.
  // Since mUSDX:USDC is ~1:1, withdraw amount = debt to repay.
  // Cap to avoid liquidation.
  const withdrawAmount = debt < maxWithdraw ? debt : maxWithdraw;

  return withdrawAmount > 0n ? withdrawAmount : 0n;
}

/**
 * Execute a deposit flow: deposit idle USDX as collateral and leverage up.
 */
async function executeDeposit(
  connection: Connection,
  keeper: Keypair
): Promise<void> {
  logInfo("Starting deposit flow...");

  // Read current state
  const config = await readConfigState(connection);
  if (config.paused) {
    logWarn("Strategy is paused, skipping deposit");
    return;
  }

  // Check vault idle USDC first and move to strategy ATA via Voltr deposit_strategy
  const { VoltrClient } = require("@voltr/vault-sdk");
  const { BN } = require("bn.js");
  const vc = new VoltrClient(connection);
  const vaultData = await vc.fetchVaultAccount(VAULT);
  const vaultIdleAta = new PublicKey(vaultData.asset.idleAta);
  const vaultIdleBalance = await getTokenBalance(connection, vaultIdleAta);
  logInfo(`Vault idle USDC: ${vaultIdleBalance.toString()}`);

  if (vaultIdleBalance > BigInt(0)) {
    logInfo(`Moving ${vaultIdleBalance.toString()} USDC from vault idle to strategy...`);

    // Ensure vault_strategy_asset_ata exists (owned by Voltr's vaultStrategyAuth PDA)
    const { vaultStrategyAuth } = vc.findVaultStrategyAddresses(VAULT, CONFIG_PDA);
    const vaultStrategyAssetAta = getAssociatedTokenAddressSync(USDC_MINT, vaultStrategyAuth, true);
    const createVsaAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      keeper.publicKey, vaultStrategyAssetAta, vaultStrategyAuth, USDC_MINT
    );
    try {
      await sendWithRetry(connection, [createVsaAtaIx], [keeper], 200_000);
      logInfo(`Created vault_strategy_asset_ata: ${vaultStrategyAssetAta.toBase58()}`);
    } catch (e: any) {
      logInfo(`vault_strategy_asset_ata already exists or created`);
    }

    const depositStrategyIx = await vc.createDepositStrategyIx(
      {
        depositAmount: new BN(vaultIdleBalance.toString()),
        instructionDiscriminator: null,
        additionalArgs: null,
      },
      {
        manager: keeper.publicKey,
        vault: VAULT,
        vaultAssetMint: USDC_MINT,
        strategy: CONFIG_PDA,
        assetTokenProgram: TOKEN_PROGRAM_ID,
        adaptorProgram: ADAPTOR_PROGRAM,
        remainingAccounts: [
          { pubkey: STRATEGY_USDC_ATA, isSigner: false, isWritable: true },
        ],
      }
    );
    const moveSig = await sendWithRetry(connection, [depositStrategyIx], [keeper], 400_000);
    logInfo(`Moved USDC to strategy`, { signature: moveSig });
  }

  // Check idle USDC balance in strategy ATA
  const idleUsdc = await getTokenBalance(connection, STRATEGY_USDC_ATA);
  logInfo(`Idle USDC in strategy ATA: ${idleUsdc.toString()}`);

  if (idleUsdc < BigInt(MIN_DEPOSIT_THRESHOLD)) {
    logInfo("Not enough idle USDC to deposit, skipping");
    return;
  }

  // Step 1: Fetch Jupiter quote for USDC -> USDX so we can swap inside deposit_collateral
  const quote = await getJupiterQuote(USDC_MINT, USDX_MINT, idleUsdc);
  const swapResp = await getJupiterSwapInstructions(quote, CONFIG_PDA);
  if (!swapResp.swapInstruction) {
    throw new Error("Jupiter did not return a swap instruction for USDC->USDX");
  }
  const { data: jupiterData, accounts: jupiterAccounts } =
    extractJupiterRouteData(swapResp.swapInstruction);

  // Step 2: deposit_collateral — swap USDC->USDX, wrap to mUSDX, post as Save collateral
  logInfo(`Depositing ${idleUsdc.toString()} USDC as collateral (via Jupiter USDC→USDX)...`);
  const depositIx = buildDepositCollateralIx(
    keeper.publicKey,
    idleUsdc,
    jupiterData,
    jupiterAccounts
  );
  const depositSig = await sendWithRetry(
    connection,
    [depositIx],
    [keeper],
    600_000,
    swapResp.addressLookupTableAddresses?.map((a) => new PublicKey(a))
  );
  logInfo(`Collateral deposited`, { signature: depositSig });

  // Step 3: Open leverage steps until target reached
  await executeLeverageLoop(connection, keeper);
}

/**
 * Execute leverage loop iterations until target leverage is reached or
 * iteration cap is hit.
 */
async function executeLeverageLoop(
  connection: Connection,
  keeper: Keypair
): Promise<void> {
  let config = await readConfigState(connection);
  const iterationCap = config.loopIterationCap;

  for (let i = 0; i < iterationCap; i++) {
    // Re-read config each iteration since state changes
    config = await readConfigState(connection);

    if (config.paused) {
      logWarn("Strategy paused during leverage loop, stopping");
      break;
    }

    // Check if we've reached target leverage
    // target stores leverage * 100 (4x = 400), current stores leverage * 10000 (4x = 40000)
    const targetCurrentScale = config.targetLeverageBps * 100;
    if (
      config.currentLeverageBps >= targetCurrentScale &&
      config.currentLeverageBps > 0
    ) {
      logInfo(
        `Target leverage reached: ${config.currentLeverageBps} bps >= ${targetCurrentScale} bps (target ${config.targetLeverageBps})`
      );
      break;
    }

    const borrowAmount = calculateBorrowAmount(config);
    if (borrowAmount === 0n) {
      logInfo("No more borrowing needed, target leverage met");
      break;
    }

    logInfo(`Leverage step ${i + 1}/${iterationCap}`, {
      borrowAmount: borrowAmount.toString(),
      currentLeverage: config.currentLeverageBps,
      targetLeverage: config.targetLeverageBps,
    });

    try {
      await executeOpenLeverageStep(connection, keeper, borrowAmount);
    } catch (err: any) {
      logError(`Leverage step ${i + 1} failed, stopping loop`, {
        error: err?.message,
      });
      break;
    }

    // Brief pause between steps to let state settle
    await sleep(1000);
  }

  // Log final state
  config = await readConfigState(connection);
  logInfo("Leverage loop complete", {
    collateral: config.musdxCollateralAmount.toString(),
    debt: config.usdcDebtAmount.toString(),
    leverage: config.currentLeverageBps,
  });
}

/**
 * Execute a single open_leverage_step: borrow USDC -> swap to USDX via
 * Jupiter -> wrap to mUSDX -> re-deposit as collateral.
 */
async function executeOpenLeverageStep(
  connection: Connection,
  keeper: Keypair,
  usdcBorrowAmount: bigint
): Promise<string> {
  // Get Jupiter quote for USDC -> USDX
  const quote = await getJupiterQuote(
    USDC_MINT,
    USDX_MINT,
    usdcBorrowAmount
  );

  // Get swap instructions with CONFIG_PDA as the user (it's the signer via PDA)
  const swapIxResp = await getJupiterSwapInstructions(quote, CONFIG_PDA);
  const { data: jupiterData, accounts: jupiterAccounts } =
    extractJupiterRouteData(swapIxResp.swapInstruction);

  logInfo("Building open_leverage_step instruction", {
    borrowAmount: usdcBorrowAmount.toString(),
    jupiterAccountCount: jupiterAccounts.length,
  });

  const ix = buildOpenLeverageStepIx(
    keeper.publicKey,
    usdcBorrowAmount,
    jupiterData,
    jupiterAccounts
  );

  // Pass our ALT + Jupiter's address lookup tables for versioned transaction compression
  const OUR_ALT = new PublicKey("2eDysx624w2kwFsuK4y8wkJzm2dksm4DQTB6f4AeSju2");
  const altPubkeys = [
    OUR_ALT,
    ...(swapIxResp.addressLookupTableAddresses || []).map(
      (a: string) => new PublicKey(a)
    ),
  ];

  return sendWithRetry(connection, [ix], [keeper], 1_200_000, altPubkeys);
}

/**
 * Execute a single close_leverage_step: withdraw collateral -> swap to USDC
 * via Jupiter -> repay debt.
 */
async function executeCloseLeverageStep(
  connection: Connection,
  keeper: Keypair,
  collateralWithdrawAmount?: bigint
): Promise<string> {
  const config = await readConfigState(connection);

  if (config.usdcDebtAmount === 0n) {
    logInfo("No debt to repay");
    return "";
  }

  const withdrawAmount =
    collateralWithdrawAmount || calculateWithdrawAmount(config);
  if (withdrawAmount === 0n) {
    logInfo("No collateral to withdraw");
    return "";
  }

  // Get Jupiter quote: we're swapping mUSDX -> USDC
  // The collateral we withdraw from Save comes out as mUSDX
  const quote = await getJupiterQuote(
    MUSDX_MINT,
    USDC_MINT,
    withdrawAmount
  );

  const swapIxResp = await getJupiterSwapInstructions(quote, CONFIG_PDA);
  const { data: jupiterData, accounts: jupiterAccounts } =
    extractJupiterRouteData(swapIxResp.swapInstruction);

  logInfo("Building close_leverage_step instruction", {
    withdrawAmount: withdrawAmount.toString(),
    jupiterAccountCount: jupiterAccounts.length,
  });

  const ix = buildCloseLeverageStepIx(
    keeper.publicKey,
    withdrawAmount,
    jupiterData,
    jupiterAccounts
  );

  return sendWithRetry(connection, [ix], [keeper], 1_200_000);
}

/**
 * Full unwind: close leverage steps until debt is zero.
 */
async function executeFullUnwind(
  connection: Connection,
  keeper: Keypair
): Promise<void> {
  logInfo("Starting full unwind...");

  let config = await readConfigState(connection);
  let iteration = 0;
  const maxIterations = 20; // safety cap

  while (config.usdcDebtAmount > 0n && iteration < maxIterations) {
    iteration++;

    logInfo(`Unwind step ${iteration}`, {
      collateral: config.musdxCollateralAmount.toString(),
      debt: config.usdcDebtAmount.toString(),
      leverage: config.currentLeverageBps,
    });

    try {
      const sig = await executeCloseLeverageStep(connection, keeper);
      if (!sig) break;
      logInfo(`Unwind step ${iteration} complete`, { signature: sig });
    } catch (err: any) {
      logError(`Unwind step ${iteration} failed`, {
        error: err?.message,
      });
      break;
    }

    // Re-read state
    config = await readConfigState(connection);
    await sleep(1000);
  }

  if (config.usdcDebtAmount === 0n) {
    logInfo("Full unwind complete - all debt repaid");
  } else {
    logWarn("Unwind stopped with remaining debt", {
      remainingDebt: config.usdcDebtAmount.toString(),
    });
  }
}

// =============================================================================
// Health check
// =============================================================================

async function healthCheck(
  connection: Connection,
  keeper: Keypair
): Promise<void> {
  logInfo("Running health check...");

  try {
    const config = await readConfigState(connection);

    const collateral = config.musdxCollateralAmount;
    const debt = config.usdcDebtAmount;
    const equity = collateral > debt ? collateral - debt : 0n;

    logInfo("Position state", {
      admin: config.admin.toBase58(),
      keeper: config.keeper.toBase58(),
      paused: config.paused,
      collateral: collateral.toString(),
      debt: debt.toString(),
      equity: equity.toString(),
      currentLeverageBps: config.currentLeverageBps,
      targetLeverageBps: config.targetLeverageBps,
      maxLeverageBps: config.maxLeverageBps,
      maxSlippageBps: config.maxSlippageBps,
      minSwapPriceBps: config.minSwapPriceBps,
      loopIterationCap: config.loopIterationCap,
      lastRefreshTs: config.lastRefreshTs.toString(),
    });

    // Check token balances
    const idleUsdx = await getTokenBalance(connection, STRATEGY_USDX_ATA);
    const idleMusdx = await getTokenBalance(connection, STRATEGY_MUSDX_ATA);
    const idleUsdc = await getTokenBalance(connection, STRATEGY_USDC_ATA);

    logInfo("Strategy ATA balances", {
      usdx: idleUsdx.toString(),
      musdx: idleMusdx.toString(),
      usdc: idleUsdc.toString(),
    });

    // Check if strategy is paused
    if (config.paused) {
      logWarn("Strategy is PAUSED");
      return;
    }

    // Check if keeper key matches
    if (!config.keeper.equals(keeper.publicKey)) {
      logWarn("Keeper key mismatch!", {
        configKeeper: config.keeper.toBase58(),
        ourKeeper: keeper.publicKey.toBase58(),
      });
    }

    // Check leverage drift
    if (
      config.currentLeverageBps > 0 &&
      config.targetLeverageBps > 0 &&
      collateral > 0n
    ) {
      const drift = Math.abs(
        config.currentLeverageBps - config.targetLeverageBps
      );
      const driftPct =
        (drift / config.targetLeverageBps) * 100;

      if (driftPct > 10) {
        logWarn(`Leverage drifted ${driftPct.toFixed(1)}% from target`, {
          current: config.currentLeverageBps,
          target: config.targetLeverageBps,
          driftBps: drift,
        });

        // Attempt rebalance
        if (config.currentLeverageBps < config.targetLeverageBps) {
          logInfo("Leverage below target, opening leverage steps...");
          try {
            await executeLeverageLoop(connection, keeper);
          } catch (err: any) {
            logError("Rebalance leverage-up failed", {
              error: err?.message,
            });
          }
        } else if (config.currentLeverageBps > config.maxLeverageBps) {
          logWarn("Leverage ABOVE maximum, executing emergency deleverage step");
          try {
            await executeCloseLeverageStep(connection, keeper);
          } catch (err: any) {
            logError("Emergency deleverage step failed", {
              error: err?.message,
            });
          }
        }
      } else {
        logInfo(`Leverage within tolerance (drift: ${driftPct.toFixed(1)}%)`);
      }
    }

    // Check for idle USDX that should be deposited
    if (idleUsdx >= BigInt(MIN_DEPOSIT_THRESHOLD)) {
      logInfo("Idle USDX detected, deploying...");
      try {
        await executeDeposit(connection, keeper);
      } catch (err: any) {
        logError("Auto-deposit from health check failed", {
          error: err?.message,
        });
      }
    }
  } catch (err: any) {
    logError("Health check failed", { error: err?.message });
  }
}

// =============================================================================
// Print status
// =============================================================================

async function printStatus(connection: Connection): Promise<void> {
  const config = await readConfigState(connection);

  const collateral = config.musdxCollateralAmount;
  const debt = config.usdcDebtAmount;
  const equity = collateral > debt ? collateral - debt : 0n;

  const idleUsdx = await getTokenBalance(connection, STRATEGY_USDX_ATA);
  const idleMusdx = await getTokenBalance(connection, STRATEGY_MUSDX_ATA);
  const idleUsdc = await getTokenBalance(connection, STRATEGY_USDC_ATA);
  const collateralTokens = await getTokenBalance(
    connection,
    STRATEGY_COLLATERAL_ATA
  );

  console.log("\n========================================");
  console.log("  Leveraged mUSDX Vault - Position Status");
  console.log("========================================\n");
  console.log(`  Config PDA:       ${CONFIG_PDA.toBase58()}`);
  console.log(`  Vault:            ${VAULT.toBase58()}`);
  console.log(`  Admin:            ${config.admin.toBase58()}`);
  console.log(`  Keeper:           ${config.keeper.toBase58()}`);
  console.log(`  Paused:           ${config.paused}`);
  console.log();
  console.log("  --- Position ---");
  console.log(
    `  Collateral (mUSDX):   ${formatTokenAmount(collateral)} mUSDX`
  );
  console.log(`  Debt (USDC):          ${formatTokenAmount(debt)} USDC`);
  console.log(`  Equity:               ${formatTokenAmount(equity)}`);
  console.log(
    `  Current Leverage:     ${(config.currentLeverageBps / 10000).toFixed(2)}x (${config.currentLeverageBps} bps)`
  );
  console.log(
    `  Target Leverage:      ${(config.targetLeverageBps / 10000).toFixed(2)}x (${config.targetLeverageBps} bps)`
  );
  console.log(
    `  Max Leverage:         ${(config.maxLeverageBps / 10000).toFixed(2)}x (${config.maxLeverageBps} bps)`
  );
  console.log(`  Max Slippage:         ${config.maxSlippageBps} bps`);
  console.log(`  Min Swap Price:       ${config.minSwapPriceBps} bps`);
  console.log(`  Loop Iteration Cap:   ${config.loopIterationCap}`);
  console.log();
  console.log("  --- Idle Balances ---");
  console.log(`  USDX:                 ${formatTokenAmount(idleUsdx)}`);
  console.log(`  mUSDX:                ${formatTokenAmount(idleMusdx)}`);
  console.log(`  USDC:                 ${formatTokenAmount(idleUsdc)}`);
  console.log(
    `  Save coll. tokens:    ${formatTokenAmount(collateralTokens)}`
  );
  console.log();
  console.log(
    `  Last Refresh:         ${new Date(Number(config.lastRefreshTs) * 1000).toISOString()}`
  );
  console.log("========================================\n");
}

function formatTokenAmount(amount: bigint): string {
  const whole = amount / 1_000_000n;
  const frac = amount % 1_000_000n;
  return `${whole.toString()}.${frac.toString().padStart(6, "0")}`;
}

// =============================================================================
// Webhook server
// =============================================================================

function startServer(connection: Connection, keeper: Keypair): void {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  const PORT = parseInt(process.env.PORT || "3000", 10);

  // Health endpoint
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      keeper: keeper.publicKey.toBase58(),
      vault: VAULT.toBase58(),
      configPda: CONFIG_PDA.toBase58(),
      timestamp: new Date().toISOString(),
    });
  });

  // Alchemy webhook endpoint
  app.post("/webhook", async (req, res) => {
    try {
      logInfo("Webhook received", {
        type: req.body?.type,
        id: req.body?.id,
      });

      // Respond immediately to avoid Alchemy timeout
      res.status(200).json({ received: true });

      // Process asynchronously
      processWebhookPayload(connection, keeper, req.body).catch((err) => {
        logError("Webhook processing failed", { error: err?.message });
      });
    } catch (err: any) {
      logError("Webhook handler error", { error: err?.message });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Start periodic health check
  setInterval(() => {
    healthCheck(connection, keeper).catch((err) => {
      logError("Periodic health check error", { error: err?.message });
    });
  }, HEALTH_CHECK_INTERVAL_MS);

  app.listen(PORT, () => {
    logInfo(`Keeper server started`, {
      port: PORT,
      keeper: keeper.publicKey.toBase58(),
      vault: VAULT.toBase58(),
      configPda: CONFIG_PDA.toBase58(),
      healthCheckIntervalMin: HEALTH_CHECK_INTERVAL_MS / 60_000,
    });

    // Run initial health check on startup
    healthCheck(connection, keeper).catch((err) => {
      logError("Initial health check error", { error: err?.message });
    });
  });
}

/**
 * Process an Alchemy webhook payload. Detect vault idle ATA balance changes
 * and trigger deposit or withdrawal flows.
 */
async function processWebhookPayload(
  connection: Connection,
  keeper: Keypair,
  payload: any
): Promise<void> {
  if (!payload) {
    logWarn("Empty webhook payload");
    return;
  }

  // Alchemy Enhanced Webhooks send account activity notifications
  // Format: { webhookId, id, createdAt, type, event: { ... } }
  const event = payload.event || payload;

  // Check for account activity type webhooks
  if (payload.type === "ENHANCED_TRANSACTION" || payload.type === "ADDRESS_ACTIVITY") {
    const activities = event?.activity || event?.data || [];

    for (const activity of Array.isArray(activities) ? activities : [activities]) {
      await handleActivity(connection, keeper, activity);
    }
    return;
  }

  // Handle raw account change notifications
  // These come from Alchemy "Account Change" webhook type
  if (event?.accountKeyIndex !== undefined || event?.nativeTransfers || event?.tokenTransfers) {
    const tokenTransfers = event?.tokenTransfers || [];
    for (const transfer of tokenTransfers) {
      // Check if our strategy USDX ATA received tokens
      if (
        transfer.toUserAccount === STRATEGY_USDX_ATA.toBase58() ||
        transfer.toTokenAccount === STRATEGY_USDX_ATA.toBase58()
      ) {
        logInfo("Detected USDX transfer to strategy ATA", {
          amount: transfer.tokenAmount,
          from: transfer.fromUserAccount,
        });
        await executeDeposit(connection, keeper);
        return;
      }
    }
  }

  // Fallback: check the strategy ATA balance directly if we get any notification
  // about accounts we care about
  try {
    const idleUsdx = await getTokenBalance(connection, STRATEGY_USDX_ATA);
    if (idleUsdx >= BigInt(MIN_DEPOSIT_THRESHOLD)) {
      logInfo("Idle USDX detected after webhook, deploying...", {
        amount: idleUsdx.toString(),
      });
      await executeDeposit(connection, keeper);
    }
  } catch (err: any) {
    logError("Failed to check strategy ATA balance", {
      error: err?.message,
    });
  }
}

/**
 * Handle a single activity notification from Alchemy.
 */
async function handleActivity(
  connection: Connection,
  keeper: Keypair,
  activity: any
): Promise<void> {
  if (!activity) return;

  const strategyUsdxStr = STRATEGY_USDX_ATA.toBase58();

  // Check if this activity involves our strategy's USDX ATA
  const toAddress = activity.toAddress || activity.to || "";
  const fromAddress = activity.fromAddress || activity.from || "";
  const asset = activity.asset || "";
  const category = activity.category || "";

  // Deposit detected: USDX arrived at strategy ATA
  if (toAddress === strategyUsdxStr) {
    logInfo("USDX deposit detected via webhook activity", {
      from: fromAddress,
      amount: activity.value || activity.rawContract?.value,
      category,
    });

    // Allow a brief delay for the transaction to finalize
    await sleep(2000);
    await executeDeposit(connection, keeper);
    return;
  }

  // Withdrawal request: monitor for Voltr withdrawal signals
  // This would be detected by monitoring the vault's withdrawal queue
  // or specific program log patterns
  if (
    fromAddress === strategyUsdxStr &&
    category === "token"
  ) {
    logInfo("Potential withdrawal detected", {
      to: toAddress,
      amount: activity.value,
    });
    // Check if we need to unwind to service the withdrawal
    const config = await readConfigState(connection);
    if (config.usdcDebtAmount > 0n) {
      logInfo("Unwinding to service withdrawal...");
      await executeFullUnwind(connection, keeper);
    }
  }
}

// =============================================================================
// Ensure ATAs exist
// =============================================================================

async function ensureStrategyATAs(
  connection: Connection,
  keeper: Keypair
): Promise<void> {
  logInfo("Ensuring strategy ATAs exist...");

  const atas = [
    { mint: USDX_MINT, ata: STRATEGY_USDX_ATA, name: "USDX" },
    { mint: MUSDX_MINT, ata: STRATEGY_MUSDX_ATA, name: "mUSDX" },
    { mint: USDC_MINT, ata: STRATEGY_USDC_ATA, name: "USDC" },
    {
      mint: MUSDX_COLLATERAL_MINT,
      ata: STRATEGY_COLLATERAL_ATA,
      name: "Save Collateral",
    },
  ];

  const createIxs: TransactionInstruction[] = [];

  for (const { mint, ata, name } of atas) {
    const info = await connection.getAccountInfo(ata);
    if (!info) {
      logInfo(`Creating ${name} ATA: ${ata.toBase58()}`);
      createIxs.push(
        createAssociatedTokenAccountIdempotentInstruction(
          keeper.publicKey,
          ata,
          CONFIG_PDA,
          mint
        )
      );
    }
  }

  if (createIxs.length > 0) {
    const sig = await sendWithRetry(connection, createIxs, [keeper]);
    logInfo(`Created ${createIxs.length} ATAs`, { signature: sig });
  } else {
    logInfo("All strategy ATAs already exist");
  }
}

// =============================================================================
// CLI entry point
// =============================================================================

async function main(): Promise<void> {
  const command = process.argv[2] || "server";

  logInfo(`Keeper starting`, { command });

  const connection = getConnection();
  const keeper = getKeeper();

  logInfo(`Keeper public key: ${keeper.publicKey.toBase58()}`);

  switch (command) {
    case "server":
      await ensureStrategyATAs(connection, keeper);
      await resumePendingActions();
      startServer(connection, keeper);
      break;

    case "deposit":
      await ensureStrategyATAs(connection, keeper);
      await executeDeposit(connection, keeper);
      break;

    case "unwind":
      await executeCloseLeverageStep(connection, keeper);
      logInfo("Single unwind step complete");
      break;

    case "unwind-all":
      await executeFullUnwind(connection, keeper);
      break;

    case "leverage":
      await executeLeverageLoop(connection, keeper);
      break;

    case "status":
      await printStatus(connection);
      break;

    default:
      console.error(
        `Unknown command: ${command}\n` +
          `Usage: npx ts-node keeper/index.ts [server|deposit|unwind|unwind-all|leverage|status]`
      );
      process.exit(1);
  }
}

main().catch((err) => {
  logError("Fatal error", { error: err?.message, stack: err?.stack });
  process.exit(1);
});
