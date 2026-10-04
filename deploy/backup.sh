#!/usr/bin/env bash
# Daily backup of everything the service owns (database, encrypted sessions, browser profiles) -> /var/backups/shipzora, 7 kept.
set -euo pipefail
DATA_DIR=${DATA_DIR:-/var/lib/shipzora}
OUT=${OUT:-/var/backups/shipzora}
mkdir -p "$OUT"
stamp=$(date +%Y%m%d-%H%M%S)
# a consistent copy of the SQLite database while the service runs (WAL mode): use SQLite's own backup API through node
sudo -u shipzora node -e "const D=require('/opt/shipzora/node_modules/better-sqlite3'); new D('$DATA_DIR/automation.db',{readonly:true}).backup('/tmp/shipzora-db-$stamp.sqlite').then(()=>process.exit(0))"
tar -czf "$OUT/shipzora-$stamp.tar.gz" -C /tmp "shipzora-db-$stamp.sqlite" -C "$DATA_DIR" --exclude='automation.db*' --exclude='debug' .
rm -f "/tmp/shipzora-db-$stamp.sqlite"
ls -1t "$OUT"/shipzora-*.tar.gz | tail -n +8 | xargs -r rm -f
echo "backup written: $OUT/shipzora-$stamp.tar.gz"
