/**
 * test-orca-open-close.ts — Phase 2 smoke test for orca_adaptor.
 *
 * Flow:
 *   1. Ensure config PDA exists (re-use or create).
 *   2. open_position on the SOL/USDC Whirlpool with a valid tick range.
 *      Position has 0 liquidity at this point.
 *   3. close_position on the same position.
 *
 * This exercises the two new CPIs end-to-end without needing any LP capital,
 * since Whirlpool lets you open a 0-liquidity position and close it.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";

const ORCA_ADAPTOR = new PublicKey("5o35D7VMZpJpN9JQxuhzdGiYQofNfgXQFcuWxihFD8Lc");
const WHIRLPOOL_PROGRAM = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
const WHIRLPOOL = new PublicKey("4HppGTweoGQ8ZZ6UcCgwJKfi5mJD9Dqwy6htCpnbfBLW");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const CONFIG_SEED = Buffer.from("orca_strategy_config");
const VOLTR_VAULT_SEED = new PublicKey("CpLxaSioYMjJscmX4gH13iAkrxrMLJTH1PXYQMMeuKB5");

function disc(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().slice(0, 8);
}

function loadKp(p: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(p.replace("~", os.homedir()), "utf-8")))
  );
}

async function fetchWhirlpoolTickSpacing(
  conn: Connection,
  pool: PublicKey
): Promise<number> {
  const info = await conn.getAccountInfo(pool);
  if (!info) throw new Error("whirlpool not found");
  return info.data.readUInt16LE(41);
}

/** Round `tick` down to the nearest multiple of `spacing`. */
function floorToSpacing(tick: number, spacing: number): number {
  return Math.floor(tick / spacing) * spacing;
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

  // ---- 1. Ensure config PDA exists ----
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
    console.log("\n[1] config PDA already exists — skipping init");
  }

  // ---- 2. open_position ----
  console.log("\n[2] open_position...");
  const tickSpacing = await fetchWhirlpoolTickSpacing(conn, WHIRLPOOL);
  console.log("  tick_spacing:", tickSpacing);

  // Pool current tick ≈ -24354 at time of Phase 1 test. Use a range well
  // inside valid bounds that's also aligned to tick_spacing.
  const tickLower = floorToSpacing(-30000, tickSpacing);
  const tickUpper = floorToSpacing(-20000, tickSpacing);
  console.log(`  tick_range: [${tickLower}, ${tickUpper}]`);

  const positionMint = Keypair.generate();
  const [position, positionBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("position"), positionMint.publicKey.toBuffer()],
    WHIRLPOOL_PROGRAM
  );
  const positionTokenAccount = getAssociatedTokenAddressSync(
    positionMint.publicKey,
    configPda,
    true
  );
  console.log("  position_mint:", positionMint.publicKey.toBase58());
  console.log("  position     :", position.toBase58());
  console.log("  position_ata :", positionTokenAccount.toBase58());

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
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },  // keeper
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },   // funder
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

  const openSig = await sendAndConfirmTransaction(
    conn,
    new Transaction().add(openIx),
    [payer, positionMint]
  );
  console.log("  tx:", openSig);

  // Verify position was created
  const posInfo = await conn.getAccountInfo(position);
  if (!posInfo) throw new Error("position account was not created");
  console.log("  position account created, len:", posInfo.data.length);

  // ---- 3. close_position ----
  console.log("\n[3] close_position...");
  const closeIx = new TransactionInstruction({
    programId: ORCA_ADAPTOR,
    keys: [
      { pubkey: configPda, isSigner: false, isWritable: false },
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },  // keeper
      { pubkey: payer.publicKey, isSigner: false, isWritable: true },  // receiver
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: positionMint.publicKey, isSigner: false, isWritable: true },
      { pubkey: positionTokenAccount, isSigner: false, isWritable: true },
      { pubkey: WHIRLPOOL_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: disc("close_position"),
  });

  const closeSig = await sendAndConfirmTransaction(
    conn,
    new Transaction().add(closeIx),
    [payer]
  );
  console.log("  tx:", closeSig);

  const posAfter = await conn.getAccountInfo(position);
  if (posAfter) {
    console.log("\n✗ position account still exists after close");
    process.exit(1);
  }

  console.log("\n✓ open_position + close_position both succeeded — Phase 2 works");
}

main().catch((e) => {
  console.error("FAIL:", e.message || e);
  console.error(e.logs || e.transactionLogs || "");
  process.exit(1);
});
