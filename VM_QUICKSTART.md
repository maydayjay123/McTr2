# 🚀 VM Quick Start - 3 Steps

## First Time Setup (One Time Only)

**On your VM:**

```bash
# 1. Clone/pull the repo
cd /path/to/MM-profit
git pull

# 2. Run setup script (one time only)
chmod +x setup-vm.sh
./setup-vm.sh

# Follow the prompts - it will:
# - Install npm packages
# - Create directories
# - Set up systemd services
# - Start the bots

# 3. Check Telegram
# Open your bot and send: /start
```

That's it! Your bot is now running 24/7! ✅

---

## Daily Workflow (After Setup)

**Development → Production**

### On Your Windows Dev Machine:

```bash
cd /c/Users/Shadow/Documents/AAAA/MM-profit

# Make changes, test if needed
npm run botv4

# Push to git
git add .
git commit -m "Update config"
git push
```

### On Your VM:

```bash
# Pull and deploy
cd /path/to/MM-profit
./deploy.sh

# Or manually:
git pull
sudo systemctl restart mm-trade
```

**Done!** Your VM is now running the latest code. 🎉

---

## Quick Commands

### Check Status
```bash
sudo systemctl status mm-trade-v4
sudo systemctl status mm-trade-tg
```

### Restart (Your Go-To Command)
```bash
sudo systemctl restart mm-trade-v4
sudo systemctl restart mm-trade-tg

# Or if you kept the old name:
sudo systemctl restart mm-trade
```

### View Logs
```bash
# Live logs
sudo journalctl -u mm-trade-v4 -f

# Last 100 lines
sudo journalctl -u mm-trade-v4 -n 100

# Bot's own log
tail -f data/logs/botv4.log
```

### Stop/Start
```bash
sudo systemctl stop mm-trade-v4
sudo systemctl start mm-trade-v4
```

---

## Multi-Wallet Setup

If you have multiple wallets:

```bash
# Restart all
sudo systemctl restart mm-trade-multi@{0,1,2}
sudo systemctl restart mm-trade-tg

# Check status
sudo systemctl status mm-trade-multi@0
sudo systemctl status mm-trade-multi@1
sudo systemctl status mm-trade-multi@2

# View logs
sudo journalctl -u mm-trade-multi@0 -f
```

---

## Telegram Monitoring

Your bot is always accessible via Telegram:

```
/status      - Live status
/position    - Position details
/risk        - Risk metrics
/performance - Statistics
```

Use the **interactive buttons** to control the bot! 📱

---

## Troubleshooting

### Bot Not Starting?

```bash
# Check the logs
sudo journalctl -u mm-trade-v4 -n 50

# Common issues:
# 1. .env missing
ls -la .env

# 2. wallets.json missing
ls -la wallets.json

# 3. Permissions
chmod -R u+rw data/
```

### Migration Issues?

```bash
# Check state version
cat data/state/botv4_state.json | jq '.version'

# Should show "v4"

# If migration failed, check logs
sudo journalctl -u mm-trade-v4 | grep -i migrate
```

### Telegram Not Working?

```bash
# Test bot token
curl "https://api.telegram.org/bot$TG_BOT_TOKEN/getMe"

# Check Telegram service
sudo systemctl status mm-trade-tg
sudo journalctl -u mm-trade-tg -n 50
```

---

## Auto-Restart on Failures

Your services are configured to **automatically restart** if they crash:

```
Restart=always
RestartSec=10
```

The bot will:
- Restart automatically on failure
- Wait 10 seconds between restarts
- Preserve state across restarts
- Continue trading seamlessly

---

## Summary

**Your workflow is simple:**

1. **First time:** Run `./setup-vm.sh`
2. **Updates:** Run `./deploy.sh`
3. **Monitor:** Use Telegram (`/status`)
4. **Restart:** `sudo systemctl restart mm-trade`

**That's it!** 🎉

Your bot runs 24/7, auto-restarts on failures, and you control everything via Telegram!

---

🚀 **Happy Trading!**