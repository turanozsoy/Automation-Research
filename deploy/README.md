# Hosting

One Ubuntu 22.04 / 24.04 server, one command. The applicant site must stay on the domain the old site used (same
Meta Pixel). Point the domain's A record at the server first.

```bash
curl -fsSL https://raw.githubusercontent.com/turanozsoy/Automation-Research/claude/magical-fermat-r1s6l0/deploy/install.sh -o install.sh
sudo bash install.sh careers.yourdomain.com
```

The script installs Node 22, Chromium, the service (systemd, restarts on crash and reboot), a virtual display with a
web VNC viewer for the login browsers, Caddy with automatic HTTPS, and a daily backup. It prints the operator
password and the VNC password at the end. Running it again is safe: secrets and the environment file are kept.

Afterwards:

1. Copy your real Website B settings to `/opt/shipzora/config/site-b.local.json` (`chown shipzora:shipzora`).
2. Edit `/etc/shipzora/service.env`: `META_PIXEL_ID`, `META_CAPI_TOKEN` (and `META_TEST_EVENT_CODE` while testing).
3. `sudo systemctl restart shipzora`.
4. Open `https://<domain>/admin/accounts`, import proxies, add accounts. "Get cookies" opens the login browser on
   the virtual display: watch and drive it at
   `https://<domain>/vnc/vnc.html?path=vnc/websockify&autoconnect=true` (browser login: user `operator` and the VNC
   password, then the same password once more for the screen). The `path` parameter matters: without it noVNC looks
   for its connection at the site root.

| What | Where |
|---|---|
| Code | `/opt/shipzora` (branch `claude/magical-fermat-r1s6l0`) |
| Environment | `/etc/shipzora/service.env` (root, 0600) |
| Data: database, encrypted sessions, browser profiles | `/var/lib/shipzora` |
| Backups (daily 04:15, 7 kept) | `/var/backups/shipzora` |
| Logs | `journalctl -u shipzora -f` |
| Update to the latest code | `sudo bash /opt/shipzora/deploy/update.sh` |
| Restart | `sudo systemctl restart shipzora` |

Sizing: one Chromium process per live applicant, roughly 500 MB each. `MAX_WORKFLOWS` in the environment file caps
it (6 on an 8 GB server leaves room for the system and the login browser).
