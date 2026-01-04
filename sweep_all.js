require("dotenv").config();
const fs = require("fs");
const path = require("path");
const fetch = global.fetch || require("node-fetch");
const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} = require("@solana/web3.js");

const TARGET_ADDRESS =
  process.env.SWEEP_TARGET ||
  "FnnYe1tkQdWJANw6mRJSF2YbdD5YbPHQ7gTYDt86RNTJ";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUP_BASE_URL = process.env.JUPITER_API_BASE || "https://lite-api.jup.ag";
const RPC_URLS = (process.env.SOLANA_RPC_URLS || process.env.RPC_URLS || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const RPC_URL = process.env.SOLANA_RPC_URL;
const SWEEP_KEEP_LAMPORTS = 5000n;
const MAX_ROUNDS = 5;
const SELL_SLIPPAGE_BPS = Number(process.env.SWEEP_SELL_SLIPPAGE_BPS || 100);
const WALLET_FILES = [
  process.env.WALLETS_FILE || path.join(__dirname, "wallets.json"),
  process.env.VOL_WALLETS_FILE || path.join(__dirname, "vol_wallets.json"),
];

function logLine(message) {
  const stamp = new Date().toISOString().replace("T", " ").split(".")[0];
  console.log(`${stamp} | ${message}`);
}

function buildRpcUrls() {
  const list = [];
  if (RPC_URL) list.push(RPC_URL);
  for (const url of RPC_URLS) {
    if (url && !list.includes(url)) list.push(url);
  }
  if (!list.length) {
    throw new Error("Missing SOLANA_RPC_URL or SOLANA_RPC_URLS");
  }
  return list;
}

function loadWalletEntries() {
  const entries = [];
  for (const file of WALLET_FILES) {
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, "utf8");
    if (!raw.trim()) continue;
    const data = JSON.parse(raw);
    if (Array.isArray(data.wallets)) {
      entries.push(...data.wallets);
    }
    if (data.parent) entries.push(data.parent);
    if (Array.isArray(data.volWallets)) entries.push(...data.volWallets);
    if (Array.isArray(data.mmWallets)) entries.push(...data.mmWallets);
  }
  const seen = new Set();
  const deduped = [];
  for (const entry of entries) {
    if (!entry?.publicKey || !entry?.secretKey) continue;
    if (seen.has(entry.publicKey)) continue;
    seen.add(entry.publicKey);
    deduped.push(entry);
  }
  return deduped;
}

function buildUrls(pathSuffixes) {
  const base = JUP_BASE_URL.replace(/\/+$/, "");
  return pathSuffixes.map((suffix) => `${base}${suffix}`);
}

async function fetchWithFallback(urls, label, options) {
  for (const url of urls) {
    let response;
    try {
      response = await fetch(url, options);
    } catch (err) {
      throw new Error(`${label} fetch failed: ${err.message || err} (${url})`);
    }
    if (response.ok) return { response, url };
    if (response.status !== 404) {
      const body = await response.text();
      throw new Error(`${label} failed: ${response.status} ${body} (${url})`);
    }
  }
  throw new Error(`${label} failed: endpoint not found (404)`);
}

async function fetchQuote(inputMint, outputMint, amount, slippageBps) {
  const liteFallbacks = buildUrls(["/swap/v1/quote", "/quote", "/v1/quote"]);
  const defaultUrls = buildUrls(["/v6/quote"]);
  const urls = JUP_BASE_URL.includes("lite-api.jup.ag")
    ? liteFallbacks.concat(defaultUrls)
    : defaultUrls;
  const urlsWithParams = urls.map((rawUrl) => {
    const url = new URL(rawUrl);
    url.searchParams.set("inputMint", inputMint);
    url.searchParams.set("outputMint", outputMint);
    url.searchParams.set("amount", amount.toString());
    url.searchParams.set("slippageBps", String(slippageBps));
    return url.toString();
  });
  const { response } = await fetchWithFallback(urlsWithParams, "Quote");
  const data = await response.json();
  if (!data || !data.outAmount) {
    throw new Error("Quote returned no outAmount");
  }
  return data;
}

async function fetchSwapTransaction(quote, userPublicKey) {
  const liteFallbacks = buildUrls(["/swap/v1/swap", "/swap", "/v1/swap"]);
  const defaultUrls = buildUrls(["/v6/swap"]);
  const urls = JUP_BASE_URL.includes("lite-api.jup.ag")
    ? liteFallbacks.concat(defaultUrls)
    : defaultUrls;
  const { response } = await fetchWithFallback(urls, "Swap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
    }),
  });
  const data = await response.json();
  if (!data?.swapTransaction) {
    throw new Error("Swap response missing transaction");
  }
  return data.swapTransaction;
}

async function executeSwap(connection, keypair, quote) {
  const swapTxB64 = await fetchSwapTransaction(
    quote,
    keypair.publicKey.toBase58()
  );
  const txBuffer = Buffer.from(swapTxB64, "base64");
  const tx = VersionedTransaction.deserialize(txBuffer);
  tx.sign([keypair]);
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  return signature;
}

async function getTokenAccounts(connection, owner) {
  const accounts = await connection.getParsedTokenAccountsByOwner(
    owner,
    { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") },
    "confirmed"
  );
  return accounts.value.map((acc) => acc.account.data.parsed.info);
}

async function sellToken(connection, keypair, mint, amount) {
  const quote = await fetchQuote(mint, SOL_MINT, amount, SELL_SLIPPAGE_BPS);
  const sig = await executeSwap(connection, keypair, quote);
  return sig;
}

async function transferSol(connection, keypair, target, lamports) {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey: target,
      lamports: Number(lamports),
    })
  );
  const sig = await connection.sendTransaction(tx, [keypair], {
    skipPreflight: false,
    maxRetries: 3,
  });
  return sig;
}

async function sweepWallet(connection, entry, targetPubkey) {
  const keypair = Keypair.fromSecretKey(Uint8Array.from(entry.secretKey));
  const owner = keypair.publicKey;
  let anyAction = false;
  const tokenAccounts = await getTokenAccounts(connection, owner);
  for (const info of tokenAccounts) {
    const mint = info.mint;
    const amount = BigInt(info.tokenAmount.amount);
    if (amount <= 0n) continue;
    logLine(`SELL start | wallet=${owner.toBase58()} mint=${mint} amount=${amount}`);
    try {
      const sig = await sellToken(connection, keypair, mint, amount);
      logLine(`SELL ok | wallet=${owner.toBase58()} mint=${mint} sig=${sig}`);
      anyAction = true;
    } catch (err) {
      logLine(
        `SELL failed | wallet=${owner.toBase58()} mint=${mint} error=${err.message || err}`
      );
    }
  }

  const solBal = BigInt(await connection.getBalance(owner, "confirmed"));
  if (solBal > SWEEP_KEEP_LAMPORTS) {
    const sendLamports = solBal - SWEEP_KEEP_LAMPORTS;
    try {
      const sig = await transferSol(connection, keypair, targetPubkey, sendLamports);
      logLine(
        `SEND ok | wallet=${owner.toBase58()} sol=${Number(sendLamports) / 1e9} sig=${sig}`
      );
      anyAction = true;
      return { sentLamports: sendLamports, anyAction };
    } catch (err) {
      logLine(
        `SEND failed | wallet=${owner.toBase58()} error=${err.message || err}`
      );
    }
  }
  return { sentLamports: 0n, anyAction };
}

async function main() {
  const rpcUrls = buildRpcUrls();
  const connection = new Connection(rpcUrls[0], "confirmed");
  const targetPubkey = new PublicKey(TARGET_ADDRESS);
  const wallets = loadWalletEntries();
  if (!wallets.length) {
    throw new Error("No wallets found.");
  }
  logLine(`Target address: ${TARGET_ADDRESS}`);
  logLine(`Wallets loaded: ${wallets.length}`);

  let totalRecovered = 0n;
  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    logLine(`ROUND ${round}/${MAX_ROUNDS} start`);
    let roundAction = false;
    for (const entry of wallets) {
      const result = await sweepWallet(connection, entry, targetPubkey);
      totalRecovered += result.sentLamports;
      roundAction = roundAction || result.anyAction;
    }
    logLine(`ROUND ${round} complete`);
    if (!roundAction) break;
  }

  logLine(`TOTAL recovered SOL: ${Number(totalRecovered) / 1e9}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
