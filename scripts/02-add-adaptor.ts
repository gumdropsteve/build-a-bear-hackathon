/**
 * 02-add-adaptor.ts — Add Ranger's lending adaptor to our vault.
 *
 * This uses the EXISTING deployed Ranger lending adaptor, not our custom one.
 * The lending adaptor knows how to supply tokens to Save/Solend, Kamino, etc.
 *
 * Prerequisites:
 *   - Vault created (VAULT_ADDRESS in config)
 *   - Admin keypair funded
 *
 * Usage:
 *   ADMIN_FILE_PATH=~/.config/solana/admin.json \
 *   HELIUS_RPC_URL=https://... \
 *   npx ts-node scripts/02-add-adaptor.ts
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { VoltrClient } from "@voltr/vault-sdk";
import { VAULT_ADDRESS, LENDING_ADAPTOR_PROGRAM_ID } from "./config";
import { loadKeypair, sendTx, getRpcUrl } from "./helpers";

async function main() {
  const adminKp = loadKeypair(process.env.ADMIN_FILE_PATH!);
  const vault = new PublicKey(VAULT_ADDRESS);

  const connection = new Connection(getRpcUrl());
  const vc = new VoltrClient(connection);

  console.log("Vault:", vault.toBase58());
  console.log("Adding lending adaptor:", LENDING_ADAPTOR_PROGRAM_ID.toBase58());

  const addAdaptorIx = await vc.createAddAdaptorIx({
    vault,
    payer: adminKp.publicKey,
    admin: adminKp.publicKey,
    adaptorProgram: LENDING_ADAPTOR_PROGRAM_ID,
  });

  const sig = await sendTx(connection, [addAdaptorIx], [adminKp]);
  console.log("\nLending adaptor added!");
  console.log("Signature:", sig);
}

main().catch(console.error);
