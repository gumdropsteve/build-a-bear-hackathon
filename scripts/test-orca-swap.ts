/**
 * test-orca-swap.ts — Phase 1 smoke test for orca_adaptor.
 *
 * Flow:
 *   1. Initialize the config PDA (admin + keeper = deployer).
 *   2. Create the strategy's WSOL + USDC ATAs (owned by config PDA).
 *   3. Wrap ~0.001 SOL into the strategy WSOL ATA.
 *   4. Call the adaptor's `swap` ix: WSOL -> USDC through Orca's
 *      4-bps SOL/USDC Whirlpool.
 *   5. Assert USDC balance in the strategy USDC ATA went up.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
} from "@solana/spl-token";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";

const ORCA_ADAPTOR = new PublicKey("5o35D7VMZpJpN9JQxuhzdGiYQofNfgXQFcuWxihFD8Lc");
const WHIRLPOOL_PROGRAM = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");

// SOL/USDC 4 bps Whirlpool (token_mint_a = SOL, token_mint_b = USDC)
const WHIRLPOOL = new PublicKey("4HppGTweoGQ8ZZ6UcCgwJKfi5mJD9Dqwy6htCpnbfBLW");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const SOL = NATIVE_MINT; // WSOL

const CONFIG_SEED = Buffer.from("orca_strategy_config");

// Stand-in voltr_vault — Phase 1 doesn't actually CPI into Voltr, we just
// need a stable pubkey to seed the config PDA. Reuse the live USDC Voltr
// vault so the strategy is grouped with the rest of the hackathon artifacts.
const VOLTR_VAULT_SEED = new PublicKey("CpLxaSioYMjJscmX4gH13iAkrxrMLJTH1PXYQMMeuKB5");

function disc(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().slice(0, 8);
}

function loadKp(p: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(p.replace("~", os.homedir()), "utf-8")))
  );
}

// Whirlpool TICK_ARRAY_SIZE is 88 ticks per array.
const TICK_ARRAY_SIZE = 88;

function deriveStartTickIndex(tickCurrentIndex: number, tickSpacing: number): number {
  const arraySpan = tickSpacing * TICK_ARRAY_SIZE;
  return Math.floor(tickCurrentIndex / arraySpan) * arraySpan;
}

function tickArrayPda(whirlpool: PublicKey, startTick: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("tick_array"), whirlpool.toBuffer(), Buffer.from(startTick.toString())],
    WHIRLPOOL_PROGRAM
  )[0];
}

function oraclePda(whirlpool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("oracle"), whirlpool.toBuffer()],
    WHIRLPOOL_PROGRAM
  )[0];
}

// Whirlpool sqrt_price bounds (from Orca whirlpool/math): u128.
// MAX_SQRT_PRICE_X64 = 79226673515401279992447579055 (2^64 * 1.0001^443636)
// MIN_SQRT_PRICE_X64 = 4295048016
const MAX_SQRT_PRICE_X64 = 79226673515401279992447579055n;
const MIN_SQRT_PRICE_X64 = 4295048016n;

async function fetchWhirlpool(connection: Connection, pool: PublicKey) {
  const info = await connection.getAccountInfo(pool);
  if (!info) throw new Error("whirlpool not found");
  const d = info.data;
  return {
    bump: d[8],
    tickSpacing: d.readUInt16LE(41),
    feeRate: d.readUInt16LE(45),
    liquidity: d.readBigUInt64LE(49),
    sqrtPrice: d.readBigUInt64LE(65) + (d.readBigUInt64LE(73) << 64n),
    tickCurrentIndex: d.readInt32LE(81),
    tokenMintA: new PublicKey(d.slice(101, 133)),
    tokenVaultA: new PublicKey(d.slice(133, 165)),
    tokenMintB: new PublicKey(d.slice(181, 213)),
    tokenVaultB: new PublicKey(d.slice(213, 245)),
  };
}

async function main() {
  const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
  const payer = loadKp("~/.config/solana/id.json");

  console.log("Payer:       ", payer.publicKey.toBase58());
  console.log("Orca adaptor:", ORCA_ADAPTOR.toBase58());
  console.log("Whirlpool:   ", WHIRLPOOL.toBase58());

  const [configPda] = PublicKey.findProgramAddressSync(
    [CONFIG_SEED, VOLTR_VAULT_SEED.toBuffer()],
    ORCA_ADAPTOR
  );
  console.log("Config PDA:  ", configPda.toBase58());

  // ---- 1. initialize_config (idempotent — skip if already exists) ----
  const configExists = !!(await conn.getAccountInfo(configPda));
  if (!configExists) {
    console.log("\n[1] initialize_config...");
    const args = Buffer.concat([VOLTR_VAULT_SEED.toBuffer(), USDC.toBuffer()]);
    const ix = new TransactionInstruction({
      programId: ORCA_ADAPTOR,
      keys: [
        { pubkey: configPda, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: false }, // admin
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },  // payer
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([disc("initialize_config"), args]),
    });
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [payer]);
    console.log("  tx:", sig);
  } else {
    console.log("\n[1] config PDA already exists — skipping init");
  }

  // ---- 2. Create strategy ATAs (owned by config PDA) ----
  const strategySolAta = getAssociatedTokenAddressSync(SOL, configPda, true);
  const strategyUsdcAta = getAssociatedTokenAddressSync(USDC, configPda, true);
  console.log("\n[2] create strategy ATAs...");
  console.log("  strategy WSOL ATA:", strategySolAta.toBase58());
  console.log("  strategy USDC ATA:", strategyUsdcAta.toBase58());
  const createAtasIx = [
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, strategySolAta, configPda, SOL),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, strategyUsdcAta, configPda, USDC),
  ];
  const sigAta = await sendAndConfirmTransaction(conn, new Transaction().add(...createAtasIx), [payer]);
  console.log("  tx:", sigAta);

  // ---- 3. Wrap 0.001 SOL into strategy WSOL ATA ----
  const WRAP_LAMPORTS = 1_000_000; // 0.001 SOL
  console.log(`\n[3] wrap ${WRAP_LAMPORTS / LAMPORTS_PER_SOL} SOL into strategy WSOL ATA...`);
  const wrapTx = new Transaction()
    .add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: strategySolAta,
        lamports: WRAP_LAMPORTS,
      })
    )
    .add(createSyncNativeInstruction(strategySolAta));
  const sigWrap = await sendAndConfirmTransaction(conn, wrapTx, [payer]);
  console.log("  tx:", sigWrap);

  // ---- 4. Fetch whirlpool state to compute tick arrays ----
  console.log("\n[4] fetch whirlpool state...");
  const pool = await fetchWhirlpool(conn, WHIRLPOOL);
  console.log("  tick_spacing:", pool.tickSpacing);
  console.log("  tick_current_index:", pool.tickCurrentIndex);
  console.log("  token_mint_a:", pool.tokenMintA.toBase58());
  console.log("  token_mint_b:", pool.tokenMintB.toBase58());

  // For a_to_b = true (SOL -> USDC), price decreases, ticks decrease.
  // tick_array_0 = array containing current tick; _1, _2 = arrays below.
  const A_TO_B = true;
  const startCurrent = deriveStartTickIndex(pool.tickCurrentIndex, pool.tickSpacing);
  const arraySpan = pool.tickSpacing * TICK_ARRAY_SIZE;
  const startTicks = A_TO_B
    ? [startCurrent, startCurrent - arraySpan, startCurrent - 2 * arraySpan]
    : [startCurrent, startCurrent + arraySpan, startCurrent + 2 * arraySpan];
  const tickArrays = startTicks.map((st) => tickArrayPda(WHIRLPOOL, st));
  console.log("  tick_arrays:", tickArrays.map((k) => k.toBase58()));
  const oracle = oraclePda(WHIRLPOOL);
  console.log("  oracle:", oracle.toBase58());

  // ---- 5. Call swap ----
  console.log("\n[5] swap...");
  const amountIn = BigInt(WRAP_LAMPORTS); // 0.001 SOL
  const minOut = 0n; // no slippage floor — this is a smoke test
  const sqrtPriceLimit = A_TO_B ? MIN_SQRT_PRICE_X64 + 1n : MAX_SQRT_PRICE_X64 - 1n;

  // Anchor args are serialized in declaration order:
  //   amount_in (u64), min_amount_out (u64), a_to_b (bool, 1 byte), sqrt_price_limit (u128)
  const amountBuf = Buffer.alloc(8); amountBuf.writeBigUInt64LE(amountIn);
  const minOutBuf = Buffer.alloc(8); minOutBuf.writeBigUInt64LE(minOut);
  const flags = Buffer.from([A_TO_B ? 1 : 0]);
  const sqrtBuf = Buffer.alloc(16);
  sqrtBuf.writeBigUInt64LE(sqrtPriceLimit & 0xffffffffffffffffn, 0);
  sqrtBuf.writeBigUInt64LE(sqrtPriceLimit >> 64n, 8);
  const data = Buffer.concat([disc("swap"), amountBuf, minOutBuf, flags, sqrtBuf]);

  const swapIx = new TransactionInstruction({
    programId: ORCA_ADAPTOR,
    keys: [
      { pubkey: configPda, isSigner: false, isWritable: false },
      { pubkey: payer.publicKey, isSigner: true, isWritable: false }, // keeper
      { pubkey: strategySolAta, isSigner: false, isWritable: true },  // token_a ata
      { pubkey: strategyUsdcAta, isSigner: false, isWritable: true }, // token_b ata
      { pubkey: WHIRLPOOL, isSigner: false, isWritable: true },
      { pubkey: pool.tokenVaultA, isSigner: false, isWritable: true },
      { pubkey: pool.tokenVaultB, isSigner: false, isWritable: true },
      { pubkey: tickArrays[0], isSigner: false, isWritable: true },
      { pubkey: tickArrays[1], isSigner: false, isWritable: true },
      { pubkey: tickArrays[2], isSigner: false, isWritable: true },
      { pubkey: oracle, isSigner: false, isWritable: true },
      { pubkey: WHIRLPOOL_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });

  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(swapIx), [payer]);
  console.log("  tx:", sig);

  // ---- 6. Verify ----
  const usdcBal = await conn.getTokenAccountBalance(strategyUsdcAta);
  const solBal = await conn.getTokenAccountBalance(strategySolAta);
  console.log("\n[6] post-swap balances:");
  console.log("  strategy USDC:", usdcBal.value.uiAmountString);
  console.log("  strategy WSOL:", solBal.value.uiAmountString);

  if (BigInt(usdcBal.value.amount) > 0n) {
    console.log("\n✓ swap succeeded — orca_adaptor Phase 1 works end-to-end");
  } else {
    console.log("\n✗ swap completed but strategy USDC balance did not go up");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("FAIL:", e.message || e);
  console.error(e.logs || e.transactionLogs || "");
  process.exit(1);
});
