#!/bin/bash
# Quick deployment script for VM

set -e

echo "=========================================="
echo "MM-Profit BotV4 Deployment"
echo "=========================================="
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Get the directory where the script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

echo -e "${YELLOW}Step 1: Pulling latest changes...${NC}"
git pull
echo -e "${GREEN}✓ Code updated${NC}"
echo ""

echo -e "${YELLOW}Step 2: Checking environment...${NC}"
if [ ! -f ".env" ]; then
    echo "⚠️  .env file not found!"
    echo "Please create .env from .env.example"
    exit 1
fi

if [ ! -f "wallets.json" ]; then
    echo "⚠️  wallets.json not found!"
    echo "Please create wallets.json"
    exit 1
fi
echo -e "${GREEN}✓ Environment OK${NC}"
echo ""

echo -e "${YELLOW}Step 3: Creating data directories...${NC}"
mkdir -p data/state data/logs data/commands backups
echo -e "${GREEN}✓ Directories created${NC}"
echo ""

echo -e "${YELLOW}Step 4: Backing up current state...${NC}"
if [ -f "data/state/botv4_state.json" ]; then
    BACKUP_NAME="backups/state_backup_$(date +%Y%m%d_%H%M%S).json"
    cp data/state/botv4_state.json "$BACKUP_NAME"
    echo -e "${GREEN}✓ Backup created: $BACKUP_NAME${NC}"
else
    echo "No existing state to backup"
fi
echo ""

echo -e "${YELLOW}Step 5: Restarting services...${NC}"

# Check which services exist
if systemctl list-unit-files | grep -q "mm-trade-v4.service"; then
    echo "Restarting mm-trade-v4..."
    sudo systemctl restart mm-trade-v4
    echo -e "${GREEN}✓ mm-trade-v4 restarted${NC}"
elif systemctl list-unit-files | grep -q "mm-trade.service"; then
    echo "Restarting mm-trade..."
    sudo systemctl restart mm-trade
    echo -e "${GREEN}✓ mm-trade restarted${NC}"
else
    echo "⚠️  No trading service found"
    echo "Run setup first (see VM_SETUP.md)"
fi

if systemctl list-unit-files | grep -q "mm-trade-tg.service"; then
    echo "Restarting mm-trade-tg..."
    sudo systemctl restart mm-trade-tg
    echo -e "${GREEN}✓ mm-trade-tg restarted${NC}"
fi

# Check for multi-wallet instances
for i in {0..5}; do
    if systemctl is-active --quiet mm-trade-multi@$i; then
        echo "Restarting mm-trade-multi@$i..."
        sudo systemctl restart mm-trade-multi@$i
        echo -e "${GREEN}✓ mm-trade-multi@$i restarted${NC}"
    fi
done

echo ""
echo -e "${YELLOW}Step 6: Checking status...${NC}"
sleep 3

if systemctl list-unit-files | grep -q "mm-trade-v4.service"; then
    if systemctl is-active --quiet mm-trade-v4; then
        echo -e "${GREEN}✓ mm-trade-v4 is running${NC}"
    else
        echo -e "⚠️  mm-trade-v4 is NOT running"
        echo "Check logs: sudo journalctl -u mm-trade-v4 -n 50"
    fi
elif systemctl list-unit-files | grep -q "mm-trade.service"; then
    if systemctl is-active --quiet mm-trade; then
        echo -e "${GREEN}✓ mm-trade is running${NC}"
    else
        echo -e "⚠️  mm-trade is NOT running"
        echo "Check logs: sudo journalctl -u mm-trade -n 50"
    fi
fi

if systemctl list-unit-files | grep -q "mm-trade-tg.service"; then
    if systemctl is-active --quiet mm-trade-tg; then
        echo -e "${GREEN}✓ mm-trade-tg is running${NC}"
    else
        echo -e "⚠️  mm-trade-tg is NOT running"
        echo "Check logs: sudo journalctl -u mm-trade-tg -n 50"
    fi
fi

echo ""
echo "=========================================="
echo -e "${GREEN}Deployment Complete!${NC}"
echo "=========================================="
echo ""
echo "📊 View logs:"
echo "  sudo journalctl -u mm-trade-v4 -f"
echo "  tail -f data/logs/botv4.log"
echo ""
echo "📱 Check Telegram:"
echo "  /status"
echo ""
echo "🔍 Check status:"
echo "  sudo systemctl status mm-trade-v4"
echo ""