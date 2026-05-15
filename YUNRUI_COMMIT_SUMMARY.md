# 提交摘要：云睿OpenClaw Windows 品牌发行版

建议提交信息：

```text
feat: add Yunrui OpenClaw Windows release flow
```

## 主要改动

- 将 Tauri / Cargo / npm 元信息改为 `云睿OpenClaw` / `yunrui-openclaw`。
- 在配置页新增 API Key 入口分流：
  - `我已经有 API Key`
  - `去中转站获取 API Key`
- 保留自有 API Key 直填路径，不强制跳转中转站。
- 支持中转站 URL 本地持久化和构建期默认值：
  - `openclaw_relay_station_url`
  - `VITE_YUNRUI_RELAY_STATION_URL`
  - GitHub Secret: `YUNRUI_RELAY_STATION_URL`
- 中转站模式未填写 API Key 时阻止保存/验证。
- 恢复并保持聊天会话模式引用：`chatSessionModeRef.current = "synced"`。
- 强化 Windows 发布脚本：
  - 输出 `Yunrui-OpenClaw-v<version>-Windows.zip`
  - 主 exe 发布名为 `Yunrui-OpenClaw.exe`
  - 检查 Node/npm/Cargo
  - release 为空时拒绝生成空 zip
  - 发布包包含合规/检查/Actions 文档和 `LICENSE`
- 新增 GitHub Actions Windows 构建 workflow（使用 `pwsh` 执行发布脚本，避免 Windows PowerShell 5.1 中文路径/字符串编码问题）。
- 新增发布前检查脚本 `npm run check:yunrui`。
- 新增交付文档：
  - `云睿OpenClaw发布说明.md`
  - `RELEASE_CHECKLIST.md`
  - `GITHUB_ACTIONS_WINDOWS.md`

## 本地验证

已通过：

```bash
npm run check:yunrui && npm run build
```

输出包含：

```text
发布前检查通过。
✓ built
```

## 仍需真实 Windows 验证

当前 Mac 缺 Rust/Windows 构建环境，不能直接产出 Windows exe。真实可分发 zip 需要：

1. 推到 GitHub 后运行 `.github/workflows/build-yunrui-windows.yml`；或
2. 在 Windows 机器上执行 `build-release.bat`。

## 提交前文件列表

应包含：

- `.github/workflows/build-yunrui-windows.yml`
- `GITHUB_ACTIONS_WINDOWS.md`
- `RELEASE_CHECKLIST.md`
- `云睿OpenClaw发布说明.md`
- `scripts/check-yunrui-release.mjs`
- `scripts/build-release.ps1`
- `src/App.tsx`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`
- `package.json`
- `package-lock.json`
