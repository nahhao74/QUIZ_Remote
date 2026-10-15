#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this command with sudo: sudo ./scripts/install-localhost-proxy.sh" >&2
  exit 1
fi

project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

if systemctl is-active --quiet apache2; then
  # Apache already owns port 80. Reuse it instead of competing for the port.
  systemctl disable --now classpulse-http.socket >/dev/null 2>&1 || true
  install -m 0644 "${project_dir}/infra/apache/classpulse.conf" /etc/apache2/sites-available/classpulse.conf
  a2enmod proxy proxy_http proxy_wstunnel >/dev/null
  a2ensite classpulse >/dev/null
  apache2ctl configtest
  systemctl reload apache2
  echo "ClassPulse is ready at http://localhost through Apache"
  exit 0
fi

install -m 0644 \
  "${project_dir}/infra/systemd/classpulse-http.socket" \
  "${project_dir}/infra/systemd/classpulse-http.service" \
  /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now classpulse-http.socket
systemctl --no-pager --lines=0 status classpulse-http.socket

echo "ClassPulse is ready at http://localhost"
