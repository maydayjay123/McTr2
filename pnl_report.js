require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Connection, PublicKey } = require("@solana/web3.js");

const RPC_URL = process.env.SOLANA_RPC_URL;
const DEFAULT_MINT = process.env.TARGET_MINT;
const DEFAULT_WALLETS_PATH = path.join(__dirname, "wallets.json");

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (!key.startsWith("--")) continue;
    const name = key.slice(2);
    const value = args[i + 1];
    out[name] = value;
    i += 1;
  }
  return out;
}

function readDefaultWallet() {
  try {
    if (!fs.existsSync(DEFAULT_WALLETS_PATH)) return null;
    const raw = fs.readFileSync(DEFAULT_WALLETS_PATH, "utf8");
    if (!raw.trim()) return null;
    const data = JSON.parse(raw);
    const main = data.wallets && data.wallets[0];
    return main?.publicKey || null;
  } catch {
    return null;
  }
}

function getAccountKeys(tx) {
  const msg = tx.transaction.message;
  const toStringKey = (key) => {
    if (!key) return null;
    if (typeof key === "string") return key;
    if (typeof key.toBase58 === "function") return key.toBase58();
    return null;
  };

  if (Array.isArray(msg.accountKeys)) {
    return msg.accountKeys.map(toStringKey).filter(Boolean);
  }
  if (msg.getAccountKeys) {
    try {
      const keys = msg.getAccountKeys({
        accountKeysFromLookups: tx.meta?.loadedAddresses,
      });
      if (Array.isArray(keys)) {
        return keys.map(toStringKey).filter(Boolean);
      }
      if (Array.isArray(keys.accountKeys)) {
        return keys.accountKeys.map(toStringKey).filter(Boolean);
      }
      if (Array.isArray(keys.staticAccountKeys)) {
        const combined = [
          ...keys.staticAccountKeys,
          ...(keys.accountKeysFromLookups?.writable || []),
          ...(keys.accountKeysFromLookups?.readonly || []),
        ];
        return combined.map(toStringKey).filter(Boolean);
      }
    } catch {
      // fall through
    }
  }
  if (msg.staticAccountKeys) {
    const loaded = tx.meta?.loadedAddresses;
    const writable = loaded?.writable || [];
    const readonly = loaded?.readonly || [];
    const combined = [...msg.staticAccountKeys, ...writable, ...readonly];
    return combined.map(toStringKey).filter(Boolean);
  }
  return [];
}

function sumTokenDelta(meta, owner, mint) {
  const pre = meta.preTokenBalances || [];
  const post = meta.postTokenBalances || [];
  const preMap = new Map();
  const postMap = new Map();
  let decimals = null;

  for (const entry of pre) {
    if (entry.owner !== owner || entry.mint !== mint) continue;
    preMap.set(entry.accountIndex, entry.uiTokenAmount.amount);
    decimals = entry.uiTokenAmount.decimals;
  }

  for (const entry of post) {
    if (entry.owner !== owner || entry.mint !== mint) continue;
    postMap.set(entry.accountIndex, entry.uiTokenAmount.amount);
    decimals = entry.uiTokenAmount.decimals;
  }

  const allIndexes = new Set([...preMap.keys(), ...postMap.keys()]);
  let delta = 0n;
  for (const idx of allIndexes) {
    const preAmt = BigInt(preMap.get(idx) || "0");
    const postAmt = BigInt(postMap.get(idx) || "0");
    delta += postAmt - preAmt;
  }

  return { delta, decimals };
}

function formatDecimal(raw, decimals) {
  if (decimals === null || decimals === undefined) return "--";
  const base = 10 ** decimals;
  return (Number(raw) / base).toFixed(8);
}

function lamportsToSol(lamports) {
  return lamports / 1e9;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchCurrentBalances(connection, walletPub, mint) {
  const solLamports = await connection.getBalance(walletPub, "confirmed");
  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
    walletPub,
    { mint: new PublicKey(mint) },
    "confirmed",
  );
  let tokenTotal = 0;
  let decimals = null;
  for (const entry of tokenAccounts.value) {
    const amount = entry.account.data.parsed.info.tokenAmount;
    tokenTotal += Number(amount.uiAmount || 0);
    decimals = amount.decimals;
  }
  return {
    sol: lamportsToSol(solLamports),
    token: tokenTotal,
    decimals,
  };
}

async function getTransactionWithRetry(connection, signature, max = 5) {
  let delay = 500;
  for (let attempt = 1; attempt <= max; attempt += 1) {
    try {
      return await connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
    } catch (err) {
      const msg = err?.message || String(err);
      if (msg.includes("429")) {
        await sleep(delay);
        delay *= 2;
        continue;
      }
      throw err;
    }
  }
  throw new Error(`RPC 429 after ${max} retries for ${signature}`);
}

async function main() {
  const args = parseArgs();
  const mint = args.mint || DEFAULT_MINT;
  const wallet = args.wallet || readDefaultWallet();
  const limit = Number(args.limit || 200);
  const pages = Number(args.pages || 5);
  const delayMs = Number(args.delay || process.env.PNL_RPC_DELAY_MS || 250);
  const sigAddress = args["sig-address"] || args.sigAddress;
  const csvPath = args.csv || "pnl_report.csv";
  const markPrice = Number(args["mark-price"] || args.markPrice || 0);

  if (!RPC_URL) {
    console.error("Missing SOLANA_RPC_URL in .env");
    process.exit(1);
  }
  if (!mint) {
    console.error("Missing --mint or TARGET_MINT in .env");
    process.exit(1);
  }
  if (!wallet) {
    console.error("Missing --wallet or wallets.json");
    process.exit(1);
  }

  const connection = new Connection(RPC_URL, "confirmed");
  const walletPub = new PublicKey(wallet);
  const sigPub = sigAddress ? new PublicKey(sigAddress) : walletPub;

  let before = undefined;
  const signatures = [];

  for (let page = 0; page < pages; page += 1) {
    const batch = await connection.getSignaturesForAddress(sigPub, {
      limit,
      before,
    });
    if (!batch.length) break;
    signatures.push(...batch);
    before = batch[batch.length - 1].signature;
  }

  const rows = [];
  let inventory = 0;
  let costBasisSol = 0;
  let totalPnl = 0;
  let decimals = null;

  for (const sig of signatures) {
    const tx = await getTransactionWithRetry(connection, sig.signature);
    if (!tx || !tx.meta) continue;

    const { delta: tokenDelta, decimals: tokenDecimals } = sumTokenDelta(
      tx.meta,
      wallet,
      mint,
    );
    if (tokenDecimals !== null) decimals = tokenDecimals;

    const keys = getAccountKeys(tx);
    const walletIndex = keys.indexOf(wallet);
    if (walletIndex < 0) continue;

    const solDeltaLamports =
      tx.meta.postBalances[walletIndex] - tx.meta.preBalances[walletIndex];

    if (tokenDelta === 0n && solDeltaLamports === 0) continue;

    const tokenDeltaNum = Number(tokenDelta);
    const tokenDeltaSol =
      decimals !== null ? tokenDeltaNum / 10 ** decimals : 0;
    const solDelta = lamportsToSol(solDeltaLamports);

    let side = "other";
    if (tokenDelta > 0n && solDelta < 0) side = "buy";
    if (tokenDelta < 0n && solDelta > 0) side = "sell";

    let pnl = 0;

    if (side === "buy") {
      const solSpent = Math.abs(solDelta);
      costBasisSol += solSpent;
      inventory += Math.abs(tokenDeltaSol);
    } else if (side === "sell") {
      const solReceived = solDelta;
      const avgCost = inventory > 0 ? costBasisSol / inventory : 0;
      const tokensSold = Math.abs(tokenDeltaSol);
      const costOut = avgCost * tokensSold;
      pnl = solReceived - costOut;
      totalPnl += pnl;
      inventory -= tokensSold;
      costBasisSol = Math.max(costBasisSol - costOut, 0);
      if (inventory <= 0) {
        inventory = 0;
        costBasisSol = 0;
      }
    }

    rows.push({
      time: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : "--",
      signature: sig.signature,
      side,
      tokenDelta: tokenDeltaSol,
      solDelta,
      priceSol:
        tokenDeltaSol !== 0 ? Math.abs(solDelta) / Math.abs(tokenDeltaSol) : 0,
      inventory,
      avgCost: inventory > 0 ? costBasisSol / inventory : 0,
      pnl,
      totalPnl,
    });

    if (delayMs > 0) {
      await sleep(delayMs);
    }
  }

  console.log("Trades:");
  console.log(
    "time | side | token_delta | sol_delta | price_sol | inventory | avg_cost | pnl | total_pnl",
  );
  for (const row of rows.reverse()) {
    console.log(
      `${row.time} | ${row.side} | ${row.tokenDelta.toFixed(8)} | ${row.solDelta.toFixed(
        8,
      )} | ${row.priceSol.toFixed(8)} | ${row.inventory.toFixed(
        8,
      )} | ${row.avgCost.toFixed(8)} | ${row.pnl.toFixed(8)} | ${row.totalPnl.toFixed(8)}`,
    );
  }

  const csvHeader = [
    "time",
    "signature",
    "side",
    "token_delta",
    "sol_delta",
    "price_sol",
    "inventory",
    "avg_cost",
    "pnl",
    "total_pnl",
  ].join(",");
  const csvLines = rows
    .slice()
    .reverse()
    .map((row) =>
      [
        row.time,
        row.signature,
        row.side,
        row.tokenDelta.toFixed(8),
        row.solDelta.toFixed(8),
        row.priceSol.toFixed(8),
        row.inventory.toFixed(8),
        row.avgCost.toFixed(8),
        row.pnl.toFixed(8),
        row.totalPnl.toFixed(8),
      ].join(","),
    );
  const summaryLines = [
    "",
    "summary",
    `mint,${mint}`,
    `wallet,${wallet}`,
    `signature_address,${sigPub.toBase58()}`,
    `token_decimals,${decimals ?? ""}`,
    `inventory,${inventory.toFixed(8)}`,
    `cost_basis_sol,${costBasisSol.toFixed(8)}`,
    `total_pnl_sol,${totalPnl.toFixed(8)}`,
    `chain_sol,${chainBalances.sol.toFixed(8)}`,
    `chain_token,${chainBalances.token.toFixed(8)}`,
    `inventory_diff,${(chainBalances.token - inventory).toFixed(8)}`,
    `mark_price,${markPrice > 0 ? markPrice.toFixed(8) : ""}`,
  ];
  fs.writeFileSync(
    csvPath,
    `${csvHeader}\n${csvLines.join("\n")}\n${summaryLines.join("\n")}\n`,
    "utf8",
  );
  console.log(`\nCSV saved: ${csvPath}`);

  console.log("\nSummary:");
  console.log(`Wallet: ${wallet}`);
  console.log(`Mint: ${mint}`);
  console.log(`Token decimals: ${decimals ?? "--"}`);
  console.log(`Signature address: ${sigPub.toBase58()}`);
  console.log(`Inventory: ${inventory.toFixed(8)}`);
  console.log(`Cost basis SOL: ${costBasisSol.toFixed(8)}`);
  console.log(`Total PnL SOL: ${totalPnl.toFixed(8)}`);

  const chainBalances = await fetchCurrentBalances(connection, walletPub, mint);
  const inventoryDiff = chainBalances.token - inventory;
  console.log(`Chain SOL: ${chainBalances.sol.toFixed(8)}`);
  console.log(`Chain token: ${chainBalances.token.toFixed(8)}`);
  if (Math.abs(inventoryDiff) > 0.000001) {
    console.log(`Inventory diff (chain - calc): ${inventoryDiff.toFixed(8)}`);
  }

  if (markPrice > 0) {
    const markValue = chainBalances.token * markPrice;
    const unrealized = markValue - costBasisSol;
    const totalWithMark = totalPnl + unrealized;
    console.log(`Mark price: ${markPrice.toFixed(8)} SOL`);
    console.log(`Unrealized PnL: ${unrealized.toFixed(8)} SOL`);
    console.log(`Total PnL + unrealized: ${totalWithMark.toFixed(8)} SOL`);
  }
}

main().catch((err) => {
  console.error("Report failed:", err.message || err);
  process.exit(1);
});
