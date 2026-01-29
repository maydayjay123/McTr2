// Quick wallet balance checker
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Connection, PublicKey } = require("@solana/web3.js");

const RPC_URL = process.env.SOLANA_RPC_URL;
const WALLETS_FILE = path.join(__dirname, "wallets.json");

async function main() {
  if (!RPC_URL) {
    console.error("Missing SOLANA_RPC_URL in .env");
    process.exit(1);
  }

  const connection = new Connection(RPC_URL, "confirmed");

  // Load wallets
  if (!fs.existsSync(WALLETS_FILE)) {
    console.error("wallets.json not found");
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf8"));
  const wallets = data.wallets || [];

  if (!wallets.length) {
    console.log("No wallets found");
    return;
  }

  const activeIndex = Number(process.env.WALLET_INDEX) || 0;
  const targetMint = process.env.TARGET_MINT || "(not set)";

  console.log("═══════════════════════════════════════════════════════════");
  console.log("                    WALLET BALANCES");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Active wallet: index ${activeIndex}`);
  console.log(`  Target token:  ${targetMint}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i];
    const pubkey = new PublicKey(wallet.publicKey);

    const isActive = i === activeIndex;
    const marker = isActive ? "→" : " ";
    console.log(`${marker}[${i}] ${wallet.name || "unnamed"}${isActive ? " (ACTIVE)" : ""}`);
    console.log(`    ${wallet.publicKey}`);

    try {
      // Get SOL balance
      const solBalance = await connection.getBalance(pubkey, "confirmed");
      const sol = (solBalance / 1e9).toFixed(4);
      console.log(`    SOL: ${sol}`);

      // Get all token accounts
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
        pubkey,
        { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") },
        "confirmed"
      );

      if (tokenAccounts.value.length > 0) {
        console.log("    Tokens:");
        for (const account of tokenAccounts.value) {
          const info = account.account.data.parsed.info;
          const mint = info.mint;
          const amount = info.tokenAmount.uiAmount;
          const decimals = info.tokenAmount.decimals;

          // Skip zero balances
          if (amount === 0) continue;

          // Shorten mint for display
          const shortMint = mint.slice(0, 8) + "..." + mint.slice(-4);
          console.log(`      ${shortMint}: ${amount.toLocaleString()}`);
        }
      } else {
        console.log("    Tokens: none");
      }
    } catch (err) {
      console.log(`    Error: ${err.message}`);
    }

    console.log("");
  }

  console.log("═══════════════════════════════════════════════════════════");
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});