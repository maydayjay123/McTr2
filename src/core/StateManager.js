/**
 * StateManager - Backward-compatible state management
 * Handles migration from botv3 state format to botv4 while preserving active trades
 */

const fs = require("fs");
const path = require("path");

class StateManager {
  constructor(stateFilePath) {
    this.stateFilePath = stateFilePath;
    this.state = null;
    this.version = "v4";
  }

  /**
   * Load state from disk with automatic migration
   */
  load() {
    if (!fs.existsSync(this.stateFilePath)) {
      return null;
    }

    try {
      const raw = fs.readFileSync(this.stateFilePath, "utf8");
      if (!raw.trim()) return null;

      const data = JSON.parse(raw);

      // Detect version and migrate if needed
      if (!data.version || data.version === "v3") {
        this.state = this._migrateFromV3(data);
      } else {
        this.state = data;
      }

      return this.state;
    } catch (error) {
      throw new Error(`Failed to load state: ${error.message}`);
    }
  }

  /**
   * Migrate from v3 (botv3.js) state format
   */
  _migrateFromV3(v3State) {
    const v4State = {
      version: "v4",
      tokenMint: v3State.tokenMint,
      mode: v3State.mode || "waiting_entry",

      // Position data (converted to v4 format)
      position: null,

      // Risk manager state
      riskManager: {
        startBalance: v3State.startBalanceLamports || null,
        peakBalance: v3State.peakBalanceLamports || null,
        currentBalance: null,
        sessionPnL: 0,
        tradeCount: v3State.stats?.tradeCount || 0,
        winCount: v3State.stats?.winCount || 0,
        lossCount: v3State.stats?.lossCount || 0,
      },

      // Price engine state
      priceEngine: {
        lastPriceScaled: v3State.lastPriceScaled || null,
        referencePriceScaled: v3State.referencePriceScaled || null,
      },

      // Configuration snapshot
      config: v3State.settings || {},

      // Session data
      sessionStartTime: v3State.sessionStartTime || Date.now(),
      lastUpdateTime: Date.now(),

      // Legacy fields for reference
      _legacy: {
        originalMode: v3State.mode,
        stepIndex: v3State.stepIndex,
        totalSolSpentLamports: v3State.totalSolSpentLamports,
        totalTokenAmount: v3State.totalTokenAmount,
        paused: v3State.paused,
        lastCommandLine: v3State.lastCommandLine,
      },
    };

    // Migrate active position if exists
    if (v3State.mode === "in_position" &&
        (v3State.totalTokenAmount && BigInt(v3State.totalTokenAmount) > 0n)) {

      v4State.position = {
        tokenMint: v3State.tokenMint,
        mode: "holding", // v3 doesn't track building/holding, assume holding
        currentStep: v3State.stepIndex || 0,
        totalSolSpentLamports: v3State.totalSolSpentLamports || "0",
        totalTokenAmount: v3State.totalTokenAmount || "0",

        // Calculate average entry from v3 data
        avgEntryPriceScaled: this._calculateAvgEntry(
          v3State.totalSolSpentLamports,
          v3State.totalTokenAmount
        ),

        entryHighPriceScaled: v3State.entryHighScaled || null,
        profitConfirmCount: 0,
        trailPeakBps: v3State.trailPeakBps || null,
        lastPriceScaled: v3State.lastPriceScaled || null,

        // Partial exits (v3 doesn't have this, so empty)
        partialExitsFilled: [],

        entryTime: v3State.sessionStartTime || Date.now(),
        lastUpdateTime: Date.now(),

        // Steps data (reconstructed from v3)
        steps: [],
      };
    }

    return v4State;
  }

  /**
   * Calculate average entry price from total spent and total tokens
   */
  _calculateAvgEntry(totalSolSpentLamports, totalTokenAmount) {
    if (!totalSolSpentLamports || !totalTokenAmount) return null;

    const solSpent = BigInt(totalSolSpentLamports);
    const tokens = BigInt(totalTokenAmount);

    if (tokens === 0n) return null;

    const SCALE = 1_000_000_000n;
    const avgPrice = (solSpent * SCALE) / tokens;
    return avgPrice.toString();
  }

  /**
   * Save state to disk
   */
  save(state) {
    try {
      const stateToSave = {
        ...state,
        version: "v4",
        lastUpdateTime: Date.now(),
      };

      const json = JSON.stringify(stateToSave, null, 2);
      fs.writeFileSync(this.stateFilePath, json, "utf8");

      this.state = stateToSave;
    } catch (error) {
      throw new Error(`Failed to save state: ${error.message}`);
    }
  }

  /**
   * Create backup of current state
   */
  backup() {
    if (!fs.existsSync(this.stateFilePath)) return null;

    const backupDir = path.join(path.dirname(this.stateFilePath), "..", "..", "backups");

    try {
      fs.mkdirSync(backupDir, { recursive: true });
    } catch {}

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const baseName = path.basename(this.stateFilePath, ".json");
    const backupPath = path.join(backupDir, `${baseName}_${timestamp}.json`);

    try {
      fs.copyFileSync(this.stateFilePath, backupPath);
      return backupPath;
    } catch (error) {
      throw new Error(`Failed to create backup: ${error.message}`);
    }
  }

  /**
   * Export state for a specific module
   */
  exportForModule(moduleName) {
    if (!this.state) return null;

    switch (moduleName) {
      case "trade_engine":
        return this.state.position ? {
          position: this.state.position,
        } : null;

      case "risk_manager":
        return this.state.riskManager || null;

      case "price_engine":
        return this.state.priceEngine || null;

      default:
        return null;
    }
  }

  /**
   * Update state from module
   */
  updateFromModule(moduleName, moduleState) {
    if (!this.state) {
      this.state = {
        version: "v4",
        tokenMint: null,
        mode: "waiting_entry",
        position: null,
        riskManager: {},
        priceEngine: {},
        config: {},
        sessionStartTime: Date.now(),
        lastUpdateTime: Date.now(),
      };
    }

    switch (moduleName) {
      case "trade_engine":
        this.state.position = moduleState.position;
        this.state.mode = moduleState.position ? "in_position" : "waiting_entry";
        break;

      case "risk_manager":
        this.state.riskManager = moduleState;
        break;

      case "price_engine":
        this.state.priceEngine = moduleState;
        break;
    }

    this.state.lastUpdateTime = Date.now();
  }

  /**
   * Get current state
   */
  getState() {
    return this.state;
  }

  /**
   * Reset state (create new session)
   */
  reset(tokenMint) {
    this.state = {
      version: "v4",
      tokenMint,
      mode: "waiting_entry",
      position: null,
      riskManager: {
        startBalance: null,
        peakBalance: null,
        currentBalance: null,
        sessionPnL: 0,
        tradeCount: 0,
        winCount: 0,
        lossCount: 0,
      },
      priceEngine: {
        lastPriceScaled: null,
        referencePriceScaled: null,
      },
      config: {},
      sessionStartTime: Date.now(),
      lastUpdateTime: Date.now(),
    };

    this.save(this.state);
    return this.state;
  }

  /**
   * Check if state has active position
   */
  hasActivePosition() {
    if (!this.state) return false;
    return this.state.position !== null && this.state.mode === "in_position";
  }

  /**
   * Get migration summary
   */
  getMigrationSummary() {
    if (!this.state || !this.state._legacy) {
      return null;
    }

    return {
      migrated: true,
      fromVersion: "v3",
      toVersion: "v4",
      hadActivePosition: this.state._legacy.originalMode === "in_position",
      preservedFields: Object.keys(this.state._legacy),
    };
  }
}

module.exports = StateManager;