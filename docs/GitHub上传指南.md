# 如何上传到 GitHub

## 一、首次上传

### 1. 在 GitHub 创建仓库

1. 登录 [GitHub](https://github.com)
2. 点击右上角 **+** → **New repository**
3. 填写：
   - **Repository name**：`openclaw-deploy`（或自定义）
   - **Description**：`OpenClaw 一键部署 - 小白零门槛部署 OpenClaw 私人 AI 助手的 Windows 桌面工具`
   - 选择 **Public**
   - 可选：勾选 **Add a README file**
4. 点击 **Create repository**

### 2. 本地初始化 Git 并推送

在项目根目录（`openclow`）打开终端，执行：

```bash
# 初始化 Git（若尚未初始化）
git init

# 添加 .gitignore（若没有）
# 确保 .gitignore 包含：node_modules/、target/、release/、dist/

# 添加所有文件
git add .

# 首次提交
git commit -m "feat: 初始版本 - OpenClaw 一键部署工具"

# 添加远程仓库（替换 YOUR_USERNAME 为你的 GitHub 用户名）
git remote add origin https://github.com/YOUR_USERNAME/openclaw-deploy.git

# 推送到 main 分支
git branch -M main
git push -u origin main
```

### 3. 创建发布（Release）

1. 在仓库页面点击 **Releases** → **Create a new release**
2. **Tag**：输入 `v0.1.0`，选择 **Create new tag**
3. **Release title**：`v0.1.0 - 首次发布`
4. **Description**：可写更新说明，例如：

   ```markdown
   ## 功能
   - 环境检测、一键安装 OpenClaw
   - 配置向导（AI 模型、API Key）
   - 一键启动 Gateway、打开对话界面
   - 渠道配置（Telegram、飞书、QQ）
   - 附带 Shell 安装脚本

   ## 下载
   - 安装包：NSIS (.exe) / MSI (.msi)
   - 绿色版：OpenClaw-Deploy-v0.1.0-Windows.zip
   ```

5. 上传文件：
   - 将 `release/` 文件夹中的 `.exe`、`.msi` 拖入
   - 或上传根目录的 `OpenClaw-Deploy-v0.1.0-Windows.zip`
6. 点击 **Publish release**

---

## 二、更新 README 中的链接

在 `README.md` 中，将 `YOUR_USERNAME` 替换为你的 GitHub 用户名：

- `https://github.com/YOUR_USERNAME/openclaw-deploy/releases`
- `git clone https://github.com/YOUR_USERNAME/openclaw-deploy.git`

---

## 三、后续更新

```bash
# 修改代码后
git add .
git commit -m "fix: 修复 xxx 问题"
git push

# 发布新版本时
# 1. 修改 package.json 和 src-tauri/tauri.conf.json 中的 version
# 2. 运行 npm run release 或 build-release.bat
# 3. 在 GitHub 创建新 Release，上传新的安装包和 zip
```

---

## 四、.gitignore 建议

确保项目根目录有 `.gitignore`，包含：

```
node_modules/
dist/
src-tauri/target/
release/
*.zip
.DS_Store
Thumbs.db
```
