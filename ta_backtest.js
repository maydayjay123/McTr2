require("dotenv").config();
const fs = require("fs");
const path = require("path");

const LOG_PATH = process.env.BOT_LOG_PATH || path.join(__dirname, "bot.log");
const OUT_PATH = process.env.BT_OUTPUT || path.join(__dirname, "ta_backtest.txt");
const WINDOW_SEC = Number(process.env.BT_WINDOW_SEC || 3600);
const INTERVAL_MS = Number(process.env.BT_INTERVAL_MS || 5000);

const BASE_PROFIT_BPS = Number(process.env.PROFIT_TARGET_BPS || 200);
const HARD_STOP_BPS = Number(process.env.HARD_STOP_BPS || -5000);
const STEP_DRAWDOWN_PCT = (process.env.STEP_DRAWDOWN_PCT || "0,5,10")
  .split(",")
  .map((v) => Number(v.trim()))
  .filter((v) => Number.isFinite(v));
const PROFIT_STEP_BPS = 25;

const LADDER_VARIANTS = [
  { name: "15/25/60", steps: [15, 25, 60] },
  { name: "10/30/60", steps: [10, 30, 60] },
  { name: "20/20/60", steps: [20, 20, 60] },
  { name: "10/15/15/60", steps: [10, 15, 15, 60] },
];

function parseTime(line) {
  const match = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
  if (!match) return null;
  const ts = new Date(match[1].replace(" ", "T"));
  return Number.isNaN(ts.getTime()) ? null : ts;
}

function parseTableRow(line) {
  if (!line.includes("|")) return null;
  if (line.startsWith("time")) return null;
  const parts = line.split("|").map((p) => p.trim());
  if (parts.length < 10) return null;
  const ts = parseTime(line);
  if (!ts) return null;
  return {
    ts,
    mode: parts[1],
    step: parts[2],
    avg: Number(parts[3]) || null,
    px: Number(parts[4]) || null,
    move: Number(parts[5]) || null,
    posSol: Number(parts[6]) || null,
    tradePnl: Number(parts[7]) || null,
    walletPnl: Number(parts[8]) || null,
    solBal: Number(parts[9]) || null,
  };
}

function readLines(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing log file: ${filePath}`);
  }
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
}

function formatPct(bps) {
  return `${(bps / 100).toFixed(2)}%`;
}

function formatSol(value) {
  return `${value.toFixed(6)} SOL`;
}

function simulateTrade(prices, ladder) {
  if (!prices.length) {
    return null;
  }

  const steps = ladder.steps;
  const drawdowns = STEP_DRAWDOWN_PCT;
  const totalAlloc = 1;
  const stepSol = steps.map((pct) => (pct / 100) * totalAlloc);

  let totalSpent = 0;
  let totalTokens = 0;
  let stepsUsed = 0;
  let entryPrice = prices[0].price;

  function buy(stepIdx, price) {
    const amount = stepSol[stepIdx];
    totalSpent += amount;
    totalTokens += amount / price;
    stepsUsed = stepIdx + 1;
  }

  buy(0, entryPrice);

  for (let i = 1; i < prices.length; i += 1) {
    const price = prices[i].price;
    if (totalTokens <= 0) continue;
    const avgCost = totalSpent / totalTokens;
    const pnlBps = ((price - avgCost) / avgCost) * 10000;
    const drawdownBps = ((avgCost - price) / avgCost) * 10000;
    const targetBps = BASE_PROFIT_BPS + Math.max(stepsUsed - 1, 0) * PROFIT_STEP_BPS;

    if (pnlBps >= targetBps) {
      const realized = totalTokens * price;
      return {
        exitIndex: i,
        pnlSol: realized - totalSpent,
        pnlBps,
        stepsUsed,
        targetBps,
      };
    }

    if (pnlBps <= HARD_STOP_BPS) {
      const realized = totalTokens * price;
      return {
        exitIndex: i,
        pnlSol: realized - totalSpent,
        pnlBps,
        stepsUsed,
        targetBps,
      };
    }

    if (stepsUsed < steps.length) {
      const triggerPct = drawdowns[stepsUsed] ?? drawdowns[drawdowns.length - 1];
      if (drawdownBps >= triggerPct * 100) {
        buy(stepsUsed, price);
      }
    }
  }

  const lastPrice = prices[prices.length - 1].price;
  const realized = totalTokens * lastPrice;
  const pnlBps = ((lastPrice - totalSpent / totalTokens) / (totalSpent / totalTokens)) * 10000;
  return {
    exitIndex: prices.length - 1,
    pnlSol: realized - totalSpent,
    pnlBps,
    stepsUsed,
    targetBps: BASE_PROFIT_BPS + Math.max(stepsUsed - 1, 0) * PROFIT_STEP_BPS,
  };
}

function buildPriceSeries(rows, startTs, endTs) {
  return rows
    .filter((row) => row.ts >= startTs && row.ts <= endTs && row.px)
    .map((row) => ({
      ts: row.ts,
      price: row.px,
    }));
}

function buildLevels(prices) {
  if (!prices.length) return null;
  const vals = prices.map((p) => p.price).sort((a, b) => a - b);
  const min = vals[0];
  const max = vals[vals.length - 1];
  const mid = vals[Math.floor(vals.length / 2)];
  return { min, mid, max, rangePct: ((max - min) / mid) * 100 };
}

function parseTrades(rows) {
  const trades = [];
  let lastMetrics = null;
  let current = null;
  let pendingExit = null;

  rows.forEach((row) => {
    if (row.type === "metric") {
      lastMetrics = row.data;
      if (current && row.data.mode === "POS") {
        const stepMatch = row.data.step.match(/^(\d+)/);
        if (stepMatch) {
          const stepNum = Number(stepMatch[1]);
          if (Number.isFinite(stepNum)) {
            current.maxStep = Math.max(current.maxStep, stepNum);
          }
        }
      }

      if (pendingExit) {
        if (row.data.solBal !== null) {
          pendingExit.exitSol = row.data.solBal;
          pendingExit.exitTs = row.data.ts;
          trades.push(pendingExit);
          pendingExit = null;
          current = null;
        }
      }
    }

    if (row.type === "buy" && lastMetrics) {
      if (!current) {
        current = {
          entryTs: row.ts,
          entrySol: lastMetrics.solBal ?? 0,
          maxStep: 1,
        };
      }
    }

    if (row.type === "sell" && current) {
      pendingExit = {
        ...current,
        sellTs: row.ts,
      };
    }
  });

  return trades
    .filter((t) => t.exitSol !== undefined)
    .map((t) => ({
      entryTs: t.entryTs,
      exitTs: t.exitTs || t.sellTs,
      durationSec: Math.max(0, (t.exitTs - t.entryTs) / 1000),
      entrySol: t.entrySol,
      exitSol: t.exitSol,
      pnlSol: t.exitSol - t.entrySol,
      maxStep: t.maxStep,
    }));
}

function parseRows(lines) {
  const rows = [];
  lines.forEach((line) => {
    const ts = parseTime(line);
    if (!ts) return;
    if (line.includes("BUY confirmed")) {
      rows.push({ type: "buy", ts });
      return;
    }
    if (line.includes("SELL confirmed")) {
      rows.push({ type: "sell", ts });
      return;
    }
    const table = parseTableRow(line);
    if (table) {
      rows.push({ type: "metric", data: table });
    }
  });
  return rows;
}

function formatTable(rows) {
  const header =
    "trade | entry_ts           | exit_ts            | dur_s | steps | real_pnl_sol | sim_variant | sim_pnl_sol | sim_pnl_%";
  const lines = [header];
  rows.forEach((row) => lines.push(row));
  return lines.join("\n");
}

function run() {
  const lines = readLines(LOG_PATH);
  const rows = parseRows(lines);
  const metricRows = rows
    .filter((r) => r.type === "metric")
    .map((r) => r.data);
  const now = new Date();
  const windowStart = new Date(now.getTime() - WINDOW_SEC * 1000);

  const trades = parseTrades(rows).filter(
    (t) => t.entryTs >= windowStart && t.exitTs <= now
  );

  const summaryLines = [];
  summaryLines.push(`window_sec: ${WINDOW_SEC}`);
  summaryLines.push(`profit_target_bps: ${BASE_PROFIT_BPS}`);
  summaryLines.push(`hard_stop_bps: ${HARD_STOP_BPS}`);
  summaryLines.push(`profit_step_bps: ${PROFIT_STEP_BPS}`);
  summaryLines.push("");

  const tableLines = [];
  trades.forEach((trade, idx) => {
    const priceSeries = buildPriceSeries(
      metricRows,
      trade.entryTs,
      trade.exitTs
    );
    const levels = buildLevels(priceSeries);
    summaryLines.push(
      `trade_${idx + 1}: steps_used=${trade.maxStep} real_pnl=${formatSol(
        trade.pnlSol
      )} duration=${trade.durationSec.toFixed(1)}s`
    );
    if (levels) {
      summaryLines.push(
        `  levels: min=${levels.min.toFixed(8)} mid=${levels.mid.toFixed(
          8
        )} max=${levels.max.toFixed(8)} range=${levels.rangePct.toFixed(2)}%`
      );
    }

    LADDER_VARIANTS.forEach((variant) => {
      const sim = simulateTrade(priceSeries, variant);
      if (!sim) return;
      const row = [
        String(idx + 1).padEnd(5),
        trade.entryTs.toISOString().replace("T", " ").slice(0, 19),
        trade.exitTs.toISOString().replace("T", " ").slice(0, 19),
        trade.durationSec.toFixed(1).padStart(6),
        String(trade.maxStep).padStart(5),
        trade.pnlSol.toFixed(6).padStart(12),
        variant.name.padStart(11),
        sim.pnlSol.toFixed(6).padStart(11),
        formatPct(sim.pnlBps).padStart(9),
      ].join(" | ");
      tableLines.push(row);
    });
    summaryLines.push("");
  });

  const output = [
    "TA BACKTEST SUMMARY",
    summaryLines.join("\n"),
    "",
    formatTable(tableLines),
    "",
    "legend: sim_pnl_% uses ladder + profit step rule (0.25% per step).",
  ].join("\n");

  fs.writeFileSync(OUT_PATH, output, "utf8");
  console.log(`[backtest] wrote ${OUT_PATH}`);
}

function loop() {
  try {
    run();
  } catch (err) {
    console.error(`[backtest] failed: ${err.message || err}`);
  }
}

loop();
setInterval(loop, INTERVAL_MS);
