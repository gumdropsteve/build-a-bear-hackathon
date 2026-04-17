/**
 * 01-init-vault.ts — Create a Ranger/Voltr vault for mUSDX.
 *
 * Prerequisites:
 *   - mUSDX program deployed and initialized (MUSDX_MINT must be set in config)
 *   - Admin and manager keypairs funded with SOL
 *   - RPC URL set via HELIUS_RPC_URL or SOLANA_RPC_URL env var
 *
 * Usage:
 *   ADMIN_FILE_PATH=~/.config/solana/admin.json \
 *   MANAGER_FILE_PATH=~/.config/solana/manager.json \
 *   HELIUS_RPC_URL=https://... \
 *   npx ts-node scripts/01-init-vault.ts
 */

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { VoltrClient } from "@voltr/vault-sdk";
import { vaultParams, MUSDX_MINT, assetTokenProgram } from "./config";
import { loadKeypair, sendTx, getRpcUrl } from "./helpers";

async function main() {
  const adminKp = loadKeypair(process.env.ADMIN_FILE_PATH!);
  const managerKp = loadKeypair(process.env.MANAGER_FILE_PATH!);
  const vaultKp = Keypair.generate();

  const connection = new Connection(getRpcUrl());
  const vc = new VoltrClient(connection);

  const musdxMint = new PublicKey(MUSDX_MINT);

  console.log("Admin:", adminKp.publicKey.toBase58());
  console.log("Manager:", managerKp.publicKey.toBase58());
  console.log("Vault (new):", vaultKp.publicKey.toBase58());
  console.log("Asset mint (mUSDX):", musdxMint.toBase58());

  // 1. Create the vault.
  const initVaultIx = await vc.createInitializeVaultIx(vaultParams, {
    vault: vaultKp.publicKey,
    vaultAssetMint: musdxMint,
    admin: adminKp.publicKey,
    manager: managerKp.publicKey,
    payer: adminKp.publicKey,
  });

  const sig = await sendTx(connection, [initVaultIx], [adminKp, vaultKp]);
  console.log("\nVault initialized!");
  console.log("Signature:", sig);
  console.log("\n>>> Update VAULT_ADDRESS in scripts/config.ts:");
  console.log(`export let VAULT_ADDRESS = "${vaultKp.publicKey.toBase58()}";`);

  // 2. Optionally set LP token metadata.
  // (Uncomment when we have a hosted JSON URI)
  // const metadataIx = await vc.createCreateLpMetadataIx(
  //   { name: lpTokenMetadata.name, symbol: lpTokenMetadata.symbol, uri: lpTokenMetadata.uri },
  //   { vault: vaultKp.publicKey, admin: adminKp.publicKey, payer: adminKp.publicKey }
  // );
  // await sendTx(connection, [metadataIx], [adminKp]);
  // console.log("LP metadata set.");
}

main().catch(console.error);
