#!/usr/bin/env bash
# OpenClaw Shell - Linux / macOS 交互式菜单
# 与 Windows OpenClaw_Shell.ps1 功能对应

set -euo pipefail

# WSL 检测：若无原生 node，尝试使用 Windows Node（避免 Ubuntu 未装 Node 时直接失败）
setup_wsl_node_if_needed() {
  if command -v node &>/dev/null; then
    return 0
  fi
  [[ -z "${WSL_DISTRO_NAME:-}" ]] && [[ ! "$(uname -r 2>/dev/null)" =~ [Mm]icrosoft ]] && return 0
  local node_exe=""
  for dir in /mnt/d/Nodejs "/mnt/c/Program Files/nodejs"; do
    [[ -x "$dir/node.exe" ]] && node_exe="$dir/node.exe" && break
  done
  if [[ -n "$node_exe" ]]; then
    mkdir -p ~/.local/bin
    ln -sf "$node_exe" ~/.local/bin/node 2>/dev/null || true
    export PATH="$HOME/.local/bin:$PATH"
    if command -v node &>/dev/null; then
      return 0
    fi
  fi
  return 1
}
setup_wsl_node_if_needed || true

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
  "moonshotai/Kimi-K2-Instruct-0905:Kimi K2（可对话）"
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
  export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
  # WSL 下 npm config 可能返回 Windows 路径，优先用 Linux 原生路径
  local npm_prefix npm_root
  npm_prefix=$(npm config get prefix 2>/dev/null || true)
  npm_prefix="${npm_prefix%/}"
  if [[ -n "$npm_prefix" ]]; then
    # 将 C:\path 转为 /mnt/c/path 供 WSL 使用
    if [[ "$npm_prefix" =~ ^[A-Za-z]: ]]; then
      local drive="${npm_prefix:0:1}"; drive="${drive,,}"
      npm_prefix="/mnt/$drive${npm_prefix:2}"
    fi
    [[ -d "$npm_prefix/bin" ]] && export PATH="$npm_prefix/bin:$PATH"
  fi
  hash -r 2>/dev/null || true

  # 优先 Linux 原生路径
  [[ -x "$HOME/.local/bin/openclaw" ]] && { echo "$HOME/.local/bin/openclaw"; return; }
  [[ -x "/usr/local/bin/openclaw" ]] && { echo "/usr/local/bin/openclaw"; return; }
  [[ -x "/opt/homebrew/bin/openclaw" ]] && { echo "/opt/homebrew/bin/openclaw"; return; }
  npm_root=$(npm root -g 2>/dev/null || true)
  if [[ -n "$npm_root" && -x "$npm_root/../bin/openclaw" ]]; then
    echo "$npm_root/../bin/openclaw"
    return
  fi
  if command -v openclaw &>/dev/null; then
    local oc_path
    oc_path=$(command -v openclaw)
    # WSL：若 openclaw 来自 /mnt/*（Windows 路径），其内部路径解析可能出错，改用 npx
    if [[ "$(uname -r 2>/dev/null)" =~ [Mm]icrosoft ]] && [[ "$oc_path" == /mnt/* ]]; then
      if command -v npx &>/dev/null; then
        echo "npx openclaw"
        return
      fi
    fi
    echo "openclaw"
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

# 从 openclaw.json 读取 gateway token（避免 unauthorized / too many failed attempts）
get_gateway_token() {
  local cfg="$OPENCLAW_CONFIG/openclaw.json"
  [[ ! -f "$cfg" ]] && return
  if command -v jq &>/dev/null; then
    jq -r '.gateway.auth.token // empty' "$cfg" 2>/dev/null
  else
    sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$cfg" 2>/dev/null | head -1
  fi
}

# 打开浏览器（自动附带 token，避免认证失败）
open_browser() {
  local url="http://127.0.0.1:18789/"
  local token
  token=$(get_gateway_token)
  if [[ -n "$token" ]]; then
    url="${url}?token=$token"
    echo -e "${GRAY}  使用 token 打开，避免认证失败${NC}"
  fi
  if command -v xdg-open &>/dev/null; then
    xdg-open "$url" 2>/dev/null &
  elif command -v open &>/dev/null; then
    open "$url" 2>/dev/null &
  else
    echo -e "${YELLOW}请手动打开: $url${NC}"
  fi
}

# 插件 manifest 补齐：clawdbot.plugin.json -> openclaw.plugin.json（避免 plugin manifest not found）
# 返回补齐的数量（0=无变更）
ensure_manifest_compat() {
  local ext_root="$OPENCLAW_CONFIG/extensions"
  [[ ! -d "$ext_root" ]] && echo "0" && return 0
  local count=0 dir old_manifest new_manifest
  for dir in "$ext_root"/*/; do
    [[ -d "$dir" ]] || continue
    old_manifest="${dir}clawdbot.plugin.json"
    new_manifest="${dir}openclaw.plugin.json"
    if [[ -f "$old_manifest" && ! -f "$new_manifest" ]]; then
      cp -f "$old_manifest" "$new_manifest" 2>/dev/null && ((count++)) || true
    fi
  done
  echo "$count"
}

# 一键最小修复：manifest补齐 -> doctor --fix -> plugins -> skills check -> gateway自检
minimal_repair() {
  export OPENCLAW_STATE_DIR="$OPENCLAW_CONFIG"
  echo ""
  echo -e "${CYAN}[1/5] manifest 补齐...${NC}"
  local fixed_count
  fixed_count=$(ensure_manifest_compat)
  if [[ "${fixed_count:-0}" -gt 0 ]]; then
    echo -e "${GREEN}[OK] 已补齐 $fixed_count 个插件 manifest${NC}"
  else
    echo -e "${GRAY}[OK] 无需补齐${NC}"
  fi

  echo -e "${CYAN}[2/5] doctor --fix...${NC}"
  run_openclaw doctor --fix 2>/dev/null || true

  echo -e "${CYAN}[3/5] plugins 校验...${NC}"
  run_openclaw plugins list 2>/dev/null || true

  echo -e "${CYAN}[4/5] skills check...${NC}"
  run_openclaw skills check 2>/dev/null || true

  echo -e "${CYAN}[5/5] gateway 自检...${NC}"
  if gateway_running; then
    echo -e "${GREEN}[OK] Gateway: 运行中${NC}"
  else
    echo -e "${GRAY}[OK] Gateway: 已停止${NC}"
  fi

  echo ""
  echo -e "${GREEN}[完成] 最小修复已执行${NC}"
}

# 生成可复制工单摘要（失败时供用户发给维护者）
write_ticket_summary() {
  local action="$1"
  local err_msg="$2"
  local first_line
  first_line=$(echo "$err_msg" | head -1)
  [[ -z "$first_line" ]] && first_line="$err_msg"
  echo ""
  echo -e "${YELLOW}--- 可复制工单摘要（发给维护者）---${NC}"
  echo "时间: $(date '+%Y-%m-%d %H:%M:%S')"
  echo "操作: $action"
  echo "错误摘要: $first_line"
  echo "建议: 点击「一键最小修复」后重试；若仍失败请附上完整日志与截图。"
  echo -e "${YELLOW}----------------------------------------${NC}"
}

# 渠道状态（用 jq 或 grep 解析，避免 set -e 导致退出）
show_channel_status() {
  echo ""
  echo -e "${YELLOW}--- 渠道状态 ---${NC}"
  echo -e "${GRAY}  配置: $OPENCLAW_CONFIG${NC}"
  echo ""
  local cfg="$OPENCLAW_CONFIG/openclaw.json"
  local ch_cfg="$OPENCLAW_CONFIG/channels.json"
  local check_file=""
  [[ -f "$cfg" ]] && check_file="$cfg"
  [[ -f "$ch_cfg" ]] && check_file="${check_file:+$check_file }$ch_cfg"
  if [[ -n "$check_file" ]]; then
    for name in "Telegram:telegram" "Discord:discord" "飞书:feishu" "钉钉:dingtalk" "QQ:qq"; do
      local label="${name%%:*}" id="${name#*:}"
      local ok=""
      if command -v jq &>/dev/null; then
        ok=$(jq -r --arg c "$id" '.channels[$c] // .[$c] // empty' $check_file 2>/dev/null | head -1) || true
      fi
      [[ -z "$ok" ]] && ok=$(grep -l "\"$id\"" $check_file 2>/dev/null | head -1) || true
      if [[ -n "$ok" ]]; then
        echo -e "  ${GREEN}$label: 已配置${NC}"
      else
        echo -e "  ${GRAY}$label: 未配置${NC}"
      fi
    done
  else
    echo -e "${GRAY}  未找到配置文件${NC}"
  fi
  if [[ -n "${OPENCLAW_CMD:-}" ]]; then
    echo ""
    echo -e "${GRAY}  CLI 渠道状态（若失败不影响脚本继续）:${NC}"
    if ! run_openclaw channels status 2>/dev/null; then
      echo -e "${GRAY}  channels status 读取失败，可能是当前版本暂不支持该命令${NC}"
    fi
  fi
  echo ""
  return 0
}

# 渠道接入：安装插件 + channels add
channel_setup() {
  echo ""
  echo -e "${YELLOW}--- 接入对话渠道 ---${NC}"
  echo "  [1] Telegram  [2] Discord  [3] 飞书  [4] 钉钉  [5] QQ  [0] 返回"
  read_input -p "选择: " ch
  case "$ch" in
    0) return ;;
    1) local plugin="" channel_name="Telegram" channel_id="telegram" ;;
    2) plugin="" channel_name="Discord" channel_id="discord" ;;
    3) plugin="@openclaw/feishu" channel_name="飞书" channel_id="feishu" ;;
    4) plugin="@adongguo/openclaw-dingtalk" channel_name="钉钉" channel_id="dingtalk" ;;
    5) plugin="@sliverp/qqbot" channel_name="QQ" channel_id="qq" ;;
    *) echo -e "${YELLOW}无效${NC}"; return ;;
  esac

  if [[ -n "$plugin" ]]; then
    echo -e "${CYAN}正在安装 $channel_name 插件: $plugin ...${NC}"
    export OPENCLAW_STATE_DIR="$OPENCLAW_CONFIG"
    local err_out
    err_out=$($OPENCLAW_CMD plugins install "${plugin}@latest" 2>&1)
    if [[ $? -ne 0 ]]; then
      echo -e "${RED}[失败] 插件安装失败${NC}"
      write_ticket_summary "渠道插件安装 ($channel_name)" "$err_out"
      return
    fi
    ensure_manifest_compat >/dev/null
    echo -e "${GREEN}[OK] 插件已安装${NC}"
  fi

  echo -e "${CYAN}启动 openclaw channels add，按提示填写 Token / App ID 等${NC}"
  echo "获取: Telegram: @BotFather | Discord: discord.com/developers | 飞书: open.feishu.cn | 钉钉: open.dingtalk.com | QQ: bot.q.qq.com"
  echo ""
  local add_args=("channels" "add")
  if run_openclaw channels add --help 2>/dev/null | grep -q '\--channel'; then
    add_args+=("--channel" "$channel_id")
  fi
  run_openclaw "${add_args[@]}"
  if [[ $? -eq 0 ]] && gateway_running; then
    read_input -p "Gateway 运行中，是否重启以应用新配置？(Y/n): " restart
    restart="${restart:-y}"
    if [[ "${restart,,}" != "n" && "${restart,,}" != "no" ]]; then
      run_openclaw gateway restart 2>/dev/null || true
      echo -e "${GREEN}[OK] Gateway 已重启${NC}"
    fi
    echo "  查看配对码: openclaw pairing list $channel_id"
    echo "  批准配对: openclaw pairing approve $channel_id <CODE>"
  fi
}

# 配置备份
backup_config() {
  local out_dir="${1:-$HOME}"
  local zip_name="openclaw_backup_$(date +%Y%m%d_%H%M%S).zip"
  local zip_path="$out_dir/$zip_name"
  if [[ ! -d "$OPENCLAW_CONFIG" ]]; then
    echo -e "${YELLOW}配置目录不存在${NC}"
    return 1
  fi
  if command -v zip &>/dev/null; then
    (cd "$(dirname "$OPENCLAW_CONFIG")" && zip -r "$zip_path" "$(basename "$OPENCLAW_CONFIG")" -x "*.log" 2>/dev/null)
  elif command -v tar &>/dev/null; then
    tar -czf "${zip_path%.zip}.tar.gz" -C "$(dirname "$OPENCLAW_CONFIG")" "$(basename "$OPENCLAW_CONFIG")" 2>/dev/null
    zip_path="${zip_path%.zip}.tar.gz"
  else
    echo -e "${RED}需要 zip 或 tar${NC}"
    return 1
  fi
  if [[ -f "$zip_path" ]]; then
    echo -e "${GREEN}[OK] 备份已保存: $zip_path${NC}"
  else
    echo -e "${RED}[失败] 备份失败${NC}"
  fi
}

# 配置恢复
restore_config() {
  local zip_path="$1"
  if [[ ! -f "$zip_path" ]]; then
    echo -e "${RED}文件不存在${NC}"
    return 1
  fi
  mkdir -p "$OPENCLAW_CONFIG"
  if [[ "$zip_path" == *.zip ]]; then
    unzip -o "$zip_path" -d "$(dirname "$OPENCLAW_CONFIG")" 2>/dev/null || true
  else
    tar -xzf "$zip_path" -C "$(dirname "$OPENCLAW_CONFIG")" 2>/dev/null || true
  fi
  echo -e "${GREEN}[OK] 配置已恢复${NC}"
}

# 诊断导出
export_diagnostic() {
  local out_dir="${1:-$HOME}"
  local fname="openclaw_diagnostic_$(date +%Y%m%d_%H%M%S).txt"
  local fpath="$out_dir/$fname"
  {
    echo "=== OpenClaw Diagnostic Export ==="
    echo "Time: $(date '+%Y-%m-%d %H:%M:%S')"
    echo "Path: $OPENCLAW_CMD"
    echo "Version: $($OPENCLAW_CMD --version 2>/dev/null)"
    echo "Gateway: $(gateway_running && echo Running || echo Stopped)"
    echo ""
    echo "--- openclaw doctor ---"
    run_openclaw doctor 2>&1
    echo ""
    echo "--- openclaw status ---"
    run_openclaw status 2>&1
  } > "$fpath"
  echo -e "${GREEN}[OK] 诊断已导出: $fpath${NC}"
}

# 打开文档
open_docs() {
  local url="https://docs.openclaw.ai/cli"
  echo -e "${CYAN}文档: $url${NC}"
  if command -v xdg-open &>/dev/null; then
    xdg-open "$url" 2>/dev/null &
  elif command -v open &>/dev/null; then
    open "$url" 2>/dev/null &
  fi
}

# 嗅探 OpenClaw 安装位置（与 find_openclaw 检测逻辑一致，避免「已安装」但「无可删除」）
find_openclaw_locations() {
  local current_dir
  if [[ "$OPENCLAW_CMD" == */* ]]; then
    current_dir="${OPENCLAW_CMD%/*}"
  else
    # command -v openclaw 可找到 PATH 中的实际路径，与第一页检测一致
    current_dir=$(dirname "$(command -v openclaw 2>/dev/null)" 2>/dev/null)
  fi
  local npm_prefix npm_root path_dir
  npm_prefix=$(npm config get prefix 2>/dev/null) || true
  npm_root=$(npm root -g 2>/dev/null) || true
  path_dir=$(command -v openclaw 2>/dev/null | xargs dirname 2>/dev/null) || true
  # 加入 PATH 中 openclaw 所在目录，确保与第一页「已安装」检测一致
  for dir in /usr/local/bin /opt/homebrew/bin "$HOME/.local/bin" "$HOME/.npm-global/bin" \
      "${npm_prefix%/}/bin" "${npm_root%/}/../bin" "$path_dir"; do
    [[ -z "$dir" || ! -d "$dir" ]] && continue
    dir="${dir%/}"
    [[ -x "$dir/openclaw" ]] || continue
    local ver="" cur=""
    ver=$("$dir/openclaw" --version 2>/dev/null) || true
    [[ "$dir" == "$current_dir" ]] && cur=" (当前)"
    echo "$dir|$ver|$cur"
  done | sort -u -t'|' -k1,1
}

purge_openclaw_by_prefix() {
  local prefix="$1"
  [[ -z "$prefix" ]] && return 1
  prefix="${prefix%/}"

  npm uninstall -g openclaw --prefix "$prefix" >/dev/null 2>&1 || true
  rm -f "$prefix/bin/openclaw" "$prefix/bin/openclaw.cmd" >/dev/null 2>&1 || true
  rm -rf "$prefix/lib/node_modules/openclaw" "$prefix/node_modules/openclaw" >/dev/null 2>&1 || true

  if [[ -x "$prefix/bin/openclaw" || -d "$prefix/lib/node_modules/openclaw" || -d "$prefix/node_modules/openclaw" ]]; then
    return 1
  fi
  return 0
}

purge_openclaw_fallback() {
  local npm_prefix npm_root path_bin
  local prefixes=()
  npm_prefix=$(npm config get prefix 2>/dev/null || true)
  npm_root=$(npm root -g 2>/dev/null || true)
  path_bin=$(command -v openclaw 2>/dev/null | xargs dirname 2>/dev/null || true)

  [[ -n "$npm_prefix" ]] && prefixes+=("${npm_prefix%/}")
  [[ -n "$npm_root" ]] && prefixes+=("$(dirname "$npm_root")")
  [[ -n "$HOME" ]] && prefixes+=("$HOME/.local" "$HOME/.npm-global")
  [[ -n "$path_bin" ]] && prefixes+=("$(dirname "$path_bin")")
  prefixes+=("/usr/local" "/opt/homebrew")

  local p ok_count=0
  for p in "${prefixes[@]}"; do
    [[ -z "$p" ]] && continue
    if purge_openclaw_by_prefix "$p"; then
      ((ok_count++)) || true
    fi
  done
  echo "$ok_count"
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

# 显示主菜单（与 Windows OpenClaw_Shell.ps1 功能对应）
show_header() {
  clear
  echo ""
  echo -e "${CYAN}==========================================${NC}"
  echo -e "${CYAN}  OpenClaw (Linux/macOS)${NC}"
  echo -e "${CYAN}==========================================${NC}"
  local oc_dir
  if [[ "$OPENCLAW_CMD" == */* ]]; then
    oc_dir="${OPENCLAW_CMD%/*}"
  else
    oc_dir=$(command -v $OPENCLAW_CMD 2>/dev/null | xargs dirname 2>/dev/null)
  fi
  echo -e "${GRAY}  路径: ${oc_dir:-$OPENCLAW_CMD}${NC}"
  if gateway_running; then
    echo -e "${GREEN}  Gateway: 运行中${NC}"
  else
    echo -e "${GRAY}  Gateway: 已停止${NC}"
  fi
  echo -e "${GRAY}  配置: $OPENCLAW_CONFIG${NC}"
  echo ""
  echo -e "  [1]  快速配置 - 首次使用 / API / 渠道接入"
  echo -e "  [2]  启动 Gateway"
  echo -e "  [3]  常用命令 - status / gateway / doctor 等"
  echo -e "  [4]  运行 OpenClaw - 进入 openclaw 命令行"
  echo -e "  [5]  检查更新"
  echo -e "  [6]  打开对话界面"
  echo -e "  [7]  配置路径 - 设置 OPENCLAW_STATE_DIR"
  echo -e "  [8]  帮助与文档"
  echo -e "  [9]  安装管理 - 嗅探 / 删除 / 热迁移"
  echo -e "  [10] 工具箱 - 备份 / 恢复 / 诊断 / Skills / 最小修复"
  echo -e "  [0]  退出"
  echo -e "${CYAN}==========================================${NC}"
  echo ""
}

# 快速配置（硅基流动）- 与 Windows [b] 对应
quick_config_siliconflow() {
  echo ""
  echo -e "${YELLOW}--- 快速配置（硅基流动）---${NC}"
  mkdir -p "$OPENCLAW_CONFIG"

  echo "选择模型:"
  local i=1
  for item in "${FIXED_MODELS[@]}"; do
    local id="${item%%:*}" label="${item#*:}"
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

  read_input -p "是否安装官方 Skills 依赖? (Y/n): " install_skills_choice
  install_skills_choice="$(echo "${install_skills_choice:-y}" | tr '[:upper:]' '[:lower:]')"
  local skip_skills="false"
  [[ "$install_skills_choice" == "n" || "$install_skills_choice" == "no" ]] && skip_skills="true"

  echo ""
  local mcount
  mcount=$(ensure_manifest_compat)
  [[ "${mcount:-0}" -gt 0 ]] && echo -e "${GRAY}[预处理] 已补齐 $mcount 个插件 manifest${NC}"
  echo -e "${CYAN}正在执行配置 (模型: $model_id, Skills: $([[ "$skip_skills" == "true" ]] && echo 跳过 || echo 安装))...${NC}"
  export OPENCLAW_STATE_DIR="$OPENCLAW_CONFIG"
  local onboard_args=(
    onboard --non-interactive --mode local
    --auth-choice custom-api-key --custom-base-url "$DEFAULT_BASE_URL"
    --custom-model-id "$model_id" --custom-api-key "$api_key"
    --custom-compatibility openai --node-manager npm --secret-input-mode plaintext
    --gateway-port 18789 --gateway-bind loopback
    --skip-channels --skip-daemon --accept-risk
  )
  [[ "$skip_skills" == "true" ]] && onboard_args+=(--skip-skills)
  $OPENCLAW_CMD "${onboard_args[@]}" 2>/dev/null || true
  echo -e "${GREEN}[OK] 配置完成${NC}"
}

# 快速配置主菜单（与 Windows [1] 子菜单对应）
quick_config_menu() {
  while true; do
    echo ""
    echo -e "${YELLOW}--- 快速配置 ---${NC}"
    echo "  [a] 交互式配置 - 完整向导 (openclaw onboard)"
    echo "  [b] 快速配置 - 硅基流动 API + 模型 + 可选 Skills"
    echo "  [c] 接入对话渠道 - Telegram / QQ / 飞书 / 钉钉 / Discord"
    echo "  [d] 查看所有渠道状态"
    echo "  [0] 返回主菜单"
    read_input -p "请选择: " cfg
    cfg="${cfg:-}"
    case "$cfg" in
      a) echo -e "${CYAN}正在打开交互式配置...${NC}"; run_openclaw onboard ;;
      b) quick_config_siliconflow ;;
      c) channel_setup ;;
      d) show_channel_status || true ;;
      0) return ;;
      *) echo -e "${YELLOW}无效${NC}" ;;
    esac
  done
}

# 主流程
main() {
  # 快捷参数（需先解析 openclaw 路径）
  OPENCLAW_CMD=$(find_openclaw)
  case "${1:-}" in
    minimal-repair) ensure_openclaw && minimal_repair; exit 0 ;;
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
      1) quick_config_menu ;;
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
        while true; do
          echo ""
          echo -e "${YELLOW}--- 常用命令 ---${NC}"
          echo "  [1] Gateway 状态  [2] 启动  [3] 停止  [4] 重启"
          echo "  [5] 模型列表  [6] 渠道状态  [7] 诊断检查  [8] 完整状态"
          echo "  [0] 返回主菜单"
          read_input -p "选择: " sub
          case "$sub" in
            1) run_openclaw gateway status ;;
            2) start_gateway; sleep 2; run_openclaw gateway status ;;
            3) stop_gateway; echo -e "${GREEN}[OK] 已停止${NC}" ;;
            4) run_openclaw gateway restart ;;
            5) run_openclaw models list ;;
            6) run_openclaw channels status ;;
            7) run_openclaw doctor ;;
            8) run_openclaw status ;;
            0) break ;;
            *) echo "无效" ;;
          esac
        done
        ;;
      4)
        echo ""
        echo -e "${CYAN}进入 openclaw 命令行，输入 exit 退出${NC}"
        run_openclaw
        ;;
      5)
        echo ""
        echo -e "${CYAN}正在更新 OpenClaw...${NC}"
        npm install -g openclaw@latest 2>/dev/null || npm install -g openclaw@latest --prefix "$HOME/.local" 2>/dev/null
        echo -e "${GREEN}[OK] 完成${NC}"
        OPENCLAW_CMD=$(find_openclaw)
        ;;
      6)
        if gateway_running; then
          open_browser
        else
          echo -e "${YELLOW}Gateway 未运行，正在启动...${NC}"
          start_gateway
          sleep 4
          open_browser
        fi
        ;;
      7)
        while true; do
          echo ""
          echo -e "${YELLOW}--- 配置路径 ---${NC}"
          echo "  当前: $OPENCLAW_CONFIG"
          echo "  [a] 设置自定义路径  [b] 恢复默认  [c] 持久化到 shell 配置"
          echo "  [0] 返回"
          read_input -p "选择: " cp
          case "$cp" in
            a)
              read_input -p "新路径 (留空取消): " new_path
              if [[ -n "$new_path" ]]; then
                OPENCLAW_CONFIG="${new_path%/}"
                export OPENCLAW_STATE_DIR="$OPENCLAW_CONFIG"
                echo -e "${GREEN}[OK] 当前会话已切换${NC}"
              fi
              ;;
            b)
              OPENCLAW_CONFIG="$HOME/.openclaw"
              export OPENCLAW_STATE_DIR="$OPENCLAW_CONFIG"
              echo -e "${GREEN}[OK] 已恢复默认${NC}"
              ;;
            c)
              local rc_file
              [[ -f "$HOME/.zshrc" ]] && rc_file="$HOME/.zshrc" || rc_file="$HOME/.bashrc"
              echo "" >> "$rc_file"
              echo "# OpenClaw 配置路径" >> "$rc_file"
              echo "export OPENCLAW_STATE_DIR=\"$OPENCLAW_CONFIG\"" >> "$rc_file"
              echo -e "${GREEN}[OK] 已追加到 $rc_file，新开终端生效${NC}"
              ;;
            0) break ;;
            *) echo "无效" ;;
          esac
        done
        ;;
      8) open_docs ;;
      9)
        while true; do
          echo ""
          echo -e "${YELLOW}--- 安装管理 ---${NC}"
          echo "  [a] 一键嗅探 - 检测所有 OpenClaw 安装"
          echo "  [b] 删除安装 - 选择后自动卸载  [c] 热迁移  [0] 返回"
          read_input -p "选择: " im
          case "$im" in
            a)
              echo ""
              OPENCLAW_CMD=$(find_openclaw)
              local locs line dir ver cur
              locs=$(find_openclaw_locations 2>/dev/null || true)
              if [[ -z "$locs" ]]; then
                echo -e "${YELLOW}未检测到安装${NC}"
              else
                local i=1
                while IFS= read -r line; do
                  [[ -z "$line" ]] && continue
                  dir="${line%%|*}"
                  ver="${line#*|}"
                  cur="${ver##*|}"
                  ver="${ver%|*}"
                  echo -e "  [$i] $dir${ver:+ $ver}$cur"
                  ((i++)) || true
                done <<< "$locs"
              fi
              ;;
            b)
              echo ""
              OPENCLAW_CMD=$(find_openclaw)
              local locs_arr=() i=1 sel idx target_dir prefix
              while IFS= read -r line; do
                [[ -z "$line" ]] && continue
                dir="${line%%|*}"
                locs_arr+=("$dir")
                ver="${line#*|}"
                cur="${ver##*|}"
                ver="${ver%|*}"
                echo -e "  [$i] $dir${ver:+ $ver}$cur"
                ((i++)) || true
              done <<< "$(find_openclaw_locations 2>/dev/null || true)"
              if [[ ${#locs_arr[@]} -eq 0 ]]; then
                echo -e "${YELLOW}未检测到可枚举安装，正在尝试自动清理常见路径...${NC}"
                local cleaned
                cleaned=$(purge_openclaw_fallback)
                OPENCLAW_CMD=$(find_openclaw)
                if [[ -z "$OPENCLAW_CMD" ]]; then
                  echo -e "${GREEN}[OK] 自动清理完成（清理尝试: $cleaned）${NC}"
                else
                  echo -e "${YELLOW}仍检测到命令: $OPENCLAW_CMD，可重试一次或手动检查 PATH${NC}"
                fi
              else
                echo "  [0] 取消"
                read_input -p "选择要删除的安装: " sel
                sel="${sel:-0}"
                if [[ "$sel" != "0" ]] && [[ "$sel" =~ ^[0-9]+$ ]]; then
                  idx=$((sel))
                  if [[ $idx -ge 1 && $idx -le ${#locs_arr[@]} ]]; then
                    target_dir="${locs_arr[$((idx-1))]}"
                    read_input -p "确认删除 $target_dir ? (y/N): " confirm
                    confirm="${confirm:-n}"
                    if [[ "${confirm,,}" == "y" || "${confirm,,}" == "yes" ]]; then
                      prefix="${target_dir%/bin}"
                      [[ "$prefix" == "$target_dir" ]] && prefix="$(dirname "$target_dir")"
                      if purge_openclaw_by_prefix "$prefix"; then
                        echo -e "${GREEN}[OK] 已自动卸载并清理${NC}"
                      else
                        rm -f "$target_dir/openclaw" "$target_dir/openclaw.cmd" 2>/dev/null || true
                        if [[ ! -f "$target_dir/openclaw" && ! -f "$target_dir/openclaw.cmd" ]]; then
                          echo -e "${GREEN}[OK] 已自动清理可执行文件${NC}"
                        else
                          echo -e "${YELLOW}清理可能未完全完成，建议重试一次删除${NC}"
                        fi
                      fi
                      OPENCLAW_CMD=$(find_openclaw)
                    else
                      echo "已取消"
                    fi
                  else
                    echo "无效选择"
                  fi
                fi
              fi
              ;;
            c) echo -e "${GRAY}请手动迁移目录后重装${NC}" ;;
            0) break ;;
            *) echo "无效" ;;
          esac
        done
        ;;
      10)
        while true; do
          echo ""
          echo -e "${YELLOW}--- 工具箱 ---${NC}"
          echo "  [a] 配置备份  [b] 配置恢复  [c] 诊断导出"
          echo "  [d] 代理设置  [e] 修复 Gateway  [f] 前台启动 Gateway"
          echo "  [g] Skills 管理  [h] 一键最小修复  [0] 返回"
          read_input -p "选择: " tool
          case "$tool" in
            a) read_input -p "保存目录 (默认 $HOME): " out; backup_config "${out:-$HOME}" ;;
            b)
              read_input -p "备份文件路径: " zip_path
              [[ -n "$zip_path" ]] && restore_config "$zip_path"
              ;;
            c) read_input -p "保存目录 (默认 $HOME): " out; export_diagnostic "${out:-$HOME}" ;;
            d)
              echo "当前 proxy: $(npm config get proxy 2>/dev/null || echo 未设置)"
              read_input -p "设置代理 (留空清除): " px
              if [[ -n "$px" ]]; then
                npm config set proxy "$px" && npm config set https-proxy "$px"
                echo -e "${GREEN}[OK] 已设置${NC}"
              else
                npm config delete proxy 2>/dev/null; npm config delete https-proxy 2>/dev/null
                echo -e "${GREEN}[OK] 已清除${NC}"
              fi
              ;;
            e)
              echo -e "${CYAN}停止 -> 重新注册 -> 启动${NC}"
              stop_gateway
              sleep 2
              run_openclaw gateway install --force 2>/dev/null || true
              start_gateway
              sleep 3
              gateway_running && echo -e "${GREEN}[OK] Gateway 已修复${NC}" || echo -e "${YELLOW}请用选项 2 启动${NC}"
              ;;
            f)
              echo -e "${CYAN}新开终端运行: openclaw gateway (保持窗口不关)${NC}"
              echo "  export OPENCLAW_STATE_DIR=\"$OPENCLAW_CONFIG\""
              echo "  openclaw gateway"
              ;;
            g)
              echo ""
              echo "  [1] 列出 Skills  [2] 检查依赖  [3] 一键安装/更新"
              read_input -p "选择: " sk
              case "$sk" in
                1) ensure_manifest_compat >/dev/null; run_openclaw skills list ;;
                2) run_openclaw skills check ;;
                3)
                  echo -e "${CYAN}[预处理] manifest 补齐 + doctor --fix...${NC}"
                  ensure_manifest_compat >/dev/null
                  run_openclaw doctor --fix 2>/dev/null || true
                  echo -e "${CYAN}正在安装/更新 Skills...${NC}"
                  local err_out oc_ec
                  export OPENCLAW_STATE_DIR="$OPENCLAW_CONFIG"
                  err_out=$($OPENCLAW_CMD onboard --non-interactive --accept-risk --mode local --auth-choice skip --node-manager npm --skip-channels --skip-daemon --skip-health --skip-ui 2>&1)
                  oc_ec=$?
                  if [[ $oc_ec -eq 0 ]]; then
                    echo -e "${GREEN}[OK] Skills 已更新${NC}"
                    run_openclaw skills check
                  else
                    echo -e "${RED}[失败] Skills 更新失败${NC}"
                    write_ticket_summary "Skills 安装/更新" "$err_out"
                  fi
                  ;;
                *) echo "无效" ;;
              esac
              ;;
            h) minimal_repair ;;
            0) break ;;
            *) echo "无效" ;;
          esac
        done
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
