@echo off
setlocal EnableExtensions
chcp 65001 >nul 2>nul

set "SCRIPT_DIR=%~dp0"
set "NPM_GLOBAL=%APPDATA%\npm"
REM Add Node.js and npm to PATH (fix: npm not recognized when launched from shortcut/explorer)
set "NODE_PATHS=%ProgramFiles%\nodejs;%ProgramFiles(x86)%\nodejs;%LOCALAPPDATA%\Programs\node;D:\nodejs;C:\nodejs;%NPM_GLOBAL%"
set "PATH=%NODE_PATHS%;%PATH%"

cd /d "%SCRIPT_DIR%"

echo.
echo ==========================================
echo   OpenClaw 一键部署 - Shell 脚本
echo   交互式菜单 / 快速配置 / 常用命令
echo ==========================================
echo.

REM Use PowerShell script (interactive menu) via Bootstrap for UTF-8
if exist "%SCRIPT_DIR%OpenClaw_Shell.ps1" (
  powershell -ExecutionPolicy Bypass -NoProfile -File "%SCRIPT_DIR%OpenClaw_Shell_Bootstrap.ps1" %*
  if errorlevel 1 (
    echo.
    echo [提示] 脚本异常退出，请检查上方错误信息
    pause
  )
  goto :eof
)

REM Fallback: 无主脚本时，用仅安装脚本（第一页检测 -> 第二页安装选项）
if exist "%SCRIPT_DIR%OpenClaw_Install_Only.ps1" (
  powershell -ExecutionPolicy Bypass -File "%SCRIPT_DIR%OpenClaw_Install_Only.ps1" %*
  goto :eof
)

REM 缺少主脚本时提示：完整功能需复制整个 scripts 文件夹
echo [提示] 未找到 OpenClaw_Shell.ps1，仅有最小安装功能
echo 完整菜单（快速配置/Gateway/渠道等）需复制整个 scripts 文件夹：
echo   - OpenClaw_Shell_Install.cmd
echo   - OpenClaw_Shell.ps1
echo   - OpenClaw_Shell_Bootstrap.ps1
echo   - OpenClaw_Install_Only.ps1
echo.
echo 继续执行最小安装...
echo.

REM 最小 fallback: 直接安装
set "OPENCLAW_CMD=%NPM_GLOBAL%\openclaw.cmd"
if not exist "%NPM_GLOBAL%" mkdir "%NPM_GLOBAL%" 2>nul

where node >nul 2>nul || (
  echo [失败] 未检测到 Node.js
  pause
  exit /b 1
)
where npm >nul 2>nul || (
  echo [失败] 未检测到 npm
  pause
  exit /b 1
)

where git >nul 2>nul || (
  echo [警告] 未检测到 Git，安装 OpenClaw 可能失败
  echo 若出现 spawn git 错误，请先安装: https://git-scm.com/download/win
  echo.
)

if not exist "%OPENCLAW_CMD%" (
  echo [1/2] 安装 OpenClaw...
  npm install -g openclaw
  if errorlevel 1 (
    echo [失败] 安装失败
    echo [提示] EPERM: 用脚本选择「自定义目录」安装到 D:\openclow
    echo [提示] ECONNRESET: 检查网络、代理或防火墙
    pause
    exit /b 1
  )
)

echo [2/2] 启动 OpenClaw...
call "%OPENCLAW_CMD%" %*
pause
