#!/usr/bin/env bash
# Pull the latest code and restart. Usage: sudo bash /opt/shipzora/deploy/update.sh
set -euo pipefail
BRANCH=${BRANCH:-claude/magical-fermat-r1s6l0}
cd /opt/shipzora
sudo -u shipzora git fetch origin "$BRANCH"
sudo -u shipzora git checkout -q "$BRANCH"
sudo -u shipzora git pull -q origin "$BRANCH"
sudo -u shipzora npm ci --no-audit --no-fund
sudo -u shipzora env PLAYWRIGHT_BROWSERS_PATH=/opt/shipzora/pw-browsers npx playwright install chromium
systemctl restart shipzora
sleep 3
systemctl --no-pager --lines=5 status shipzora
