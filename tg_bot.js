require("dotenv").config();
const fs = require("fs");
const path = require("path");
const fetch = global.fetch || require("node-fetch");

const BOT_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;
const STATE_PATH = process.env.STATE_PATH || path.join(__dirname, "bot_state.json");
const LOG_PATH = process.env.LOG_PATH || path.join(__dirname, "bot.log");

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("Missing TG_BOT_TOKEN or TG_CHAT_ID in .env");
  process.exit(1);
}

const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;
let updateOffset = 0;

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

function formatStatus() {
  const state = readState();
  const lines = readLogLines();
  const metrics = findLatestMetrics(lines);
  const lastTradePnl = findLastTradePnl(lines);

  const mode = state?.mode || metrics?.mode || "unknown";
  const step = metrics?.step || state?.stepIndex || "--";
  const token = state?.tokenMint || "--";
  const entryHigh = state?.entryHighScaled ? String(state.entryHighScaled) : "--";
  const avg = metrics?.avg || "--";
  const px = metrics?.px || "--";
  const tradePnl = metrics?.tradePnl || "--";
  const walletPnl = metrics?.walletPnl || "--";
  const solBal = metrics?.solBal || "--";

  return [
    "MM Profit Status",
    `Mode: ${mode}`,
    `Step: ${step}`,
    `Token: ${token}`,
    `Avg: ${avg}`,
    `Px: ${px}`,
    `Move: ${metrics?.move || "--"}`,
    `Trade PnL: ${tradePnl}`,
    `Wallet PnL: ${walletPnl}`,
    `SOL Bal: ${solBal}`,
    `Entry High: ${entryHigh}`,
    `Last Trade PnL: ${lastTradePnl || "--"}`,
  ].join("\n");
}

async function sendMessage(text) {
  const res = await fetch(`${API_BASE}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
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

async function pollLoop() {
  try {
    const updates = await getUpdates();
    for (const update of updates) {
      updateOffset = update.update_id + 1;
      const message = update.message?.text || "";
      const chatId = String(update.message?.chat?.id || "");
      if (chatId !== String(CHAT_ID)) {
        continue;
      }
      if (message.startsWith("/status")) {
        await sendMessage(formatStatus());
      }
    }
  } catch (err) {
    console.error("TG bot error:", err.message || err);
  } finally {
    setTimeout(pollLoop, 1000);
  }
}

console.log("Telegram bot running. Commands: /status");
pollLoop();
