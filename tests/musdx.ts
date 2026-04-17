// Integration tests for the musdx program.
//
// Runs against a local validator (started by `anchor test`). Uses raw
// `@solana/web3.js` + `@solana/spl-token` to build instructions, rather than
// depending on Anchor's IDL tooling (which has a platform-tools version
// mismatch we can't easily fix in the hackathon timeframe).

import { expect } from "chai";
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
  mintTo,
  getAccount,
  getMint,
} from "@solana/spl-token";
import { createHash } from "crypto";
import BN from "bn.js";

// ---------- Program config ----------

const MUSDX_PROGRAM_ID = new PublicKey(
  "LMo3w1NAqeTBPwPcbgt3W5aqbU22eiXYdeRXFXB2FpF",
);

const STATE_SEED = Buffer.from("state");
const USDX_VAULT_SEED = Buffer.from("usdx_vault");
const MUSDX_MINT_SEED = Buffer.from("musdx_mint");
const COOLDOWN_SILO_SEED = Buffer.from("usdx_cooldown_silo");
const COOLDOWN_ENTRY_SEED = Buffer.from("cooldown");

// ---------- Anchor helpers ----------

/** Compute the 8-byte Anchor instruction discriminator. */
function ixDiscriminator(name: string): Buffer {
  return createHash("sha256")
    .update(`global:${name}`)
    .digest()
    .slice(0, 8);
}

/** Encode a u64 in little-endian. */
function u64(n: BN | number): Buffer {
  const bn = BN.isBN(n) ? n : new BN(n);
  return bn.toArrayLike(Buffer, "le", 8);
}

/** Encode an i64 in little-endian. */
function i64(n: BN | number): Buffer {
  const bn = BN.isBN(n) ? n : new BN(n);
  return bn.toTwos(64).toArrayLike(Buffer, "le", 8);
}

// ---------- Tests ----------

describe("musdx", function () {
  // These tests wait for real-time cooldowns, so give them room.
  this.timeout(60_000);

  // Local validator started by `anchor test`.
  const connection = new Connection("http://127.0.0.1:8899", "confirmed");

  const payer = Keypair.generate();
  const admin = Keypair.generate();
  const alice = Keypair.generate();

  // Created in the init block.
  let usdxMint: PublicKey;
  let statePda: PublicKey;
  let musdxMintPda: PublicKey;
  let usdxVaultPda: PublicKey;
  let cooldownSiloPda: PublicKey;

  before(async () => {
    // Fund payer, admin, alice.
    for (const kp of [payer, admin, alice]) {
      const sig = await connection.requestAirdrop(
        kp.publicKey,
        5 * LAMPORTS_PER_SOL,
      );
      await connection.confirmTransaction(sig, "confirmed");
    }

    // Create a mock USDX mint (6 decimals, admin is mint authority).
    usdxMint = await createMint(
      connection,
      payer,
      admin.publicKey,
      null,
      6,
    );

    // Derive all program PDAs.
    [statePda] = PublicKey.findProgramAddressSync([STATE_SEED], MUSDX_PROGRAM_ID);
    [musdxMintPda] = PublicKey.findProgramAddressSync(
      [MUSDX_MINT_SEED],
      MUSDX_PROGRAM_ID,
    );
    [usdxVaultPda] = PublicKey.findProgramAddressSync(
      [USDX_VAULT_SEED],
      MUSDX_PROGRAM_ID,
    );
    [cooldownSiloPda] = PublicKey.findProgramAddressSync(
      [COOLDOWN_SILO_SEED],
      MUSDX_PROGRAM_ID,
    );
  });

  it("initializes the program with a 2-second cooldown", async () => {
    const data = Buffer.concat([
      ixDiscriminator("initialize"),
      // arg: cooldown_duration as i64 = 2 seconds (short for tests)
      i64(2),
    ]);

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
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction().add(ix);
    await sendAndConfirmTransaction(connection, tx, [payer, admin]);

    // Verify mint exists.
    const mintInfo = await getMint(connection, musdxMintPda);
    expect(mintInfo.decimals).to.equal(6);
    expect(mintInfo.supply.toString()).to.equal("0");

    // Verify vault is empty.
    const vaultInfo = await getAccount(connection, usdxVaultPda);
    expect(vaultInfo.amount.toString()).to.equal("0");

    // Verify silo is empty.
    const siloInfo = await getAccount(connection, cooldownSiloPda);
    expect(siloInfo.amount.toString()).to.equal("0");
  });

  it("wraps USDX into mUSDX at 1:1 for the first depositor", async () => {
    // Create alice's USDX ATA and mint her 100 USDX.
    const aliceUsdxAta = await createAssociatedTokenAccount(
      connection,
      payer,
      usdxMint,
      alice.publicKey,
    );
    await mintTo(
      connection,
      payer,
      usdxMint,
      aliceUsdxAta,
      admin,
      100_000_000, // 100 USDX
    );

    // Create alice's mUSDX ATA.
    const aliceMusdxAta = await createAssociatedTokenAccount(
      connection,
      payer,
      musdxMintPda,
      alice.publicKey,
    );

    const data = Buffer.concat([
      ixDiscriminator("wrap"),
      u64(40_000_000), // wrap 40 USDX
    ]);

    const ix = new TransactionInstruction({
      programId: MUSDX_PROGRAM_ID,
      keys: [
        { pubkey: statePda, isSigner: false, isWritable: true },
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

    await sendAndConfirmTransaction(connection, new Transaction().add(ix), [
      alice,
    ]);

    // Alice should have 40 mUSDX (1:1 for first depositor).
    const musdxBalance = await getAccount(connection, aliceMusdxAta);
    expect(musdxBalance.amount.toString()).to.equal("40000000");

    // Vault should have 40 USDX.
    const vaultBalance = await getAccount(connection, usdxVaultPda);
    expect(vaultBalance.amount.toString()).to.equal("40000000");
  });

  it("grows the mUSDX exchange rate when admin posts yield", async () => {
    // Admin needs a USDX ATA with a balance to post yield from.
    const adminUsdxAta = await createAssociatedTokenAccount(
      connection,
      payer,
      usdxMint,
      admin.publicKey,
    );
    await mintTo(
      connection,
      payer,
      usdxMint,
      adminUsdxAta,
      admin,
      10_000_000, // 10 USDX
    );

    const data = Buffer.concat([
      ixDiscriminator("post_yield"),
      u64(10_000_000), // post 10 USDX as yield (25% gain on current 40 USDX pot)
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

    await sendAndConfirmTransaction(connection, new Transaction().add(ix), [
      admin,
    ]);

    // Vault now has 50 USDX backing 40 mUSDX shares → exchange rate = 1.25.
    const vaultBalance = await getAccount(connection, usdxVaultPda);
    expect(vaultBalance.amount.toString()).to.equal("50000000");

    const mintInfo = await getMint(connection, musdxMintPda);
    expect(mintInfo.supply.toString()).to.equal("40000000"); // unchanged
  });

  it("starts a cooldown and claims the full amount after the delay", async () => {
    const aliceUsdxAta = await import("@solana/spl-token").then((m) =>
      m.getAssociatedTokenAddressSync(usdxMint, alice.publicKey),
    );
    const aliceMusdxAta = await import("@solana/spl-token").then((m) =>
      m.getAssociatedTokenAddressSync(musdxMintPda, alice.publicKey),
    );

    const [cooldownEntryPda] = PublicKey.findProgramAddressSync(
      [COOLDOWN_ENTRY_SEED, alice.publicKey.toBuffer()],
      MUSDX_PROGRAM_ID,
    );

    // Alice cools down 20 mUSDX → at 1.25 exchange rate, that's 25 USDX locked.
    const cooldownData = Buffer.concat([
      ixDiscriminator("cooldown"),
      u64(20_000_000),
    ]);
    const cooldownIx = new TransactionInstruction({
      programId: MUSDX_PROGRAM_ID,
      keys: [
        { pubkey: statePda, isSigner: false, isWritable: true },
        { pubkey: usdxMint, isSigner: false, isWritable: false },
        { pubkey: musdxMintPda, isSigner: false, isWritable: true },
        { pubkey: usdxVaultPda, isSigner: false, isWritable: true },
        { pubkey: cooldownSiloPda, isSigner: false, isWritable: true },
        { pubkey: alice.publicKey, isSigner: true, isWritable: true },
        { pubkey: aliceMusdxAta, isSigner: false, isWritable: true },
        { pubkey: cooldownEntryPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: cooldownData,
    });

    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(cooldownIx),
      [alice],
    );

    // Main vault: 50 - 25 = 25 USDX. Silo: 25 USDX. Shares: 40 - 20 = 20.
    const vaultBalance = await getAccount(connection, usdxVaultPda);
    expect(vaultBalance.amount.toString()).to.equal("25000000");
    const siloBalance = await getAccount(connection, cooldownSiloPda);
    expect(siloBalance.amount.toString()).to.equal("25000000");
    const mintInfo = await getMint(connection, musdxMintPda);
    expect(mintInfo.supply.toString()).to.equal("20000000");

    // Wait 3 seconds (cooldown is 2).
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Claim.
    const claimData = ixDiscriminator("claim");
    const claimIx = new TransactionInstruction({
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
      data: claimData,
    });

    await sendAndConfirmTransaction(connection, new Transaction().add(claimIx), [
      alice,
    ]);

    // Silo drained. Alice gets 25 USDX back.
    const siloAfter = await getAccount(connection, cooldownSiloPda);
    expect(siloAfter.amount.toString()).to.equal("0");

    const aliceUsdxAfter = await getAccount(connection, aliceUsdxAta);
    // She had 60 left (100 initial - 40 wrapped). Now +25 = 85 USDX.
    expect(aliceUsdxAfter.amount.toString()).to.equal("85000000");
  });
});
