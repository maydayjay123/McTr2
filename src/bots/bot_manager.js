const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
const fs = require("fs");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const WALLETS_FILE =
  process.env.WALLETS_FILE || path.join(ROOT, "wallets.json");
const TRADE_WALLET_COUNT = Number(
  process.env.TRADE_WALLET_COUNT || process.env.BOT_WALLET_COUNT || 0
);
const RESTART_DELAY_MS = Number(process.env.BOT_RESTART_DELAY_MS || 5000);

function readWallets() {
  if (!fs.existsSync(WALLETS_FILE)) return [];
  const raw = fs.readFileSync(WALLETS_FILE, "utf8");
  if (!raw.trim()) return [];
  try {
    const data = JSON.parse(raw);
    return Array.isArray(data.wallets) ? data.wallets : [];
  } catch (err) {
    console.error("Failed to parse wallets.json:", err.message || err);
    return [];
  }
}

function selectTradeWallets(wallets) {
  const tradeWallets = wallets.filter((w) => w.role === "trade");
  const fallback = wallets;
  const candidates = tradeWallets.length ? tradeWallets : fallback;
  const count =
    Number.isFinite(TRADE_WALLET_COUNT) && TRADE_WALLET_COUNT > 0
      ? Math.min(TRADE_WALLET_COUNT, candidates.length)
      : candidates.length;
  return candidates.slice(0, count);
}

function resolveWalletIndex(wallets, entry) {
  const index = wallets.indexOf(entry);
  if (index !== -1) return index;
  if (typeof entry?.publicKey === "string") {
    return wallets.findIndex((w) => w.publicKey === entry.publicKey);
  }
  return -1;
}

function spawnBot(wallets, entry) {
  const index = resolveWalletIndex(wallets, entry);
  if (index < 0) {
    console.error("Unable to resolve wallet index for entry:", entry?.name);
    return null;
  }

  const mint =
    entry.targetMint ||
    entry.mint ||
    entry.tokenMint ||
    process.env.TARGET_MINT ||
    "";

  if (!mint) {
    console.warn(
      `Wallet ${entry.name || index} has no target mint. Set wallet.targetMint or TARGET_MINT env.`
    );
  }

  const childEnv = {
    ...process.env,
    WALLET_INDEX: String(index),
    TARGET_MINT: mint,
    WALLET_NAME: entry.name || `wallet_${index + 1}`,
  };

  const child = spawn(process.execPath, [path.join(__dirname, "botv3.js")], {
    env: childEnv,
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    if (signal === "SIGTERM" || signal === "SIGINT") {
      return;
    }
    console.warn(
      `botv3 exited (wallet ${index}) code=${code} signal=${signal || "none"}`
    );
    setTimeout(() => {
      spawnBot(wallets, entry);
    }, RESTART_DELAY_MS);
  });

  return child;
}

function main() {
  const wallets = readWallets();
  if (!wallets.length) {
    console.error("No wallets found. Please create wallets.json first.");
    process.exit(1);
  }

  const tradeWallets = selectTradeWallets(wallets);
  if (!tradeWallets.length) {
    console.error("No trade wallets found in wallets.json.");
    process.exit(1);
  }

  console.log(
    `Starting ${tradeWallets.length} trade bot(s) from wallets.json...`
  );

  const children = tradeWallets
    .map((wallet) => spawnBot(wallets, wallet))
    .filter(Boolean);

  const shutdown = () => {
    for (const child of children) {
      if (!child || child.killed) continue;
      child.kill("SIGTERM");
    }
    setTimeout(() => process.exit(0), 1000);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
