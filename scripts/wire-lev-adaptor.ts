/**
 * wire-lev-adaptor.ts
 *
 * 1. Add lev_musdx_adaptor to the Ranger vault
 * 2. Initialize the strategy (creates the config PDA via Voltr CPI)
 *
 * Usage:
 *   npx ts-node scripts/wire-lev-adaptor.ts
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
import { VoltrClient } from "@voltr/vault-sdk";
import * as fs from "fs";
import * as os from "os";

const LEV_ADAPTOR_PROGRAM_ID = new PublicKey(
  "3VLBqfCaTJf9SAb1vqfFQNyct7jna8eznSvuPwk82XRm"
);
const VAULT = new PublicKey("Cee4wn9QKZki7BX25mYBo5S2MBQ63MWakfwm7eyuKsSM");
const MUSDX_MINT = new PublicKey(
  "3RyhjAivYTA1VyXJUG1qXgCLHq4zBvbD9B6bcrcDnKB9"
);

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
  const vc = new VoltrClient(connection);

  console.log("Payer:", payer.publicKey.toBase58());
  console.log("Vault:", VAULT.toBase58());
  console.log("Adaptor:", LEV_ADAPTOR_PROGRAM_ID.toBase58());

  // 1. Add the lev adaptor to the vault
  console.log("\n1. Adding lev_musdx_adaptor to vault...");
  const addAdaptorIx = await vc.createAddAdaptorIx({
    vault: VAULT,
    payer: payer.publicKey,
    admin: payer.publicKey,
    adaptorProgram: LEV_ADAPTOR_PROGRAM_ID,
  });

  const addSig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(addAdaptorIx),
    [payer]
  );
  console.log("  tx:", addSig);

  // 2. Derive the strategy PDA (config PDA in our adaptor)
  const CONFIG_SEED = Buffer.from("strategy_config");
  const [strategyPda] = PublicKey.findProgramAddressSync(
    [CONFIG_SEED, VAULT.toBuffer()],
    LEV_ADAPTOR_PROGRAM_ID
  );
  console.log("  Strategy PDA:", strategyPda.toBase58());

  // 2b. Create config PDA via initialize_config FIRST
  console.log("\n2. Creating config PDA via initialize_config...");
  {
    const { createHash } = require("crypto");
    const disc = createHash("sha256")
      .update("global:initialize_config")
      .digest()
      .slice(0, 8);

    // InitializeConfigArgs: voltr_vault(32) + save_obligation(32) + target(2) + max(2) + slip(2) + cap(1)
    const fakeObligation = new PublicKey("11111111111111111111111111111111");
    const args = Buffer.concat([
      VAULT.toBuffer(),            // voltr_vault
      fakeObligation.toBuffer(),   // save_obligation (set later)
      Buffer.from([0x90, 0x01]),   // target_leverage_bps = 400 (4x)
      Buffer.from([0xF4, 0x01]),   // max_leverage_bps = 500 (5x)
      Buffer.from([0x64, 0x00]),   // max_slippage_bps = 100 (1%)
      Buffer.from([8]),            // loop_iteration_cap = 8
    ]);

    const data = Buffer.concat([disc, args]);
    const ix = new TransactionInstruction({
      programId: LEV_ADAPTOR_PROGRAM_ID,
      keys: [
        { pubkey: strategyPda, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });

    const configSig = await sendAndConfirmTransaction(
      connection,
      new Transaction().add(ix),
      [payer]
    );
    console.log("  tx:", configSig);
  }

  // 3. Initialize the strategy via Voltr (validates pre-existing config PDA)
  console.log("\n3. Registering strategy with Voltr...");
  const initStrategyIx = await vc.createInitializeStrategyIx(
    {
      instructionDiscriminator: null,
      additionalArgs: VAULT.toBuffer(), // voltr_vault arg
    },
    {
      payer: payer.publicKey,
      manager: payer.publicKey,
      vault: VAULT,
      strategy: strategyPda,
      adaptorProgram: LEV_ADAPTOR_PROGRAM_ID,
      remainingAccounts: [],
    }
  );

  const initSig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(initStrategyIx),
    [payer]
  );
  console.log("  tx:", initSig);

  // 4. Verify
  const { strategyInitReceipt } = vc.findVaultStrategyAddresses(
    VAULT,
    strategyPda
  );
  const receipt = await vc.fetchStrategyInitReceiptAccount(strategyInitReceipt);
  console.log("\n  Strategy receipt:");
  console.log("    vault:", receipt.vault.toBase58());
  console.log("    strategy:", receipt.strategy.toBase58());
  console.log("    positionValue:", receipt.positionValue.toString());

  console.log("\nDone! Adaptor wired into vault.");
}

main().catch((err) => {
  console.error("\nFAILED:", err);
  process.exit(1);
});
