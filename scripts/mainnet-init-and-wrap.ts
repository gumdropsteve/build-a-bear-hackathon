/**
 * mainnet-init-and-wrap.ts
 *
 * 1. Initialize mUSDX with real USDX mint + 7-day cooldown
 * 2. Wrap 1 USDX -> 1 mUSDX (first deposit, 1:1)
 *
 * Usage:
 *   npx ts-node scripts/mainnet-init-and-wrap.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
  getMint,
} from "@solana/spl-token";
import { createHash } from "crypto";
import BN from "bn.js";
import * as fs from "fs";
import * as os from "os";

// ──────────────────── Config ────────────────────

const MUSDX_PROGRAM_ID = new PublicKey(
  "5NTrBzBD92B8qRDquvxBihpcxQHmCNqu2WtmoT9RRFpK"
);
const USDX_MINT = new PublicKey(
  "9Gst2E7KovZ9jwecyGqnnhpG1mhHKdyLpJQnZonkCFhA"
);

const STATE_SEED = Buffer.from("state");
const USDX_VAULT_SEED = Buffer.from("usdx_vault");
const MUSDX_MINT_SEED = Buffer.from("musdx_mint");
const COOLDOWN_SILO_SEED = Buffer.from("usdx_cooldown_silo");

const SEVEN_DAYS = 7 * 24 * 60 * 60; // 604800 seconds

// ──────────────────── Helpers ────────────────────

function ixDiscriminator(name: string): Buffer {
  return createHash("sha256")
    .update(`global:${name}`)
    .digest()
    .slice(0, 8);
}

function u64(n: BN | number): Buffer {
  const bn = BN.isBN(n) ? n : new BN(n);
  return bn.toArrayLike(Buffer, "le", 8);
}

function i64(n: BN | number): Buffer {
  const bn = BN.isBN(n) ? n : new BN(n);
  return bn.toTwos(64).toArrayLike(Buffer, "le", 8);
}

function loadKeypair(filePath: string): Keypair {
  const resolved = filePath.replace("~", os.homedir());
  const raw = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

// ──────────────────── Main ────────────────────

async function main() {
  const connection = new Connection(
    "https://api.mainnet-beta.solana.com",
    "confirmed"
  );

  const payer = loadKeypair("~/.config/solana/id.json");
  console.log("Payer/Admin:", payer.publicKey.toBase58());
  console.log("Program:    ", MUSDX_PROGRAM_ID.toBase58());
  console.log("USDX mint:  ", USDX_MINT.toBase58());

  const balance = await connection.getBalance(payer.publicKey);
  console.log("Balance:    ", (balance / 1e9).toFixed(4), "SOL\n");

  // Derive PDAs
  const [statePda] = PublicKey.findProgramAddressSync(
    [STATE_SEED],
    MUSDX_PROGRAM_ID
  );
  const [musdxMintPda] = PublicKey.findProgramAddressSync(
    [MUSDX_MINT_SEED],
    MUSDX_PROGRAM_ID
  );
  const [usdxVaultPda] = PublicKey.findProgramAddressSync(
    [USDX_VAULT_SEED],
    MUSDX_PROGRAM_ID
  );
  const [cooldownSiloPda] = PublicKey.findProgramAddressSync(
    [COOLDOWN_SILO_SEED],
    MUSDX_PROGRAM_ID
  );

  console.log("PDAs:");
  console.log("  state:         ", statePda.toBase58());
  console.log("  musdx_mint:    ", musdxMintPda.toBase58());
  console.log("  usdx_vault:    ", usdxVaultPda.toBase58());
  console.log("  cooldown_silo: ", cooldownSiloPda.toBase58());
  console.log();

  // ─── Step 1: Initialize ───
  console.log("1. initialize (cooldown = 7 days / 604800s)...");
  {
    const data = Buffer.concat([
      ixDiscriminator("initialize"),
      i64(SEVEN_DAYS),
    ]);

    const ix = new TransactionInstruction({
      programId: MUSDX_PROGRAM_ID,
      keys: [
        { pubkey: statePda, isSigner: false, isWritable: true },
        { pubkey: USDX_MINT, isSigner: false, isWritable: false },
        { pubkey: musdxMintPda, isSigner: false, isWritable: true },
        { pubkey: usdxVaultPda, isSigner: false, isWritable: true },
        { pubkey: cooldownSiloPda, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: false }, // admin
        { pubkey: payer.publicKey, isSigner: true, isWritable: true }, // payer
        {
          pubkey: SystemProgram.programId,
          isSigner: false,
          isWritable: false,
        },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction().add(ix);
    const txSig = await sendAndConfirmTransaction(connection, tx, [payer]);
    console.log("  tx:", txSig);

    const mintInfo = await getMint(connection, musdxMintPda);
    console.log("  mUSDX mint decimals:", mintInfo.decimals);
    console.log("  mUSDX mint supply:  ", mintInfo.supply.toString());

    const vaultInfo = await getAccount(connection, usdxVaultPda);
    console.log("  vault balance:      ", vaultInfo.amount.toString());
    console.log("  PASS\n");
  }

  // ─── Step 2: Wrap 1 USDX ───
  console.log("2. wrap 1 USDX (1_000_000 base units)...");
  {
    // Check deployer's USDX balance first
    const payerUsdxAta = getAssociatedTokenAddressSync(
      USDX_MINT,
      payer.publicKey
    );

    let payerUsdxBalance: bigint;
    try {
      const acct = await getAccount(connection, payerUsdxAta);
      payerUsdxBalance = acct.amount;
    } catch {
      console.error(
        "  ERROR: Deployer has no USDX ATA. Send USDX to:",
        payerUsdxAta.toBase58()
      );
      return;
    }
    console.log(
      "  deployer USDX balance:",
      payerUsdxBalance.toString(),
      `(${Number(payerUsdxBalance) / 1e6} USDX)`
    );

    if (payerUsdxBalance < 1_000_000n) {
      console.error(
        "  ERROR: Need at least 1 USDX (1_000_000 base units). Current:",
        payerUsdxBalance.toString()
      );
      return;
    }

    // Create deployer's mUSDX ATA if needed
    const payerMusdxAta = getAssociatedTokenAddressSync(
      musdxMintPda,
      payer.publicKey
    );
    const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      payerMusdxAta,
      payer.publicKey,
      musdxMintPda
    );

    const wrapData = Buffer.concat([
      ixDiscriminator("wrap"),
      u64(1_000_000), // 1 USDX
    ]);
    const wrapIx = new TransactionInstruction({
      programId: MUSDX_PROGRAM_ID,
      keys: [
        { pubkey: statePda, isSigner: false, isWritable: false },
        { pubkey: USDX_MINT, isSigner: false, isWritable: false },
        { pubkey: musdxMintPda, isSigner: false, isWritable: true },
        { pubkey: usdxVaultPda, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
        { pubkey: payerUsdxAta, isSigner: false, isWritable: true },
        { pubkey: payerMusdxAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: wrapData,
    });

    const tx = new Transaction().add(createAtaIx, wrapIx);
    const txSig = await sendAndConfirmTransaction(connection, tx, [payer]);
    console.log("  tx:", txSig);

    const musdxBal = await getAccount(connection, payerMusdxAta);
    console.log(
      "  deployer mUSDX balance:",
      musdxBal.amount.toString(),
      `(${Number(musdxBal.amount) / 1e6} mUSDX)`
    );

    const vaultBal = await getAccount(connection, usdxVaultPda);
    console.log(
      "  vault USDX balance:    ",
      vaultBal.amount.toString(),
      `(${Number(vaultBal.amount) / 1e6} USDX)`
    );

    console.log("  PASS\n");
  }

  const finalBalance = await connection.getBalance(payer.publicKey);
  console.log("========================================");
  console.log("  mUSDX LIVE ON MAINNET");
  console.log("  Program:    ", MUSDX_PROGRAM_ID.toBase58());
  console.log("  mUSDX mint: ", musdxMintPda.toBase58());
  console.log("  USDX vault: ", usdxVaultPda.toBase58());
  console.log("  Cooldown:    7 days");
  console.log("  Remaining:  ", (finalBalance / 1e9).toFixed(4), "SOL");
  console.log("========================================");
}

main().catch((err) => {
  console.error("\nFAILED:", err);
  process.exit(1);
});
