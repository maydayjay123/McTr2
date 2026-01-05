require("dotenv").config();
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const fetch = global.fetch || require("node-fetch");
const {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} = require("@solana/web3.js");

const RPC_URL = process.env.SOLANA_RPC_URL;
const WALLETS_FILE = path.join(__dirname, "wallets.json");
const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUP_BASE_URL = process.env.JUPITER_API_BASE || "https://quote-api.jup.ag";

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

function createPrompt() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (question, defaultValue) =>
    new Promise((resolve) => {
      const suffix = defaultValue ? ` (${defaultValue})` : "";
      rl.question(`${question}${suffix}: `, (answer) => {
        const value = answer.trim();
        resolve(value || defaultValue || "");
      });
    });

  return { ask, close: () => rl.close() };
}

function toBaseUnits(amountStr, decimals) {
  const trimmed = amountStr.trim();
  if (!trimmed) {
    throw new Error("Amount is required");
  }

  const [whole, frac = ""] = trimmed.split(".");
  const safeWhole = whole === "" ? "0" : whole;
  const paddedFrac = (frac + "0".repeat(decimals)).slice(0, decimals);
  const base = BigInt(safeWhole) * 10n ** BigInt(decimals);
  const fracValue = paddedFrac ? BigInt(paddedFrac) : 0n;
  return base + fracValue;
}

function buildFallbackUrls(primaryUrl, fallbackPaths) {
  if (primaryUrl) {
    return [primaryUrl];
  }
  return fallbackPaths;
}

function buildUrls(pathSuffixes) {
  const base = JUP_BASE_URL.replace(/\/+$/, "");
  return pathSuffixes.map((suffix) => `${base}${suffix}`);
}

async function fetchWithFallback(urls, label) {
  let lastStatus = null;
  for (const url of urls) {
    let response;
    try {
      response = await fetch(url);
    } catch (err) {
      throw new Error(`${label} fetch failed: ${err.message || err} (${url})`);
    }

    if (response.ok) {
      return { response, url };
    }

    lastStatus = response.status;
    if (response.status !== 404) {
      throw new Error(`${label} failed: ${response.status} (${url})`);
    }
  }

  throw new Error(
    `${label} failed: endpoint not found (404). Tried: ${urls.join(", ")}`
  );
}

async function fetchTokenMap() {
  const liteFallbacks = buildUrls(["/tokens", "/v1/tokens"]);
  const defaultUrls = buildUrls(["/v6/tokens"]);
  const urls = buildFallbackUrls(
    process.env.JUPITER_TOKENS_URL,
    JUP_BASE_URL.includes("lite-api.jup.ag")
      ? defaultUrls.concat(liteFallbacks)
      : defaultUrls
  );

  let response;
  try {
    ({ response } = await fetchWithFallback(urls, "Token list"));
  } catch (err) {
    if (String(err.message || "").includes("endpoint not found")) {
      return null;
    }
    throw err;
  }

  const tokens = await response.json();
  const map = new Map();
  for (const token of tokens) {
    map.set(token.address, token);
  }
  return map;
}

async function fetchQuote(inputMint, outputMint, amount, slippageBps) {
  const liteFallbacks = buildUrls(["/swap/v1/quote", "/quote", "/v1/quote"]);
  const defaultUrls = buildUrls(["/v6/quote"]);
  const urls = buildFallbackUrls(
    process.env.JUPITER_QUOTE_URL,
    JUP_BASE_URL.includes("lite-api.jup.ag")
      ? liteFallbacks.concat(defaultUrls)
      : defaultUrls
  );

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
  const urls = buildFallbackUrls(
    process.env.JUPITER_SWAP_URL,
    JUP_BASE_URL.includes("lite-api.jup.ag")
      ? liteFallbacks.concat(defaultUrls)
      : defaultUrls
  );

  let response;
  let lastError = null;
  for (const url of urls) {
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey,
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
        }),
      });
    } catch (err) {
      lastError = new Error(`Swap fetch failed: ${err.message || err} (${url})`);
      break;
    }

    if (response.ok) {
      lastError = null;
      break;
    }

    if (response.status !== 404) {
      const body = await response.text();
      throw new Error(`Swap failed: ${response.status} ${body} (${url})`);
    }
  }

  if (lastError) {
    throw lastError;
  }
  if (!response || !response.ok) {
    throw new Error(
      `Swap failed: endpoint not found (404). Tried: ${urls.join(", ")}`
    );
  }

  const data = await response.json();
  if (!data || !data.swapTransaction) {
    throw new Error("Swap response missing transaction");
  }

  return data.swapTransaction;
}

async function main() {
  if (!RPC_URL) {
    console.error("Missing SOLANA_RPC_URL env var.");
    process.exit(1);
  }

  const wallets = ensureInitialWallet();
  const mainWallet = wallets[0];
  const keypair = keypairFromEntry(mainWallet);
  const connection = new Connection(RPC_URL, "confirmed");

  const prompt = createPrompt();
  try {
    const sideRaw = await prompt.ask("Side (buy/sell)", "buy");
    const side = sideRaw.toLowerCase();
    if (side !== "buy" && side !== "sell") {
      throw new Error("Side must be buy or sell");
    }

    const targetMint = await prompt.ask("Target token mint", "");
    if (!targetMint) {
      throw new Error("Target mint is required");
    }

    const amountInput = await prompt.ask(
      side === "buy" ? "Amount in SOL" : "Amount in target token",
      "0.01"
    );

    const slippageInput = await prompt.ask("Slippage bps", "50");
    const slippageBps = Number(slippageInput);
    const quoteOnlyRaw = await prompt.ask("Quote only? (y/n)", "n");
    const quoteOnly = quoteOnlyRaw.toLowerCase().startsWith("y");

    if (Number.isNaN(slippageBps) || slippageBps <= 0) {
      throw new Error("Invalid slippage bps");
    }

    const tokenMap = await fetchTokenMap();

    const inputMint = side === "buy" ? SOL_MINT : targetMint;
    const outputMint = side === "buy" ? targetMint : SOL_MINT;

    const inputDecimals =
      inputMint === SOL_MINT
        ? 9
        : tokenMap?.get(inputMint)?.decimals ||
          (await getMintDecimals(connection, inputMint));
    if (inputDecimals === undefined) {
      throw new Error(`Unknown decimals for mint ${inputMint}`);
    }

    const amountBaseUnits = toBaseUnits(amountInput, inputDecimals);

    if (side === "buy") {
      const solBalance = await connection.getBalance(keypair.publicKey, "confirmed");
      const bufferLamports = 5000n;
      const needed = amountBaseUnits + bufferLamports;
      if (BigInt(solBalance) < needed) {
        console.log(
          `Insufficient SOL. Balance: ${solBalance} lamports, needed: ${needed.toString()} (amount + fee buffer).`
        );
        console.log(`Fund this address and try again: ${keypair.publicKey.toBase58()}`);
        return;
      }
    } else {
      const tokenAccounts = await connection.getTokenAccountsByOwner(
        keypair.publicKey,
        { mint: new PublicKey(targetMint) },
        "confirmed"
      );

      if (!tokenAccounts.value.length) {
        console.log(
          `No token account found for ${targetMint}. Fund this address with the token and try again: ${keypair.publicKey.toBase58()}`
        );
        return;
      }

      const tokenBalance = await connection.getTokenAccountBalance(
        tokenAccounts.value[0].pubkey,
        "confirmed"
      );
      const tokenAmount = BigInt(tokenBalance.value.amount);
      if (tokenAmount < amountBaseUnits) {
        console.log(
          `Insufficient token balance. Balance: ${tokenBalance.value.amount}, needed: ${amountBaseUnits.toString()}`
        );
        return;
      }
    }

    console.log("Requesting quote...");
    const quote = await fetchQuote(
      inputMint,
      outputMint,
      amountBaseUnits,
      slippageBps
    );

    console.log(
      `Quote out amount (raw): ${quote.outAmount}, price impact: ${quote.priceImpactPct}`
    );

    if (quoteOnly) {
      console.log("Quote-only mode enabled. No transaction sent.");
      return;
    }

    console.log("Building swap transaction...");
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

    console.log(`Sent swap, signature: ${signature}`);

    await connection.confirmTransaction(signature, "confirmed");
    console.log("Swap confirmed.");
  } finally {
    prompt.close();
  }
}

main().catch((err) => {
  console.error("Swap failed:", err.message || err);
  console.error(
    "Tip: check SOLANA_RPC_URL, internet access, and that the wallet is funded."
  );
  process.exit(1);
});

async function getMintDecimals(connection, mintAddress) {
  const pubkey = new PublicKey(mintAddress);
  const info = await connection.getParsedAccountInfo(pubkey, "confirmed");
  const data = info.value?.data;
  if (!data || data.program !== "spl-token") {
    throw new Error(`Unable to read mint data for ${mintAddress}`);
  }
  const decimals = data.parsed?.info?.decimals;
  if (decimals === undefined) {
    throw new Error(`Mint decimals not found for ${mintAddress}`);
  }
  return decimals;
}
