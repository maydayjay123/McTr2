require("dotenv").config();
const fs = require("fs");
const path = require("path");
const fetch = global.fetch || require("node-fetch");
const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
  Transaction,
} = require("@solana/web3.js");

const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUP_BASE_URL = process.env.JUPITER_API_BASE || "https://lite-api.jup.ag";
const RPC_URLS = (process.env.SOLANA_RPC_URLS || process.env.RPC_URLS || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const RPC_URL = process.env.SOLANA_RPC_URL;

const VOL_TARGET_MINT = process.env.VOL_TARGET_MINT || process.env.TARGET_MINT;
const WALLETS_FILE =
  process.env.VOL_WALLETS_FILE || path.join(__dirname, "vol_wallets.json");
const STATE_FILE =
  process.env.VOL_STATE_FILE || path.join(__dirname, "botvol_state.json");
const COMMANDS_FILE =
  process.env.VOL_COMMANDS_PATH || path.join(__dirname, "vol_commands.jsonl");
const LOG_FILE =
  process.env.VOL_LOG_PATH || path.join(__dirname, "botvol.log");
const DATA_LOG =
  process.env.VOL_DATA_LOG_PATH || path.join(__dirname, "botvol_data.log");

const DEFAULT_VOL_WALLET_COUNT = 2;
const DEFAULT_MM_WALLET_COUNT = 1;
const DEFAULT_VOL_SPLIT_PCT = 30;
const DEFAULT_RESERVE_SOL = 0.02;
const DEFAULT_POLL_MS = 5000;
const DEFAULT_BUY_COUNT = 10;
const DEFAULT_SELL_CHUNKS = 2;
const DEFAULT_VOL_USE_PCT = 90;
const DEFAULT_BUY_DELAY_MS = 1000;
const DEFAULT_SLIPPAGE_BPS = 100;
const DEFAULT_MM_ACTION_MS = 30000;
const DEFAULT_MM_TRADE_PCT = 10;
const DEFAULT_MM_MAX_TRADE_SOL = 0.02;
const DEFAULT_MM_MIN_TRADE_SOL = 0.002;
const DEFAULT_MM_PING_PCT = 0.6;
const DEFAULT_MM_DRIFT_PCT = 0.3;
const DEFAULT_MM_RANGE_PCT = 0.8;
const DEFAULT_MM_SELL_PCT = 25;
const PRICE_QUOTE_LAMPORTS = 5_000_000n;
const SWEEP_MAX_RETRIES = 3;
const SWEEP_RETRY_DELAY_MS = 2000;
const SWEEP_KEEP_LAMPORTS = 5000n;

const BALANCE_THRESHOLD_LAMPORTS = 100000n;

function ts() {
  return new Date().toISOString().replace("T", " ").split(".")[0];
}

function logLine(line) {
  const output = `${ts()} | ${line}`;
  console.log(output);
  fs.appendFileSync(LOG_FILE, `${output}\n`, "utf8");
}

function logInfo(message, fields) {
  const extra =
    fields && Object.keys(fields).length
      ? ` | ${Object.entries(fields)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")}`
      : "";
  logLine(`INFO | ${message}${extra}`);
}

function logWarn(message, fields) {
  const extra =
    fields && Object.keys(fields).length
      ? ` | ${Object.entries(fields)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")}`
      : "";
  logLine(`WARN | ${message}${extra}`);
}

function logError(message, fields) {
  const extra =
    fields && Object.keys(fields).length
      ? ` | ${Object.entries(fields)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")}`
      : "";
  logLine(`ERROR | ${message}${extra}`);
}

function logData(event, payload) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    event,
    ...payload,
  });
  fs.appendFileSync(DATA_LOG, `${line}\n`, "utf8");
}

function lamportsFromSol(sol) {
  return BigInt(Math.round(sol * 1e9));
}

function formatSol(lamports) {
  const value = lamports < 0n ? -lamports : lamports;
  const whole = value / 1_000_000_000n;
  const frac = value % 1_000_000_000n;
  return `${whole.toString()}.${frac.toString().padStart(9, "0").slice(0, 6)}`;
}

function buildRpcUrls() {
  const list = [];
  if (RPC_URL) list.push(RPC_URL);
  for (const url of RPC_URLS) {
    if (url && !list.includes(url)) list.push(url);
  }
  return list;
}

function loadWalletFile() {
  if (!fs.existsSync(WALLETS_FILE)) {
    return { parent: null, volWallets: [], mmWallets: [] };
  }
  const raw = fs.readFileSync(WALLETS_FILE, "utf8");
  if (!raw.trim()) {
    return { parent: null, volWallets: [], mmWallets: [] };
  }
  return JSON.parse(raw);
}

function saveWalletFile(data) {
  fs.writeFileSync(WALLETS_FILE, JSON.stringify(data, null, 2), "utf8");
}

function ensureWallets(state) {
  const data = loadWalletFile();
  if (!data.parent) {
    const parent = Keypair.generate();
    data.parent = {
      publicKey: parent.publicKey.toBase58(),
      secretKey: Array.from(parent.secretKey),
    };
    logInfo("Created parent wallet", { pubkey: data.parent.publicKey });
  }

  data.volWallets = data.volWallets || [];
  data.mmWallets = data.mmWallets || [];

  while (data.volWallets.length < state.volWalletCount) {
    const kp = Keypair.generate();
    data.volWallets.push({
      publicKey: kp.publicKey.toBase58(),
      secretKey: Array.from(kp.secretKey),
    });
  }
  while (data.mmWallets.length < state.mmWalletCount) {
    const kp = Keypair.generate();
    data.mmWallets.push({
      publicKey: kp.publicKey.toBase58(),
      secretKey: Array.from(kp.secretKey),
    });
  }
  saveWalletFile(data);
  return data;
}

function readState() {
  if (!fs.existsSync(STATE_FILE)) return null;
  const raw = fs.readFileSync(STATE_FILE, "utf8");
  if (!raw.trim()) return null;
  return JSON.parse(raw);
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function readCommands(lastIndex) {
  if (!fs.existsSync(COMMANDS_FILE)) {
    return { entries: [], nextIndex: lastIndex };
  }
  const raw = fs.readFileSync(COMMANDS_FILE, "utf8");
  if (!raw.trim()) {
    return { entries: [], nextIndex: lastIndex };
  }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  let start = Number.isFinite(lastIndex) ? lastIndex : 0;
  if (start > lines.length) {
    logWarn("Command index reset", {
      lastIndex: start,
      lines: lines.length,
    });
    start = 0;
  }
  const entries = [];
  for (let i = start; i < lines.length; i += 1) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry?.action) entries.push(entry);
    } catch (err) {
      logWarn("Command parse failed", { error: err.message || err });
    }
  }
  return { entries, nextIndex: lines.length };
}

function parseCommand(entry) {
  const action = String(entry.action || "").trim();
  const parts = action.split(/\s+/).filter(Boolean);
  return { name: parts[0].toLowerCase(), args: parts.slice(1) };
}

function ensureState() {
  let state = readState();
  if (!state) {
    state = {
      running: false,
      volWalletCount: DEFAULT_VOL_WALLET_COUNT,
      mmWalletCount: DEFAULT_MM_WALLET_COUNT,
      volSplitPct: DEFAULT_VOL_SPLIT_PCT,
      reserveSol: DEFAULT_RESERVE_SOL,
      buyCount: DEFAULT_BUY_COUNT,
      sellChunks: DEFAULT_SELL_CHUNKS,
      volUsePct: DEFAULT_VOL_USE_PCT,
      buyDelayMs: DEFAULT_BUY_DELAY_MS,
      pollMs: DEFAULT_POLL_MS,
      slippageBps: DEFAULT_SLIPPAGE_BPS,
      lastCommandLine: 0,
      lastDistributionTs: 0,
      lastParentBalanceLamports: null,
      stats: {
        buys: 0,
        sells: 0,
        mmBuys: 0,
        mmSells: 0,
        mmVolumeSol: 0,
        volumeSol: 0,
        lastSweepTs: null,
      },
      cycles: {},
      mmCycles: {},
      mmStrategy: {
        actionMs: DEFAULT_MM_ACTION_MS,
        tradePct: DEFAULT_MM_TRADE_PCT,
        maxTradeSol: DEFAULT_MM_MAX_TRADE_SOL,
        minTradeSol: DEFAULT_MM_MIN_TRADE_SOL,
        pingPct: DEFAULT_MM_PING_PCT,
        driftPct: DEFAULT_MM_DRIFT_PCT,
        rangePct: DEFAULT_MM_RANGE_PCT,
        sellPct: DEFAULT_MM_SELL_PCT,
      },
      mmPrice: {
        ema: null,
        last: null,
        ts: null,
      },
      targetMint: VOL_TARGET_MINT || "",
    };
    writeState(state);
  }
  if (!state.targetMint) {
    state.targetMint = VOL_TARGET_MINT || "";
  }
  if (!state.stats) {
    state.stats = { buys: 0, sells: 0, volumeSol: 0, lastSweepTs: null };
  }
  if (state.stats.mmBuys === undefined) state.stats.mmBuys = 0;
  if (state.stats.mmSells === undefined) state.stats.mmSells = 0;
  if (state.stats.mmVolumeSol === undefined) state.stats.mmVolumeSol = 0;
  if (!state.cycles) state.cycles = {};
  if (!state.mmCycles) state.mmCycles = {};
  if (!state.mmStrategy) {
    state.mmStrategy = {
      actionMs: DEFAULT_MM_ACTION_MS,
      tradePct: DEFAULT_MM_TRADE_PCT,
      maxTradeSol: DEFAULT_MM_MAX_TRADE_SOL,
      minTradeSol: DEFAULT_MM_MIN_TRADE_SOL,
      pingPct: DEFAULT_MM_PING_PCT,
      driftPct: DEFAULT_MM_DRIFT_PCT,
      rangePct: DEFAULT_MM_RANGE_PCT,
      sellPct: DEFAULT_MM_SELL_PCT,
    };
  }
  if (!state.mmPrice) {
    state.mmPrice = { ema: null, last: null, ts: null };
  } else if (state.mmPrice.ts === undefined) {
    state.mmPrice.ts = null;
  }
  return state;
}

function getCycle(state, pubkey) {
  if (!state.cycles[pubkey]) {
    state.cycles[pubkey] = {
      buyCount: 0,
      sellStage: 0,
      lastActionTs: 0,
    };
  }
  return state.cycles[pubkey];
}

function getMmCycle(state, pubkey) {
  if (!state.mmCycles) state.mmCycles = {};
  if (!state.mmCycles[pubkey]) {
    state.mmCycles[pubkey] = {
      lastActionTs: 0,
      lastTradePrice: null,
    };
  }
  return state.mmCycles[pubkey];
}

function shouldWait(cycle, delayMs) {
  return Date.now() - cycle.lastActionTs < delayMs;
}

function buildUrls(pathSuffixes) {
  const base = JUP_BASE_URL.replace(/\/+$/, "");
  return pathSuffixes.map((suffix) => `${base}${suffix}`);
}

async function fetchWithFallback(urls, label) {
  for (const url of urls) {
    const response = await fetch(url);
    if (response.ok) {
      return { response, url };
    }
    if (response.status !== 404) {
      const body = await response.text();
      throw new Error(`${label} failed: ${response.status} ${body} (${url})`);
    }
  }
  throw new Error(`${label} failed: endpoint not found (404)`);
}

async function fetchQuote(inputMint, outputMint, amount, slippageBps) {
  const liteFallbacks = buildUrls(["/swap/v1/quote", "/quote", "/v1/quote"]);
  const defaultUrls = buildUrls(["/v6/quote"]);
  const urls = JUP_BASE_URL.includes("lite-api.jup.ag")
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

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

async function getMidPrice(connection, mint) {
  const quote = await fetchQuote(
    SOL_MINT,
    mint,
    PRICE_QUOTE_LAMPORTS,
    DEFAULT_SLIPPAGE_BPS
  );
  const outAmount = Number(quote.outAmount || 0);
  if (!outAmount) {
    throw new Error("Price quote returned zero outAmount");
  }
  const price = Number(PRICE_QUOTE_LAMPORTS) / outAmount;
  return price;
}

async function fetchSwapTransaction(quote, userPublicKey) {
  const liteFallbacks = buildUrls(["/swap/v1/swap", "/swap", "/v1/swap"]);
  const defaultUrls = buildUrls(["/v6/swap"]);
  const urls = JUP_BASE_URL.includes("lite-api.jup.ag")
    ? liteFallbacks.concat(defaultUrls)
    : defaultUrls;

  let response = null;
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
        }),
      });
    } catch (err) {
      lastError = err;
      continue;
    }
    if (response.ok) break;
    if (response.status !== 404) {
      const body = await response.text();
      throw new Error(`Swap failed: ${response.status} ${body} (${url})`);
    }
  }
  if (!response || !response.ok) {
    throw new Error(
      lastError ? `Swap fetch failed: ${lastError.message || lastError}` : "Swap failed"
    );
  }
  const data = await response.json();
  if (!data?.swapTransaction) {
    throw new Error("Swap response missing transaction");
  }
  return data.swapTransaction;
}

async function executeSwap(connection, keypair, quote) {
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
  return signature;
}

async function getTokenBalance(connection, owner, mint) {
  const accounts = await connection.getTokenAccountsByOwner(
    owner,
    { mint },
    "confirmed"
  );
  if (!accounts.value.length) {
    return { amount: 0n, decimals: 0 };
  }
  const balances = await Promise.all(
    accounts.value.map((account) =>
      connection.getTokenAccountBalance(account.pubkey, "confirmed")
    )
  );
  const decimals = Number(balances[0].value.decimals);
  const amount = balances.reduce(
    (acc, balance) => acc + BigInt(balance.value.amount),
    0n
  );
  return { amount, decimals };
}

async function transferSol(connection, fromKeypair, toPubkey, lamports) {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: fromKeypair.publicKey,
      toPubkey,
      lamports: Number(lamports),
    })
  );
  const signature = await connection.sendTransaction(tx, [fromKeypair], {
    skipPreflight: false,
    maxRetries: 3,
  });
  return signature;
}

async function main() {
  const rpcUrls = buildRpcUrls();
  if (!rpcUrls.length) {
    logError("Missing SOLANA_RPC_URL or SOLANA_RPC_URLS");
    process.exit(1);
  }
  if (!VOL_TARGET_MINT) {
    logError("Missing VOL_TARGET_MINT or TARGET_MINT");
    process.exit(1);
  }

  let rpcIndex = 0;
  let connection = new Connection(rpcUrls[rpcIndex], "confirmed");

  let state = ensureState();
  if (VOL_TARGET_MINT && state.targetMint !== VOL_TARGET_MINT) {
    state.targetMint = VOL_TARGET_MINT;
    writeState(state);
    logInfo("Target mint updated from env", { mint: state.targetMint });
  }
  let wallets = ensureWallets(state);
  const parentKeypair = Keypair.fromSecretKey(
    Uint8Array.from(wallets.parent.secretKey)
  );
  const mintPubkey = new PublicKey(state.targetMint);

  logInfo("VOL config", {
    target: state.targetMint,
    volWallets: state.volWalletCount,
    mmWallets: state.mmWalletCount,
    split: `${state.volSplitPct}/${100 - state.volSplitPct}`,
  });
  logInfo("MM config", {
    actionMs: state.mmStrategy.actionMs,
    tradePct: state.mmStrategy.tradePct,
    maxTradeSol: state.mmStrategy.maxTradeSol,
    minTradeSol: state.mmStrategy.minTradeSol,
    pingPct: state.mmStrategy.pingPct,
    driftPct: state.mmStrategy.driftPct,
    rangePct: state.mmStrategy.rangePct,
    sellPct: state.mmStrategy.sellPct,
  });

  while (true) {
    const pollMs = state.pollMs || DEFAULT_POLL_MS;
    try {
      connection = new Connection(rpcUrls[rpcIndex], "confirmed");
      rpcIndex = (rpcIndex + 1) % rpcUrls.length;

      const commandRead = readCommands(state.lastCommandLine);
      if (commandRead.entries.length) {
        let walletConfigChanged = false;
        for (const entry of commandRead.entries) {
          const cmd = parseCommand(entry);
          if (cmd.name === "vol_start") {
            state.running = true;
            logInfo("CMD vol_start");
          } else if (cmd.name === "vol_stop") {
            state.running = false;
            logInfo("CMD vol_stop");
          } else if (cmd.name === "vol_set_vol") {
            const count = Number(cmd.args[0]);
            if (Number.isFinite(count) && count > 0) {
              state.volWalletCount = Math.floor(count);
              walletConfigChanged = true;
              logInfo("CMD vol_set_vol", { count: state.volWalletCount });
            }
          } else if (cmd.name === "vol_set_mm") {
            const count = Number(cmd.args[0]);
            if (Number.isFinite(count) && count > 0) {
              state.mmWalletCount = Math.floor(count);
              walletConfigChanged = true;
              logInfo("CMD vol_set_mm", { count: state.mmWalletCount });
            }
          } else if (cmd.name === "vol_set_reserve") {
            const reserve = Number(cmd.args[0]);
            if (Number.isFinite(reserve) && reserve >= 0) {
              state.reserveSol = reserve;
              logInfo("CMD vol_set_reserve", { sol: reserve });
            }
          } else if (cmd.name === "vol_sweep") {
            state.sweep = true;
            logInfo("CMD vol_sweep");
          }
        }
        state.lastCommandLine = commandRead.nextIndex;
        writeState(state);
        if (walletConfigChanged) {
          wallets = ensureWallets(state);
          logInfo("Wallets refreshed", {
            volWallets: wallets.volWallets.length,
            mmWallets: wallets.mmWallets.length,
          });
        }
      }

      if (!state.running) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        continue;
      }

      const parentBalance = BigInt(
        await connection.getBalance(parentKeypair.publicKey, "confirmed")
      );
      state.lastParentBalanceLamports = parentBalance.toString();
      writeState(state);

      if (state.sweep) {
        logInfo("SWEEP start");
        const volWallets = wallets.volWallets.slice(0, state.volWalletCount);
        const mmWallets = wallets.mmWallets.slice(0, state.mmWalletCount);
        const sweepWallets = volWallets.concat(mmWallets);
        for (const wallet of sweepWallets) {
          const keypair = Keypair.fromSecretKey(
            Uint8Array.from(wallet.secretKey)
          );
          let tokenBal = await getTokenBalance(
            connection,
            keypair.publicKey,
            mintPubkey
          );
          let attempts = 0;
          while (tokenBal.amount > 0n && attempts < SWEEP_MAX_RETRIES) {
            const quote = await fetchQuote(
              state.targetMint,
              SOL_MINT,
              tokenBal.amount,
              state.slippageBps
            );
            logData("quote", {
              type: "sell",
              wallet: wallet.publicKey,
              inAmount: tokenBal.amount.toString(),
              outAmount: quote.outAmount,
            });
            const sig = await executeSwap(connection, keypair, quote);
            logInfo("Sweep sell", {
              wallet: wallet.publicKey,
              sig,
              attempt: attempts + 1,
            });
            await new Promise((resolve) =>
              setTimeout(resolve, SWEEP_RETRY_DELAY_MS)
            );
            tokenBal = await getTokenBalance(
              connection,
              keypair.publicKey,
              mintPubkey
            );
            attempts += 1;
          }
          if (tokenBal.amount > 0n) {
            logWarn("Sweep sell incomplete", {
              wallet: wallet.publicKey,
              remaining: tokenBal.amount.toString(),
            });
            continue;
          }

          const solBal = BigInt(
            await connection.getBalance(keypair.publicKey, "confirmed")
          );
          if (solBal > SWEEP_KEEP_LAMPORTS + BALANCE_THRESHOLD_LAMPORTS) {
            const delta = solBal - SWEEP_KEEP_LAMPORTS;
            const sig = await transferSol(
              connection,
              keypair,
              parentKeypair.publicKey,
              delta
            );
            logInfo("Sweep sol", {
              wallet: wallet.publicKey,
              sol: formatSol(delta),
              sig,
            });
          }
        }
        state.stats.lastSweepTs = new Date().toISOString();
        state.running = false;
        state.sweep = false;
        writeState(state);
        logInfo("SWEEP complete");
        logInfo("SWEEP stopped bot");
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        continue;
      }

      const reserveLamports = lamportsFromSol(state.reserveSol);
      const availableParent =
        parentBalance > reserveLamports ? parentBalance - reserveLamports : 0n;

      if (availableParent < BALANCE_THRESHOLD_LAMPORTS) {
        logWarn("Parent balance too low", { sol: formatSol(parentBalance) });
      } else if (Date.now() - state.lastDistributionTs > 60000) {
        const volCount = state.volWalletCount;
        const mmCount = state.mmWalletCount;
        const volPct = state.volSplitPct;
        const mmPct = 100 - volPct;
        const volTarget = (availableParent * BigInt(volPct)) / 100n;
        const mmTarget = (availableParent * BigInt(mmPct)) / 100n;

        const volWallets = wallets.volWallets.slice(0, volCount);
        const mmWallets = wallets.mmWallets.slice(0, mmCount);

        for (const wallet of volWallets) {
          const walletBal = BigInt(
            await connection.getBalance(new PublicKey(wallet.publicKey), "confirmed")
          );
          const target = volTarget / BigInt(Math.max(volCount, 1));
          if (walletBal + BALANCE_THRESHOLD_LAMPORTS < target) {
            const delta = target - walletBal;
            const sig = await transferSol(
              connection,
              parentKeypair,
              new PublicKey(wallet.publicKey),
              delta
            );
            logInfo("Transfer to vol wallet", {
              wallet: wallet.publicKey,
              sol: formatSol(delta),
              sig,
            });
          }
        }

        for (const wallet of mmWallets) {
          const walletBal = BigInt(
            await connection.getBalance(new PublicKey(wallet.publicKey), "confirmed")
          );
          const target = mmTarget / BigInt(Math.max(mmCount, 1));
          if (walletBal + BALANCE_THRESHOLD_LAMPORTS < target) {
            const delta = target - walletBal;
            const sig = await transferSol(
              connection,
              parentKeypair,
              new PublicKey(wallet.publicKey),
              delta
            );
            logInfo("Transfer to mm wallet", {
              wallet: wallet.publicKey,
              sol: formatSol(delta),
              sig,
            });
          }
        }
        state.lastDistributionTs = Date.now();
        writeState(state);
      }

 

      const volWallets = wallets.volWallets.slice(0, state.volWalletCount);
      for (const wallet of volWallets) {
        const keypair = Keypair.fromSecretKey(Uint8Array.from(wallet.secretKey));
        const cycle = getCycle(state, wallet.publicKey);
        if (shouldWait(cycle, state.buyDelayMs)) {
          continue;
        }
        const solBal = BigInt(
          await connection.getBalance(keypair.publicKey, "confirmed")
        );
        const reserve = lamportsFromSol(state.reserveSol);
        const tokenBal = await getTokenBalance(connection, keypair.publicKey, mintPubkey);

        if (cycle.buyCount >= state.buyCount) {
          if (tokenBal.amount === 0n) {
            cycle.buyCount = 0;
            cycle.sellStage = 0;
            continue;
          }
          if (cycle.sellStage < state.sellChunks) {
            const remaining = state.sellChunks - cycle.sellStage;
            const amount = tokenBal.amount / BigInt(remaining);
            if (amount > 0n) {
              const quote = await fetchQuote(
                state.targetMint,
                SOL_MINT,
                amount,
                state.slippageBps
              );
              logData("quote", {
                type: "sell",
                wallet: wallet.publicKey,
                inAmount: amount.toString(),
                outAmount: quote.outAmount,
              });
              const sig = await executeSwap(connection, keypair, quote);
              state.stats.sells += 1;
              logInfo("Vol sell", { wallet: wallet.publicKey, sig });
              cycle.sellStage += 1;
              cycle.lastActionTs = Date.now();
              writeState(state);
            }
          } else {
            cycle.buyCount = 0;
            cycle.sellStage = 0;
          }
          continue;
        }

        if (solBal <= reserve + BALANCE_THRESHOLD_LAMPORTS) {
          continue;
        }
        const spendable = solBal - reserve;
        const alloc = (spendable * BigInt(state.volUsePct)) / 100n;
        const remainingBuys = state.buyCount - cycle.buyCount;
        const perBuy = alloc / BigInt(Math.max(remainingBuys, 1));
        if (perBuy <= BALANCE_THRESHOLD_LAMPORTS) {
          continue;
        }

        const quote = await fetchQuote(
          SOL_MINT,
          state.targetMint,
          perBuy,
          state.slippageBps
        );
        logData("quote", {
          type: "buy",
          wallet: wallet.publicKey,
          inAmount: perBuy.toString(),
          outAmount: quote.outAmount,
        });
        const sig = await executeSwap(connection, keypair, quote);
        state.stats.buys += 1;
        state.stats.volumeSol += Number(perBuy) / 1e9;
        logInfo("Vol buy", { wallet: wallet.publicKey, sig, sol: formatSol(perBuy) });
        cycle.buyCount += 1;
        cycle.lastActionTs = Date.now();
        writeState(state);
      }

      const mmWallets = wallets.mmWallets.slice(0, state.mmWalletCount);
      if (mmWallets.length) {
        let price = null;
        try {
          const now = Date.now();
          const refreshMs = Math.min(state.mmStrategy.actionMs, 20000);
          if (!state.mmPrice.ts || now - state.mmPrice.ts > refreshMs) {
            price = await getMidPrice(connection, state.targetMint);
            const alpha = 0.2;
            if (state.mmPrice.ema === null) {
              state.mmPrice.ema = price;
            } else {
              state.mmPrice.ema =
                state.mmPrice.ema * (1 - alpha) + price * alpha;
            }
            state.mmPrice.last = price;
            state.mmPrice.ts = now;
            writeState(state);
          } else {
            price = state.mmPrice.last;
          }
        } catch (err) {
          logWarn("MM price unavailable", { error: err.message || err });
        }

        if (price !== null && state.mmPrice.ema) {
          const ema = state.mmPrice.ema;
          const pingPct = state.mmStrategy.pingPct;
          const driftPct = state.mmStrategy.driftPct;
          const rangePct = state.mmStrategy.rangePct;
          const tradePct = state.mmStrategy.tradePct;
          const maxTradeSol = state.mmStrategy.maxTradeSol;
          const minTradeSol = state.mmStrategy.minTradeSol;
          const sellPct = state.mmStrategy.sellPct;
          for (const wallet of mmWallets) {
            const keypair = Keypair.fromSecretKey(
              Uint8Array.from(wallet.secretKey)
            );
            const cycle = getMmCycle(state, wallet.publicKey);
            if (Date.now() - cycle.lastActionTs < state.mmStrategy.actionMs) {
              continue;
            }
            const solBal = BigInt(
              await connection.getBalance(keypair.publicKey, "confirmed")
            );
            const reserve = lamportsFromSol(state.reserveSol);
            const tokenBal = await getTokenBalance(
              connection,
              keypair.publicKey,
              mintPubkey
            );

            const deltaPct = ((price - ema) / ema) * 100;
            if (cycle.lastTradePrice === null) {
              cycle.lastTradePrice = price;
            }
            const rangeUp =
              price >= cycle.lastTradePrice * (1 + rangePct / 100);
            const rangeDown =
              price <= cycle.lastTradePrice * (1 - rangePct / 100);
            const pingBuy = deltaPct <= -pingPct;
            const pingSell = deltaPct >= pingPct;
            const driftBuy = price < ema * (1 - driftPct / 100);
            const driftSell = price > ema * (1 + driftPct / 100);

            const sellSignal =
              (pingSell || driftSell || rangeUp) && tokenBal.amount > 0n;
            const buySignal = pingBuy || driftBuy || rangeDown;

            if (sellSignal) {
              const amount = (tokenBal.amount * BigInt(sellPct)) / 100n;
              if (amount > BALANCE_THRESHOLD_LAMPORTS) {
                const quote = await fetchQuote(
                  state.targetMint,
                  SOL_MINT,
                  amount,
                  state.slippageBps
                );
                logData("quote", {
                  type: "mm_sell",
                  wallet: wallet.publicKey,
                  inAmount: amount.toString(),
                  outAmount: quote.outAmount,
                });
                const sig = await executeSwap(connection, keypair, quote);
                state.stats.mmSells += 1;
                logInfo("MM sell", {
                  wallet: wallet.publicKey,
                  sig,
                  reason: [
                    pingSell ? "ping" : null,
                    driftSell ? "drift" : null,
                    rangeUp ? "range" : null,
                  ]
                    .filter(Boolean)
                    .join(","),
                });
                cycle.lastTradePrice = price;
                cycle.lastActionTs = Date.now();
                writeState(state);
              }
              continue;
            }

            if (buySignal) {
              if (solBal <= reserve + BALANCE_THRESHOLD_LAMPORTS) {
                continue;
              }
              const spendable = solBal - reserve;
              let tradeSol =
                (Number(spendable) / 1e9) * (tradePct / 100);
              tradeSol = clamp(tradeSol, minTradeSol, maxTradeSol);
              const tradeLamports = lamportsFromSol(tradeSol);
              if (tradeLamports <= BALANCE_THRESHOLD_LAMPORTS) {
                continue;
              }
              const quote = await fetchQuote(
                SOL_MINT,
                state.targetMint,
                tradeLamports,
                state.slippageBps
              );
              logData("quote", {
                type: "mm_buy",
                wallet: wallet.publicKey,
                inAmount: tradeLamports.toString(),
                outAmount: quote.outAmount,
              });
              const sig = await executeSwap(connection, keypair, quote);
              state.stats.mmBuys += 1;
              state.stats.mmVolumeSol += Number(tradeLamports) / 1e9;
              logInfo("MM buy", {
                wallet: wallet.publicKey,
                sig,
                reason: [
                  pingBuy ? "ping" : null,
                  driftBuy ? "drift" : null,
                  rangeDown ? "range" : null,
                ]
                  .filter(Boolean)
                  .join(","),
              });
              cycle.lastTradePrice = price;
              cycle.lastActionTs = Date.now();
              writeState(state);
            }
          }
        }
      }
    } catch (err) {
      logError("Loop error", { error: err.message || err });
    }
    await new Promise((resolve) => setTimeout(resolve, state.pollMs || DEFAULT_POLL_MS));
  }
}

main().catch((err) => {
  logError("Bot failed", { error: err.message || err });
  process.exit(1);
});
