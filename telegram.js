// ═══════════════════════════════════════════════════════════════════════════
// MM-Profit Telegram Controller
// ═══════════════════════════════════════════════════════════════════════════

require("dotenv").config();
const bot = require("./bot");
const config = require("./config");

const BOT_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

let updateOffset = 0;
let lastStatusMessageId = null;

// ═══════════════════════════════════════════════════════════════════════════
// TELEGRAM API
// ═══════════════════════════════════════════════════════════════════════════

async function sendMessage(text, keyboard = null) {
  const body = {
    chat_id: CHAT_ID,
    text,
    parse_mode: "HTML",
  };

  if (keyboard) {
    body.reply_markup = keyboard;
  }

  try {
    const res = await fetch(`${API_BASE}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("sendMessage failed:", err);
      return null;
    }

    const data = await res.json();
    return data?.result?.message_id || null;
  } catch (err) {
    console.error("sendMessage error:", err.message);
    return null;
  }
}

async function editMessage(messageId, text, keyboard = null) {
  const body = {
    chat_id: CHAT_ID,
    message_id: messageId,
    text,
    parse_mode: "HTML",
  };

  if (keyboard) {
    body.reply_markup = keyboard;
  }

  try {
    const res = await fetch(`${API_BASE}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      // Message might be unchanged, that's ok
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function answerCallback(callbackId, text = "") {
  try {
    await fetch(`${API_BASE}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackId,
        text,
        show_alert: false,
      }),
    });
  } catch {}
}

async function getUpdates() {
  const url = new URL(`${API_BASE}/getUpdates`);
  url.searchParams.set("timeout", "30");
  url.searchParams.set("offset", String(updateOffset));

  try {
    const res = await fetch(url.toString());
    if (!res.ok) return [];

    const data = await res.json();
    return data.result || [];
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// KEYBOARDS
// ═══════════════════════════════════════════════════════════════════════════

function getMainKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "▶️ Start", callback_data: "cmd_start" },
        { text: "⏸️ Pause", callback_data: "cmd_pause" },
        { text: "🔄 Refresh", callback_data: "cmd_status" },
      ],
      [
        { text: "💰 Buy", callback_data: "cmd_buy" },
        { text: "💸 Sell", callback_data: "cmd_sell" },
      ],
      [
        { text: "🔧 Fix", callback_data: "cmd_fix" },
        { text: "🗑️ Reset", callback_data: "cmd_reset" },
        { text: "⚙️ Config", callback_data: "cmd_config" },
      ],
    ],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// STATUS FORMATTING
// ═══════════════════════════════════════════════════════════════════════════

function formatPrice(price) {
  if (!price || price === 0) return "0";

  // For readable display of small prices
  if (price >= 1) {
    return price.toFixed(4);
  } else if (price >= 0.0001) {
    return price.toFixed(6);
  } else {
    // Very small - format as 0.0{5}4861 (5 zeros then digits)
    const str = price.toFixed(12);
    const match = str.match(/^0\.(0*)([1-9]\d*)/);
    if (match) {
      const zeros = match[1].length;
      const digits = match[2].slice(0, 4);
      return `0.0{${zeros}}${digits}`;
    }
    return price.toExponential(4);
  }
}

function formatStatus(status) {
  const phaseEmoji = {
    watching: "👀",
    building: "🔨",
    holding: "💎",
    trailing: "📈",
  };

  const emoji = phaseEmoji[status.phase] || "❓";
  const pauseIndicator = status.paused ? " [PAUSED]" : "";

  let text = `<b>${emoji} MM-Profit Bot${pauseIndicator}</b>\n\n`;

  // Phase & Price
  text += `<b>Phase:</b> ${status.phase.toUpperCase()}\n`;
  text += `<b>Price:</b> ${formatPrice(status.price)} SOL\n`;

  if (status.watchPrice) {
    const dropPct = ((status.watchPrice - status.price) / status.watchPrice) * 100;
    text += `<b>Watch Price:</b> ${formatPrice(status.watchPrice)} SOL\n`;
    text += `<b>Drop:</b> ${dropPct.toFixed(2)}%\n`;
  }

  text += `\n`;

  // Position
  if (BigInt(status.position.tokens) > 0n) {
    text += `<b>Position:</b>\n`;
    text += `  Tokens: ${formatTokens(status.position.tokens, status.tokenDecimals)}\n`;
    text += `  SOL Spent: ${formatSol(status.position.solSpent)}\n`;
    text += `  Avg Entry: ${formatPrice(status.position.avgEntry)} SOL\n`;
    text += `  P&L: ${status.profitPct >= 0 ? "+" : ""}${status.profitPct.toFixed(2)}%\n`;
    text += `\n`;
  }

  // Steps
  text += `<b>Steps:</b> ${status.stepIndex}/${status.totalSteps}\n`;
  text += `<b>Entry Trigger:</b> ${status.currentEntryDropPct}% drop\n`;

  // Trailing
  if (status.trailing.active) {
    text += `<b>Trailing:</b> Peak ${formatPrice(status.trailing.peakPrice)} SOL\n`;
  }

  text += `\n`;

  // Balances
  text += `<b>Balances:</b>\n`;
  text += `  SOL: ${formatSol(status.balances.sol)}\n`;
  text += `  Token: ${formatTokens(status.balances.token, status.tokenDecimals)}\n`;

  // Last Trade
  if (status.lastTrade.timestamp) {
    const ago = Math.floor((Date.now() - status.lastTrade.timestamp) / 60000);
    text += `\n<b>Last Trade:</b> ${status.lastTrade.profitPct >= 0 ? "+" : ""}${status.lastTrade.profitPct.toFixed(2)}% (${ago}m ago)\n`;
  }

  return text;
}

function formatConfig() {
  let text = `<b>⚙️ Configuration</b>\n\n`;

  text += `<b>Entry:</b>\n`;
  text += `  Default Drop: ${config.entryDropPct}%\n\n`;

  text += `<b>Steps:</b>\n`;
  config.steps.forEach((s, i) => {
    text += `  ${i + 1}. Drop ${s.dropPct}% → ${s.sizePct}% size\n`;
  });
  text += `\n`;

  text += `<b>Wallet:</b>\n`;
  text += `  Max Use: ${config.maxWalletUsePct}%\n\n`;

  text += `<b>Trailing:</b>\n`;
  text += `  Trigger: ${config.trailingTriggerPct}%\n`;
  text += `  Stop: ${config.trailingStopPct}%\n\n`;

  text += `<b>Re-entry Rules:</b>\n`;
  config.reentryRules.forEach(r => {
    text += `  &gt;${r.minProfitPct}% profit → ${r.nextDropPct}% drop\n`;
  });
  text += `\n`;

  text += `<b>Cooldown:</b>\n`;
  text += `  Reset after ${config.cooldownResetHours}h\n`;
  text += `  If range &lt;${config.cooldownRangePct}%\n`;

  return text;
}

function formatSol(lamports) {
  const value = BigInt(lamports);
  const whole = value / 1_000_000_000n;
  const frac = value % 1_000_000_000n;
  return `${whole}.${frac.toString().padStart(9, "0").slice(0, 4)}`;
}

function formatBigNumber(str) {
  const num = BigInt(str);
  if (num === 0n) return "0";

  // Format with commas for readability
  const numStr = num.toString();
  if (numStr.length <= 6) return numStr;

  // Scientific notation for very large numbers
  const exp = numStr.length - 1;
  const mantissa = numStr[0] + "." + numStr.slice(1, 4);
  return `${mantissa}e${exp}`;
}

// Format token amount with decimals (base units -> actual tokens)
function formatTokens(baseUnits, decimals = 6) {
  const num = BigInt(baseUnits);
  if (num === 0n) return "0";

  const factor = 10n ** BigInt(decimals);
  const whole = num / factor;
  const frac = num % factor;

  // Format with commas
  const wholeStr = whole.toLocaleString();
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, 2);

  return `${wholeStr}.${fracStr}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// COMMAND HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

async function handleCommand(cmd) {
  switch (cmd) {
    case "status":
    case "cmd_status": {
      const status = await bot.getStatus();
      const text = formatStatus(status);
      const msgId = await sendMessage(text, getMainKeyboard());
      if (msgId) lastStatusMessageId = msgId;
      break;
    }

    case "start":
    case "cmd_start": {
      bot.setPaused(false);
      await sendMessage("✅ Bot started");
      break;
    }

    case "pause":
    case "stop":
    case "cmd_pause": {
      bot.setPaused(true);
      await sendMessage("⏸️ Bot paused");
      break;
    }

    case "buy":
    case "cmd_buy": {
      await sendMessage("💰 Executing buy...");
      const result = await bot.forceBuy();
      if (result.success) {
        await sendMessage(`✅ Buy executed - Step ${result.step}/${result.totalSteps} complete`);
      } else {
        await sendMessage(`❌ Buy failed: ${result.error || "Unknown error"}`);
      }
      break;
    }

    case "sell":
    case "cmd_sell": {
      await sendMessage("💸 Executing sell...");
      const result = await bot.forceSell();
      if (result.success) {
        await sendMessage("✅ Sell executed");
      } else {
        await sendMessage(`❌ Sell failed: ${result.error || "Unknown error"}`);
      }
      break;
    }

    case "reset":
    case "cmd_reset": {
      bot.resetState();
      await sendMessage("🗑️ State reset to defaults");
      break;
    }

    case "fix":
    case "cmd_fix": {
      const result = await bot.fixState();
      if (result.success) {
        let msg = `🔧 State fixed!\nTokens: ${result.tokens}\nWatch Price: ${formatPrice(result.watchPrice)} SOL\nSteps: ${result.stepIndex}/3\nPhase: ${result.phase.toUpperCase()}`;
        await sendMessage(msg);
      } else {
        await sendMessage(`❌ Fix failed: ${result.error}`);
      }
      break;
    }

    case "config":
    case "cmd_config": {
      await sendMessage(formatConfig());
      break;
    }

    case "help":
    default: {
      const helpText = `<b>📖 Commands</b>

/status - Show bot status
/start - Start the bot
/stop - Pause the bot
/buy - Force buy (next step)
/sell - Force sell all
/fix - Fix corrupted state (keeps position)
/reset - Reset state (clears all)
/config - Show configuration
/help - Show this message`;
      await sendMessage(helpText, getMainKeyboard());
      break;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN LOOP
// ═══════════════════════════════════════════════════════════════════════════

async function pollLoop() {
  try {
    const updates = await getUpdates();

    for (const update of updates) {
      updateOffset = update.update_id + 1;

      // Handle text commands
      if (update.message?.text) {
        const chatId = String(update.message.chat.id);
        if (chatId !== String(CHAT_ID)) continue;

        const text = update.message.text.trim();
        if (text.startsWith("/")) {
          const cmd = text.slice(1).split(" ")[0].toLowerCase();
          await handleCommand(cmd);
        }
      }

      // Handle button callbacks
      if (update.callback_query) {
        const callbackId = update.callback_query.id;
        const data = update.callback_query.data;

        await answerCallback(callbackId);
        await handleCommand(data);
      }
    }
  } catch (err) {
    console.error("Poll error:", err.message);
  }

  // Schedule next poll
  setTimeout(pollLoop, config.tgPollIntervalMs);
}

async function main() {
  if (!BOT_TOKEN) {
    console.error("Missing TG_BOT_TOKEN in .env");
    process.exit(1);
  }
  if (!CHAT_ID) {
    console.error("Missing TG_CHAT_ID in .env");
    process.exit(1);
  }

  console.log("Telegram bot starting...");
  console.log(`Chat ID: ${CHAT_ID}`);

  // Send startup message
  await sendMessage("🤖 <b>MM-Profit Bot Online</b>\n\nUse /status to see current state.", getMainKeyboard());

  // Start polling
  pollLoop();
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
