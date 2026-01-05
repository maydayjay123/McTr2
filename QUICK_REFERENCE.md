# 🚀 BotV4 Quick Reference Card

## Start Commands

```bash
# Single wallet
npm run botv4

# Multi-wallet
WALLET_INDEX=0 npm run botv4
WALLET_INDEX=1 npm run botv4
WALLET_INDEX=2 npm run botv4

# Telegram interface
npm run tg2
```

## Telegram Commands

```
/status      - Live bot status & price
/position    - Position details & P&L
/risk        - Risk metrics & drawdown
/performance - Trading statistics
/wallets     - Switch between wallets
/refresh     - Force panel refresh
/help        - Show all commands
```

## Key Features

### Partial Exits
- 25% @ +5% profit
- 25% @ +10% profit
- 25% @ +20% profit
- Remaining 25% with trailing

### Dynamic Trailing
- Standard: 4% gap
- Above +15%: 3% gap
- Above +25%: 2% gap

### Risk Protection
- Max drawdown: 30%
- Daily loss limit: 10%
- Auto trading halt

## Files

### Core Modules
- `src/core/PriceEngine.js` - Price tracking
- `src/core/TradeEngine.js` - Position management
- `src/core/RiskManager.js` - Risk control
- `src/core/StateManager.js` - Data persistence
- `src/core/TelegramUI.js` - UI formatting
- `src/core/PerformanceMonitor.js` - Health checks

### Bots
- `src/bots/botv4.js` - Main trading bot
- `src/bots/tg_bot_v2.js` - Telegram interface

### Data
- `data/state/botv4_state.json` - Bot state
- `data/logs/botv4.log` - Bot logs
- `data/commands/tg_commands.jsonl` - Command queue

## Configuration (.env)

### Required
```env
TARGET_MINT=...
SOLANA_RPC_URL=...
TG_BOT_TOKEN=...
TG_CHAT_ID=...
```

### Optional V4 Settings
```env
PRICE_UPDATE_MS=3000
MAX_DRAWDOWN_PCT=30
TG_PANEL_REFRESH_MS=10000
```

## Monitoring

### View Logs
```bash
tail -f data/logs/botv4.log
```

### Check State
```bash
cat data/state/botv4_state.json | jq
```

### Telegram Panels
- 📊 Status - Current info
- 💼 Position - Entry & P&L
- ⚠️ Risk - Drawdown & limits
- 📈 Performance - Win rate & stats

## Troubleshooting

### No price available
```bash
curl "https://lite-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=YOUR_TOKEN&amount=10000000&slippageBps=50"
```

### Telegram not responding
```bash
curl "https://api.telegram.org/bot$TG_BOT_TOKEN/getMe"
```

### State issues
```bash
# Backup
cp -r data/ data_backup/

# Reset (WARNING: loses history)
rm data/state/botv4_state.json
```

## Quick Actions (Telegram Buttons)

### When Waiting
- 🚀 Force Buy
- ⏸️ Pause

### When In Position
- 💰 Sell 25%
- 💰 Sell 50%
- 💸 Sell All
- ⏸️ Pause

## Documentation

- **Quick Start:** [START_V4.md](START_V4.md)
- **Full Guide:** [BOTV4_GUIDE.md](BOTV4_GUIDE.md)
- **Feature Overview:** [README_V4.md](README_V4.md)
- **Upgrade Summary:** [UPGRADE_SUMMARY.md](UPGRADE_SUMMARY.md)

## Emergency Stops

### Graceful Shutdown
```bash
# Press Ctrl+C in bot terminal
# State will be saved automatically
```

### Force Sell via Telegram
```
Click: 💸 Sell All
```

### Pause Trading
```
Click: ⏸️ Pause
or
/pause command
```

## Need Help?

1. Check logs: `tail -f data/logs/botv4.log`
2. View state: `cat data/state/botv4_state.json | jq`
3. Telegram status: `/status`, `/risk`, `/performance`
4. Read docs: [BOTV4_GUIDE.md](BOTV4_GUIDE.md)

---

**Happy Trading! 🚀**