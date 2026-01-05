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
const STATE_FILE = path.join(__dirname, "bot_state.json");
const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUP_BASE_URL = process.env.JUPITER_API_BASE || "https://quote-api.jup.ag";

const DEFAULT_STEP_SOL = [0.01, 0.03, 0.05];
const DEFAULT_STEP_DRAWDOWN_PCT = [0, 5, 10];
const DEFAULT_PROFIT_BPS = 50;
const DEFAULT_POLL_MS = 5000;
const DEFAULT_PRICE_SAMPLE_SOL = 0.01;
const DEFAULT_ENTRY_DROP_PCT = 4.5;
const DEFAULT_BUY_SLIPPAGE_BPS = 50;
const DEFAULT_SELL_SLIPPAGE_BPS = 50;
const DEFAULT_BUY_SLIPPAGE_STEP_BPS = 25;
const DEFAULT_BUY_SLIPPAGE_CAP_BPS = 500;
const DEFAULT_SELL_PRIORITY_FEE_LAMPORTS = 0;
const DEFAULT_BUY_PRIORITY_FEE_LAMPORTS = 0;
const DEFAULT_SELL_PRIORITY_FEE_STEP_LAMPORTS = 2000;
const DEFAULT_SELL_PRIORITY_FEE_CAP_LAMPORTS = 20000;
const DEFAULT_SELL_SLIPPAGE_STEP_BPS = 25;
const DEFAULT_SELL_SLIPPAGE_CAP_BPS = 500;
const DEFAULT_CONFIRM_TIMEOUT_MS = 120000;
const DEFAULT_PROFIT_CONFIRM_TICKS = 2;
const DEFAULT_TRAIL_START_PCT = 8;
const DEFAULT_TRAIL_GAP_PCT = 4;
const DEFAULT_TRAIL_MIN_PROFIT_PCT = 3;
const DEFAULT_SELL_PNL_LOG = "sell_pnl.log";
const PRICE_SCALE = 1_000_000_000n;
const LOG_FILE =
  process.env.BOT_LOG_PATH || path.join(__dirname, "botv2.log");
const LOG_TO_CONSOLE = process.env.LOG_TO_CONSOLE !== "false";

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

function readState() {
  if (!fs.existsSync(STATE_FILE)) {
    return null;
  }

  const raw = fs.readFileSync(STATE_FILE, "utf8");
  if (!raw.trim()) {
    return null;
  }

  return JSON.parse(raw);
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function parseNumberList(value, fallback) {
  if (!value) {
    return fallback;
  }
  const parts = value
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item));
  return parts.length ? parts : fallback;
}

function sumNumbers(values) {
  return values.reduce((acc, item) => acc + item, 0);
}

function lamportsFromSol(sol) {
  return BigInt(Math.round(sol * 1e9));
}

function formatPctFromBps(bps) {
  return `${(Number(bps) / 100).toFixed(2)}%`;
}

function formatSolFromLamports(lamports, decimals = 6) {
  const sign = lamports < 0n ? "-" : "";
  const value = lamports < 0n ? -lamports : lamports;
  const whole = value / 1_000_000_000n;
  const frac = value % 1_000_000_000n;
  const fracStr = frac.toString().padStart(9, "0").slice(0, decimals);
  return `${sign}${whole.toString()}.${fracStr}`;
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

function ts() {
  return new Date().toISOString().replace("T", " ").split(".")[0];
}

const originalConsoleLog = console.log.bind(console);
const originalConsoleError = console.error.bind(console);

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

function formatLogArgs(args) {
  return args.map((item) => safeStringify(item)).join(" ");
}

function isPlainObject(value) {
  if (Object.prototype.toString.call(value) !== "[object Object]") {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function formatKeyValue(obj) {
  return Object.entries(obj)
    .map(([key, val]) => `${key}=${safeStringify(val)}`)
    .join(" ");
}

function shouldPrefixLine(line) {
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(line)) {
    return false;
  }
  if (line.startsWith("time")) {
    return false;
  }
  return true;
}

function writeLogLine(line, isError) {
  const output = shouldPrefixLine(line) ? `${ts()} | ${line}` : line;
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

function pad(value, width) {
  const str = String(value);
  if (str.length >= width) {
    return str.slice(0, width);
  }
  return str.padEnd(width, " ");
}

function formatTableRow(row) {
  return [
    pad(row.time, 19),
    pad(row.mode, 6),
    pad(row.step, 6),
    pad(row.avg, 14),
    pad(row.px, 14),
    pad(row.move, 10),
    pad(row.stepPct, 9),
    pad(row.posSol, 10),
    pad(row.tradePnl, 10),
    pad(row.walletPnl, 10),
    pad(row.solBal, 10),
  ].join(" | ");
}

function formatSwapError(err) {
  const message = String(err?.message || err || "Unknown error");
  const codeMatch = message.match(/custom program error: (0x[0-9a-fA-F]+)/);
  if (codeMatch) {
    return `program error ${codeMatch[1]} (likely slippage/route)`;
  }
  const firstLine = message.split("\n")[0];
  return firstLine.slice(0, 200);
}

function buildUrls(pathSuffixes) {
  const base = JUP_BASE_URL.replace(/\/+$/, "");
  return pathSuffixes.map((suffix) => `${base}${suffix}`);
}

function buildFallbackUrls(primaryUrl, fallbackPaths) {
  if (primaryUrl) {
    return [primaryUrl];
  }
  return fallbackPaths;
}

async function fetchWithFallback(urls, label) {
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

    if (response.status !== 404) {
      throw new Error(`${label} failed: ${response.status} (${url})`);
    }
  }

  throw new Error(
    `${label} failed: endpoint not found (404). Tried: ${urls.join(", ")}`
  );
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
          ...(quote._swapOptions || {}),
        }),
      });
    } catch (err) {
      lastError = err;
      continue;
    }

    if (response.ok) {
      break;
    }

    if (response.status !== 404) {
      const body = await response.text();
      throw new Error(`Swap failed: ${response.status} ${body} (${url})`);
    }
  }

  if (!response || !response.ok) {
    if (lastError) {
      throw new Error(`Swap fetch failed: ${lastError.message || lastError}`);
    }
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

async function getTokenAccountBalanceInfo(connection, owner, mint) {
  const tokenAccounts = await connection.getTokenAccountsByOwner(
    owner,
    { mint },
    "confirmed"
  );

  if (!tokenAccounts.value.length) {
    return { amount: 0n, decimals: null };
  }

  const balances = await Promise.all(
    tokenAccounts.value.map((account) =>
      connection.getTokenAccountBalance(account.pubkey, "confirmed")
    )
  );
  const decimals = Number(balances[0].value.decimals);
  const amount = balances.reduce(
    (acc, balance) => acc + BigInt(balance.value.amount),
    0n
  );

  return {
    amount,
    decimals,
  };
}

async function executeSwap(connection, keypair, quote, confirmTimeoutMs) {
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

  const confirmed = await waitForSignature(
    connection,
    signature,
    confirmTimeoutMs
  );
  return { signature, confirmed };
}

function computeBps(numerator, denominator) {
  return (numerator * 10000n) / denominator;
}

async function waitForSignature(connection, signature, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    });
    const result = status && status.value && status.value[0];
    if (result) {
      if (result.confirmationStatus === "confirmed" || result.confirmationStatus === "finalized") {
        return true;
      }
      if (result.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(result.err)}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return false;
}

async function main() {
  if (!RPC_URL) {
    logError("Missing SOLANA_RPC_URL env var.");
    process.exit(1);
  }

  const wallets = loadWallets();
  if (!wallets.length) {
    logError("No wallets found. Run swap.js once to create a wallet.");
    process.exit(1);
  }

  const keypair = keypairFromEntry(wallets[0]);
  const connection = new Connection(RPC_URL, "confirmed");

  let tokenMint = process.env.TARGET_MINT || "";
  if (!tokenMint) {
    const prompt = createPrompt();
    tokenMint = await prompt.ask("Target token mint", "");
    prompt.close();
  }

  if (!tokenMint) {
    logError("Target token mint is required.");
    process.exit(1);
  }

  const stepSol = parseNumberList(
    process.env.STEP_SOL_AMOUNTS,
    DEFAULT_STEP_SOL
  );
  const stepPct = parseNumberList(process.env.STEP_SOL_PCT, null);
  const tradeAllocPct = Number(process.env.TRADE_ALLOC_PCT || 0);
  const stepDrawdown = parseNumberList(
    process.env.STEP_DRAWDOWN_PCT,
    DEFAULT_STEP_DRAWDOWN_PCT
  );
  const targetProfitBps = BigInt(
    Number(process.env.PROFIT_TARGET_BPS || DEFAULT_PROFIT_BPS)
  );
  const pollMs = Number(process.env.POLL_MS || DEFAULT_POLL_MS);
  const priceSampleSol = Number(
    process.env.PRICE_SAMPLE_SOL || DEFAULT_PRICE_SAMPLE_SOL
  );
  const entryDropPct = Number(
    process.env.ENTRY_DROP_PCT || DEFAULT_ENTRY_DROP_PCT
  );
  const buySlippageBps = Number(
    process.env.BUY_SLIPPAGE_BPS || DEFAULT_BUY_SLIPPAGE_BPS
  );
  const sellSlippageBps = Number(
    process.env.SELL_SLIPPAGE_BPS || DEFAULT_SELL_SLIPPAGE_BPS
  );
  const buySlippageStepBps = Number(
    process.env.BUY_SLIPPAGE_STEP_BPS || DEFAULT_BUY_SLIPPAGE_STEP_BPS
  );
  const buySlippageCapBps = Number(
    process.env.BUY_SLIPPAGE_CAP_BPS || DEFAULT_BUY_SLIPPAGE_CAP_BPS
  );
  const sellPriorityFeeLamports = BigInt(
    process.env.SELL_PRIORITY_FEE_LAMPORTS || DEFAULT_SELL_PRIORITY_FEE_LAMPORTS
  );
  const sellPriorityFeeStepLamports = BigInt(
    process.env.SELL_PRIORITY_FEE_STEP_LAMPORTS ||
      DEFAULT_SELL_PRIORITY_FEE_STEP_LAMPORTS
  );
  const sellPriorityFeeCapLamports = BigInt(
    process.env.SELL_PRIORITY_FEE_CAP_LAMPORTS ||
      DEFAULT_SELL_PRIORITY_FEE_CAP_LAMPORTS
  );
  const buyPriorityFeeLamports = BigInt(
    process.env.BUY_PRIORITY_FEE_LAMPORTS || DEFAULT_BUY_PRIORITY_FEE_LAMPORTS
  );
  const sellSlippageStepBps = Number(
    process.env.SELL_SLIPPAGE_STEP_BPS || DEFAULT_SELL_SLIPPAGE_STEP_BPS
  );
  const sellSlippageCapBps = Number(
    process.env.SELL_SLIPPAGE_CAP_BPS || DEFAULT_SELL_SLIPPAGE_CAP_BPS
  );
  const sellPnlLogPath =
    process.env.SELL_PNL_LOG_PATH || DEFAULT_SELL_PNL_LOG;
  const confirmTimeoutMs = Number(
    process.env.CONFIRM_TIMEOUT_MS || DEFAULT_CONFIRM_TIMEOUT_MS
  );
  const profitConfirmTicks = Number(
    process.env.PROFIT_CONFIRM_TICKS || DEFAULT_PROFIT_CONFIRM_TICKS
  );
  const trailStartBps = BigInt(
    Math.round(
      Number(process.env.TRAILING_START_PCT || DEFAULT_TRAIL_START_PCT) * 100
    )
  );
  const trailGapBps = BigInt(
    Math.round(
      Number(process.env.TRAILING_GAP_PCT || DEFAULT_TRAIL_GAP_PCT) * 100
    )
  );
  const trailMinProfitBps = BigInt(
    Math.round(
      Number(
        process.env.TRAILING_MIN_PROFIT_PCT || DEFAULT_TRAIL_MIN_PROFIT_PCT
      ) * 100
    )
  );

  logInfo("LOG settings", {
    file: LOG_FILE,
    console: LOG_TO_CONSOLE ? "on" : "off",
  });

  let state = readState();
  if (!state || state.tokenMint !== tokenMint) {
    state = {
      tokenMint,
      mode: "in_position",
      stepIndex: 0,
      totalSolSpentLamports: "0",
      totalTokenAmount: "0",
      tokenDecimals: null,
      referencePriceScaled: null,
    };
    writeState(state);
  }
  if (!state.mode) {
    state.mode = "in_position";
  }
  if (state.done) {
    state.mode = "waiting_entry";
    state.done = false;
  }
  if (state.entryHighScaled === undefined) {
    state.entryHighScaled = null;
  }
  if (state.buySlippageBps === undefined) {
    state.buySlippageBps = null;
  }
  if (state.sellSlippageBps === undefined) {
    state.sellSlippageBps = null;
  }
  if (state.sellPriorityFeeLamports === undefined) {
    state.sellPriorityFeeLamports = null;
  }
  if (state.profitStreak === undefined) {
    state.profitStreak = 0;
  }
  if (state.trailPeakBps === undefined) {
    state.trailPeakBps = null;
  }
  state.startPriceScaled = null;
  state.startSolBalanceLamports = null;
  state.sessionStartTs = ts();

  const mintPubkey = new PublicKey(tokenMint);
  const sessionStartBalance = await connection.getBalance(
    keypair.publicKey,
    "confirmed"
  );
  state.startSolBalanceLamports = sessionStartBalance.toString();
  writeState(state);

  function computeStepLamports(balanceLamports) {
    let lamports = stepSol.map(lamportsFromSol);
    if (stepPct && tradeAllocPct > 0) {
      const allocLamports =
        (balanceLamports * BigInt(Math.round(tradeAllocPct * 100))) / 10000n;
      lamports = stepPct.map(
        (pct) => (allocLamports * BigInt(Math.round(pct * 100))) / 10000n
      );
      const pctTotal = sumNumbers(stepPct);
      logInfo("CONFIG step pct", {
        steps: stepPct.join(","),
        totalPct: pctTotal,
        allocPct: tradeAllocPct,
        allocSol: formatSolFromLamports(allocLamports),
      });
    }
    return lamports;
  }

  let stepLamports = computeStepLamports(BigInt(sessionStartBalance));

  if (stepLamports.length !== stepDrawdown.length) {
    logError("Step amounts length does not match STEP_DRAWDOWN_PCT length.");
    process.exit(1);
  }

  logInfo("CONFIG trade", {
    token: tokenMint,
    steps: stepLamports.map((lamports) => formatSolFromLamports(lamports)).join(","),
    drawdown: `${stepDrawdown.join(",")}%`,
    profit: formatPctFromBps(targetProfitBps),
    pollMs,
    entryDropPct,
  });
  logInfo("CONFIG execution", {
    buySlipBps: buySlippageBps,
    sellSlipBps: sellSlippageBps,
    buyFee: buyPriorityFeeLamports.toString(),
    sellFee: sellPriorityFeeLamports.toString(),
    trail: `${formatPctFromBps(trailStartBps)}/${formatPctFromBps(trailGapBps)}/${formatPctFromBps(trailMinProfitBps)}`,
  });

  let lineCount = 0;
  function printHeader() {
    console.log(
      [
        pad("time", 19),
        pad("mode", 6),
        pad("step", 6),
        pad("avg", 14),
        pad("px", 14),
        pad("move", 10),
        pad("step%", 9),
        pad("pos_sol", 10),
        pad("trade_pnl", 10),
        pad("wallet_pnl", 10),
        pad("sol_bal", 10),
      ].join(" | ")
    );
  }

  function printRow(row) {
    if (lineCount % 20 === 0) {
      printHeader();
    }
    console.log(formatTableRow(row));
    lineCount += 1;
  }

  async function refreshTokenAmount() {
    const info = await getTokenAccountBalanceInfo(
      connection,
      keypair.publicKey,
      mintPubkey
    );
    state.totalTokenAmount = info.amount.toString();
    if (info.decimals !== null) {
      state.tokenDecimals = info.decimals;
    }
    writeState(state);
    return info.amount;
  }

  async function doBuy(stepIndex, fromEntry = false) {
    const lamports = stepLamports[stepIndex];
    const solAmountDisplay = formatSolFromLamports(lamports);

    const solBalance = await connection.getBalance(
      keypair.publicKey,
      "confirmed"
    );
    if (BigInt(solBalance) < lamports + 5000n) {
      logWarn("Insufficient SOL for step", {
        step: stepIndex + 1,
        balanceLamports: solBalance,
        needLamports: lamports.toString(),
      });
      return false;
    }

    const beforeTokens = await getTokenAccountBalanceInfo(
      connection,
      keypair.publicKey,
      mintPubkey
    );
    const beforeSol = BigInt(solBalance);
    const effectiveBuySlippageBps =
      state.buySlippageBps !== null && state.buySlippageBps !== undefined
        ? Number(state.buySlippageBps)
        : buySlippageBps;

    logInfo("BUY start", {
      step: stepIndex + 1,
      sol: solAmountDisplay,
      slippageBps: effectiveBuySlippageBps,
    });
    const quote = await fetchQuote(
      SOL_MINT,
      tokenMint,
      lamports,
      effectiveBuySlippageBps
    );
    if (buyPriorityFeeLamports > 0n) {
      quote._swapOptions = {
        prioritizationFeeLamports: Number(buyPriorityFeeLamports),
      };
    }
    let result;
    try {
      result = await executeSwap(connection, keypair, quote, confirmTimeoutMs);
    } catch (err) {
      logWarn("BUY failed", {
        error: formatSwapError(err),
        slippageBps: effectiveBuySlippageBps,
      });
      const nextBps = Math.min(
        effectiveBuySlippageBps + buySlippageStepBps,
        buySlippageCapBps
      );
      state.buySlippageBps = nextBps;
      writeState(state);
      if (fromEntry) {
        state.mode = "waiting_entry";
        writeState(state);
      }
      return false;
    }
    if (result.confirmed) {
      logInfo("BUY confirmed", { signature: result.signature });
    } else {
      logWarn("BUY sent but not confirmed in time", {
        signature: result.signature,
      });
    }

    const afterTokens = await refreshTokenAmount();
    const afterSol = BigInt(
      await connection.getBalance(keypair.publicKey, "confirmed")
    );
    if (afterTokens <= beforeTokens.amount) {
      if (afterSol >= beforeSol - 5000n) {
        logWarn("BUY failed: SOL balance unchanged, retrying with higher slippage", {
          slippageBps: effectiveBuySlippageBps,
        });
        const nextBps = Math.min(
          effectiveBuySlippageBps + buySlippageStepBps,
          buySlippageCapBps
        );
        state.buySlippageBps = nextBps;
        writeState(state);
        if (fromEntry) {
          state.mode = "waiting_entry";
          writeState(state);
        }
        return false;
      }
      logWarn("BUY pending: SOL spent but tokens not seen yet");
      if (fromEntry) {
        state.mode = "waiting_entry";
        writeState(state);
      }
      return false;
    }

    const actualSpent = beforeSol > afterSol ? beforeSol - afterSol : lamports;
    state.totalSolSpentLamports = (
      BigInt(state.totalSolSpentLamports) + actualSpent
    ).toString();
    state.stepIndex = stepIndex + 1;
    state.buySlippageBps = buySlippageBps;
    writeState(state);
    return true;
  }

  async function doSell(reason, currentPriceScaled, slippageOverrideBps) {
    const tokenAmount = BigInt(state.totalTokenAmount);
    if (tokenAmount <= 0n) {
      logWarn("No tokens to sell");
      return false;
    }

    const beforeTokens = await refreshTokenAmount();
    const beforeSol = BigInt(
      await connection.getBalance(keypair.publicKey, "confirmed")
    );
    const effectiveSellPriorityFeeLamports =
      state.sellPriorityFeeLamports !== null &&
      state.sellPriorityFeeLamports !== undefined
        ? BigInt(state.sellPriorityFeeLamports)
        : sellPriorityFeeLamports;
    logInfo("SELL start", {
      reason,
      tokens: beforeTokens.toString(),
      slippageBps: slippageOverrideBps ?? "auto",
      priorityFee: effectiveSellPriorityFeeLamports.toString(),
    });
    const effectiveSellSlippageBps =
      state.sellSlippageBps !== null && state.sellSlippageBps !== undefined
        ? Number(state.sellSlippageBps)
        : sellSlippageBps;
    const slippageBps =
      slippageOverrideBps !== undefined
        ? slippageOverrideBps
        : effectiveSellSlippageBps;
    const quote = await fetchQuote(
      tokenMint,
      SOL_MINT,
      tokenAmount,
      slippageBps
    );
    logInfo("SELL quote", {
      inAmount: tokenAmount.toString(),
      outAmount: quote.outAmount,
      priceImpact: quote.priceImpactPct ?? "n/a",
    });
    const estOutLamports = BigInt(quote.outAmount);
    const totalSpentLamports = BigInt(state.totalSolSpentLamports || "0");
    const estProfitLamports =
      estOutLamports - totalSpentLamports - effectiveSellPriorityFeeLamports;
    if (estProfitLamports < 0n) {
      logWarn("SELL blocked: estimated loss", {
        estPnl: formatSolFromLamports(estProfitLamports),
        spent: formatSolFromLamports(totalSpentLamports),
        out: formatSolFromLamports(estOutLamports),
      });
      return false;
    }
    if (effectiveSellPriorityFeeLamports > 0n) {
      quote._swapOptions = {
        prioritizationFeeLamports: Number(effectiveSellPriorityFeeLamports),
      };
    }
    let result;
    try {
      result = await executeSwap(connection, keypair, quote, confirmTimeoutMs);
    } catch (err) {
      logWarn("SELL failed", {
        error: formatSwapError(err),
        slippageBps: slippageBps,
      });
      const nextBps = Math.min(
        effectiveSellSlippageBps + sellSlippageStepBps,
        sellSlippageCapBps
      );
      state.sellSlippageBps = nextBps;
      if (sellPriorityFeeCapLamports > 0n) {
        const nextPriority =
          effectiveSellPriorityFeeLamports + sellPriorityFeeStepLamports;
        state.sellPriorityFeeLamports =
          nextPriority > sellPriorityFeeCapLamports
            ? sellPriorityFeeCapLamports.toString()
            : nextPriority.toString();
      }
      writeState(state);
      return false;
    }
    if (result.confirmed) {
      logInfo("SELL confirmed", { signature: result.signature });
    } else {
      logWarn("SELL sent but not confirmed in time", {
        signature: result.signature,
      });
    }
    const afterTokens = await refreshTokenAmount();
    const afterSol = BigInt(
      await connection.getBalance(keypair.publicKey, "confirmed")
    );
    logInfo("SELL balance", {
      tokensBefore: beforeTokens.toString(),
      tokensAfter: afterTokens.toString(),
      solBefore: beforeSol.toString(),
      solAfter: afterSol.toString(),
    });
    const tokenDecreased = afterTokens < beforeTokens;
    const solIncreased = afterSol > beforeSol + 5000n;
    if (!tokenDecreased && !solIncreased) {
      logWarn("SELL failed or pending: balances unchanged", {
        tokensBefore: beforeTokens.toString(),
        tokensAfter: afterTokens.toString(),
        solBefore: beforeSol.toString(),
        solAfter: afterSol.toString(),
      });
      return false;
    }
    if (afterTokens > 0n) {
      logWarn("SELL partial: remaining tokens, staying in position", {
        remainingTokens: afterTokens.toString(),
      });
      state.totalTokenAmount = afterTokens.toString();
      writeState(state);
      return false;
    }
    try {
      const solDelta = afterSol - beforeSol;
      const totalSpent = BigInt(state.totalSolSpentLamports || "0");
      const realizedPnlLamports = solDelta - totalSpent;
      const realizedPnlPct =
        totalSpent > 0n
          ? Number(realizedPnlLamports) / Number(totalSpent)
          : 0;
      const line = `${ts()} | pct ${(realizedPnlPct * 100).toFixed(
        2
      )}% | pnl ${formatSolFromLamports(
        realizedPnlLamports
      )} | spent ${formatSolFromLamports(totalSpent)}\n`;
      fs.appendFileSync(sellPnlLogPath, line, "utf8");
    } catch (err) {
      logWarn("SELL pnl log failed", { error: err.message || err });
    }
    state.stepIndex = 0;
    state.totalSolSpentLamports = "0";
    state.totalTokenAmount = "0";
    state.mode = "waiting_entry";
    state.referencePriceScaled = currentPriceScaled.toString();
    state.sellSlippageBps = sellSlippageBps;
    state.sellPriorityFeeLamports = null;
    state.trailPeakBps = null;
    stepLamports = computeStepLamports(afterSol);
    writeState(state);
    return true;
  }

  while (true) {
    try {
    if (state.mode === "in_position") {
      const totalSolSpent = BigInt(state.totalSolSpentLamports);
      const tokenAmount = await refreshTokenAmount();
      if (tokenAmount === 0n && totalSolSpent === 0n) {
        logInfo("POS empty position. Switching to entry mode.");
        state.mode = "waiting_entry";
        state.entryHighScaled = null;
        writeState(state);
      }
    }

    if (state.mode === "waiting_entry") {
      const sampleLamports = lamportsFromSol(priceSampleSol);
      const priceQuote = await fetchQuote(
        SOL_MINT,
        tokenMint,
        sampleLamports,
        buySlippageBps
      );
      const outAmountRaw = BigInt(priceQuote.outAmount);
      if (outAmountRaw === 0n) {
        printRow({
          time: ts(),
          mode: "WAIT",
          step: "-",
          avg: "-",
          px: "-",
        move: "0.00%",
        stepPct: "--",
        posSol: "0.000000",
        tradePnl: "0.000000",
        walletPnl: "0.000000",
        solBal: "0.000000",
        });
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        continue;
      }

      const currentPriceScaled = (sampleLamports * PRICE_SCALE) / outAmountRaw;
      if (!state.startPriceScaled) {
        state.startPriceScaled = currentPriceScaled.toString();
        writeState(state);
      }
      let entryHighScaled = state.entryHighScaled
        ? BigInt(state.entryHighScaled)
        : currentPriceScaled;

      if (currentPriceScaled > entryHighScaled) {
        entryHighScaled = currentPriceScaled;
        state.entryHighScaled = entryHighScaled.toString();
        writeState(state);
      } else if (!state.entryHighScaled) {
        state.entryHighScaled = entryHighScaled.toString();
        writeState(state);
      }

      const dropBps = computeBps(
        entryHighScaled - currentPriceScaled,
        entryHighScaled
      );
      const overallBps = state.startPriceScaled
        ? computeBps(
            currentPriceScaled - BigInt(state.startPriceScaled),
            BigInt(state.startPriceScaled)
          )
        : 0n;
      const entryDropBps = BigInt(Math.round(entryDropPct * 100));

      const solBalLamports = BigInt(
        await connection.getBalance(keypair.publicKey, "confirmed")
      );
      const startSol = state.startSolBalanceLamports
        ? BigInt(state.startSolBalanceLamports)
        : solBalLamports;
      const walletPnl = solBalLamports - startSol;
      printRow({
        time: ts(),
        mode: "WAIT",
        step: "-",
        avg: "-",
        px: "-",
        move: `${formatPctFromBps(dropBps)}|${formatPctFromBps(entryDropBps)}`,
        stepPct: formatPctFromBps(entryDropBps),
        posSol: "0.000000",
        tradePnl: "0.000000",
        walletPnl: formatSolFromLamports(walletPnl),
        solBal: formatSolFromLamports(solBalLamports),
      });

      if (dropBps >= entryDropBps) {
        await refreshTokenAmount();
        const bought = await doBuy(0, true);
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        if (bought) {
          state.mode = "in_position";
          state.entryHighScaled = null;
          writeState(state);
        } else {
          logWarn("BUY step 1 will retry on next tick.");
        }
      }

      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }

    const totalSolSpent = BigInt(state.totalSolSpentLamports);
    const totalTokens = await refreshTokenAmount();

    if (state.stepIndex === 0 && totalSolSpent === 0n) {
      const bought = await doBuy(0);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      if (!bought) {
        logWarn("BUY step 1 will retry on next tick.");
      }
      continue;
    }

    if (totalSolSpent === 0n || totalTokens === 0n) {
      if (totalTokens === 0n) {
        const solBal = await connection.getBalance(
          keypair.publicKey,
          "confirmed"
        );
        if (BigInt(solBal) >= totalSolSpent) {
          logInfo("POS waiting: no tokens and no SOL spent. Resetting to entry mode.");
          state.mode = "waiting_entry";
          state.entryHighScaled = null;
          state.stepIndex = 0;
          state.totalSolSpentLamports = "0";
          writeState(state);
          await new Promise((resolve) => setTimeout(resolve, pollMs));
          continue;
        }
      }
      const solBalLamports = BigInt(
        await connection.getBalance(keypair.publicKey, "confirmed")
      );
      const startSol = state.startSolBalanceLamports
        ? BigInt(state.startSolBalanceLamports)
        : solBalLamports;
      const walletPnl = solBalLamports - startSol;
      printRow({
        time: ts(),
        mode: "POS",
        step: `${state.stepIndex}/${stepLamports.length}`,
        avg: "-",
        px: "-",
        move: "pending",
        stepPct:
          state.stepIndex < stepLamports.length
            ? `${stepDrawdown[state.stepIndex].toFixed(2)}%`
            : "--",
        posSol: "0.000000",
        tradePnl: "0.000000",
        walletPnl: formatSolFromLamports(walletPnl),
        solBal: formatSolFromLamports(solBalLamports),
      });
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }

    const sampleLamports = lamportsFromSol(priceSampleSol);
    const priceQuote = await fetchQuote(
      SOL_MINT,
      tokenMint,
      sampleLamports,
      buySlippageBps
    );
    const outAmountRaw = BigInt(priceQuote.outAmount);
    if (outAmountRaw === 0n) {
      logWarn("Price quote returned 0 output. Waiting...");
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }

    const currentPriceScaled = (sampleLamports * PRICE_SCALE) / outAmountRaw;
    if (!state.startPriceScaled) {
      state.startPriceScaled = currentPriceScaled.toString();
      writeState(state);
    }
    const avgCostScaled = (totalSolSpent * PRICE_SCALE) / totalTokens;

    const drawdownBps = computeBps(
      avgCostScaled - currentPriceScaled,
      avgCostScaled
    );

    let avgDisplay = `${avgCostScaled.toString()} scaled/raw`;
    let currentDisplay = `${currentPriceScaled.toString()} scaled/raw`;
    if (typeof state.tokenDecimals === "number") {
      const factor = 10n ** BigInt(state.tokenDecimals);
      const avgLamportsPerToken = (avgCostScaled * factor) / PRICE_SCALE;
      const currentLamportsPerToken =
        (currentPriceScaled * factor) / PRICE_SCALE;
      avgDisplay = `${formatSolFromLamports(avgLamportsPerToken)} SOL/token`;
      currentDisplay = `${formatSolFromLamports(
        currentLamportsPerToken
      )} SOL/token`;
    }

    if (state.stepIndex < stepLamports.length) {
      const triggerBps = BigInt(
        Math.round(stepDrawdown[state.stepIndex] * 100)
      );
      if (drawdownBps >= triggerBps) {
        const bought = await doBuy(state.stepIndex);
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        if (!bought) {
          logWarn("BUY step will retry on next tick", {
            step: state.stepIndex + 1,
          });
        }
        continue;
      }
    }

    const sellQuote = await fetchQuote(
      tokenMint,
      SOL_MINT,
      totalTokens,
      sellSlippageBps
    );
    const estSolOut = BigInt(sellQuote.outAmount);
    const effectiveSellPriorityFeeLamports =
      state.sellPriorityFeeLamports !== null &&
      state.sellPriorityFeeLamports !== undefined
        ? BigInt(state.sellPriorityFeeLamports)
        : sellPriorityFeeLamports;
    const priorityCost = effectiveSellPriorityFeeLamports;
    const profitBps = computeBps(
      estSolOut - totalSolSpent - priorityCost,
      totalSolSpent
    );
    const profitLamports = estSolOut - totalSolSpent - priorityCost;
    const overallBps = state.startPriceScaled
      ? computeBps(
          currentPriceScaled - BigInt(state.startPriceScaled),
          BigInt(state.startPriceScaled)
        )
      : 0n;

    const solBalLamports = BigInt(
      await connection.getBalance(keypair.publicKey, "confirmed")
    );
    const startSol = state.startSolBalanceLamports
      ? BigInt(state.startSolBalanceLamports)
      : solBalLamports;
    const walletValue = solBalLamports + estSolOut;
    const walletPnl = walletValue - startSol;
    printRow({
      time: ts(),
      mode: "POS",
      step: `${state.stepIndex}/${stepLamports.length}`,
      avg: avgDisplay.replace(" SOL/token", ""),
      px: currentDisplay.replace(" SOL/token", ""),
      move: formatPctFromBps(drawdownBps),
      stepPct:
        state.stepIndex < stepLamports.length
          ? `${stepDrawdown[state.stepIndex].toFixed(2)}%`
          : "--",
      posSol: formatSolFromLamports(estSolOut),
      tradePnl: formatSolFromLamports(profitLamports),
      walletPnl: formatSolFromLamports(walletPnl),
      solBal: formatSolFromLamports(solBalLamports),
    });

    if (profitBps >= targetProfitBps) {
      state.profitStreak = Number(state.profitStreak || 0) + 1;
      writeState(state);
    } else {
      state.profitStreak = 0;
      writeState(state);
    }

    const trailArmed =
      profitBps >= trailStartBps || state.trailPeakBps !== null;
    if (trailArmed) {
      if (
        state.trailPeakBps === null ||
        profitBps > BigInt(state.trailPeakBps)
      ) {
        state.trailPeakBps = profitBps.toString();
        writeState(state);
        logInfo("TRAIL peak updated", {
          peak: formatPctFromBps(BigInt(state.trailPeakBps)),
        });
      }
      const trailStopBps = BigInt(state.trailPeakBps) - trailGapBps;
      if (profitBps <= trailStopBps && profitBps >= trailMinProfitBps) {
        await doSell("trailing stop hit", currentPriceScaled, sellSlippageBps);
        continue;
      }
      logInfo("TRAIL check", {
        profit: formatPctFromBps(profitBps),
        peak: formatPctFromBps(BigInt(state.trailPeakBps)),
        stop: formatPctFromBps(trailStopBps),
        min: formatPctFromBps(trailMinProfitBps),
      });
    } else {
      logInfo("TRAIL idle", {
        profit: formatPctFromBps(profitBps),
        start: formatPctFromBps(trailStartBps),
      });
    }

    if (state.profitStreak >= profitConfirmTicks) {
      logInfo("PROFIT confirm", {
        streak: state.profitStreak,
        target: formatPctFromBps(targetProfitBps),
      });
      const confirmQuote = await fetchQuote(
        tokenMint,
        SOL_MINT,
        totalTokens,
        sellSlippageBps
      );
      const confirmOut = BigInt(confirmQuote.outAmount);
      const confirmProfitBps = computeBps(
        confirmOut - totalSolSpent - effectiveSellPriorityFeeLamports,
        totalSolSpent
      );
      logInfo("PROFIT confirm quote", {
        est: formatPctFromBps(confirmProfitBps),
        out: confirmOut.toString(),
      });

      if (confirmProfitBps >= targetProfitBps) {
        await doSell("profit target hit", currentPriceScaled, sellSlippageBps);
      } else {
        logWarn("PROFIT confirm failed", {
          est: formatPctFromBps(confirmProfitBps),
          target: formatPctFromBps(targetProfitBps),
        });
      }
      continue;
    }


    await new Promise((resolve) => setTimeout(resolve, pollMs));
    } catch (err) {
      logError("Loop error", { error: err.message || err });
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}

main().catch((err) => {
  logError("Bot failed", { error: err.message || err });
  process.exit(1);
});
