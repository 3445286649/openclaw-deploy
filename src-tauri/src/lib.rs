use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::env;
use std::path::Path;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Emitter;
use regex::Regex;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;
const INTERACTIVE_ONBOARD_PS1: &str = include_str!("../scripts/openclaw-onboard.ps1");

#[cfg(target_os = "windows")]
fn hide_console_window(cmd: &mut Command) {
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn hide_console_window(_cmd: &mut Command) {}

#[derive(Debug, Serialize, Deserialize)]
pub struct EnvCheckResult {
    pub ok: bool,
    pub version: Option<String>,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct InstallResult {
    pub config_dir: String,
    pub install_dir: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SavedAiConfig {
    pub provider: String,
    pub base_url: Option<String>,
    pub proxy_url: Option<String>,
    pub no_proxy: Option<String>,
    pub has_api_key: bool,
    pub config_path: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LocalOpenclawInfo {
    pub installed: bool,
    pub install_dir: Option<String>,
    pub executable: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ExecutableCheckInfo {
    pub executable: Option<String>,
    pub exists: bool,
    pub source: String,
    pub detail: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RuntimeModelInfo {
    pub model: Option<String>,
    pub provider_api: Option<String>,
    pub base_url: Option<String>,
    pub key_prefix: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct KeySyncStatus {
    pub synced: bool,
    pub openclaw_json_key_prefix: Option<String>,
    pub env_key_prefix: Option<String>,
    pub auth_profile_key_prefix: Option<String>,
    pub detail: String,
}

#[tauri::command]
fn check_node() -> EnvCheckResult {
    let mut cmd = Command::new("node");
    hide_console_window(&mut cmd);
    let output = cmd.arg("--version").output();

    match output {
        Ok(out) => {
            let version = String::from_utf8_lossy(&out.stdout);
            let version = version.trim().to_string();
            let major: Option<u32> = version
                .trim_start_matches('v')
                .split('.')
                .next()
                .and_then(|s| s.parse().ok());
            let ok = major.map(|m| m >= 22).unwrap_or(false);
            let msg = if ok {
                format!("Node.js {} 已安装，版本符合要求 (>=22)", version)
            } else {
                format!("Node.js {} 版本过低，需要 >= 22。请访问 https://nodejs.org 下载安装", version)
            };
            EnvCheckResult {
                ok,
                version: Some(version),
                message: msg,
            }
        }
        Err(_) => EnvCheckResult {
            ok: false,
            version: None,
            message: "未检测到 Node.js，请先安装 Node.js 22+。下载地址: https://nodejs.org".to_string(),
        },
    }
}

fn find_npm_path() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        // 通过 node 获取其所在目录，npm.cmd 通常在同一目录
        let mut cmd = Command::new("node");
        hide_console_window(&mut cmd);
        let output = cmd
            .arg("-e")
            .arg("console.log(process.execPath)")
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let node_path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if node_path.is_empty() {
            return None;
        }
        let node_dir = std::path::Path::new(&node_path).parent()?;
        let npm_cmd = node_dir.join("npm.cmd");
        if npm_cmd.exists() {
            return Some(npm_cmd.to_string_lossy().to_string());
        }
        let npm_bat = node_dir.join("npm");
        if npm_bat.exists() {
            return Some(npm_bat.to_string_lossy().to_string());
        }
        None
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

fn run_npm_cmd(args: &[&str]) -> std::io::Result<std::process::Output> {
    #[cfg(target_os = "windows")]
    {
        let args_str: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        if let Some(npm_path) = find_npm_path() {
            let mut cmd = Command::new("cmd");
            hide_console_window(&mut cmd);
            cmd.args(["/c", &npm_path]);
            cmd.args(&args_str);
            return cmd.output();
        }
        let cmd_str = format!("npm {}", args.join(" "));
        let mut cmd = Command::new("cmd");
        hide_console_window(&mut cmd);
        cmd.args(["/c", &cmd_str]).output()
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut cmd = Command::new("npm");
        cmd.args(args);
        cmd.output()
    }
}

#[tauri::command]
fn check_npm() -> EnvCheckResult {
    let output = run_npm_cmd(&["--version"]);

    match output {
        Ok(out) => {
            let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if version.is_empty() {
                EnvCheckResult {
                    ok: false,
                    version: None,
                    message: "未检测到 npm，通常随 Node.js 一起安装".to_string(),
                }
            } else {
                let msg = format!("npm {} 已安装", version);
                EnvCheckResult {
                    ok: true,
                    version: Some(version),
                    message: msg,
                }
            }
        }
        Err(_) => EnvCheckResult {
            ok: false,
            version: None,
            message: "未检测到 npm，通常随 Node.js 一起安装".to_string(),
        },
    }
}

#[tauri::command]
fn check_openclaw(install_hint: Option<String>) -> EnvCheckResult {
    let hint = install_hint.as_deref().filter(|s| !s.trim().is_empty());
    let exe = find_openclaw_executable(hint).unwrap_or_else(|| "openclaw".to_string());
    let output = run_openclaw_cmd(&exe, &["--version"], None);

    match output {
        Ok(out) => {
            if !out.status.success() {
                return EnvCheckResult {
                    ok: false,
                    version: None,
                    message: "OpenClaw 未安装，点击「一键安装」进行安装".to_string(),
                };
            }
            let version = strip_ansi_text(&String::from_utf8_lossy(&out.stdout)).trim().to_string();
            let msg = format!("OpenClaw 已安装 ({})", if version.is_empty() { "已安装" } else { &version });
            EnvCheckResult {
                ok: true,
                version: Some(version),
                message: msg,
            }
        }
        Err(_) => EnvCheckResult {
            ok: false,
            version: None,
            message: "OpenClaw 未安装，点击「一键安装」进行安装".to_string(),
        },
    }
}

#[tauri::command]
fn install_openclaw(custom_prefix: Option<String>) -> Result<String, String> {
    let prefix = custom_prefix
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());
    let args: Vec<&str> = if let Some(p) = prefix {
        vec!["install", "-g", "openclaw", "--prefix", p]
    } else {
        vec!["install", "-g", "openclaw"]
    };
    let output = run_npm_cmd(&args).map_err(|e| format!("执行失败: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if output.status.success() {
        let msg = if prefix.is_some() {
            format!(
                "安装成功!\n请将安装目录的 bin 文件夹添加到系统 PATH 环境变量。\n{}",
                stdout
            )
        } else {
            format!("安装成功!\n{}", stdout)
        };
        Ok(msg)
    } else {
        Err(format!("安装失败:\n{}\n{}", stdout, stderr))
    }
}

#[cfg(target_os = "windows")]
fn add_path_to_user_env(path_to_add: &str) -> Result<(), String> {
    use winreg::RegKey;
    let path = path_to_add.trim().replace('/', "\\");
    if path.is_empty() {
        return Err("路径为空".to_string());
    }
    let hkcu = RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
    let (env_key, _) = hkcu
        .create_subkey("Environment")
        .map_err(|e| format!("无法打开注册表: {}", e))?;
    let current: String = env_key
        .get_value("Path")
        .unwrap_or_else(|_| String::new());
    let already = current.split(';').any(|s| s.trim().eq_ignore_ascii_case(&path));
    if already {
        return Ok(());
    }
    let new_path = if current.is_empty() || current.ends_with(';') {
        format!("{}{}", current, path)
    } else {
        format!("{};{}", current, path)
    };
    env_key
        .set_value("Path", &new_path)
        .map_err(|e| format!("无法写入 PATH: {}", e))?;
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn add_path_to_user_env(_path_to_add: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "windows")]
fn remove_path_from_user_env(path_to_remove: &str) -> Result<(), String> {
    use winreg::RegKey;
    let path = path_to_remove.trim().replace('/', "\\");
    let hkcu = RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
    let (env_key, _) = hkcu
        .create_subkey("Environment")
        .map_err(|e| format!("无法打开注册表: {}", e))?;
    let current: String = env_key.get_value("Path").unwrap_or_else(|_| String::new());
    let new_path = current
        .split(';')
        .filter(|s| !s.trim().is_empty())
        .filter(|s| !s.trim().eq_ignore_ascii_case(&path))
        .collect::<Vec<_>>()
        .join(";");
    env_key
        .set_value("Path", &new_path)
        .map_err(|e| format!("无法写入 PATH: {}", e))?;
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn remove_path_from_user_env(_path_to_remove: &str) -> Result<(), String> {
    Ok(())
}

fn run_npm_cmd_streaming(args: &[&str], app: &tauri::AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        let args_str: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        let mut child = if let Some(np) = find_npm_path() {
            let mut cmd = Command::new("cmd");
            hide_console_window(&mut cmd);
            cmd.args(["/c", &np]);
            cmd.args(&args_str);
            cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
            cmd.spawn()
        } else {
            let cmd_str = format!("npm {}", args.join(" "));
            let mut cmd = Command::new("cmd");
            hide_console_window(&mut cmd);
            cmd.args(["/c", &cmd_str]);
            cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
            cmd.spawn()
        }.map_err(|e| format!("启动失败: {}", e))?;
        let stdout = child.stdout.take().ok_or("无法获取 stdout")?;
        let stderr = child.stderr.take().ok_or("无法获取 stderr")?;
        let app_stdout = app.clone();
        let app_stderr = app.clone();
        let stdout_handle = std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                if let Ok(l) = line {
                    let _ = app_stdout.emit("install-output", l);
                }
            }
        });
        let stderr_handle = std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(l) = line {
                    let _ = app_stderr.emit("install-output", format!("[stderr] {}", l));
                }
            }
        });
        let _ = stdout_handle.join();
        let _ = stderr_handle.join();
        let status = child.wait().map_err(|e| format!("等待进程失败: {}", e))?;
        Ok(status.success())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let output = run_npm_cmd(args).map_err(|e| format!("{}", e))?;
        Ok(output.status.success())
    }
}

fn emit_install_step(app: &tauri::AppHandle, key: &str, status: &str, text: &str) {
    let _ = app.emit(
        "install-output",
        format!("__STEP__|{}|{}|{}", key, status, text),
    );
}

#[cfg(target_os = "windows")]
fn openclaw_binary_path_from_prefix(prefix: &str) -> String {
    format!("{}\\openclaw.cmd", prefix.trim().replace('/', "\\"))
}

#[cfg(not(target_os = "windows"))]
fn openclaw_binary_path_from_prefix(prefix: &str) -> String {
    format!("{}/openclaw", prefix.trim().replace('\\', "/"))
}

#[cfg(target_os = "windows")]
fn openclaw_core_file_path_from_prefix(prefix: &str) -> String {
    format!(
        "{}\\node_modules\\openclaw\\openclaw.mjs",
        prefix.trim().replace('/', "\\")
    )
}

#[cfg(not(target_os = "windows"))]
fn openclaw_core_file_path_from_prefix(prefix: &str) -> String {
    format!(
        "{}/node_modules/openclaw/openclaw.mjs",
        prefix.trim().replace('\\', "/")
    )
}

#[tauri::command]
fn install_openclaw_full(app: tauri::AppHandle, install_dir: String) -> Result<InstallResult, String> {
    let dir = install_dir.trim().replace('/', "\\");
    if dir.is_empty() {
        return Err("请选择安装目录".to_string());
    }
    emit_install_step(&app, "prepare_dir", "running", "准备安装目录");
    let path = Path::new(&dir);
    if !path.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {}", e))?;
    }
    emit_install_step(&app, "prepare_dir", "done", "安装目录已就绪");
    emit_install_step(&app, "npm_install", "running", "正在下载并安装 OpenClaw（耗时 10-60 秒）");
    let args = vec!["install", "-g", "openclaw", "--prefix", &dir];
    let success = run_npm_cmd_streaming(&args, &app).map_err(|e| format!("执行失败: {}", e))?;
    if !success {
        emit_install_step(&app, "npm_install", "error", "npm 安装失败");
        return Err("安装失败，请查看上方输出".to_string());
    }
    emit_install_step(&app, "npm_install", "done", "npm 安装完成");

    emit_install_step(&app, "verify_files", "running", "校验安装完整性");
    let exe_path = openclaw_binary_path_from_prefix(&dir);
    let core_path = openclaw_core_file_path_from_prefix(&dir);
    let mut files_ok = Path::new(&exe_path).exists() && Path::new(&core_path).exists();
    if !files_ok {
        // 半安装恢复：清理后重试一次
        let _ = app.emit(
            "install-output",
            "检测到安装不完整，正在自动重试安装一次..."
        );
        let retry_success = run_npm_cmd_streaming(&args, &app).map_err(|e| format!("执行失败: {}", e))?;
        if !retry_success {
            emit_install_step(&app, "verify_files", "error", "自动重试失败");
            return Err("安装重试失败，请检查网络并重试".to_string());
        }
        files_ok = Path::new(&exe_path).exists() && Path::new(&core_path).exists();
    }
    if !files_ok {
        emit_install_step(&app, "verify_files", "error", "安装产物不完整");
        return Err(format!(
            "安装不完整：缺少核心文件。\n请删除目录后重试：{}",
            dir
        ));
    }
    emit_install_step(&app, "verify_files", "done", "核心文件校验通过");

    emit_install_step(&app, "verify_cli", "running", "验证 openclaw 命令可执行");
    let version_output = run_openclaw_cmd(&exe_path, &["--version"], None)
        .map_err(|e| format!("验证失败: {}", e))?;
    if !version_output.status.success() {
        emit_install_step(&app, "verify_cli", "error", "命令验证失败");
        let out = String::from_utf8_lossy(&version_output.stdout);
        let err = String::from_utf8_lossy(&version_output.stderr);
        return Err(format!("安装后命令不可用：\n{}\n{}", out, err));
    }
    emit_install_step(&app, "verify_cli", "done", "命令验证通过");

    emit_install_step(&app, "write_path", "running", "写入系统 PATH");
    // Windows 下 npm --prefix 将可执行文件直接放在 prefix 根目录（非 node_modules/.bin）
    add_path_to_user_env(&dir).map_err(|e| format!("添加 PATH 失败: {}", e))?;
    emit_install_step(&app, "write_path", "done", "PATH 写入完成");

    emit_install_step(&app, "create_config", "running", "创建配置目录");
    let config_dir = format!("{}/.openclaw", dir.replace('\\', "/"));
    std::fs::create_dir_all(&config_dir).map_err(|e| format!("创建配置目录失败: {}", e))?;
    emit_install_step(&app, "create_config", "done", "配置目录创建完成");
    Ok(InstallResult {
        config_dir: config_dir.clone(),
        install_dir: dir,
    })
}

#[tauri::command]
fn recommended_install_dir() -> Result<String, String> {
    let home = env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    Ok(format!("{}/openclaw", home.replace('\\', "/")))
}

/// 查找 openclaw 可执行文件路径。优先使用配置路径推导的安装目录。
fn find_openclaw_executable(config_path: Option<&str>) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        // 1. 优先使用传入路径推导安装目录：
        // - 若为 X/.openclaw，安装目录是 X
        // - 若为普通目录，视为安装目录
        if let Some(cp) = config_path.filter(|s| !s.trim().is_empty()) {
            let p = Path::new(cp.trim());
            let install_dir = if p.file_name().and_then(|s| s.to_str()).map(|s| s == ".openclaw").unwrap_or(false) {
                p.parent().map(|x| x.to_path_buf())
            } else {
                Some(p.to_path_buf())
            };
            if let Some(dir) = install_dir {
                let exe = dir.join("openclaw.cmd");
                if exe.exists() {
                    return Some(exe.to_string_lossy().to_string());
                }
            }
        }
        // 2. 尝试 npm root -g：root 为 node_modules，可执行文件在 parent (prefix)
        if let Ok(out) = run_npm_cmd(&["root", "-g"]) {
            if out.status.success() {
                let root = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !root.is_empty() {
                    let prefix = Path::new(&root).parent();
                    if let Some(p) = prefix {
                        let exe = p.join("openclaw.cmd");
                        if exe.exists() {
                            return Some(exe.to_string_lossy().to_string());
                        }
                    }
                }
            }
        }
        // 3. 常见路径
        if let Ok(appdata) = env::var("APPDATA") {
            let exe = Path::new(&appdata).join("npm").join("openclaw.cmd");
            if exe.exists() {
                return Some(exe.to_string_lossy().to_string());
            }
        }
        if let Ok(pf) = env::var("ProgramFiles") {
            let exe = Path::new(&pf).join("nodejs").join("openclaw.cmd");
            if exe.exists() {
                return Some(exe.to_string_lossy().to_string());
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Some(cp) = config_path.filter(|s| !s.trim().is_empty()) {
            let p = Path::new(cp.trim());
            let install_dir = if p.file_name().and_then(|s| s.to_str()).map(|s| s == ".openclaw").unwrap_or(false) {
                p.parent().map(|x| x.to_path_buf())
            } else {
                Some(p.to_path_buf())
            };
            if let Some(dir) = install_dir {
                let exe = dir.join("openclaw");
                if exe.exists() {
                    return Some(exe.to_string_lossy().to_string());
                }
            }
        }
        if let Ok(out) = run_npm_cmd(&["root", "-g"]) {
            if out.status.success() {
                let root = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !root.is_empty() {
                    let prefix = Path::new(&root).parent();
                    if let Some(p) = prefix {
                        let exe = p.join("openclaw");
                        if exe.exists() {
                            return Some(exe.to_string_lossy().to_string());
                        }
                    }
                }
            }
        }
    }
    None
}

fn resolve_openclaw_dir(custom_path: Option<&str>) -> String {
    custom_path
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.replace('\\', "/"))
        .unwrap_or_else(|| {
            let home = env::var("HOME")
                .or_else(|_| env::var("USERPROFILE"))
                .unwrap_or_else(|_| ".".to_string());
            format!("{}/.openclaw", home.replace('\\', "/"))
        })
}

fn load_openclaw_config(openclaw_dir: &str) -> Result<Value, String> {
    let config_path = format!("{}/openclaw.json", openclaw_dir.replace('\\', "/"));
    if !Path::new(&config_path).exists() {
        return Ok(json!({}));
    }
    let txt = std::fs::read_to_string(&config_path).map_err(|e| format!("读取 openclaw.json 失败: {}", e))?;
    serde_json::from_str(&txt).map_err(|e| format!("解析 openclaw.json 失败: {}", e))
}

fn save_openclaw_config(openclaw_dir: &str, root: &Value) -> Result<(), String> {
    let config_path = format!("{}/openclaw.json", openclaw_dir.replace('\\', "/"));
    std::fs::write(
        &config_path,
        serde_json::to_string_pretty(root).map_err(|e| format!("序列化配置失败: {}", e))?,
    )
    .map_err(|e| format!("写入 openclaw.json 失败: {}", e))
}

fn ensure_gateway_mode_local(root: &mut Value) {
    if !root.is_object() {
        *root = json!({});
    }
    let obj = root.as_object_mut().expect("object");
    let gateway = obj.entry("gateway".to_string()).or_insert_with(|| json!({}));
    if !gateway.is_object() {
        *gateway = json!({});
    }
    let gobj = gateway.as_object_mut().expect("gateway object");
    gobj.entry("mode".to_string()).or_insert_with(|| json!("local"));
}

fn generate_gateway_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id() as u128;
    format!("{:032x}{:08x}", nanos, pid as u32)
}

fn ensure_telegram_open_requirements(ch_obj: &mut Map<String, Value>) {
    let dm_open = ch_obj
        .get("dmPolicy")
        .and_then(|v| v.as_str())
        .map(|s| s.eq_ignore_ascii_case("open"))
        .unwrap_or(false);
    if !dm_open {
        return;
    }

    let allow_from = ch_obj
        .entry("allowFrom".to_string())
        .or_insert_with(|| json!(["*"]));
    if !allow_from.is_array() {
        *allow_from = json!(["*"]);
        return;
    }
    let arr = allow_from.as_array_mut().expect("allowFrom array");
    let has_wildcard = arr.iter().any(|v| v.as_str().map(|s| s == "*").unwrap_or(false));
    if !has_wildcard {
        arr.push(json!("*"));
    }
}

fn normalize_openclaw_config_for_telegram(root: &mut Value) {
    if let Some(ch_obj) = root
        .as_object_mut()
        .and_then(|obj| obj.get_mut("channels"))
        .and_then(|v| v.as_object_mut())
        .and_then(|channels| channels.get_mut("telegram"))
        .and_then(|v| v.as_object_mut())
    {
        ch_obj.remove("chatId");
        ensure_telegram_open_requirements(ch_obj);
    }
}

fn normalize_openclaw_config_for_models(root: &mut Value) {
    if !root.is_object() {
        *root = json!({});
    }
    let obj = root.as_object_mut().expect("root object");
    let models = obj.entry("models".to_string()).or_insert_with(|| json!({}));
    if !models.is_object() {
        *models = json!({});
    }
    let providers = models
        .as_object_mut()
        .expect("models object")
        .entry("providers".to_string())
        .or_insert_with(|| json!({}));
    if !providers.is_object() {
        *providers = json!({});
    }
    let openai = providers
        .as_object_mut()
        .expect("providers object")
        .entry("openai".to_string())
        .or_insert_with(|| json!({}));
    if !openai.is_object() {
        *openai = json!({});
    }
    let openai_obj = openai.as_object_mut().expect("openai object");
    let base_url = openai_obj
        .entry("baseUrl".to_string())
        .or_insert_with(|| json!("https://api.openai.com/v1"));
    if !base_url.is_string() {
        *base_url = json!("https://api.openai.com/v1");
    }
    let base_url_text = openai_obj
        .get("baseUrl")
        .and_then(|v| v.as_str())
        .unwrap_or("https://api.openai.com/v1")
        .to_ascii_lowercase();
    let default_api = if base_url_text.contains("moonshot.cn")
        || base_url_text.contains("dashscope.aliyuncs.com")
    {
        "openai-completions"
    } else {
        "openai-responses"
    };
    let api = openai_obj
        .entry("api".to_string())
        .or_insert_with(|| json!(default_api));
    if !api.is_string() {
        *api = json!(default_api);
    }
    let models_arr = openai_obj
        .entry("models".to_string())
        .or_insert_with(|| json!([]));
    if !models_arr.is_array() {
        *models_arr = json!([]);
    }
}

fn preferred_primary_model_for_provider(provider: &str) -> &'static str {
    match provider {
        "kimi" | "moonshot" => "openai/moonshot-v1-32k",
        "qwen" | "bailian" | "dashscope" => "openai/qwen-plus",
        "deepseek" => "openai/deepseek-chat",
        "openai" => "openai/gpt-4o-mini",
        "anthropic" => "anthropic/claude-3-5-haiku-latest",
        _ => "openai/gpt-4o-mini",
    }
}

fn primary_prefix_for_provider(provider: &str) -> &'static str {
    match provider {
        "anthropic" => "anthropic",
        _ => "openai",
    }
}

fn normalize_primary_model(provider: &str, selected_model: Option<&str>) -> String {
    if let Some(raw) = selected_model.map(|s| s.trim()).filter(|s| !s.is_empty()) {
        if raw.contains('/') {
            return raw.to_string();
        }
        return format!("{}/{}", primary_prefix_for_provider(provider), raw);
    }
    preferred_primary_model_for_provider(provider).to_string()
}

fn infer_model_context_window(model: &str) -> Option<u32> {
    let s = model.trim().to_ascii_lowercase();
    if s.is_empty() {
        return None;
    }
    if s.contains("200k") {
        return Some(200_000);
    }
    if s.contains("128k") {
        return Some(128_000);
    }
    if s.contains("64k") {
        return Some(64_000);
    }
    if s.contains("32k") {
        return Some(32_000);
    }
    if s.contains("16k") {
        return Some(16_000);
    }
    if s.contains("8k") {
        return Some(8_192);
    }
    if s == "gpt-4" || s.ends_with("/gpt-4") {
        return Some(8_192);
    }
    if s.contains("gpt-4o") {
        return Some(128_000);
    }
    None
}

fn ensure_channel_in_openclaw_config(root: &mut Value, channel: &str, config: Value) {
    if !root.is_object() {
        *root = json!({});
    }
    let obj = root.as_object_mut().expect("object");

    let channels = obj.entry("channels".to_string()).or_insert_with(|| json!({}));
    if !channels.is_object() {
        *channels = json!({});
    }
    channels
        .as_object_mut()
        .expect("channels object")
        .insert(channel.to_string(), config);
    if channel == "telegram" {
        if let Some(ch_obj) = channels
            .as_object_mut()
            .and_then(|m| m.get_mut("telegram"))
            .and_then(|v| v.as_object_mut())
        {
            ch_obj.entry("enabled".to_string()).or_insert_with(|| json!(true));
            ch_obj.entry("dmPolicy".to_string()).or_insert_with(|| json!("open"));
            ch_obj.remove("chatId");
            ensure_telegram_open_requirements(ch_obj);
        }
    }

    let plugins = obj.entry("plugins".to_string()).or_insert_with(|| json!({}));
    if !plugins.is_object() {
        *plugins = json!({});
    }
    let p_obj = plugins.as_object_mut().expect("plugins object");
    let entries = p_obj.entry("entries".to_string()).or_insert_with(|| json!({}));
    if !entries.is_object() {
        *entries = json!({});
    }
    let e_obj = entries.as_object_mut().expect("entries object");
    let entry = e_obj
        .entry(channel.to_string())
        .or_insert_with(|| json!({ "enabled": true }));
    if !entry.is_object() {
        *entry = json!({ "enabled": true });
    } else {
        entry
            .as_object_mut()
            .expect("entry object")
            .insert("enabled".to_string(), json!(true));
    }
}

fn upsert_auth_profile_api_key(
    openclaw_dir: &str,
    provider: &str,
    key: &str,
) -> Result<(), String> {
    let agent_dir = format!("{}/agents/main/agent", openclaw_dir.replace('\\', "/"));
    std::fs::create_dir_all(&agent_dir).map_err(|e| format!("创建 agent 目录失败: {}", e))?;
    let auth_path = format!("{}/auth-profiles.json", agent_dir);

    let mut root: Value = if Path::new(&auth_path).exists() {
        let txt = std::fs::read_to_string(&auth_path).map_err(|e| format!("读取 auth-profiles 失败: {}", e))?;
        serde_json::from_str(&txt).unwrap_or_else(|_| json!({ "version": 1, "profiles": {} }))
    } else {
        json!({ "version": 1, "profiles": {} })
    };
    if !root.is_object() {
        root = json!({ "version": 1, "profiles": {} });
    }
    let obj = root.as_object_mut().expect("root object");
    if !obj.contains_key("version") {
        obj.insert("version".to_string(), json!(1));
    }
    let profiles = obj.entry("profiles".to_string()).or_insert_with(|| json!({}));
    if !profiles.is_object() {
        *profiles = json!({});
    }
    let profile_id = format!("{}:default", provider);
    profiles
        .as_object_mut()
        .expect("profiles object")
        .insert(
            profile_id,
            json!({
                "type": "api_key",
                "provider": provider,
                "key": key
            }),
        );

    std::fs::write(
        &auth_path,
        serde_json::to_string_pretty(&root).map_err(|e| format!("序列化 auth-profiles 失败: {}", e))?,
    )
    .map_err(|e| format!("写入 auth-profiles 失败: {}", e))
}

fn read_auth_profile_api_key(openclaw_dir: &str, provider: &str) -> Option<String> {
    let auth_path = format!(
        "{}/agents/main/agent/auth-profiles.json",
        openclaw_dir.replace('\\', "/")
    );
    let txt = std::fs::read_to_string(&auth_path).ok()?;
    let root: Value = serde_json::from_str(&txt).ok()?;
    let profiles = root.get("profiles")?.as_object()?;
    let profile_id = format!("{}:default", provider);
    profiles
        .get(&profile_id)
        .and_then(|v| v.get("key"))
        .and_then(|k| k.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn read_proxy_from_env(openclaw_dir: &str) -> (Option<String>, Option<String>) {
    let env_path = format!("{}/env", openclaw_dir.replace('\\', "/"));
    let txt = match std::fs::read_to_string(&env_path) {
        Ok(v) => v,
        Err(_) => return (None, None),
    };
    let mut proxy: Option<String> = None;
    let mut no_proxy: Option<String> = None;
    for raw in txt.lines() {
        let line = raw.trim();
        if let Some(v) = line
            .strip_prefix("export HTTPS_PROXY=")
            .or_else(|| line.strip_prefix("export HTTP_PROXY="))
        {
            let vv = v.trim().to_string();
            if !vv.is_empty() {
                proxy = Some(vv);
            }
        }
        if let Some(v) = line.strip_prefix("export NO_PROXY=") {
            let vv = v.trim().to_string();
            if !vv.is_empty() {
                no_proxy = Some(vv);
            }
        }
    }
    (proxy, no_proxy)
}

fn apply_proxy_env_to_cmd(cmd: &mut Command, openclaw_dir: &str) {
    let (proxy, no_proxy) = read_proxy_from_env(openclaw_dir);
    if let Some(p) = proxy {
        cmd.env("HTTPS_PROXY", &p);
        cmd.env("HTTP_PROXY", &p);
    }
    if let Some(n) = no_proxy {
        cmd.env("NO_PROXY", &n);
    }
}

fn mask_key_prefix(key: &str) -> Option<String> {
    let k = key.trim();
    if k.len() < 8 {
        return None;
    }
    let head = &k[..8];
    let tail = &k[k.len().saturating_sub(4)..];
    Some(format!("{}...{}", head, tail))
}

fn is_builtin_channel_for_openclaw(channel: &str) -> bool {
    matches!(
        channel,
        "telegram"
            | "whatsapp"
            | "discord"
            | "irc"
            | "googlechat"
            | "slack"
            | "signal"
            | "imessage"
            | "msteams"
    )
}

fn merge_legacy_channels_json(openclaw_dir: &str) -> Result<(), String> {
    let channels_path = format!("{}/channels.json", openclaw_dir.replace('\\', "/"));
    if !Path::new(&channels_path).exists() {
        return Ok(());
    }
    let txt = std::fs::read_to_string(&channels_path).map_err(|e| format!("读取 channels.json 失败: {}", e))?;
    let legacy: Value = serde_json::from_str(&txt).unwrap_or_else(|_| json!({}));
    if !legacy.is_object() {
        return Ok(());
    }

    let mut root = load_openclaw_config(openclaw_dir)?;
    for (k, v) in legacy.as_object().expect("legacy object") {
        if is_builtin_channel_for_openclaw(k) {
            ensure_channel_in_openclaw_config(&mut root, k, v.clone());
        }
    }
    ensure_gateway_mode_local(&mut root);
    normalize_openclaw_config_for_telegram(&mut root);
    normalize_openclaw_config_for_models(&mut root);
    save_openclaw_config(openclaw_dir, &root)
}

fn reset_agent_sessions_for_model_change(openclaw_dir: &str) -> Result<usize, String> {
    let sessions_dir = Path::new(openclaw_dir).join("agents").join("main").join("sessions");
    std::fs::create_dir_all(&sessions_dir).map_err(|e| format!("创建 sessions 目录失败: {}", e))?;
    let mut removed = 0usize;
    let entries = std::fs::read_dir(&sessions_dir).map_err(|e| format!("读取 sessions 目录失败: {}", e))?;
    for entry in entries {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else { continue };
        if name == "sessions.json" || name.ends_with(".lock") {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    let sessions_json_path = sessions_dir.join("sessions.json");
    let _ = std::fs::write(&sessions_json_path, "{}");
    Ok(removed)
}

#[tauri::command]
fn get_openclaw_dir(custom_path: Option<String>) -> String {
    resolve_openclaw_dir(custom_path.as_deref())
}

#[tauri::command]
fn write_env_config(
    api_key: Option<String>,
    provider: String,
    base_url: Option<String>,
    selected_model: Option<String>,
    reset_sessions: Option<bool>,
    proxy_url: Option<String>,
    no_proxy: Option<String>,
    custom_path: Option<String>,
) -> Result<String, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let base_url_for_content = base_url.clone();

    std::fs::create_dir_all(&openclaw_dir)
        .map_err(|e| format!("创建目录失败: {}", e))?;

    // 优先使用本次输入的 key；若为空则沿用已保存 key（便于只改模型/地址时无需重复输入）
    let provider_for_auth = match provider.as_str() {
        "kimi" | "qwen" | "openai" => "openai",
        "anthropic" => "anthropic",
        "deepseek" => "deepseek",
        "bailian" | "dashscope" => "dashscope",
        other => other,
    };
    let effective_api_key = api_key
        .as_deref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| read_auth_profile_api_key(&openclaw_dir, provider_for_auth))
        .ok_or("保存失败：未检测到可用 API Key。请至少输入一次有效 API Key 后再保存。".to_string())?;

    let proxy_block = {
        let mut s = String::new();
        if let Some(p) = proxy_url
            .as_deref()
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
        {
            s.push_str(&format!("export HTTPS_PROXY={}\n", p));
            s.push_str(&format!("export HTTP_PROXY={}\n", p));
        }
        if let Some(n) = no_proxy
            .as_deref()
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
        {
            s.push_str(&format!("export NO_PROXY={}\n", n));
        }
        s
    };

    let content = match provider.as_str() {
        "anthropic" => {
            let base = base_url_for_content.clone().map(|u| format!("export ANTHROPIC_BASE_URL={}\n", u)).unwrap_or_default();
            format!(
                "# OpenClaw 环境变量\n{}{}\nexport ANTHROPIC_API_KEY={}\n",
                proxy_block, base, effective_api_key
            )
        }
        "openai" => {
            let base = base_url_for_content.clone().map(|u| format!("export OPENAI_BASE_URL={}\n", u)).unwrap_or_default();
            format!(
                "# OpenClaw 环境变量\n{}{}\nexport OPENAI_API_KEY={}\n",
                proxy_block, base, effective_api_key
            )
        }
        "deepseek" => {
            format!(
                "# OpenClaw 环境变量\n{}export DEEPSEEK_API_KEY={}\n",
                proxy_block, effective_api_key
            )
        }
        "kimi" | "moonshot" => {
            let base = base_url_for_content.clone()
                .or_else(|| Some("https://api.moonshot.cn/v1".to_string()))
                .map(|u| format!("export OPENAI_BASE_URL={}\n", u))
                .unwrap_or_default();
            format!(
                "# OpenClaw 环境变量 (Kimi)\n{}{}\nexport OPENAI_API_KEY={}\n",
                proxy_block, base, effective_api_key
            )
        }
        "qwen" => {
            let base = base_url_for_content.clone()
                .or_else(|| Some("https://dashscope.aliyuncs.com/compatible-mode/v1".to_string()))
                .map(|u| format!("export OPENAI_BASE_URL={}\n", u))
                .unwrap_or_default();
            format!(
                "# OpenClaw 环境变量 (通义千问)\n{}{}\nexport OPENAI_API_KEY={}\n",
                proxy_block, base, effective_api_key
            )
        }
        "bailian" | "dashscope" => {
            format!(
                "# OpenClaw 环境变量 (阿里云百炼)\n{}export DASHSCOPE_API_KEY={}\n",
                proxy_block, effective_api_key
            )
        }
        _ => {
            format!(
                "# OpenClaw 环境变量\n{}export OPENAI_API_KEY={}\n",
                proxy_block, effective_api_key
            )
        }
    };

    let env_path = format!("{}/env", openclaw_dir);
    std::fs::write(&env_path, content).map_err(|e| format!("写入失败: {}", e))?;

    // 同步写入 auth-profiles，避免网关报 “No API key found for provider”
    upsert_auth_profile_api_key(&openclaw_dir, provider_for_auth, &effective_api_key)?;

    // 对 openai 兼容提供商写入 openclaw.json 的 provider baseUrl/key，提升兼容性
    if provider_for_auth == "openai" {
        let mut cfg = load_openclaw_config(&openclaw_dir)?;
        if !cfg.is_object() {
            cfg = json!({});
        }
        let root = cfg.as_object_mut().expect("config root");
        let models = root.entry("models".to_string()).or_insert_with(|| json!({}));
        if !models.is_object() {
            *models = json!({});
        }
        let providers = models
            .as_object_mut()
            .expect("models object")
            .entry("providers".to_string())
            .or_insert_with(|| json!({}));
        if !providers.is_object() {
            *providers = json!({});
        }
        let openai = providers
            .as_object_mut()
            .expect("providers object")
            .entry("openai".to_string())
            .or_insert_with(|| json!({}));
        if !openai.is_object() {
            *openai = json!({});
        }
        let openai_obj = openai.as_object_mut().expect("openai object");
        openai_obj.insert("apiKey".to_string(), json!(effective_api_key));
        let desired_api = match provider.as_str() {
            "kimi" | "moonshot" | "qwen" | "bailian" | "dashscope" => "openai-completions",
            _ => "openai-responses",
        };
        openai_obj.insert("api".to_string(), json!(desired_api));
        if let Some(u) = base_url.clone().filter(|s| !s.trim().is_empty()) {
            openai_obj.insert("baseUrl".to_string(), json!(u));
        } else {
            openai_obj
                .entry("baseUrl".to_string())
                .or_insert_with(|| json!("https://api.openai.com/v1"));
        }
        let models_arr = openai_obj
            .entry("models".to_string())
            .or_insert_with(|| json!([]));
        if !models_arr.is_array() {
            *models_arr = json!([]);
        }
        normalize_openclaw_config_for_models(&mut cfg);
        save_openclaw_config(&openclaw_dir, &cfg)?;
    }

    // 始终同步运行时主模型，避免“UI 已切换但运行时仍是旧模型”
    let mut cfg = load_openclaw_config(&openclaw_dir).unwrap_or_else(|_| json!({}));
    if !cfg.is_object() {
        cfg = json!({});
    }
    let root = cfg.as_object_mut().expect("config root");
    let agents = root.entry("agents".to_string()).or_insert_with(|| json!({}));
    if !agents.is_object() {
        *agents = json!({});
    }
    let defaults = agents
        .as_object_mut()
        .expect("agents object")
        .entry("defaults".to_string())
        .or_insert_with(|| json!({}));
    if !defaults.is_object() {
        *defaults = json!({});
    }
    let model_cfg = defaults
        .as_object_mut()
        .expect("defaults object")
        .entry("model".to_string())
        .or_insert_with(|| json!({}));
    if !model_cfg.is_object() {
        *model_cfg = json!({});
    }
    let final_primary_model = normalize_primary_model(provider.as_str(), selected_model.as_deref());
    if let Some(ctx) = infer_model_context_window(&final_primary_model) {
        if ctx < 16_000 {
            return Err(format!(
                "保存失败：所选模型 {} 上下文窗口仅 {} tokens，系统最低要求 16000。请改选 16k/32k/128k 模型。",
                final_primary_model, ctx
            ));
        }
    }
    model_cfg
        .as_object_mut()
        .expect("model object")
        .insert("primary".to_string(), json!(final_primary_model));
    save_openclaw_config(&openclaw_dir, &cfg)?;

    let mut note = String::new();
    if reset_sessions.unwrap_or(false) {
        if let Ok(removed) = reset_agent_sessions_for_model_change(&openclaw_dir) {
            note = format!("；检测到模型/凭证变更，已刷新会话快照 {} 个", removed);
        } else {
            note = "；检测到模型/凭证变更，已尝试刷新会话快照".to_string();
        }
    }

    Ok(format!(
        "配置已保存到 {}（API Key 已安全写入本地，不会在界面回显）{}",
        env_path, note
    ))
}

#[tauri::command]
fn discover_available_models(
    provider: String,
    base_url: Option<String>,
    api_key: Option<String>,
    custom_path: Option<String>,
) -> Result<Vec<String>, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let provider_for_auth = match provider.as_str() {
        "kimi" | "qwen" | "openai" => "openai",
        "anthropic" => "anthropic",
        "deepseek" => "deepseek",
        "bailian" | "dashscope" => "dashscope",
        _ => "openai",
    };
    let key = api_key
        .as_deref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| read_auth_profile_api_key(&openclaw_dir, provider_for_auth))
        .ok_or("未找到可用 API Key，请先输入或保存配置".to_string())?;

    let resolved_base = base_url
        .as_deref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| match provider.as_str() {
            "kimi" | "moonshot" => "https://api.moonshot.cn/v1".to_string(),
            "qwen" | "bailian" | "dashscope" => "https://dashscope.aliyuncs.com/compatible-mode/v1".to_string(),
            "deepseek" => "https://api.deepseek.com/v1".to_string(),
            _ => "https://api.openai.com/v1".to_string(),
        });

    #[cfg(target_os = "windows")]
    {
        let url = format!("{}/models", resolved_base.trim_end_matches('/'));
        let headers = if provider == "anthropic" {
            format!(
                r#"@{{"x-api-key"="{}";"anthropic-version"="2023-06-01";"Content-Type"="application/json"}}"#,
                key
            )
        } else {
            format!(r#"@{{"Authorization"="Bearer {}";"Content-Type"="application/json"}}"#, key)
        };
        let script = format!(
            "$h={}; try {{ $r=Invoke-WebRequest -UseBasicParsing -Method GET -Uri '{}' -Headers $h -TimeoutSec 20; Write-Output '__OK__'; Write-Output $r.Content }} catch {{ Write-Output '__ERR__'; Write-Output $_.Exception.Message; if ($_.ErrorDetails) {{ Write-Output $_.ErrorDetails.Message }} }}",
            headers, url
        );
        let mut cmd = Command::new("powershell");
        hide_console_window(&mut cmd);
        apply_proxy_env_to_cmd(&mut cmd, &openclaw_dir);
        let out = cmd.args(["-NoProfile", "-Command", &script]).output();
        let o = out.map_err(|e| format!("拉取模型列表失败: {}", e))?;
        let raw = format!(
            "{}\n{}",
            String::from_utf8_lossy(&o.stdout),
            String::from_utf8_lossy(&o.stderr)
        );
        let clean = strip_ansi_text(&raw);
        let t = clean.to_lowercase();
        if !t.contains("__ok__") {
            if t.contains("unauthorized") || t.contains("invalid_api_key") || t.contains("(401)") || t.contains("(403)") {
                return Err("拉取模型列表失败：API Key 无效或无权限（401/403）".to_string());
            }
            if t.contains("rate limit") || t.contains("too many requests") || t.contains("(429)") || t.contains("429") {
                return Err("拉取模型列表失败：触发限流（429），请稍后重试".to_string());
            }
            if t.contains("url.not_found") || t.contains("not found") || t.contains("(404)") || t.contains("404") {
                return Err("拉取模型列表失败：API 地址不正确（404）".to_string());
            }
            return Err("拉取模型列表失败：请检查 URL、Key 与网络".to_string());
        }

        let body_start = clean.find('{').ok_or("拉取模型列表失败：返回数据格式异常".to_string())?;
        let body = &clean[body_start..];
        let root: Value = serde_json::from_str(body).map_err(|_| "拉取模型列表失败：返回数据不是有效 JSON".to_string())?;
        let data = root
            .get("data")
            .and_then(|v| v.as_array())
            .ok_or("拉取模型列表失败：返回中缺少 data 数组".to_string())?;

        let mut all = BTreeSet::new();
        for item in data {
            if let Some(id) = item.get("id").and_then(|v| v.as_str()).map(|s| s.trim()).filter(|s| !s.is_empty()) {
                all.insert(id.to_string());
            }
        }
        if all.is_empty() {
            return Err("拉取模型列表失败：未找到可用模型".to_string());
        }

        let mut filtered: Vec<String> = all
            .iter()
            .filter(|id| {
                let s = id.to_ascii_lowercase();
                !(s.contains("embedding")
                    || s.contains("whisper")
                    || s.contains("tts")
                    || s.contains("moderation")
                    || s.contains("image")
                    || s.contains("rerank"))
            })
            .cloned()
            .collect();

        if filtered.is_empty() {
            filtered = all.into_iter().collect();
        }
        Ok(filtered)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (provider, resolved_base, key);
        Err("当前平台暂未实现自动拉取模型列表".to_string())
    }
}

#[tauri::command]
fn read_env_config(custom_path: Option<String>) -> Result<SavedAiConfig, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let env_path = format!("{}/env", openclaw_dir);
    if !Path::new(&env_path).exists() {
        return Ok(SavedAiConfig {
            provider: "anthropic".to_string(),
            base_url: None,
            proxy_url: None,
            no_proxy: None,
            has_api_key: false,
            config_path: env_path,
        });
    }

    let txt = std::fs::read_to_string(&env_path).map_err(|e| format!("读取失败: {}", e))?;
    let has_anthropic = txt.contains("ANTHROPIC_API_KEY=");
    let has_deepseek = txt.contains("DEEPSEEK_API_KEY=");
    let has_dashscope = txt.contains("DASHSCOPE_API_KEY=");
    let has_openai = txt.contains("OPENAI_API_KEY=");

    let provider = if has_anthropic {
        "anthropic"
    } else if has_deepseek {
        "deepseek"
    } else if has_dashscope {
        "bailian"
    } else if has_openai {
        if txt.contains("api.moonshot.cn") {
            "kimi"
        } else if txt.contains("dashscope.aliyuncs.com/compatible-mode") {
            "qwen"
        } else {
            "openai"
        }
    } else {
        "anthropic"
    };

    let mut base_url: Option<String> = None;
    let mut proxy_url: Option<String> = None;
    let mut no_proxy: Option<String> = None;
    for line in txt.lines() {
        if let Some(v) = line.strip_prefix("export OPENAI_BASE_URL=") {
            base_url = Some(v.trim().to_string());
        }
        if let Some(v) = line.strip_prefix("export ANTHROPIC_BASE_URL=") {
            base_url = Some(v.trim().to_string());
        }
        if let Some(v) = line
            .strip_prefix("export HTTPS_PROXY=")
            .or_else(|| line.strip_prefix("export HTTP_PROXY="))
        {
            proxy_url = Some(v.trim().to_string());
        }
        if let Some(v) = line.strip_prefix("export NO_PROXY=") {
            no_proxy = Some(v.trim().to_string());
        }
    }

    let has_api_key = txt.contains("_API_KEY=");
    Ok(SavedAiConfig {
        provider: provider.to_string(),
        base_url,
        proxy_url,
        no_proxy,
        has_api_key,
        config_path: env_path,
    })
}

fn run_openclaw_cmd(exe: &str, args: &[&str], env_extra: Option<(&str, &str)>) -> std::io::Result<std::process::Output> {
    #[cfg(target_os = "windows")]
    {
        if exe.to_ascii_lowercase().ends_with(".cmd") || exe.to_ascii_lowercase().ends_with(".bat") {
            let esc = |s: &str| s.replace('\'', "''");
            let joined_args = if args.is_empty() {
                String::new()
            } else {
                format!(
                    " {}",
                    args.iter()
                        .map(|a| format!("'{}'", esc(a)))
                        .collect::<Vec<String>>()
                        .join(" ")
                )
            };
            let script = format!("& '{}'{}", esc(exe), joined_args);
            let mut cmd = Command::new("powershell");
            hide_console_window(&mut cmd);
            cmd.args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &script,
            ]);
            if let Some((k, v)) = env_extra {
                cmd.env(k, v);
            }
            return cmd.output();
        }
        let mut cmd = Command::new(exe);
        hide_console_window(&mut cmd);
        cmd.args(args);
        if let Some((k, v)) = env_extra {
            cmd.env(k, v);
        }
        return cmd.output();
    }
    #[cfg(not(target_os = "windows"))]
    {
    let mut cmd = Command::new(exe);
    cmd.args(args);
    if let Some((k, v)) = env_extra {
        cmd.env(k, v);
    }
    cmd.output()
    }
}

#[tauri::command]
fn open_external_url(url: String) -> Result<String, String> {
    let u = url.trim();
    if u.is_empty() {
        return Err("URL 为空".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("rundll32");
        hide_console_window(&mut cmd);
        cmd.args(["url.dll,FileProtocolHandler", u]);
        if cmd.spawn().is_err() {
            let mut fallback = Command::new("explorer");
            hide_console_window(&mut fallback);
            fallback.arg(u);
            fallback
                .spawn()
                .map_err(|e| format!("打开链接失败: {}", e))?;
        }
        return Ok("已打开浏览器".to_string());
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(u)
            .spawn()
            .map_err(|e| format!("打开链接失败: {}", e))?;
        return Ok("已打开浏览器".to_string());
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(u)
            .spawn()
            .map_err(|e| format!("打开链接失败: {}", e))?;
        return Ok("已打开浏览器".to_string());
    }
}

fn strip_ansi_text(input: &str) -> String {
    // 去除常见 ANSI 转义序列，避免前端日志乱码
    let re = Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]").unwrap();
    re.replace_all(input, "").to_string()
}

fn run_openclaw_cmd_clean(exe: &str, args: &[&str], env_extra: Option<(&str, &str)>) -> Result<(bool, String, String), String> {
    let output = run_openclaw_cmd(exe, args, env_extra).map_err(|e| format!("执行失败: {}", e))?;
    let stdout = strip_ansi_text(&String::from_utf8_lossy(&output.stdout));
    let stderr = strip_ansi_text(&String::from_utf8_lossy(&output.stderr));
    Ok((output.status.success(), stdout, stderr))
}

#[tauri::command]
fn start_gateway(custom_path: Option<String>, install_hint: Option<String>) -> Result<String, String> {
    let mut config_dir = custom_path
        .as_deref()
        .map(|s| s.trim().replace('\\', "/"))
        .filter(|s| !s.is_empty());
    // 若用户保存了无效路径，自动回退到用户默认目录，避免“配了 token 但完全不生效”
    if let Some(dir) = &config_dir {
        let cpath = format!("{}/openclaw.json", dir);
        if !Path::new(&cpath).exists() {
            let fallback = resolve_openclaw_dir(None);
            let fpath = format!("{}/openclaw.json", fallback);
            if Path::new(&fpath).exists() {
                config_dir = Some(fallback);
            }
        }
    }
    if config_dir.is_none() {
        config_dir = Some(resolve_openclaw_dir(None));
    }

    let install_hint_norm = install_hint
        .as_deref()
        .map(|s| s.trim().replace('\\', "/"))
        .filter(|s| !s.is_empty());
    let config_path = config_dir.as_deref();
    let exe = find_openclaw_executable(install_hint_norm.as_deref().or(config_path))
        .unwrap_or_else(|| "openclaw".to_string());
    let state_dir = config_dir.clone();
    if let Some(dir) = state_dir.as_deref() {
        let _ = merge_legacy_channels_json(dir);
        if let Ok(mut root) = load_openclaw_config(dir) {
            ensure_gateway_mode_local(&mut root);
            normalize_openclaw_config_for_telegram(&mut root);
            normalize_openclaw_config_for_models(&mut root);
            let _ = save_openclaw_config(dir, &root);
        }
    }
    let env_extra = state_dir.as_ref().map(|s| ("OPENCLAW_STATE_DIR", s.as_str()));
    let (ok, stdout, stderr) = run_openclaw_cmd_clean(&exe, &["gateway", "start"], env_extra)?;
    if ok {
        return Ok(format!("Gateway 已启动\n{}", stdout));
    }

    let combined = format!("{}\n{}", stdout, stderr);
    let lower = combined.to_lowercase();
    if lower.contains("program not found")
        || lower.contains("not recognized as an internal or external command")
        || lower.contains("系统找不到指定的文件")
        || lower.contains("no such file or directory")
    {
        return Err(format!(
            "找不到 openclaw 可执行文件（program not found）。\n请在「安装 OpenClaw」里确认安装目录（例如 D 盘路径）并重新安装/保存。\n当前解析到的可执行路径：{}",
            exe
        ));
    }
    if combined.contains("MODULE_NOT_FOUND") || combined.contains("Cannot find module") {
        return Err("检测到 OpenClaw 安装不完整（缺少核心模块）。请返回「安装 OpenClaw」重新安装。".to_string());
    }
    let missing_service = combined.contains("Gateway service missing")
        || combined.contains("gateway install")
        || combined.contains("schtasks");

    if missing_service {
        let (install_ok, install_out, install_err) =
            run_openclaw_cmd_clean(&exe, &["gateway", "install"], env_extra)?;
        if !install_ok {
            return Err(format!(
                "检测到网关服务未安装，已尝试自动安装但失败。\n{}\n{}",
                install_out, install_err
            ));
        }

        let (start_ok2, stdout2, stderr2) = run_openclaw_cmd_clean(&exe, &["gateway", "start"], env_extra)?;
        if start_ok2 {
            return Ok(format!("Gateway 已自动安装并启动\n{}\n{}", install_out, stdout2));
        }
        return Err(format!(
            "网关服务已安装，但启动仍失败。\n{}\n{}",
            stdout2, stderr2
        ));
    }

    Err(format!("启动失败:\n{}\n{}", stdout, stderr))
}

#[tauri::command]
fn stop_gateway(custom_path: Option<String>, install_hint: Option<String>) -> Result<String, String> {
    let config_path = custom_path.as_deref().filter(|s| !s.trim().is_empty());
    let install_hint_norm = install_hint
        .as_deref()
        .map(|s| s.trim().replace('\\', "/"))
        .filter(|s| !s.is_empty());
    let exe = find_openclaw_executable(install_hint_norm.as_deref().or(config_path))
        .unwrap_or_else(|| "openclaw".to_string());
    let state_dir = config_path.map(|p| p.trim().replace('\\', "/"));
    let env_extra = state_dir.as_ref().map(|s| ("OPENCLAW_STATE_DIR", s.as_str()));
    let (ok, stdout, stderr) = run_openclaw_cmd_clean(&exe, &["gateway", "stop"], env_extra)?;
    if ok {
        Ok(format!("Gateway 已停止\n{}", stdout))
    } else {
        Err(format!("停止失败:\n{}\n{}", stdout, stderr))
    }
}

#[tauri::command]
fn fix_node() -> Result<String, String> {
    Ok("https://nodejs.org".to_string())
}

#[tauri::command]
fn fix_npm() -> Result<String, String> {
    // 尝试通过 cmd 运行 npm（Windows 下通常能正确解析 PATH）
    let output = run_npm_cmd(&["--version"]);
    match output {
        Ok(out) if out.status.success() => {
            let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !version.is_empty() {
                return Ok("npm 已可用，请点击「重新检测」验证".to_string());
            }
        }
        _ => {}
    }

    // 尝试常见 Node.js 安装路径
    #[cfg(target_os = "windows")]
    {
        let program_files = env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".to_string());
        let node_paths = [
            format!("{}\\nodejs\\npm.cmd", program_files),
            "C:\\Program Files\\nodejs\\npm.cmd".to_string(),
            format!("{}\\nodejs\\npm.cmd", env::var("ProgramFiles(x86)").unwrap_or_default()),
        ];

        for path in &node_paths {
            if std::path::Path::new(path).exists() {
                let mut cmd = Command::new("cmd");
                hide_console_window(&mut cmd);
                let output = cmd.args(["/c", path, "--version"]).output();
                if let Ok(out) = output {
                    if out.status.success() {
                        return Ok("已找到 npm，请点击「重新检测」验证".to_string());
                    }
                }
            }
        }
    }

    Err("无法自动修复 npm。请尝试：\n1. 重新安装 Node.js（选择 LTS 版本）\n2. 安装时勾选「Add to PATH」\n3. 重启电脑后再试".to_string())
}

#[tauri::command]
fn fix_openclaw() -> Result<String, String> {
    install_openclaw(None)
}

#[tauri::command]
fn gateway_status(custom_path: Option<String>, install_hint: Option<String>) -> Result<String, String> {
    let config_path = custom_path.as_deref().filter(|s| !s.trim().is_empty());
    let install_hint_norm = install_hint
        .as_deref()
        .map(|s| s.trim().replace('\\', "/"))
        .filter(|s| !s.is_empty());
    let exe = find_openclaw_executable(install_hint_norm.as_deref().or(config_path))
        .unwrap_or_else(|| "openclaw".to_string());
    let state_dir = config_path.map(|p| p.trim().replace('\\', "/"));
    let env_extra = state_dir.as_ref().map(|s| ("OPENCLAW_STATE_DIR", s.as_str()));
    let (_, stdout, stderr) = run_openclaw_cmd_clean(&exe, &["gateway", "status"], env_extra)?;
    Ok(format!("{}\n{}", stdout, stderr))
}

#[tauri::command]
fn run_onboard(custom_path: Option<String>) -> Result<String, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    Ok(format!(
        "已切换为图形化渠道配置，无需打开黑色终端窗口。\n请在本页的 Telegram / 飞书 / QQ 卡片中填写并测试。\n当前配置目录：{}",
        openclaw_dir
    ))
}

#[tauri::command]
fn run_onboard_cli(custom_path: Option<String>, install_hint: Option<String>) -> Result<String, String> {
    let config_dir = custom_path
        .as_deref()
        .map(|s| s.trim().replace('\\', "/"))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| resolve_openclaw_dir(None));
    let install_hint_norm = install_hint
        .as_deref()
        .map(|s| s.trim().replace('\\', "/"))
        .filter(|s| !s.is_empty());
    let exe = find_openclaw_executable(install_hint_norm.as_deref().or(Some(config_dir.as_str())))
        .unwrap_or_else(|| "openclaw".to_string());
    let (ok_check, _stdout_check, stderr_check) = run_openclaw_cmd_clean(&exe, &["--version"], None)?;
    if !ok_check {
        return Err(format!(
            "未找到可用的 OpenClaw 可执行文件，请先完成安装。{}",
            stderr_check
        ));
    }

    #[cfg(target_os = "windows")]
    {
        let cmdline = format!(
            "set OPENCLAW_STATE_DIR={} && \"{}\" onboard",
            config_dir.replace('/', "\\"),
            exe.replace('/', "\\")
        );
        let mut cmd = Command::new("cmd");
        // 这里故意不隐藏窗口：用户明确要求打开经典终端界面
        cmd.args(["/c", "start", "", "cmd", "/k", &cmdline]);
        cmd.output().map_err(|e| format!("打开经典终端失败: {}", e))?;
        return Ok("已打开经典终端配置界面（CLI）。".to_string());
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (config_dir, exe);
        Err("当前平台暂未实现打开经典终端配置界面".to_string())
    }
}

#[tauri::command]
fn run_interactive_shell_onboard(custom_path: Option<String>, install_hint: Option<String>) -> Result<String, String> {
    let config_dir = custom_path
        .as_deref()
        .map(|s| s.trim().replace('\\', "/"))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| resolve_openclaw_dir(None));
    let install_hint_norm = install_hint
        .as_deref()
        .map(|s| s.trim().replace('\\', "/"))
        .filter(|s| !s.is_empty());
    let exe = find_openclaw_executable(install_hint_norm.as_deref().or(Some(config_dir.as_str())))
        .unwrap_or_else(|| "openclaw".to_string());
    let (ok_check, _stdout_check, stderr_check) = run_openclaw_cmd_clean(&exe, &["--version"], None)?;
    if !ok_check {
        return Err(format!(
            "未找到可用的 OpenClaw 可执行文件，请先完成安装。{}",
            stderr_check
        ));
    }

    #[cfg(target_os = "windows")]
    {
        let script_path = env::temp_dir().join("openclaw-onboard-interactive.ps1");
        std::fs::write(&script_path, INTERACTIVE_ONBOARD_PS1)
            .map_err(|e| format!("写入脚本失败: {}", e))?;

        let script_path_s = script_path.to_string_lossy().to_string().replace('/', "\\");
        let config_dir_win = config_dir.replace('/', "\\");
        let exe_win = exe.replace('/', "\\");
        let hint_win = install_hint_norm.unwrap_or_default().replace('/', "\\");

        let mut cmd = Command::new("cmd");
        // 这里故意不隐藏窗口：交互式脚本需要用户可见输入
        cmd.args([
            "/c",
            "start",
            "",
            "powershell",
            "-NoLogo",
            "-NoExit",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ]);
        cmd.arg(&script_path_s);
        cmd.args(["-OpenclawStateDir", &config_dir_win, "-OpenclawExe", &exe_win]);
        if !hint_win.trim().is_empty() {
            cmd.args(["-InstallHint", &hint_win]);
        }
        cmd.output().map_err(|e| format!("打开交互式脚本失败: {}", e))?;
        return Ok("已打开交互式 Shell 脚本（环境检测 / 模型 / Key / 渠道 / 一键启动）。".to_string());
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (config_dir, exe, install_hint_norm);
        Err("当前平台暂未实现打开交互式 Shell 脚本".to_string())
    }
}

#[tauri::command]
fn get_local_openclaw(
    install_hint: Option<String>,
    custom_path: Option<String>,
) -> Result<LocalOpenclawInfo, String> {
    let hint = install_hint
        .as_deref()
        .or(custom_path.as_deref())
        .filter(|s| !s.trim().is_empty());
    let exe = find_openclaw_executable(hint);
    if exe.is_none() {
        return Ok(LocalOpenclawInfo {
            installed: false,
            install_dir: None,
            executable: None,
            version: None,
        });
    }

    let exe_path = exe.unwrap_or_default();
    let install_dir = Path::new(&exe_path)
        .parent()
        .map(|p| p.to_string_lossy().to_string());
    let (ok, stdout, _) = run_openclaw_cmd_clean(&exe_path, &["--version"], None)?;
    Ok(LocalOpenclawInfo {
        installed: ok,
        install_dir,
        executable: Some(exe_path),
        version: if ok { Some(stdout.trim().to_string()) } else { None },
    })
}

#[tauri::command]
fn check_openclaw_executable(custom_path: Option<String>, install_hint: Option<String>) -> Result<ExecutableCheckInfo, String> {
    let install_hint_norm = install_hint
        .as_deref()
        .map(|s| s.trim().replace('\\', "/"))
        .filter(|s| !s.is_empty());
    let custom_norm = custom_path
        .as_deref()
        .map(|s| s.trim().replace('\\', "/"))
        .filter(|s| !s.is_empty());
    let search_hint = install_hint_norm
        .as_deref()
        .or(custom_norm.as_deref());
    let exe = find_openclaw_executable(search_hint);
    let exists = exe
        .as_deref()
        .map(|p| Path::new(p).exists())
        .unwrap_or(false);
    let source = if install_hint_norm.is_some() {
        "install_hint"
    } else if custom_norm.is_some() {
        "custom_path"
    } else {
        "auto_search"
    };
    let detail = if exists {
        "已找到可执行文件".to_string()
    } else {
        "未找到可执行文件，请检查安装目录或重新安装".to_string()
    };
    Ok(ExecutableCheckInfo {
        executable: exe,
        exists,
        source: source.to_string(),
        detail,
    })
}

#[tauri::command]
fn uninstall_openclaw(install_dir: String) -> Result<String, String> {
    let dir = install_dir.trim().replace('/', "\\");
    if dir.is_empty() {
        return Err("请先提供安装目录".to_string());
    }
    let args = vec!["uninstall", "-g", "openclaw", "--prefix", &dir];
    let out = run_npm_cmd(&args).map_err(|e| format!("执行失败: {}", e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("卸载失败：{}", stderr));
    }

    // 清理可执行壳文件
    let bin_cmd = Path::new(&dir).join("openclaw.cmd");
    let bin_ps1 = Path::new(&dir).join("openclaw.ps1");
    let bin_noext = Path::new(&dir).join("openclaw");
    let _ = std::fs::remove_file(bin_cmd);
    let _ = std::fs::remove_file(bin_ps1);
    let _ = std::fs::remove_file(bin_noext);
    let _ = remove_path_from_user_env(&dir);
    Ok(format!("OpenClaw 已卸载：{}", dir))
}

#[tauri::command]
fn save_channel_config(
    channel: String,
    config: Value,
    custom_path: Option<String>,
) -> Result<String, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    std::fs::create_dir_all(&openclaw_dir).map_err(|e| format!("创建配置目录失败: {}", e))?;
    let config_path = format!("{}/channels.json", openclaw_dir);

    let mut effective_config = config;
    if channel == "telegram" && effective_config.is_object() {
        let cobj = effective_config.as_object_mut().expect("telegram config object");
        cobj.entry("enabled".to_string()).or_insert_with(|| json!(true));
        cobj.entry("dmPolicy".to_string()).or_insert_with(|| json!("open"));
        ensure_telegram_open_requirements(cobj);
    }

    let mut root: Value = if Path::new(&config_path).exists() {
        let txt = std::fs::read_to_string(&config_path).map_err(|e| format!("读取配置失败: {}", e))?;
        serde_json::from_str(&txt).unwrap_or_else(|_| Value::Object(Map::new()))
    } else {
        Value::Object(Map::new())
    };

    if !root.is_object() {
        root = Value::Object(Map::new());
    }
    let obj = root.as_object_mut().ok_or("配置格式错误")?;
    obj.insert(channel.clone(), effective_config.clone());
    std::fs::write(
        &config_path,
        serde_json::to_string_pretty(&root).map_err(|e| format!("序列化失败: {}", e))?,
    )
    .map_err(|e| format!("写入配置失败: {}", e))?;
    // 同步写入 OpenClaw 真正读取的 openclaw.json（仅内置渠道）
    if is_builtin_channel_for_openclaw(&channel) {
        let mut openclaw_root = load_openclaw_config(&openclaw_dir)?;
        ensure_channel_in_openclaw_config(&mut openclaw_root, &channel, effective_config);
        ensure_gateway_mode_local(&mut openclaw_root);
        save_openclaw_config(&openclaw_dir, &openclaw_root)?;
        Ok(format!("{} 渠道配置已保存并已同步到 openclaw.json：{}", channel, openclaw_dir))
    } else {
        let tip = if channel == "qq" || channel == "feishu" {
            "该渠道在当前 OpenClaw 版本不是内置通道，可能出现“机器人离线/去火星”类提示；建议优先使用 Telegram 或接入自定义插件。"
        } else {
            "当前 OpenClaw 版本非内置渠道。"
        };
        Ok(format!(
            "{} 渠道配置已保存到 channels.json：{}。{}",
            channel, openclaw_dir, tip
        ))
    }
}

#[tauri::command]
fn read_channel_config(channel: String, custom_path: Option<String>) -> Result<Value, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let channels_path = format!("{}/channels.json", openclaw_dir.replace('\\', "/"));
    if Path::new(&channels_path).exists() {
        let txt = std::fs::read_to_string(&channels_path)
            .map_err(|e| format!("读取 channels.json 失败: {}", e))?;
        if let Ok(root) = serde_json::from_str::<Value>(&txt) {
            if let Some(v) = root
                .as_object()
                .and_then(|obj| obj.get(&channel))
                .cloned()
            {
                return Ok(v);
            }
        }
    }

    let root = load_openclaw_config(&openclaw_dir).unwrap_or_else(|_| json!({}));
    let fallback = root
        .as_object()
        .and_then(|obj| obj.get("channels"))
        .and_then(|chs| chs.as_object())
        .and_then(|chs| chs.get(&channel))
        .cloned()
        .unwrap_or_else(|| json!({}));
    Ok(fallback)
}

#[tauri::command]
fn test_model_connection(
    provider: String,
    base_url: Option<String>,
    api_key: Option<String>,
    custom_path: Option<String>,
) -> Result<String, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let provider_for_auth = match provider.as_str() {
        "kimi" | "qwen" | "openai" => "openai",
        "anthropic" => "anthropic",
        "deepseek" => "deepseek",
        "bailian" | "dashscope" => "dashscope",
        _ => "openai",
    };
    let key = api_key
        .as_deref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| read_auth_profile_api_key(&openclaw_dir, provider_for_auth))
        .ok_or("未找到可用 API Key，请先保存配置或输入 API Key 后重试".to_string())?;

    let resolved_base = base_url
        .as_deref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| match provider.as_str() {
            "kimi" | "moonshot" => "https://api.moonshot.cn/v1".to_string(),
            "qwen" => "https://dashscope.aliyuncs.com/compatible-mode/v1".to_string(),
            "deepseek" => "https://api.deepseek.com/v1".to_string(),
            "anthropic" => "https://api.anthropic.com".to_string(),
            _ => "https://api.openai.com/v1".to_string(),
        });

    #[cfg(target_os = "windows")]
    {
        let (url, body, headers) = if provider == "anthropic" {
            (
                format!("{}/v1/messages", resolved_base.trim_end_matches('/')),
                r#"{"model":"claude-3-5-haiku-latest","max_tokens":8,"messages":[{"role":"user","content":"ping"}]}"#.to_string(),
                format!(r#"@{{"x-api-key"="{}";"anthropic-version"="2023-06-01";"Content-Type"="application/json"}}"#, key),
            )
        } else {
            let probe_model = match provider.as_str() {
                "kimi" | "moonshot" => "moonshot-v1-32k",
                "qwen" | "bailian" | "dashscope" => "qwen-plus",
                "deepseek" => "deepseek-chat",
                "openai" => "gpt-4o-mini",
                _ => "gpt-4o-mini",
            };
            (
                format!("{}/chat/completions", resolved_base.trim_end_matches('/')),
                json!({
                    "model": probe_model,
                    "messages": [{"role":"user","content":"ping"}],
                    "max_tokens": 8
                }).to_string(),
                format!(r#"@{{"Authorization"="Bearer {}";"Content-Type"="application/json"}}"#, key),
            )
        };
        let script = format!(
            "$h={}; $b='{}'; try {{ $r=Invoke-WebRequest -UseBasicParsing -Method POST -Uri '{}' -Headers $h -Body $b -TimeoutSec 20; Write-Output '__OK__'; Write-Output $r.Content }} catch {{ Write-Output '__ERR__'; Write-Output $_.Exception.Message; if ($_.ErrorDetails) {{ Write-Output $_.ErrorDetails.Message }} }}",
            headers,
            body.replace('\'', "''"),
            url
        );
        let mut final_t = String::new();
        for attempt in 0..3 {
            let mut cmd = Command::new("powershell");
            hide_console_window(&mut cmd);
            apply_proxy_env_to_cmd(&mut cmd, &openclaw_dir);
            let out = cmd.args(["-NoProfile", "-Command", &script]).output();
            let o = out.map_err(|e| format!("执行失败: {}", e))?;
            let text = format!(
                "{}\n{}",
                String::from_utf8_lossy(&o.stdout),
                String::from_utf8_lossy(&o.stderr)
            );
            final_t = strip_ansi_text(&text).to_lowercase();
            let is_rate_limited = final_t.contains("rate limit")
                || final_t.contains("too many requests")
                || final_t.contains("(429)")
                || final_t.contains("429");
            if !is_rate_limited || attempt == 2 {
                break;
            }
            let wait_sec = 1_u64 << attempt; // 1s, 2s, 4s
            thread::sleep(Duration::from_secs(wait_sec));
        }
        let t = final_t;
        if t.contains("__ok__") {
            return Ok("模型连通性检测通过".to_string());
        }
        if t.contains("url.not_found") || t.contains("(404)") || t.contains("404") {
            return Err("模型连通性检测失败：接口路径错误（url.not_found/404），请检查该提供商是否支持当前 API 协议".to_string());
        }
        if t.contains("insufficient balance")
            || t.contains("exceeded_current_quota")
            || t.contains("(429)")
            || t.contains("too many requests")
            || t.contains("rate limit")
        {
            return Err("模型连通性检测失败：账户余额不足或额度受限（429），已自动重试 3 次".to_string());
        }
        if t.contains("unauthorized")
            || t.contains("invalid_api_key")
            || t.contains("(401)")
            || t.contains("(403)")
        {
            return Err("模型连通性检测失败：API Key 无效或无权限（401/403）".to_string());
        }
        if t.contains("timed out") || t.contains("name or service not known") || t.contains("unable to connect") {
            return Err("模型连通性检测失败：网络不可达或超时".to_string());
        }
        return Err("模型连通性检测失败：请检查 API 地址、Key 与提供商配置".to_string());
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (provider, resolved_base, key);
        Err("当前平台暂未实现一键模型连通性检测".to_string())
    }
}

#[tauri::command]
fn probe_runtime_model_connection(custom_path: Option<String>) -> Result<String, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let root = load_openclaw_config(&openclaw_dir).unwrap_or_else(|_| json!({}));

    let model_full = root
        .as_object()
        .and_then(|obj| obj.get("agents"))
        .and_then(|v| v.as_object())
        .and_then(|v| v.get("defaults"))
        .and_then(|v| v.as_object())
        .and_then(|v| v.get("model"))
        .and_then(|v| {
            if v.is_string() {
                v.as_str().map(|s| s.to_string())
            } else {
                v.as_object()
                    .and_then(|o| o.get("primary"))
                    .and_then(|p| p.as_str())
                    .map(|s| s.to_string())
            }
        })
        .unwrap_or_else(|| "openai/gpt-4o-mini".to_string());

    let (provider_hint, model_name) = if let Some((p, m)) = model_full.split_once('/') {
        (p.to_string(), m.to_string())
    } else {
        ("openai".to_string(), model_full.clone())
    };

    let providers_obj = root
        .as_object()
        .and_then(|obj| obj.get("models"))
        .and_then(|v| v.as_object())
        .and_then(|v| v.get("providers"))
        .and_then(|v| v.as_object());

    let provider_obj = providers_obj
        .and_then(|p| p.get(&provider_hint))
        .and_then(|v| v.as_object())
        .or_else(|| providers_obj.and_then(|p| p.get("openai")).and_then(|v| v.as_object()));

    let api_mode = provider_obj
        .and_then(|p| p.get("api"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "openai-completions".to_string());

    let base_url = provider_obj
        .and_then(|p| p.get("baseUrl"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| match provider_hint.as_str() {
            "anthropic" => "https://api.anthropic.com".to_string(),
            "deepseek" => "https://api.deepseek.com/v1".to_string(),
            _ => "https://api.openai.com/v1".to_string(),
        });

    let key_from_provider = provider_obj
        .and_then(|p| p.get("apiKey"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let auth_provider = match provider_hint.as_str() {
        "openai" | "kimi" | "moonshot" | "qwen" | "bailian" | "dashscope" => "openai",
        "anthropic" => "anthropic",
        "deepseek" => "deepseek",
        _ => "openai",
    };
    let key_from_auth = read_auth_profile_api_key(&openclaw_dir, auth_provider);

    if let (Some(a), Some(b)) = (key_from_provider.as_deref(), key_from_auth.as_deref()) {
        if a != b {
            let p1 = mask_key_prefix(a).unwrap_or_else(|| "(隐藏)".to_string());
            let p2 = mask_key_prefix(b).unwrap_or_else(|| "(隐藏)".to_string());
            return Err(format!(
                "运行时探活失败[config_mismatch]：openclaw.json 与 auth-profiles.json 的 Key 不一致（{} vs {}）。请重新保存配置后重试。",
                p1, p2
            ));
        }
    }

    let key = key_from_provider
        .or(key_from_auth)
        .ok_or("运行时探活失败[config_mismatch]：未找到当前生效 API Key，请先保存配置".to_string())?;
    let key_prefix = mask_key_prefix(&key).unwrap_or_else(|| "(隐藏)".to_string());
    let base_lower = base_url.to_ascii_lowercase();
    let model_lower = model_name.to_ascii_lowercase();
    if base_lower.contains("moonshot.cn") && !model_lower.contains("moonshot") {
        return Err(format!(
            "运行时探活失败[model_mismatch]：当前地址是 Kimi，但生效模型不是 moonshot。模型={}，地址={}",
            model_full, base_url
        ));
    }
    if base_lower.contains("dashscope.aliyuncs.com") && !model_lower.contains("qwen") {
        return Err(format!(
            "运行时探活失败[model_mismatch]：当前地址是千问/百炼，但生效模型不是 qwen。模型={}，地址={}",
            model_full, base_url
        ));
    }

    #[cfg(target_os = "windows")]
    {
        let base = base_url.trim_end_matches('/');
        let (url, body, headers) = if provider_hint == "anthropic" {
            (
                format!("{}/v1/messages", base),
                json!({
                    "model": model_name,
                    "max_tokens": 8,
                    "messages": [{"role":"user","content":"ping"}]
                })
                .to_string(),
                format!(
                    r#"@{{"x-api-key"="{}";"anthropic-version"="2023-06-01";"Content-Type"="application/json"}}"#,
                    key
                ),
            )
        } else if api_mode == "openai-responses" {
            (
                format!("{}/responses", base),
                json!({
                    "model": model_name,
                    "input": "ping",
                    "max_output_tokens": 8
                })
                .to_string(),
                format!(r#"@{{"Authorization"="Bearer {}";"Content-Type"="application/json"}}"#, key),
            )
        } else {
            (
                format!("{}/chat/completions", base),
                json!({
                    "model": model_name,
                    "messages": [{"role":"user","content":"ping"}],
                    "max_tokens": 8
                })
                .to_string(),
                format!(r#"@{{"Authorization"="Bearer {}";"Content-Type"="application/json"}}"#, key),
            )
        };

        let script = format!(
            "$h={}; $b='{}'; try {{ $r=Invoke-WebRequest -UseBasicParsing -Method POST -Uri '{}' -Headers $h -Body $b -TimeoutSec 20; Write-Output '__OK__'; Write-Output $r.Content }} catch {{ Write-Output '__ERR__'; Write-Output $_.Exception.Message; if ($_.ErrorDetails) {{ Write-Output $_.ErrorDetails.Message }} }}",
            headers,
            body.replace('\'', "''"),
            url
        );
        let mut final_t = String::new();
        for attempt in 0..3 {
            let mut cmd = Command::new("powershell");
            hide_console_window(&mut cmd);
            apply_proxy_env_to_cmd(&mut cmd, &openclaw_dir);
            let out = cmd.args(["-NoProfile", "-Command", &script]).output();
            let o = out.map_err(|e| format!("运行时探活失败[unknown]：执行失败: {}", e))?;
            let text = format!(
                "{}\n{}",
                String::from_utf8_lossy(&o.stdout),
                String::from_utf8_lossy(&o.stderr)
            );
            final_t = strip_ansi_text(&text).to_lowercase();
            let is_rate_limited = final_t.contains("rate limit")
                || final_t.contains("too many requests")
                || final_t.contains("(429)")
                || final_t.contains("429");
            if !is_rate_limited || attempt == 2 {
                break;
            }
            let wait_sec = 1_u64 << attempt; // 1s, 2s, 4s
            thread::sleep(Duration::from_secs(wait_sec));
        }
        let t = final_t;
        if t.contains("__ok__") {
            return Ok(format!(
                "启动自动探活通过：模型={}，协议={}，地址={}，Key前缀={}",
                model_full, api_mode, base_url, key_prefix
            ));
        }
        if t.contains("unauthorized")
            || t.contains("invalid_api_key")
            || t.contains("(401)")
            || t.contains("(403)")
        {
            return Err(format!(
                "运行时探活失败[key_invalid]：API Key 无效或无权限（401/403）。模型={}，地址={}，Key前缀={}",
                model_full, base_url, key_prefix
            ));
        }
        if t.contains("model_not_found")
            || t.contains("invalid model")
            || t.contains("model does not exist")
            || t.contains("unsupported model")
        {
            return Err(format!(
                "运行时探活失败[model_mismatch]：模型名与当前提供商不匹配。模型={}，协议={}，地址={}",
                model_full, api_mode, base_url
            ));
        }
        if t.contains("url.not_found")
            || t.contains("not found")
            || t.contains("(404)")
            || t.contains("404")
        {
            return Err(format!(
                "运行时探活失败[api_mismatch]：接口协议或地址不匹配（404）。模型={}，协议={}，地址={}",
                model_full, api_mode, base_url
            ));
        }
        if t.contains("timed out")
            || t.contains("name or service not known")
            || t.contains("unable to connect")
        {
            return Err(format!(
                "运行时探活失败[network]：网络不可达或超时。地址={}",
                base_url
            ));
        }
        if t.contains("rate limit") || t.contains("too many requests") || t.contains("(429)") || t.contains("429") {
            return Err(format!(
                "运行时探活失败[rate_limited]：API 触发限流（429），已自动重试 3 次。模型={}，地址={}",
                model_full, base_url
            ));
        }
        Err(format!(
            "运行时探活失败[unknown]：请检查配置。模型={}，协议={}，地址={}，Key前缀={}",
            model_full, api_mode, base_url, key_prefix
        ))
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (model_full, api_mode, base_url, key_prefix);
        Err("当前平台暂未实现运行时自动探活".to_string())
    }
}

#[tauri::command]
fn get_gateway_auth_token(custom_path: Option<String>) -> Result<String, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let mut root = load_openclaw_config(&openclaw_dir).unwrap_or_else(|_| json!({}));
    if !root.is_object() {
        root = json!({});
    }
    ensure_gateway_mode_local(&mut root);
    let obj = root.as_object_mut().expect("config object");
    let gateway = obj.entry("gateway".to_string()).or_insert_with(|| json!({}));
    if !gateway.is_object() {
        *gateway = json!({});
    }
    let gw_obj = gateway.as_object_mut().expect("gateway object");
    let auth = gw_obj.entry("auth".to_string()).or_insert_with(|| json!({}));
    if !auth.is_object() {
        *auth = json!({});
    }
    let auth_obj = auth.as_object_mut().expect("auth object");
    auth_obj.entry("mode".to_string()).or_insert_with(|| json!("token"));
    let token = auth_obj
        .get("token")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(generate_gateway_token);
    auth_obj.insert("token".to_string(), json!(token.clone()));
    let _ = save_openclaw_config(&openclaw_dir, &root);
    Ok(token)
}

#[tauri::command]
fn read_runtime_model_info(custom_path: Option<String>) -> Result<RuntimeModelInfo, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let root = load_openclaw_config(&openclaw_dir).unwrap_or_else(|_| json!({}));
    let model = root
        .as_object()
        .and_then(|obj| obj.get("agents"))
        .and_then(|v| v.as_object())
        .and_then(|v| v.get("defaults"))
        .and_then(|v| v.as_object())
        .and_then(|v| v.get("model"))
        .and_then(|v| {
            if v.is_string() {
                v.as_str().map(|s| s.to_string())
            } else {
                v.as_object()
                    .and_then(|o| o.get("primary"))
                    .and_then(|p| p.as_str())
                    .map(|s| s.to_string())
            }
        });
    let provider = root
        .as_object()
        .and_then(|obj| obj.get("models"))
        .and_then(|v| v.as_object())
        .and_then(|v| v.get("providers"))
        .and_then(|v| v.as_object())
        .and_then(|v| v.get("openai"))
        .and_then(|v| v.as_object());
    let provider_api = provider
        .and_then(|p| p.get("api"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let base_url = provider
        .and_then(|p| p.get("baseUrl"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let key_raw = provider
        .and_then(|p| p.get("apiKey"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| read_auth_profile_api_key(&openclaw_dir, "openai"));
    let key_prefix = key_raw.as_deref().and_then(mask_key_prefix);
    Ok(RuntimeModelInfo {
        model,
        provider_api,
        base_url,
        key_prefix,
    })
}

#[tauri::command]
fn read_key_sync_status(custom_path: Option<String>) -> Result<KeySyncStatus, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let root = load_openclaw_config(&openclaw_dir).unwrap_or_else(|_| json!({}));
    let openclaw_key = root
        .as_object()
        .and_then(|obj| obj.get("models"))
        .and_then(|v| v.as_object())
        .and_then(|v| v.get("providers"))
        .and_then(|v| v.as_object())
        .and_then(|v| v.get("openai"))
        .and_then(|v| v.as_object())
        .and_then(|v| v.get("apiKey"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let env_path = format!("{}/env", openclaw_dir.replace('\\', "/"));
    let env_key = std::fs::read_to_string(&env_path)
        .ok()
        .and_then(|txt| {
            txt.lines().find_map(|line| {
                line.trim()
                    .strip_prefix("export OPENAI_API_KEY=")
                    .map(|v| v.trim().to_string())
            })
        })
        .filter(|s| !s.is_empty());

    let auth_key = read_auth_profile_api_key(&openclaw_dir, "openai");

    let non_empty_values: Vec<&str> = [openclaw_key.as_deref(), env_key.as_deref(), auth_key.as_deref()]
        .into_iter()
        .flatten()
        .collect();
    let synced = !non_empty_values.is_empty()
        && non_empty_values.len() == 3
        && non_empty_values.windows(2).all(|w| w[0] == w[1]);

    let detail = if synced {
        "Key 已在 openclaw.json / env / auth-profiles 三处同步".to_string()
    } else {
        "Key 未完全同步：请在当前页面重新输入 API Key 并点击“保存配置”".to_string()
    };

    Ok(KeySyncStatus {
        synced,
        openclaw_json_key_prefix: openclaw_key.as_deref().and_then(mask_key_prefix),
        env_key_prefix: env_key.as_deref().and_then(mask_key_prefix),
        auth_profile_key_prefix: auth_key.as_deref().and_then(mask_key_prefix),
        detail,
    })
}

#[tauri::command]
fn test_channel_connection(channel: String, config: Value) -> Result<String, String> {
    if (channel == "qq" || channel == "feishu") && !is_builtin_channel_for_openclaw(&channel) {
        return Err(format!(
            "{} 连通性测试提示：当前 OpenClaw 版本非内置该渠道，平台可能提示机器人离线（例如“去火星”）。如需稳定对话，建议使用 Telegram 或安装对应插件。",
            channel
        ));
    }
    let obj = config.as_object().ok_or("配置格式错误，需为对象")?;
    let required_ok = match channel.as_str() {
        "telegram" => obj.get("botToken").and_then(|v| v.as_str()).map(|s| !s.trim().is_empty()).unwrap_or(false),
        "feishu" => {
            let app_id = obj.get("appId").and_then(|v| v.as_str()).map(|s| !s.trim().is_empty()).unwrap_or(false);
            let app_secret = obj.get("appSecret").and_then(|v| v.as_str()).map(|s| !s.trim().is_empty()).unwrap_or(false);
            app_id && app_secret
        }
        "qq" => {
            let app_id = obj.get("appId").and_then(|v| v.as_str()).map(|s| !s.trim().is_empty()).unwrap_or(false);
            let token = obj.get("token").and_then(|v| v.as_str()).map(|s| !s.trim().is_empty()).unwrap_or(false);
            app_id && token
        }
        _ => false,
    };

    if !required_ok {
        return Err(format!("{} 渠道缺少必填字段，请检查后重试", channel));
    }
    // Telegram 做一次真实连通性测试（getMe）
    if channel == "telegram" {
        let token = obj
            .get("botToken")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .unwrap_or("");
        if token.is_empty() {
            return Err("telegram botToken 为空".to_string());
        }
        #[cfg(target_os = "windows")]
        {
            let url = format!("https://api.telegram.org/bot{}/getMe", token);
            let mut cmd = Command::new("powershell");
            hide_console_window(&mut cmd);
            let script = format!(
                "$r=Invoke-WebRequest -UseBasicParsing -Uri '{}' -Method GET -TimeoutSec 10; $r.Content",
                url
            );
            let out = cmd.args(["-NoProfile", "-Command", &script]).output();
            if let Ok(o) = out {
                let body = String::from_utf8_lossy(&o.stdout).to_string();
                if body.contains("\"ok\":true") {
                    return Ok("telegram 连通性测试通过（已成功调用 getMe）".to_string());
                }
            }
            return Err("telegram 连通性测试失败，请检查 botToken 或网络".to_string());
        }
    }
    Ok(format!("{} 连通性基础测试通过（必填项与格式已校验）", channel))
}

#[tauri::command]
fn list_pairings(channel: String, custom_path: Option<String>) -> Result<String, String> {
    let cfg = custom_path
        .as_deref()
        .map(|s| s.trim().replace('\\', "/"))
        .filter(|s| !s.is_empty());
    let exe = find_openclaw_executable(cfg.as_deref()).unwrap_or_else(|| "openclaw".to_string());
    if let Some(dir) = cfg.as_deref() {
        if let Ok(mut root) = load_openclaw_config(dir) {
            normalize_openclaw_config_for_telegram(&mut root);
            normalize_openclaw_config_for_models(&mut root);
            let _ = save_openclaw_config(dir, &root);
        }
    }
    let env_extra = cfg.as_ref().map(|s| ("OPENCLAW_STATE_DIR", s.as_str()));
    let (ok, stdout, stderr) =
        run_openclaw_cmd_clean(&exe, &["pairing", "list", channel.as_str()], env_extra)?;
    if ok {
        Ok(stdout)
    } else {
        Err(format!("查询配对失败:\n{}\n{}", stdout, stderr))
    }
}

#[tauri::command]
fn approve_pairing(
    channel: String,
    code: String,
    custom_path: Option<String>,
) -> Result<String, String> {
    let c = code.trim();
    if c.is_empty() {
        return Err("请先输入配对码".to_string());
    }
    let cfg = custom_path
        .as_deref()
        .map(|s| s.trim().replace('\\', "/"))
        .filter(|s| !s.is_empty());
    let exe = find_openclaw_executable(cfg.as_deref()).unwrap_or_else(|| "openclaw".to_string());
    if let Some(dir) = cfg.as_deref() {
        if let Ok(mut root) = load_openclaw_config(dir) {
            normalize_openclaw_config_for_telegram(&mut root);
            normalize_openclaw_config_for_models(&mut root);
            let _ = save_openclaw_config(dir, &root);
        }
    }
    let env_extra = cfg.as_ref().map(|s| ("OPENCLAW_STATE_DIR", s.as_str()));
    let (ok, stdout, stderr) = run_openclaw_cmd_clean(
        &exe,
        &["pairing", "approve", channel.as_str(), c],
        env_extra,
    )?;
    if ok {
        Ok(format!("配对成功\n{}", stdout))
    } else {
        Err(format!("配对失败:\n{}\n{}", stdout, stderr))
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            check_node,
            check_npm,
            check_openclaw,
            install_openclaw,
            install_openclaw_full,
            recommended_install_dir,
            get_openclaw_dir,
            write_env_config,
            discover_available_models,
            read_env_config,
            test_model_connection,
            probe_runtime_model_connection,
            start_gateway,
            stop_gateway,
            gateway_status,
            run_onboard,
            run_onboard_cli,
            run_interactive_shell_onboard,
            get_local_openclaw,
            check_openclaw_executable,
            uninstall_openclaw,
            save_channel_config,
            read_channel_config,
            get_gateway_auth_token,
            read_runtime_model_info,
            read_key_sync_status,
            test_channel_connection,
            list_pairings,
            approve_pairing,
            open_external_url,
            fix_node,
            fix_npm,
            fix_openclaw,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
