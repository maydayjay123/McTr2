/**
 * TelegramUI - Professional Telegram interface with rich formatting and interactive controls
 * Provides real-time status panels, charts, and inline keyboards
 */

const EventEmitter = require("events");

class TelegramUI extends EventEmitter {
  constructor(botToken, chatId) {
    super();

    this.botToken = botToken;
    this.chatId = chatId;
    this.apiBase = `https://api.telegram.org/bot${botToken}`;

    this.lastPanelMessageId = null;
    this.lastPanelType = null;
  }

  /**
   * Send message
   */
  async sendMessage(text, options = {}) {
    try {
      const payload = {
        chat_id: this.chatId,
        text,
        parse_mode: options.parseMode || "HTML",
        disable_web_page_preview: options.disablePreview !== false,
        ...options,
      };

      const response = await this._apiCall("sendMessage", payload);
      return response.result;
    } catch (error) {
      this.emit("error", { type: "send_message", error });
      throw error;
    }
  }

  /**
   * Edit message
   */
  async editMessage(messageId, text, options = {}) {
    try {
      const payload = {
        chat_id: this.chatId,
        message_id: messageId,
        text,
        parse_mode: options.parseMode || "HTML",
        ...options,
      };

      const response = await this._apiCall("editMessageText", payload);
      return response.result;
    } catch (error) {
      // Message not modified error is OK
      if (error.message && error.message.includes("message is not modified")) {
        return null;
      }
      this.emit("error", { type: "edit_message", error });
      throw error;
    }
  }

  /**
   * Send or update status panel
   */
  async sendOrUpdatePanel(panelType, data) {
    const text = this._formatPanel(panelType, data);
    const keyboard = this._getPanelKeyboard(panelType, data);

    const options = {
      reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
    };

    try {
      if (this.lastPanelMessageId && this.lastPanelType === panelType) {
        // Update existing panel
        await this.editMessage(this.lastPanelMessageId, text, options);
      } else {
        // Send new panel
        const message = await this.sendMessage(text, options);
        this.lastPanelMessageId = message.message_id;
        this.lastPanelType = panelType;
      }
    } catch (error) {
      // If edit fails, send new message
      const message = await this.sendMessage(text, options);
      this.lastPanelMessageId = message.message_id;
      this.lastPanelType = panelType;
    }
  }

  /**
   * Format panel based on type
   */
  _formatPanel(panelType, data) {
    switch (panelType) {
      case "status":
        return this._formatStatusPanel(data);
      case "position":
        return this._formatPositionPanel(data);
      case "risk":
        return this._formatRiskPanel(data);
      case "performance":
        return this._formatPerformancePanel(data);
      default:
        return "Unknown panel type";
    }
  }

  /**
   * Format status panel
   */
  _formatStatusPanel(data) {
    const {
      mode,
      tokenName,
      currentPrice,
      priceChange24h,
      balance,
      position,
      metrics,
    } = data;

    const lines = [];

    // Header
    lines.push("<b>═══ BOT STATUS ═══</b>\n");

    // Mode indicator
    const modeIcon = mode === "in_position" ? "📊" : "⏳";
    const modeText = mode === "in_position" ? "IN POSITION" : "WAITING ENTRY";
    lines.push(`${modeIcon} <b>${modeText}</b>\n`);

    // Token info
    if (tokenName) {
      lines.push(`<b>Token:</b> ${tokenName}`);
    }

    // Price
    if (currentPrice !== null && currentPrice !== undefined) {
      const priceStr = this._formatPrice(currentPrice);
      const changeStr = priceChange24h !== null
        ? this._formatChange(priceChange24h)
        : "";
      lines.push(`<b>Price:</b> ${priceStr} ${changeStr}`);
    }

    // Balance
    if (balance !== null && balance !== undefined) {
      const balanceStr = this._formatSol(balance);
      lines.push(`<b>Balance:</b> ${balanceStr} SOL`);
    }

    lines.push("");

    // Position info
    if (position && mode === "in_position") {
      const profitStr = this._formatProfitBps(position.profitBps);
      const pnlStr = this._formatSol(position.unrealizedPnL);

      lines.push("<b>POSITION</b>");
      lines.push(`Entry: ${this._formatPrice(position.avgEntry)}`);
      lines.push(`Size: ${this._formatSol(position.solInvested)} SOL`);
      lines.push(`P&L: ${pnlStr} SOL ${profitStr}`);
      lines.push(`Step: ${position.currentStep + 1}/${position.totalSteps}`);
      lines.push("");
    }

    // Metrics
    if (metrics) {
      lines.push("<b>METRICS</b>");
      if (metrics.vwap) {
        lines.push(`VWAP: ${this._formatPrice(metrics.vwap)}`);
      }
      if (metrics.volatility !== null) {
        lines.push(`Volatility: ${(metrics.volatility * 100).toFixed(2)}%`);
      }
      if (metrics.momentum !== null) {
        lines.push(`Momentum: ${this._formatChange(metrics.momentum)}`);
      }
    }

    lines.push("");
    lines.push(`<i>Updated: ${new Date().toLocaleTimeString()}</i>`);

    return lines.join("\n");
  }

  /**
   * Format position panel
   */
  _formatPositionPanel(data) {
    const {
      mode,
      avgEntry,
      currentPrice,
      solInvested,
      tokenAmount,
      profitBps,
      unrealizedPnL,
      currentStep,
      totalSteps,
      trailPeakBps,
      partialExits,
      entryTime,
    } = data;

    const lines = [];

    lines.push("<b>═══ POSITION DETAILS ═══</b>\n");

    // Entry info
    lines.push("<b>ENTRY</b>");
    lines.push(`Price: ${this._formatPrice(avgEntry)}`);
    lines.push(`Size: ${this._formatSol(solInvested)} SOL`);
    lines.push(`Tokens: ${this._formatTokenAmount(tokenAmount)}`);
    if (entryTime) {
      const duration = this._formatDuration(Date.now() - entryTime);
      lines.push(`Duration: ${duration}`);
    }
    lines.push("");

    // Current status
    lines.push("<b>CURRENT</b>");
    lines.push(`Price: ${this._formatPrice(currentPrice)}`);
    const profitStr = this._formatProfitBps(profitBps);
    const pnlStr = this._formatSol(unrealizedPnL);
    lines.push(`P&L: ${pnlStr} SOL ${profitStr}`);
    lines.push(`Step: ${currentStep + 1}/${totalSteps}`);
    lines.push("");

    // Trailing info
    if (trailPeakBps !== null) {
      const peakPct = (trailPeakBps / 100).toFixed(2);
      lines.push(`<b>TRAIL PEAK:</b> +${peakPct}%`);
      lines.push("");
    }

    // Partial exits
    if (partialExits && partialExits.length > 0) {
      lines.push("<b>PARTIAL EXITS</b>");
      for (const exit of partialExits) {
        lines.push(`✓ ${exit.exitPct}% at +${exit.profitPct}%`);
      }
      lines.push("");
    }

    // Progress bar
    const progressBar = this._createProgressBar(profitBps, 0, 1000, 10);
    lines.push(`<code>${progressBar}</code>`);

    lines.push("");
    lines.push(`<i>Updated: ${new Date().toLocaleTimeString()}</i>`);

    return lines.join("\n");
  }

  /**
   * Format risk panel
   */
  _formatRiskPanel(data) {
    const {
      startBalance,
      currentBalance,
      peakBalance,
      pnlPct,
      drawdownFromPeak,
      drawdownFromStart,
      tradingAllowed,
      blockReason,
      tradeCount,
      winRate,
      riskLevel,
    } = data;

    const lines = [];

    lines.push("<b>═══ RISK METRICS ═══</b>\n");

    // Status
    const statusIcon = tradingAllowed ? "✅" : "🛑";
    const statusText = tradingAllowed ? "TRADING ACTIVE" : "TRADING BLOCKED";
    lines.push(`${statusIcon} <b>${statusText}</b>`);

    if (blockReason) {
      lines.push(`<i>${blockReason}</i>`);
    }
    lines.push("");

    // Balance metrics
    lines.push("<b>BALANCE</b>");
    lines.push(`Start: ${this._formatSol(startBalance)} SOL`);
    lines.push(`Peak: ${this._formatSol(peakBalance)} SOL`);
    lines.push(`Current: ${this._formatSol(currentBalance)} SOL`);
    lines.push(`P&L: ${this._formatChange(pnlPct)}`);
    lines.push("");

    // Drawdown
    lines.push("<b>DRAWDOWN</b>");
    const ddIcon = drawdownFromPeak > 20 ? "🔴" : drawdownFromPeak > 10 ? "🟡" : "🟢";
    lines.push(`${ddIcon} From Peak: ${drawdownFromPeak.toFixed(2)}%`);
    lines.push(`From Start: ${Math.abs(drawdownFromStart).toFixed(2)}%`);
    lines.push("");

    // Performance
    if (tradeCount > 0) {
      lines.push("<b>PERFORMANCE</b>");
      lines.push(`Trades: ${tradeCount}`);
      lines.push(`Win Rate: ${winRate.toFixed(1)}%`);
      lines.push("");
    }

    // Risk level
    const riskIcon = {
      low: "🟢",
      medium: "🟡",
      high: "🟠",
      extreme: "🔴",
    }[riskLevel] || "⚪";
    lines.push(`${riskIcon} <b>Risk Level: ${(riskLevel || "unknown").toUpperCase()}</b>`);

    lines.push("");
    lines.push(`<i>Updated: ${new Date().toLocaleTimeString()}</i>`);

    return lines.join("\n");
  }

  /**
   * Format performance panel
   */
  _formatPerformancePanel(data) {
    const {
      tradeCount,
      winCount,
      lossCount,
      winRate,
      totalPnL,
      avgPnLPerTrade,
      bestTrade,
      worstTrade,
      sessionDuration,
    } = data;

    const lines = [];

    lines.push("<b>═══ PERFORMANCE ═══</b>\n");

    // Summary
    lines.push("<b>SESSION</b>");
    lines.push(`Total Trades: ${tradeCount}`);
    lines.push(`Wins: ${winCount} | Losses: ${lossCount}`);
    lines.push(`Win Rate: ${winRate.toFixed(1)}%`);
    if (sessionDuration) {
      lines.push(`Duration: ${this._formatDuration(sessionDuration)}`);
    }
    lines.push("");

    // P&L
    lines.push("<b>P&L</b>");
    lines.push(`Total: ${this._formatSol(totalPnL)} SOL`);
    lines.push(`Avg/Trade: ${this._formatSol(avgPnLPerTrade)} SOL`);
    if (bestTrade) {
      lines.push(`Best: ${this._formatSol(bestTrade)} SOL`);
    }
    if (worstTrade) {
      lines.push(`Worst: ${this._formatSol(worstTrade)} SOL`);
    }
    lines.push("");

    // Win rate visualization
    const winBar = this._createProgressBar(winRate, 0, 100, 15);
    lines.push(`<code>${winBar}</code>`);

    lines.push("");
    lines.push(`<i>Updated: ${new Date().toLocaleTimeString()}</i>`);

    return lines.join("\n");
  }

  /**
   * Get keyboard for panel type
   */
  _getPanelKeyboard(panelType, data) {
    const baseButtons = [
      [
        { text: "📊 Status", callback_data: "panel_status" },
        { text: "💼 Position", callback_data: "panel_position" },
      ],
      [
        { text: "⚠️ Risk", callback_data: "panel_risk" },
        { text: "📈 Performance", callback_data: "panel_performance" },
      ],
    ];

    const actionButtons = [];

    if (data && data.mode === "waiting_entry") {
      actionButtons.push([
        { text: "🚀 Force Buy", callback_data: "action_force_buy" },
        { text: "⏸️ Pause", callback_data: "action_pause" },
      ]);
    } else if (data && data.mode === "in_position") {
      actionButtons.push([
        { text: "💰 Sell 25%", callback_data: "action_sell_25" },
        { text: "💰 Sell 50%", callback_data: "action_sell_50" },
      ]);
      actionButtons.push([
        { text: "💸 Sell All", callback_data: "action_sell_all" },
        { text: "⏸️ Pause", callback_data: "action_pause" },
      ]);
    }

    return [...baseButtons, ...actionButtons];
  }

  /**
   * Format price
   */
  _formatPrice(priceScaled) {
    if (priceScaled === null || priceScaled === undefined) return "—";
    const price = Number(priceScaled) / 1e9;
    return price.toExponential(4);
  }

  /**
   * Format SOL amount
   */
  _formatSol(lamports) {
    if (lamports === null || lamports === undefined) return "—";
    const sol = Number(lamports) / 1e9;
    return sol.toFixed(4);
  }

  /**
   * Format token amount
   */
  _formatTokenAmount(amount) {
    if (amount === null || amount === undefined) return "—";
    const num = Number(amount);
    if (num >= 1e9) return (num / 1e9).toFixed(2) + "B";
    if (num >= 1e6) return (num / 1e6).toFixed(2) + "M";
    if (num >= 1e3) return (num / 1e3).toFixed(2) + "K";
    return num.toFixed(2);
  }

  /**
   * Format profit in BPS
   */
  _formatProfitBps(bps) {
    if (bps === null || bps === undefined) return "";
    const pct = bps / 100;
    const sign = pct >= 0 ? "+" : "";
    const icon = pct >= 0 ? "📈" : "📉";
    return `${icon} ${sign}${pct.toFixed(2)}%`;
  }

  /**
   * Format percentage change
   */
  _formatChange(pct) {
    if (pct === null || pct === undefined) return "";
    const sign = pct >= 0 ? "+" : "";
    const icon = pct >= 0 ? "🟢" : "🔴";
    return `${icon} ${sign}${pct.toFixed(2)}%`;
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
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  /**
   * Create progress bar
   */
  _createProgressBar(value, min, max, length) {
    const normalized = Math.max(0, Math.min(1, (value - min) / (max - min)));
    const filled = Math.round(normalized * length);
    const empty = length - filled;

    const bar = "█".repeat(filled) + "░".repeat(empty);
    const pct = ((value - min) / (max - min) * 100).toFixed(0);

    return `${bar} ${pct}%`;
  }

  /**
   * Send alert
   */
  async sendAlert(type, data) {
    const icon = {
      price_move: "📊",
      profit_target: "🎯",
      stop_loss: "🛑",
      partial_exit: "💰",
      position_opened: "🚀",
      position_closed: "🏁",
      risk_warning: "⚠️",
      error: "❌",
    }[type] || "ℹ️";

    const text = `${icon} <b>${type.toUpperCase().replace(/_/g, " ")}</b>\n\n${data}`;
    await this.sendMessage(text);
  }

  /**
   * API call helper
   */
  async _apiCall(method, payload) {
    const fetch = require("node-fetch");
    const url = `${this.apiBase}/${method}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      timeout: 10000,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Telegram API error: ${response.status} - ${errorText}`);
    }

    return response.json();
  }
}

module.exports = TelegramUI;