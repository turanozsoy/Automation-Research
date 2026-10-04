#!/usr/bin/env bash
# One-shot server setup on a fresh Ubuntu 22.04 / 24.04 VPS.
#   curl -fsSL https://raw.githubusercontent.com/turanozsoy/Automation-Research/claude/magical-fermat-r1s6l0/deploy/install.sh -o install.sh
#   sudo bash install.sh careers.yourdomain.com
# Installs Node 22, Chromium (Playwright), the service as a systemd unit, a virtual display + noVNC for the login
# browsers, and Caddy (automatic HTTPS). Safe to run again: existing secrets and the env file are kept.
set -euo pipefail
DOMAIN=${1:?usage: sudo bash install.sh <domain>}
REPO_URL=${REPO_URL:-https://github.com/turanozsoy/Automation-Research.git}
BRANCH=${BRANCH:-claude/magical-fermat-r1s6l0}
APP_DIR=/opt/shipzora
DATA_DIR=/var/lib/shipzora
ENV_FILE=/etc/shipzora/service.env
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }

echo "== packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https xvfb x11vnc novnc websockify fonts-liberation >/dev/null
if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi

echo "== user, directories"
id shipzora >/dev/null 2>&1 || useradd --system --no-create-home --home-dir "$APP_DIR" --shell /usr/sbin/nologin shipzora
mkdir -p "$APP_DIR" "$DATA_DIR" /etc/shipzora /var/backups/shipzora
chown shipzora:shipzora "$APP_DIR" "$DATA_DIR" /var/backups/shipzora
chmod 700 "$DATA_DIR"

echo "== code ($BRANCH)"
# the directory may already exist (home skeleton, an earlier attempt): initialise in place instead of cloning
if [ ! -d "$APP_DIR/.git" ]; then
  sudo -u shipzora git init -q "$APP_DIR"
  sudo -u shipzora git -C "$APP_DIR" remote add origin "$REPO_URL"
fi
cd "$APP_DIR"
sudo -u shipzora git fetch -q origin "$BRANCH"
sudo -u shipzora git checkout -q -B "$BRANCH" "origin/$BRANCH"
sudo -u shipzora git branch -q --set-upstream-to "origin/$BRANCH" "$BRANCH" || true
sudo -u shipzora npm ci --no-audit --no-fund
sudo -u shipzora env PLAYWRIGHT_BROWSERS_PATH="$APP_DIR/pw-browsers" npx playwright install chromium
npx playwright install-deps chromium >/dev/null 2>&1 || true

echo "== secrets and environment"
if [ ! -f "$ENV_FILE" ]; then
  MASTER=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
  ADMINPW=$(node -e "console.log(require('crypto').randomBytes(12).toString('base64url'))")
  sed -e "s|^PROFILE_MASTER_KEY=.*|PROFILE_MASTER_KEY=$MASTER|" -e "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$ADMINPW|" deploy/service.env.example > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "   wrote $ENV_FILE"
else
  echo "   $ENV_FILE exists, kept"
fi
if [ ! -f /etc/shipzora/vncpasswd ]; then
  VNCPW=$(node -e "console.log(require('crypto').randomBytes(9).toString('base64url'))")
  x11vnc -storepasswd "$VNCPW" /etc/shipzora/vncpasswd >/dev/null
  echo "$VNCPW" > /etc/shipzora/vnc-password.txt; chmod 600 /etc/shipzora/vnc-password.txt
fi
VNCPW=$(cat /etc/shipzora/vnc-password.txt)
chown shipzora:shipzora /etc/shipzora/vncpasswd

echo "== services"
install -m 644 deploy/shipzora.service deploy/shipzora-xvfb.service deploy/shipzora-vnc.service deploy/shipzora-novnc.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now shipzora-xvfb shipzora-vnc shipzora-novnc >/dev/null
systemctl enable shipzora >/dev/null
systemctl restart shipzora

echo "== caddy (HTTPS for $DOMAIN)"
HASH=$(caddy hash-password --plaintext "$VNCPW")
sed -e "s|DOMAIN|$DOMAIN|g" -e "s|VNC_HASH|$HASH|" deploy/Caddyfile.template > /etc/caddy/Caddyfile
systemctl enable caddy >/dev/null; systemctl restart caddy

echo "== daily backup"
cat > /etc/cron.d/shipzora-backup <<CRON
15 4 * * * root DATA_DIR=$DATA_DIR bash $APP_DIR/deploy/backup.sh >> /var/log/shipzora-backup.log 2>&1
CRON

sleep 3
echo
echo "────────────────────────────────────────────────────────────"
echo "  Site:            https://$DOMAIN"
echo "  Operations page: https://$DOMAIN/admin/accounts"
echo "  Operator password:  $(grep ^ADMIN_PASSWORD= "$ENV_FILE" | cut -d= -f2-)"
echo "  Login browsers:  https://$DOMAIN/vnc/vnc.html   user: operator   password: $VNCPW"
echo "  Environment:     $ENV_FILE   (set META_PIXEL_ID and META_CAPI_TOKEN, then: systemctl restart shipzora)"
echo "  Website B config: $APP_DIR/config/site-b.local.json  (copy yours here, owner shipzora, then restart)"
echo "  Logs:            journalctl -u shipzora -f"
echo "  Update:          sudo bash $APP_DIR/deploy/update.sh"
echo "────────────────────────────────────────────────────────────"
systemctl --no-pager --lines=3 status shipzora || true
