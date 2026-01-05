/**
 * PriceEngine - Real-time price tracking with WebSocket and REST fallback
 * Provides price feeds, VWAP, volatility metrics, and price alerts
 */

const EventEmitter = require("events");
const fetch = require("node-fetch");

class PriceEngine extends EventEmitter {
  constructor(config = {}) {
    super();

    this.config = {
      jupiterApiBase: config.jupiterApiBase || "https://lite-api.jup.ag",
      birdeyeApiKey: config.birdeyeApiKey || null,
      priceUpdateIntervalMs: config.priceUpdateIntervalMs || 3000,
      vwapWindow: config.vwapWindow || 20,
      volatilityWindow: config.volatilityWindow || 50,
      ...config,
    };

    this.currentPrice = null;
    this.lastPriceUpdate = 0;
    this.priceHistory = [];
    this.isRunning = false;
    this.updateTimer = null;
    this.wsConnection = null;

    // Metrics
    this.metrics = {
      vwap: null,
      volatility: null,
      momentum: null,
      spread: null,
      volume24h: null,
    };
  }

  /**
   * Start price tracking for a token pair
   */
  async start(tokenMint, quoteMint = "So11111111111111111111111111111111111111112") {
    if (this.isRunning) {
      throw new Error("PriceEngine already running");
    }

    this.tokenMint = tokenMint;
    this.quoteMint = quoteMint;
    this.isRunning = true;

    this.emit("started", { tokenMint, quoteMint });

    // Start polling loop (WebSocket can be added later)
    this._startPriceLoop();
  }

  /**
   * Stop price tracking
   */
  stop() {
    this.isRunning = false;

    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }

    if (this.wsConnection) {
      this.wsConnection.close();
      this.wsConnection = null;
    }

    this.emit("stopped");
  }

  /**
   * Get current price (scaled by 1e9 for precision)
   */
  getCurrentPriceScaled() {
    return this.currentPrice;
  }

  /**
   * Get price in SOL (unscaled)
   */
  getCurrentPrice() {
    if (!this.currentPrice) return null;
    return Number(this.currentPrice) / 1e9;
  }

  /**
   * Get all metrics
   */
  getMetrics() {
    return { ...this.metrics };
  }

  /**
   * Fetch price quote from Jupiter
   */
  async fetchQuote(inputMint, outputMint, amountLamports) {
    const url = `${this.config.jupiterApiBase}/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=50`;

    try {
      const response = await fetch(url, { timeout: 10000 });
      if (!response.ok) {
        throw new Error(`Jupiter quote failed: ${response.status}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      this.emit("error", { type: "quote_fetch", error });
      throw error;
    }
  }

  /**
   * Calculate price from quote data
   */
  calculatePriceFromQuote(quote, inputAmount, inputDecimals, outputDecimals) {
    const outAmount = BigInt(quote.outAmount || "0");
    if (outAmount === 0n) return null;

    const inAmount = BigInt(inputAmount);
    const SCALE = 1_000_000_000n;

    // Price = output / input (normalized for decimals)
    const decimalAdj = BigInt(10 ** (inputDecimals - outputDecimals));
    const priceScaled = (outAmount * SCALE * decimalAdj) / inAmount;

    return priceScaled.toString();
  }

  /**
   * Main price update loop
   */
  async _startPriceLoop() {
    while (this.isRunning) {
      try {
        await this._updatePrice();
      } catch (error) {
        this.emit("error", { type: "price_update", error });
      }

      // Wait before next update
      await this._sleep(this.config.priceUpdateIntervalMs);
    }
  }

  /**
   * Update price and metrics
   */
  async _updatePrice() {
    const sampleAmount = BigInt(Math.round(0.01 * 1e9)); // 0.01 SOL sample

    try {
      const quote = await this.fetchQuote(
        this.quoteMint,
        this.tokenMint,
        sampleAmount.toString()
      );

      const priceScaled = this.calculatePriceFromQuote(
        quote,
        sampleAmount.toString(),
        9, // SOL decimals
        9  // Assume token decimals (should be fetched from token metadata)
      );

      if (!priceScaled) {
        return;
      }

      const oldPrice = this.currentPrice;
      this.currentPrice = priceScaled;
      this.lastPriceUpdate = Date.now();

      // Add to price history
      this.priceHistory.push({
        price: priceScaled,
        timestamp: Date.now(),
      });

      // Trim history
      const maxHistory = Math.max(this.config.vwapWindow, this.config.volatilityWindow);
      if (this.priceHistory.length > maxHistory) {
        this.priceHistory = this.priceHistory.slice(-maxHistory);
      }

      // Update metrics
      this._updateMetrics();

      // Emit price update event
      this.emit("price", {
        price: priceScaled,
        priceNum: Number(priceScaled) / 1e9,
        timestamp: this.lastPriceUpdate,
        oldPrice,
        change: oldPrice ? this._calculateChange(oldPrice, priceScaled) : null,
      });

    } catch (error) {
      this.emit("error", { type: "price_fetch", error });
    }
  }

  /**
   * Update calculated metrics
   */
  _updateMetrics() {
    if (this.priceHistory.length < 2) {
      return;
    }

    // VWAP (simplified without volume, just average)
    const vwapPrices = this.priceHistory.slice(-this.config.vwapWindow);
    const vwapSum = vwapPrices.reduce((sum, p) => sum + BigInt(p.price), 0n);
    this.metrics.vwap = (Number(vwapSum) / vwapPrices.length / 1e9).toFixed(9);

    // Volatility (standard deviation)
    const prices = vwapPrices.map(p => Number(p.price) / 1e9);
    const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
    const variance = prices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / prices.length;
    this.metrics.volatility = Math.sqrt(variance);

    // Momentum (rate of change over window)
    if (vwapPrices.length >= 10) {
      const oldPrice = Number(vwapPrices[0].price) / 1e9;
      const newPrice = Number(vwapPrices[vwapPrices.length - 1].price) / 1e9;
      this.metrics.momentum = ((newPrice - oldPrice) / oldPrice) * 100;
    }

    this.emit("metrics", this.metrics);
  }

  /**
   * Calculate percentage change
   */
  _calculateChange(oldPrice, newPrice) {
    const old = Number(oldPrice);
    const current = Number(newPrice);
    return ((current - old) / old) * 100;
  }

  /**
   * Sleep utility
   */
  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get price history
   */
  getPriceHistory(count) {
    if (!count) return [...this.priceHistory];
    return this.priceHistory.slice(-count);
  }

  /**
   * Check if price is stale
   */
  isPriceStale(maxAgeMs = 30000) {
    if (!this.lastPriceUpdate) return true;
    return Date.now() - this.lastPriceUpdate > maxAgeMs;
  }
}

module.exports = PriceEngine;
