/**
 * BotV4 - Professional Solana Trading Bot
 * Modular architecture with advanced features and real-time monitoring
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
const fs = require("fs");
const fetch = require("node-fetch");
const {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} = require("@solana/web3.js");

// Core modules
const PriceEngine = require("../core/PriceEngine");
const TradeEngine = require("../core/TradeEngine");
const RiskManager = require("../core/RiskManager");
const StateManager = require("../core/StateManager");
const PerformanceMonitor = require("../core/PerformanceMonitor");

// Constants and configuration
const ROOT_DIR = path.join(__dirname, "..", "..");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, "data");
const STATE_DIR = process.env.STATE_DIR || path.join(DATA_DIR, "state");
const LOG_DIR = process.env.LOG_DIR || path.join(DATA_DIR, "logs");
const COMMANDS_DIR = process.env.COMMANDS_DIR || path.join(DATA_DIR, "commands");

const RPC_URL = process.env.SOLANA_RPC_URL;
const RPC_URLS = (process.env.SOLANA_RPC_URLS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const WALLET_INDEX = Number(process.env.WALLET_INDEX) || null;
const WALLETS_FILE = process.env.WALLETS_FILE || path.join(ROOT_DIR, "wallets.json");

const STATE_FILE = WALLET_INDEX !== null
  ? path.join(STATE_DIR, `botv4_state_${WALLET_INDEX}.json`)
  : path.join(STATE_DIR, "botv4_state.json");

const LOG_FILE = WALLET_INDEX !== null
  ? path.join(LOG_DIR, `botv4_${WALLET_INDEX}.log`)
  : path.join(LOG_DIR, "botv4.log");

const COMMANDS_FILE = WALLET_INDEX !== null
  ? path.join(COMMANDS_DIR, `tg_commands_${WALLET_INDEX}.jsonl`)
  : path.join(COMMANDS_DIR, "tg_commands.jsonl");

const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUP_BASE_URL = process.env.JUPITER_API_BASE || "https://lite-api.jup.ag";

// Trading configuration
const CONFIG = {
  targetMint: process.env.TARGET_MINT,
  tradeAllocPct: Number(process.env.TRADE_ALLOC_PCT || 88),
  stepSolPct: parseNumberList(process.env.STEP_SOL_PCT, [15, 25, 60]),
  stepDrawdownPct: parseNumberList(process.env.STEP_DRAWDOWN_PCT, [0, 6, 12]),
  profitTargetBps: Number(process.env.PROFIT_TARGET_BPS || 300),
  profitConfirmTicks: Number(process.env.PROFIT_CONFIRM_TICKS || 2),
  trailingStartPct: Number(process.env.TRAILING_START_PCT || 8),
  trailingGapPct: Number(process.env.TRAILING_GAP_PCT || 4),
  trailingMinProfitPct: Number(process.env.TRAILING_MIN_PROFIT_PCT || 3),
  buySlippageBps: Number(process.env.BUY_SLIPPAGE_BPS || 100),
  sellSlippageBps: Number(process.env.SELL_SLIPPAGE_BPS || 50),
  buyPriorityFee: Number(process.env.BUY_PRIORITY_FEE_LAMPORTS || 0),
  sellPriorityFee: Number(process.env.SELL_PRIORITY_FEE_LAMPORTS || 0),
  maxDrawdownPct: Number(process.env.MAX_DRAWDOWN_PCT || 30),
  pollMs: Number(process.env.POLL_MS || 5000),
  priceUpdateMs: Number(process.env.PRICE_UPDATE_MS || 3000),
  balanceRefreshMs: Number(process.env.BALANCE_REFRESH_MS || 30000),
  confirmTimeoutMs: Number(process.env.CONFIRM_TIMEOUT_MS || 120000),
};

// State
let connection;
let wallet;
let tokenMint;
let currentRpcIndex = 0;
let lastCommandLine = 0;
let paused = false;
let lastBalanceRefresh = 0;

// Modules
let priceEngine;
let tradeEngine;
let riskManager;
let stateManager;
let perfMonitor;

/**
 * Main entry point
 */
async function main() {
  try {
    logInfo("=".repeat(60));
    logInfo("BotV4 - Professional Solana Trading Bot");
    logInfo("=".repeat(60));

    ensureDirectories();

    // Load wallet
    wallet = loadWallet();
    if (!wallet) {
      logError("Failed to load wallet");
      process.exit(1);
    }

    const walletAddress = wallet.publicKey.toBase58();
    logInfo(`Wallet: ${walletAddress.slice(0, 8)}...${walletAddress.slice(-8)}`);

    // Initialize RPC connection
    connection = new Connection(RPC_URL || RPC_URLS[0], "confirmed");
    logInfo(`RPC: ${RPC_URL || RPC_URLS[0]}`);

    // Get token mint
    tokenMint = CONFIG.targetMint;
    if (!tokenMint) {
      logError("TARGET_MINT not configured");
      process.exit(1);
    }
    logInfo(`Token: ${tokenMint}`);

    // Initialize modules
    await initializeModules();

    // Load or create state
    await loadState();

    // Check for active position on startup
    if (stateManager.hasActivePosition()) {
      logInfo("⚠️  Active position detected - migrated from previous session");
      const state = stateManager.getState();
      if (state.position) {
        tradeEngine.importState({ position: state.position });
        logInfo(`Position: ${formatSol(state.position.totalSolSpentLamports)} SOL invested`);
      }
    }

    // Start price engine
    await priceEngine.start(tokenMint, SOL_MINT);
    logInfo("Price engine started");

    // Start performance monitoring
    perfMonitor.start();
    logInfo("Performance monitor started");

    logInfo("=".repeat(60));
    logInfo("Bot running - Press Ctrl+C to stop");
    logInfo("=".repeat(60));

    // Main loop
    await runMainLoop();

  } catch (error) {
    logError(`Fatal error: ${error.message}`);
    console.error(error);
    process.exit(1);
  }
}

/**
 * Initialize all modules
 */
async function initializeModules() {
  // State manager
  stateManager = new StateManager(STATE_FILE);

  // Price engine
  priceEngine = new PriceEngine({
    jupiterApiBase: JUP_BASE_URL,
    priceUpdateIntervalMs: CONFIG.priceUpdateMs,
    vwapWindow: 20,
    volatilityWindow: 50,
  });

  // Trade engine
  tradeEngine = new TradeEngine({
    stepSolPct: CONFIG.stepSolPct,
    stepDrawdownPct: CONFIG.stepDrawdownPct,
    profitTargetBps: CONFIG.profitTargetBps,
    profitConfirmTicks: CONFIG.profitConfirmTicks,
    trailingStartPct: CONFIG.trailingStartPct,
    trailingGapPct: CONFIG.trailingGapPct,
    trailingMinProfitPct: CONFIG.trailingMinProfitPct,
    partialExitsEnabled: true,
    dynamicTrailingEnabled: true,
  });

  // Risk manager
  riskManager = new RiskManager({
    maxDrawdownPct: CONFIG.maxDrawdownPct,
    maxPositionSizePct: CONFIG.tradeAllocPct,
    stopLossEnabled: true,
  });

  // Performance monitor
  perfMonitor = new PerformanceMonitor({
    metricsIntervalMs: 60000,
    healthCheckIntervalMs: 30000,
  });

  // Event handlers
  setupEventHandlers();
}

/**
 * Setup event handlers for modules
 */
function setupEventHandlers() {
  // Price engine events
  priceEngine.on("price", (data) => {
    perfMonitor.recordPriceUpdate();

    if (tradeEngine.hasPosition()) {
      handlePriceUpdate(data.price);
    }
  });

  priceEngine.on("error", (err) => {
    logError(`Price engine error: ${err.error.message}`);
    perfMonitor.recordError("price_engine", err.error);
  });

  // Trade engine events
  tradeEngine.on("step_filled", (data) => {
    logInfo(`Step ${data.stepIndex} filled: ${formatSol(data.solSpent)} SOL @ ${formatPrice(data.price)}`);
    saveState();
  });

  tradeEngine.on("partial_exit", (data) => {
    logInfo(`Partial exit: ${data.level.exitPct}% at +${data.level.profitPct}%`);
    saveState();
  });

  tradeEngine.on("position_closed", (data) => {
    const pnlSol = formatSol(data.pnlLamports);
    const profitPct = (data.profitBps / 100).toFixed(2);
    logInfo(`Position closed: ${pnlSol} SOL (${profitPct}%)`);

    const isWin = data.pnlLamports > 0n;
    riskManager.recordTrade(data.pnlLamports, isWin);
    saveState();
  });

  // Risk manager events
  riskManager.on("trading_blocked", (data) => {
    logWarn(`Trading blocked: ${data.reason}`);
    paused = true;
  });

  riskManager.on("trading_allowed", () => {
    logInfo("Trading resumed");
    paused = false;
  });

  // Performance monitor events
  perfMonitor.on("health_degraded", (issues) => {
    logWarn(`Health degraded: ${issues.length} issues`);
    for (const issue of issues) {
      logWarn(`  [${issue.severity}] ${issue.component}: ${issue.message}`);
    }
  });

  perfMonitor.on("health_restored", () => {
    logInfo("Health restored");
  });
}

/**
 * Load state from disk
 */
async function loadState() {
  const state = stateManager.load();

  if (state) {
    logInfo("State loaded successfully");

    const migrationSummary = stateManager.getMigrationSummary();
    if (migrationSummary) {
      logInfo(`Migrated from ${migrationSummary.fromVersion} to ${migrationSummary.toVersion}`);
      if (migrationSummary.hadActivePosition) {
        logInfo("Active position preserved from previous version");
      }
    }

    // Initialize risk manager with saved balance
    if (state.riskManager?.startBalance) {
      riskManager.importState(state.riskManager);
    }
  } else {
    logInfo("No existing state found - starting fresh");

    // Get initial balance
    const balance = await getBalance();
    riskManager.initSession(balance);

    stateManager.reset(tokenMint);
  }
}

/**
 * Save state to disk
 */
function saveState() {
  try {
    const state = stateManager.getState() || {};

    // Update from modules
    stateManager.updateFromModule("trade_engine", tradeEngine.exportState());
    stateManager.updateFromModule("risk_manager", riskManager.exportState().session);

    stateManager.save(state);
  } catch (error) {
    logError(`Failed to save state: ${error.message}`);
  }
}

/**
 * Main trading loop
 */
async function runMainLoop() {
  while (true) {
    try {
      // Check for commands
      await processCommands();

      // Refresh balance periodically
      if (Date.now() - lastBalanceRefresh > CONFIG.balanceRefreshMs) {
        const balance = await getBalance();
        riskManager.updateBalance(balance);
        lastBalanceRefresh = Date.now();
      }

      // Skip trading if paused
      if (paused) {
        await sleep(CONFIG.pollMs);
        continue;
      }

      // Skip trading if risk limits exceeded
      if (!riskManager.canTrade()) {
        await sleep(CONFIG.pollMs);
        continue;
      }

      // Get current price
      const currentPrice = priceEngine.getCurrentPriceScaled();
      if (!currentPrice) {
        logWarn("No price available");
        await sleep(CONFIG.pollMs);
        continue;
      }

      // Handle trading logic
      if (tradeEngine.hasPosition()) {
        await handleInPosition(currentPrice);
      } else {
        await handleWaitingEntry(currentPrice);
      }

      saveState();

    } catch (error) {
      logError(`Loop error: ${error.message}`);
      perfMonitor.recordError("main_loop", error);
    }

    await sleep(CONFIG.pollMs);
  }
}

/**
 * Handle trading when in position
 */
async function handleInPosition(currentPriceScaled) {
  const update = tradeEngine.updatePrice(currentPriceScaled);

  if (!update) return;

  const { profitBps, nextStep, partialExit, exitSignal } = update;

  // Check for next step entry (averaging down)
  if (nextStep) {
    logInfo(`Next step triggered: ${nextStep.drawdownPct.toFixed(2)}% drawdown`);
    await executeBuy(nextStep.stepIndex, nextStep.sizeLamports);
  }

  // Check for partial exit
  if (partialExit) {
    logInfo(`Partial exit signal: ${partialExit.level.exitPct}% at +${partialExit.level.profitPct}%`);
    await executeSell(partialExit.exitAmount, "partial");
  }

  // Check for full exit
  if (exitSignal) {
    logInfo(`Exit signal: ${exitSignal.type} (${(exitSignal.profitBps / 100).toFixed(2)}%)`);
    await executeSell(null, "full");
  }
}

/**
 * Handle trading when waiting for entry
 */
async function handleWaitingEntry(currentPriceScaled) {
  // Simple entry logic - can be enhanced with your existing entry conditions
  // For now, this is a placeholder that waits for manual commands

  // You can add your entry logic from botv3.js here, such as:
  // - Entry drop detection
  // - Reference price tracking
  // - Entry high tracking
}

/**
 * Execute buy order
 */
async function executeBuy(stepIndex, amountLamports) {
  const startTime = Date.now();

  try {
    logInfo(`Executing buy: Step ${stepIndex}, ${formatSol(amountLamports)} SOL`);

    // Fetch swap quote
    const quote = await fetchJupiterQuote(
      SOL_MINT,
      tokenMint,
      amountLamports.toString(),
      CONFIG.buySlippageBps
    );

    perfMonitor.recordApiCall(true, Date.now() - startTime);

    // Get swap transaction
    const swapTx = await fetchJupiterSwap(quote, wallet.publicKey.toBase58());

    // Execute transaction
    const signature = await executeTransaction(swapTx);

    logInfo(`Buy executed: ${signature}`);

    // Get token balance to calculate amount received
    const tokenBalance = await getTokenBalance(tokenMint);

    // Record in trade engine
    const priceScaled = priceEngine.getCurrentPriceScaled();
    tradeEngine.recordStepFill(
      stepIndex,
      amountLamports,
      tokenBalance,
      priceScaled
    );

    perfMonitor.recordTrade("buy", Date.now() - startTime);

    return true;

  } catch (error) {
    logError(`Buy failed: ${error.message}`);
    perfMonitor.recordApiCall(false, Date.now() - startTime);
    perfMonitor.recordError("buy", error);
    return false;
  }
}

/**
 * Execute sell order
 */
async function executeSell(amountTokens, type) {
  const startTime = Date.now();

  try {
    const position = tradeEngine.getPositionSummary();
    const sellAmount = amountTokens || BigInt(position.totalTokenAmount);

    logInfo(`Executing sell (${type}): ${formatTokenAmount(sellAmount)} tokens`);

    // Fetch swap quote
    const quote = await fetchJupiterQuote(
      tokenMint,
      SOL_MINT,
      sellAmount.toString(),
      CONFIG.sellSlippageBps
    );

    perfMonitor.recordApiCall(true, Date.now() - startTime);

    // Get swap transaction
    const swapTx = await fetchJupiterSwap(quote, wallet.publicKey.toBase58());

    // Execute transaction
    const signature = await executeTransaction(swapTx);

    logInfo(`Sell executed: ${signature}`);

    // Get SOL balance to calculate received amount
    const solReceived = await getBalance();

    const priceScaled = priceEngine.getCurrentPriceScaled();

    if (type === "partial") {
      // Record partial exit
      tradeEngine.recordPartialExit(
        { profitPct: 0 }, // Level info
        sellAmount,
        solReceived,
        priceScaled
      );
    } else {
      // Close full position
      tradeEngine.closePosition(priceScaled, solReceived);
    }

    perfMonitor.recordTrade("sell", Date.now() - startTime);

    return true;

  } catch (error) {
    logError(`Sell failed: ${error.message}`);
    perfMonitor.recordApiCall(false, Date.now() - startTime);
    perfMonitor.recordError("sell", error);
    return false;
  }
}

/**
 * Fetch Jupiter quote
 */
async function fetchJupiterQuote(inputMint, outputMint, amount, slippageBps) {
  const url = `${JUP_BASE_URL}/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;

  const response = await fetch(url, { timeout: 10000 });
  if (!response.ok) {
    throw new Error(`Jupiter quote failed: ${response.status}`);
  }

  return response.json();
}

/**
 * Fetch Jupiter swap transaction
 */
async function fetchJupiterSwap(quote, userPublicKey) {
  const url = `${JUP_BASE_URL}/v6/swap`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey,
      wrapAndUnwrapSol: true,
    }),
    timeout: 10000,
  });

  if (!response.ok) {
    throw new Error(`Jupiter swap failed: ${response.status}`);
  }

  const data = await response.json();
  return data.swapTransaction;
}

/**
 * Execute transaction
 */
async function executeTransaction(swapTransactionBase64) {
  const transactionBuf = Buffer.from(swapTransactionBase64, "base64");
  const transaction = VersionedTransaction.deserialize(transactionBuf);

  transaction.sign([wallet]);

  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });

  // Confirm transaction
  await connection.confirmTransaction(signature, "confirmed");

  return signature;
}

/**
 * Get SOL balance
 */
async function getBalance() {
  const balance = await connection.getBalance(wallet.publicKey);
  return BigInt(balance);
}

/**
 * Get token balance
 */
async function getTokenBalance(mint) {
  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
    wallet.publicKey,
    { mint: new PublicKey(mint) }
  );

  if (tokenAccounts.value.length === 0) {
    return 0n;
  }

  const balance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount;
  return BigInt(balance);
}

/**
 * Process commands from file
 */
async function processCommands() {
  if (!fs.existsSync(COMMANDS_FILE)) return;

  try {
    const lines = fs.readFileSync(COMMANDS_FILE, "utf8")
      .split(/\r?\n/)
      .filter(Boolean);

    for (let i = lastCommandLine; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      try {
        const cmd = JSON.parse(line);
        await handleCommand(cmd);
      } catch (err) {
        logWarn(`Invalid command at line ${i + 1}: ${err.message}`);
      }
    }

    lastCommandLine = lines.length;
  } catch (error) {
    logError(`Command processing error: ${error.message}`);
  }
}

/**
 * Handle command
 */
async function handleCommand(cmd) {
  logInfo(`Command: ${cmd.type}`);

  switch (cmd.type) {
    case "pause":
      paused = true;
      logInfo("Bot paused");
      break;

    case "resume":
      paused = false;
      logInfo("Bot resumed");
      break;

    case "force_buy":
      if (!tradeEngine.hasPosition()) {
        const balance = await getBalance();
        const positionSize = (balance * BigInt(CONFIG.tradeAllocPct)) / 100n;
        const stepSize = (positionSize * BigInt(CONFIG.stepSolPct[0])) / 100n;
        await executeBuy(0, stepSize);
      }
      break;

    case "force_sell":
      if (tradeEngine.hasPosition()) {
        await executeSell(null, "full");
      }
      break;

    case "sell_pct":
      if (tradeEngine.hasPosition() && cmd.pct) {
        const position = tradeEngine.getPositionSummary();
        const amount = (BigInt(position.totalTokenAmount) * BigInt(cmd.pct)) / 100n;
        await executeSell(amount, "partial");
      }
      break;

    default:
      logWarn(`Unknown command: ${cmd.type}`);
  }
}

/**
 * Utility functions
 */

function ensureDirectories() {
  [DATA_DIR, STATE_DIR, LOG_DIR, COMMANDS_DIR].forEach(dir => {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}
  });
}

function loadWallet() {
  if (!fs.existsSync(WALLETS_FILE)) {
    return null;
  }

  const data = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf8"));
  const wallets = data.wallets || [];

  if (WALLET_INDEX !== null) {
    if (WALLET_INDEX >= wallets.length) {
      return null;
    }
    const entry = wallets[WALLET_INDEX];
    return Keypair.fromSecretKey(Uint8Array.from(entry.secretKey));
  }

  if (wallets.length === 0) {
    return null;
  }

  const entry = wallets[0];
  return Keypair.fromSecretKey(Uint8Array.from(entry.secretKey));
}

function parseNumberList(value, fallback) {
  if (!value) return fallback;
  const parts = value.split(",").map(s => Number(s.trim())).filter(n => !isNaN(n));
  return parts.length ? parts : fallback;
}

function formatSol(lamports) {
  return (Number(lamports) / 1e9).toFixed(4);
}

function formatPrice(priceScaled) {
  return (Number(priceScaled) / 1e9).toExponential(4);
}

function formatTokenAmount(amount) {
  const num = Number(amount);
  if (num >= 1e9) return (num / 1e9).toFixed(2) + "B";
  if (num >= 1e6) return (num / 1e6).toFixed(2) + "M";
  if (num >= 1e3) return (num / 1e3).toFixed(2) + "K";
  return num.toFixed(2);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function logInfo(msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [INFO] ${msg}`;
  console.log(line);
  appendLog(line);
}

function logWarn(msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [WARN] ${msg}`;
  console.warn(line);
  appendLog(line);
}

function logError(msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [ERROR] ${msg}`;
  console.error(line);
  appendLog(line);
}

function appendLog(line) {
  try {
    fs.appendFileSync(LOG_FILE, line + "\n", "utf8");
  } catch {}
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  logInfo("Shutting down...");

  if (priceEngine) priceEngine.stop();
  if (perfMonitor) perfMonitor.stop();

  saveState();

  logInfo("Shutdown complete");
  process.exit(0);
});

process.on("SIGTERM", () => {
  logInfo("Terminating...");

  if (priceEngine) priceEngine.stop();
  if (perfMonitor) perfMonitor.stop();

  saveState();

  process.exit(0);
});

// Start bot
main().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});