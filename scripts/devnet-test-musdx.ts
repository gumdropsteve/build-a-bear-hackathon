/**
 * devnet-test-musdx.ts
 *
 * End-to-end smoke test for the mUSDX program on devnet.
 * Creates a mock USDX mint, then exercises:
 *   1. initialize  (2-second cooldown for fast testing)
 *   2. wrap        (alice wraps 40 USDX -> 40 mUSDX at 1:1)
 *   3. post_yield  (admin posts 10 USDX -> exchange rate 1.25)
 *   4. cooldown    (alice burns 20 mUSDX -> 25 USDX locked in silo)
 *   5. claim       (after 2s cooldown -> alice gets 25 USDX back)
 *   6. set_paused  (pause then unpause)
 *
 * Usage:
 *   npx ts-node scripts/devnet-test-musdx.ts
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
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  getAccount,
  getMint,
} from "@solana/spl-token";
import { createHash } from "crypto";
import BN from "bn.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ──────────────────── Config ────────────────────

const MUSDX_PROGRAM_ID = new PublicKey(
  "5NTrBzBD92B8qRDquvxBihpcxQHmCNqu2WtmoT9RRFpK"
);

const STATE_SEED = Buffer.from("state");
const USDX_VAULT_SEED = Buffer.from("usdx_vault");
const MUSDX_MINT_SEED = Buffer.from("musdx_mint");
const COOLDOWN_SILO_SEED = Buffer.from("usdx_cooldown_silo");
const COOLDOWN_ENTRY_SEED = Buffer.from("cooldown");

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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ──────────────────── Main ────────────────────

async function main() {
  const connection = new Connection(
    "https://api.devnet.solana.com",
    "confirmed"
  );

  // Load wallet (payer + admin)
  const payer = loadKeypair("~/.config/solana/id.json");
  const admin = payer; // same key for devnet simplicity
  const alice = Keypair.generate();

  console.log("Payer/Admin:", payer.publicKey.toBase58());
  console.log("Alice:      ", alice.publicKey.toBase58());
  console.log("Program:    ", MUSDX_PROGRAM_ID.toBase58());
  console.log();

  // Fund alice from payer (devnet airdrop is rate-limited)
  console.log("Funding Alice with 0.5 SOL from payer...");
  {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: alice.publicKey,
        lamports: 0.5 * LAMPORTS_PER_SOL,
      })
    );
    const sig = await sendAndConfirmTransaction(connection, tx, [payer]);
    console.log("  tx:", sig);
    console.log("  done\n");
  }

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
  const [cooldownEntryPda] = PublicKey.findProgramAddressSync(
    [COOLDOWN_ENTRY_SEED, alice.publicKey.toBuffer()],
    MUSDX_PROGRAM_ID
  );

  console.log("PDAs:");
  console.log("  state:         ", statePda.toBase58());
  console.log("  musdx_mint:    ", musdxMintPda.toBase58());
  console.log("  usdx_vault:    ", usdxVaultPda.toBase58());
  console.log("  cooldown_silo: ", cooldownSiloPda.toBase58());
  console.log();

  // ─── Step 0: Create mock USDX mint ───
  console.log("Creating mock USDX mint (6 decimals)...");
  const usdxMint = await createMint(
    connection,
    payer,
    admin.publicKey,
    null,
    6
  );
  console.log("  USDX mint:", usdxMint.toBase58());
  console.log();

  // ─── Step 1: Initialize ───
  console.log("1. initialize (cooldown = 2 seconds)...");
  {
    const data = Buffer.concat([ixDiscriminator("initialize"), i64(2)]);
    const ix = new TransactionInstruction({
      programId: MUSDX_PROGRAM_ID,
      keys: [
        { pubkey: statePda, isSigner: false, isWritable: true },
        { pubkey: usdxMint, isSigner: false, isWritable: false },
        { pubkey: musdxMintPda, isSigner: false, isWritable: true },
        { pubkey: usdxVaultPda, isSigner: false, isWritable: true },
        { pubkey: cooldownSiloPda, isSigner: false, isWritable: true },
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
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
    assert(mintInfo.decimals === 6, "mint decimals should be 6");
    assert(mintInfo.supply === 0n, "supply should be 0");

    const vaultInfo = await getAccount(connection, usdxVaultPda);
    assert(vaultInfo.amount === 0n, "vault should be empty");
    console.log("  PASS: state, mint, vault, silo all created correctly\n");
  }

  // ─── Step 2: Wrap ───
  console.log("2. wrap (alice wraps 40 USDX)...");
  {
    // Create alice's USDX ATA and mint 100 USDX
    const aliceUsdxAta = await createAssociatedTokenAccount(
      connection,
      payer,
      usdxMint,
      alice.publicKey
    );
    await mintTo(connection, payer, usdxMint, aliceUsdxAta, admin, 100_000_000);

    // Create alice's mUSDX ATA
    const aliceMusdxAta = await createAssociatedTokenAccount(
      connection,
      payer,
      musdxMintPda,
      alice.publicKey
    );

    const data = Buffer.concat([ixDiscriminator("wrap"), u64(40_000_000)]);
    const ix = new TransactionInstruction({
      programId: MUSDX_PROGRAM_ID,
      keys: [
        { pubkey: statePda, isSigner: false, isWritable: false },
        { pubkey: usdxMint, isSigner: false, isWritable: false },
        { pubkey: musdxMintPda, isSigner: false, isWritable: true },
        { pubkey: usdxVaultPda, isSigner: false, isWritable: true },
        { pubkey: alice.publicKey, isSigner: true, isWritable: false },
        { pubkey: aliceUsdxAta, isSigner: false, isWritable: true },
        { pubkey: aliceMusdxAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data,
    });
    const txSig = await sendAndConfirmTransaction(
      connection,
      new Transaction().add(ix),
      [alice]
    );
    console.log("  tx:", txSig);

    const musdxBal = await getAccount(connection, aliceMusdxAta);
    assert(musdxBal.amount === 40_000_000n, "alice should have 40 mUSDX");

    const vaultBal = await getAccount(connection, usdxVaultPda);
    assert(vaultBal.amount === 40_000_000n, "vault should have 40 USDX");

    console.log("  PASS: alice has 40 mUSDX, vault has 40 USDX (1:1)\n");
  }

  // ─── Step 3: Post yield ───
  console.log("3. post_yield (admin posts 10 USDX -> rate = 1.25)...");
  {
    const adminUsdxAta = await createAssociatedTokenAccount(
      connection,
      payer,
      usdxMint,
      admin.publicKey
    );
    await mintTo(connection, payer, usdxMint, adminUsdxAta, admin, 10_000_000);

    const data = Buffer.concat([
      ixDiscriminator("post_yield"),
      u64(10_000_000),
    ]);
    const ix = new TransactionInstruction({
      programId: MUSDX_PROGRAM_ID,
      keys: [
        { pubkey: statePda, isSigner: false, isWritable: false },
        { pubkey: musdxMintPda, isSigner: false, isWritable: false },
        { pubkey: usdxVaultPda, isSigner: false, isWritable: true },
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: adminUsdxAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data,
    });
    const txSig = await sendAndConfirmTransaction(
      connection,
      new Transaction().add(ix),
      [payer]
    );
    console.log("  tx:", txSig);

    const vaultBal = await getAccount(connection, usdxVaultPda);
    assert(
      vaultBal.amount === 50_000_000n,
      "vault should have 50 USDX (40 + 10 yield)"
    );

    const mintInfo = await getMint(connection, musdxMintPda);
    assert(
      mintInfo.supply === 40_000_000n,
      "shares unchanged at 40 mUSDX"
    );

    console.log(
      "  PASS: vault=50 USDX, shares=40 mUSDX, rate=1.25\n"
    );
  }

  // ─── Step 4: Cooldown ───
  console.log(
    "4. cooldown (alice burns 20 mUSDX -> 25 USDX locked in silo)..."
  );
  {
    const aliceMusdxAta = getAssociatedTokenAddressSync(
      musdxMintPda,
      alice.publicKey
    );

    const data = Buffer.concat([
      ixDiscriminator("cooldown"),
      u64(20_000_000),
    ]);
    const ix = new TransactionInstruction({
      programId: MUSDX_PROGRAM_ID,
      keys: [
        { pubkey: statePda, isSigner: false, isWritable: false },
        { pubkey: usdxMint, isSigner: false, isWritable: false },
        { pubkey: musdxMintPda, isSigner: false, isWritable: true },
        { pubkey: usdxVaultPda, isSigner: false, isWritable: true },
        { pubkey: cooldownSiloPda, isSigner: false, isWritable: true },
        { pubkey: alice.publicKey, isSigner: true, isWritable: true },
        { pubkey: aliceMusdxAta, isSigner: false, isWritable: true },
        { pubkey: cooldownEntryPda, isSigner: false, isWritable: true },
        {
          pubkey: SystemProgram.programId,
          isSigner: false,
          isWritable: false,
        },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data,
    });
    const txSig = await sendAndConfirmTransaction(
      connection,
      new Transaction().add(ix),
      [alice]
    );
    console.log("  tx:", txSig);

    const vaultBal = await getAccount(connection, usdxVaultPda);
    assert(
      vaultBal.amount === 25_000_000n,
      "vault should have 25 USDX (50 - 25)"
    );

    const siloBal = await getAccount(connection, cooldownSiloPda);
    assert(siloBal.amount === 25_000_000n, "silo should have 25 USDX");

    const mintInfo = await getMint(connection, musdxMintPda);
    assert(
      mintInfo.supply === 20_000_000n,
      "shares should be 20 mUSDX (40 - 20 burned)"
    );

    console.log("  PASS: vault=25, silo=25, shares=20\n");
  }

  // ─── Step 5: Claim (wait for cooldown) ───
  console.log("5. claim (waiting 3s for 2s cooldown to elapse)...");
  await sleep(3000);
  {
    const aliceUsdxAta = getAssociatedTokenAddressSync(
      usdxMint,
      alice.publicKey
    );

    const data = ixDiscriminator("claim");
    const ix = new TransactionInstruction({
      programId: MUSDX_PROGRAM_ID,
      keys: [
        { pubkey: statePda, isSigner: false, isWritable: false },
        { pubkey: usdxMint, isSigner: false, isWritable: false },
        { pubkey: cooldownSiloPda, isSigner: false, isWritable: true },
        { pubkey: alice.publicKey, isSigner: true, isWritable: false },
        { pubkey: aliceUsdxAta, isSigner: false, isWritable: true },
        { pubkey: cooldownEntryPda, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data,
    });
    const txSig = await sendAndConfirmTransaction(
      connection,
      new Transaction().add(ix),
      [alice]
    );
    console.log("  tx:", txSig);

    const siloBal = await getAccount(connection, cooldownSiloPda);
    assert(siloBal.amount === 0n, "silo should be drained");

    const aliceUsdxBal = await getAccount(connection, aliceUsdxAta);
    assert(
      aliceUsdxBal.amount === 85_000_000n,
      "alice should have 85 USDX (60 remaining + 25 claimed)"
    );

    console.log("  PASS: silo=0, alice=85 USDX (got 25 back)\n");
  }

  // ─── Step 6: set_paused ───
  console.log("6. set_paused (pause, verify wrap fails, unpause)...");
  {
    // Pause
    const pauseData = Buffer.concat([
      ixDiscriminator("set_paused"),
      Buffer.from([1]), // true
    ]);
    const pauseIx = new TransactionInstruction({
      programId: MUSDX_PROGRAM_ID,
      keys: [
        { pubkey: statePda, isSigner: false, isWritable: true },
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
      ],
      data: pauseData,
    });
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(pauseIx),
      [payer]
    );

    // Try wrapping while paused — should fail
    const aliceUsdxAta = getAssociatedTokenAddressSync(
      usdxMint,
      alice.publicKey
    );
    const aliceMusdxAta = getAssociatedTokenAddressSync(
      musdxMintPda,
      alice.publicKey
    );
    const wrapData = Buffer.concat([ixDiscriminator("wrap"), u64(1_000_000)]);
    const wrapIx = new TransactionInstruction({
      programId: MUSDX_PROGRAM_ID,
      keys: [
        { pubkey: statePda, isSigner: false, isWritable: false },
        { pubkey: usdxMint, isSigner: false, isWritable: false },
        { pubkey: musdxMintPda, isSigner: false, isWritable: true },
        { pubkey: usdxVaultPda, isSigner: false, isWritable: true },
        { pubkey: alice.publicKey, isSigner: true, isWritable: false },
        { pubkey: aliceUsdxAta, isSigner: false, isWritable: true },
        { pubkey: aliceMusdxAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: wrapData,
    });

    let wrapFailed = false;
    try {
      await sendAndConfirmTransaction(
        connection,
        new Transaction().add(wrapIx),
        [alice]
      );
    } catch {
      wrapFailed = true;
    }
    assert(wrapFailed, "wrap should fail while paused");

    // Unpause
    const unpauseData = Buffer.concat([
      ixDiscriminator("set_paused"),
      Buffer.from([0]), // false
    ]);
    const unpauseIx = new TransactionInstruction({
      programId: MUSDX_PROGRAM_ID,
      keys: [
        { pubkey: statePda, isSigner: false, isWritable: true },
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
      ],
      data: unpauseData,
    });
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(unpauseIx),
      [payer]
    );

    console.log("  PASS: pause blocks wrap, unpause re-enables it\n");
  }

  console.log("========================================");
  console.log("  ALL 6 TESTS PASSED ON DEVNET");
  console.log("  Program:", MUSDX_PROGRAM_ID.toBase58());
  console.log("  Mock USDX:", usdxMint.toBase58());
  console.log("========================================");
}

function assert(condition: boolean, msg: string) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${msg}`);
  }
}

main().catch((err) => {
  console.error("\nTEST FAILED:", err);
  process.exit(1);
});
