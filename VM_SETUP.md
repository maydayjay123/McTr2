# 🖥️ VM Setup Guide - BotV4 Production Deployment

## Quick Setup on Your VM

### Step 1: Push to Git & Pull on VM

**On your development machine:**
```bash
cd /c/Users/Shadow/Documents/AAAA/MM-profit
git add .
git commit -m "Upgrade to BotV4 with professional features"
git push
```

**On your VM:**
```bash
cd /path/to/MM-profit
git pull
```

---

## Step 2: Install Systemd Services

### Option A: Single Wallet Setup

**1. Create log directory:**
```bash
sudo mkdir -p /var/log/mm-trade
sudo chown $USER:$USER /var/log/mm-trade
```

**2. Copy service files:**
```bash
# Edit service files first - replace YOUR_USER and /path/to/MM-profit
nano systemd/mm-trade-v4.service
# Change: User=YOUR_USER → User=youruser
# Change: WorkingDirectory=/path/to/MM-profit → WorkingDirectory=/home/youruser/MM-profit
# Change: ReadWritePaths=/path/to/MM-profit/data → ReadWritePaths=/home/youruser/MM-profit/data

nano systemd/mm-trade-tg.service
# Same changes

# Copy to systemd
sudo cp systemd/mm-trade-v4.service /etc/systemd/system/
sudo cp systemd/mm-trade-tg.service /etc/systemd/system/
```

**3. Enable and start:**
```bash
sudo systemctl daemon-reload
sudo systemctl enable mm-trade-v4
sudo systemctl enable mm-trade-tg
sudo systemctl start mm-trade-v4
sudo systemctl start mm-trade-tg
```

---

### Option B: Multi-Wallet Setup

**1. Setup for 3 wallets (0, 1, 2):**
```bash
# Edit the template file first
nano systemd/mm-trade-multi.service
# Make the same USER and path changes as above

# Copy template
sudo cp systemd/mm-trade-multi.service /etc/systemd/system/mm-trade-multi@.service
sudo cp systemd/mm-trade-tg.service /etc/systemd/system/

# Enable all wallets
sudo systemctl daemon-reload
sudo systemctl enable mm-trade-multi@0
sudo systemctl enable mm-trade-multi@1
sudo systemctl enable mm-trade-multi@2
sudo systemctl enable mm-trade-tg

# Start all
sudo systemctl start mm-trade-multi@0
sudo systemctl start mm-trade-multi@1
sudo systemctl start mm-trade-multi@2
sudo systemctl start mm-trade-tg
```

---

## Step 3: Manage Your Services

### Your Existing Commands Work!

**Restart all (your current workflow):**
```bash
sudo systemctl restart mm-trade-v4
sudo systemctl restart mm-trade-tg
```

**For multi-wallet:**
```bash
sudo systemctl restart mm-trade-multi@0
sudo systemctl restart mm-trade-multi@1
sudo systemctl restart mm-trade-multi@2
sudo systemctl restart mm-trade-tg
```

### Check Status

**Single wallet:**
```bash
sudo systemctl status mm-trade-v4
sudo systemctl status mm-trade-tg
```

**Multi-wallet:**
```bash
sudo systemctl status mm-trade-multi@0
sudo systemctl status mm-trade-multi@1
sudo systemctl status mm-trade-multi@2
sudo systemctl status mm-trade-tg
```

### View Logs

**Real-time logs:**
```bash
# BotV4
sudo journalctl -u mm-trade-v4 -f

# Telegram
sudo journalctl -u mm-trade-tg -f

# Multi-wallet
sudo journalctl -u mm-trade-multi@0 -f
```

**All logs combined:**
```bash
sudo journalctl -u mm-trade-v4 -u mm-trade-tg -f
```

**File logs:**
```bash
tail -f /var/log/mm-trade/botv4.log
tail -f /var/log/mm-trade/tg-bot.log
```

**Multi-wallet logs:**
```bash
tail -f /var/log/mm-trade/botv4-0.log
tail -f /var/log/mm-trade/botv4-1.log
tail -f /var/log/mm-trade/botv4-2.log
```

### Stop Services

```bash
sudo systemctl stop mm-trade-v4
sudo systemctl stop mm-trade-tg

# Or multi-wallet
sudo systemctl stop mm-trade-multi@{0,1,2}
sudo systemctl stop mm-trade-tg
```

---

## Step 4: Migration from V3

### If You're Currently Running V3

**Option 1: Direct Upgrade (Recommended)**

Your existing `mm-trade` service can stay as-is, just update it to run BotV4:

```bash
# Edit your existing service
sudo nano /etc/systemd/system/mm-trade.service

# Change this line:
# ExecStart=/usr/bin/node src/bots/botv3.js
# To:
ExecStart=/usr/bin/node src/bots/botv4.js

# Reload and restart
sudo systemctl daemon-reload
sudo systemctl restart mm-trade
```

**BotV4 will automatically:**
- ✅ Detect your V3 state
- ✅ Migrate to V4 format
- ✅ Preserve active positions
- ✅ Continue trading

Check logs to confirm migration:
```bash
sudo journalctl -u mm-trade -n 50
```

You should see:
```
State loaded successfully
Migrated from v3 to v4
Active position preserved from previous version
```

**Option 2: Side-by-Side (Testing)**

Run V3 and V4 together on different wallets:

```bash
# V3 on wallet 0 (existing)
sudo systemctl restart mm-trade

# V4 on wallet 1 (new)
sudo systemctl start mm-trade-multi@1

# Compare behavior before full migration
```

---

## Step 5: Update Your Deployment Workflow

### Your Git Push → VM Pull Workflow

**Development machine (Windows):**
```bash
# Make changes
cd /c/Users/Shadow/Documents/AAAA/MM-profit

# Test locally if needed
npm run botv4

# Commit and push
git add .
git commit -m "Update bot configuration"
git push
```

**VM (production):**
```bash
# Pull changes
cd /path/to/MM-profit
git pull

# Restart services (your existing command works!)
sudo systemctl restart mm-trade-v4
sudo systemctl restart mm-trade-tg

# Or if you renamed:
sudo systemctl restart mm-trade
```

---

## Monitoring & Maintenance

### Health Checks

**Quick health check script:**
```bash
#!/bin/bash
# save as ~/check-bot.sh

echo "=== Bot Status ==="
sudo systemctl is-active mm-trade-v4
sudo systemctl is-active mm-trade-tg

echo ""
echo "=== Recent Errors ==="
sudo journalctl -u mm-trade-v4 --since "5 minutes ago" | grep ERROR

echo ""
echo "=== Position Status ==="
cat /path/to/MM-profit/data/state/botv4_state.json | jq '.mode, .position.profitBps'

echo ""
echo "=== Memory Usage ==="
ps aux | grep "node src/bots/botv4" | awk '{print $4"%"}'
```

Make it executable:
```bash
chmod +x ~/check-bot.sh
./check-bot.sh
```

### Automated Monitoring (Optional)

**Cron job to check every 5 minutes:**
```bash
crontab -e

# Add:
*/5 * * * * /home/youruser/check-bot.sh >> /var/log/mm-trade/health-check.log 2>&1
```

### Log Rotation

**Create log rotation config:**
```bash
sudo nano /etc/logrotate.d/mm-trade

# Add:
/var/log/mm-trade/*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    create 0644 youruser youruser
}
```

Test:
```bash
sudo logrotate -d /etc/logrotate.d/mm-trade
```

---

## Troubleshooting on VM

### Service Won't Start

**Check status:**
```bash
sudo systemctl status mm-trade-v4
```

**Common issues:**

1. **Permission error:**
```bash
# Fix data directory permissions
chmod -R u+rw /path/to/MM-profit/data
```

2. **Missing .env:**
```bash
# Check .env exists
ls -la /path/to/MM-profit/.env

# Copy from example if missing
cp .env.example .env
nano .env  # Fill in values
```

3. **Node not found:**
```bash
# Find node path
which node

# Update service file with correct path
sudo nano /etc/systemd/system/mm-trade-v4.service
# Update: ExecStart=/usr/bin/node ...
```

4. **Port conflicts:**
```bash
# Check if another bot is running
ps aux | grep "node src/bots"

# Kill old processes
pkill -f "node src/bots/botv3"
```

### Migration Issues

**Check migration status:**
```bash
# View state version
cat data/state/botv4_state.json | jq '.version'

# Should show: "v4"

# Check for legacy data
cat data/state/botv4_state.json | jq '._legacy'
```

**If migration failed:**
```bash
# Restore from backup
cp data_backup/state/botv3_state.json data/state/

# Restart service (will retry migration)
sudo systemctl restart mm-trade-v4

# Check logs
sudo journalctl -u mm-trade-v4 -n 100
```

### Performance Issues

**Check resource usage:**
```bash
# Memory
free -h

# CPU
top -bn1 | grep "node"

# Disk
df -h
```

**Adjust memory limits if needed:**
```bash
sudo nano /etc/systemd/system/mm-trade-v4.service

# Change:
MemoryMax=500M
# To:
MemoryMax=1G

sudo systemctl daemon-reload
sudo systemctl restart mm-trade-v4
```

---

## Backup Strategy on VM

### Automated Backups

**Daily backup script:**
```bash
#!/bin/bash
# save as ~/backup-bot.sh

BACKUP_DIR="/home/youruser/mm-profit-backups"
DATE=$(date +%Y%m%d_%H%M%S)

mkdir -p $BACKUP_DIR

# Backup data directory
tar -czf $BACKUP_DIR/data_$DATE.tar.gz /path/to/MM-profit/data

# Keep only last 7 days
find $BACKUP_DIR -name "data_*.tar.gz" -mtime +7 -delete

echo "Backup completed: data_$DATE.tar.gz"
```

**Add to crontab:**
```bash
crontab -e

# Daily at 2 AM
0 2 * * * /home/youruser/backup-bot.sh
```

---

## Quick Reference Commands

### Start/Stop
```bash
sudo systemctl start mm-trade-v4       # Start
sudo systemctl stop mm-trade-v4        # Stop
sudo systemctl restart mm-trade-v4     # Restart (your go-to!)
sudo systemctl status mm-trade-v4      # Status
```

### Logs
```bash
sudo journalctl -u mm-trade-v4 -f      # Follow live
sudo journalctl -u mm-trade-v4 -n 100  # Last 100 lines
tail -f /var/log/mm-trade/botv4.log    # File log
```

### Enable/Disable Auto-start
```bash
sudo systemctl enable mm-trade-v4      # Start on boot
sudo systemctl disable mm-trade-v4     # Don't start on boot
```

### Force Reload
```bash
sudo systemctl daemon-reload           # After editing service file
```

---

## Production Checklist

Before going live with BotV4:

- [ ] `.env` configured with correct values
- [ ] `wallets.json` present with keys
- [ ] Systemd service files edited (USER, paths)
- [ ] Services enabled and started
- [ ] Logs showing successful startup
- [ ] Telegram bot responding to `/status`
- [ ] State migration completed (check logs)
- [ ] Backup system configured
- [ ] Health monitoring set up
- [ ] Log rotation configured

---

## Your Workflow (Summary)

**Daily management:**
```bash
# On development machine
cd /c/Users/Shadow/Documents/AAAA/MM-profit
# make changes
git push

# On VM
ssh your-vm
cd /path/to/MM-profit
git pull
sudo systemctl restart mm-trade-v4
sudo journalctl -u mm-trade-v4 -f  # check it's working
```

**That's it!** Your existing workflow stays the same, just with better features! 🚀

---

## Need Help?

**Check logs first:**
```bash
sudo journalctl -u mm-trade-v4 -n 200 --no-pager
```

**Common log locations:**
- `/var/log/mm-trade/botv4.log` - Main log
- `/var/log/mm-trade/botv4-error.log` - Errors only
- `/path/to/MM-profit/data/logs/botv4.log` - Bot's own log

**Telegram status:**
```
/status
/risk
/performance
```

**Full docs:** [BOTV4_GUIDE.md](BOTV4_GUIDE.md)

---

🎉 **Your VM is ready to run BotV4 24/7!**