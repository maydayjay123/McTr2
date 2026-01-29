// Trading Bot Configuration
// All trading parameters in one place - easy to tweak

module.exports = {
  // ═══════════════════════════════════════════════════════════════
  // ENTRY LOGIC
  // ═══════════════════════════════════════════════════════════════

  entryDropPct: 4,              // Default: buy when price drops 4% from watch price

  // Position building steps (3 steps)
  steps: [
    { dropPct: 4,  sizePct: 15 },   // Step 1: 4% drop, use 15% of allocation
    { dropPct: 12, sizePct: 25 },   // Step 2: 12% drop, use 25% of allocation
    { dropPct: 23, sizePct: 60 },   // Step 3: 23% drop, use 60% of allocation
  ],

  // ═══════════════════════════════════════════════════════════════
  // WALLET & ALLOCATION
  // ═══════════════════════════════════════════════════════════════

  maxWalletUsePct: 80,          // Only use 80% of SOL balance

  // ═══════════════════════════════════════════════════════════════
  // TAKE PROFIT - TRAILING STOP
  // ═══════════════════════════════════════════════════════════════

  trailingTriggerPct: 10,       // Activate trailing when profit hits 10%
  trailingStopPct: 6,           // Sell when price drops 6% from peak

  // ═══════════════════════════════════════════════════════════════
  // PARTIAL EXITS (disabled by default - flip enabled to true to use)
  // ═══════════════════════════════════════════════════════════════

  partialExits: {
    enabled: false,
    levels: [
      { profitPct: 15, sellPct: 25 },  // At 15% profit, sell 25% of position
      { profitPct: 25, sellPct: 25 },  // At 25% profit, sell another 25%
      // Remaining 50% rides the trailing stop
    ]
  },

  // ═══════════════════════════════════════════════════════════════
  // DYNAMIC RE-ENTRY (after profitable sell)
  // ═══════════════════════════════════════════════════════════════

  // After a big win, wait for bigger pullback before re-entering
  // Checked in order - first match wins
  reentryRules: [
    { minProfitPct: 80, nextDropPct: 35 },  // >80% profit → wait for 35% drop
    { minProfitPct: 50, nextDropPct: 18 },  // >50% profit → wait for 18% drop
    { minProfitPct: 25, nextDropPct: 8 },   // >25% profit → wait for 8% drop
    // Below 25% profit (or loss) → use default entryDropPct (4%)
  ],

  // Cooldown: reset to normal entry after price consolidates
  cooldownResetHours: 6,        // Reset to entryDropPct after 6 hours
  cooldownRangePct: 10,         // ...if price stays within 10% range

  // ═══════════════════════════════════════════════════════════════
  // TIMING
  // ═══════════════════════════════════════════════════════════════

  priceCheckMs: 3000,           // Check price every 3 seconds
  confirmTicks: 2,              // Require 2 consecutive ticks to confirm signals

  // ═══════════════════════════════════════════════════════════════
  // FEES & SLIPPAGE
  // ═══════════════════════════════════════════════════════════════

  buySlippageBps: 150,          // 1.5% slippage for buys
  sellSlippageBps: 100,         // 1% slippage for sells
  buyPriorityFeeLamports: 0,    // Priority fee for buys (0 = none)
  sellPriorityFeeLamports: 0,   // Priority fee for sells (0 = none)

  // Escalation on failed transactions
  slippageStepBps: 25,          // Increase slippage by 0.25% per retry
  slippageCapBps: 500,          // Max slippage 5%
  priorityFeeStepLamports: 2000,
  priorityFeeCapLamports: 20000,

  // ═══════════════════════════════════════════════════════════════
  // TELEGRAM
  // ═══════════════════════════════════════════════════════════════

  tgPollIntervalMs: 1000,       // Poll Telegram every 1 second
  tgStatusRefreshMs: 10000,     // Auto-refresh status every 10 seconds (0 = disabled)
};
