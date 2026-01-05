/**
 * RiskManager - Position sizing, drawdown management, and risk analytics
 * Provides real-time risk metrics and position limits
 */

const EventEmitter = require("events");

class RiskManager extends EventEmitter {
  constructor(config = {}) {
    super();

    this.config = {
      maxDrawdownPct: config.maxDrawdownPct || 30,
      maxPositionSizePct: config.maxPositionSizePct || 90,
      stopLossEnabled: config.stopLossEnabled !== false,
      maxDailyLossPct: config.maxDailyLossPct || 10,
      riskRewardRatio: config.riskRewardRatio || 2.0,
      ...config,
    };

    this.session = {
      startBalance: null,
      peakBalance: null,
      currentBalance: null,
      dailyPnL: 0,
      tradeCount: 0,
      winCount: 0,
      lossCount: 0,
      startTime: Date.now(),
      lastResetTime: Date.now(),
    };

    this.limits = {
      tradingAllowed: true,
      reason: null,
    };
  }

  /**
   * Initialize session with starting balance
   */
  initSession(balanceLamports) {
    this.session.startBalance = balanceLamports;
    this.session.peakBalance = balanceLamports;
    this.session.currentBalance = balanceLamports;
    this.session.startTime = Date.now();
    this.session.lastResetTime = Date.now();

    this.emit("session_init", this.getSessionMetrics());
  }

  /**
   * Update current balance
   */
  updateBalance(balanceLamports) {
    const oldBalance = this.session.currentBalance;
    this.session.currentBalance = balanceLamports;

    // Update peak
    if (balanceLamports > this.session.peakBalance) {
      this.session.peakBalance = balanceLamports;
    }

    // Check risk limits
    this._checkRiskLimits();

    this.emit("balance_update", {
      balance: balanceLamports,
      oldBalance,
      metrics: this.getSessionMetrics(),
    });
  }

  /**
   * Record trade result
   */
  recordTrade(pnlLamports, isWin) {
    this.session.tradeCount++;
    this.session.dailyPnL += Number(pnlLamports);

    if (isWin) {
      this.session.winCount++;
    } else {
      this.session.lossCount++;
    }

    this.emit("trade_recorded", {
      pnl: pnlLamports,
      isWin,
      metrics: this.getSessionMetrics(),
    });

    // Check risk limits after trade
    this._checkRiskLimits();
  }

  /**
   * Calculate position size based on risk parameters
   */
  calculatePositionSize(availableBalanceLamports, riskPct) {
    const maxSize = (availableBalanceLamports * BigInt(this.config.maxPositionSizePct)) / 100n;
    const riskSize = (availableBalanceLamports * BigInt(riskPct || this.config.maxPositionSizePct)) / 100n;

    return riskSize < maxSize ? riskSize : maxSize;
  }

  /**
   * Calculate stop loss level
   */
  calculateStopLoss(entryPrice, stopLossPct) {
    if (!this.config.stopLossEnabled) return null;

    const stopPct = stopLossPct || 10;
    const entryNum = Number(entryPrice) / 1e9;
    const stopPrice = entryNum * (1 - stopPct / 100);

    return BigInt(Math.round(stopPrice * 1e9)).toString();
  }

  /**
   * Calculate take profit level based on risk/reward ratio
   */
  calculateTakeProfit(entryPrice, stopLossPrice) {
    const entryNum = Number(entryPrice) / 1e9;
    const stopNum = Number(stopLossPrice) / 1e9;
    const risk = entryNum - stopNum;
    const reward = risk * this.config.riskRewardRatio;
    const takeProfit = entryNum + reward;

    return BigInt(Math.round(takeProfit * 1e9)).toString();
  }

  /**
   * Check if trade is allowed based on risk limits
   */
  canTrade() {
    return this.limits.tradingAllowed;
  }

  /**
   * Get reason why trading is blocked
   */
  getTradingBlockReason() {
    return this.limits.reason;
  }

  /**
   * Check risk limits and update trading status
   */
  _checkRiskLimits() {
    if (!this.session.startBalance || !this.session.currentBalance) {
      return;
    }

    // Check drawdown from peak
    const drawdownFromPeak = this._calculateDrawdownPct(
      this.session.peakBalance,
      this.session.currentBalance
    );

    if (drawdownFromPeak >= this.config.maxDrawdownPct) {
      this._blockTrading(`Max drawdown reached: ${drawdownFromPeak.toFixed(2)}%`);
      return;
    }

    // Check daily loss
    const dailyLossPct = (this.session.dailyPnL / Number(this.session.startBalance)) * 100;
    if (dailyLossPct <= -this.config.maxDailyLossPct) {
      this._blockTrading(`Max daily loss reached: ${dailyLossPct.toFixed(2)}%`);
      return;
    }

    // All checks passed
    if (!this.limits.tradingAllowed) {
      this._allowTrading();
    }
  }

  /**
   * Calculate drawdown percentage
   */
  _calculateDrawdownPct(peakBalance, currentBalance) {
    if (!peakBalance || peakBalance === 0n) return 0;

    const peak = Number(peakBalance);
    const current = Number(currentBalance);
    return ((peak - current) / peak) * 100;
  }

  /**
   * Block trading with reason
   */
  _blockTrading(reason) {
    if (this.limits.tradingAllowed) {
      this.limits.tradingAllowed = false;
      this.limits.reason = reason;
      this.emit("trading_blocked", { reason });
    }
  }

  /**
   * Allow trading
   */
  _allowTrading() {
    this.limits.tradingAllowed = true;
    this.limits.reason = null;
    this.emit("trading_allowed");
  }

  /**
   * Reset daily limits (call at start of new day)
   */
  resetDailyLimits() {
    this.session.dailyPnL = 0;
    this.session.lastResetTime = Date.now();
    this._checkRiskLimits();
    this.emit("daily_reset");
  }

  /**
   * Get session metrics
   */
  getSessionMetrics() {
    if (!this.session.startBalance || !this.session.currentBalance) {
      return null;
    }

    const pnlLamports = this.session.currentBalance - this.session.startBalance;
    const pnlPct = (Number(pnlLamports) / Number(this.session.startBalance)) * 100;

    const drawdownFromStart = this._calculateDrawdownPct(
      this.session.startBalance,
      this.session.currentBalance
    );

    const drawdownFromPeak = this._calculateDrawdownPct(
      this.session.peakBalance,
      this.session.currentBalance
    );

    const winRate = this.session.tradeCount > 0
      ? (this.session.winCount / this.session.tradeCount) * 100
      : 0;

    const avgPnLPerTrade = this.session.tradeCount > 0
      ? this.session.dailyPnL / this.session.tradeCount
      : 0;

    return {
      startBalance: this.session.startBalance,
      peakBalance: this.session.peakBalance,
      currentBalance: this.session.currentBalance,
      pnlLamports,
      pnlPct,
      drawdownFromStart,
      drawdownFromPeak,
      dailyPnL: this.session.dailyPnL,
      tradeCount: this.session.tradeCount,
      winCount: this.session.winCount,
      lossCount: this.session.lossCount,
      winRate,
      avgPnLPerTrade,
      tradingAllowed: this.limits.tradingAllowed,
      blockReason: this.limits.reason,
      sessionDurationMs: Date.now() - this.session.startTime,
    };
  }

  /**
   * Calculate Kelly Criterion for position sizing
   */
  calculateKellyFraction() {
    if (this.session.tradeCount < 10) {
      return 0.1; // Conservative default
    }

    const winRate = this.session.winCount / this.session.tradeCount;
    const lossRate = 1 - winRate;

    if (lossRate === 0) return 0.25; // Cap at 25%

    // Simplified Kelly: (winRate - lossRate) / lossRate
    const kelly = (winRate - lossRate) / lossRate;

    // Cap between 0 and 0.25 (never risk more than 25%)
    return Math.max(0, Math.min(0.25, kelly));
  }

  /**
   * Get risk level (low, medium, high, extreme)
   */
  getRiskLevel() {
    const metrics = this.getSessionMetrics();
    if (!metrics) return "unknown";

    const drawdown = metrics.drawdownFromPeak;

    if (drawdown < 5) return "low";
    if (drawdown < 15) return "medium";
    if (drawdown < 25) return "high";
    return "extreme";
  }

  /**
   * Export session state
   */
  exportState() {
    return {
      session: { ...this.session },
      limits: { ...this.limits },
      config: { ...this.config },
    };
  }

  /**
   * Import session state
   */
  importState(state) {
    if (state.session) {
      this.session = { ...state.session };
    }
    if (state.limits) {
      this.limits = { ...state.limits };
    }
    if (state.config) {
      this.config = { ...this.config, ...state.config };
    }
  }
}

module.exports = RiskManager;