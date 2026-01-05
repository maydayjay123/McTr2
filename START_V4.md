# 🚀 Quick Start Guide - BotV4

## Step 1: Verify Your Setup

Your existing configuration will work! Just verify:

```bash
# Check your .env file has these required fields:
cat .env | grep -E "TARGET_MINT|SOLANA_RPC_URL|TG_BOT_TOKEN|TG_CHAT_ID"
```

## Step 2: Backup Your Data (Important!)

```bash
# Create backup of current state
cp -r data/ data_backup_$(date +%Y%m%d_%H%M%S)/

# Or on Windows PowerShell:
# Copy-Item -Recurse data data_backup_$(Get-Date -Format "yyyyMMdd_HHmmss")
```

## Step 3: Start BotV4

**Option A: Single Wallet**
```bash
npm run botv4
```

**Option B: Multi-Wallet (if you have multiple wallets)**
```bash
# Terminal 1 - Wallet 0
WALLET_INDEX=0 npm run botv4

# Terminal 2 - Wallet 1
WALLET_INDEX=1 npm run botv4

# Terminal 3 - Wallet 2
WALLET_INDEX=2 npm run botv4

# Windows PowerShell:
# $env:WALLET_INDEX=0; npm run botv4
```

## Step 4: Start Telegram Bot V2

**New terminal:**
```bash
npm run tg2
```

## Step 5: Open Telegram

1. Open your Telegram bot chat
2. Type `/start` or `/help`
3. Use the interactive buttons to navigate

### Quick Commands:
- `/status` - See live bot status
- `/position` - View your position details
- `/risk` - Check risk metrics
- `/performance` - See trading stats

## What to Expect

### First Launch:

```
============================================================
BotV4 - Professional Solana Trading Bot
============================================================
Wallet: 8vZ9x...3pQm
RPC: https://your-rpc-url.com
Token: EPjF...xqaU
State loaded successfully
Migrated from v3 to v4
Active position preserved from previous version
Price engine started
Performance monitor started
============================================================
Bot running - Press Ctrl+C to stop
============================================================
```

### If You Had Active Trades:

✅ **Your position is automatically preserved!**

The bot will:
1. Detect your existing V3 state
2. Migrate to V4 format
3. Continue managing your open position
4. Apply new V4 features (partial exits, dynamic trailing)

## Telegram Interface

You'll see panels like this:

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

Updated: 14:23:45
```

**Use the buttons below the message to:**
- Switch between panels
- Execute trades (Force Buy, Sell 25%, Sell All)
- Pause/Resume the bot

## Monitor Your Bot

### Watch Logs:
```bash
# View live logs
tail -f data/logs/botv4.log

# Search for specific events
grep "Buy executed" data/logs/botv4.log
grep "Position closed" data/logs/botv4.log
grep "Partial exit" data/logs/botv4.log
```

### Check State:
```bash
# View current state (pretty print)
cat data/state/botv4_state.json | jq

# Check if position is active
cat data/state/botv4_state.json | jq '.mode'
```

## Testing the New Features

### 1. Partial Exits

When your position reaches profit:
- **+5%**: Bot sells 25% automatically
- **+10%**: Bot sells another 25%
- **+20%**: Bot sells another 25%
- **Remaining 25%**: Runs with trailing stop

Watch Telegram for alerts: "💰 Partial exit: 25% at +5%"

### 2. Dynamic Trailing Stop

As profit grows, trailing tightens:
- **Below +15%**: 4% trailing gap
- **Above +15%**: 3% trailing gap (tighter!)
- **Above +25%**: 2% trailing gap (very tight!)

### 3. Risk Protection

If drawdown hits limits:
- Bot pauses trading automatically
- Sends Telegram alert
- Shows reason in `/risk` panel

### 4. Real-Time Panels

Panels auto-refresh every 10 seconds with live data:
- Current price
- Unrealized P&L
- Risk metrics
- Win rate

## Controlling the Bot

### Via Telegram Buttons:

**When Waiting for Entry:**
- 🚀 Force Buy
- ⏸️ Pause

**When In Position:**
- 💰 Sell 25%
- 💰 Sell 50%
- 💸 Sell All
- ⏸️ Pause

### Via Commands File:

The bot reads commands from `data/commands/tg_commands.jsonl`

You can also write commands manually:
```bash
echo '{"type":"pause","timestamp":1704067200000}' >> data/commands/tg_commands.jsonl
echo '{"type":"resume","timestamp":1704067200000}' >> data/commands/tg_commands.jsonl
echo '{"type":"force_buy","timestamp":1704067200000}' >> data/commands/tg_commands.jsonl
echo '{"type":"force_sell","timestamp":1704067200000}' >> data/commands/tg_commands.jsonl
```

## Stopping the Bot

**Graceful Shutdown:**
```bash
# Press Ctrl+C in the terminal running botv4

# The bot will:
# 1. Stop price engine
# 2. Stop performance monitor
# 3. Save current state
# 4. Log "Shutdown complete"
```

**Your position is safe!** State is saved to disk.

## Troubleshooting

### "Failed to load wallet"
```bash
# Check wallets.json exists
ls -la wallets.json

# Verify format
cat wallets.json | jq
```

### "No price available"
```bash
# Test Jupiter API manually
curl "https://lite-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=YOUR_TOKEN_MINT&amount=10000000&slippageBps=50"

# Check if Jupiter is down
# Try alternative: JUPITER_API_BASE=https://quote-api.jup.ag
```

### "Telegram bot not responding"
```bash
# Verify token
echo $TG_BOT_TOKEN

# Test API
curl "https://api.telegram.org/bot$TG_BOT_TOKEN/getMe"

# Check bot is running
ps aux | grep tg_bot_v2
```

### "State migration issues"
```bash
# Check V3 state exists
cat data/state/botv3_state.json

# Manual backup
cp data/state/botv3_state.json data/state/botv3_state_backup.json

# Reset to fresh state (WARNING: loses history)
rm data/state/botv4_state.json
```

## Next Steps

1. ✅ **Monitor First Trade** - Watch logs and Telegram
2. ✅ **Test Partial Exits** - Let position hit +5% to see it work
3. ✅ **Check Risk Panel** - Monitor drawdown metrics
4. ✅ **Review Performance** - Use `/performance` command
5. ✅ **Adjust Settings** - Fine-tune in `.env` if needed

## Advanced: Running V3 and V4 Together

You can test V4 alongside V3:

```bash
# V3 on Wallet 0
WALLET_INDEX=0 npm run botv3 &

# V4 on Wallet 1
WALLET_INDEX=1 npm run botv4 &

# Telegram Bot V2 (supports both)
npm run tg2 &

# In Telegram, use /wallets to switch between them
```

## Need Help?

- **Full Documentation**: [BOTV4_GUIDE.md](BOTV4_GUIDE.md)
- **Feature Overview**: [README_V4.md](README_V4.md)
- **Check Logs**: `tail -f data/logs/botv4.log`
- **Telegram Status**: `/status`, `/risk`, `/performance`

---

## 🎉 You're Ready!

Your bot is now running with professional features:

✅ Partial exits for risk management
✅ Dynamic trailing for max profit
✅ Real-time risk monitoring
✅ Professional Telegram UI
✅ Performance tracking
✅ Health monitoring

**Monitor via Telegram and watch your improved bot in action! 🚀**