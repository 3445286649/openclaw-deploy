#!/usr/bin/env bash
# OpenClaw Shell - Linux / macOS 交互式菜单
# 与 Windows OpenClaw_Shell.ps1 功能对应

set -euo pipefail

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
NC='\033[0m'

# 配置路径
OPENCLAW_CONFIG="${OPENCLAW_STATE_DIR:-${OPENCLAW_CONFIG:-${OPENCLAW_CONFIG_DIR:-$HOME/.openclaw}}}"
OPENCLAW_CONFIG="${OPENCLAW_CONFIG%/}"

# 固定硅基流动模型（引流用，与 Windows 一致）
FIXED_MODELS=(
  "deepseek-ai/DeepSeek-V3:DeepSeek V3（推荐）"
  "Qwen/Qwen2.5-72B-Instruct:Qwen2.5 72B"
  "GLM-4-9B-Chat:GLM-4-9B / GLM-5"
  "moonshot/kimi-k2-turbo-preview:Kimi k2-turbo"
  "deepseek-ai/DeepSeek-R1:DeepSeek R1（备选）"
)
DEFAULT_BASE_URL="https://api.siliconflow.cn/v1"

# 交互式读取（curl 管道运行时 stdin 是管道，需从 /dev/tty 读）
read_input() {
  if [[ -e /dev/tty ]]; then
    read -r "$@" < /dev/tty
  else
    read -r "$@"
  fi
}

# 查找 openclaw 命令（安装后需刷新 PATH）
find_openclaw() {
  # 加入常见 npm 全局路径
  local npm_prefix
  npm_prefix=$(npm config get prefix 2>/dev/null || true)
  npm_prefix="${npm_prefix%/}"
  [[ -n "$npm_prefix" ]] && export PATH="$npm_prefix/bin:$PATH"
  export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
  hash -r 2>/dev/null || true

  if command -v openclaw &>/dev/null; then
    echo "openclaw"
    return
  fi
  [[ -x "$HOME/.local/bin/openclaw" ]] && { echo "$HOME/.local/bin/openclaw"; return; }
  [[ -n "$npm_prefix" && -x "$npm_prefix/bin/openclaw" ]] && { echo "$npm_prefix/bin/openclaw"; return; }
  # npm root -g 的 ../bin
  local npm_root
  npm_root=$(npm root -g 2>/dev/null || true)
  if [[ -n "$npm_root" && -x "$npm_root/../bin/openclaw" ]]; then
    echo "$npm_root/../bin/openclaw"
    return
  fi
  [[ -x "/usr/local/bin/openclaw" ]] && { echo "/usr/local/bin/openclaw"; return; }
  [[ -x "/opt/homebrew/bin/openclaw" ]] && { echo "/opt/homebrew/bin/openclaw"; return; }
  # 最后尝试 npx（可运行刚安装的包）
  if command -v npx &>/dev/null; then
    echo "npx openclaw"
    return
  fi
  echo ""
}

# 运行 openclaw（带 OPENCLAW_STATE_DIR）
run_openclaw() {
  export OPENCLAW_STATE_DIR="$OPENCLAW_CONFIG"
  $OPENCLAW_CMD "$@"
}

# 检测 Gateway 是否运行
gateway_running() {
  curl -s -o /dev/null -w "%{http_code}" --connect-timeout 1 "http://127.0.0.1:18789/" 2>/dev/null | grep -q "200"
}

# 启动 Gateway（后台）
start_gateway() {
  export OPENCLAW_STATE_DIR="$OPENCLAW_CONFIG"
  mkdir -p "$OPENCLAW_CONFIG"
  nohup env OPENCLAW_STATE_DIR="$OPENCLAW_CONFIG" $OPENCLAW_CMD gateway --port 18789 >> "$OPENCLAW_CONFIG/gateway.log" 2>&1 &
  echo $! > "$OPENCLAW_CONFIG/gateway.pid" 2>/dev/null || true
}

# 停止 Gateway
stop_gateway() {
  run_openclaw gateway stop 2>/dev/null || true
  local pid_file="$OPENCLAW_CONFIG/gateway.pid"
  if [[ -f "$pid_file" ]]; then
    local pid
    pid=$(cat "$pid_file")
    kill "$pid" 2>/dev/null || true
    rm -f "$pid_file"
  fi
}

# 打开浏览器
open_browser() {
  local url="http://127.0.0.1:18789/"
  if command -v xdg-open &>/dev/null; then
    xdg-open "$url" 2>/dev/null &
  elif command -v open &>/dev/null; then
    open "$url" 2>/dev/null &
  else
    echo -e "${YELLOW}请手动打开: $url${NC}"
  fi
}

# 环境检测与安装
ensure_openclaw() {
  echo ""
  echo -e "${YELLOW}[第一页] 环境检测${NC}"
  echo "----------------------------------------"
  if ! command -v node &>/dev/null; then
    echo -e "${RED}[失败] 未检测到 Node.js${NC}"
    echo "请安装: https://nodejs.org/"
    return 1
  fi
  echo -e "${GREEN}[OK] Node.js $(node -v)${NC}"
  if ! command -v npm &>/dev/null; then
    echo -e "${RED}[失败] 未检测到 npm${NC}"
    return 1
  fi
  echo -e "${GREEN}[OK] npm $(npm -v)${NC}"
  if ! command -v git &>/dev/null; then
    echo -e "${YELLOW}[警告] 未检测到 Git，部分功能可能受影响${NC}"
  else
    echo -e "${GREEN}[OK] Git $(git --version | head -1)${NC}"
  fi
  echo ""

  echo -e "${YELLOW}[第二页] OpenClaw 安装检测${NC}"
  echo "----------------------------------------"
  OPENCLAW_CMD=$(find_openclaw)
  if [[ -z "$OPENCLAW_CMD" ]]; then
    echo -e "${YELLOW}未检测到 OpenClaw，正在安装...${NC}"
    if npm install -g openclaw 2>/dev/null; then
      # 安装后刷新 PATH 再查找
      OPENCLAW_CMD=$(find_openclaw)
    fi
    if [[ -z "$OPENCLAW_CMD" ]]; then
      # 尝试无 sudo 安装到用户目录
      echo -e "${YELLOW}全局安装未找到，尝试用户目录安装...${NC}"
      npm config set prefix "$HOME/.local" 2>/dev/null || true
      if npm install -g openclaw 2>/dev/null; then
        export PATH="$HOME/.local/bin:$PATH"
        OPENCLAW_CMD=$(find_openclaw)
      fi
    fi
  fi
  if [[ -z "$OPENCLAW_CMD" ]]; then
    echo -e "${RED}[失败] 安装失败，请检查 npm 权限或网络${NC}"
    return 1
  fi
  echo -e "${GREEN}[完成] OpenClaw 已安装${NC}"
  local ver
  ver=$($OPENCLAW_CMD --version 2>/dev/null) && echo -e "${GRAY}[版本] $ver${NC}"
  echo ""
  return 0
}

# 显示主菜单
show_header() {
  clear
  echo ""
  echo -e "${CYAN}==========================================${NC}"
  echo -e "${CYAN}  OpenClaw (Linux/macOS)${NC}"
  echo -e "${CYAN}==========================================${NC}"
  echo -e "${GRAY}  配置路径: $OPENCLAW_CONFIG${NC}"
  if gateway_running; then
    echo -e "${GREEN}  Gateway: 运行中${NC}"
  else
    echo -e "${GRAY}  Gateway: 已停止${NC}"
  fi
  echo ""
  echo -e "  [1]  快速配置 - 硅基流动 API + 模型"
  echo -e "  [2]  启动 Gateway"
  echo -e "  [3]  停止 Gateway"
  echo -e "  [4]  打开对话界面"
  echo -e "  [5]  常用命令 - status / doctor 等"
  echo -e "  [6]  检查更新"
  echo -e "  [7]  配置路径 - 设置 OPENCLAW_STATE_DIR"
  echo -e "  [0]  退出"
  echo -e "${CYAN}==========================================${NC}"
  echo ""
}

# 快速配置（硅基流动）
quick_config() {
  echo ""
  echo -e "${YELLOW}--- 快速配置（硅基流动）---${NC}"
  echo "填写配置目录完整路径（默认 $HOME/.openclaw）"
  read_input -p "配置路径 [回车默认]: " custom_path
  if [[ -n "$custom_path" ]]; then
    OPENCLAW_CONFIG="${custom_path%/}"
    export OPENCLAW_STATE_DIR="$OPENCLAW_CONFIG"
  fi
  mkdir -p "$OPENCLAW_CONFIG"

  echo ""
  echo "选择模型:"
  local i=1
  for item in "${FIXED_MODELS[@]}"; do
    local id="${item%%:*}"
    local label="${item#*:}"
    echo -e "  [$i] $label ($id)"
    ((i++)) || true
  done
  read_input -p "请选择 (1-${#FIXED_MODELS[@]}，默认1): " sel
  sel="${sel:-1}"
  local model_id
  if [[ "$sel" =~ ^[0-9]+$ ]] && (( sel >= 1 && sel <= ${#FIXED_MODELS[@]} )); then
    model_id="${FIXED_MODELS[$((sel-1))]%%:*}"
  else
    model_id="${FIXED_MODELS[0]%%:*}"
  fi
  echo -e "${CYAN}想用更多高端模型？加群 1085253453 解锁！${NC}"
  echo ""

  read_input -p "API Key (硅基流动): " api_key
  if [[ -z "$api_key" ]]; then
    echo -e "${YELLOW}[取消] 未输入 API Key${NC}"
    return
  fi

  echo ""
  echo -e "${CYAN}正在执行配置 (模型: $model_id)...${NC}"
  export OPENCLAW_STATE_DIR="$OPENCLAW_CONFIG"
  $OPENCLAW_CMD onboard --non-interactive \
    --mode local \
    --auth-choice custom-api-key \
    --custom-base-url "$DEFAULT_BASE_URL" \
    --custom-model-id "$model_id" \
    --custom-api-key "$api_key" \
    --custom-compatibility openai \
    --secret-input-mode plaintext \
    --gateway-port 18789 \
    --gateway-bind loopback \
    --skip-skills --skip-channels --skip-daemon \
    --accept-risk 2>/dev/null || true

  echo -e "${GREEN}[OK] 配置完成${NC}"
}

# 主流程
main() {
  # 快捷参数（需先解析 openclaw 路径）
  OPENCLAW_CMD=$(find_openclaw)
  case "${1:-}" in
    gateway-start) ensure_openclaw && start_gateway && sleep 3 && open_browser; exit 0 ;;
    gateway-stop) stop_gateway; exit 0 ;;
    open-chat) start_gateway; sleep 4; open_browser; exit 0 ;;
    status) [[ -n "$OPENCLAW_CMD" ]] && run_openclaw status; exit 0 ;;
    doctor) [[ -n "$OPENCLAW_CMD" ]] && run_openclaw doctor; exit 0 ;;
  esac

  if ! ensure_openclaw; then
    read_input -p "按回车退出"
    exit 1
  fi

  while true; do
    show_header
    read_input -p "请选择: " choice
    choice="${choice:-}"

    case "$choice" in
      1) quick_config ;;
      2)
        echo ""
        echo -e "${CYAN}正在启动 Gateway...${NC}"
        start_gateway
        sleep 3
        if gateway_running; then
          echo -e "${GREEN}[OK] Gateway 已启动${NC}"
          open_browser
        else
          echo -e "${YELLOW}启动中，请稍后访问 http://127.0.0.1:18789/${NC}"
        fi
        ;;
      3)
        stop_gateway
        echo -e "${GREEN}[OK] Gateway 已停止${NC}"
        ;;
      4)
        if gateway_running; then
          open_browser
        else
          echo -e "${YELLOW}Gateway 未运行，正在启动...${NC}"
          start_gateway
          sleep 4
          open_browser
        fi
        ;;
      5)
        echo ""
        echo -e "${YELLOW}--- 常用命令 ---${NC}"
        echo "  [1] status   [2] gateway status   [3] doctor"
        read_input -p "选择: " sub
        case "$sub" in
          1) run_openclaw status ;;
          2) run_openclaw gateway status ;;
          3) run_openclaw doctor ;;
          *) echo "无效" ;;
        esac
        ;;
      6)
        echo ""
        echo -e "${CYAN}正在更新 OpenClaw...${NC}"
        npm install -g openclaw@latest
        echo -e "${GREEN}[OK] 完成${NC}"
        OPENCLAW_CMD=$(find_openclaw)
        ;;
      7)
        echo ""
        echo -e "${YELLOW}当前配置路径: $OPENCLAW_CONFIG${NC}"
        echo "设置自定义路径（export OPENCLAW_STATE_DIR=路径）"
        read_input -p "新路径 (留空取消): " new_path
        if [[ -n "$new_path" ]]; then
          OPENCLAW_CONFIG="${new_path%/}"
          echo "当前会话已切换，持久化请加入 ~/.bashrc 或 ~/.zshrc:"
          echo "  export OPENCLAW_STATE_DIR=\"$OPENCLAW_CONFIG\""
        fi
        ;;
      0) echo -e "${GREEN}已退出${NC}"; exit 0 ;;
      *) echo -e "${YELLOW}无效输入${NC}" ;;
    esac
    echo ""
    read_input -p "按回车继续"
  done
}

# 检测 Windows 时提示
OS=$(uname -s)
case "$OS" in
  MINGW*|MSYS*|CYGWIN*) echo -e "${YELLOW}Windows 请使用 OpenClaw_Shell_Install.cmd${NC}"; exit 1 ;;
esac

main "$@"
