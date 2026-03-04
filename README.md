# OpenClaw 一键部署

> 小白零门槛部署 [OpenClaw](https://github.com/openclaw/openclaw) 私人 AI 助手的 Windows 桌面工具

[![Tauri](https://img.shields.io/badge/Tauri-2.0-blue.svg)](https://tauri.app/)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

## 简介

**OpenClaw 一键部署** 是一款图形化桌面应用，帮助你在 Windows 上快速安装、配置并启动 OpenClaw。无需手写配置文件，按向导三步即可完成部署。

- **零门槛**：图形界面，无需命令行基础
- **一键安装**：自动检测环境，通过 npm 全局安装 OpenClaw
- **配置向导**：支持 Claude、GPT、DeepSeek、Kimi、阿里云百炼等，可配置自定义 API 地址（OneAPI、NewAPI 等）
- **渠道配置**：Telegram、飞书、QQ 等渠道的图形化配置与配对

## 功能概览

| 功能 | 说明 |
|------|------|
| 环境检测 | 自动检测 Node.js（≥22）、npm、OpenClaw 安装状态 |
| 一键安装 | 通过 npm 全局安装 OpenClaw |
| 配置向导 | AI 模型、API Key、自定义 API 地址 |
| 启动服务 | 启动 Gateway 并自动打开对话网页 |
| 渠道配置 | Telegram、飞书、QQ 等渠道配对 |

## 下载与安装

### 方式一：安装包（推荐）

1. 前往 [Releases](https://github.com/你的用户名/openclaw-deploy/releases) 下载最新版本
2. 选择 **NSIS 安装包**（`.exe`）或 **MSI 安装包**（`.msi`）
3. 运行安装程序，按提示完成安装

### 方式二：绿色版（免安装）

1. 下载 `OpenClaw-Deploy-vX.X.X-Windows.zip`
2. 解压到任意目录
3. 双击 `openclaw-deploy.exe` 运行

压缩包内同时包含：
- `openclaw-deploy.exe` - 主程序
- `OpenClaw_Shell_Install.cmd` - Shell 安装/启动脚本（命令行用户可用）
- `使用文档.md` - 详细使用说明与常见问题

## 使用流程

1. **安装 Node.js**（建议 v22 及以上）  
   若未安装，请从 [Node.js 官网](https://nodejs.org/) 下载并安装。

2. **打开本工具**，按向导完成：
   - 步骤 1：安装 OpenClaw
   - 步骤 2：配置 AI 模型（选择提供商、填入 API Key）
   - 步骤 3：点击「启动 Gateway 并自动打开对话网页」，浏览器会自动打开对话界面

3. 如需 Telegram 等渠道，在「启动服务」页的渠道卡片中完成配对。

## Shell 脚本

除图形界面外，还提供 `OpenClaw_Shell_Install.cmd` 脚本，用于在命令行中安装并启动 OpenClaw：

- **功能**：检测 openclaw 是否已安装，未安装则执行 `npm install -g openclaw`，然后启动服务
- **使用**：双击运行，或在 CMD 中执行
- **前置条件**：已安装 Node.js（含 npm）

## 从源码构建

### 环境要求

- Node.js >= 18
- Rust >= 1.70
- Windows: Microsoft C++ Build Tools + WebView2

### 构建步骤

```bash
# 克隆仓库
git clone https://github.com/你的用户名/openclaw-deploy.git
cd openclaw-deploy

# 安装依赖
npm install

# 开发模式（热重载）
npm run tauri dev

# 打包发布（生成 exe + 压缩包，含 Shell 脚本）
npm run tauri build
# 或双击根目录 build-release.bat
```

打包完成后：
- 可执行文件：`src-tauri/target/release/openclaw-deploy.exe`
- 发布文件夹：`release/`（含 exe、安装包、Shell 脚本、使用文档）
- 压缩包：`OpenClaw-Deploy-v0.1.0-Windows.zip`

## 常见问题

详见 [使用文档.md](使用文档.md)，包括：

- 启动后浏览器打开错误页面
- openclaw.cmd 找不到
- 内存资源不足
- 404 错误
- WebChat 连接断开
- 未检测到 npm

## 技术栈

- [Tauri 2](https://tauri.app/) - 跨平台桌面应用框架
- [React 19](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/)
- [Tailwind CSS](https://tailwindcss.com/) - 样式
- [Lucide React](https://lucide.dev/) - 图标

## 开源协议

[MIT](LICENSE)

## 致谢

- [OpenClaw](https://github.com/openclaw/openclaw) - 私人 AI 助手项目
