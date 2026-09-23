#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
MANAGER_SCRIPT="${SCRIPT_DIR}/server-manager.sh"
SERVICE_NAME="realname-simple-server"

if [[ ! -f "${MANAGER_SCRIPT}" ]]; then
  echo "安装包不完整：缺少 server-manager.sh"
  exit 1
fi

if [[ "${EUID}" -ne 0 ]]; then
  if ! command -v sudo >/dev/null 2>&1; then
    echo "请使用 root 账号运行：bash install.sh"
    exit 1
  fi
  exec sudo bash "$0" "$@"
fi

if [[ -f "/etc/systemd/system/${SERVICE_NAME}.service" ]]; then
  echo "检测到已安装的实名上机后端，将进入升级引导。"
  exec bash "${MANAGER_SCRIPT}" upgrade --source "${SCRIPT_DIR}"
fi

exec bash "${MANAGER_SCRIPT}" install --source "${SCRIPT_DIR}" "$@"
