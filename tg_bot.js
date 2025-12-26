require("dotenv").config();
const fs = require("fs");
const path = require("path");
const fetch = global.fetch || require("node-fetch");

const BOT_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;
const STATE_PATH = process.env.STATE_PATH || path.join(__dirname, "bot_state.json");
const LOG_PATH =
  process.env.LOG_PATH ||
  process.env.BOT_LOG_PATH ||
  path.join(__dirname, "botv2.log");
const COMMANDS_PATH =
  process.env.TG_COMMANDS_PATH || path.join(__dirname, "tg_commands.jsonl");
const ALERT_STATE_PATH =
  process.env.TG_ALERT_STATE_PATH || path.join(__dirname, "tg_alert.json");

const DEFAULT_ALERT_MOVE_PCT = Number(process.env.ALERT_MOVE_PCT || 2);
const DEFAULT_ALERT_WINDOW_SEC = Number(process.env.ALERT_WINDOW_SEC || 30);
const DEFAULT_ALERT_COOLDOWN_SEC = Number(process.env.ALERT_COOLDOWN_SEC || 300);

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("Missing TG_BOT_TOKEN or TG_CHAT_ID in .env");
  process.exit(1);
}

const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;
let updateOffset = 0;
let alertConfig = {
  movePct: DEFAULT_ALERT_MOVE_PCT,
  windowSec: DEFAULT_ALERT_WINDOW_SEC,
  cooldownSec: DEFAULT_ALERT_COOLDOWN_SEC,
};
let alertSamples = [];
let lastAlertAt = 0;

function readAlertConfig() {
  try {
    if (!fs.existsSync(ALERT_STATE_PATH)) return;
    const raw = fs.readFileSync(ALERT_STATE_PATH, "utf8");
    if (!raw.trim()) return;
    const data = JSON.parse(raw);
    if (typeof data.movePct === "number") alertConfig.movePct = data.movePct;
    if (typeof data.windowSec === "number") alertConfig.windowSec = data.windowSec;
    if (typeof data.cooldownSec === "number")
      alertConfig.cooldownSec = data.cooldownSec;
  } catch (err) {
    console.error("Alert config read failed:", err.message || err);
  }
}

function writeAlertConfig() {
  try {
    fs.writeFileSync(ALERT_STATE_PATH, JSON.stringify(alertConfig), "utf8");
  } catch (err) {
    console.error("Alert config write failed:", err.message || err);
  }
}

function readState() {
  try {
    if (!fs.existsSync(STATE_PATH)) return null;
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readLogLines() {
  try {
    if (!fs.existsSync(LOG_PATH)) return [];
    return fs.readFileSync(LOG_PATH, "utf8").split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function parseTableRow(line) {
  if (!line.includes("|")) return null;
  if (line.startsWith("time")) return null;
  const parts = line.split("|").map((p) => p.trim());
  if (parts.length < 10) return null;
  const time = parts[0];
  const mode = parts[1];
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(time)) return null;
  if (mode !== "WAIT" && mode !== "POS") return null;
  return {
    time: parts[0],
    mode: parts[1],
    step: parts[2],
    avg: parts[3],
    px: parts[4],
    move: parts[5],
    posSol: parts[6],
    tradePnl: parts[7],
    walletPnl: parts[8],
    solBal: parts[9],
  };
}

function parsePrice(value) {
  const match = String(value || "").match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const num = Number(match[0]);
  return Number.isFinite(num) ? num : null;
}

function parseLogTime(value) {
  const stamp = String(value || "").replace(" ", "T");
  const parsed = new Date(stamp);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.getTime();
}

function findLatestMetrics(lines) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const row = parseTableRow(lines[i]);
    if (row) return row;
  }
  return null;
}

function findLastTradePnl(lines) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].includes("SELL confirmed")) continue;
    for (let j = i + 1; j < lines.length; j += 1) {
      const row = parseTableRow(lines[j]);
      if (row) return row.walletPnl;
    }
  }
  return null;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatSol(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "--";
  return num.toFixed(8);
}

function lamportsToSol(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return num / 1e9;
}

function countTrades(lines) {
  return lines.filter((line) => line.includes("SELL confirmed")).length;
}

function computeTargetBps(stepLabel) {
  const base = Number(process.env.PROFIT_TARGET_BPS || 200);
  const stepBump = 25;
  const match = String(stepLabel || "").match(/^(\d+)/);
  const stepNum = match ? Number(match[1]) : 1;
  return base + Math.max(stepNum - 1, 0) * stepBump;
}

function formatStatus() {
  const state = readState();
  const lines = readLogLines();
  const metrics = findLatestMetrics(lines);
  const lastTradePnl = findLastTradePnl(lines);

  const mode = state?.mode || metrics?.mode || "unknown";
  const step = metrics?.step || state?.stepIndex || "--";
  const token = state?.tokenMint || "--";
  const avg = metrics?.avg || "--";
  const px = metrics?.px || "--";
  const move = metrics?.move || "--";
  const tradePnl = metrics?.tradePnl || "--";
  const walletPnl = metrics?.walletPnl || "--";
  const solBal = metrics?.solBal || "--";
  const tradeCount = countTrades(lines);
  const trailStart = Number(process.env.TRAILING_START_PCT || 0);
  const trailGap = Number(process.env.TRAILING_GAP_PCT || 0);
  const trailPeak = state?.trailPeakBps ? Number(state.trailPeakBps) / 100 : null;

  let tradePnlPct = "--";
  if (metrics?.posSol && metrics?.tradePnl) {
    const posSol = Number(metrics.posSol);
    const tradePnlNum = Number(metrics.tradePnl);
    if (Number.isFinite(posSol) && posSol !== 0 && Number.isFinite(tradePnlNum)) {
      tradePnlPct = `${((tradePnlNum / posSol) * 100).toFixed(2)}%`;
    }
  }

  const targetBps = computeTargetBps(step);
  const tpPct = `${(targetBps / 100).toFixed(2)}%`;

  const tokenShort =
    token.length > 16 ? `${token.slice(0, 6)}...${token.slice(-6)}` : token;
  const avgShort = avg === "--" ? "--" : Number(avg).toFixed(8);
  const pxShort = px === "--" ? "--" : Number(px).toFixed(8);
  const startSol = lamportsToSol(state?.startSolBalanceLamports);
  const currentSol = Number.isFinite(Number(solBal)) ? Number(solBal) : null;
  const sessionPnl =
    startSol !== null && currentSol !== null ? currentSol - startSol : null;
  const sessionPct =
    startSol && sessionPnl !== null ? (sessionPnl / startSol) * 100 : null;

  const sessionStartText = startSol !== null ? startSol.toFixed(6) : "--";
  const sessionNowText = currentSol !== null ? currentSol.toFixed(6) : "--";
  const sessionPnlText =
    sessionPnl !== null
      ? `${sessionPnl >= 0 ? "+" : ""}${sessionPnl.toFixed(6)}`
      : "--";
  const sessionPctText =
    sessionPct !== null && Number.isFinite(sessionPct)
      ? `${sessionPct.toFixed(2)}%`
      : "--";

  const liveSol = tradePnl;
  const livePct = tradePnlPct;
  const liveBox = [
    "+-----------+",
    "| LIVE      |",
    `| ${liveSol.padEnd(9)}|`,
    `| ${livePct.padEnd(9)}|`,
    "+-----------+",
  ];

  const sheetLines = [
    "MM PROFIT :: STATUS",
    "--------------------",
    `MODE     : ${mode}`,
    `STEP     : ${step}   TRADES: ${tradeCount}`,
    `TOKEN    : ${tokenShort}`,
    "",
    `AVG      : ${avgShort}`,
    `PX       : ${pxShort}`,
    `MOVE     : ${move}`,
    "",
    `TP TARGET: ${tpPct}`,
    `TRAIL    : ${trailStart.toFixed(1)}%/${trailGap.toFixed(1)}%` +
      `${trailPeak !== null ? `  PEAK ${trailPeak.toFixed(2)}%` : ""}`,
    "",
    `SESSION  : ${sessionStartText} -> ${sessionNowText} SOL`,
    `SESSION$ : ${sessionPnlText} (${sessionPctText})`,
    "",
    `WALLET   : ${formatSol(walletPnl)} SOL`,
    `SOL BAL  : ${formatSol(solBal)} SOL`,
    `LAST PNL : ${formatSol(lastTradePnl || "--")} SOL`,
  ];

  const innerPad = 1;
  const gap = "  ";
  const liveWidth = liveBox[0].length;
  const baseWidth = Math.max(...sheetLines.map((line) => line.length));
  const leftBlockWidth = baseWidth + innerPad * 2;
  const totalWidth = Math.max(leftBlockWidth + gap.length + liveWidth, leftBlockWidth);
  const border = `+${"-".repeat(totalWidth + 2)}+`;

  const liveRowStart = 2;
  const boxLines = sheetLines.map((line, idx) => {
    const liveIdx = idx - liveRowStart;
    const left = " ".repeat(innerPad) + line.padEnd(baseWidth) + " ".repeat(innerPad);
    const right =
      liveIdx >= 0 && liveIdx < liveBox.length
        ? gap + liveBox[liveIdx]
        : " ".repeat(gap.length + liveWidth);
    const content = (left + right).padEnd(totalWidth);
    return `| ${content} |`;
  });
  const boxed = [border, ...boxLines, border].join("\n");
  return `<pre>${escapeHtml(boxed)}</pre>`;
}

function appendCommand(action) {
  const payload = {
    ts: new Date().toISOString(),
    action,
  };
  try {
    fs.appendFileSync(COMMANDS_PATH, `${JSON.stringify(payload)}\n`, "utf8");
  } catch (err) {
    console.error("Failed to write command:", err.message || err);
  }
}

async function sendMessage(text) {
  const res = await fetch(`${API_BASE}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Start bot", callback_data: "bot_start" },
            { text: "Stop bot", callback_data: "bot_stop" },
          ],
          [
            { text: "Force sell", callback_data: "bot_force_sell" },
            { text: "Force buy", callback_data: "bot_force_buy" },
          ],
        ],
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`sendMessage failed: ${res.status} ${body}`);
  }
}

async function sendAlert(text) {
  const res = await fetch(`${API_BASE}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: "HTML",
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`sendMessage failed: ${res.status} ${body}`);
  }
}

async function getUpdates() {
  const url = new URL(`${API_BASE}/getUpdates`);
  url.searchParams.set("timeout", "30");
  url.searchParams.set("offset", String(updateOffset));
  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`getUpdates failed: ${res.status} ${body}`);
  }
  const data = await res.json();
  return data.result || [];
}

async function checkMoveAlert() {
  const lines = readLogLines();
  const metrics = findLatestMetrics(lines);
  if (!metrics) return;
  const price = parsePrice(metrics.px);
  if (price === null) return;
  const timeMs = parseLogTime(metrics.time) || Date.now();

  alertSamples.push({ ts: timeMs, price });
  const windowMs = alertConfig.windowSec * 1000;
  alertSamples = alertSamples.filter((s) => timeMs - s.ts <= windowMs);
  if (alertSamples.length < 2) return;

  let min = alertSamples[0].price;
  let max = alertSamples[0].price;
  for (const sample of alertSamples) {
    min = Math.min(min, sample.price);
    max = Math.max(max, sample.price);
  }

  const deltaPct = min > 0 ? ((max - min) / min) * 100 : 0;
  const now = Date.now();
  if (deltaPct < alertConfig.movePct) return;
  if (now - lastAlertAt < alertConfig.cooldownSec * 1000) return;
  lastAlertAt = now;

  const oldest = alertSamples[0];
  const direction = price >= oldest.price ? "up" : "down";
  await sendAlert(
    `PRICE spike ${direction} | delta ${deltaPct.toFixed(2)}% in ${alertConfig.windowSec}s\n` +
      `Current PX: <b>${price.toFixed(8)}</b>`
  );
}

async function answerCallbackQuery(callbackId, text) {
  const res = await fetch(`${API_BASE}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackId,
      text,
      show_alert: false,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`answerCallbackQuery failed: ${res.status} ${body}`);
  }
}

async function pollLoop() {
  try {
    const updates = await getUpdates();
    for (const update of updates) {
      updateOffset = update.update_id + 1;
      const message = update.message?.text || "";
      const chatId = String(update.message?.chat?.id || "");
      const callback = update.callback_query;
      const callbackChatId = String(callback?.message?.chat?.id || "");

      if (message) {
        if (chatId !== String(CHAT_ID)) continue;
        if (message.startsWith("/status")) {
          await sendMessage(formatStatus());
        } else if (/^\/setalert\b/.test(message) || /^\/setalert\b/.test(message)) {
          const parts = message.trim().split(/\s+/);
          const pct = Number(parts[1]);
          const windowSec = Number(parts[2]);
          const cooldownSec = Number(parts[3]);
          if (
            Number.isFinite(pct) &&
            Number.isFinite(windowSec) &&
            Number.isFinite(cooldownSec)
          ) {
            alertConfig = { movePct: pct, windowSec, cooldownSec };
            writeAlertConfig();
            await sendMessage(
              `<b>Alert updated</b>\nPRICE delta ${pct}% in ${windowSec}s\nCooldown ${cooldownSec}s`
            );
          } else {
            await sendMessage(
              "<b>Usage</b>: /setalert <movePct> <windowSec> <cooldownSec>\nExample: /setalert 2 30 300"
            );
          }
        } else if (message.startsWith("/alert")) {
          await sendMessage(
            `<b>Alert</b>\nPRICE delta ${alertConfig.movePct}% in ${alertConfig.windowSec}s\nCooldown ${alertConfig.cooldownSec}s`
          );
        }
      }

      if (callback) {
        if (callbackChatId !== String(CHAT_ID)) continue;
        const action = callback.data;
        if (action) {
          appendCommand(action);
          await answerCallbackQuery(callback.id, `Queued: ${action}`);
        }
      }
    }
  } catch (err) {
    console.error("TG bot error:", err.message || err);
  } finally {
    setTimeout(pollLoop, 1000);
  }
}

console.log("Telegram bot running. Commands: /status");
readAlertConfig();
setInterval(() => {
  checkMoveAlert().catch((err) => {
    console.error("Alert check failed:", err.message || err);
  });
}, 5000);
pollLoop();
