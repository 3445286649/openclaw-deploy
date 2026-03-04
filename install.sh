#!/usr/bin/env bash
set -euo pipefail

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${GREEN}====================================${NC}"
echo -e "    OpenClaw 一键部署工具 v1.0"
echo -e "${GREEN}====================================${NC}"
echo ""

# 检测操作系统
OS="$(uname -s)"
case "${OS}" in
    Linux*)     MACHINE=Linux;;
    Darwin*)    MACHINE=Mac;;
    MINGW*|MSYS*|CYGWIN*) MACHINE=Windows;;
    *)          MACHINE="UNKNOWN:${OS}"
esac

echo -e "检测到系统：${YELLOW}${MACHINE}${NC}"

if [[ "${MACHINE}" == "Windows" ]]; then
    echo -e "${YELLOW}Windows 用户推荐使用图形化桌面版（双击安装）${NC}"
    echo ""
    echo "下载地址：https://github.com/3445286649/openclaw-deploy/releases"
    echo "或在 release zip 中双击 OpenClaw_Shell_Install.cmd"
    echo ""
    echo -e "${GREEN}按回车退出，或 Ctrl+C 中止${NC}"
    read -r
    exit 0
fi

# Linux / macOS 安装逻辑
echo -e "${GREEN}开始安装 OpenClaw...${NC}"

# 检查必要命令
command -v node >/dev/null 2>&1 || { echo -e "${RED}错误：未找到 Node.js，请先安装 → https://nodejs.org/${NC}"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo -e "${RED}错误：未找到 npm${NC}"; exit 1; }
command -v git >/dev/null 2>&1 || echo -e "${YELLOW}警告：未找到 git，部分功能可能受影响${NC}"

# 中国加速
npm config set registry https://registry.npmmirror.com 2>/dev/null || true

# 尝试全局安装（需要 sudo）
echo -e "${YELLOW}尝试全局安装 openclaw...${NC}"
if sudo npm install -g openclaw; then
    echo -e "${GREEN}全局安装成功！${NC}"
    OPENCLAW_CMD="openclaw"
else
    echo -e "${RED}全局安装失败（权限问题），切换本地安装...${NC}"
    INSTALL_DIR="$HOME/.openclaw-local"
    mkdir -p "$INSTALL_DIR" && cd "$INSTALL_DIR"
    npm init -y >/dev/null 2>&1
    npm install openclaw
    OPENCLAW_CMD="$INSTALL_DIR/node_modules/.bin/openclaw"
    echo -e "${GREEN}本地安装到 $INSTALL_DIR 成功${NC}"
    echo "启动命令：$OPENCLAW_CMD gateway --port 18789"
fi

# 确认安装
if ! $OPENCLAW_CMD --version >/dev/null 2>&1; then
    echo -e "${RED}安装验证失败，请检查 npm 权限或网络${NC}"
    exit 1
fi

# 配置目录
CONFIG_DIR="$HOME/.openclaw"
mkdir -p "$CONFIG_DIR"

# 追加配置（避免覆盖用户已有设置）
echo -e "${GREEN}自动配置作者推荐的稳定免费API...${NC}"
{
    echo 'export OPENAI_BASE_URL="https://api.siliconflow.cn/v1"'
    echo '# export OPENAI_API_KEY="你的硅基流动 Key 或加群领"'
    echo '# 备用 Kimi（长上下文强）：export OPENAI_BASE_URL="https://api.moonshot.ai/v1"'
} >> "$CONFIG_DIR/env"

echo -e "${YELLOW}已配置硅基流动 API（https://api.siliconflow.cn/v1）${NC}"
echo -e "没有 Key？立即加作者 QQ 群：${YELLOW}1088525353${NC} 领免费测试额度 + 专属代理通知！"
echo -e "${BLUE}提示：编辑 $CONFIG_DIR/env 填入你的 Key，然后重启 Gateway${NC}"
echo ""

# 启动 Gateway（用 nohup 后台持久运行）
echo -e "${GREEN}启动 OpenClaw Gateway（端口 18789）...${NC}"
nohup $OPENCLAW_CMD gateway --port 18789 > "$CONFIG_DIR/gateway.log" 2>&1 &

sleep 4  # 等待启动

# 尝试打开浏览器
if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "http://127.0.0.1:18789" 2>/dev/null || true
elif command -v open >/dev/null 2>&1; then
    open "http://127.0.0.1:18789" 2>/dev/null || true
elif command -v wslview >/dev/null 2>&1; then  # WSL 支持
    wslview "http://127.0.0.1:18789" 2>/dev/null || true
else
    echo -e "${YELLOW}请手动浏览器打开：http://127.0.0.1:18789${NC}"
fi

echo ""
echo -e "${GREEN}部署完成！${NC}"
echo "WebUI 地址：http://127.0.0.1:18789"
echo "日志文件：$CONFIG_DIR/gateway.log"
echo "欢迎加群 1088525353 获取帮助、免费额度、包月代理"
echo ""