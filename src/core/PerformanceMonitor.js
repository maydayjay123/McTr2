/**
 * PerformanceMonitor - System health checks and performance metrics
 * Tracks bot performance, errors, and system resources
 */

const EventEmitter = require("events");

class PerformanceMonitor extends EventEmitter {
  constructor(config = {}) {
    super();

    this.config = {
      metricsIntervalMs: config.metricsIntervalMs || 60000, // 1 minute
      healthCheckIntervalMs: config.healthCheckIntervalMs || 30000, // 30 seconds
      errorThreshold: config.errorThreshold || 10,
      errorWindowMs: config.errorWindowMs || 300000, // 5 minutes
      ...config,
    };

    this.metrics = {
      uptime: 0,
      startTime: Date.now(),

      // API metrics
      apiCalls: {
        total: 0,
        successful: 0,
        failed: 0,
        avgResponseTime: 0,
      },

      // Trade metrics
      trades: {
        total: 0,
        buys: 0,
      sells: 0,
        avgExecutionTime: 0,
      },

      // Error tracking
      errors: {
        total: 0,
        recent: [],
        byType: {},
      },

      // Price feed
      priceFeed: {
        updates: 0,
        staleCount: 0,
        lastUpdate: null,
        avgUpdateInterval: 0,
      },

      // System
      system: {
        memoryUsage: 0,
        cpuUsage: 0,
      },
    };

    this.healthStatus = {
      healthy: true,
      issues: [],
      lastCheck: Date.now(),
    };

    this.isRunning = false;
    this.metricsTimer = null;
    this.healthTimer = null;

    this.apiCallTimestamps = [];
    this.priceUpdateTimestamps = [];
  }

  /**
   * Start monitoring
   */
  start() {
    if (this.isRunning) return;

    this.isRunning = true;
    this.metrics.startTime = Date.now();

    // Start metrics collection
    this.metricsTimer = setInterval(() => {
      this._updateMetrics();
    }, this.config.metricsIntervalMs);

    // Start health checks
    this.healthTimer = setInterval(() => {
      this._performHealthCheck();
    }, this.config.healthCheckIntervalMs);

    this.emit("started");
  }

  /**
   * Stop monitoring
   */
  stop() {
    this.isRunning = false;

    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = null;
    }

    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }

    this.emit("stopped");
  }

  /**
   * Record API call
   */
  recordApiCall(success, responseTimeMs) {
    this.metrics.apiCalls.total++;

    if (success) {
      this.metrics.apiCalls.successful++;
    } else {
      this.metrics.apiCalls.failed++;
    }

    // Update average response time
    const totalCalls = this.metrics.apiCalls.total;
    const currentAvg = this.metrics.apiCalls.avgResponseTime;
    this.metrics.apiCalls.avgResponseTime =
      (currentAvg * (totalCalls - 1) + responseTimeMs) / totalCalls;

    this.apiCallTimestamps.push(Date.now());

    // Trim old timestamps
    const cutoff = Date.now() - 3600000; // Keep last hour
    this.apiCallTimestamps = this.apiCallTimestamps.filter(ts => ts > cutoff);
  }

  /**
   * Record trade
   */
  recordTrade(type, executionTimeMs) {
    this.metrics.trades.total++;

    if (type === "buy") {
      this.metrics.trades.buys++;
    } else if (type === "sell") {
      this.metrics.trades.sells++;
    }

    // Update average execution time
    const totalTrades = this.metrics.trades.total;
    const currentAvg = this.metrics.trades.avgExecutionTime;
    this.metrics.trades.avgExecutionTime =
      (currentAvg * (totalTrades - 1) + executionTimeMs) / totalTrades;

    this.emit("trade_recorded", { type, executionTimeMs });
  }

  /**
   * Record error
   */
  recordError(type, error) {
    this.metrics.errors.total++;

    // Add to recent errors
    this.metrics.errors.recent.push({
      type,
      message: error.message || String(error),
      timestamp: Date.now(),
    });

    // Trim to last 50 errors
    if (this.metrics.errors.recent.length > 50) {
      this.metrics.errors.recent = this.metrics.errors.recent.slice(-50);
    }

    // Count by type
    if (!this.metrics.errors.byType[type]) {
      this.metrics.errors.byType[type] = 0;
    }
    this.metrics.errors.byType[type]++;

    // Check error rate
    this._checkErrorRate();

    this.emit("error_recorded", { type, error });
  }

  /**
   * Record price update
   */
  recordPriceUpdate() {
    this.metrics.priceFeed.updates++;
    this.metrics.priceFeed.lastUpdate = Date.now();

    this.priceUpdateTimestamps.push(Date.now());

    // Calculate average update interval
    if (this.priceUpdateTimestamps.length >= 2) {
      const intervals = [];
      for (let i = 1; i < this.priceUpdateTimestamps.length; i++) {
        intervals.push(this.priceUpdateTimestamps[i] - this.priceUpdateTimestamps[i - 1]);
      }
      this.metrics.priceFeed.avgUpdateInterval =
        intervals.reduce((a, b) => a + b, 0) / intervals.length;
    }

    // Trim old timestamps
    const cutoff = Date.now() - 3600000; // Keep last hour
    this.priceUpdateTimestamps = this.priceUpdateTimestamps.filter(ts => ts > cutoff);
  }

  /**
   * Record stale price
   */
  recordStalePrice() {
    this.metrics.priceFeed.staleCount++;
    this.emit("stale_price");
  }

  /**
   * Update metrics
   */
  _updateMetrics() {
    this.metrics.uptime = Date.now() - this.metrics.startTime;

    // Update system metrics
    const memUsage = process.memoryUsage();
    this.metrics.system.memoryUsage = memUsage.heapUsed;

    this.emit("metrics_update", this.getMetrics());
  }

  /**
   * Perform health check
   */
  _performHealthCheck() {
    const issues = [];

    // Check price feed
    if (this.metrics.priceFeed.lastUpdate) {
      const staleDuration = Date.now() - this.metrics.priceFeed.lastUpdate;
      if (staleDuration > 60000) { // 1 minute
        issues.push({
          severity: "warning",
          component: "price_feed",
          message: `Price feed stale for ${Math.round(staleDuration / 1000)}s`,
        });
      }
    }

    // Check error rate
    const recentErrors = this.metrics.errors.recent.filter(
      err => Date.now() - err.timestamp < this.config.errorWindowMs
    );

    if (recentErrors.length >= this.config.errorThreshold) {
      issues.push({
        severity: "critical",
        component: "error_rate",
        message: `High error rate: ${recentErrors.length} errors in ${this.config.errorWindowMs / 1000}s`,
      });
    }

    // Check API success rate
    if (this.metrics.apiCalls.total > 0) {
      const successRate = this.metrics.apiCalls.successful / this.metrics.apiCalls.total;
      if (successRate < 0.9) { // Less than 90% success
        issues.push({
          severity: "warning",
          component: "api",
          message: `Low API success rate: ${(successRate * 100).toFixed(1)}%`,
        });
      }
    }

    // Check memory usage
    const memLimit = 500 * 1024 * 1024; // 500MB
    if (this.metrics.system.memoryUsage > memLimit) {
      issues.push({
        severity: "warning",
        component: "memory",
        message: `High memory usage: ${Math.round(this.metrics.system.memoryUsage / 1024 / 1024)}MB`,
      });
    }

    // Update health status
    const previouslyHealthy = this.healthStatus.healthy;
    this.healthStatus = {
      healthy: issues.length === 0,
      issues,
      lastCheck: Date.now(),
    };

    // Emit health change event
    if (previouslyHealthy && !this.healthStatus.healthy) {
      this.emit("health_degraded", issues);
    } else if (!previouslyHealthy && this.healthStatus.healthy) {
      this.emit("health_restored");
    }

    this.emit("health_check", this.healthStatus);
  }

  /**
   * Check error rate threshold
   */
  _checkErrorRate() {
    const windowStart = Date.now() - this.config.errorWindowMs;
    const recentErrors = this.metrics.errors.recent.filter(
      err => err.timestamp > windowStart
    );

    if (recentErrors.length >= this.config.errorThreshold) {
      this.emit("error_threshold_exceeded", {
        count: recentErrors.length,
        windowMs: this.config.errorWindowMs,
      });
    }
  }

  /**
   * Get current metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      uptime: Date.now() - this.metrics.startTime,
    };
  }

  /**
   * Get health status
   */
  getHealthStatus() {
    return { ...this.healthStatus };
  }

  /**
   * Get performance summary
   */
  getSummary() {
    const metrics = this.getMetrics();

    return {
      uptime: this._formatDuration(metrics.uptime),
      apiCalls: {
        total: metrics.apiCalls.total,
        successRate: metrics.apiCalls.total > 0
          ? ((metrics.apiCalls.successful / metrics.apiCalls.total) * 100).toFixed(1) + "%"
          : "N/A",
        avgResponseTime: metrics.apiCalls.avgResponseTime.toFixed(0) + "ms",
      },
      trades: {
        total: metrics.trades.total,
        buys: metrics.trades.buys,
        sells: metrics.trades.sells,
        avgExecutionTime: metrics.trades.avgExecutionTime.toFixed(0) + "ms",
      },
      errors: {
        total: metrics.errors.total,
        recent: metrics.errors.recent.length,
      },
      priceFeed: {
        updates: metrics.priceFeed.updates,
        avgInterval: metrics.priceFeed.avgUpdateInterval
          ? metrics.priceFeed.avgUpdateInterval.toFixed(0) + "ms"
          : "N/A",
        staleCount: metrics.priceFeed.staleCount,
      },
      health: this.healthStatus.healthy ? "Healthy" : "Issues Detected",
    };
  }

  /**
   * Format duration
   */
  _formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
  }

  /**
   * Reset metrics
   */
  reset() {
    this.metrics = {
      uptime: 0,
      startTime: Date.now(),
      apiCalls: { total: 0, successful: 0, failed: 0, avgResponseTime: 0 },
      trades: { total: 0, buys: 0, sells: 0, avgExecutionTime: 0 },
      errors: { total: 0, recent: [], byType: {} },
      priceFeed: { updates: 0, staleCount: 0, lastUpdate: null, avgUpdateInterval: 0 },
      system: { memoryUsage: 0, cpuUsage: 0 },
    };

    this.apiCallTimestamps = [];
    this.priceUpdateTimestamps = [];

    this.emit("reset");
  }
}

module.exports = PerformanceMonitor;