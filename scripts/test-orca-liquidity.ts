/**
 * test-orca-liquidity.ts — Phase 3 smoke test for orca_adaptor.
 *
 * Flow:
 *   1. Ensure config PDA exists.
 *   2. Fund strategy WSOL ATA from keeper's SOL.
 *   3. swap 0.003 WSOL -> USDC via our adaptor (Phase 1 ix) so strategy has
 *      both sides of the pool.
 *   4. open_position on the 4bps SOL/USDC Whirlpool (Phase 2).
 *   5. increase_liquidity with modest maxes, small liquidity_amount.
 *   6. decrease_liquidity back to 0.
 *   7. close_position.
 *
 * Exercises every orca_adaptor ix end-to-end.
 */
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction, SYSVAR_RENT_PUBKEY,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, NATIVE_MINT, ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
} from "@solana/spl-token";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";

const ORCA_ADAPTOR = new PublicKey("5o35D7VMZpJpN9JQxuhzdGiYQofNfgXQFcuWxihFD8Lc");
const WHIRLPOOL_PROGRAM = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
const WHIRLPOOL = new PublicKey("4HppGTweoGQ8ZZ6UcCgwJKfi5mJD9Dqwy6htCpnbfBLW");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const SOL = NATIVE_MINT;
const CONFIG_SEED = Buffer.from("orca_strategy_config");
const VOLTR_VAULT_SEED = new PublicKey("CpLxaSioYMjJscmX4gH13iAkrxrMLJTH1PXYQMMeuKB5");
const TICK_ARRAY_SIZE = 88;

const MAX_SQRT_PRICE_X64 = 79226673515401279992447579055n;
const MIN_SQRT_PRICE_X64 = 4295048016n;

function disc(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().slice(0, 8);
}
function loadKp(p: string) {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(p.replace("~", os.homedir()), "utf-8")))
  );
}
function deriveStartTickIndex(t: number, s: number) {
  return Math.floor(t / (s * TICK_ARRAY_SIZE)) * (s * TICK_ARRAY_SIZE);
}
function tickArrayPda(pool: PublicKey, startTick: number) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("tick_array"), pool.toBuffer(), Buffer.from(startTick.toString())],
    WHIRLPOOL_PROGRAM
  )[0];
}
function oraclePda(pool: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("oracle"), pool.toBuffer()],
    WHIRLPOOL_PROGRAM
  )[0];
}
function floorTo(t: number, s: number) { return Math.floor(t / s) * s; }

async function fetchWhirlpool(conn: Connection, pool: PublicKey) {
  const info = (await conn.getAccountInfo(pool))!;
  const d = info.data;
  return {
    tickSpacing: d.readUInt16LE(41),
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
  const [configPda] = PublicKey.findProgramAddressSync(
    [CONFIG_SEED, VOLTR_VAULT_SEED.toBuffer()], ORCA_ADAPTOR
  );
  console.log("Payer:        ", payer.publicKey.toBase58());
  console.log("Orca adaptor: ", ORCA_ADAPTOR.toBase58());
  console.log("Config PDA:   ", configPda.toBase58());

  // ---- 1. init config ----
  if (!(await conn.getAccountInfo(configPda))) {
    console.log("\n[1] initialize_config...");
    const args = Buffer.concat([VOLTR_VAULT_SEED.toBuffer(), USDC.toBuffer()]);
    const ix = new TransactionInstruction({
      programId: ORCA_ADAPTOR,
      keys: [
        { pubkey: configPda, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([disc("initialize_config"), args]),
    });
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [payer]);
    console.log("  tx:", sig);
  } else {
    console.log("\n[1] config PDA already exists");
  }

  // ---- 2. Create + fund strategy ATAs ----
  const strategyWsolAta = getAssociatedTokenAddressSync(SOL, configPda, true);
  const strategyUsdcAta = getAssociatedTokenAddressSync(USDC, configPda, true);
  console.log("\n[2] create + fund strategy ATAs...");
  const createAtasIx = [
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, strategyWsolAta, configPda, SOL),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, strategyUsdcAta, configPda, USDC),
  ];
  const WRAP = 6_000_000; // 0.006 SOL
  const fundTx = new Transaction()
    .add(...createAtasIx)
    .add(SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: strategyWsolAta,
      lamports: WRAP,
    }))
    .add(createSyncNativeInstruction(strategyWsolAta));
  const sig2 = await sendAndConfirmTransaction(conn, fundTx, [payer]);
  console.log("  tx:", sig2);

  // ---- 3. swap some WSOL -> USDC via adaptor ----
  console.log("\n[3] swap ~0.003 WSOL -> USDC via adaptor...");
  const pool0 = await fetchWhirlpool(conn, WHIRLPOOL);
  const startCurrent = deriveStartTickIndex(pool0.tickCurrentIndex, pool0.tickSpacing);
  const arraySpan = pool0.tickSpacing * TICK_ARRAY_SIZE;
  const tickArraysSwap = [startCurrent, startCurrent - arraySpan, startCurrent - 2 * arraySpan]
    .map(st => tickArrayPda(WHIRLPOOL, st));
  const oracle = oraclePda(WHIRLPOOL);

  const swapAmount = 3_000_000n; // 0.003 WSOL
  const swapData = Buffer.concat([
    disc("swap"),
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(swapAmount); return b; })(),
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(0n); return b; })(), // min_out
    Buffer.from([1]), // a_to_b
    (() => {
      const b = Buffer.alloc(16);
      b.writeBigUInt64LE((MIN_SQRT_PRICE_X64 + 1n) & 0xffffffffffffffffn, 0);
      b.writeBigUInt64LE((MIN_SQRT_PRICE_X64 + 1n) >> 64n, 8);
      return b;
    })(),
  ]);
  const swapIx = new TransactionInstruction({
    programId: ORCA_ADAPTOR,
    keys: [
      { pubkey: configPda, isSigner: false, isWritable: false },
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      { pubkey: strategyWsolAta, isSigner: false, isWritable: true },
      { pubkey: strategyUsdcAta, isSigner: false, isWritable: true },
      { pubkey: WHIRLPOOL, isSigner: false, isWritable: true },
      { pubkey: pool0.tokenVaultA, isSigner: false, isWritable: true },
      { pubkey: pool0.tokenVaultB, isSigner: false, isWritable: true },
      { pubkey: tickArraysSwap[0], isSigner: false, isWritable: true },
      { pubkey: tickArraysSwap[1], isSigner: false, isWritable: true },
      { pubkey: tickArraysSwap[2], isSigner: false, isWritable: true },
      { pubkey: oracle, isSigner: false, isWritable: true },
      { pubkey: WHIRLPOOL_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: swapData,
  });
  const sig3 = await sendAndConfirmTransaction(conn, new Transaction().add(swapIx), [payer]);
  console.log("  tx:", sig3);

  // ---- 4. open_position ----
  console.log("\n[4] open_position...");
  const pool = await fetchWhirlpool(conn, WHIRLPOOL);
  // Keep both ticks inside the tick array containing the current tick —
  // that array is guaranteed to be initialized (swaps traverse it
  // constantly), so we don't need to init one ourselves.
  const arraySpan2 = pool.tickSpacing * TICK_ARRAY_SIZE;
  const curStart = Math.floor(pool.tickCurrentIndex / arraySpan2) * arraySpan2;
  const tickLower = curStart; // start of current array
  const tickUpper = curStart + arraySpan2 - pool.tickSpacing; // end of current array (exclusive -1)
  console.log(`  tick_range: [${tickLower}, ${tickUpper}] (tick_current=${pool.tickCurrentIndex})`);
  const positionMint = Keypair.generate();
  const [position, positionBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("position"), positionMint.publicKey.toBuffer()], WHIRLPOOL_PROGRAM
  );
  const positionTokenAccount = getAssociatedTokenAddressSync(
    positionMint.publicKey, configPda, true
  );
  const openData = Buffer.concat([
    disc("open_position"),
    Buffer.from(new Int32Array([tickLower]).buffer),
    Buffer.from(new Int32Array([tickUpper]).buffer),
    Buffer.from([positionBump]),
  ]);
  const openIx = new TransactionInstruction({
    programId: ORCA_ADAPTOR,
    keys: [
      { pubkey: configPda, isSigner: false, isWritable: false },
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: positionMint.publicKey, isSigner: true, isWritable: true },
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: positionTokenAccount, isSigner: false, isWritable: true },
      { pubkey: WHIRLPOOL, isSigner: false, isWritable: false },
      { pubkey: WHIRLPOOL_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: openData,
  });
  const sig4 = await sendAndConfirmTransaction(conn, new Transaction().add(openIx), [payer, positionMint]);
  console.log("  tx:", sig4);
  console.log("  position:", position.toBase58());

  // ---- 5. increase_liquidity ----
  console.log("\n[5] increase_liquidity...");
  // Tick arrays covering tick_lower and tick_upper (for -30000 and -20000):
  const tickArrayLower = tickArrayPda(WHIRLPOOL, deriveStartTickIndex(tickLower, pool.tickSpacing));
  const tickArrayUpper = tickArrayPda(WHIRLPOOL, deriveStartTickIndex(tickUpper, pool.tickSpacing));
  console.log("  tick_array_lower:", tickArrayLower.toBase58());
  console.log("  tick_array_upper:", tickArrayUpper.toBase58());

  // Small liquidity_amount. Whirlpool will consume at most token_max_a / _b.
  const liquidityAmount = 1_000_000n; // 1e6 L units
  const tokenMaxA = 1_000_000n; // 0.001 WSOL cap
  const tokenMaxB = 100_000n;   // 0.1 USDC cap

  const incData = Buffer.concat([
    disc("increase_liquidity"),
    (() => {
      const b = Buffer.alloc(16);
      b.writeBigUInt64LE(liquidityAmount & 0xffffffffffffffffn, 0);
      b.writeBigUInt64LE(liquidityAmount >> 64n, 8);
      return b;
    })(),
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(tokenMaxA); return b; })(),
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(tokenMaxB); return b; })(),
  ]);

  const modifyKeys = [
    { pubkey: configPda, isSigner: false, isWritable: false },
    { pubkey: payer.publicKey, isSigner: true, isWritable: false },
    { pubkey: WHIRLPOOL, isSigner: false, isWritable: true },
    { pubkey: position, isSigner: false, isWritable: true },
    { pubkey: positionTokenAccount, isSigner: false, isWritable: false },
    { pubkey: strategyWsolAta, isSigner: false, isWritable: true },
    { pubkey: strategyUsdcAta, isSigner: false, isWritable: true },
    { pubkey: pool.tokenVaultA, isSigner: false, isWritable: true },
    { pubkey: pool.tokenVaultB, isSigner: false, isWritable: true },
    { pubkey: tickArrayLower, isSigner: false, isWritable: true },
    { pubkey: tickArrayUpper, isSigner: false, isWritable: true },
    { pubkey: WHIRLPOOL_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  const incIx = new TransactionInstruction({ programId: ORCA_ADAPTOR, keys: modifyKeys, data: incData });
  const sig5 = await sendAndConfirmTransaction(conn, new Transaction().add(incIx), [payer]);
  console.log("  tx:", sig5);

  // Read position liquidity. Position layout:
  //   8 disc + 32 whirlpool + 32 position_mint + 16 liquidity ...
  const posAfterInc = (await conn.getAccountInfo(position))!;
  const posLiquidity =
    posAfterInc.data.readBigUInt64LE(72) + (posAfterInc.data.readBigUInt64LE(80) << 64n);
  console.log("  position liquidity after increase:", posLiquidity.toString());

  // ---- 6. decrease_liquidity (all of it) ----
  console.log("\n[6] decrease_liquidity...");
  const decData = Buffer.concat([
    disc("decrease_liquidity"),
    (() => {
      const b = Buffer.alloc(16);
      b.writeBigUInt64LE(posLiquidity & 0xffffffffffffffffn, 0);
      b.writeBigUInt64LE(posLiquidity >> 64n, 8);
      return b;
    })(),
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(0n); return b; })(),
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(0n); return b; })(),
  ]);
  const decIx = new TransactionInstruction({ programId: ORCA_ADAPTOR, keys: modifyKeys, data: decData });
  const sig6 = await sendAndConfirmTransaction(conn, new Transaction().add(decIx), [payer]);
  console.log("  tx:", sig6);

  // ---- 7. close_position ----
  console.log("\n[7] close_position...");
  const closeIx = new TransactionInstruction({
    programId: ORCA_ADAPTOR,
    keys: [
      { pubkey: configPda, isSigner: false, isWritable: false },
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      { pubkey: payer.publicKey, isSigner: false, isWritable: true },
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: positionMint.publicKey, isSigner: false, isWritable: true },
      { pubkey: positionTokenAccount, isSigner: false, isWritable: true },
      { pubkey: WHIRLPOOL_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: disc("close_position"),
  });
  const sig7 = await sendAndConfirmTransaction(conn, new Transaction().add(closeIx), [payer]);
  console.log("  tx:", sig7);

  console.log("\n✓ Phase 3 end-to-end:");
  console.log("    swap  :", sig3);
  console.log("    open  :", sig4);
  console.log("    inc   :", sig5);
  console.log("    dec   :", sig6);
  console.log("    close :", sig7);
}

main().catch(e => {
  console.error("FAIL:", e.message || e);
  console.error(e.logs || e.transactionLogs || "");
  process.exit(1);
});
