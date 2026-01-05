/**
 * TradeEngine - Advanced trade execution with partial exits, dynamic trailing, and smart order management
 * Handles multi-step position building, profit taking, and sophisticated exit strategies
 */

const EventEmitter = require("events");

class TradeEngine extends EventEmitter {
  constructor(config = {}) {
    super();

    this.config = {
      // Position building
      stepSolPct: config.stepSolPct || [15, 25, 60],
      stepDrawdownPct: config.stepDrawdownPct || [0, 6, 12],

      // Profit targets
      profitTargetBps: config.profitTargetBps || 300,
      profitConfirmTicks: config.profitConfirmTicks || 2,

      // Trailing stop
      trailingStartPct: config.trailingStartPct || 8,
      trailingGapPct: config.trailingGapPct || 4,
      trailingMinProfitPct: config.trailingMinProfitPct || 3,

      // Partial exits
      partialExitsEnabled: config.partialExitsEnabled !== false,
      partialExitLevels: config.partialExitLevels || [
        { profitPct: 5, exitPct: 25 },   // Take 25% at +5%
        { profitPct: 10, exitPct: 25 },  // Take 25% at +10%
        { profitPct: 20, exitPct: 25 },  // Take 25% at +20%
      ],

      // Dynamic trailing
      dynamicTrailingEnabled: config.dynamicTrailingEnabled !== false,
      dynamicTrailingLevels: config.dynamicTrailingLevels || [
        { profitPct: 15, gapPct: 3 },    // Tighter trailing above +15%
        { profitPct: 25, gapPct: 2 },    // Even tighter above +25%
      ],

      ...config,
    };

    this.position = null;
  }

  /**
   * Initialize new position
   */
  initPosition(tokenMint, totalCapitalLamports) {
    this.position = {
      tokenMint,
      mode: "building", // building, holding, exiting
      totalCapitalLamports,

      // Steps
      currentStep: 0,
      steps: this._calculateSteps(totalCapitalLamports),
      totalSolSpentLamports: 0n,
      totalTokenAmount: 0n,

      // Entry
      avgEntryPriceScaled: null,
      entryHighPriceScaled: null,

      // Profit tracking
      profitConfirmCount: 0,
      trailPeakBps: null,
      lastPriceScaled: null,

      // Partial exits
      partialExits: [],
      partialExitsFilled: [],

      // Timestamps
      entryTime: Date.now(),
      lastUpdateTime: Date.now(),
    };

    this.emit("position_init", this.position);
    return this.position;
  }

  /**
   * Calculate position steps
   */
  _calculateSteps(totalCapitalLamports) {
    const steps = [];
    const { stepSolPct, stepDrawdownPct } = this.config;

    for (let i = 0; i < stepSolPct.length; i++) {
      const sizePct = stepSolPct[i];
      const drawdownPct = stepDrawdownPct[i] || 0;
      const sizeLamports = (totalCapitalLamports * BigInt(Math.round(sizePct * 100))) / 10000n;

      steps.push({
        index: i,
        sizeLamports,
        sizePct,
        drawdownPct,
        filled: false,
        entryPriceScaled: null,
        tokenAmount: 0n,
      });
    }

    return steps;
  }

  /**
   * Record step fill
   */
  recordStepFill(stepIndex, solSpentLamports, tokenAmount, priceScaled) {
    if (!this.position) {
      throw new Error("No active position");
    }

    if (stepIndex >= this.position.steps.length) {
      throw new Error(`Invalid step index: ${stepIndex}`);
    }

    const step = this.position.steps[stepIndex];
    step.filled = true;
    step.entryPriceScaled = priceScaled;
    step.tokenAmount = tokenAmount;

    this.position.totalSolSpentLamports += solSpentLamports;
    this.position.totalTokenAmount += tokenAmount;
    this.position.currentStep = stepIndex;

    // Recalculate average entry price
    this._recalculateAvgEntry();

    // Update mode
    if (stepIndex >= this.position.steps.length - 1) {
      this.position.mode = "holding";
    }

    this.emit("step_filled", {
      stepIndex,
      solSpent: solSpentLamports,
      tokenAmount,
      price: priceScaled,
      avgEntry: this.position.avgEntryPriceScaled,
    });
  }

  /**
   * Recalculate average entry price
   */
  _recalculateAvgEntry() {
    if (this.position.totalTokenAmount === 0n) {
      this.position.avgEntryPriceScaled = null;
      return;
    }

    const SCALE = 1_000_000_000n;
    const avgPrice = (this.position.totalSolSpentLamports * SCALE) / this.position.totalTokenAmount;
    this.position.avgEntryPriceScaled = avgPrice.toString();
  }

  /**
   * Update position with current price
   */
  updatePrice(currentPriceScaled) {
    if (!this.position) return null;

    this.position.lastPriceScaled = currentPriceScaled;
    this.position.lastUpdateTime = Date.now();

    // Calculate current profit
    const profitBps = this._calculateProfitBps(currentPriceScaled);

    // Update entry high
    if (!this.position.entryHighPriceScaled ||
        BigInt(currentPriceScaled) > BigInt(this.position.entryHighPriceScaled)) {
      this.position.entryHighPriceScaled = currentPriceScaled;
    }

    // Check for next step entry
    const nextStep = this._checkNextStepEntry(currentPriceScaled);

    // Check for partial exit opportunities
    const partialExit = this._checkPartialExit(currentPriceScaled, profitBps);

    // Check for full exit signal
    const exitSignal = this._checkExitSignal(currentPriceScaled, profitBps);

    return {
      profitBps,
      nextStep,
      partialExit,
      exitSignal,
      position: this.getPositionSummary(),
    };
  }

  /**
   * Calculate profit in basis points
   */
  _calculateProfitBps(currentPriceScaled) {
    if (!this.position.avgEntryPriceScaled) return 0;

    const entry = Number(this.position.avgEntryPriceScaled);
    const current = Number(currentPriceScaled);

    if (entry === 0) return 0;

    return Math.round(((current - entry) / entry) * 10000);
  }

  /**
   * Check if next step should be entered
   */
  _checkNextStepEntry(currentPriceScaled) {
    if (this.position.mode !== "building") return null;

    const nextStepIndex = this.position.currentStep + 1;
    if (nextStepIndex >= this.position.steps.length) return null;

    const nextStep = this.position.steps[nextStepIndex];
    if (nextStep.filled) return null;

    // Check if price has dropped enough for next step
    if (!this.position.entryHighPriceScaled) return null;

    const entryHigh = Number(this.position.entryHighPriceScaled);
    const current = Number(currentPriceScaled);
    const dropPct = ((entryHigh - current) / entryHigh) * 100;

    if (dropPct >= nextStep.drawdownPct) {
      return {
        stepIndex: nextStepIndex,
        drawdownPct: dropPct,
        targetDrawdownPct: nextStep.drawdownPct,
        sizeLamports: nextStep.sizeLamports,
      };
    }

    return null;
  }

  /**
   * Check for partial exit opportunity
   */
  _checkPartialExit(currentPriceScaled, profitBps) {
    if (!this.config.partialExitsEnabled) return null;
    if (this.position.mode === "building") return null;

    const profitPct = profitBps / 100;

    // Find next unfilled partial exit level
    for (const level of this.config.partialExitLevels) {
      const alreadyFilled = this.position.partialExitsFilled.some(
        exit => exit.profitPct === level.profitPct
      );

      if (!alreadyFilled && profitPct >= level.profitPct) {
        const exitAmount = (this.position.totalTokenAmount * BigInt(level.exitPct)) / 100n;

        return {
          level,
          exitAmount,
          profitPct,
        };
      }
    }

    return null;
  }

  /**
   * Record partial exit
   */
  recordPartialExit(level, amountSold, solReceived, priceScaled) {
    this.position.totalTokenAmount -= amountSold;

    this.position.partialExitsFilled.push({
      profitPct: level.profitPct,
      exitPct: level.exitPct,
      amountSold,
      solReceived,
      priceScaled,
      timestamp: Date.now(),
    });

    this.emit("partial_exit", {
      level,
      amountSold,
      solReceived,
      remaining: this.position.totalTokenAmount,
    });
  }

  /**
   * Check for exit signal
   */
  _checkExitSignal(currentPriceScaled, profitBps) {
    if (this.position.mode === "building") return null;

    // Check profit target
    if (profitBps >= this.config.profitTargetBps) {
      this.position.profitConfirmCount++;

      if (this.position.profitConfirmCount >= this.config.profitConfirmTicks) {
        return {
          type: "profit_target",
          profitBps,
          targetBps: this.config.profitTargetBps,
        };
      }
    } else {
      this.position.profitConfirmCount = 0;
    }

    // Check trailing stop
    const trailingSignal = this._checkTrailingStop(currentPriceScaled, profitBps);
    if (trailingSignal) return trailingSignal;

    return null;
  }

  /**
   * Check trailing stop with dynamic levels
   */
  _checkTrailingStop(currentPriceScaled, profitBps) {
    if (profitBps < this.config.trailingStartPct * 100) {
      return null; // Not in trailing mode yet
    }

    // Update trail peak
    if (!this.position.trailPeakBps || profitBps > this.position.trailPeakBps) {
      this.position.trailPeakBps = profitBps;
    }

    // Determine trailing gap based on profit level (dynamic trailing)
    let trailingGap = this.config.trailingGapPct;

    if (this.config.dynamicTrailingEnabled) {
      for (const level of this.config.dynamicTrailingLevels) {
        if ((profitBps / 100) >= level.profitPct) {
          trailingGap = level.gapPct;
        }
      }
    }

    // Check if price dropped below trailing gap
    const dropFromPeak = this.position.trailPeakBps - profitBps;
    const dropPct = dropFromPeak / 100;

    if (dropPct >= trailingGap) {
      const minProfit = this.config.trailingMinProfitPct * 100;
      if (profitBps >= minProfit) {
        return {
          type: "trailing_stop",
          profitBps,
          peakBps: this.position.trailPeakBps,
          dropPct,
          gapPct: trailingGap,
        };
      }
    }

    return null;
  }

  /**
   * Mark position as exiting
   */
  startExit() {
    if (this.position) {
      this.position.mode = "exiting";
      this.emit("exit_started", this.position);
    }
  }

  /**
   * Close position
   */
  closePosition(exitPriceScaled, solReceived) {
    if (!this.position) return null;

    const profitBps = this._calculateProfitBps(exitPriceScaled);
    const pnlLamports = solReceived - this.position.totalSolSpentLamports;

    const summary = {
      tokenMint: this.position.tokenMint,
      totalSolSpent: this.position.totalSolSpentLamports,
      solReceived,
      pnlLamports,
      profitBps,
      entryPrice: this.position.avgEntryPriceScaled,
      exitPrice: exitPriceScaled,
      duration: Date.now() - this.position.entryTime,
      stepsCompleted: this.position.steps.filter(s => s.filled).length,
      partialExits: this.position.partialExitsFilled.length,
    };

    this.emit("position_closed", summary);

    this.position = null;
    return summary;
  }

  /**
   * Get position summary
   */
  getPositionSummary() {
    if (!this.position) return null;

    const profitBps = this.position.lastPriceScaled
      ? this._calculateProfitBps(this.position.lastPriceScaled)
      : 0;

    return {
      tokenMint: this.position.tokenMint,
      mode: this.position.mode,
      currentStep: this.position.currentStep,
      totalSteps: this.position.steps.length,
      totalSolSpent: this.position.totalSolSpentLamports.toString(),
      totalTokenAmount: this.position.totalTokenAmount.toString(),
      avgEntryPrice: this.position.avgEntryPriceScaled,
      currentPrice: this.position.lastPriceScaled,
      profitBps,
      profitPct: profitBps / 100,
      trailPeakBps: this.position.trailPeakBps,
      partialExitsCompleted: this.position.partialExitsFilled.length,
      duration: Date.now() - this.position.entryTime,
    };
  }

  /**
   * Check if position is active
   */
  hasPosition() {
    return this.position !== null;
  }

  /**
   * Export position state
   */
  exportState() {
    return {
      position: this.position ? {
        ...this.position,
        totalSolSpentLamports: this.position.totalSolSpentLamports.toString(),
        totalTokenAmount: this.position.totalTokenAmount.toString(),
        steps: this.position.steps.map(s => ({
          ...s,
          sizeLamports: s.sizeLamports.toString(),
          tokenAmount: s.tokenAmount.toString(),
        })),
      } : null,
      config: { ...this.config },
    };
  }

  /**
   * Import position state
   */
  importState(state) {
    if (state.config) {
      this.config = { ...this.config, ...state.config };
    }

    if (state.position) {
      this.position = {
        ...state.position,
        totalSolSpentLamports: BigInt(state.position.totalSolSpentLamports || "0"),
        totalTokenAmount: BigInt(state.position.totalTokenAmount || "0"),
        steps: state.position.steps.map(s => ({
          ...s,
          sizeLamports: BigInt(s.sizeLamports || "0"),
          tokenAmount: BigInt(s.tokenAmount || "0"),
        })),
      };
    }
  }
}

module.exports = TradeEngine;