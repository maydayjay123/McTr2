/**
 * TelegramBotV2 - Enhanced Telegram interface for BotV4
 * Professional UI with real-time updates and interactive controls
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
const fs = require("fs");
const TelegramUI = require("../core/TelegramUI");

// Configuration
const ROOT_DIR = path.join(__dirname, "..", "..");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, "data");
const STATE_DIR = process.env.STATE_DIR || path.join(DATA_DIR, "state");
const LOG_DIR = process.env.LOG_DIR || path.join(DATA_DIR, "logs");
const COMMANDS_DIR = process.env.COMMANDS_DIR || path.join(DATA_DIR, "commands");

const BOT_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("Missing TG_BOT_TOKEN or TG_CHAT_ID");
  process.exit(1);
}

const WALLETS_FILE = process.env.WALLETS_FILE || path.join(ROOT_DIR, "wallets.json");
const UPDATE_INTERVAL_MS = Number(process.env.TG_UPDATE_INTERVAL_MS || 5000);
const PANEL_REFRESH_MS = Number(process.env.TG_PANEL_REFRESH_MS || 10000);

// State
let telegramUI;
let updateOffset = 0;
let currentWalletIndex = null;
let currentPanel = "status";
let lastPanelUpdate = 0;

/**
 * Main entry point
 */
async function main() {
  console.log("=".repeat(60));
  console.log("TelegramBotV2 - Enhanced Interface");
  console.log("=".repeat(60));

  ensureDirectories();

  // Initialize Telegram UI
  telegramUI = new TelegramUI(BOT_TOKEN, CHAT_ID);

  // Setup event handlers
  telegramUI.on("error", (err) => {
    console.error("Telegram error:", err.error.message);
  });

  // Send startup message
  await telegramUI.sendMessage(
    "<b>🤖 TelegramBotV2 Started</b>\n\n" +
    "Professional trading interface active.\n" +
    "Use the buttons below to navigate.",
    {}
  );

  // Send initial status panel
  await updateStatusPanel();

  console.log("Bot running - Press Ctrl+C to stop");
  console.log("=".repeat(60));

  // Start main loop
  await runMainLoop();
}

/**
 * Main loop
 */
async function runMainLoop() {
  while (true) {
    try {
      // Process Telegram updates
      await processUpdates();

      // Auto-refresh panel if needed
      if (Date.now() - lastPanelUpdate > PANEL_REFRESH_MS) {
        await refreshCurrentPanel();
      }

      await sleep(UPDATE_INTERVAL_MS);

    } catch (error) {
      console.error("Loop error:", error.message);
      await sleep(UPDATE_INTERVAL_MS);
    }
  }
}

/**
 * Process Telegram updates
 */
async function processUpdates() {
  try {
    const updates = await fetchUpdates();

    for (const update of updates) {
      updateOffset = update.update_id + 1;

      // Handle callback queries (button presses)
      if (update.callback_query) {
        await handleCallbackQuery(update.callback_query);
      }

      // Handle messages
      if (update.message) {
        await handleMessage(update.message);
      }
    }
  } catch (error) {
    console.error("Update processing error:", error.message);
  }
}

/**
 * Fetch Telegram updates
 */
async function fetchUpdates() {
  const fetch = require("node-fetch");
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      offset: updateOffset,
      timeout: 30,
    }),
  });

  const data = await response.json();
  return data.result || [];
}

/**
 * Handle callback query (button press)
 */
async function handleCallbackQuery(query) {
  const data = query.data;
  console.log(`Callback: ${data}`);

  // Answer callback to remove loading state
  await answerCallbackQuery(query.id);

  // Handle panel navigation
  if (data.startsWith("panel_")) {
    const panel = data.replace("panel_", "");
    currentPanel = panel;
    await refreshCurrentPanel();
    return;
  }

  // Handle actions
  if (data.startsWith("action_")) {
    await handleAction(data.replace("action_", ""));
    return;
  }

  // Handle wallet selection
  if (data.startsWith("wallet_")) {
    const index = parseInt(data.replace("wallet_", ""));
    currentWalletIndex = index;
    await refreshCurrentPanel();
    return;
  }
}

/**
 * Handle action command
 */
async function handleAction(action) {
  const commandsFile = getCommandsFile();

  let command = null;

  switch (action) {
    case "force_buy":
      command = { type: "force_buy", timestamp: Date.now() };
      await telegramUI.sendAlert("action", "🚀 Force buy triggered");
      break;

    case "pause":
      command = { type: "pause", timestamp: Date.now() };
      await telegramUI.sendAlert("action", "⏸️ Bot paused");
      break;

    case "resume":
      command = { type: "resume", timestamp: Date.now() };
      await telegramUI.sendAlert("action", "▶️ Bot resumed");
      break;

    case "sell_25":
      command = { type: "sell_pct", pct: 25, timestamp: Date.now() };
      await telegramUI.sendAlert("action", "💰 Selling 25% of position");
      break;

    case "sell_50":
      command = { type: "sell_pct", pct: 50, timestamp: Date.now() };
      await telegramUI.sendAlert("action", "💰 Selling 50% of position");
      break;

    case "sell_all":
      command = { type: "force_sell", timestamp: Date.now() };
      await telegramUI.sendAlert("action", "💸 Selling entire position");
      break;

    default:
      console.warn(`Unknown action: ${action}`);
  }

  if (command) {
    writeCommand(commandsFile, command);
  }
}

/**
 * Handle text message
 */
async function handleMessage(message) {
  const text = message.text;
  if (!text) return;

  console.log(`Message: ${text}`);

  // Handle commands
  if (text.startsWith("/")) {
    await handleSlashCommand(text);
  }
}

/**
 * Handle slash commands
 */
async function handleSlashCommand(command) {
  const cmd = command.toLowerCase().split(" ")[0];

  switch (cmd) {
    case "/start":
    case "/help":
      await sendHelpMessage();
      break;

    case "/status":
      currentPanel = "status";
      await refreshCurrentPanel();
      break;

    case "/position":
      currentPanel = "position";
      await refreshCurrentPanel();
      break;

    case "/risk":
      currentPanel = "risk";
      await refreshCurrentPanel();
      break;

    case "/performance":
      currentPanel = "performance";
      await refreshCurrentPanel();
      break;

    case "/wallets":
      await sendWalletsPanel();
      break;

    case "/refresh":
      await refreshCurrentPanel();
      break;

    default:
      await telegramUI.sendMessage(`Unknown command: ${cmd}`);
  }
}

/**
 * Send help message
 */
async function sendHelpMessage() {
  const help = `
<b>📖 BotV2 Commands</b>

<b>Panels:</b>
/status - Bot status and current price
/position - Position details
/risk - Risk metrics and limits
/performance - Trading performance

<b>Controls:</b>
/wallets - Select wallet (multi-wallet mode)
/refresh - Force refresh current panel

<b>Navigation:</b>
Use the inline buttons to navigate between panels and trigger actions.

<b>Auto-refresh:</b>
Panels auto-refresh every ${PANEL_REFRESH_MS / 1000}s
  `.trim();

  await telegramUI.sendMessage(help);
}

/**
 * Send wallets selection panel
 */
async function sendWalletsPanel() {
  const wallets = readWallets();

  if (wallets.length === 0) {
    await telegramUI.sendMessage("No wallets configured");
    return;
  }

  const buttons = wallets.map((w, i) => {
    const label = w.label || `Wallet ${i}`;
    const current = i === currentWalletIndex ? "✓ " : "";
    return [{ text: `${current}${label}`, callback_data: `wallet_${i}` }];
  });

  buttons.push([{ text: "🔄 Refresh", callback_data: "action_refresh" }]);

  const text = `<b>Select Wallet</b>\n\n` +
    `Current: ${currentWalletIndex !== null ? wallets[currentWalletIndex].label || `Wallet ${currentWalletIndex}` : "Default"}`;

  await telegramUI.sendMessage(text, {
    reply_markup: { inline_keyboard: buttons },
  });
}

/**
 * Refresh current panel
 */
async function refreshCurrentPanel() {
  const data = await getPanelData(currentPanel);
  await telegramUI.sendOrUpdatePanel(currentPanel, data);
  lastPanelUpdate = Date.now();
}

/**
 * Update status panel
 */
async function updateStatusPanel() {
  const data = await getPanelData("status");
  await telegramUI.sendOrUpdatePanel("status", data);
  lastPanelUpdate = Date.now();
}

/**
 * Get panel data
 */
async function getPanelData(panelType) {
  const state = readState();
  const metrics = readMetrics();

  switch (panelType) {
    case "status":
      return buildStatusData(state, metrics);

    case "position":
      return buildPositionData(state);

    case "risk":
      return buildRiskData(state);

    case "performance":
      return buildPerformanceData(state);

    default:
      return {};
  }
}

/**
 * Build status panel data
 */
function buildStatusData(state, metrics) {
  return {
    mode: state?.mode || "waiting_entry",
    tokenName: state?.tokenMint ? formatTokenMint(state.tokenMint) : null,
    currentPrice: state?.priceEngine?.lastPriceScaled || null,
    priceChange24h: metrics?.momentum || null,
    balance: state?.riskManager?.currentBalance || null,
    position: state?.position ? {
      avgEntry: state.position.avgEntryPriceScaled,
      solInvested: state.position.totalSolSpentLamports,
      profitBps: calculateProfitBps(
        state.position.avgEntryPriceScaled,
        state.priceEngine?.lastPriceScaled
      ),
      unrealizedPnL: calculateUnrealizedPnL(
        state.position.totalSolSpentLamports,
        state.priceEngine?.lastPriceScaled,
        state.position.avgEntryPriceScaled
      ),
      currentStep: state.position.currentStep || 0,
      totalSteps: state.position.steps?.length || 3,
    } : null,
    metrics: {
      vwap: metrics?.vwap || null,
      volatility: metrics?.volatility || null,
      momentum: metrics?.momentum || null,
    },
  };
}

/**
 * Build position panel data
 */
function buildPositionData(state) {
  if (!state?.position) {
    return {
      mode: "waiting_entry",
      avgEntry: null,
      currentPrice: null,
      solInvested: 0n,
      tokenAmount: 0n,
      profitBps: 0,
      unrealizedPnL: 0n,
      currentStep: 0,
      totalSteps: 0,
      trailPeakBps: null,
      partialExits: [],
      entryTime: null,
    };
  }

  return {
    mode: state.mode,
    avgEntry: state.position.avgEntryPriceScaled,
    currentPrice: state.priceEngine?.lastPriceScaled,
    solInvested: state.position.totalSolSpentLamports,
    tokenAmount: state.position.totalTokenAmount,
    profitBps: calculateProfitBps(
      state.position.avgEntryPriceScaled,
      state.priceEngine?.lastPriceScaled
    ),
    unrealizedPnL: calculateUnrealizedPnL(
      state.position.totalSolSpentLamports,
      state.priceEngine?.lastPriceScaled,
      state.position.avgEntryPriceScaled
    ),
    currentStep: state.position.currentStep || 0,
    totalSteps: state.position.steps?.length || 3,
    trailPeakBps: state.position.trailPeakBps,
    partialExits: state.position.partialExitsFilled || [],
    entryTime: state.position.entryTime,
  };
}

/**
 * Build risk panel data
 */
function buildRiskData(state) {
  const risk = state?.riskManager || {};

  return {
    startBalance: risk.startBalance || 0n,
    currentBalance: risk.currentBalance || 0n,
    peakBalance: risk.peakBalance || 0n,
    pnlPct: calculateBalancePnLPct(risk.startBalance, risk.currentBalance),
    drawdownFromPeak: calculateDrawdownPct(risk.peakBalance, risk.currentBalance),
    drawdownFromStart: calculateDrawdownPct(risk.startBalance, risk.currentBalance),
    tradingAllowed: !state?._legacy?.paused,
    blockReason: null,
    tradeCount: risk.tradeCount || 0,
    winRate: calculateWinRate(risk.winCount, risk.tradeCount),
    riskLevel: calculateRiskLevel(risk.peakBalance, risk.currentBalance),
  };
}

/**
 * Build performance panel data
 */
function buildPerformanceData(state) {
  const risk = state?.riskManager || {};

  return {
    tradeCount: risk.tradeCount || 0,
    winCount: risk.winCount || 0,
    lossCount: risk.lossCount || 0,
    winRate: calculateWinRate(risk.winCount, risk.tradeCount),
    totalPnL: risk.sessionPnL || 0n,
    avgPnLPerTrade: risk.tradeCount > 0
      ? (risk.sessionPnL || 0) / risk.tradeCount
      : 0,
    bestTrade: null, // Would need to track this
    worstTrade: null,
    sessionDuration: state?.sessionStartTime
      ? Date.now() - state.sessionStartTime
      : 0,
  };
}

/**
 * Helper functions
 */

function readState() {
  const stateFile = getStateFile();

  if (!fs.existsSync(stateFile)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(stateFile, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readMetrics() {
  // Metrics would come from price engine state
  return {
    vwap: null,
    volatility: null,
    momentum: null,
  };
}

function readWallets() {
  if (!fs.existsSync(WALLETS_FILE)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(WALLETS_FILE, "utf8");
    if (!raw.trim()) return [];
    const data = JSON.parse(raw);
    return data.wallets || [];
  } catch {
    return [];
  }
}

function getStateFile() {
  if (currentWalletIndex !== null) {
    return path.join(STATE_DIR, `botv4_state_${currentWalletIndex}.json`);
  }
  return path.join(STATE_DIR, "botv4_state.json");
}

function getCommandsFile() {
  if (currentWalletIndex !== null) {
    return path.join(COMMANDS_DIR, `tg_commands_${currentWalletIndex}.jsonl`);
  }
  return path.join(COMMANDS_DIR, "tg_commands.jsonl");
}

function writeCommand(filePath, command) {
  try {
    const line = JSON.stringify(command) + "\n";
    fs.appendFileSync(filePath, line, "utf8");
  } catch (error) {
    console.error("Failed to write command:", error.message);
  }
}

function calculateProfitBps(entryPriceScaled, currentPriceScaled) {
  if (!entryPriceScaled || !currentPriceScaled) return 0;

  const entry = Number(entryPriceScaled);
  const current = Number(currentPriceScaled);

  if (entry === 0) return 0;

  return Math.round(((current - entry) / entry) * 10000);
}

function calculateUnrealizedPnL(totalSolSpent, currentPriceScaled, avgEntryPriceScaled) {
  if (!totalSolSpent || !currentPriceScaled || !avgEntryPriceScaled) return 0n;

  const entry = Number(avgEntryPriceScaled);
  const current = Number(currentPriceScaled);
  const spent = Number(totalSolSpent);

  if (entry === 0) return 0n;

  const currentValue = (spent / entry) * current;
  const pnl = currentValue - spent;

  return BigInt(Math.round(pnl));
}

function calculateBalancePnLPct(startBalance, currentBalance) {
  if (!startBalance || startBalance === 0n) return 0;

  const start = Number(startBalance);
  const current = Number(currentBalance);

  return ((current - start) / start) * 100;
}

function calculateDrawdownPct(peakBalance, currentBalance) {
  if (!peakBalance || peakBalance === 0n) return 0;

  const peak = Number(peakBalance);
  const current = Number(currentBalance);

  return ((peak - current) / peak) * 100;
}

function calculateWinRate(winCount, totalCount) {
  if (!totalCount || totalCount === 0) return 0;
  return (winCount / totalCount) * 100;
}

function calculateRiskLevel(peakBalance, currentBalance) {
  const dd = calculateDrawdownPct(peakBalance, currentBalance);

  if (dd < 5) return "low";
  if (dd < 15) return "medium";
  if (dd < 25) return "high";
  return "extreme";
}

function formatTokenMint(mint) {
  return mint.slice(0, 4) + "..." + mint.slice(-4);
}

async function answerCallbackQuery(queryId) {
  const fetch = require("node-fetch");
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`;

  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: queryId }),
  });
}

function ensureDirectories() {
  [DATA_DIR, STATE_DIR, LOG_DIR, COMMANDS_DIR].forEach(dir => {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Start bot
main().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});