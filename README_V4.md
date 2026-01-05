# MM-Profit BotV4 - Professional Solana Trading Bot 🚀

**Version 0.2.0** - Complete professional revamp with advanced features

## ✨ Key Features

### 🎯 Advanced Trading
- **Partial Exits** - Automatically take profits at 5%, 10%, 20%
- **Dynamic Trailing Stop** - Tightens as profit grows (4% → 3% → 2%)
- **Multi-Step Position Building** - Smart averaging down
- **Exit Confirmation** - Prevents premature exits

### 🛡️ Risk Management
- **Drawdown Protection** - Auto-halt at risk limits
- **Session Tracking** - Win rate, P&L, trade statistics
- **Position Sizing** - Kelly Criterion support
- **Daily Loss Limits** - Protect against excessive losses

### 📱 Professional Telegram UI
- **4 Interactive Panels**: Status, Position, Risk, Performance
- **Rich Formatting** - HTML, progress bars, live metrics
- **Inline Keyboards** - One-click trading actions
- **Auto-Refresh** - Real-time updates every 10 seconds
- **Multi-Wallet Support** - Manage multiple bots

### 📊 Real-Time Monitoring
- **Live Price Tracking** - Continuous updates
- **VWAP & Volatility** - Technical indicators
- **Performance Metrics** - API health, execution speed
- **Health Checks** - Automatic system monitoring

### 🔄 Backward Compatible
- **Automatic Migration** - V3 → V4 state conversion
- **Preserves Active Trades** - No disruption
- **Legacy Support** - Can run V3 and V4 together

---

## 🚀 Quick Start

### 1. Run BotV4

**Single wallet:**
```bash
npm run botv4
```

**Multi-wallet:**
```bash
WALLET_INDEX=0 npm run botv4 &
WALLET_INDEX=1 npm run botv4 &
WALLET_INDEX=2 npm run botv4 &
```

### 2. Run Telegram Interface

```bash
npm run tg2
```

### 3. Use Telegram Commands

- `/status` - Live bot status
- `/position` - Position details
- `/risk` - Risk metrics
- `/performance` - Trading stats
- `/help` - All commands

---

## 📋 What's Included

### New Core Modules (`src/core/`)

1. **PriceEngine.js** - Real-time price tracking
   - Continuous price updates
   - VWAP calculation
   - Volatility metrics
   - Price history

2. **TradeEngine.js** - Advanced trade execution
   - Partial exits at multiple levels
   - Dynamic trailing stop
   - Multi-step position building
   - Exit signal generation

3. **RiskManager.js** - Capital protection
   - Drawdown monitoring
   - Session P&L tracking
   - Position size calculation
   - Risk level indicators

4. **StateManager.js** - State persistence
   - Backward-compatible migration
   - Automatic V3 → V4 conversion
   - State backup system

5. **TelegramUI.js** - Professional UI
   - Rich HTML formatting
   - Interactive panels
   - Progress bars & emojis
   - Inline keyboards

6. **PerformanceMonitor.js** - Health monitoring
   - API success tracking
   - Error rate monitoring
   - System health checks
   - Performance metrics

### New Bots

- **botv4.js** - Main trading bot with modular architecture
- **tg_bot_v2.js** - Enhanced Telegram interface

---

## 🎨 Feature Highlights

### Partial Exits in Action

```
Entry: $1.00
Price: $1.05 → Sell 25% (+5% profit)
Price: $1.10 → Sell 25% (+10% profit)
Price: $1.20 → Sell 25% (+20% profit)
Remaining: 25% with trailing stop
```

### Dynamic Trailing Stop

```
Profit < +15%:  4% trailing gap
Profit > +15%:  3% trailing gap
Profit > +25%:  2% trailing gap
```

### Risk Protection

```
Drawdown Monitor:
  Peak: 0.500 SOL
  Current: 0.400 SOL
  Drawdown: 20% ⚠️ Warning

  At 30%: 🛑 Trading Halted
```

---

## 📊 Telegram UI Examples

### Status Panel
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

[📊 Status] [💼 Position]
[⚠️ Risk]   [📈 Performance]
[💰 Sell 25%] [💰 Sell 50%]
[💸 Sell All] [⏸️ Pause]
```

### Risk Panel
```
═══ RISK METRICS ═══

✅ TRADING ACTIVE

BALANCE
Start: 0.5000 SOL
Peak: 0.5200 SOL
Current: 0.5150 SOL
P&L: 🟢 +3.00%

DRAWDOWN
🟢 From Peak: 0.96%
From Start: -3.00%

PERFORMANCE
Trades: 8
Win Rate: 75.0%

🟢 Risk Level: LOW
```

---

## 🔧 Configuration

Your existing `.env` works! New optional settings:

```env
# V4 New Settings (Optional)
PRICE_UPDATE_MS=3000          # Price refresh (3s)
MAX_DRAWDOWN_PCT=30           # Auto-stop limit
TG_PANEL_REFRESH_MS=10000     # Panel refresh (10s)

# All V3 Settings Still Work
TARGET_MINT=...
TRADE_ALLOC_PCT=88
STEP_SOL_PCT=15,25,60
STEP_DRAWDOWN_PCT=0,6,12
PROFIT_TARGET_BPS=300
TRAILING_START_PCT=8
TRAILING_GAP_PCT=4
```

---

## 🔄 Migration from V3

### Automatic Migration

BotV4 **automatically migrates** your V3 state:

1. ✅ Detects existing V3 state
2. ✅ Preserves active positions
3. ✅ Converts to V4 format
4. ✅ Backs up original state
5. ✅ Continues trading seamlessly

### What's Preserved

- Total SOL spent
- Total token amount
- Average entry price
- Step index
- Trade history
- Session statistics

### Running Both Versions

You can run V3 and V4 simultaneously:

```bash
# V3 on Wallet 0
WALLET_INDEX=0 npm run botv3 &

# V4 on Wallet 1
WALLET_INDEX=1 npm run botv4 &

# Telegram (supports both)
npm run tg2
```

---

## 📖 Documentation

**Full Guide**: [BOTV4_GUIDE.md](BOTV4_GUIDE.md)

Includes:
- Detailed feature explanations
- Configuration reference
- Advanced usage examples
- Troubleshooting guide
- Best practices

---

## 🏗️ Architecture

```
Modular Design:
┌─────────────────┐
│    BotV4.js     │ ← Main orchestrator
└────────┬────────┘
         │
    ┌────┴────┐
    │ Modules │
    └────┬────┘
         │
    ┌────┴────────────────────┐
    │                         │
┌───▼────┐  ┌──────▼──────┐  │
│ Price  │  │    Trade    │  │
│ Engine │  │   Engine    │  │
└────────┘  └─────────────┘  │
                              │
┌────────────┐  ┌────────▼────┐
│    Risk    │  │   State     │
│  Manager   │  │  Manager    │
└────────────┘  └─────────────┘
                              │
┌────────────────┐  ┌─────────▼────┐
│  Performance   │  │  Telegram    │
│   Monitor      │  │     UI       │
└────────────────┘  └──────────────┘
```

---

## 📈 Performance Improvements

### Over V3:

- ✅ **Modular Code** - Easy to maintain and extend
- ✅ **Event-Driven** - Better separation of concerns
- ✅ **Real-Time Data** - Live price & metrics
- ✅ **Professional UI** - Rich Telegram interface
- ✅ **Risk Protection** - Automatic safeguards
- ✅ **Health Monitoring** - System diagnostics
- ✅ **Partial Exits** - Better risk management
- ✅ **Dynamic Trailing** - Maximize profits

---

## 🆘 Support

### Check Status
```bash
# View bot logs
tail -f data/logs/botv4.log

# Check state file
cat data/state/botv4_state.json | jq

# Telegram status
/status
/performance
```

### Common Issues

**"No price available"**
- Check Jupiter API connectivity
- Verify RPC URL is working

**"State migration failed"**
- Check data/state/ permissions
- Verify V3 state file format

**Telegram not updating**
- Verify TG_BOT_TOKEN is correct
- Check TG_CHAT_ID matches

Full troubleshooting: [BOTV4_GUIDE.md](BOTV4_GUIDE.md#-troubleshooting)

---

## 🎯 Next Steps

1. **Read the Guide** - [BOTV4_GUIDE.md](BOTV4_GUIDE.md)
2. **Backup Your Data** - `cp -r data/ data_backup/`
3. **Test with Small Positions** - Start with low allocation
4. **Monitor via Telegram** - Use the interactive panels
5. **Adjust Settings** - Fine-tune for your strategy

---

## 🎉 Enjoy Trading!

BotV4 brings professional features to your Solana trading:

- 🎯 Smarter exits with partial profits
- 🛡️ Better risk management
- 📱 Professional Telegram UI
- 📊 Real-time monitoring
- 🔄 Seamless migration from V3

**Start Trading:** `npm run botv4`

**Questions?** Check [BOTV4_GUIDE.md](BOTV4_GUIDE.md)

---

**Happy Trading! 🚀📈**