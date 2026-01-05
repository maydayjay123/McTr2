# BotV4 - Professional Trading Bot Upgrade Guide

## 🚀 What's New in V4

BotV4 is a complete rewrite with professional-grade features:

### **Core Improvements**

1. **Modular Architecture**
   - Separated concerns: PriceEngine, TradeEngine, RiskManager, TelegramUI
   - Each module is independent and testable
   - Event-driven communication between modules

2. **Real-Time Price Tracking**
   - Continuous price updates (configurable interval)
   - VWAP calculation
   - Volatility metrics
   - Momentum indicators
   - Price history tracking

3. **Advanced Trade Engine**
   - **Partial Exits**: Automatically take profits at multiple levels
     - 25% at +5%, 25% at +10%, 25% at +20%
   - **Dynamic Trailing Stop**: Tightens as profit increases
     - Standard 4% gap
     - 3% gap above +15% profit
     - 2% gap above +25% profit
   - **Multi-Step Position Building**: Smart averaging down
   - **Exit Confirmation**: Prevents premature exits

4. **Risk Management**
   - **Drawdown Protection**: Automatic trading halt at risk limits
   - **Session Tracking**: Win rate, PnL, trade count
   - **Position Sizing**: Kelly Criterion support
   - **Daily Loss Limits**: Prevents excessive losses
   - **Risk Level Indicators**: Low, Medium, High, Extreme

5. **Professional Telegram UI**
   - **4 Interactive Panels**:
     - 📊 Status: Live price, position, balance
     - 💼 Position: Entry, P&L, trailing info
     - ⚠️ Risk: Drawdown, limits, health
     - 📈 Performance: Win rate, trades, stats
   - **Rich Formatting**: HTML, progress bars, emojis
   - **Inline Keyboards**: One-click actions
   - **Auto-Refresh**: Panels update every 10 seconds
   - **Multi-Wallet Support**: Switch between wallets

6. **Performance Monitoring**
   - **Health Checks**: API success rate, error tracking
   - **Metrics**: Response times, trade execution speed
   - **System Monitoring**: Memory usage, uptime
   - **Error Threshold Alerts**: Automatic warnings

7. **Backward Compatibility**
   - **Automatic State Migration**: V3 → V4
   - **Preserves Active Trades**: No disruption to open positions
   - **Legacy Support**: Can read old state files

---

## 📋 Migration from BotV3 to BotV4

### **Safety First**

BotV4 automatically migrates your state from V3, **preserving active trades**.

**Before migrating:**

1. **Backup your data**:
   ```bash
   cp -r data/ data_backup_$(date +%Y%m%d)/
   ```

2. **No code changes needed** - V4 reads V3 state files automatically

### **Migration Process**

1. **Your existing botv3 state** will be detected
2. **Active positions** are preserved with:
   - Total SOL spent
   - Total token amount
   - Average entry price (calculated)
   - Step index
3. **Risk metrics** are carried over:
   - Trade count
   - Win/loss record
   - Balance history
4. **New V4 state** is saved with `version: "v4"` marker

### **What Happens During Migration**

```
V3 State:
{
  mode: "in_position",
  stepIndex: 1,
  totalSolSpentLamports: "150000000",
  totalTokenAmount: "1500000000",
  ...
}

↓ Automatic Migration ↓

V4 State:
{
  version: "v4",
  mode: "in_position",
  position: {
    totalSolSpentLamports: "150000000",
    totalTokenAmount: "1500000000",
    avgEntryPriceScaled: "calculated",
    currentStep: 1,
    ...
  },
  riskManager: { ... },
  _legacy: { originalMode: "in_position", ... }
}
```

---

## 🎯 Quick Start

### **1. Install (if needed)**

```bash
npm install
```

### **2. Configuration**

Your existing `.env` works! New optional settings:

```env
# Existing settings from V3 work as-is
TARGET_MINT=your_token_mint
SOLANA_RPC_URL=your_rpc_url
TRADE_ALLOC_PCT=88

# New V4 settings (optional)
PRICE_UPDATE_MS=3000          # Price refresh interval
MAX_DRAWDOWN_PCT=30           # Auto-stop at drawdown
TG_UPDATE_INTERVAL_MS=5000    # Telegram poll interval
TG_PANEL_REFRESH_MS=10000     # Panel auto-refresh
```

### **3. Run BotV4**

**Single wallet:**
```bash
node src/bots/botv4.js
```

**Multi-wallet:**
```bash
WALLET_INDEX=0 node src/bots/botv4.js &
WALLET_INDEX=1 node src/bots/botv4.js &
WALLET_INDEX=2 node src/bots/botv4.js &
```

### **4. Run Telegram Bot V2**

```bash
node src/bots/tg_bot_v2.js
```

---

## 📱 Telegram Interface

### **Commands**

- `/status` - Bot status and current price
- `/position` - Detailed position info
- `/risk` - Risk metrics and drawdown
- `/performance` - Trading statistics
- `/wallets` - Switch between wallets (multi-wallet)
- `/refresh` - Force refresh current panel
- `/help` - Show all commands

### **Interactive Panels**

Each panel has **inline buttons** for:

- 📊 **Navigation**: Switch between Status/Position/Risk/Performance
- 🎮 **Actions**:
  - 🚀 Force Buy (when waiting)
  - 💰 Sell 25%/50%/All (when in position)
  - ⏸️ Pause/Resume

### **Status Panel Example**

```
═══ BOT STATUS ═══

📊 IN POSITION

Token: EPjF...xqaU
Price: 1.2340e-8 🟢 +2.45%
Balance: 0.5234 SOL

POSITION
Entry: 1.2000e-8
Size: 0.1500 SOL
P&L: 0.0051 SOL 📈 +3.40%
Step: 2/3

METRICS
VWAP: 1.2300e-8
Volatility: 0.15%
Momentum: 🟢 +1.23%

Updated: 14:23:45
```

---

## 🎨 New Features in Detail

### **1. Partial Exits**

Automatically lock in profits at multiple levels:

```javascript
partialExitLevels: [
  { profitPct: 5, exitPct: 25 },   // Take 25% at +5%
  { profitPct: 10, exitPct: 25 },  // Take 25% at +10%
  { profitPct: 20, exitPct: 25 },  // Take 25% at +20%
]
```

**How it works:**
- Bot monitors profit percentage
- At each level, sells specified percentage
- Remaining position continues running
- Reduces risk while maintaining upside

### **2. Dynamic Trailing Stop**

Trailing gap **tightens** as profit grows:

```javascript
dynamicTrailingLevels: [
  { profitPct: 15, gapPct: 3 },  // 3% gap above +15%
  { profitPct: 25, gapPct: 2 },  // 2% gap above +25%
]
```

**Example:**
- Entry: $1.00
- Price reaches $1.20 (+20%)
- Trailing activates with 3% gap (because profit > 15%)
- Stop loss: $1.164 (20% - 3% = 17%)
- If price continues to $1.30 (+30%)
- Trailing tightens to 2% gap (because profit > 25%)
- Stop loss: $1.274 (30% - 2% = 28%)

### **3. Risk Manager**

Protects your capital automatically:

**Drawdown Protection:**
```javascript
maxDrawdownPct: 30  // Stop trading at -30% from peak
```

**Daily Loss Limit:**
```javascript
maxDailyLossPct: 10  // Stop trading at -10% daily
```

**When limits hit:**
- Trading automatically paused
- Telegram alert sent
- Reason displayed in Risk panel
- Manual resume required

### **4. Performance Monitoring**

Tracks bot health in real-time:

**Metrics Tracked:**
- API call success rate
- Average response time
- Trade execution speed
- Error frequency
- Price feed staleness
- Memory usage

**Health Checks:**
- Price feed status (alerts if stale > 1min)
- Error rate (alerts if > 10 errors in 5min)
- API success rate (warns if < 90%)
- Memory usage (warns if > 500MB)

**Health Events:**
- `health_degraded` - Issues detected
- `health_restored` - All systems normal
- `error_threshold_exceeded` - Too many errors

---

## 🔧 Configuration Reference

### **Core Settings**

| Setting | Default | Description |
|---------|---------|-------------|
| `TARGET_MINT` | Required | Token to trade |
| `TRADE_ALLOC_PCT` | 88 | % of balance for trading |
| `STEP_SOL_PCT` | 15,25,60 | Position steps (must sum to 100) |
| `STEP_DRAWDOWN_PCT` | 0,6,12 | Drawdown % to trigger each step |

### **Profit Targets**

| Setting | Default | Description |
|---------|---------|-------------|
| `PROFIT_TARGET_BPS` | 300 | Target profit (300 = 3%) |
| `PROFIT_CONFIRM_TICKS` | 2 | Ticks at target before exit |
| `TRAILING_START_PCT` | 8 | Start trailing at +8% |
| `TRAILING_GAP_PCT` | 4 | Trailing gap % |
| `TRAILING_MIN_PROFIT_PCT` | 3 | Min profit for trail exit |

### **Risk Management**

| Setting | Default | Description |
|---------|---------|-------------|
| `MAX_DRAWDOWN_PCT` | 30 | Max drawdown before halt |
| `MAX_DAILY_LOSS_PCT` | 10 | Max daily loss % |

### **Fees & Slippage**

| Setting | Default | Description |
|---------|---------|-------------|
| `BUY_SLIPPAGE_BPS` | 100 | Buy slippage (100 = 1%) |
| `SELL_SLIPPAGE_BPS` | 50 | Sell slippage (50 = 0.5%) |
| `BUY_PRIORITY_FEE_LAMPORTS` | 0 | Buy priority fee |
| `SELL_PRIORITY_FEE_LAMPORTS` | 0 | Sell priority fee |

### **Timing**

| Setting | Default | Description |
|---------|---------|-------------|
| `POLL_MS` | 5000 | Main loop interval |
| `PRICE_UPDATE_MS` | 3000 | Price refresh interval |
| `BALANCE_REFRESH_MS` | 30000 | Balance check interval |
| `TG_PANEL_REFRESH_MS` | 10000 | Telegram panel refresh |

---

## 🏗️ Architecture

```
BotV4
├── Core Modules (src/core/)
│   ├── PriceEngine.js       - Price tracking & metrics
│   ├── TradeEngine.js       - Position & exit logic
│   ├── RiskManager.js       - Risk limits & session
│   ├── StateManager.js      - State persistence & migration
│   ├── TelegramUI.js        - UI formatting & panels
│   └── PerformanceMonitor.js - Health checks & metrics
│
├── Bots (src/bots/)
│   ├── botv4.js            - Main trading bot (V4)
│   ├── tg_bot_v2.js        - Telegram interface (V2)
│   ├── botv3.js            - Legacy bot (still works)
│   └── tg_bot.js           - Legacy Telegram (still works)
│
└── Data (data/)
    ├── state/              - Bot state files
    │   ├── botv4_state.json
    │   └── botv4_state_{index}.json
    ├── logs/               - Log files
    └── commands/           - Command queue files
```

---

## 🔄 Running V3 and V4 Together

You can run V3 and V4 simultaneously on **different wallets**:

**Terminal 1 - V3 on Wallet 0:**
```bash
WALLET_INDEX=0 node src/bots/botv3.js
```

**Terminal 2 - V4 on Wallet 1:**
```bash
WALLET_INDEX=1 node src/bots/botv4.js
```

**Terminal 3 - Telegram (supports both):**
```bash
node src/bots/tg_bot_v2.js
```

Use `/wallets` command to switch between them in Telegram.

---

## 📊 State File Format

### **V4 State Structure**

```json
{
  "version": "v4",
  "tokenMint": "EPjF...xqaU",
  "mode": "in_position",

  "position": {
    "tokenMint": "EPjF...xqaU",
    "mode": "holding",
    "currentStep": 1,
    "totalSolSpentLamports": "150000000",
    "totalTokenAmount": "1500000000",
    "avgEntryPriceScaled": "100000000",
    "entryHighPriceScaled": "105000000",
    "trailPeakBps": 800,
    "partialExitsFilled": [],
    "entryTime": 1704067200000,
    "steps": [...]
  },

  "riskManager": {
    "startBalance": "500000000",
    "peakBalance": "520000000",
    "currentBalance": "515000000",
    "sessionPnL": 15000000,
    "tradeCount": 5,
    "winCount": 4,
    "lossCount": 1
  },

  "priceEngine": {
    "lastPriceScaled": "104000000",
    "referencePriceScaled": "100000000"
  },

  "sessionStartTime": 1704063600000,
  "lastUpdateTime": 1704067200000
}
```

---

## 🐛 Troubleshooting

### **State Migration Issues**

**Problem:** "Failed to load state"
```bash
# Check state file exists
ls -la data/state/

# Validate JSON
cat data/state/botv4_state.json | jq

# Manual backup
cp data/state/botv3_state.json data/state/botv3_state_backup.json
```

### **Price Feed Issues**

**Problem:** "No price available"
```bash
# Check Jupiter API
curl "https://lite-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=YOUR_TOKEN&amount=10000000&slippageBps=50"

# Check RPC
curl -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' YOUR_RPC_URL
```

### **Telegram Not Updating**

**Problem:** Panels not refreshing
```bash
# Check bot token
echo $TG_BOT_TOKEN

# Test API
curl "https://api.telegram.org/bot$TG_BOT_TOKEN/getMe"

# Check logs
tail -f data/logs/botv4.log
```

### **Module Errors**

**Problem:** "Cannot find module '../core/...'"
```bash
# Check file structure
ls -la src/core/

# Reinstall if needed
rm -rf node_modules
npm install
```

---

## 📈 Best Practices

### **1. Start Small**

Test V4 with small position sizes first:
```env
TRADE_ALLOC_PCT=10  # Start with 10% instead of 88%
```

### **2. Monitor Closely**

Watch the Telegram interface during first trades:
- Check partial exits trigger correctly
- Verify trailing stop behavior
- Monitor risk metrics

### **3. Adjust Gradually**

Fine-tune settings based on results:
- Tighten trailing gaps if exiting too early
- Adjust partial exit levels for your strategy
- Modify drawdown limits based on volatility

### **4. Regular Backups**

```bash
# Daily backup script
#!/bin/bash
DATE=$(date +%Y%m%d)
tar -czf backup_$DATE.tar.gz data/
```

### **5. Health Monitoring**

Check performance metrics regularly:
```bash
# View health status in Telegram
/performance

# Check logs for warnings
grep "WARN" data/logs/botv4.log
```

---

## 🎓 Advanced Usage

### **Custom Partial Exit Levels**

Edit [TradeEngine.js](src/core/TradeEngine.js#L19-L23):
```javascript
partialExitLevels: [
  { profitPct: 3, exitPct: 20 },   // Conservative: early exits
  { profitPct: 7, exitPct: 30 },
  { profitPct: 15, exitPct: 30 },
]
```

### **Custom Trailing Levels**

Edit [TradeEngine.js](src/core/TradeEngine.js#L26-L30):
```javascript
dynamicTrailingLevels: [
  { profitPct: 10, gapPct: 3.5 },  // Tighter at +10%
  { profitPct: 20, gapPct: 2.5 },  // Even tighter at +20%
  { profitPct: 30, gapPct: 1.5 },  // Very tight at +30%
]
```

### **Kelly Criterion Position Sizing**

Enable in [RiskManager.js](src/core/RiskManager.js):
```javascript
// Get optimal position size
const kellyFraction = riskManager.calculateKellyFraction();
const positionSize = availableBalance * BigInt(Math.floor(kellyFraction * 100)) / 100n;
```

---

## 🆘 Support

- **Issues**: Check [botv4 logs](data/logs/botv4.log)
- **State**: Inspect [state files](data/state/)
- **Performance**: Monitor via `/performance` in Telegram

---

## 🎉 Enjoy Your Upgraded Bot!

BotV4 brings professional-grade features to your trading:
- ✅ Partial exits for risk management
- ✅ Dynamic trailing for maximum profit
- ✅ Real-time risk monitoring
- ✅ Professional Telegram interface
- ✅ Backward compatible migration
- ✅ Performance monitoring

**Happy Trading! 🚀**