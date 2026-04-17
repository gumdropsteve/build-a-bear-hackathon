/**
 * cooldown-and-wrap.ts
 *
 * 1. Cooldown 1 mUSDX (burns shares, locks 1 USDX in silo for 7 days)
 * 2. Wrap 6.9 USDX -> mUSDX
 *
 * Usage:
 *   npx ts-node scripts/cooldown-and-wrap.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
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
const COOLDOWN_ENTRY_SEED = Buffer.from("cooldown");

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

function loadKeypair(filePath: string): Keypair {
  const resolved = filePath.replace("~", os.homedir());
  const raw = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main() {
  const connection = new Connection(
    "https://api.mainnet-beta.solana.com",
    "confirmed"
  );

  const payer = loadKeypair("~/.config/solana/id.json");
  console.log("Payer:", payer.publicKey.toBase58());

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
    [COOLDOWN_ENTRY_SEED, payer.publicKey.toBuffer()],
    MUSDX_PROGRAM_ID
  );

  const payerUsdxAta = getAssociatedTokenAddressSync(
    USDX_MINT,
    payer.publicKey
  );
  const payerMusdxAta = getAssociatedTokenAddressSync(
    musdxMintPda,
    payer.publicKey
  );

  // ─── Step 1: Cooldown 1 mUSDX ───
  console.log("1. cooldown (burn 1 mUSDX, lock 1 USDX in silo for 7 days)...");
  {
    const data = Buffer.concat([
      ixDiscriminator("cooldown"),
      u64(1_000_000), // 1 mUSDX
    ]);
    const ix = new TransactionInstruction({
      programId: MUSDX_PROGRAM_ID,
      keys: [
        { pubkey: statePda, isSigner: false, isWritable: false },
        { pubkey: USDX_MINT, isSigner: false, isWritable: false },
        { pubkey: musdxMintPda, isSigner: false, isWritable: true },
        { pubkey: usdxVaultPda, isSigner: false, isWritable: true },
        { pubkey: cooldownSiloPda, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: payerMusdxAta, isSigner: false, isWritable: true },
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
      [payer]
    );
    console.log("  tx:", txSig);

    const mintInfo = await getMint(connection, musdxMintPda);
    console.log("  mUSDX supply:", mintInfo.supply.toString());

    const vaultBal = await getAccount(connection, usdxVaultPda);
    console.log("  vault USDX: ", vaultBal.amount.toString());

    const siloBal = await getAccount(connection, cooldownSiloPda);
    console.log("  silo USDX:  ", siloBal.amount.toString());
    console.log();
  }

  // ─── Step 2: Wrap 6.9 USDX ───
  console.log("2. wrap 6.9 USDX (6_900_000 base units)...");
  {
    const data = Buffer.concat([
      ixDiscriminator("wrap"),
      u64(6_900_000), // 6.9 USDX
    ]);
    const ix = new TransactionInstruction({
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
      data,
    });
    const txSig = await sendAndConfirmTransaction(
      connection,
      new Transaction().add(ix),
      [payer]
    );
    console.log("  tx:", txSig);

    const musdxBal = await getAccount(connection, payerMusdxAta);
    console.log(
      "  deployer mUSDX:",
      musdxBal.amount.toString(),
      `(${Number(musdxBal.amount) / 1e6} mUSDX)`
    );

    const vaultBal = await getAccount(connection, usdxVaultPda);
    console.log(
      "  vault USDX:    ",
      vaultBal.amount.toString(),
      `(${Number(vaultBal.amount) / 1e6} USDX)`
    );

    const usdxBal = await getAccount(connection, payerUsdxAta);
    console.log(
      "  deployer USDX: ",
      usdxBal.amount.toString(),
      `(${Number(usdxBal.amount) / 1e6} USDX remaining)`
    );
    console.log();
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error("\nFAILED:", err);
  process.exit(1);
});
