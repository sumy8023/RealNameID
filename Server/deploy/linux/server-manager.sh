#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE_NAME="realname-simple-server"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
PATH_FILE="/etc/${SERVICE_NAME}.install-path"
MANAGER_COMMAND="/usr/local/sbin/realname-server"
SERVICE_USER="realname-server"
SERVICE_GROUP="realname-server"
DEFAULT_INSTALL_DIR="/opt/realname-simple-server"
BACKUP_ROOT="/var/backups/${SERVICE_NAME}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
UPGRADE_BACKUP_DIR=""
UPGRADE_INSTALL_DIR=""
UPGRADE_WAS_ACTIVE="no"

ACTION="${1:-menu}"
SOURCE_DIR=""
REQUESTED_INSTALL_DIR=""

shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)
      SOURCE_DIR="${2:-}"
      shift 2
      ;;
    --path)
      REQUESTED_INSTALL_DIR="${2:-}"
      shift 2
      ;;
    *)
      if [[ -z "${REQUESTED_INSTALL_DIR}" && "${ACTION}" == "install" ]]; then
        REQUESTED_INSTALL_DIR="$1"
      fi
      shift
      ;;
  esac
done

print_title() {
  echo
  echo "========================================"
  echo " 实名上机后端 Linux 管理面板"
  echo "========================================"
}

require_root() {
  if [[ "${EUID}" -eq 0 ]]; then
    return
  fi
  if ! command -v sudo >/dev/null 2>&1; then
    echo "此操作需要 root 权限。"
    exit 1
  fi
  local args=("$0" "${ACTION}")
  if [[ -n "${SOURCE_DIR}" ]]; then
    args+=(--source "${SOURCE_DIR}")
  fi
  if [[ -n "${REQUESTED_INSTALL_DIR}" ]]; then
    args+=(--path "${REQUESTED_INSTALL_DIR}")
  fi
  exec sudo bash "${args[@]}"
}

ensure_systemd() {
  if ! command -v systemctl >/dev/null 2>&1 || [[ ! -d /run/systemd/system ]]; then
    echo "当前系统未使用 systemd，无法安装为系统服务。"
    exit 1
  fi
}

ask_yes_no() {
  local prompt="$1"
  local default_answer="${2:-y}"
  local answer
  if [[ "${default_answer}" == "y" ]]; then
    read -r -p "${prompt} [Y/n]: " answer || true
    answer="${answer:-y}"
  else
    read -r -p "${prompt} [y/N]: " answer || true
    answer="${answer:-n}"
  fi
  [[ "${answer}" =~ ^[Yy]$ ]]
}

read_install_dir() {
  if [[ -f "${PATH_FILE}" ]]; then
    head -n 1 "${PATH_FILE}"
  else
    echo "${DEFAULT_INSTALL_DIR}"
  fi
}

validate_install_dir() {
  local install_dir="$1"
  if [[ "${install_dir}" != /* || "${install_dir}" == "/" ]]; then
    echo "安装路径必须是绝对路径，且不能是根目录。"
    return 1
  fi
  if [[ ! "${install_dir}" =~ ^/[A-Za-z0-9._/-]+$ || "${install_dir}" == *".."* ]]; then
    echo "安装路径只能包含字母、数字、点、下划线、短横线和斜杠，且不能包含空格或 ..。"
    return 1
  fi
  case "${install_dir}" in
    /bin|/boot|/dev|/etc|/home|/lib|/lib64|/proc|/root|/run|/sbin|/sys|/tmp|/usr|/var)
      echo "不能直接安装到系统目录：${install_dir}"
      return 1
      ;;
  esac
  return 0
}

resolve_source_dir() {
  local candidate="${SOURCE_DIR:-${SCRIPT_DIR}}"
  if [[ ! -f "${candidate}/server.js" ]]; then
    read -r -p "请输入新版本 Linux 安装包所在目录: " candidate
  fi
  candidate="$(cd -- "${candidate}" 2>/dev/null && pwd)" || {
    echo "安装包目录不存在。"
    return 1
  }
  for required_file in server.js package.json; do
    if [[ ! -f "${candidate}/${required_file}" ]]; then
      echo "安装包不完整：缺少 ${required_file}"
      return 1
    fi
  done
  SOURCE_DIR="${candidate}"
}

node_major_version() {
  node --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'
}

install_node_from_system() {
  echo "正在通过系统软件源安装 Node.js..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs npm
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y nodejs npm
  elif command -v yum >/dev/null 2>&1; then
    yum install -y nodejs npm
  elif command -v zypper >/dev/null 2>&1; then
    zypper --non-interactive install nodejs npm
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm nodejs npm
  else
    echo "未识别系统软件管理器，请先手动安装 Node.js 18 或更高版本。"
    return 1
  fi
}

ensure_node() {
  local major=0
  if command -v node >/dev/null 2>&1; then
    major="$(node_major_version)"
  fi
  if [[ "${major:-0}" -ge 18 ]]; then
    echo "Node.js 检查通过：$(node --version)"
    return
  fi
  echo "运行后端需要 Node.js 18 或更高版本。"
  if ! ask_yes_no "是否现在自动安装 Node.js" "y"; then
    echo "已取消。请安装 Node.js 18 或更高版本后重新运行。"
    exit 1
  fi
  install_node_from_system
  major="$(node_major_version)"
  if [[ "${major:-0}" -lt 18 ]]; then
    echo "当前软件源安装的 Node.js 版本过低，请手动升级到 18 或更高版本。"
    exit 1
  fi
}

ensure_service_account() {
  if ! getent group "${SERVICE_GROUP}" >/dev/null 2>&1; then
    groupadd --system "${SERVICE_GROUP}"
  fi
  if ! id "${SERVICE_USER}" >/dev/null 2>&1; then
    local nologin_shell="/usr/sbin/nologin"
    [[ -x "${nologin_shell}" ]] || nologin_shell="/sbin/nologin"
    useradd --system --gid "${SERVICE_GROUP}" --home-dir "$(read_install_dir)" --no-create-home --shell "${nologin_shell}" "${SERVICE_USER}"
  fi
}

rollback_upgrade() {
  local exit_code=$?
  trap - ERR
  if [[ -n "${UPGRADE_BACKUP_DIR}" && -n "${UPGRADE_INSTALL_DIR}" ]]; then
    echo "升级失败，正在恢复旧版本..."
    cp -a "${UPGRADE_BACKUP_DIR}/server.js" "${UPGRADE_INSTALL_DIR}/server.js" || true
    cp -a "${UPGRADE_BACKUP_DIR}/package.json" "${UPGRADE_INSTALL_DIR}/package.json" || true
    if [[ "${UPGRADE_WAS_ACTIVE}" == "yes" ]]; then
      systemctl start "${SERVICE_NAME}.service" || true
    fi
    echo "旧版本已恢复。备份目录：${UPGRADE_BACKUP_DIR}"
  fi
  exit "${exit_code}"
}

install_payload() {
  local source_dir="$1"
  local install_dir="$2"
  install -d -o root -g "${SERVICE_GROUP}" -m 0750 "${install_dir}"
  install -m 0640 -o root -g "${SERVICE_GROUP}" "${source_dir}/server.js" "${install_dir}/server.js"
  install -m 0640 -o root -g "${SERVICE_GROUP}" "${source_dir}/package.json" "${install_dir}/package.json"
  install -d -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" -m 0750 "${install_dir}/runtime"
}

install_manager_command() {
  local manager_source="${SOURCE_DIR}/server-manager.sh"
  if [[ ! -f "${manager_source}" ]]; then
    manager_source="${SCRIPT_DIR}/server-manager.sh"
  fi
  install -m 0755 -o root -g root "${manager_source}" "${MANAGER_COMMAND}"
}

write_service_file() {
  local install_dir="$1"
  local node_bin
  node_bin="$(command -v node)"
  cat > "${SERVICE_FILE}" <<EOF
[Unit]
Description=RealName Simple Server
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_GROUP}
WorkingDirectory=${install_dir}
ExecStart=${node_bin} ${install_dir}/server.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
UMask=0027
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF
  chmod 0644 "${SERVICE_FILE}"
  systemctl daemon-reload
}

service_is_installed() {
  [[ -f "${SERVICE_FILE}" && -f "${PATH_FILE}" ]]
}

require_installed() {
  if ! service_is_installed; then
    echo "实名上机后端服务尚未安装。"
    exit 1
  fi
}

do_install() {
  require_root
  ensure_systemd
  print_title
  if service_is_installed; then
    echo "服务已经安装。如需替换程序，请选择升级服务。"
    return
  fi
  resolve_source_dir
  ensure_node

  local install_dir="${REQUESTED_INSTALL_DIR:-${DEFAULT_INSTALL_DIR}}"
  if [[ -z "${REQUESTED_INSTALL_DIR}" ]]; then
    read -r -p "安装路径 [${DEFAULT_INSTALL_DIR}]: " install_dir || true
    install_dir="${install_dir:-${DEFAULT_INSTALL_DIR}}"
  fi
  validate_install_dir "${install_dir}"

  echo
  echo "安装路径：${install_dir}"
  echo "服务名称：${SERVICE_NAME}"
  echo "运行账号：${SERVICE_USER}"
  if ! ask_yes_no "确认安装" "y"; then
    echo "已取消安装。"
    return
  fi

  printf '%s\n' "${install_dir}" > "${PATH_FILE}"
  chmod 0644 "${PATH_FILE}"
  ensure_service_account
  node --check "${SOURCE_DIR}/server.js" >/dev/null
  install_payload "${SOURCE_DIR}" "${install_dir}"
  install_manager_command
  write_service_file "${install_dir}"

  if ask_yes_no "是否设置为开机自动启动" "y"; then
    systemctl enable "${SERVICE_NAME}.service"
  fi
  if ask_yes_no "是否现在启动服务" "y"; then
    systemctl start "${SERVICE_NAME}.service"
  fi

  echo
  echo "安装完成。以后运行 realname-server 可打开管理面板。"
  echo "服务状态："
  systemctl --no-pager --full status "${SERVICE_NAME}.service" || true
}

do_upgrade() {
  require_root
  ensure_systemd
  require_installed
  print_title
  resolve_source_dir
  ensure_node

  local install_dir
  install_dir="$(read_install_dir)"
  validate_install_dir "${install_dir}"
  node --check "${SOURCE_DIR}/server.js" >/dev/null

  echo "当前安装路径：${install_dir}"
  echo "升级包目录：${SOURCE_DIR}"
  if ! ask_yes_no "确认升级并覆盖程序文件" "y"; then
    echo "已取消升级。"
    return
  fi

  local backup_dir="${BACKUP_ROOT}/$(date +%Y%m%d-%H%M%S)"
  install -d -m 0700 "${backup_dir}"
  cp -a "${install_dir}/server.js" "${backup_dir}/server.js"
  cp -a "${install_dir}/package.json" "${backup_dir}/package.json"
  UPGRADE_BACKUP_DIR="${backup_dir}"
  UPGRADE_INSTALL_DIR="${install_dir}"
  trap rollback_upgrade ERR

  local was_active="no"
  if systemctl is-active --quiet "${SERVICE_NAME}.service"; then
    was_active="yes"
    UPGRADE_WAS_ACTIVE="yes"
    systemctl stop "${SERVICE_NAME}.service"
  fi

  install_payload "${SOURCE_DIR}" "${install_dir}"
  install_manager_command
  write_service_file "${install_dir}"

  if [[ "${was_active}" == "yes" ]]; then
    systemctl start "${SERVICE_NAME}.service"
  fi

  trap - ERR
  UPGRADE_BACKUP_DIR=""
  UPGRADE_INSTALL_DIR=""

  echo "升级完成。旧程序备份在：${backup_dir}"
  if [[ "${was_active}" == "yes" ]]; then
    systemctl --no-pager --full status "${SERVICE_NAME}.service" || true
  else
    echo "升级前服务处于停止状态，本次未自动启动。"
  fi
}

do_start() {
  require_root
  ensure_systemd
  require_installed
  systemctl start "${SERVICE_NAME}.service"
  echo "服务已启动。"
}

do_stop() {
  require_root
  ensure_systemd
  require_installed
  systemctl stop "${SERVICE_NAME}.service"
  echo "服务已停止。"
}

do_restart() {
  require_root
  ensure_systemd
  require_installed
  systemctl restart "${SERVICE_NAME}.service"
  echo "服务已重启。"
}

do_status() {
  ensure_systemd
  require_installed
  systemctl --no-pager --full status "${SERVICE_NAME}.service" || true
}

do_logs() {
  ensure_systemd
  require_installed
  journalctl -u "${SERVICE_NAME}.service" -n 100 --no-pager
}

do_enable() {
  require_root
  ensure_systemd
  require_installed
  systemctl enable "${SERVICE_NAME}.service"
  echo "已设置为开机自动启动。"
}

do_disable_and_stop() {
  require_root
  ensure_systemd
  require_installed
  systemctl disable --now "${SERVICE_NAME}.service"
  echo "服务已停止，并已关闭开机自动启动。"
}

do_uninstall() {
  require_root
  ensure_systemd
  require_installed
  print_title
  local install_dir
  install_dir="$(read_install_dir)"
  echo "将卸载 systemd 服务。外部 MySQL 数据库不会被删除。"
  if ! ask_yes_no "确认卸载服务" "n"; then
    echo "已取消卸载。"
    return
  fi

  systemctl disable --now "${SERVICE_NAME}.service" >/dev/null 2>&1 || true
  rm -f -- "${SERVICE_FILE}"
  systemctl daemon-reload
  systemctl reset-failed >/dev/null 2>&1 || true
  rm -f -- "${MANAGER_COMMAND}" "${PATH_FILE}"

  if ask_yes_no "是否同时删除安装目录 ${install_dir}" "n"; then
    validate_install_dir "${install_dir}"
    rm -rf -- "${install_dir}"
    userdel "${SERVICE_USER}" >/dev/null 2>&1 || true
    groupdel "${SERVICE_GROUP}" >/dev/null 2>&1 || true
    echo "安装目录已删除。升级备份仍保留在 ${BACKUP_ROOT}。"
  else
    echo "程序文件已保留在 ${install_dir}。"
  fi
  echo "服务已卸载，MySQL 数据库未改动。"
}

show_menu() {
  ensure_systemd
  while true; do
    print_title
    local install_dir
    install_dir="$(read_install_dir)"
    echo "当前安装路径：${install_dir}"
    if service_is_installed; then
      echo "运行状态：$(systemctl is-active "${SERVICE_NAME}.service" 2>/dev/null || true)"
      echo "开机自启：$(systemctl is-enabled "${SERVICE_NAME}.service" 2>/dev/null || true)"
    else
      echo "安装状态：未安装"
    fi
    echo
    echo "1. 安装服务"
    echo "2. 升级服务"
    echo "3. 启动服务"
    echo "4. 停止服务"
    echo "5. 重启服务"
    echo "6. 查看服务状态"
    echo "7. 查看最近日志"
    echo "8. 设置开机自动启动"
    echo "9. 关闭服务并取消开机自启"
    echo "10. 卸载服务"
    echo "0. 退出"
    echo
    read -r -p "请选择操作: " choice
    case "${choice}" in
      1) ACTION=install; do_install ;;
      2) ACTION=upgrade; SOURCE_DIR=""; do_upgrade ;;
      3) ACTION=start; do_start ;;
      4) ACTION=stop; do_stop ;;
      5) ACTION=restart; do_restart ;;
      6) do_status ;;
      7) do_logs ;;
      8) ACTION=enable; do_enable ;;
      9) ACTION=disable; do_disable_and_stop ;;
      10) ACTION=uninstall; do_uninstall ;;
      0) exit 0 ;;
      *) echo "无效选项，请重新选择。" ;;
    esac
    echo
    read -r -p "按回车键返回菜单..." _ || true
  done
}

case "${ACTION}" in
  install) do_install ;;
  upgrade) do_upgrade ;;
  start) do_start ;;
  stop) do_stop ;;
  restart) do_restart ;;
  status) do_status ;;
  logs) do_logs ;;
  enable) do_enable ;;
  disable) do_disable_and_stop ;;
  uninstall) do_uninstall ;;
  menu|"") show_menu ;;
  *)
    echo "未知操作：${ACTION}"
    echo "可用操作：install upgrade start stop restart status logs enable disable uninstall menu"
    exit 1
    ;;
esac
