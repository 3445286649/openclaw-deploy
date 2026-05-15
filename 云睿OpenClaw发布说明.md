# 云睿OpenClaw Windows 发布说明

云睿OpenClaw 是基于 OpenClaw 一键部署工具制作的 Windows 端品牌壳与新手引导版。

## 合规说明

- 本项目基于 OpenClaw / openclaw-deploy 的 MIT 开源许可进行定制。
- 发布包必须保留原始 `LICENSE` 文件、原作者署名与 MIT 协议信息。
- “云睿OpenClaw”仅代表本定制发行版的品牌名称，不表示抹除或替代上游项目作者贡献。

## API Key 入口

配置页提供两条路径：

1. **我已经有 API Key**：直接填写自己的 Key，验证后保存启用。
2. **去中转站获取 API Key**：填写并打开中转站链接；拿到 Key 后切回“我已经有 API Key”再保存。

自有 API Key 用户不会被强制跳转到中转站。

## Windows 打包

在 Windows 机器上执行：

```bat
build-release.bat
```

或：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1
```

成功后会生成：

- `release/` 发布文件夹
- `Yunrui-OpenClaw-v<version>-Windows.zip`

## 当前备注

中转站 URL 暂未内置。发布前可二选一：

1. 在应用中手动填写并保存；
2. 在构建时设置环境变量 `VITE_YUNRUI_RELAY_STATION_URL`，或在 GitHub 仓库 Secrets 中配置 `YUNRUI_RELAY_STATION_URL`，构建产物会自动带默认入口。
