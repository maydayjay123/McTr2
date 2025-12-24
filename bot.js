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
const DEFAULT_HARD_STOP_BPS = -5000;
const DEFAULT_POLL_MS = 5000;
const DEFAULT_PRICE_SAMPLE_SOL = 0.01;
const DEFAULT_ENTRY_DROP_PCT = 4.5;
const DEFAULT_BUY_SLIPPAGE_BPS = 50;
const DEFAULT_SELL_SLIPPAGE_BPS = 50;
const DEFAULT_BUY_SLIPPAGE_STEP_BPS = 25;
const DEFAULT_BUY_SLIPPAGE_CAP_BPS = 500;
const DEFAULT_SELL_PRIORITY_FEE_LAMPORTS = 0;
const DEFAULT_BUY_PRIORITY_FEE_LAMPORTS = 0;
const DEFAULT_SELL_SLIPPAGE_STEP_BPS = 25;
const DEFAULT_SELL_SLIPPAGE_CAP_BPS = 500;
const DEFAULT_CONFIRM_TIMEOUT_MS = 120000;
const DEFAULT_PROFIT_CONFIRM_TICKS = 2;
const DEFAULT_TRAIL_START_PCT = 8;
const DEFAULT_TRAIL_GAP_PCT = 4;
const DEFAULT_TRAIL_MIN_PROFIT_PCT = 3;
const DEFAULT_SELL_PNL_LOG = "sell_pnl.log";
const PRICE_SCALE = 1_000_000_000n;

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
  for (const url of urls) {
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

    if (response.ok) {
      break;
    }

    if (response.status !== 404) {
      const body = await response.text();
      throw new Error(`Swap failed: ${response.status} ${body} (${url})`);
    }
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

async function getTokenAccountBalanceInfo(connection, owner, mint) {
  const tokenAccounts = await connection.getTokenAccountsByOwner(
    owner,
    { mint },
    "confirmed"
  );

  if (!tokenAccounts.value.length) {
    return { amount: 0n, decimals: null };
  }

  const tokenBalance = await connection.getTokenAccountBalance(
    tokenAccounts.value[0].pubkey,
    "confirmed"
  );

  return {
    amount: BigInt(tokenBalance.value.amount),
    decimals: Number(tokenBalance.value.decimals),
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
    console.error("Missing SOLANA_RPC_URL env var.");
    process.exit(1);
  }

  const wallets = loadWallets();
  if (!wallets.length) {
    console.error("No wallets found. Run swap.js once to create a wallet.");
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
    console.error("Target token mint is required.");
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
  const hardStopBps = BigInt(
    Number(process.env.HARD_STOP_BPS || DEFAULT_HARD_STOP_BPS)
  );
  const pollMs = Number(process.env.POLL_MS || DEFAULT_POLL_MS);
  const priceSampleSol = Number(
    process.env.PRICE_SAMPLE_SOL || DEFAULT_PRICE_SAMPLE_SOL
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
  if (!state.entryHighScaled) {
    state.entryHighScaled = null;
  }
  if (!state.buySlippageBps) {
    state.buySlippageBps = null;
  }
  if (!state.sellSlippageBps) {
    state.sellSlippageBps = null;
  }
  if (!state.profitStreak) {
    state.profitStreak = 0;
  }
  if (!state.trailPeakBps) {
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
      console.log(
        `${ts()} | CONFIG step pct ${stepPct.join(
          ","
        )} (total ${pctTotal}%) | alloc ${tradeAllocPct}% -> ${formatSolFromLamports(
          allocLamports
        )} SOL`
      );
    }
    return lamports;
  }

  let stepLamports = computeStepLamports(BigInt(sessionStartBalance));

  if (stepLamports.length !== stepDrawdown.length) {
    console.error(
      "Step amounts length does not match STEP_DRAWDOWN_PCT length."
    );
    process.exit(1);
  }

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
      console.log(
        `Insufficient SOL for step ${stepIndex + 1}. Balance ${solBalance} lamports, need ${lamports.toString()}.`
      );
      return false;
    }

    const beforeTokens = await getTokenAccountBalanceInfo(
      connection,
      keypair.publicKey,
      mintPubkey
    );
    const beforeSol = BigInt(solBalance);
    const effectiveBuySlippageBps = state.buySlippageBps
      ? Number(state.buySlippageBps)
      : buySlippageBps;

    console.log(
      `${ts()} | BUY step ${stepIndex + 1}: ${solAmountDisplay} SOL`
    );
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
      console.log(
        `${ts()} | BUY failed: ${formatSwapError(
          err
        )} | slippage ${effectiveBuySlippageBps} bps`
      );
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
      console.log(`${ts()} | BUY confirmed: ${result.signature}`);
    } else {
      console.log(
        `${ts()} | BUY sent but not confirmed in time: ${result.signature}. Checking balance...`
      );
    }

    const afterTokens = await refreshTokenAmount();
    const afterSol = BigInt(
      await connection.getBalance(keypair.publicKey, "confirmed")
    );
    if (afterTokens <= beforeTokens.amount) {
      if (afterSol >= beforeSol - 5000n) {
        console.log(
          `${ts()} | BUY failed: SOL balance unchanged. Will retry with higher slippage.`
        );
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
      console.log(
        `${ts()} | BUY pending: SOL spent but tokens not seen yet.`
      );
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
      console.log("No tokens to sell.");
      return false;
    }

    const beforeTokens = await refreshTokenAmount();
    const beforeSol = BigInt(
      await connection.getBalance(keypair.publicKey, "confirmed")
    );
    console.log(
      `${ts()} | SELL start | reason ${reason} | tokens ${beforeTokens.toString()} | slippage ${slippageOverrideBps ?? "auto"} bps | priority ${sellPriorityFeeLamports.toString()}`
    );
    const effectiveSellSlippageBps = state.sellSlippageBps
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
    console.log(
      `${ts()} | SELL quote | in ${tokenAmount.toString()} | out ${quote.outAmount} | priceImpact ${quote.priceImpactPct ?? "n/a"}`
    );
    if (sellPriorityFeeLamports > 0n) {
      quote._swapOptions = {
        prioritizationFeeLamports: Number(sellPriorityFeeLamports),
      };
    }
    let result;
    try {
      result = await executeSwap(connection, keypair, quote, confirmTimeoutMs);
    } catch (err) {
      console.log(
        `${ts()} | SELL failed: ${formatSwapError(
          err
        )} | slippage ${slippageBps} bps`
      );
      const nextBps = Math.min(
        effectiveSellSlippageBps + sellSlippageStepBps,
        sellSlippageCapBps
      );
      state.sellSlippageBps = nextBps;
      writeState(state);
      return false;
    }
    if (result.confirmed) {
      console.log(`${ts()} | SELL confirmed: ${result.signature}`);
    } else {
      console.log(
        `${ts()} | SELL sent but not confirmed in time: ${result.signature}. Checking balance...`
      );
    }
    const afterTokens = await refreshTokenAmount();
    const afterSol = BigInt(
      await connection.getBalance(keypair.publicKey, "confirmed")
    );
    console.log(
      `${ts()} | SELL balance | tokens ${beforeTokens.toString()} -> ${afterTokens.toString()} | sol ${beforeSol.toString()} -> ${afterSol.toString()}`
    );
    const tokenDecreased = afterTokens < beforeTokens;
    const solIncreased = afterSol > beforeSol + 5000n;
    if (!tokenDecreased && !solIncreased) {
      console.log(
        `${ts()} | SELL failed or pending: balances unchanged. tokens ${beforeTokens.toString()} -> ${afterTokens.toString()}, sol ${beforeSol.toString()} -> ${afterSol.toString()}`
      );
      return false;
    }
    if (afterTokens > 0n) {
      console.log(
        `${ts()} | SELL partial: remaining tokens ${afterTokens.toString()}. Staying in position.`
      );
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
      console.log(`${ts()} | SELL pnl log failed: ${err.message || err}`);
    }
    state.stepIndex = 0;
    state.totalSolSpentLamports = "0";
    state.totalTokenAmount = "0";
    state.mode = "waiting_entry";
    state.referencePriceScaled = currentPriceScaled.toString();
    state.sellSlippageBps = sellSlippageBps;
    state.trailPeakBps = null;
    stepLamports = computeStepLamports(afterSol);
    writeState(state);
    return true;
  }

  while (true) {
    if (state.mode === "in_position") {
      const totalSolSpent = BigInt(state.totalSolSpentLamports);
      const tokenAmount = await refreshTokenAmount();
      if (tokenAmount === 0n && totalSolSpent === 0n) {
        console.log(`${ts()} | POS empty position. Switching to entry mode.`);
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
      const entryDropBps = BigInt(
        Math.round(
          Number(process.env.ENTRY_DROP_PCT || DEFAULT_ENTRY_DROP_PCT) * 100
        )
      );

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
          console.log(`${ts()} | BUY step 1 will retry on next tick.`);
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
        console.log(`${ts()} | BUY step 1 will retry on next tick.`);
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
          console.log(
            `${ts()} | POS waiting: no tokens and no SOL spent. Resetting to entry mode.`
          );
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
        step: `${state.stepIndex}/${stepSol.length}`,
        avg: "-",
        px: "-",
        move: "pending",
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
      console.log("Price quote returned 0 output. Waiting...");
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

    if (state.stepIndex < stepSol.length) {
      const triggerBps = BigInt(stepDrawdown[state.stepIndex] * 100);
      if (drawdownBps >= triggerBps) {
        const bought = await doBuy(state.stepIndex);
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        if (!bought) {
          console.log(
            `${ts()} | BUY step ${state.stepIndex + 1} will retry on next tick.`
          );
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
    const priorityCost = sellPriorityFeeLamports;
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
      step: `${state.stepIndex}/${stepSol.length}`,
      avg: avgDisplay.replace(" SOL/token", ""),
      px: currentDisplay.replace(" SOL/token", ""),
      move: formatPctFromBps(drawdownBps),
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

    if (profitBps >= trailStartBps) {
      if (
        state.trailPeakBps === null ||
        profitBps > BigInt(state.trailPeakBps)
      ) {
        state.trailPeakBps = profitBps.toString();
        writeState(state);
        console.log(
          `${ts()} | TRAIL peak updated | peak ${formatPctFromBps(
            BigInt(state.trailPeakBps)
          )}`
        );
      }
      const trailStopBps = BigInt(state.trailPeakBps) - trailGapBps;
      if (profitBps <= trailStopBps && profitBps >= trailMinProfitBps) {
        await doSell("trailing stop hit", currentPriceScaled, sellSlippageBps);
        continue;
      }
      console.log(
        `${ts()} | TRAIL check | profit ${formatPctFromBps(
          profitBps
        )} | peak ${formatPctFromBps(
          BigInt(state.trailPeakBps)
        )} | stop ${formatPctFromBps(trailStopBps)} | min ${formatPctFromBps(
          trailMinProfitBps
        )}`
      );
    } else {
      console.log(
        `${ts()} | TRAIL idle | profit ${formatPctFromBps(
          profitBps
        )} | start ${formatPctFromBps(trailStartBps)}`
      );
    }

    if (state.profitStreak >= profitConfirmTicks) {
      console.log(
        `${ts()} | PROFIT confirm | streak ${state.profitStreak} | target ${formatPctFromBps(
          targetProfitBps
        )}`
      );
      const confirmQuote = await fetchQuote(
        tokenMint,
        SOL_MINT,
        totalTokens,
        sellSlippageBps
      );
      const confirmOut = BigInt(confirmQuote.outAmount);
      const confirmProfitBps = computeBps(
        confirmOut - totalSolSpent - sellPriorityFeeLamports,
        totalSolSpent
      );
      console.log(
        `${ts()} | PROFIT confirm | est ${formatPctFromBps(
          confirmProfitBps
        )} | out ${confirmOut.toString()}`
      );

      if (confirmProfitBps >= targetProfitBps) {
        await doSell("profit target hit", currentPriceScaled, sellSlippageBps);
      } else {
        console.log(
          `${ts()} | PROFIT confirm failed: ${formatPctFromBps(
            confirmProfitBps
          )} < target ${formatPctFromBps(targetProfitBps)}`
        );
      }
      continue;
    }

    if (drawdownBps >= BigInt(Math.abs(Number(hardStopBps)))) {
      await doSell("hard stop hit", currentPriceScaled);
      continue;
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

main().catch((err) => {
  console.error("Bot failed:", err.message || err);
  process.exit(1);
});
