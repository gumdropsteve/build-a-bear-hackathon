/**
 * set-musdx-metadata.ts
 *
 * Calls the create_metadata instruction on the mUSDX program to set
 * Metaplex token metadata for the mUSDX mint.
 *
 * Usage:
 *   npx ts-node scripts/set-musdx-metadata.ts
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
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";

const MUSDX_PROGRAM_ID = new PublicKey(
  "5NTrBzBD92B8qRDquvxBihpcxQHmCNqu2WtmoT9RRFpK"
);
const METAPLEX_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

const STATE_SEED = Buffer.from("state");
const MUSDX_MINT_SEED = Buffer.from("musdx_mint");

function ixDiscriminator(name: string): Buffer {
  return createHash("sha256")
    .update(`global:${name}`)
    .digest()
    .slice(0, 8);
}

function borshString(s: string): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(s.length);
  return Buffer.concat([len, Buffer.from(s, "utf-8")]);
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
  console.log("Payer/Admin:", payer.publicKey.toBase58());

  const [statePda] = PublicKey.findProgramAddressSync(
    [STATE_SEED],
    MUSDX_PROGRAM_ID
  );
  const [musdxMintPda] = PublicKey.findProgramAddressSync(
    [MUSDX_MINT_SEED],
    MUSDX_PROGRAM_ID
  );

  // Derive the Metaplex metadata PDA for the mUSDX mint
  const [metadataPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      METAPLEX_PROGRAM_ID.toBuffer(),
      musdxMintPda.toBuffer(),
    ],
    METAPLEX_PROGRAM_ID
  );

  console.log("mUSDX mint:   ", musdxMintPda.toBase58());
  console.log("Metadata PDA: ", metadataPda.toBase58());

  const name = "Staked USDX";
  const symbol = "mUSDX";
  const uri =
    "https://gist.githubusercontent.com/gumdropsteve/d3ef3a9e8fa94a2bee277602d952f204/raw/musdx-metadata.json";

  console.log(`\nSetting metadata: name="${name}" symbol="${symbol}"`);
  console.log(`URI: ${uri}\n`);

  const data = Buffer.concat([
    ixDiscriminator("create_metadata"),
    borshString(name),
    borshString(symbol),
    borshString(uri),
  ]);

  const ix = new TransactionInstruction({
    programId: MUSDX_PROGRAM_ID,
    keys: [
      { pubkey: statePda, isSigner: false, isWritable: false },
      { pubkey: musdxMintPda, isSigner: false, isWritable: false },
      { pubkey: metadataPda, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: false }, // admin
      { pubkey: payer.publicKey, isSigner: true, isWritable: true }, // payer
      {
        pubkey: SystemProgram.programId,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: METAPLEX_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  const txSig = await sendAndConfirmTransaction(connection, tx, [payer]);
  console.log("tx:", txSig);
  console.log("\nMetadata set successfully!");
}

main().catch((err) => {
  console.error("\nFAILED:", err);
  process.exit(1);
});
