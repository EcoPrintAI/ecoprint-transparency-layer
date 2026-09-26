#!/bin/sh
set -eu

ACTION=${1:-}
REPO_ROOT=${2:-$(cd "$(dirname "$0")/../.." && pwd)}
ENGINE_SOURCE="$REPO_ROOT/sigsense/engine/v3engine"
GROUP=ecoprint

fail() { echo "[ecoprint service] $*" >&2; exit 1; }
need_root() { [ "$(id -u)" -eq 0 ] || fail "Run service $ACTION with administrator privileges (for example, sudo)."; }
ensure_group() {
    if [ "$(uname -s)" = Darwin ]; then
        MACOS_USER=${SUDO_USER:-$(stat -f '%Su' /dev/console)}
        [ -n "$MACOS_USER" ] && [ "$MACOS_USER" != root ] || fail "Could not determine the logged-in CLI user for IPC group access."
        MACOS_GROUP_ADDED=0
        if ! dseditgroup -o checkmember -m "$MACOS_USER" "$GROUP" >/dev/null 2>&1; then
            dseditgroup -o create "$GROUP" >/dev/null 2>&1 || true
            dseditgroup -o edit -a "$MACOS_USER" -t user "$GROUP"
            MACOS_GROUP_ADDED=1
        fi
    else
        getent group "$GROUP" >/dev/null 2>&1 || groupadd --system "$GROUP"
        if [ -n "${SUDO_USER:-}" ]; then usermod -a -G "$GROUP" "$SUDO_USER"; fi
    fi
}

case "$(uname -s)" in
  Darwin)
    APP_DIR="/Library/Application Support/EcoPrint"
    DB="$APP_DIR/Data/ecoprint_telemetry.db"
    CONFIG="$APP_DIR/Config/ecoprint.conf"
    SOCKET=/var/run/ecoprint.sock
    SERVICE_FILE=/Library/LaunchDaemons/com.ecoprint.sigsense.plist
    LABEL=com.ecoprint.sigsense
    ;;
  Linux)
    APP_DIR=/usr/local/libexec/ecoprint
    DB=/var/lib/ecoprint/ecoprint_telemetry.db
    CONFIG=/etc/ecoprint/ecoprint.conf
    SOCKET=/run/ecoprint/ecoprint.sock
    SERVICE_FILE=/etc/systemd/system/ecoprint-sigsense.service
    LABEL=ecoprint-sigsense.service
    ;;
  *) fail "Unsupported Unix platform: $(uname -s)" ;;
esac

case "$ACTION" in
  install)
    need_root
    [ -x "$ENGINE_SOURCE" ] || fail "Build the engine first: make -C sigsense/engine"
    ensure_group
    if [ "$(uname -s)" = Darwin ]; then
      # Make upgrades repeatable and let us tighten the existing DB permissions safely.
      launchctl bootout system "$SERVICE_FILE" >/dev/null 2>&1 || true
    fi
    if [ "$(uname -s)" = Darwin ]; then
      install -d -o root -g wheel -m 0755 "$APP_DIR"
      install -d -o root -g wheel -m 0700 "$(dirname "$CONFIG")"
    else
      install -d -o root -g "$GROUP" -m 0750 "$APP_DIR" "$(dirname "$CONFIG")"
    fi
    install -d -o root -g "$GROUP" -m 0750 "$(dirname "$DB")"
    if [ "$(uname -s)" = Darwin ]; then
      for data_file in "$DB" "$DB-wal" "$DB-shm"; do
        if [ -e "$data_file" ]; then
          chown root:"$GROUP" "$data_file"
          chmod 0640 "$data_file"
        fi
      done
    fi
    if [ "$(uname -s)" = Darwin ]; then
      install -o root -g wheel -m 0755 "$ENGINE_SOURCE" "$APP_DIR/v3engine"
    else
      install -o root -g "$GROUP" -m 0750 "$ENGINE_SOURCE" "$APP_DIR/v3engine"
    fi
    if [ -e "$CONFIG" ]; then
      if [ "$(uname -s)" = Darwin ]; then
        chown root:wheel "$CONFIG"
        chmod 0600 "$CONFIG"
      else
        chown root:"$GROUP" "$CONFIG"
        chmod 0640 "$CONFIG"
      fi
    else
      # Preserve the repository's configured provider and API key on first install.
      if [ "$(uname -s)" = Darwin ]; then
        install -o root -g wheel -m 0600 "$REPO_ROOT/sigsense/engine/ecoprint.conf" "$CONFIG"
      else
        install -o root -g "$GROUP" -m 0640 "$REPO_ROOT/sigsense/engine/ecoprint.conf" "$CONFIG"
      fi
    fi
    if [ "$(uname -s)" = Darwin ]; then
      cat > "$SERVICE_FILE" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$APP_DIR/v3engine</string><string>--db</string><string>$DB</string><string>--config</string><string>$CONFIG</string><string>--socket</string><string>$SOCKET</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>Umask</key><integer>23</integer>
  <key>EnvironmentVariables</key><dict><key>ECOPRINT_IPC_GROUP</key><string>$GROUP</string></dict>
  <key>StandardOutPath</key><string>/var/log/ecoprint-sigsense.log</string>
  <key>StandardErrorPath</key><string>/var/log/ecoprint-sigsense.err</string>
</dict></plist>
EOF
      chown root:wheel "$SERVICE_FILE"
      chmod 0644 "$SERVICE_FILE"
      launchctl bootstrap system "$SERVICE_FILE"
      [ "$MACOS_GROUP_ADDED" -eq 0 ] || echo "User $MACOS_USER may need to sign out and back in for the ecoprint group to take effect."
    else
      cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=EcoPrint SigSense local telemetry service
After=local-fs.target

[Service]
Type=simple
User=root
Group=$GROUP
CapabilityBoundingSet=CAP_DAC_READ_SEARCH
NoNewPrivileges=true
RuntimeDirectory=ecoprint
RuntimeDirectoryMode=0750
Environment=ECOPRINT_IPC_GROUP=$GROUP
ExecStart=$APP_DIR/v3engine --db $DB --config $CONFIG --socket $SOCKET
Restart=on-failure
RestartSec=2
UMask=0007

[Install]
WantedBy=multi-user.target
EOF
      chmod 0644 "$SERVICE_FILE"
      systemctl daemon-reload
      systemctl enable --now "$LABEL"
      [ -z "${SUDO_USER:-}" ] || echo "User $SUDO_USER may need to sign out and back in for the ecoprint group to take effect."
    fi
    echo "Installed. CLI reads $DB; use ECOPRINT_TELEMETRY_DB to override it."
    ;;
  uninstall)
    need_root
    if [ "$(uname -s)" = Darwin ]; then
      launchctl disable "system/$LABEL" >/dev/null 2>&1 || true
      launchctl bootout system "$SERVICE_FILE" >/dev/null 2>&1 || true
      rm -f "$SERVICE_FILE" "$APP_DIR/v3engine"
    else
      systemctl disable --now "$LABEL" >/dev/null 2>&1 || true
      rm -f "$SERVICE_FILE" "$APP_DIR/v3engine"
      systemctl daemon-reload
    fi
    echo "Service removed; telemetry database, configuration, and group were retained."
    ;;
  start)
    if [ "$(uname -s)" = Darwin ]; then launchctl enable "system/$LABEL"; launchctl bootstrap system "$SERVICE_FILE" 2>/dev/null || true; launchctl kickstart -k "system/$LABEL"; else systemctl start "$LABEL"; fi
    ;;
  stop)
    if [ "$(uname -s)" = Darwin ]; then launchctl disable "system/$LABEL"; launchctl bootout system "$SERVICE_FILE"; else systemctl stop "$LABEL"; fi
    ;;
  status)
    if [ "$(uname -s)" = Darwin ]; then launchctl print "system/$LABEL"; else systemctl status --no-pager "$LABEL"; fi
    ;;
  *) fail "Usage: ecoprint service {install|uninstall|start|stop|status}" ;;
esac
