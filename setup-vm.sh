#!/bin/bash
# Initial setup script for VM - run once

set -e

echo "=========================================="
echo "MM-Profit BotV4 - VM Initial Setup"
echo "=========================================="
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Get the directory where the script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

echo -e "${YELLOW}This script will set up BotV4 as a systemd service${NC}"
echo ""

# Check if running as root
if [ "$EUID" -eq 0 ]; then
    echo -e "${RED}Please run as normal user (not root)${NC}"
    echo "The script will ask for sudo when needed"
    exit 1
fi

# Get user input
echo -e "${YELLOW}Configuration:${NC}"
echo "Current user: $USER"
echo "Current directory: $SCRIPT_DIR"
echo ""
read -p "Is this correct? (y/n): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Exiting. Please run from the correct directory."
    exit 1
fi

# Check for dependencies
echo -e "${YELLOW}Checking dependencies...${NC}"

if ! command -v node &> /dev/null; then
    echo -e "${RED}Node.js not found!${NC}"
    echo "Install Node.js first: https://nodejs.org/"
    exit 1
fi

if ! command -v npm &> /dev/null; then
    echo -e "${RED}npm not found!${NC}"
    echo "Install npm first"
    exit 1
fi

if ! command -v git &> /dev/null; then
    echo -e "${RED}git not found!${NC}"
    echo "Install git first: sudo apt install git"
    exit 1
fi

echo -e "${GREEN}✓ All dependencies found${NC}"
echo ""

# Install npm packages
echo -e "${YELLOW}Installing npm packages...${NC}"
npm install
echo -e "${GREEN}✓ npm packages installed${NC}"
echo ""

# Create directories
echo -e "${YELLOW}Creating directories...${NC}"
mkdir -p data/state data/logs data/commands backups
mkdir -p /var/log/mm-trade 2>/dev/null || sudo mkdir -p /var/log/mm-trade
sudo chown $USER:$USER /var/log/mm-trade
echo -e "${GREEN}✓ Directories created${NC}"
echo ""

# Check for .env
echo -e "${YELLOW}Checking configuration files...${NC}"
if [ ! -f ".env" ]; then
    echo -e "${RED}⚠️  .env file not found!${NC}"
    echo "Creating from template..."
    if [ -f ".env.example" ]; then
        cp .env.example .env
        echo -e "${YELLOW}Please edit .env and add your configuration:${NC}"
        echo "  nano .env"
        echo ""
        echo "Required fields:"
        echo "  - TARGET_MINT"
        echo "  - SOLANA_RPC_URL"
        echo "  - TG_BOT_TOKEN"
        echo "  - TG_CHAT_ID"
        echo ""
        read -p "Press Enter after you've configured .env..."
    else
        echo -e "${RED}.env.example not found!${NC}"
        exit 1
    fi
fi

if [ ! -f "wallets.json" ]; then
    echo -e "${RED}⚠️  wallets.json not found!${NC}"
    echo "Please create wallets.json with your wallet keys"
    echo "Format: {\"wallets\": [{\"secretKey\": [...], \"label\": \"Wallet 0\"}]}"
    exit 1
fi

echo -e "${GREEN}✓ Configuration files OK${NC}"
echo ""

# Ask which setup: single or multi-wallet
echo -e "${YELLOW}Service Configuration:${NC}"
echo "1) Single wallet (default)"
echo "2) Multi-wallet (3+ wallets)"
read -p "Choose setup (1/2): " -n 1 -r SETUP_TYPE
echo
echo ""

# Prepare service files
echo -e "${YELLOW}Preparing service files...${NC}"

if [[ $SETUP_TYPE == "2" ]]; then
    # Multi-wallet setup
    read -p "How many wallets? (enter number): " WALLET_COUNT

    # Update service files
    sed -i "s|YOUR_USER|$USER|g" systemd/mm-trade-multi.service
    sed -i "s|/path/to/MM-profit|$SCRIPT_DIR|g" systemd/mm-trade-multi.service

    sed -i "s|YOUR_USER|$USER|g" systemd/mm-trade-tg.service
    sed -i "s|/path/to/MM-profit|$SCRIPT_DIR|g" systemd/mm-trade-tg.service

    # Copy to systemd
    sudo cp systemd/mm-trade-multi.service /etc/systemd/system/mm-trade-multi@.service
    sudo cp systemd/mm-trade-tg.service /etc/systemd/system/

    sudo systemctl daemon-reload

    # Enable all wallets
    for ((i=0; i<$WALLET_COUNT; i++)); do
        sudo systemctl enable mm-trade-multi@$i
        echo -e "${GREEN}✓ Enabled mm-trade-multi@$i${NC}"
    done

    sudo systemctl enable mm-trade-tg
    echo -e "${GREEN}✓ Enabled mm-trade-tg${NC}"

else
    # Single wallet setup
    # Check if old mm-trade service exists
    if systemctl list-unit-files | grep -q "^mm-trade.service"; then
        echo -e "${YELLOW}Found existing mm-trade.service${NC}"
        read -p "Upgrade it to V4? (y/n): " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            # Backup old service
            sudo cp /etc/systemd/system/mm-trade.service /etc/systemd/system/mm-trade.service.backup

            # Update to V4
            sudo sed -i 's|src/bots/botv3.js|src/bots/botv4.js|g' /etc/systemd/system/mm-trade.service
            sudo sed -i "s|WorkingDirectory=.*|WorkingDirectory=$SCRIPT_DIR|g" /etc/systemd/system/mm-trade.service

            echo -e "${GREEN}✓ Updated mm-trade.service to V4${NC}"
            SERVICE_NAME="mm-trade"
        else
            # Create new service
            sed -i "s|YOUR_USER|$USER|g" systemd/mm-trade-v4.service
            sed -i "s|/path/to/MM-profit|$SCRIPT_DIR|g" systemd/mm-trade-v4.service

            sudo cp systemd/mm-trade-v4.service /etc/systemd/system/
            sudo systemctl enable mm-trade-v4
            echo -e "${GREEN}✓ Installed mm-trade-v4.service${NC}"
            SERVICE_NAME="mm-trade-v4"
        fi
    else
        # New installation
        sed -i "s|YOUR_USER|$USER|g" systemd/mm-trade-v4.service
        sed -i "s|/path/to/MM-profit|$SCRIPT_DIR|g" systemd/mm-trade-v4.service

        sudo cp systemd/mm-trade-v4.service /etc/systemd/system/
        sudo systemctl enable mm-trade-v4
        echo -e "${GREEN}✓ Installed mm-trade-v4.service${NC}"
        SERVICE_NAME="mm-trade-v4"
    fi

    # Setup Telegram service
    sed -i "s|YOUR_USER|$USER|g" systemd/mm-trade-tg.service
    sed -i "s|/path/to/MM-profit|$SCRIPT_DIR|g" systemd/mm-trade-tg.service

    sudo cp systemd/mm-trade-tg.service /etc/systemd/system/
    sudo systemctl enable mm-trade-tg
    echo -e "${GREEN}✓ Installed mm-trade-tg.service${NC}"

    sudo systemctl daemon-reload
fi

echo ""
echo -e "${GREEN}✓ Service files installed${NC}"
echo ""

# Ask to start now
read -p "Start services now? (y/n): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo ""
    echo -e "${YELLOW}Starting services...${NC}"

    if [[ $SETUP_TYPE == "2" ]]; then
        for ((i=0; i<$WALLET_COUNT; i++)); do
            sudo systemctl start mm-trade-multi@$i
            echo -e "${GREEN}✓ Started mm-trade-multi@$i${NC}"
        done
    else
        sudo systemctl start $SERVICE_NAME
        echo -e "${GREEN}✓ Started $SERVICE_NAME${NC}"
    fi

    sudo systemctl start mm-trade-tg
    echo -e "${GREEN}✓ Started mm-trade-tg${NC}"

    echo ""
    echo -e "${YELLOW}Waiting for services to start...${NC}"
    sleep 5

    echo ""
    echo -e "${YELLOW}Checking status...${NC}"

    if [[ $SETUP_TYPE == "2" ]]; then
        for ((i=0; i<$WALLET_COUNT; i++)); do
            if systemctl is-active --quiet mm-trade-multi@$i; then
                echo -e "${GREEN}✓ mm-trade-multi@$i is running${NC}"
            else
                echo -e "${RED}✗ mm-trade-multi@$i failed to start${NC}"
                echo "Check logs: sudo journalctl -u mm-trade-multi@$i -n 50"
            fi
        done
    else
        if systemctl is-active --quiet $SERVICE_NAME; then
            echo -e "${GREEN}✓ $SERVICE_NAME is running${NC}"
        else
            echo -e "${RED}✗ $SERVICE_NAME failed to start${NC}"
            echo "Check logs: sudo journalctl -u $SERVICE_NAME -n 50"
        fi
    fi

    if systemctl is-active --quiet mm-trade-tg; then
        echo -e "${GREEN}✓ mm-trade-tg is running${NC}"
    else
        echo -e "${RED}✗ mm-trade-tg failed to start${NC}"
        echo "Check logs: sudo journalctl -u mm-trade-tg -n 50"
    fi
fi

echo ""
echo "=========================================="
echo -e "${GREEN}Setup Complete!${NC}"
echo "=========================================="
echo ""
echo "🎯 Your services:"
if [[ $SETUP_TYPE == "2" ]]; then
    for ((i=0; i<$WALLET_COUNT; i++)); do
        echo "  - mm-trade-multi@$i (wallet $i)"
    done
else
    echo "  - ${SERVICE_NAME}"
fi
echo "  - mm-trade-tg (Telegram bot)"
echo ""
echo "📋 Useful commands:"
if [[ $SETUP_TYPE == "2" ]]; then
    echo "  sudo systemctl restart mm-trade-multi@0"
    echo "  sudo systemctl status mm-trade-multi@0"
    echo "  sudo journalctl -u mm-trade-multi@0 -f"
else
    echo "  sudo systemctl restart ${SERVICE_NAME}"
    echo "  sudo systemctl status ${SERVICE_NAME}"
    echo "  sudo journalctl -u ${SERVICE_NAME} -f"
fi
echo "  sudo systemctl restart mm-trade-tg"
echo ""
echo "📱 Test Telegram:"
echo "  Open your Telegram bot"
echo "  Send: /start"
echo "  Send: /status"
echo ""
echo "🚀 For future deployments:"
echo "  ./deploy.sh"
echo ""
echo "📖 Full documentation:"
echo "  VM_SETUP.md"
echo "  BOTV4_GUIDE.md"
echo ""