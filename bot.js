// ═══════════════════════════════════════════════════════════════════════════
// MM-Profit Trading Bot - Simple & Dynamic
// ═══════════════════════════════════════════════════════════════════════════

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

const config = require("./config");

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const RPC_URL = process.env.SOLANA_RPC_URL;
const TARGET_MINT = process.env.TARGET_MINT;
const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUP_BASE_URL = process.env.JUPITER_API_BASE || "https://lite-api.jup.ag";

const WALLETS_FILE = path.join(__dirname, "wallets.json");
const DATA_DIR = path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const LOG_FILE = path.join(DATA_DIR, "bot.log");

const LAMPORTS_PER_SOL = 1_000_000_000n;

// ═══════════════════════════════════════════════════════════════════════════
// GLOBALS
// ═══════════════════════════════════════════════════════════════════════════

let connection = null;
let keypair = null;
let tokenDecimals = null;
let running = true;
let paused = false;
let initialized = false;

// ═══════════════════════════════════════════════════════════════════════════
// INITIALIZATION (lazy - called on first use)
// ═══════════════════════════════════════════════════════════════════════════

function ensureInit() {
  if (initialized) return;

  if (!RPC_URL) {
    throw new Error("Missing SOLANA_RPC_URL in .env");
  }

  ensureDir(DATA_DIR);
  connection = new Connection(RPC_URL, "confirmed");
  keypair = loadWallet();
  initialized = true;
}

// ═══════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function ts() {
  return new Date().toISOString().replace("T", " ").split(".")[0];
}

function log(...args) {
  const line = `[${ts()}] ${args.join(" ")}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {}
}

function logError(...args) {
  const line = `[${ts()}] ERROR: ${args.join(" ")}`;
  console.error(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {}
}

// ═══════════════════════════════════════════════════════════════════════════
// STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

function getDefaultState() {
  return {
    phase: "watching",           // watching | building | holding | trailing
    watchPrice: null,            // Price when we started watching
    stepIndex: 0,                // 0, 1, 2 (which step we're on)
    position: {
      tokenAmount: "0",          // String for BigInt serialization
      totalSolSpent: "0",
      avgEntryPrice: 0,
    },
    trailing: {
      active: false,
      peakPrice: 0,
    },
    lastTrade: {
      profitPct: 0,
      timestamp: null,
    },
    cooldown: {
      startTime: null,
      priceAtStart: null,
      highPrice: null,
      lowPrice: null,
    },
    currentEntryDropPct: config.entryDropPct,
    partialExitsDone: [],        // Track which partial exit levels were hit
    slippage: {
      buy: config.buySlippageBps,
      sell: config.sellSlippageBps,
    },
    priorityFee: {
      buy: config.buyPriorityFeeLamports,
      sell: config.sellPriorityFeeLamports,
    },
  };
}

function readState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return getDefaultState();
    }
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    if (!raw.trim()) {
      return getDefaultState();
    }
    const defaults = getDefaultState();
    const saved = JSON.parse(raw);
    // Deep merge nested objects
    return {
      ...defaults,
      ...saved,
      position: { ...defaults.position, ...saved.position },
      trailing: { ...defaults.trailing, ...saved.trailing },
      lastTrade: { ...defaults.lastTrade, ...saved.lastTrade },
      cooldown: { ...defaults.cooldown, ...saved.cooldown },
      slippage: { ...defaults.slippage, ...saved.slippage },
      priorityFee: { ...defaults.priorityFee, ...saved.priorityFee },
    };
  } catch (err) {
    logError("Failed to read state:", err.message);
    return getDefaultState();
  }
}

function writeState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    logError("Failed to write state:", err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// WALLET
// ═══════════════════════════════════════════════════════════════════════════

function loadWallet() {
  if (!fs.existsSync(WALLETS_FILE)) {
    throw new Error("wallets.json not found");
  }
  const raw = fs.readFileSync(WALLETS_FILE, "utf8");
  const data = JSON.parse(raw);
  const wallets = data.wallets || [];

  // Use WALLET_INDEX env var or default to first wallet
  const index = Number(process.env.WALLET_INDEX) || 0;
  if (!wallets[index]) {
    throw new Error(`Wallet at index ${index} not found`);
  }

  const entry = wallets[index];
  const secretKey = Uint8Array.from(entry.secretKey);
  return Keypair.fromSecretKey(secretKey);
}

// ═══════════════════════════════════════════════════════════════════════════
// JUPITER API
// ═══════════════════════════════════════════════════════════════════════════

function buildQuoteUrl(inputMint, outputMint, amount, slippageBps) {
  const base = JUP_BASE_URL.replace(/\/+$/, "");
  const isLite = base.includes("lite-api");
  const endpoint = isLite ? "/swap/v1/quote" : "/v6/quote";

  const url = new URL(`${base}${endpoint}`);
  url.searchParams.set("inputMint", inputMint);
  url.searchParams.set("outputMint", outputMint);
  url.searchParams.set("amount", amount.toString());
  url.searchParams.set("slippageBps", String(slippageBps));
  return url.toString();
}

async function fetchQuote(inputMint, outputMint, amount, slippageBps) {
  const url = buildQuoteUrl(inputMint, outputMint, amount, slippageBps);
  const response = await fetch(url);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Quote failed: ${response.status} ${body}`);
  }

  const data = await response.json();
  if (!data || !data.outAmount) {
    throw new Error("Quote returned no outAmount");
  }
  return data;
}

async function fetchSwapTransaction(quote, userPublicKey, priorityFeeLamports = 0) {
  const base = JUP_BASE_URL.replace(/\/+$/, "");
  const isLite = base.includes("lite-api");
  const endpoint = isLite ? "/swap/v1/swap" : "/v6/swap";
  const url = `${base}${endpoint}`;

  const body = {
    quoteResponse: quote,
    userPublicKey,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
  };

  if (priorityFeeLamports > 0) {
    body.prioritizationFeeLamports = priorityFeeLamports;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Swap request failed: ${response.status} ${text}`);
  }

  const data = await response.json();
  if (!data || !data.swapTransaction) {
    throw new Error("Swap response missing transaction");
  }
  return data.swapTransaction;
}

async function executeSwap(quote, priorityFeeLamports = 0) {
  const swapTxB64 = await fetchSwapTransaction(
    quote,
    keypair.publicKey.toBase58(),
    priorityFeeLamports
  );

  const txBuffer = Buffer.from(swapTxB64, "base64");
  const tx = VersionedTransaction.deserialize(txBuffer);
  tx.sign([keypair]);

  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });

  log(`TX sent: ${signature}`);

  // Wait for confirmation
  const confirmed = await waitForConfirmation(signature, 120000);
  if (!confirmed) {
    throw new Error("Transaction not confirmed within timeout");
  }

  log(`TX confirmed: ${signature}`);
  return signature;
}

async function waitForConfirmation(signature, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const status = await connection.getSignatureStatuses([signature]);
      const result = status?.value?.[0];
      if (result) {
        if (result.err) {
          throw new Error(`TX failed: ${JSON.stringify(result.err)}`);
        }
        if (result.confirmationStatus === "confirmed" ||
            result.confirmationStatus === "finalized") {
          return true;
        }
      }
    } catch (err) {
      if (err.message.includes("TX failed")) throw err;
    }
    await sleep(2000);
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// PRICE & BALANCE
// ═══════════════════════════════════════════════════════════════════════════

async function getCurrentPrice() {
  // Get token decimals first
  const decimals = await getTokenDecimals();

  // Get quote for a small amount of SOL to check price
  const testAmount = 100_000_000n; // 0.1 SOL
  const quote = await fetchQuote(
    SOL_MINT,
    TARGET_MINT,
    testAmount,
    50 // minimal slippage for price check
  );

  // tokens received (in base units)
  const tokensOut = BigInt(quote.outAmount);
  if (tokensOut === 0n) return 0;

  // Convert to actual token amount (accounting for decimals)
  const tokenAmount = Number(tokensOut) / Math.pow(10, decimals);
  const solAmount = Number(testAmount) / 1e9;

  // Price = SOL per token
  return solAmount / tokenAmount;
}

async function getSolBalance() {
  const balance = await connection.getBalance(keypair.publicKey, "confirmed");
  return BigInt(balance);
}

async function getTokenBalance() {
  try {
    const accounts = await connection.getTokenAccountsByOwner(
      keypair.publicKey,
      { mint: new PublicKey(TARGET_MINT) },
      "confirmed"
    );

    if (!accounts.value.length) {
      return { amount: 0n, decimals: 9 };
    }

    // Sum ALL token accounts (there can be multiple for same mint)
    let totalAmount = 0n;
    let decimals = 9;

    for (const account of accounts.value) {
      const balanceInfo = await connection.getTokenAccountBalance(
        account.pubkey,
        "confirmed"
      );
      totalAmount += BigInt(balanceInfo.value.amount);
      decimals = balanceInfo.value.decimals;
    }

    return { amount: totalAmount, decimals };
  } catch {
    return { amount: 0n, decimals: 9 };
  }
}

async function getTokenDecimals() {
  if (tokenDecimals !== null) return tokenDecimals;

  try {
    const mint = new PublicKey(TARGET_MINT);
    const info = await connection.getParsedAccountInfo(mint, "confirmed");
    tokenDecimals = info.value?.data?.parsed?.info?.decimals || 9;
    return tokenDecimals;
  } catch {
    return 9;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TRADING ACTIONS
// ═══════════════════════════════════════════════════════════════════════════

async function executeBuy(solAmount, state) {
  const lamports = BigInt(Math.floor(solAmount * 1e9));
  log(`BUY: ${formatSol(lamports)} SOL`);

  const quote = await fetchQuote(
    SOL_MINT,
    TARGET_MINT,
    lamports,
    state.slippage.buy
  );

  try {
    await executeSwap(quote, state.priorityFee.buy);

    // Update position
    const tokensReceived = BigInt(quote.outAmount);
    const prevTokens = BigInt(state.position.tokenAmount);
    const prevSol = BigInt(state.position.totalSolSpent);

    state.position.tokenAmount = (prevTokens + tokensReceived).toString();
    state.position.totalSolSpent = (prevSol + lamports).toString();

    // Calculate new average entry price (SOL per token)
    const totalTokens = prevTokens + tokensReceived;
    const decimals = await getTokenDecimals();
    if (totalTokens > 0n) {
      const totalSolSpent = Number(prevSol + lamports) / 1e9; // Convert lamports to SOL
      const totalTokenAmount = Number(totalTokens) / Math.pow(10, decimals); // Convert base units to tokens
      state.position.avgEntryPrice = totalSolSpent / totalTokenAmount;
    }

    // Reset slippage on success
    state.slippage.buy = config.buySlippageBps;
    state.priorityFee.buy = config.buyPriorityFeeLamports;

    writeState(state);
    log(`BUY SUCCESS: Got ${formatTokens(tokensReceived)} tokens`);
    return true;

  } catch (err) {
    logError(`BUY FAILED: ${err.message}`);

    // Escalate slippage for next try
    state.slippage.buy = Math.min(
      state.slippage.buy + config.slippageStepBps,
      config.slippageCapBps
    );
    writeState(state);
    return false;
  }
}

async function executeSell(tokenAmount, state) {
  log(`SELL: ${formatTokens(tokenAmount)} tokens`);

  const quote = await fetchQuote(
    TARGET_MINT,
    SOL_MINT,
    tokenAmount,
    state.slippage.sell
  );

  try {
    await executeSwap(quote, state.priorityFee.sell);

    const solReceived = BigInt(quote.outAmount);
    const solSpent = BigInt(state.position.totalSolSpent);

    // Calculate profit
    const profitLamports = solReceived - solSpent;
    const profitPct = solSpent > 0n
      ? (Number(profitLamports) / Number(solSpent)) * 100
      : 0;

    log(`SELL SUCCESS: Got ${formatSol(solReceived)} SOL (${profitPct >= 0 ? "+" : ""}${profitPct.toFixed(2)}%)`);

    // Record last trade
    state.lastTrade = {
      profitPct,
      timestamp: Date.now(),
    };

    // Determine next entry drop based on profit
    state.currentEntryDropPct = getNextEntryDrop(profitPct);
    log(`Next entry trigger: ${state.currentEntryDropPct}% drop`);

    // Reset position
    state.position = {
      tokenAmount: "0",
      totalSolSpent: "0",
      avgEntryPrice: 0,
    };
    state.trailing = { active: false, peakPrice: 0 };
    state.partialExitsDone = [];
    state.stepIndex = 0;
    state.phase = "watching";
    state.watchPrice = null;

    // Start cooldown tracking
    state.cooldown = {
      startTime: Date.now(),
      priceAtStart: null,
      highPrice: null,
      lowPrice: null,
    };

    // Reset slippage
    state.slippage.sell = config.sellSlippageBps;
    state.priorityFee.sell = config.sellPriorityFeeLamports;

    writeState(state);
    return true;

  } catch (err) {
    logError(`SELL FAILED: ${err.message}`);

    // Escalate slippage and priority fee
    state.slippage.sell = Math.min(
      state.slippage.sell + config.slippageStepBps,
      config.slippageCapBps
    );
    state.priorityFee.sell = Math.min(
      state.priorityFee.sell + config.priorityFeeStepLamports,
      config.priorityFeeCapLamports
    );
    writeState(state);
    return false;
  }
}

function getNextEntryDrop(profitPct) {
  // Check reentry rules in order (highest profit first)
  for (const rule of config.reentryRules) {
    if (profitPct >= rule.minProfitPct) {
      return rule.nextDropPct;
    }
  }
  // Default to standard entry drop
  return config.entryDropPct;
}

// ═══════════════════════════════════════════════════════════════════════════
// STATE MACHINE
// ═══════════════════════════════════════════════════════════════════════════

async function tick(state) {
  if (paused) return state;

  let price;
  try {
    price = await getCurrentPrice();
  } catch (err) {
    logError(`Price fetch failed: ${err.message}`);
    return state;
  }

  if (price <= 0) {
    logError("Invalid price received");
    return state;
  }

  // Update cooldown tracking
  state = updateCooldown(state, price);

  switch (state.phase) {
    case "watching":
      state = await handleWatching(state, price);
      break;
    case "building":
      state = await handleBuilding(state, price);
      break;
    case "holding":
      state = await handleHolding(state, price);
      break;
    case "trailing":
      state = await handleTrailing(state, price);
      break;
  }

  return state;
}

function updateCooldown(state, price) {
  // Track price range for cooldown reset
  if (state.cooldown.startTime) {
    if (state.cooldown.priceAtStart === null) {
      state.cooldown.priceAtStart = price;
      state.cooldown.highPrice = price;
      state.cooldown.lowPrice = price;
    } else {
      state.cooldown.highPrice = Math.max(state.cooldown.highPrice, price);
      state.cooldown.lowPrice = Math.min(state.cooldown.lowPrice, price);
    }

    // Check if cooldown period elapsed
    const elapsedHours = (Date.now() - state.cooldown.startTime) / (1000 * 60 * 60);
    if (elapsedHours >= config.cooldownResetHours) {
      // Check if price stayed within range
      const range = state.cooldown.highPrice / state.cooldown.lowPrice - 1;
      const rangePct = range * 100;

      if (rangePct <= config.cooldownRangePct) {
        log(`Cooldown complete: price ranged ${rangePct.toFixed(1)}% over ${config.cooldownResetHours}h`);
        log(`Resetting entry trigger to ${config.entryDropPct}%`);
        state.currentEntryDropPct = config.entryDropPct;
      }

      // Reset cooldown either way
      state.cooldown = {
        startTime: null,
        priceAtStart: null,
        highPrice: null,
        lowPrice: null,
      };
      writeState(state);
    }
  }

  return state;
}

async function handleWatching(state, price) {
  // Set watch price if not set
  if (state.watchPrice === null) {
    state.watchPrice = price;
    log(`WATCHING: Starting at price ${price.toFixed(12)}`);
    writeState(state);
    return state;
  }

  // Calculate drop from watch price
  const dropPct = ((state.watchPrice - price) / state.watchPrice) * 100;

  // Check if we hit entry trigger
  const targetDrop = state.currentEntryDropPct;

  if (dropPct >= targetDrop) {
    log(`ENTRY TRIGGER: Price dropped ${dropPct.toFixed(2)}% (target: ${targetDrop}%)`);

    // Calculate buy amount for step 0
    const solBalance = await getSolBalance();
    const allocation = (Number(solBalance) * config.maxWalletUsePct) / 100;
    const stepSize = (allocation * config.steps[0].sizePct) / 100;

    if (stepSize < 0.001 * 1e9) {
      logError("Insufficient balance for trade");
      return state;
    }

    const success = await executeBuy(stepSize / 1e9, state);
    if (success) {
      state.stepIndex = 1; // Move to step 1 (next step)
      state.phase = "building";
      state.cooldown = { startTime: null, priceAtStart: null, highPrice: null, lowPrice: null };
      log(`Phase: BUILDING (step 1 of ${config.steps.length} complete)`);
    }
    writeState(state);
  }

  return state;
}

async function handleBuilding(state, price) {
  // Check if we should do next step
  if (state.stepIndex < config.steps.length) {
    const step = config.steps[state.stepIndex];
    const dropPct = ((state.watchPrice - price) / state.watchPrice) * 100;

    if (dropPct >= step.dropPct) {
      log(`STEP ${state.stepIndex + 1} TRIGGER: Price dropped ${dropPct.toFixed(2)}% (target: ${step.dropPct}%)`);

      const solBalance = await getSolBalance();
      const allocation = (Number(solBalance) * config.maxWalletUsePct) / 100;
      const stepSize = (allocation * step.sizePct) / 100;

      if (stepSize >= 0.001 * 1e9) {
        const success = await executeBuy(stepSize / 1e9, state);
        if (success) {
          state.stepIndex++;
          log(`Step ${state.stepIndex} of ${config.steps.length} complete`);
        }
      }
      writeState(state);
    }
  }

  // Check if all steps done or if profit target hit
  const profitPct = calculateProfitPct(state, price);

  if (state.stepIndex >= config.steps.length) {
    state.phase = "holding";
    log(`Phase: HOLDING (all ${config.steps.length} steps complete)`);
    writeState(state);
  } else if (profitPct >= config.trailingTriggerPct) {
    // Early profit - activate trailing
    state.phase = "trailing";
    state.trailing = { active: true, peakPrice: price };
    log(`Phase: TRAILING (profit ${profitPct.toFixed(2)}% hit trigger)`);
    writeState(state);
  }

  return state;
}

async function handleHolding(state, price) {
  const profitPct = calculateProfitPct(state, price);

  // Handle partial exits if enabled
  if (config.partialExits.enabled) {
    state = await handlePartialExits(state, price, profitPct);
  }

  // Check for trailing trigger
  if (profitPct >= config.trailingTriggerPct) {
    state.phase = "trailing";
    state.trailing = { active: true, peakPrice: price };
    log(`Phase: TRAILING (profit ${profitPct.toFixed(2)}% hit trigger)`);
    writeState(state);
  }

  return state;
}

async function handleTrailing(state, price) {
  // Update peak price
  if (price > state.trailing.peakPrice) {
    state.trailing.peakPrice = price;
    writeState(state);
  }

  // Handle partial exits if enabled
  const profitPct = calculateProfitPct(state, price);
  if (config.partialExits.enabled) {
    state = await handlePartialExits(state, price, profitPct);
  }

  // Check trailing stop
  const dropFromPeak = ((state.trailing.peakPrice - price) / state.trailing.peakPrice) * 100;

  if (dropFromPeak >= config.trailingStopPct) {
    log(`TRAILING STOP: Price dropped ${dropFromPeak.toFixed(2)}% from peak`);

    // Verify actual wallet balance before selling (prevents race condition)
    const actualBalance = await getTokenBalance();
    const actualTokens = actualBalance.amount;
    const stateTokens = BigInt(state.position.tokenAmount);

    if (actualTokens === 0n && stateTokens > 0n) {
      // State is out of sync - tokens already sold
      log(`WARNING: State shows ${stateTokens} tokens but wallet has 0 - syncing state`);
      state.position = { tokenAmount: "0", totalSolSpent: "0", avgEntryPrice: 0 };
      state.trailing = { active: false, peakPrice: 0 };
      state.stepIndex = 0;
      state.phase = "watching";
      state.watchPrice = null;
      writeState(state);
      return state;
    }

    // Sell all remaining tokens
    const tokenAmount = actualTokens > 0n ? actualTokens : stateTokens;
    if (tokenAmount > 0n) {
      await executeSell(tokenAmount, state);
    }
  }

  return state;
}

async function handlePartialExits(state, price, profitPct) {
  for (const level of config.partialExits.levels) {
    // Skip if already done this level
    if (state.partialExitsDone.includes(level.profitPct)) continue;

    if (profitPct >= level.profitPct) {
      const tokenAmount = BigInt(state.position.tokenAmount);
      const sellAmount = (tokenAmount * BigInt(level.sellPct)) / 100n;

      if (sellAmount > 0n) {
        log(`PARTIAL EXIT: Selling ${level.sellPct}% at ${profitPct.toFixed(2)}% profit`);

        // Get quote just for this partial
        const quote = await fetchQuote(
          TARGET_MINT,
          SOL_MINT,
          sellAmount,
          state.slippage.sell
        );

        try {
          await executeSwap(quote, state.priorityFee.sell);

          // Update position (reduce tokens, but keep SOL spent for P&L calc)
          state.position.tokenAmount = (tokenAmount - sellAmount).toString();
          state.partialExitsDone.push(level.profitPct);

          log(`Partial exit complete. Remaining: ${formatTokens(BigInt(state.position.tokenAmount))} tokens`);
          writeState(state);
        } catch (err) {
          logError(`Partial exit failed: ${err.message}`);
        }
      }
    }
  }
  return state;
}

function calculateProfitPct(state, currentPrice) {
  if (state.position.avgEntryPrice <= 0) return 0;
  return ((currentPrice - state.position.avgEntryPrice) / state.position.avgEntryPrice) * 100;
}

// ═══════════════════════════════════════════════════════════════════════════
// FORMATTING
// ═══════════════════════════════════════════════════════════════════════════

function formatSol(lamports) {
  const value = typeof lamports === "bigint" ? lamports : BigInt(lamports);
  const whole = value / LAMPORTS_PER_SOL;
  const frac = value % LAMPORTS_PER_SOL;
  return `${whole}.${frac.toString().padStart(9, "0").slice(0, 4)}`;
}

function formatTokens(amount) {
  const value = typeof amount === "bigint" ? amount : BigInt(amount);
  const decimals = tokenDecimals || 9;
  const factor = 10n ** BigInt(decimals);
  const whole = value / factor;
  const frac = value % factor;
  return `${whole}.${frac.toString().padStart(decimals, "0").slice(0, 4)}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC API (for Telegram)
// ═══════════════════════════════════════════════════════════════════════════

async function getStatus() {
  ensureInit();
  const state = readState();
  const decimals = await getTokenDecimals();

  let price = 0;
  try {
    price = await getCurrentPrice();
  } catch {}

  const solBal = await getSolBalance();
  const tokenBal = await getTokenBalance();
  const profitPct = calculateProfitPct(state, price);

  return {
    phase: state.phase,
    paused,
    price,
    watchPrice: state.watchPrice,
    stepIndex: state.stepIndex,
    totalSteps: config.steps.length,
    position: {
      tokens: state.position.tokenAmount,
      solSpent: state.position.totalSolSpent,
      avgEntry: state.position.avgEntryPrice,
    },
    profitPct,
    trailing: state.trailing,
    currentEntryDropPct: state.currentEntryDropPct,
    lastTrade: state.lastTrade,
    balances: {
      sol: solBal.toString(),
      token: tokenBal.amount.toString(),
    },
    tokenDecimals: decimals,
  };
}

function setPaused(value) {
  ensureInit();
  paused = value;
  log(`Bot ${paused ? "PAUSED" : "RESUMED"}`);
}

function resetState() {
  ensureInit();
  const fresh = getDefaultState();
  writeState(fresh);
  log("State RESET to defaults");
  return fresh;
}

async function forceBuy() {
  ensureInit();
  try {
    const state = readState();

    // Check if we've completed all steps
    if (state.stepIndex >= config.steps.length) {
      return { success: false, error: `All ${config.steps.length} steps already complete` };
    }

    // Get current step config
    const currentStep = config.steps[state.stepIndex];
    const stepNum = state.stepIndex + 1;

    // Calculate buy size for this step
    const solBalance = await getSolBalance();
    const allocation = (Number(solBalance) * config.maxWalletUsePct) / 100;
    const stepSize = (allocation * currentStep.sizePct) / 100;

    if (stepSize < 0.001 * 1e9) {
      return { success: false, error: "Insufficient balance" };
    }

    // Set watch price if this is first buy
    if (state.watchPrice === null) {
      const price = await getCurrentPrice();
      state.watchPrice = price;
      log(`Watch price set to ${price}`);
    }

    log(`FORCE BUY: Step ${stepNum}/${config.steps.length} (${currentStep.sizePct}% of allocation)`);

    const success = await executeBuy(stepSize / 1e9, state);

    if (success) {
      // Update step tracking
      state.stepIndex = state.stepIndex + 1;

      // Update phase
      if (state.stepIndex >= config.steps.length) {
        state.phase = "holding";
        log(`Phase: HOLDING (all ${config.steps.length} steps complete)`);
      } else {
        state.phase = "building";
        log(`Phase: BUILDING (step ${state.stepIndex}/${config.steps.length} complete)`);
      }

      writeState(state);
      return { success: true, step: stepNum, totalSteps: config.steps.length };
    }

    return { success: false, error: "Buy execution failed" };
  } catch (err) {
    return { success: false, error: err.message || "Unknown error" };
  }
}

async function forceSell() {
  ensureInit();
  try {
    const state = readState();

    // Use actual wallet balance, not state (may be out of sync)
    const actualBalance = await getTokenBalance();
    const tokenAmount = actualBalance.amount;

    if (tokenAmount <= 0n) {
      return { success: false, error: "No tokens to sell" };
    }

    const success = await executeSell(tokenAmount, state);
    return { success, error: success ? null : "Sell execution failed" };
  } catch (err) {
    return { success: false, error: err.message || "Unknown error" };
  }
}

// Fix corrupted state while syncing with actual wallet balance
async function fixState() {
  ensureInit();
  const state = readState();

  // Get actual wallet balance
  const actualBalance = await getTokenBalance();
  const actualTokens = actualBalance.amount;

  if (actualTokens <= 0n) {
    return { success: false, error: "No tokens in wallet - use Reset instead" };
  }

  // Sync state.position.tokenAmount with actual wallet balance
  const stateTokens = BigInt(state.position.tokenAmount);
  if (actualTokens !== stateTokens) {
    log(`Syncing position: state had ${formatTokens(stateTokens)} tokens, wallet has ${formatTokens(actualTokens)} tokens`);
    state.position.tokenAmount = actualTokens.toString();
  }

  // Fix watchPrice - set to avgEntryPrice or current price
  if (state.position.avgEntryPrice > 0) {
    state.watchPrice = state.position.avgEntryPrice;
  } else {
    // Fallback: get current price
    const price = await getCurrentPrice();
    state.watchPrice = price;
    state.position.avgEntryPrice = price;
  }

  // Fix stepIndex based on wallet balance
  // Estimate which step we're on based on token amount relative to typical step sizes
  const currentPrice = await getCurrentPrice();
  const decimals = actualBalance.decimals;
  const positionValue = Number(actualTokens) / Math.pow(10, decimals) * currentPrice;
  const solBalance = await getSolBalance();
  const totalAvailable = Number(solBalance) / 1e9 + positionValue;

  // If position is >50% of total, likely all steps done
  if (positionValue / totalAvailable > 0.5) {
    state.stepIndex = config.steps.length;
    state.phase = "holding";
  } else if (positionValue / totalAvailable > 0.3) {
    state.stepIndex = 2;
    state.phase = "building";
  } else {
    state.stepIndex = 1;
    state.phase = "building";
  }

  // Reset trailing
  state.trailing = { active: false, peakPrice: 0 };

  writeState(state);
  log(`State FIXED: tokens=${formatTokens(actualTokens)}, watchPrice=${state.watchPrice}, stepIndex=${state.stepIndex}, phase=${state.phase}`);

  return {
    success: true,
    watchPrice: state.watchPrice,
    stepIndex: state.stepIndex,
    phase: state.phase,
    tokens: formatTokens(actualTokens),
  };
}

// Export for telegram.js
module.exports = {
  getStatus,
  setPaused,
  resetState,
  fixState,
  forceBuy,
  forceSell,
  readState,
  writeState,
  config,
};

// ═══════════════════════════════════════════════════════════════════════════
// MAIN LOOP
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  // Validate env
  if (!RPC_URL) {
    console.error("Missing SOLANA_RPC_URL in .env");
    process.exit(1);
  }
  if (!TARGET_MINT) {
    console.error("Missing TARGET_MINT in .env");
    process.exit(1);
  }

  ensureDir(DATA_DIR);

  log("═══════════════════════════════════════════════════════════════");
  log("MM-Profit Trading Bot Starting");
  log("═══════════════════════════════════════════════════════════════");

  // Initialize
  connection = new Connection(RPC_URL, "confirmed");
  keypair = loadWallet();
  tokenDecimals = await getTokenDecimals();

  log(`Wallet: ${keypair.publicKey.toBase58()}`);
  log(`Target: ${TARGET_MINT}`);
  log(`Entry trigger: ${config.entryDropPct}% drop`);
  log(`Steps: ${config.steps.map(s => `${s.dropPct}%/${s.sizePct}%`).join(", ")}`);
  log(`Max wallet use: ${config.maxWalletUsePct}%`);
  log(`Trailing: trigger at ${config.trailingTriggerPct}%, stop at ${config.trailingStopPct}%`);
  log("═══════════════════════════════════════════════════════════════");

  let state = readState();
  log(`Loaded state: phase=${state.phase}, step=${state.stepIndex}`);

  // Main loop
  while (running) {
    try {
      // Re-read state each tick to pick up changes from Telegram commands
      state = readState();
      state = await tick(state);
    } catch (err) {
      logError(`Tick error: ${err.message}`);
    }
    await sleep(config.priceCheckMs);
  }
}

// Run if executed directly
if (require.main === module) {
  main().catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
