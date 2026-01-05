require("dotenv").config();
const fs = require("fs");
const path = require("path");
const fetch = global.fetch || require("node-fetch");
const {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} = require("@solana/web3.js");

const RPC_URL = process.env.SOLANA_RPC_URL;
const JUP_BASE_URL = (process.env.JUPITER_API_BASE || "https://quote-api.jup.ag").replace(
  /\/+$/,
  ""
);
const WALLETS_FILE =
  process.env.WALLETS_FILE || path.join(__dirname, "wallets.json");
const STATE_FILE =
  process.env.GRID_STATE_PATH || path.join(__dirname, "grid_state.json");

const SOL_MINT = "So11111111111111111111111111111111111111112";

const DEFAULT_GRID_STEP_PCT = 1.5;
const DEFAULT_GRID_MIN_STEP_PCT = 1;
const DEFAULT_GRID_MAX_STEP_PCT = 5;
const DEFAULT_GRID_VOL_WINDOW_SEC = 60;
const DEFAULT_GRID_VOL_MULT = 2;
const DEFAULT_GRID_MAX_UNITS = 10;
const DEFAULT_GRID_ALLOC_PCT = 90;
const DEFAULT_GRID_GAP_REANCHOR_PCT = 20;
const DEFAULT_GRID_SKIP_MULT = 0.5;
const DEFAULT_GRID_POLL_MS = 5000;
const DEFAULT_PRICE_SAMPLE_SOL = 0.01;
const DEFAULT_BUY_SLIPPAGE_BPS = 100;
const DEFAULT_SELL_SLIPPAGE_BPS = 100;
const DEFAULT_BUY_PRIORITY_FEE_LAMPORTS = 0;
const DEFAULT_SELL_PRIORITY_FEE_LAMPORTS = 0;
const DEFAULT_RESERVE_SOL = 0.005;
const DEFAULT_GRID_SEED_UNITS = -1;
const DEFAULT_SIM_START_SOL = 0.2;
const DEFAULT_FEE_LAMPORTS = 0;
const DEFAULT_MIN_PROFIT_PCT = 0.25;
let RATE_LIMIT_BACKOFF_MS = 5000;
let RATE_LIMIT_MAX_RETRIES = 3;
let MIN_QUOTE_INTERVAL_MS = 5000;
let lastQuoteAtMs = 0;
const LOG_FILE =
  process.env.BOT_GRID_LOG_PATH || path.join(__dirname, "bot_grid.log");
const LOG_TO_CONSOLE = process.env.LOG_TO_CONSOLE !== "false";

function ts() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const originalConsoleLog = console.log.bind(console);
const originalConsoleError = console.error.bind(console);

function isPlainObject(value) {
  if (Object.prototype.toString.call(value) !== "[object Object]") {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function safeStringify(value) {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Error) {
    return value.stack || value.message || String(value);
  }
  if (typeof value === "object" && value !== null) {
    if (isPlainObject(value)) {
      return formatKeyValue(value);
    }
    try {
      return JSON.stringify(value);
    } catch (err) {
      return String(value);
    }
  }
  return String(value);
}

function formatKeyValue(obj) {
  return Object.entries(obj)
    .map(([key, val]) => `${key}=${safeStringify(val)}`)
    .join(" ");
}

function formatLogArgs(args) {
  return args.map((item) => safeStringify(item)).join(" ");
}

function writeLogLine(line, isError) {
  const output = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(line)
    ? line
    : `${ts()} | ${line}`;
  if (LOG_TO_CONSOLE) {
    if (isError) {
      originalConsoleError(output);
    } else {
      originalConsoleLog(output);
    }
  }
  try {
    fs.appendFileSync(LOG_FILE, `${output}\n`, "utf8");
  } catch (err) {
    if (LOG_TO_CONSOLE) {
      originalConsoleError(
        `${ts()} | LOG write failed: ${err.message || err}`
      );
    }
  }
}

function logEvent(level, message, fields) {
  const extra = fields && Object.keys(fields).length
    ? ` | ${formatKeyValue(fields)}`
    : "";
  writeLogLine(`${level} | ${message}${extra}`, level === "ERROR");
}

function logInfo(message, fields) {
  logEvent("INFO", message, fields);
}

function logWarn(message, fields) {
  logEvent("WARN", message, fields);
}

function logError(message, fields) {
  logEvent("ERROR", message, fields);
}

console.log = (...args) => {
  writeLogLine(formatLogArgs(args), false);
};
console.error = (...args) => {
  writeLogLine(`ERROR | ${formatLogArgs(args)}`, true);
};

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
  fs.writeFileSync(
    WALLETS_FILE,
    JSON.stringify({ wallets }, null, 2),
    "utf8"
  );
}

function ensureInitialWallet() {
  const wallets = loadWallets();
  if (wallets.length > 0) {
    return wallets;
  }
  const kp = Keypair.generate();
  const entry = {
    name: "grid",
    publicKey: kp.publicKey.toBase58(),
    secretKey: Array.from(kp.secretKey),
  };
  saveWallets([entry]);
  console.log("Created grid wallet:");
  console.log(`- publicKey: ${entry.publicKey}`);
  console.log(`- secretKey (store securely): ${JSON.stringify(entry.secretKey)}`);
  return [entry];
}

function keypairFromEntry(entry) {
  return Keypair.fromSecretKey(Uint8Array.from(entry.secretKey));
}

function readState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatTokenAmount(raw, decimals, maxDecimals = 6) {
  if (decimals === null || decimals === undefined) {
    return raw.toString();
  }
  const sign = raw < 0n ? "-" : "";
  const value = raw < 0n ? -raw : raw;
  const factor = 10n ** BigInt(decimals);
  const whole = value / factor;
  const frac = value % factor;
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, maxDecimals);
  return `${sign}${whole.toString()}.${fracStr}`;
}

function formatSol(lamports, decimals = 6) {
  const sign = lamports < 0n ? "-" : "";
  const value = lamports < 0n ? -lamports : lamports;
  const whole = value / 1_000_000_000n;
  const frac = value % 1_000_000_000n;
  const fracStr = frac.toString().padStart(9, "0").slice(0, decimals);
  return `${sign}${whole.toString()}.${fracStr}`;
}

function percentFromLamports(pnlLamports, baseLamports) {
  if (baseLamports <= 0n) return "--";
  const pct = (Number(pnlLamports) / Number(baseLamports)) * 100;
  if (!Number.isFinite(pct)) return "--";
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

function rebuildLotsFromAggregate(state) {
  const simTokensRaw = BigInt(state.simTokenAmountRaw || "0");
  const simCostLamports = BigInt(state.simCostLamports || "0");
  if (simTokensRaw <= 0n || simCostLamports <= 0n) {
    state.simLots = [];
    return false;
  }
  state.simLotSeq += 1;
  state.simLots = [
    {
      id: state.simLotSeq,
      tokensRaw: simTokensRaw.toString(),
      costLamports: simCostLamports.toString(),
    },
  ];
  return true;
}

function buildUrls(pathSuffixes) {
  return pathSuffixes.map((suffix) => `${JUP_BASE_URL}${suffix}`);
}

async function fetchWithFallback(urls, label) {
  let lastStatus = null;
  for (const url of urls) {
    let response;
    for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt += 1) {
      try {
        response = await fetch(url);
      } catch (err) {
        throw new Error(`${label} fetch failed: ${err.message || err} (${url})`);
      }
      if (response.ok) {
        return { response, url };
      }
      if (response.status === 429 && attempt < RATE_LIMIT_MAX_RETRIES) {
        const waitMs = RATE_LIMIT_BACKOFF_MS * (attempt + 1);
        logWarn(`${label} rate limited, backing off`, {
          status: response.status,
          attempt: attempt + 1,
          waitMs,
        });
        await sleep(waitMs);
        continue;
      }
      break;
    }
    lastStatus = response ? response.status : lastStatus;
    if (response.status !== 404) {
      const body = await response.text();
      throw new Error(`${label} failed: ${response.status} ${body} (${url})`);
    }
  }
  throw new Error(
    `${label} failed: endpoint not found (${lastStatus}). Tried: ${urls.join(", ")}`
  );
}

async function fetchQuote(inputMint, outputMint, amount, slippageBps) {
  const now = Date.now();
  const elapsed = now - lastQuoteAtMs;
  if (elapsed < MIN_QUOTE_INTERVAL_MS) {
    await sleep(MIN_QUOTE_INTERVAL_MS - elapsed);
  }
  lastQuoteAtMs = Date.now();
  const liteFallbacks = buildUrls(["/swap/v1/quote", "/quote", "/v1/quote"]);
  const defaultUrls = buildUrls(["/v6/quote"]);
  const urls =
    JUP_BASE_URL.includes("lite-api.jup.ag")
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
  const urls =
    JUP_BASE_URL.includes("lite-api.jup.ag")
      ? liteFallbacks.concat(defaultUrls)
      : defaultUrls;

  let lastError = null;
  for (const url of urls) {
    let response;
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
      lastError = err;
      continue;
    }
    if (response.ok) {
      const data = await response.json();
      if (!data || !data.swapTransaction) {
        throw new Error("Swap response missing transaction");
      }
      return data.swapTransaction;
    }
    if (response.status !== 404) {
      const body = await response.text();
      throw new Error(`Swap failed: ${response.status} ${body} (${url})`);
    }
  }
  if (lastError) {
    throw new Error(`Swap fetch failed: ${lastError.message || lastError}`);
  }
  throw new Error(
    `Swap failed: endpoint not found (404). Tried: ${urls.join(", ")}`
  );
}

async function executeSwap(connection, keypair, quote, timeoutMs) {
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
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await connection.getSignatureStatus(signature);
    const state = status.value;
    if (state && state.confirmationStatus === "confirmed") {
      return { confirmed: true, signature };
    }
    await sleep(1000);
  }
  return { confirmed: false, signature };
}

async function waitForTokenBalance(connection, owner, mint, minRaw, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const balance = await getTokenBalance(connection, owner, mint);
    if (balance >= minRaw) {
      return balance;
    }
    await sleep(1000);
  }
  return null;
}

async function getMintDecimals(connection, mintAddress) {
  const mintPub = new PublicKey(mintAddress);
  const info = await connection.getParsedAccountInfo(mintPub, "confirmed");
  const parsed = info.value?.data;
  if (parsed && parsed.program === "spl-token") {
    const decimals = parsed.parsed?.info?.decimals;
    if (decimals !== undefined) {
      return decimals;
    }
  }

  const raw = await connection.getAccountInfo(mintPub, "confirmed");
  if (!raw || !raw.data || raw.data.length < 45) {
    throw new Error(`Unable to read mint data for ${mintAddress}`);
  }
  // SPL Mint layout: decimals at byte offset 44.
  return raw.data[44];
}

async function getTokenBalance(connection, owner, mint) {
  const accounts = await connection.getTokenAccountsByOwner(
    owner,
    { mint: new PublicKey(mint) },
    "confirmed"
  );
  if (!accounts.value.length) return 0n;
  let total = 0n;
  for (const acc of accounts.value) {
    const bal = await connection.getTokenAccountBalance(acc.pubkey, "confirmed");
    total += BigInt(bal.value.amount);
  }
  return total;
}

async function main() {
  if (!RPC_URL) {
    logError("Missing SOLANA_RPC_URL env var.");
    process.exit(1);
  }
  const tokenMint = process.env.TARGET_MINT;
  if (!tokenMint) {
    logError("Missing TARGET_MINT.");
    process.exit(1);
  }

  const wallets = ensureInitialWallet();
  const keypair = keypairFromEntry(wallets[0]);
  const connection = new Connection(RPC_URL, "confirmed");

  const gridStepPctBase = Number(
    process.env.GRID_STEP_PCT || DEFAULT_GRID_STEP_PCT
  );
  const gridMinStepPct = Number(
    process.env.GRID_MIN_STEP_PCT || DEFAULT_GRID_MIN_STEP_PCT
  );
  const gridMaxStepPct = Number(
    process.env.GRID_MAX_STEP_PCT || DEFAULT_GRID_MAX_STEP_PCT
  );
  const gridVolWindowSec = Number(
    process.env.GRID_VOL_WINDOW_SEC || DEFAULT_GRID_VOL_WINDOW_SEC
  );
  const gridVolMult = Number(process.env.GRID_VOL_MULT || DEFAULT_GRID_VOL_MULT);
  const gridMaxUnits = Number(
    process.env.GRID_MAX_UNITS || DEFAULT_GRID_MAX_UNITS
  );
  const gridAllocPct = Number(
    process.env.GRID_ALLOC_PCT || DEFAULT_GRID_ALLOC_PCT
  );
  const gridGapReanchorPct = Number(
    process.env.GRID_GAP_REANCHOR_PCT || DEFAULT_GRID_GAP_REANCHOR_PCT
  );
  const gridSkipMult = Number(
    process.env.GRID_SKIP_MULT || DEFAULT_GRID_SKIP_MULT
  );
  const pollMs = Number(process.env.GRID_POLL_MS || DEFAULT_GRID_POLL_MS);
  const priceSampleSol = Number(
    process.env.PRICE_SAMPLE_SOL || DEFAULT_PRICE_SAMPLE_SOL
  );
  const buySlippageBps = Number(
    process.env.BUY_SLIPPAGE_BPS || DEFAULT_BUY_SLIPPAGE_BPS
  );
  const sellSlippageBps = Number(
    process.env.SELL_SLIPPAGE_BPS || DEFAULT_SELL_SLIPPAGE_BPS
  );
  const buyPriorityFeeLamports = Number(
    process.env.BUY_PRIORITY_FEE_LAMPORTS || DEFAULT_BUY_PRIORITY_FEE_LAMPORTS
  );
  const sellPriorityFeeLamports = Number(
    process.env.SELL_PRIORITY_FEE_LAMPORTS || DEFAULT_SELL_PRIORITY_FEE_LAMPORTS
  );
  const feeLamports = Number(
    process.env.SIM_FEE_LAMPORTS || DEFAULT_FEE_LAMPORTS
  );
  const minProfitPct = Number(
    process.env.GRID_MIN_PROFIT_PCT || DEFAULT_MIN_PROFIT_PCT
  );
  const reserveSol = Number(
    process.env.GRID_RESERVE_SOL || DEFAULT_RESERVE_SOL
  );
  const gridSeedUnitsRaw = Object.prototype.hasOwnProperty.call(
    process.env,
    "GRID_SEED_UNITS"
  )
    ? Number(process.env.GRID_SEED_UNITS)
    : DEFAULT_GRID_SEED_UNITS;
  let gridSeedUnits =
    gridSeedUnitsRaw < 0 ? Math.floor(gridMaxUnits / 2) : gridSeedUnitsRaw;
  if (!Number.isFinite(gridSeedUnits) || gridSeedUnits < 0) {
    gridSeedUnits = Math.floor(gridMaxUnits / 2);
  }
  gridSeedUnits = clamp(gridSeedUnits, 0, gridMaxUnits);
  const dryRun =
    String(process.env.GRID_DRY_RUN || "true").toLowerCase() !== "false";
  const simStartSol = DEFAULT_SIM_START_SOL;
  const rateLimitBackoffMs = Number(
    process.env.GRID_RATE_LIMIT_BACKOFF_MS || RATE_LIMIT_BACKOFF_MS
  );
  const rateLimitMaxRetries = Number(
    process.env.GRID_RATE_LIMIT_MAX_RETRIES || RATE_LIMIT_MAX_RETRIES
  );
  const minQuoteIntervalMs = Number(
    process.env.GRID_MIN_QUOTE_INTERVAL_MS || MIN_QUOTE_INTERVAL_MS
  );
  if (Number.isFinite(rateLimitBackoffMs)) {
    RATE_LIMIT_BACKOFF_MS = rateLimitBackoffMs;
  }
  if (Number.isFinite(rateLimitMaxRetries)) {
    RATE_LIMIT_MAX_RETRIES = rateLimitMaxRetries;
  }
  if (Number.isFinite(minQuoteIntervalMs)) {
    MIN_QUOTE_INTERVAL_MS = minQuoteIntervalMs;
  }

  const tokenDecimals = await getMintDecimals(connection, tokenMint);
  const tokenFactor = 10n ** BigInt(tokenDecimals);

  logInfo("LOG settings", {
    file: LOG_FILE,
    console: LOG_TO_CONSOLE ? "on" : "off",
  });
  logInfo("CONFIG grid", {
    token: tokenMint,
    stepPct: gridStepPctBase,
    minStepPct: gridMinStepPct,
    maxStepPct: gridMaxStepPct,
    volWindowSec: gridVolWindowSec,
    volMult: gridVolMult,
    maxUnits: gridMaxUnits,
    allocPct: gridAllocPct,
    gapReanchorPct: gridGapReanchorPct,
    skipMult: gridSkipMult,
    pollMs,
    priceSampleSol,
    buySlippageBps,
    sellSlippageBps,
    buyPriorityFeeLamports,
    sellPriorityFeeLamports,
    feeLamports,
    minProfitPct,
    rateLimitBackoffMs: RATE_LIMIT_BACKOFF_MS,
    rateLimitMaxRetries: RATE_LIMIT_MAX_RETRIES,
    minQuoteIntervalMs: MIN_QUOTE_INTERVAL_MS,
    reserveSol,
    seedUnits: gridSeedUnits,
    simMode: dryRun,
    simStartSol,
  });
  if (dryRun) {
    logWarn("SIM mode enforced", { simStartSol });
  }

  let state = readState();
  if (!state || state.tokenMint !== tokenMint) {
    state = {
      tokenMint,
      anchorPrice: null,
      currentUnits: 0,
      lastPrice: null,
      lastActionTs: null,
      simSolLamports: null,
      simTokenAmountRaw: null,
      simCostLamports: null,
      simLots: [],
      simLotSeq: 0,
    };
    writeState(state);
  }

  if (dryRun && (state.simSolLamports === null || state.simSolLamports === undefined)) {
    state.simSolLamports = BigInt(Math.round(simStartSol * 1e9)).toString();
    state.simTokenAmountRaw = "0";
    state.simCostLamports = "0";
    state.simLots = [];
    state.simLotSeq = 0;
    writeState(state);
  }
  if (!Array.isArray(state.simLots)) {
    state.simLots = [];
  }
  if (state.simLotSeq === undefined || state.simLotSeq === null) {
    state.simLotSeq = 0;
  }
  if (dryRun) {
    const simTokensRaw = BigInt(state.simTokenAmountRaw || "0");
    const simCostLamports = BigInt(state.simCostLamports || "0");
    if (simTokensRaw > 0n && state.simLots.length === 0 && simCostLamports > 0n) {
      rebuildLotsFromAggregate(state);
      writeState(state);
      logWarn("SIM lots rebuilt from aggregate state", {
        lot: state.simLotSeq,
        tokensRaw: simTokensRaw.toString(),
        costLamports: simCostLamports.toString(),
      });
    }
  } else {
    const solBalanceLamports = BigInt(
      await connection.getBalance(keypair.publicKey, "confirmed")
    );
    const tokenBalanceRaw = await getTokenBalance(
      connection,
      keypair.publicKey,
      tokenMint
    );
    logInfo("LIVE balances", {
      solLamports: solBalanceLamports.toString(),
      tokenRaw: tokenBalanceRaw.toString(),
    });
    const anchorPrice = state.anchorPrice || (await samplePrice());
    const tokenValueLamports =
      (BigInt(Math.round(anchorPrice * 1e9)) * tokenBalanceRaw) / tokenFactor;
    const totalValueLamports = solBalanceLamports + tokenValueLamports;
    const gridAllocLamports =
      (totalValueLamports * BigInt(Math.round(gridAllocPct * 100))) / 10000n;
    const targetTokenValueLamports = gridAllocLamports / 2n;
    const reserveLamports = totalValueLamports - gridAllocLamports;

    if (tokenValueLamports > targetTokenValueLamports && tokenBalanceRaw > 0n) {
      const excessValueLamports = tokenValueLamports - targetTokenValueLamports;
      const priceLamportsPerToken = BigInt(Math.round(anchorPrice * 1e9));
      const sellAmountRaw =
        priceLamportsPerToken > 0n
          ? (excessValueLamports * tokenFactor) / priceLamportsPerToken
          : 0n;
      if (sellAmountRaw > 0n) {
        const quote = await fetchQuote(
          tokenMint,
          SOL_MINT,
          sellAmountRaw,
          sellSlippageBps
        );
        if (sellPriorityFeeLamports > 0) {
          quote._swapOptions = {
            prioritizationFeeLamports: sellPriorityFeeLamports,
          };
        }
        logInfo("LIVE rebalance sell", {
          targetTokenValueSol: formatSol(targetTokenValueLamports),
          sellAmountRaw: sellAmountRaw.toString(),
          excessValueSol: formatSol(excessValueLamports),
        });
        const swapResult = await executeSwap(connection, keypair, quote, 60000);
        logInfo("LIVE rebalance tx", {
          signature: swapResult.signature,
          confirmed: swapResult.confirmed,
        });
      }
    } else if (tokenValueLamports < targetTokenValueLamports) {
      const neededValueLamports = targetTokenValueLamports - tokenValueLamports;
      const availableSolLamports =
        solBalanceLamports > reserveLamports
          ? solBalanceLamports - reserveLamports
          : 0n;
      const buyLamports =
        neededValueLamports < availableSolLamports
          ? neededValueLamports
          : availableSolLamports;
      if (buyLamports > 0n) {
        const quote = await fetchQuote(
          SOL_MINT,
          tokenMint,
          buyLamports,
          buySlippageBps
        );
        if (buyPriorityFeeLamports > 0) {
          quote._swapOptions = {
            prioritizationFeeLamports: buyPriorityFeeLamports,
          };
        }
        logInfo("LIVE rebalance buy", {
          targetTokenValueSol: formatSol(targetTokenValueLamports),
          buyLamports: buyLamports.toString(),
          neededValueSol: formatSol(neededValueLamports),
        });
        const swapResult = await executeSwap(connection, keypair, quote, 60000);
        logInfo("LIVE rebalance tx", {
          signature: swapResult.signature,
          confirmed: swapResult.confirmed,
        });
      }
    }
    if (state.currentUnits === 0 && tokenBalanceRaw > 0n) {
      const allocSolLamports =
        (solBalanceLamports * BigInt(Math.round(gridAllocPct * 100))) / 10000n;
      const unitSolLamports =
        allocSolLamports / BigInt(Math.max(gridMaxUnits, 1));
      const derivedUnits =
        unitSolLamports > 0n
          ? Number(tokenValueLamports / unitSolLamports)
          : 0;
      state.currentUnits = clamp(derivedUnits, 0, gridMaxUnits);
      state.anchorPrice = anchorPrice;
      writeState(state);
      logInfo("LIVE grid alignment", {
        anchorPrice: anchorPrice.toFixed(9),
        tokenValueSol: formatSol(tokenValueLamports),
        unitSol: formatSol(unitSolLamports),
        currentUnits: state.currentUnits,
      });
    }
  }

  const priceSamples = [];

  async function retryLoop(label, fn) {
    // Simple backoff for startup tasks that should not exit the bot.
    while (true) {
      try {
        return await fn();
      } catch (err) {
        logWarn(`${label} failed, retrying`, { error: err.message || err });
        await sleep(RATE_LIMIT_BACKOFF_MS);
      }
    }
  }

  if (!state.anchorPrice) {
    await retryLoop("GRID seed price", async () => {
      const seedPrice = await samplePrice();
      state.anchorPrice = seedPrice;
      state.lastPrice = seedPrice;
      writeState(state);
    });
  }

  if (gridSeedUnits > 0 && state.currentUnits === 0) {
    await retryLoop("GRID seed trade", async () => {
      const solBalanceLamports = dryRun
        ? BigInt(state.simSolLamports || "0")
        : BigInt(await connection.getBalance(keypair.publicKey, "confirmed"));
    const solBalance = Number(solBalanceLamports) / 1e9;
    const allocSol = solBalance * (gridAllocPct / 100);
    const unitSol = allocSol / gridMaxUnits;
    let sizeSol = unitSol * gridSeedUnits;
    const availableSol = Math.max(solBalance - reserveSol, 0);
    sizeSol = Math.min(sizeSol, availableSol);

      if (sizeSol <= 0) {
        logWarn("GRID seed skipped: no SOL available.");
        return;
      }
      if (dryRun) {
        const lamports = BigInt(Math.round(sizeSol * 1e9));
        const quote = await fetchQuote(
          SOL_MINT,
          tokenMint,
          lamports,
          buySlippageBps
        );
        const fee = BigInt(buyPriorityFeeLamports + feeLamports);
        const totalCost = lamports + fee;
        const totalTokens = BigInt(quote.outAmount);
        const units = Math.max(gridSeedUnits, 1);
        const baseTokens = totalTokens / BigInt(units);
        const remTokens = totalTokens % BigInt(units);
        const baseCost = totalCost / BigInt(units);
        const remCost = totalCost % BigInt(units);
        logInfo("GRID seed dry-run", { sol: sizeSol.toFixed(4) });
        const simSol = BigInt(state.simSolLamports || "0") - totalCost;
        const simTokens = BigInt(state.simTokenAmountRaw || "0") + totalTokens;
        const simCost = BigInt(state.simCostLamports || "0") + totalCost;
        for (let i = 0; i < units; i += 1) {
          const lotTokens = baseTokens + (i === units - 1 ? remTokens : 0n);
          const lotCost = baseCost + (i === units - 1 ? remCost : 0n);
          state.simLotSeq += 1;
          state.simLots.push({
            id: state.simLotSeq,
            tokensRaw: lotTokens.toString(),
            costLamports: lotCost.toString(),
          });
        }
        state.simSolLamports = simSol.toString();
        state.simTokenAmountRaw = simTokens.toString();
        state.simCostLamports = simCost.toString();
        state.currentUnits = Math.min(gridSeedUnits, gridMaxUnits);
        writeState(state);
        return;
      }
      const lamports = BigInt(Math.round(sizeSol * 1e9));
      const quote = await fetchQuote(
        SOL_MINT,
        tokenMint,
        lamports,
        buySlippageBps
      );
      if (buyPriorityFeeLamports > 0) {
        quote._swapOptions = {
          prioritizationFeeLamports: buyPriorityFeeLamports,
        };
      }
      logInfo("GRID seed buy", {
        sol: sizeSol.toFixed(4),
        units: gridSeedUnits,
      });
      const swapResult = await executeSwap(connection, keypair, quote, 60000);
      logInfo("GRID seed tx", {
        signature: swapResult.signature,
        confirmed: swapResult.confirmed,
      });
      if (!swapResult.confirmed) {
        throw new Error("Seed buy not confirmed");
      }
      const minTokens = BigInt(quote.outAmount || "0");
      const balance = await waitForTokenBalance(
        connection,
        keypair.publicKey,
        tokenMint,
        minTokens,
        60000
      );
      if (!balance) {
        throw new Error("Seed buy tokens not found after confirmation");
      }
      state.currentUnits = Math.min(gridSeedUnits, gridMaxUnits);
      writeState(state);
    });
  }

  async function samplePrice() {
    const sampleLamports = BigInt(Math.round(priceSampleSol * 1e9));
    const quote = await fetchQuote(
      SOL_MINT,
      tokenMint,
      sampleLamports,
      buySlippageBps
    );
    const outAmountRaw = BigInt(quote.outAmount);
    const priceLamportsPerToken =
      (sampleLamports * tokenFactor) / outAmountRaw;
    const price = Number(priceLamportsPerToken) / 1e9;
    return price;
  }

  while (true) {
    try {
      const price = await samplePrice();
      const now = Date.now();
      priceSamples.push({ ts: now, price });
      const windowMs = gridVolWindowSec * 1000;
      while (priceSamples.length && now - priceSamples[0].ts > windowMs) {
        priceSamples.shift();
      }

      let avgAbsMove = 0;
      for (let i = 1; i < priceSamples.length; i += 1) {
        const prev = priceSamples[i - 1].price;
        const curr = priceSamples[i].price;
        avgAbsMove += Math.abs((curr - prev) / prev) * 100;
      }
      if (priceSamples.length > 1) {
        avgAbsMove /= priceSamples.length - 1;
      }

      const stepPct = clamp(
        gridStepPctBase * (1 + avgAbsMove * gridVolMult),
        gridMinStepPct,
        gridMaxStepPct
      );

      if (!state.anchorPrice) {
        state.anchorPrice = price;
        state.lastPrice = price;
        state.currentUnits = 0;
        writeState(state);
      }

      const anchor = state.anchorPrice;
      const gapPct = Math.abs((price - anchor) / anchor) * 100;
      if (gapPct >= gridGapReanchorPct && state.currentUnits === 0) {
        state.anchorPrice = price;
        state.lastPrice = price;
        writeState(state);
        logInfo("GRID re-anchor", { price: price.toFixed(8) });
      }

      const stepPrice = anchor * (stepPct / 100);
      const buyLevels = [];
      const sellLevels = [];
      for (let i = 1; i <= gridMaxUnits; i += 1) {
        buyLevels.push((anchor - stepPrice * i).toFixed(8));
        sellLevels.push((anchor + stepPrice * i).toFixed(8));
      }
      const baseUnits = Math.floor(gridMaxUnits / 2);
      const desiredUnits = clamp(
        baseUnits + Math.floor((anchor - price) / stepPrice),
        0,
        gridMaxUnits
      );
      const deltaUnits = desiredUnits - state.currentUnits;

      const solBalanceLamports = dryRun
        ? BigInt(state.simSolLamports || "0")
        : BigInt(await connection.getBalance(keypair.publicKey, "confirmed"));
      const solBalance = Number(solBalanceLamports) / 1e9;
      const allocSol = solBalance * (gridAllocPct / 100);
      const unitSol = allocSol / gridMaxUnits;

      if (dryRun) {
        const simTokensRaw = BigInt(state.simTokenAmountRaw || "0");
        const lotsTotal = Array.isArray(state.simLots)
          ? state.simLots.reduce(
              (acc, lot) => acc + BigInt(lot.tokensRaw),
              0n
            )
          : 0n;
        if (simTokensRaw !== lotsTotal) {
          const rebuilt = rebuildLotsFromAggregate(state);
          if (rebuilt) {
            logWarn("SIM lots reconciled to aggregate", {
              tokensRaw: simTokensRaw.toString(),
            });
            writeState(state);
          }
        }
      }

      const summary = [
        `${ts()} | GRID`,
        `  price  ${price.toFixed(8)} | anchor ${anchor.toFixed(8)}`,
        `  step   ${stepPct.toFixed(2)}% | units ${state.currentUnits} -> ${desiredUnits} (base ${baseUnits})`,
        `  buy    ${buyLevels.join(" ")}`,
        `  sell   ${sellLevels.join(" ")}`,
      ];
      if (dryRun) {
        const simSol = BigInt(state.simSolLamports || "0");
        const simTokens = BigInt(state.simTokenAmountRaw || "0");
        summary.push(
          `  sim    ${formatSol(simSol)} SOL | token ${formatTokenAmount(
            simTokens,
            tokenDecimals
          )}`
        );
      }
      if (dryRun) {
        const simSol = BigInt(state.simSolLamports || "0");
        const simTokens = BigInt(state.simTokenAmountRaw || "0");
        const simCost = BigInt(state.simCostLamports || "0");
        const avgCostLamportsPerToken =
          simTokens > 0n ? (simCost * tokenFactor) / simTokens : 0n;
        const avgCostPerToken = Number(avgCostLamportsPerToken) / 1e9;
        const tokenValueLamports =
          (BigInt(Math.round(price * 1e9)) * simTokens) / tokenFactor;
        const totalValue = simSol + tokenValueLamports;
        const startLamports = BigInt(Math.round(simStartSol * 1e9));
        const pnlLamports = totalValue - startLamports;
        summary.push(
          `  pnl    ${formatSol(pnlLamports)} SOL | ${percentFromLamports(
            pnlLamports,
            startLamports
          )}`
        );
        summary.push(
          `  cost   ${formatSol(simCost)} SOL | value ${formatSol(
            tokenValueLamports
          )} SOL`
        );
        summary.push(
          `  avg    ${avgCostPerToken.toFixed(9)} SOL/token | px ${price.toFixed(
            9
          )}`
        );
      }
      console.log(summary.join("\n"));

      if (deltaUnits > 0) {
        let sizeSol = unitSol * deltaUnits;
        if (deltaUnits > 1) {
          sizeSol *= 1 + (deltaUnits - 1) * gridSkipMult;
        }
        const availableSol = Math.max(solBalance - reserveSol, 0);
        sizeSol = Math.min(sizeSol, availableSol);
        if (sizeSol <= 0) {
          logWarn("GRID buy skipped: no SOL available.");
        } else if (dryRun) {
          const lamports = BigInt(Math.round(sizeSol * 1e9));
          const quote = await fetchQuote(
            SOL_MINT,
            tokenMint,
            lamports,
            buySlippageBps
          );
          const fee = BigInt(buyPriorityFeeLamports + feeLamports);
          const totalCost = lamports + fee;
          const totalTokens = BigInt(quote.outAmount);
          const units = Math.max(deltaUnits, 1);
          const baseTokens = totalTokens / BigInt(units);
          const remTokens = totalTokens % BigInt(units);
          const baseCost = totalCost / BigInt(units);
          const remCost = totalCost % BigInt(units);
          logInfo("GRID buy dry-run", {
            sol: sizeSol.toFixed(4),
            units: deltaUnits,
          });
          const simSol = BigInt(state.simSolLamports || "0") - totalCost;
          const simTokens = BigInt(state.simTokenAmountRaw || "0") + totalTokens;
          const simCost = BigInt(state.simCostLamports || "0") + totalCost;
          for (let i = 0; i < units; i += 1) {
            const lotTokens = baseTokens + (i === units - 1 ? remTokens : 0n);
            const lotCost = baseCost + (i === units - 1 ? remCost : 0n);
            state.simLotSeq += 1;
            state.simLots.push({
              id: state.simLotSeq,
              tokensRaw: lotTokens.toString(),
              costLamports: lotCost.toString(),
            });
          }
          state.simSolLamports = simSol.toString();
          state.simTokenAmountRaw = simTokens.toString();
          state.simCostLamports = simCost.toString();
          state.currentUnits = desiredUnits;
          writeState(state);
          logInfo("GRID buy quote", {
            inLamports: lamports.toString(),
            outTokens: quote.outAmount,
            priceImpact: quote.priceImpactPct ?? "n/a",
            feeLamports: fee.toString(),
          });
        } else {
          const lamports = BigInt(Math.round(sizeSol * 1e9));
          const quote = await fetchQuote(
            SOL_MINT,
            tokenMint,
            lamports,
            buySlippageBps
          );
          if (buyPriorityFeeLamports > 0) {
            quote._swapOptions = {
              prioritizationFeeLamports: buyPriorityFeeLamports,
            };
          }
            logInfo("GRID buy", { sol: sizeSol.toFixed(4), units: deltaUnits });
            const swapResult = await executeSwap(connection, keypair, quote, 60000);
            logInfo("GRID buy tx", {
              signature: swapResult.signature,
              confirmed: swapResult.confirmed,
            });
            state.currentUnits = desiredUnits;
            writeState(state);
        }
      } else if (deltaUnits < 0) {
        const unitsToSell = Math.abs(deltaUnits);
        const sizeSol = unitSol * unitsToSell;
        const tokenAmount = Math.floor((sizeSol / price) * 10 ** tokenDecimals);
        if (tokenAmount <= 0) {
          logWarn("GRID sell skipped: size too small.");
        } else if (dryRun) {
          const availableLots = Array.isArray(state.simLots)
            ? state.simLots
            : [];
          const candidateLots = availableLots.slice(-unitsToSell);
          const candidateAmountRaw = candidateLots.reduce(
            (acc, lot) => acc + BigInt(lot.tokensRaw),
            0n
          );
          if (candidateAmountRaw <= 0n) {
            logWarn("GRID sell skipped: no simulated tokens.");
          } else {
            const quoteAll = await fetchQuote(
              tokenMint,
              SOL_MINT,
              candidateAmountRaw,
              sellSlippageBps
            );
            const fee = BigInt(sellPriorityFeeLamports + feeLamports);
            const proceedsAll = BigInt(quoteAll.outAmount) - fee;
            const totalSoldTokensAll = candidateAmountRaw;
            let remainingProceedsAll = proceedsAll;
            const preview = candidateLots.map((lot, index) => {
              const tokensRaw = BigInt(lot.tokensRaw);
              const costLamports = BigInt(lot.costLamports);
              const isLast = index === candidateLots.length - 1;
              const share = isLast
                ? remainingProceedsAll
                : (proceedsAll * tokensRaw) / totalSoldTokensAll;
              remainingProceedsAll -= share;
              const realizedPnl = share - costLamports;
              const roiPct =
                costLamports > 0n
                  ? (Number(realizedPnl) / Number(costLamports)) * 100
                  : 0;
              return { lot, realizedPnl, roiPct };
            });
            const profitableLots = preview
              .filter((stat) => Number.isFinite(stat.roiPct) && stat.roiPct >= minProfitPct)
              .map((stat) => stat.lot);
            if (!profitableLots.length) {
              logWarn("GRID sell blocked: below profit target", {
                units: unitsToSell,
                outLamports: quoteAll.outAmount,
                feeLamports: fee.toString(),
                minProfitPct,
              });
              continue;
            }
            if (profitableLots.length < candidateLots.length) {
              logInfo("GRID sell filtered to profitable lots", {
                requestedUnits: unitsToSell,
                sellUnits: profitableLots.length,
                minProfitPct,
              });
            }

            logInfo("GRID sell dry-run", {
              sol: sizeSol.toFixed(4),
              units: profitableLots.length,
            });
            const sellLotsRaw = profitableLots.reduce(
              (acc, lot) => acc + BigInt(lot.tokensRaw),
              0n
            );
            const quote =
              profitableLots.length === candidateLots.length
                ? quoteAll
                : await fetchQuote(
                    tokenMint,
                    SOL_MINT,
                    sellLotsRaw,
                    sellSlippageBps
                  );
            const proceedsLamports = BigInt(quote.outAmount) - fee;
            let remainingProceeds = proceedsLamports;
            const soldLots = profitableLots.map((lot) => ({
              id: lot.id,
              tokensRaw: BigInt(lot.tokensRaw),
              costLamports: BigInt(lot.costLamports),
            }));
            for (let i = 0; i < soldLots.length; i += 1) {
              const lot = soldLots[i];
              const isLast = i === soldLots.length - 1;
              const share = isLast
                ? remainingProceeds
                : (proceedsLamports * lot.tokensRaw) / sellLotsRaw;
              remainingProceeds -= share;
              const realizedPnl = share - lot.costLamports;
              logInfo("GRID step ROI", {
                lot: lot.id,
                pnl: formatSol(realizedPnl),
                pnlPct: percentFromLamports(realizedPnl, lot.costLamports),
              });
            }
            const simSol =
              BigInt(state.simSolLamports || "0") + proceedsLamports;
            const simCost = BigInt(state.simCostLamports || "0");
            const soldCost = soldLots.reduce(
              (acc, lot) => acc + lot.costLamports,
              0n
            );
            const simTokensAfter =
              BigInt(state.simTokenAmountRaw || "0") - sellLotsRaw;
            state.simSolLamports = simSol.toString();
            state.simTokenAmountRaw = simTokensAfter.toString();
            state.simCostLamports = (simCost - soldCost).toString();
            const soldIds = new Set(soldLots.map((lot) => lot.id));
            state.simLots = availableLots.filter((lot) => !soldIds.has(lot.id));
            state.currentUnits =
              Math.max(state.currentUnits - soldLots.length, 0);
            writeState(state);
            logInfo("GRID sell quote", {
              inTokens: sellLotsRaw.toString(),
              outLamports: quote.outAmount,
              priceImpact: quote.priceImpactPct ?? "n/a",
              feeLamports: fee.toString(),
            });
          }
        } else {
          const tokenBal = await getTokenBalance(
            connection,
            keypair.publicKey,
            tokenMint
          );
          const amountRaw = BigInt(Math.min(Number(tokenBal), tokenAmount));
          if (amountRaw <= 0n) {
            logWarn("GRID sell skipped: no tokens available.");
            continue;
          }
          const quote = await fetchQuote(
            tokenMint,
            SOL_MINT,
            amountRaw,
            sellSlippageBps
          );
          if (sellPriorityFeeLamports > 0) {
            quote._swapOptions = {
              prioritizationFeeLamports: sellPriorityFeeLamports,
            };
          }
            logInfo("GRID sell", { sol: sizeSol.toFixed(4), units: unitsToSell });
            const swapResult = await executeSwap(connection, keypair, quote, 60000);
            logInfo("GRID sell tx", {
              signature: swapResult.signature,
              confirmed: swapResult.confirmed,
            });
            state.currentUnits = desiredUnits;
            writeState(state);
        }
      }

      state.lastPrice = price;
      state.lastActionTs = ts();
      if (state.currentUnits === 0 && baseUnits > 0) {
        const unitsToSeed = baseUnits;
        const sizeSol = unitSol * unitsToSeed;
        if (sizeSol > 0) {
          const lamports = BigInt(Math.round(sizeSol * 1e9));
          const quote = await fetchQuote(
            SOL_MINT,
            tokenMint,
            lamports,
            buySlippageBps
          );
          if (dryRun) {
            const fee = BigInt(buyPriorityFeeLamports + feeLamports);
            const totalCost = lamports + fee;
            const totalTokens = BigInt(quote.outAmount);
            const baseTokens = totalTokens / BigInt(unitsToSeed);
            const remTokens = totalTokens % BigInt(unitsToSeed);
            const baseCost = totalCost / BigInt(unitsToSeed);
            const remCost = totalCost % BigInt(unitsToSeed);
            const simSol = BigInt(state.simSolLamports || "0") - totalCost;
            const simTokens =
              BigInt(state.simTokenAmountRaw || "0") + totalTokens;
            const simCost =
              BigInt(state.simCostLamports || "0") + totalCost;
            for (let i = 0; i < unitsToSeed; i += 1) {
              const lotTokens =
                baseTokens + (i === unitsToSeed - 1 ? remTokens : 0n);
              const lotCost = baseCost + (i === unitsToSeed - 1 ? remCost : 0n);
              state.simLotSeq += 1;
              state.simLots.push({
                id: state.simLotSeq,
                tokensRaw: lotTokens.toString(),
                costLamports: lotCost.toString(),
              });
            }
            state.simSolLamports = simSol.toString();
            state.simTokenAmountRaw = simTokens.toString();
            state.simCostLamports = simCost.toString();
            state.currentUnits = unitsToSeed;
            logInfo("GRID re-center seed", {
              units: unitsToSeed,
              sol: sizeSol.toFixed(4),
            });
          } else {
            if (buyPriorityFeeLamports > 0) {
              quote._swapOptions = {
                prioritizationFeeLamports: buyPriorityFeeLamports,
              };
            }
            logInfo("GRID re-center buy", {
              units: unitsToSeed,
              sol: sizeSol.toFixed(4),
            });
            const swapResult = await executeSwap(connection, keypair, quote, 60000);
            logInfo("GRID re-center tx", {
              signature: swapResult.signature,
              confirmed: swapResult.confirmed,
            });
            if (!swapResult.confirmed) {
              throw new Error("Re-center buy not confirmed");
            }
            const minTokens = BigInt(quote.outAmount || "0");
            const balance = await waitForTokenBalance(
              connection,
              keypair.publicKey,
              tokenMint,
              minTokens,
              60000
            );
            if (!balance) {
              throw new Error("Re-center tokens not found after confirmation");
            }
            state.currentUnits = unitsToSeed;
          }
        }
      }
      writeState(state);
      await sleep(pollMs);
    } catch (err) {
      logError("GRID error", { error: err.message || err });
      await sleep(pollMs);
    }
  }
}

main().catch((err) => {
  logError("Grid bot failed", { error: err.message || err });
  process.exit(1);
});
