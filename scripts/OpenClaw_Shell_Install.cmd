@echo off
setlocal EnableExtensions
chcp 65001 >nul

set "NPM_GLOBAL=%APPDATA%\npm"
set "OPENCLAW_CMD=%NPM_GLOBAL%\openclaw.cmd"

echo ==========================================
echo OpenClaw Shell Installer / Launcher
echo ==========================================
echo.

if not exist "%NPM_GLOBAL%" (
  mkdir "%NPM_GLOBAL%" >nul 2>nul
)
set "PATH=%NPM_GLOBAL%;%PATH%"

if not exist "%OPENCLAW_CMD%" (
  echo [1/2] 未检测到 openclaw，开始全局安装...
  where npm >nul 2>nul
  if errorlevel 1 (
    echo [错误] 未检测到 npm，请先安装 Node.js（包含 npm）。
    echo 按任意键退出...
    pause >nul
    exit /b 1
  )

  npm install -g openclaw
  if errorlevel 1 (
    echo [错误] openclaw 安装失败，请检查网络或 npm 权限。
    echo 按任意键退出...
    pause >nul
    exit /b 1
  )
) else (
  echo [1/2] 已检测到 openclaw，无需重复安装。
)

echo.
echo [2/2] 正在启动 OpenClaw...
if not exist "%OPENCLAW_CMD%" (
  echo [错误] openclaw.cmd 仍不存在: "%OPENCLAW_CMD%"
  echo 请确认 npm 全局安装目录权限是否正常。
  echo 按任意键退出...
  pause >nul
  exit /b 1
)

call "%OPENCLAW_CMD%" %*
set "EC=%ERRORLEVEL%"

echo.
if not "%EC%"=="0" (
  echo OpenClaw 退出码: %EC%
  echo 按任意键关闭窗口...
  pause >nul
)
exit /b %EC%
