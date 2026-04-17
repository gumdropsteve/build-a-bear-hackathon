/**
 * 04-deposit-strategy.ts — Deposit mUSDX from vault idle into the Save strategy.
 *
 * This moves mUSDX from the vault's idle pool into the Save lending reserve,
 * where it earns supply APY. The mUSDX also continues to appreciate via
 * Stable's post_yield calls (5% APR from RWA backing).
 *
 * Prerequisites:
 *   - Strategy initialized (03)
 *   - Vault has mUSDX in its idle pool (user deposited via deposit_vault)
 *   - SAVE_* constants filled in config.ts
 *
 * Usage:
 *   MANAGER_FILE_PATH=~/.config/solana/manager.json \
 *   HELIUS_RPC_URL=https://... \
 *   npx ts-node scripts/04-deposit-strategy.ts
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { BN } from "@coral-xyz/anchor";
import { SEEDS, VoltrClient } from "@voltr/vault-sdk";
import { LENDING_ADAPTOR_PROGRAM_ID } from "./config";
import {
  VAULT_ADDRESS,
  SAVE_PROGRAM_ID,
  SAVE_MUSDX_LENDING_MARKET,
  SAVE_MUSDX_COUNTERPARTY_TA,
  SAVE_MUSDX_RESERVE,
  SAVE_MUSDX_COLLATERAL_MINT,
  SAVE_MUSDX_PYTH_ORACLE,
  SAVE_MUSDX_SWITCHBOARD_ORACLE,
  MUSDX_MINT,
  assetTokenProgram,
} from "./config";
import { loadKeypair, getOrCreateAta, sendTx, getRpcUrl } from "./helpers";

async function main() {
  const managerKp = loadKeypair(process.env.MANAGER_FILE_PATH!);
  const vault = new PublicKey(VAULT_ADDRESS);
  const musdxMint = new PublicKey(MUSDX_MINT);
  const counterPartyTa = new PublicKey(SAVE_MUSDX_COUNTERPARTY_TA);
  const reserve = new PublicKey(SAVE_MUSDX_RESERVE);
  const collateralMint = new PublicKey(SAVE_MUSDX_COLLATERAL_MINT);
  const lendingMarket = new PublicKey(SAVE_MUSDX_LENDING_MARKET);

  const connection = new Connection(getRpcUrl());
  const vc = new VoltrClient(connection);

  const [strategy] = PublicKey.findProgramAddressSync(
    [SEEDS.STRATEGY, counterPartyTa.toBuffer()],
    LENDING_ADAPTOR_PROGRAM_ID,
  );

  const { vaultStrategyAuth } = vc.findVaultStrategyAddresses(vault, strategy);

  const [lendingMarketAuthority] = PublicKey.findProgramAddressSync(
    [new PublicKey(lendingMarket).toBytes()],
    SAVE_PROGRAM_ID,
  );

  const vaultCollateralAta = await getOrCreateAta(
    connection,
    managerKp,
    collateralMint,
    vaultStrategyAuth,
  );

  // Amount to deposit into the strategy (all idle mUSDX in the vault).
  // Adjust as needed. -1 = withdraw/deposit all.
  const depositAmount = new BN(1_000_000); // 1 mUSDX for testing

  const remainingAccounts = [
    { pubkey: counterPartyTa, isSigner: false, isWritable: true },
    { pubkey: SAVE_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: vaultCollateralAta, isSigner: false, isWritable: true },
    { pubkey: reserve, isSigner: false, isWritable: true },
    { pubkey: collateralMint, isSigner: false, isWritable: true },
    { pubkey: lendingMarket, isSigner: false, isWritable: true },
    {
      pubkey: lendingMarketAuthority,
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: new PublicKey(SAVE_MUSDX_PYTH_ORACLE),
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: new PublicKey(SAVE_MUSDX_SWITCHBOARD_ORACLE),
      isSigner: false,
      isWritable: false,
    },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  const depositIx = await vc.createDepositStrategyIx(
    {
      depositAmount,
      additionalArgs: Buffer.from([]),
    },
    {
      manager: managerKp.publicKey,
      vault,
      vaultAssetMint: musdxMint,
      strategy,
      assetTokenProgram: new PublicKey(assetTokenProgram),
      adaptorProgram: LENDING_ADAPTOR_PROGRAM_ID,
      remainingAccounts,
    },
  );

  const sig = await sendTx(connection, [depositIx], [managerKp]);
  console.log("Deposited to Save strategy!");
  console.log("Signature:", sig);
}

main().catch(console.error);
