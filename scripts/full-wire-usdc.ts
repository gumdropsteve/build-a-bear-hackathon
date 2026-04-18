/**
 * full-wire-usdc.ts — Create a fresh Voltr vault with USDC as the native
 * asset, then wire the USDC-native lev_musdx adaptor to it end to end:
 *
 *   1. vc.createInitializeVaultIx                  (asset = USDC)
 *   2. add our adaptor to the new vault
 *   3. initialize_config  (creates the adaptor's config PDA for this vault)
 *   4. vc.createInitializeStrategyIx               (registers the strategy)
 *   5. create strategy ATAs (USDX, USDC, mUSDX, mUSDX-collateral)
 *   6. init_save_obligation
 *
 * Prints every new address so the keeper constants can be updated.
 *
 * Prereqs: wallet at `~/.config/solana/id.json` has enough SOL for vault
 * rent + ~5 tx fees (≤0.02 SOL in practice).
 */
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { BN } from "@coral-xyz/anchor";
import { VoltrClient, VaultConfig, VaultParams } from "@voltr/vault-sdk";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";

const ADAPTOR = new PublicKey("Bjepyh9UYAsJJkQ9meiVSXfgZXQFNZUn5ihqLysekpDr");
const SAVE_PROGRAM = new PublicKey("So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo");
const LENDING_MARKET = new PublicKey("7JoeENZjr1zGuocJ3d8eHxPzs6xSZKNwxQycHeRDiDCf");
const USDX_MINT = new PublicKey("9Gst2E7KovZ9jwecyGqnnhpG1mhHKdyLpJQnZonkCFhA");
const MUSDX_MINT = new PublicKey("3RyhjAivYTA1VyXJUG1qXgCLHq4zBvbD9B6bcrcDnKB9");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const MUSDX_COLLATERAL_MINT = new PublicKey("Guftqij3rRD9U2Q3LRwxzDYXzq6J4fy1bwY5fqvQzc4p");

const CONFIG_SEED = Buffer.from("strategy_config");

const vaultConfig: VaultConfig = {
  maxCap: new BN("18446744073709551615"),
  startAtTs: new BN(0),
  managerPerformanceFee: 0,
  adminPerformanceFee: 0,
  managerManagementFee: 0,
  adminManagementFee: 0,
  lockedProfitDegradationDuration: new BN(86400),
  redemptionFee: 0,
  issuanceFee: 0,
  withdrawalWaitingPeriod: new BN(0),
};

const vaultParams: VaultParams = {
  config: vaultConfig,
  name: "Leveraged mUSDX Vault (USDC)",
  description: "USDC deposits, leveraged mUSDX yield via Save + Jupiter",
};

function disc(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().slice(0, 8);
}

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(p.replace("~", os.homedir()), "utf-8")))
  );
}

async function main() {
  const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
  const payer = loadKeypair("~/.config/solana/id.json");
  const vc = new VoltrClient(connection);

  const vaultKp = Keypair.generate();
  const VAULT = vaultKp.publicKey;

  const [configPda] = PublicKey.findProgramAddressSync(
    [CONFIG_SEED, VAULT.toBuffer()], ADAPTOR
  );

  console.log("Payer:         ", payer.publicKey.toBase58());
  console.log("Adaptor:       ", ADAPTOR.toBase58());
  console.log("New Vault:     ", VAULT.toBase58());
  console.log("Config PDA:    ", configPda.toBase58());
  console.log("Asset (USDC):  ", USDC_MINT.toBase58());
  console.log();

  // 0. Create the Voltr vault with USDC as asset
  console.log("0. Creating Voltr vault with USDC asset...");
  const initVaultIx = await vc.createInitializeVaultIx(vaultParams, {
    vault: VAULT,
    vaultAssetMint: USDC_MINT,
    admin: payer.publicKey,
    manager: payer.publicKey,
    payer: payer.publicKey,
  });
  let sig = await sendAndConfirmTransaction(
    connection, new Transaction().add(initVaultIx), [payer, vaultKp]
  );
  console.log("  tx:", sig);

  // 1. Add adaptor to vault
  console.log("\n1. Adding adaptor to vault...");
  const addIx = await vc.createAddAdaptorIx({
    vault: VAULT, payer: payer.publicKey, admin: payer.publicKey,
    adaptorProgram: ADAPTOR,
  });
  sig = await sendAndConfirmTransaction(connection, new Transaction().add(addIx), [payer]);
  console.log("  tx:", sig);

  // 2. Create config PDA via initialize_config
  console.log("\n2. Creating config PDA...");
  {
    const fakeObligation = new PublicKey("11111111111111111111111111111111");
    const args = Buffer.concat([
      VAULT.toBuffer(),
      fakeObligation.toBuffer(),
      Buffer.from([0x90, 0x01]), // target leverage 400 (4x, bps×100)
      Buffer.from([0xF4, 0x01]), // max leverage   500 (5x)
      Buffer.from([0x64, 0x00]), // slippage       100 bps (1%)
      Buffer.from([8]),          // iter cap       8
    ]);
    const ix = new TransactionInstruction({
      programId: ADAPTOR,
      keys: [
        { pubkey: configPda, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([disc("initialize_config"), args]),
    });
    sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [payer]);
    console.log("  tx:", sig);
  }

  // 3. Register strategy with Voltr
  console.log("\n3. Registering with Voltr...");
  {
    const initStrategyIx = await vc.createInitializeStrategyIx(
      { instructionDiscriminator: null, additionalArgs: VAULT.toBuffer() },
      {
        payer: payer.publicKey, manager: payer.publicKey, vault: VAULT,
        strategy: configPda, adaptorProgram: ADAPTOR, remainingAccounts: [],
      }
    );
    sig = await sendAndConfirmTransaction(connection, new Transaction().add(initStrategyIx), [payer]);
    console.log("  tx:", sig);

    const { strategyInitReceipt } = vc.findVaultStrategyAddresses(VAULT, configPda);
    const receipt = await vc.fetchStrategyInitReceiptAccount(strategyInitReceipt);
    console.log("  strategy:", receipt.strategy.toBase58());
    console.log("  positionValue:", receipt.positionValue.toString());
  }

  // 4. Create strategy ATAs for config PDA
  console.log("\n4. Creating strategy ATAs...");
  {
    const atas = [
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey,
        getAssociatedTokenAddressSync(USDC_MINT, configPda, true), configPda, USDC_MINT),
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey,
        getAssociatedTokenAddressSync(USDX_MINT, configPda, true), configPda, USDX_MINT),
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey,
        getAssociatedTokenAddressSync(MUSDX_MINT, configPda, true), configPda, MUSDX_MINT),
    ];
    sig = await sendAndConfirmTransaction(connection, new Transaction().add(...atas), [payer]);
    console.log("  tx:", sig);

    sig = await sendAndConfirmTransaction(connection, new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey,
        getAssociatedTokenAddressSync(MUSDX_COLLATERAL_MINT, configPda, true),
        configPda, MUSDX_COLLATERAL_MINT),
    ), [payer]);
    console.log("  tx:", sig);
  }

  // 5. Create Save obligation for config PDA
  let obligationPubkey: PublicKey;
  console.log("\n5. Creating Save obligation...");
  {
    const marketStr = LENDING_MARKET.toBase58();
    const seed = marketStr.slice(0, 32);
    obligationPubkey = await PublicKey.createWithSeed(configPda, seed, SAVE_PROGRAM);
    console.log("  Obligation:", obligationPubkey.toBase58());

    const ix = new TransactionInstruction({
      programId: ADAPTOR,
      keys: [
        { pubkey: configPda, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SAVE_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: obligationPubkey, isSigner: false, isWritable: true },
        { pubkey: LENDING_MARKET, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: disc("init_save_obligation"),
    });
    sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [payer]);
    console.log("  tx:", sig);
  }

  console.log("\n========================================");
  console.log("  FULLY WIRED — USDC NATIVE");
  console.log("  Adaptor:        ", ADAPTOR.toBase58());
  console.log("  Vault:          ", VAULT.toBase58());
  console.log("  Config PDA:     ", configPda.toBase58());
  console.log("  Save Obligation:", obligationPubkey.toBase58());
  console.log();
  console.log("  === Update keeper/index.ts constants: ===");
  console.log(`  const VAULT = new PublicKey("${VAULT.toBase58()}");`);
  console.log(`  const CONFIG_PDA = new PublicKey("${configPda.toBase58()}");`);
  console.log(`  const SAVE_OBLIGATION = new PublicKey("${obligationPubkey.toBase58()}");`);
  console.log("========================================");
}

main().catch((err) => {
  console.error("\nFAILED:", err.message || err);
  console.error(err.transactionLogs || "");
  process.exit(1);
});
