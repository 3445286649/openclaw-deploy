# 云睿OpenClaw 发布检查清单

这份清单用于把当前仓库产出为可分发的 Windows 版 `云睿OpenClaw`。

## 1. 合规底线

发布前必须确认：

- [ ] 发布包包含 `LICENSE`
- [ ] 发布包包含 `云睿OpenClaw发布说明.md`
- [ ] 不删除上游 OpenClaw / openclaw-deploy 贡献者署名
- [ ] 不宣传为完全原创项目；只能表述为“基于 OpenClaw 定制的云睿发行版/品牌壳”

## 2. API Key 入口规则

产品内必须保留两条路径：

- [ ] `我已经有 API Key`：用户可直接输入自己的 Key、验证、保存
- [ ] `去中转站获取 API Key`：用户可打开中转站获取 Key
- [ ] 中转站路径不能强制替代自有 Key 路径
- [ ] 中转站模式没有 API Key 时，不能空保存/空验证

## 3. 发布前本地检查

在任意有 Node.js 的机器上先执行：

```bash
npm ci
npm run check:yunrui
npm run build
```

预期结果：

```text
发布前检查通过。
✓ built
```

> 注意：`npm run build` 只验证前端和 TypeScript，不会产出 Windows 原生 exe。

## 4. 中转站 URL 配置

如果暂时没有中转站 URL，可以不配置，应用内仍可手动填写。

如果需要构建产物自带默认入口，二选一：

### 方式 A：本地 Windows 构建时设置环境变量

PowerShell：

```powershell
$env:VITE_YUNRUI_RELAY_STATION_URL = "https://你的中转站地址"
powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1
```

### 方式 B：GitHub Actions Secret

在 GitHub 仓库中配置：

```text
Settings -> Secrets and variables -> Actions -> New repository secret
Name: YUNRUI_RELAY_STATION_URL
Value: https://你的中转站地址
```

随后手动运行 workflow：

```text
Actions -> Build Yunrui OpenClaw Windows -> Run workflow
```

## 5. Windows 本地打包

要求 Windows 机器已安装：

- Node.js 22 LTS 或更高
- Rust stable / Cargo
- npm

双击：

```bat
build-release.bat
```

或在 PowerShell 中执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1
```

成功后应生成：

```text
release/
Yunrui-OpenClaw-v<version>-Windows.zip
```

## 6. GitHub Actions 打包

当前仓库已包含：

```text
.github/workflows/build-yunrui-windows.yml
```

流程会自动执行：

1. `npm ci`
2. `npm run check:yunrui`
3. `scripts\build-release.ps1`
4. 上传 artifacts：
   - `Yunrui-OpenClaw-release-folder`
   - `Yunrui-OpenClaw-Windows-zip`

## 7. 发布包人工验收

拿到 zip 后检查：

- [ ] zip 文件名是 `Yunrui-OpenClaw-v<version>-Windows.zip`
- [ ] `release/` 内有 `Yunrui-OpenClaw.exe` 或 NSIS 安装包
- [ ] `LICENSE` 存在
- [ ] `云睿OpenClaw发布说明.md` 存在
- [ ] 打开应用窗口标题是 `云睿OpenClaw`
- [ ] 配置页显示 API Key 双路径入口
- [ ] “我已经有 API Key”可直接输入并验证
- [ ] “去中转站获取 API Key”可打开配置的 URL

## 8. 已知限制

- 当前 Mac 本机没有 Rust/Windows 构建环境，不能直接产出 Windows exe。
- 真正的 Windows exe/安装包需要在 Windows 机器或 GitHub Actions `windows-latest` 上构建。
