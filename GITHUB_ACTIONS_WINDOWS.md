# GitHub Actions 生成 Windows 包

当前仓库已配置 workflow：

```text
.github/workflows/build-yunrui-windows.yml
```

## 手动生成

1. 推送当前分支到 GitHub。
2. 打开仓库页面。
3. 进入 `Actions`。
4. 选择 `Build Yunrui OpenClaw Windows`。
5. 点击 `Run workflow`。
6. 等待任务完成后，在任务页面底部下载 artifacts：
   - `Yunrui-OpenClaw-release-folder`
   - `Yunrui-OpenClaw-Windows-zip`

## 配置默认中转站入口

如果要让构建产物自带默认中转站入口，添加仓库 Secret：

```text
Settings -> Secrets and variables -> Actions -> New repository secret
Name: YUNRUI_RELAY_STATION_URL
Value: https://你的中转站地址
```

不配置也可以，用户仍能在应用中手动填写中转站 URL。

## CI 会检查什么

workflow 会依次执行：

```bash
npm ci
npm run check:yunrui
./scripts/build-release.ps1
```

发布脚本在 GitHub Actions 中使用 `pwsh` 运行，避免 Windows PowerShell 5.1 对中文文件名/字符串编码处理不一致导致脚本解析失败。

`check:yunrui` 会先检查品牌名、API Key 双入口、合规文件、Windows 发布命名和构建脚本关键逻辑。检查失败时不会继续打包。

## 产物命名

最终 zip 应为：

```text
Yunrui-OpenClaw-v<version>-Windows.zip
```

release 文件夹内主程序应为：

```text
Yunrui-OpenClaw.exe
```
