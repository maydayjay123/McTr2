require("dotenv").config();
const fs = require("fs");
const path = require("path");
const fetch = global.fetch || require("node-fetch");
const { Connection, PublicKey } = require("@solana/web3.js");

const TOKEN_MINT = process.env.TARGET_MINT || process.argv[2];
const OUT_PATH = process.env.TA_OUTPUT || path.join(__dirname, "ta.json");
const INTERVAL_MS = Number(process.env.TA_INTERVAL_MS || 5000);

const RPC_URLS = [
  process.env.SOLANA_RPC_URL,
  process.env.MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com",
].filter(Boolean);

if (!TOKEN_MINT) {
  console.error("Missing token mint. Set TARGET_MINT or pass as arg.");
  process.exit(1);
}

let rpcIndex = 0;
function nextConnection() {
  const url = RPC_URLS[rpcIndex % RPC_URLS.length];
  rpcIndex += 1;
  return new Connection(url, "confirmed");
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function sortByLiquidity(pairs) {
  return pairs.slice().sort((a, b) => {
    const aLiq = number(a?.liquidity?.usd);
    const bLiq = number(b?.liquidity?.usd);
    return bLiq - aLiq;
  });
}

function computePoolRatios(pair, tokenMint) {
  const tokenPrice = number(pair.priceUsd);
  const liquidityUsd = number(pair?.liquidity?.usd);
  const priceNative = number(pair.priceNative);
  const baseIsToken =
    pair?.baseToken?.address?.toLowerCase() === tokenMint.toLowerCase();
  const tokenSymbol = baseIsToken ? pair.baseToken?.symbol : pair.quoteToken?.symbol;
  let solPriceUsd = 0;

  if (priceNative > 0 && tokenPrice > 0) {
    solPriceUsd = tokenPrice / priceNative;
  }

  let solInPool = 0;
  let tokensInPool = 0;

  if (liquidityUsd > 0 && solPriceUsd > 0 && tokenPrice > 0) {
    solInPool = (liquidityUsd / 2) / solPriceUsd;
    tokensInPool = (liquidityUsd / 2) / tokenPrice;
  }

  return {
    tokenSymbol: tokenSymbol || "TOKEN",
    tokenPriceUsd: tokenPrice,
    solPriceUsd,
    solInPool,
    tokensInPool,
  };
}

function buildTrend(pair) {
  const change = pair?.priceChange || {};
  const p5m = number(change.m5);
  const p1h = number(change.h1);
  const p6h = number(change.h6);
  const p24h = number(change.h24);
  const score = p5m + p1h + p6h + p24h;
  const direction = score > 0 ? "up" : score < 0 ? "down" : "flat";

  return {
    change5m: p5m,
    change1h: p1h,
    change6h: p6h,
    change24h: p24h,
    score,
    direction,
  };
}

async function fetchDexscreener(tokenMint) {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Dexscreener failed: ${res.status}`);
  }
  return res.json();
}

async function fetchTokenSupply(tokenMint) {
  try {
    const connection = nextConnection();
    const supply = await connection.getTokenSupply(new PublicKey(tokenMint));
    return {
      supply: supply?.value?.uiAmount || 0,
      decimals: supply?.value?.decimals || 0,
      source: connection.rpcEndpoint,
    };
  } catch (err) {
    return {
      supply: 0,
      decimals: 0,
      error: err.message || String(err),
    };
  }
}

async function buildSnapshot() {
  const dexData = await fetchDexscreener(TOKEN_MINT);
  const pairs = Array.isArray(dexData?.pairs) ? dexData.pairs : [];
  const solPairs = pairs.filter((p) => {
    const base = p?.baseToken?.address;
    const quote = p?.quoteToken?.address;
    return (
      base === "So11111111111111111111111111111111111111112" ||
      quote === "So11111111111111111111111111111111111111112"
    );
  });

  const ranked = sortByLiquidity(solPairs.length ? solPairs : pairs);
  const mainPool = ranked[0] || null;
  const supplyInfo = await fetchTokenSupply(TOKEN_MINT);

  let poolStats = null;
  let trend = null;
  if (mainPool) {
    const ratios = computePoolRatios(mainPool, TOKEN_MINT);
    poolStats = {
      dexId: mainPool.dexId || "unknown",
      pairAddress: mainPool.pairAddress,
      liquidityUsd: number(mainPool?.liquidity?.usd),
      volume24h: number(mainPool?.volume?.h24),
      volume1h: number(mainPool?.volume?.h1),
      priceUsd: ratios.tokenPriceUsd,
      solPriceUsd: ratios.solPriceUsd,
      solInPool: ratios.solInPool,
      tokensInPool: ratios.tokensInPool,
      symbol: ratios.tokenSymbol,
    };
    trend = buildTrend(mainPool);
  }

  return {
    updatedAt: new Date().toISOString(),
    tokenMint: TOKEN_MINT,
    poolCount: pairs.length,
    mainPool: poolStats,
    trend,
    supply: supplyInfo,
  };
}

async function writeSnapshot() {
  try {
    const snapshot = await buildSnapshot();
    fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2), "utf8");
    console.log(`[ta] updated ${OUT_PATH}`);
  } catch (err) {
    console.error(`[ta] failed: ${err.message || err}`);
  }
}

writeSnapshot();
setInterval(writeSnapshot, INTERVAL_MS);
