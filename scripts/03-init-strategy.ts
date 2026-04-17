/**
 * 03-init-strategy.ts — Initialize a Save/Solend lending strategy for mUSDX.
 *
 * This creates a strategy that supplies mUSDX to a Save lending market. The
 * market must have an mUSDX reserve (created via Save's permissionless pool UI).
 *
 * Modeled directly from voltrxyz/lend-scripts/src/scripts/manager-init-strategies.ts
 *
 * Prerequisites:
 *   - Vault created (01)
 *   - Lending adaptor added (02)
 *   - Save permissionless pool with mUSDX reserve created
 *   - SAVE_* constants filled in config.ts
 *
 * Usage:
 *   MANAGER_FILE_PATH=~/.config/solana/manager.json \
 *   HELIUS_RPC_URL=https://... \
 *   npx ts-node scripts/03-init-strategy.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { createWithSeedSync } from "@coral-xyz/anchor/dist/cjs/utils/pubkey";
import { SEEDS, VoltrClient } from "@voltr/vault-sdk";
import { LENDING_ADAPTOR_PROGRAM_ID } from "./config";
import {
  VAULT_ADDRESS,
  SAVE_PROGRAM_ID,
  SAVE_MUSDX_LENDING_MARKET,
  SAVE_MUSDX_COUNTERPARTY_TA,
  SAVE_MUSDX_COLLATERAL_MINT,
  MUSDX_MINT,
  assetTokenProgram,
} from "./config";
import { loadKeypair, sendTx, getOrCreateAta, getRpcUrl } from "./helpers";

async function main() {
  const managerKp = loadKeypair(process.env.MANAGER_FILE_PATH!);
  const vault = new PublicKey(VAULT_ADDRESS);
  const musdxMint = new PublicKey(MUSDX_MINT);
  const counterPartyTa = new PublicKey(SAVE_MUSDX_COUNTERPARTY_TA);
  const lendingMarket = new PublicKey(SAVE_MUSDX_LENDING_MARKET);
  const collateralMint = new PublicKey(SAVE_MUSDX_COLLATERAL_MINT);

  const connection = new Connection(getRpcUrl());
  const vc = new VoltrClient(connection);

  // Derive strategy PDA from the lending adaptor.
  const [strategy] = PublicKey.findProgramAddressSync(
    [SEEDS.STRATEGY, counterPartyTa.toBuffer()],
    LENDING_ADAPTOR_PROGRAM_ID,
  );

  const { vaultStrategyAuth } = vc.findVaultStrategyAddresses(vault, strategy);

  // Derive Save obligation (createWithSeed convention from Solend).
  const obligation = createWithSeedSync(
    vaultStrategyAuth,
    lendingMarket.toBase58().slice(0, 32),
    SAVE_PROGRAM_ID,
  );

  console.log("Vault:", vault.toBase58());
  console.log("Strategy:", strategy.toBase58());
  console.log("VaultStrategyAuth:", vaultStrategyAuth.toBase58());
  console.log("Obligation:", obligation.toBase58());

  // Ensure the vault's collateral + asset ATAs exist.
  const vaultCollateralAta = await getOrCreateAta(
    connection,
    managerKp,
    collateralMint,
    vaultStrategyAuth,
  );
  const vaultStrategyAssetAta = await getOrCreateAta(
    connection,
    managerKp,
    musdxMint,
    vaultStrategyAuth,
    new PublicKey(assetTokenProgram),
  );

  console.log("Vault collateral ATA:", vaultCollateralAta.toBase58());
  console.log("Vault strategy asset ATA:", vaultStrategyAssetAta.toBase58());

  // Build the initialize strategy ix.
  const initStrategyIx = await vc.createInitializeStrategyIx(
    {},
    {
      payer: managerKp.publicKey,
      vault,
      manager: managerKp.publicKey,
      strategy,
      adaptorProgram: LENDING_ADAPTOR_PROGRAM_ID,
      remainingAccounts: [
        { pubkey: SAVE_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: obligation, isSigner: false, isWritable: true },
        { pubkey: lendingMarket, isSigner: false, isWritable: true },
        { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        {
          pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,
          isSigner: false,
          isWritable: false,
        },
      ],
    },
  );

  const sig = await sendTx(connection, [initStrategyIx], [managerKp]);
  console.log("\nSave strategy initialized!");
  console.log("Signature:", sig);
}

main().catch(console.error);
