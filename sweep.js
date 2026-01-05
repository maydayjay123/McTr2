require("dotenv").config();
const fs = require("fs");
const path = require("path");
const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} = require("@solana/web3.js");

const RPC_URL = process.env.SOLANA_RPC_URL;
const DESTINATION_WALLET =
  process.env.DESTINATION_WALLET || "2qy9iXR9C2iLurk1kN5bHqhtw6JXWCGCe9uTijoDMz6h";
const WALLETS_FILE = path.join(__dirname, "wallets.json");

function loadWallets() {
  if (!fs.existsSync(WALLETS_FILE)) {
    return [];
  }

  const raw = fs.readFileSync(WALLETS_FILE, "utf8");
  if (!raw.trim()) {
    return [];
  }

  const data = JSON.parse(raw);
  return Array.isArray(data.wallets) ? data.wallets : [];
}

function saveWallets(wallets) {
  const payload = { wallets };
  fs.writeFileSync(WALLETS_FILE, JSON.stringify(payload, null, 2), "utf8");
}

function ensureInitialWallet() {
  const wallets = loadWallets();
  if (wallets.length > 0) {
    return wallets;
  }

  const keypair = Keypair.generate();
  const entry = {
    name: "main",
    publicKey: keypair.publicKey.toBase58(),
    secretKey: Array.from(keypair.secretKey),
  };

  saveWallets([entry]);
  console.log("Created main wallet:");
  console.log(`- publicKey: ${entry.publicKey}`);
  console.log("- secretKey (store securely):", entry.secretKey);
  return [entry];
}

function keypairFromEntry(entry) {
  const secretKey = Uint8Array.from(entry.secretKey);
  return Keypair.fromSecretKey(secretKey);
}

async function sweepWallet(connection, entry, destination) {
  const keypair = keypairFromEntry(entry);
  const balance = await connection.getBalance(keypair.publicKey, "confirmed");

  if (balance <= 0) {
    console.log(`${entry.name} (${entry.publicKey}): balance 0, skip`);
    return;
  }

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");

  const feeProbe = new Transaction({
    feePayer: keypair.publicKey,
    recentBlockhash: blockhash,
  }).add(
    SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey: destination,
      lamports: 1,
    })
  );

  const feeInfo = await connection.getFeeForMessage(
    feeProbe.compileMessage(),
    "confirmed"
  );

  const fee = feeInfo.value || 0;
  const lamportsToSend = balance - fee;

  if (lamportsToSend <= 0) {
    console.log(
      `${entry.name} (${entry.publicKey}): balance ${balance}, fee ${fee}, skip`
    );
    return;
  }

  const tx = new Transaction({
    feePayer: keypair.publicKey,
    recentBlockhash: blockhash,
  }).add(
    SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey: destination,
      lamports: lamportsToSend,
    })
  );

  const signature = await sendAndConfirmTransaction(connection, tx, [keypair], {
    commitment: "confirmed",
    maxRetries: 3,
  });

  console.log(
    `${entry.name} (${entry.publicKey}): sent ${lamportsToSend} lamports, sig ${signature}`
  );
}

async function main() {
  if (!RPC_URL) {
    console.error("Missing SOLANA_RPC_URL env var.");
    process.exit(1);
  }

  const destination = new PublicKey(DESTINATION_WALLET);
  const connection = new Connection(RPC_URL, "confirmed");

  const wallets = ensureInitialWallet();

  for (const entry of wallets) {
    await sweepWallet(connection, entry, destination);
  }
}

main().catch((err) => {
  console.error("Sweep failed:", err);
  process.exit(1);
});
