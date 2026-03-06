use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;
#[cfg(target_os = "windows")]
use encoding_rs::GBK;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::env;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};
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

#[cfg(not(target_os = "windows"))]
fn find_npm_path_fallback() -> Option<String> {
    None
}

#[cfg(not(target_os = "windows"))]
fn env_with_node_path() -> Vec<(String, String)> {
    Vec::new()
}

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

#[derive(Debug, Serialize, Deserialize)]
pub struct SelfCheckItem {
    pub key: String,
    pub label: String,
    pub status: String,
    pub detail: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SkillMissing {
    pub bins: Vec<String>,
    pub any_bins: Vec<String>,
    pub env: Vec<String>,
    pub config: Vec<String>,
    pub os: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SkillCatalogItem {
    pub name: String,
    pub description: String,
    pub source: String,
    pub bundled: bool,
    pub eligible: bool,
    pub missing: SkillMissing,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StartupMigrationResult {
    pub fixed_count: usize,
    pub fixed_dirs: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MemoryCenterStatus {
    pub enabled: bool,
    pub memory_file_exists: bool,
    pub memory_dir_exists: bool,
    pub memory_file_count: usize,
    pub note: String,
}

#[derive(Debug, Deserialize)]
struct SkillsListResp {
    skills: Vec<SkillRawItem>,
}

#[derive(Debug, Deserialize, Default)]
struct SkillRawMissing {
    #[serde(default)]
    bins: Vec<String>,
    #[serde(default, rename = "anyBins")]
    any_bins: Vec<String>,
    #[serde(default)]
    env: Vec<String>,
    #[serde(default)]
    config: Vec<String>,
    #[serde(default)]
    os: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct SkillRawItem {
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    source: String,
    #[serde(default)]
    bundled: bool,
    #[serde(default)]
    eligible: bool,
    #[serde(default)]
    missing: SkillRawMissing,
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

/// 当 node 不在 PATH 时，尝试从常见安装路径查找 npm（快捷方式/资源管理器启动时 PATH 可能不完整）
#[cfg(target_os = "windows")]
fn find_npm_path_fallback() -> Option<String> {
    let program_files = env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".to_string());
    let program_files_x86 = env::var("ProgramFiles(x86)").unwrap_or_else(|_| "C:\\Program Files (x86)".to_string());
    let appdata = env::var("APPDATA").unwrap_or_default();
    let candidates = [
        format!("{}\\nodejs\\npm.cmd", program_files.trim().replace('/', "\\")),
        "C:\\Program Files\\nodejs\\npm.cmd".to_string(),
        format!("{}\\nodejs\\npm.cmd", program_files_x86.trim().replace('/', "\\")),
        format!("{}\\npm\\npm.cmd", appdata.trim().replace('/', "\\")),
    ];
    for p in &candidates {
        if Path::new(p).exists() {
            return Some(p.clone());
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn env_with_node_path() -> Vec<(String, String)> {
    let mut extra = Vec::new();
    let program_files = env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".to_string());
    let appdata = env::var("APPDATA").unwrap_or_default();
    let program_files_x86 = env::var("ProgramFiles(x86)").unwrap_or_else(|_| "C:\\Program Files (x86)".to_string());
    let node_paths = [
        format!("{}\\nodejs", program_files.trim().replace('/', "\\")),
        format!("{}\\npm", appdata.trim().replace('/', "\\")),
        format!("{}\\nodejs", program_files_x86.trim().replace('/', "\\")),
    ];
    let current_path = env::var("Path").unwrap_or_default();
    let existing: std::collections::HashSet<String> = current_path
        .split(';')
        .map(|s| s.trim().trim_end_matches('\\').to_lowercase())
        .collect();
    let mut prepend: Vec<String> = node_paths
        .iter()
        .filter(|p| Path::new(p).exists())
        .filter(|p| !existing.contains(p.to_lowercase().trim_end_matches('\\')))
        .map(|s| s.clone())
        .collect();
    if !prepend.is_empty() {
        prepend.push(current_path);
        extra.push(("Path".to_string(), prepend.join(";")));
    }
    extra
}

fn run_npm_cmd(args: &[&str]) -> std::io::Result<std::process::Output> {
    #[cfg(target_os = "windows")]
    {
        let args_str: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        let npm_path = find_npm_path().or_else(find_npm_path_fallback);
        if let Some(np) = npm_path {
            let mut cmd = Command::new("cmd");
            hide_console_window(&mut cmd);
            cmd.args(["/c", &np]);
            cmd.args(&args_str);
            for (k, v) in env_with_node_path() {
                cmd.env(k, v);
            }
            return cmd.output();
        }
        let cmd_str = format!("npm {}", args.join(" "));
        let mut cmd = Command::new("cmd");
        hide_console_window(&mut cmd);
        for (k, v) in env_with_node_path() {
            cmd.env(k, v);
        }
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
fn check_git() -> EnvCheckResult {
    let mut cmd = Command::new("git");
    hide_console_window(&mut cmd);
    let output = cmd.arg("--version").output();

    match output {
        Ok(out) if out.status.success() => {
            let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let msg = if version.is_empty() {
                "Git 已安装".to_string()
            } else {
                format!("{} 已安装", version)
            };
            EnvCheckResult {
                ok: true,
                version: Some(version),
                message: msg,
            }
        }
        _ => EnvCheckResult {
            ok: false,
            version: None,
            message: "未检测到 Git。npm 安装 OpenClaw 时可能需要 Git，若出现 spawn git 错误请先安装: https://git-scm.com/download/win".to_string(),
        },
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
    let mut output = run_openclaw_cmd(&exe, &["--version"], None);

    // openclaw.cmd 在部分环境下会报「系统找不到指定路径」，改用 node 直接运行 mjs 兜底
    if let Ok(ref out) = output {
        if !out.status.success() {
            if let Some(install_dir) = Path::new(&exe).parent() {
                let core_mjs = install_dir.join("node_modules").join("openclaw").join("openclaw.mjs");
                if core_mjs.exists() {
                    let mut node_cmd = Command::new("node");
                    #[cfg(target_os = "windows")]
                    hide_console_window(&mut node_cmd);
                    node_cmd.arg(&core_mjs).arg("--version");
                    node_cmd.current_dir(install_dir);
                    if let Ok(node_out) = node_cmd.output() {
                        if node_out.status.success() {
                            output = Ok(node_out);
                        }
                    }
                }
            }
        }
    }

    match output {
        Ok(out) => {
            if !out.status.success() {
                return EnvCheckResult {
                    ok: false,
                    version: None,
                    message: "OpenClaw 未安装，点击「一键安装」进行安装".to_string(),
                };
            }
            let version = strip_ansi_text(&decode_console_output(&out.stdout)).trim().to_string();
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

#[derive(serde::Serialize)]
struct NpmPathCheckResult {
    in_path: bool,
    path: String,
}

#[tauri::command]
fn check_npm_path_in_user_env() -> Result<NpmPathCheckResult, String> {
    #[cfg(target_os = "windows")]
    {
        use winreg::RegKey;
        let appdata = env::var("APPDATA").map_err(|_| "无法获取 APPDATA".to_string())?;
        let npm_path = format!("{}\\npm", appdata.trim().replace('/', "\\"));
        let hkcu = RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
        let env_key = hkcu
            .open_subkey("Environment")
            .map_err(|e| format!("无法打开注册表: {}", e))?;
        let current: String = env_key.get_value("Path").unwrap_or_else(|_| String::new());
        let in_path = current
            .split(';')
            .any(|s: &str| s.trim().eq_ignore_ascii_case(&npm_path));
        Ok(NpmPathCheckResult {
            in_path,
            path: npm_path.clone(),
        })
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(NpmPathCheckResult {
            in_path: true,
            path: String::new(),
        })
    }
}

#[tauri::command]
fn add_npm_to_path() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let appdata = env::var("APPDATA").map_err(|_| "无法获取 APPDATA".to_string())?;
        let npm_path = format!("{}\\npm", appdata.trim().replace('/', "\\"));
        add_path_to_user_env(&npm_path)?;
        Ok(format!(
            "已成功将 {} 添加到用户 PATH。请关闭并重新打开 CMD/PowerShell 后生效。",
            npm_path
        ))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok("当前系统无需此操作".to_string())
    }
}

fn run_npm_cmd_streaming(args: &[&str], app: &tauri::AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        let args_str: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        let npm_path = find_npm_path().or_else(find_npm_path_fallback);
        let cmd_str = format!("npm {}", args.join(" "));
        let mut cmd = Command::new("cmd");
        hide_console_window(&mut cmd);
        for (k, v) in env_with_node_path() {
            cmd.env(k, v);
        }
        if let Some(np) = npm_path {
            cmd.args(["/c", &np]);
            cmd.args(&args_str);
        } else {
            cmd.args(["/c", &cmd_str]);
        }
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| format!("启动失败: {}", e))?;
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

    // 安装前检测 Node/npm：快捷方式启动时 PATH 可能不完整，先检测再调用 npm
    let npm_ok = run_npm_cmd(&["--version"]).map(|o| o.status.success()).unwrap_or(false);
    if !npm_ok {
        emit_install_step(&app, "npm_install", "error", "未检测到 Node.js/npm");
        return Err("未检测到 Node.js 或 npm。请先安装 Node.js 22+：https://nodejs.org\n\n若已安装，请从「开始菜单」或「环境检测」页面重新打开本应用。".to_string());
    }

    // 检测 Git：npm 安装 openclaw 时部分依赖可能需要 Git
    let has_git = Command::new("git").arg("--version").output().map(|o| o.status.success()).unwrap_or(false);
    if !has_git {
        let _ = app.emit("install-output", "[提示] 未检测到 Git，若安装失败并提示 spawn git，请先安装: https://git-scm.com/download/win");
    }
    emit_install_step(&app, "npm_install", "running", "正在下载并安装 OpenClaw（耗时 10-60 秒）");
    let args = vec!["install", "-g", "openclaw", "--prefix", &dir];
    let success = run_npm_cmd_streaming(&args, &app).map_err(|e| format!("执行失败: {}", e))?;
    if !success {
        emit_install_step(&app, "npm_install", "error", "npm 安装失败");
        let hint = if !has_git {
            "\n\n若错误含 spawn git，请先安装 Git: https://git-scm.com/download/win"
        } else {
            ""
        };
        return Err(format!("安装失败，请查看上方输出。{}", hint));
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
            let hint = if !has_git {
                " 若错误含 spawn git，请先安装 Git: https://git-scm.com/download/win"
            } else {
                ""
            };
            return Err(format!("安装重试失败，请检查网络并重试。{}", hint));
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
    let mut version_output = run_openclaw_cmd(&exe_path, &["--version"], None)
        .map_err(|e| format!("验证失败: {}", e))?;
    // openclaw.cmd 在部分环境下会报「系统找不到指定路径」，改用 node 直接运行 mjs 验证
    if !version_output.status.success() {
        let mut node_cmd = Command::new("node");
        hide_console_window(&mut node_cmd);
        node_cmd.arg(&core_path).arg("--version");
        node_cmd.current_dir(&dir);
        if let Ok(out) = node_cmd.output() {
            if out.status.success() {
                version_output = out;
            }
        }
    }
    if !version_output.status.success() {
        emit_install_step(&app, "verify_cli", "error", "命令验证失败");
        let out = decode_console_output(&version_output.stdout);
        let err = decode_console_output(&version_output.stderr);
        return Err(format!(
            "安装文件已写入 {}，但命令执行失败（openclaw.cmd 或 node 运行异常）。\n\n{}\n{}\n\n建议：用脚本选择「自定义目录」安装到 D:\\openclow，或检查 Node.js 是否正常。",
            dir, out, err
        ));
    }
    emit_install_step(&app, "verify_cli", "done", "命令验证通过");

    emit_install_step(&app, "write_path", "running", "写入系统 PATH");
    // Windows 下 npm --prefix 将可执行文件直接放在 prefix 根目录（非 node_modules/.bin）
    add_path_to_user_env(&dir).map_err(|e| format!("添加 PATH 失败: {}", e))?;
    emit_install_step(&app, "write_path", "done", "PATH 写入完成");

    emit_install_step(&app, "create_config", "running", "创建配置目录");
    let config_dir = format!("{}/.openclaw", dir.replace('\\', "/"));
    std::fs::create_dir_all(&config_dir).map_err(|e| format!("创建配置目录失败: {}", e))?;
    // OpenClaw 2026+ 要求 gateway.mode，否则 Gateway 拒绝启动
    let openclaw_json_path = format!("{}/openclaw.json", config_dir);
    let minimal_config = r#"{"gateway":{"mode":"local"}}"#;
    let _ = std::fs::write(&openclaw_json_path, minimal_config);
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

/// Windows: 从注册表读取用户 PATH（桌面应用启动时进程可能未加载最新 PATH）
#[cfg(target_os = "windows")]
fn get_user_path_from_registry() -> Vec<String> {
    use winreg::RegKey;
    let hkcu = RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
    let env_key = match hkcu.open_subkey("Environment") {
        Ok(k) => k,
        Err(_) => return vec![],
    };
    let path_val: String = env_key.get_value("Path").unwrap_or_default();
    path_val
        .split(';')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

#[cfg(not(target_os = "windows"))]
fn get_user_path_from_registry() -> Vec<String> {
    vec![]
}

/// 查找 openclaw 可执行文件路径。
/// 始终优先扫描 PATH 和固定路径，不依赖 install_hint（热迁移后可能过期）。
fn find_openclaw_executable(config_path: Option<&str>) -> Option<String> {
    // 优先使用显式路径（安装目录或配置目录），避免被 PATH 中旧版本劫持
    if let Some(cp) = config_path.filter(|s| !s.trim().is_empty()) {
        let p = Path::new(cp.trim());
        #[cfg(target_os = "windows")]
        {
            if p.is_file() && p.to_string_lossy().to_lowercase().ends_with("openclaw.cmd") {
                return Some(p.to_string_lossy().to_string());
            }
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
        #[cfg(not(target_os = "windows"))]
        {
            if p.is_file() && p.to_string_lossy().ends_with("/openclaw") {
                return Some(p.to_string_lossy().to_string());
            }
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
    }

    #[cfg(target_os = "windows")]
    {
        let mut seen = std::collections::HashSet::new();
        let mut scan_path = |entry: &str| {
            let entry = entry.trim();
            if entry.is_empty() || seen.contains(entry) {
                return None;
            }
            seen.insert(entry.to_string());
            let exe = Path::new(entry).join("openclaw.cmd");
            if exe.exists() {
                Some(exe.to_string_lossy().to_string())
            } else {
                None
            }
        };
        // 1. 注册表用户 PATH（脚本/安装写入后，进程可能未刷新）
        for entry in get_user_path_from_registry() {
            if let Some(exe) = scan_path(&entry) {
                return Some(exe);
            }
        }
        // 2. 当前进程 PATH
        if let Ok(path_env) = env::var("PATH") {
            for entry in path_env.split(';') {
                if let Some(exe) = scan_path(entry) {
                    return Some(exe);
                }
            }
        }
        // 3. 显式检查常见自定义安装路径（热迁移常用）
        for fixed in ["D:\\openclow", "C:\\openclow", "D:\\openclaw", "C:\\openclaw"] {
            let exe = Path::new(fixed).join("openclaw.cmd");
            if exe.exists() {
                return Some(exe.to_string_lossy().to_string());
            }
        }
        if let Ok(home) = env::var("USERPROFILE") {
            let exe = Path::new(&home).join("openclaw").join("openclaw.cmd");
            if exe.exists() {
                return Some(exe.to_string_lossy().to_string());
            }
        }
        // 3. 传入路径（install_hint 可能指向已迁移/删除的旧路径，仅作兜底）
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
        // 4. npm root -g（可能指向已删除的源安装）
        if let Ok(out) = run_npm_cmd(&["root", "-g"]) {
            if out.status.success() {
                let root = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !root.is_empty() {
                    if let Some(p) = Path::new(&root).parent() {
                        let exe = p.join("openclaw.cmd");
                        if exe.exists() {
                            return Some(exe.to_string_lossy().to_string());
                        }
                    }
                }
            }
        }
        // 5. APPDATA\npm（可能指向已删除的源安装）
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

fn resolve_openclaw_dir_for_ops(custom_path: Option<&str>, install_hint: Option<&str>) -> String {
    let from_custom = resolve_openclaw_dir(custom_path);
    let custom_cfg = format!("{}/openclaw.json", from_custom);
    if Path::new(&custom_cfg).exists() {
        return from_custom;
    }
    let hint_norm = install_hint
        .map(|s| s.trim().replace('\\', "/"))
        .filter(|s| !s.is_empty());
    if let Some(hint) = hint_norm {
        let cand = if hint.ends_with("/.openclaw") {
            hint
        } else {
            format!("{}/.openclaw", hint.trim_end_matches('/'))
        };
        let cand_cfg = format!("{}/openclaw.json", cand);
        if Path::new(&cand_cfg).exists() {
            return cand;
        }
    }
    from_custom
}

/// 自动检测当前 OpenClaw 配置路径（用于填充「自定义配置路径」）
#[tauri::command]
fn detect_openclaw_config_path() -> Result<Option<String>, String> {
    let home = env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    let home_slash = home.replace('\\', "/");
    let default_dir = format!("{}/.openclaw", home_slash);
    let nested_dir = format!("{}/openclaw/.openclaw", home_slash);

    let candidates: Vec<String> = vec![default_dir.clone(), nested_dir.clone()];

    // 1. 优先从 gateway.cmd 读取 OPENCLAW_STATE_DIR（Gateway 实际使用的路径）
    for base in [&default_dir, &nested_dir] {
        let gateway_path = format!("{}/gateway.cmd", base.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Ok(content) = std::fs::read_to_string(&gateway_path) {
            for line in content.lines() {
                let line = line.trim();
                let up = line.to_uppercase();
                if (up.starts_with("SET ") || up.starts_with("SET\t")) && up.contains("OPENCLAW_STATE_DIR") {
                    if let Some(eq) = line.find('=') {
                        let val = line[eq + 1..].trim().trim_matches('"').trim();
                        if !val.is_empty() {
                            let normalized = val.replace('\\', "/");
                            let cfg = format!("{}/openclaw.json", normalized);
                            if Path::new(&cfg).exists() {
                                return Ok(Some(normalized));
                            }
                        }
                    }
                }
            }
        }
    }

    // 2. 按优先级返回存在 openclaw.json 的目录
    for dir in &candidates {
        let cfg_path = format!("{}/openclaw.json", dir.replace('/', std::path::MAIN_SEPARATOR_STR));
        if Path::new(&cfg_path).exists() {
            if let Ok(txt) = std::fs::read_to_string(&cfg_path) {
                if serde_json::from_str::<Value>(&txt).is_ok() {
                    return Ok(Some(dir.replace('\\', "/")));
                }
            }
        }
    }

    Ok(None)
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

fn now_stamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    secs.to_string()
}

fn create_config_snapshot(openclaw_dir: &str, reason: &str) -> Result<String, String> {
    let reason_norm = reason
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect::<String>();
    let snapshot_root = Path::new(openclaw_dir).join(".snapshots");
    std::fs::create_dir_all(&snapshot_root).map_err(|e| format!("创建快照目录失败: {}", e))?;
    let snapshot_dir = snapshot_root.join(format!("{}-{}", now_stamp(), reason_norm));
    std::fs::create_dir_all(&snapshot_dir).map_err(|e| format!("创建快照失败: {}", e))?;

    for f in ["openclaw.json", "channels.json", "env"] {
        let src = Path::new(openclaw_dir).join(f);
        if src.exists() {
            let dst = snapshot_dir.join(f);
            let _ = std::fs::copy(&src, &dst);
        }
    }
    Ok(snapshot_dir.to_string_lossy().to_string().replace('\\', "/"))
}

fn list_snapshot_dirs(openclaw_dir: &str) -> Vec<String> {
    let root = Path::new(openclaw_dir).join(".snapshots");
    let mut dirs = Vec::new();
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                dirs.push(p.to_string_lossy().to_string().replace('\\', "/"));
            }
        }
    }
    dirs.sort_by(|a, b| b.cmp(a));
    dirs
}

fn configured_channels_from_files(openclaw_dir: &str) -> Vec<String> {
    let mut result: BTreeSet<String> = BTreeSet::new();
    let builtins = ["telegram", "discord", "feishu", "dingtalk", "qq"];

    let root = load_openclaw_config(openclaw_dir).unwrap_or_else(|_| json!({}));
    if let Some(chs) = root.get("channels").and_then(|v| v.as_object()) {
        for id in builtins {
            let ch = chs.get(id).cloned().unwrap_or_else(|| json!({}));
            if is_channel_configured(id, &ch) {
                result.insert(id.to_string());
            }
        }
    }

    let channels_path = Path::new(openclaw_dir).join("channels.json");
    if channels_path.exists() {
        if let Ok(txt) = std::fs::read_to_string(channels_path) {
            if let Ok(v) = serde_json::from_str::<Value>(&txt) {
                if let Some(obj) = v.as_object() {
                    for id in builtins {
                        let ch = obj.get(id).cloned().unwrap_or_else(|| json!({}));
                        if is_channel_configured(id, &ch) {
                            result.insert(id.to_string());
                        }
                    }
                }
            }
        }
    }
    result.into_iter().collect()
}

fn channel_plugin_package(channel: &str) -> Option<&'static str> {
    match channel {
        "discord" => Some("@openclaw/discord"),
        "feishu" => Some("@openclaw/feishu"),
        "dingtalk" => Some("@adongguo/openclaw-dingtalk"),
        "qq" => Some("@sliverp/qqbot"),
        _ => None,
    }
}

fn winget_install_package(pkg_id: &str) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("cmd");
        hide_console_window(&mut cmd);
        let out = cmd
            .args([
                "/c",
                "winget",
                "install",
                "--id",
                pkg_id,
                "-e",
                "--accept-package-agreements",
                "--accept-source-agreements",
                "--silent",
            ])
            .output()
            .map_err(|e| format!("执行 winget 失败: {}", e))?;
        let stdout = decode_console_output(&out.stdout);
        let stderr = decode_console_output(&out.stderr);
        if out.status.success() {
            Ok(format!("winget 安装成功: {}\n{}", pkg_id, stdout))
        } else {
            Err(format!("winget 安装失败: {}\n{}\n{}", pkg_id, stdout, stderr))
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = pkg_id;
        Err("当前平台未实现 winget 安装".to_string())
    }
}

fn try_fix_missing_bin(bin: &str) -> Result<String, String> {
    let b = bin.trim().to_lowercase();
    let pkg = match b.as_str() {
        "jq" => Some("jqlang.jq"),
        "rg" => Some("BurntSushi.ripgrep.MSVC"),
        "ffmpeg" => Some("Gyan.FFmpeg"),
        "op" => Some("AgileBits.1Password.CLI"),
        _ => None,
    };
    if let Some(id) = pkg {
        return winget_install_package(id);
    }
    Err(format!("暂不支持自动安装依赖: {}", bin))
}

fn ensure_extension_manifest_compat_details(openclaw_dir: &str) -> Result<Vec<String>, String> {
    let ext_root = Path::new(openclaw_dir).join("extensions");
    if !ext_root.exists() {
        return Ok(vec![]);
    }
    let mut fixed_dirs: Vec<String> = Vec::new();
    let entries = std::fs::read_dir(&ext_root).map_err(|e| format!("读取 extensions 目录失败: {}", e))?;
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let old_manifest = dir.join("clawdbot.plugin.json");
        let new_manifest = dir.join("openclaw.plugin.json");
        if old_manifest.exists() && !new_manifest.exists() {
            std::fs::copy(&old_manifest, &new_manifest)
                .map_err(|e| format!("补齐 openclaw.plugin.json 失败: {}", e))?;
            if let Some(name) = dir.file_name().and_then(|s| s.to_str()) {
                fixed_dirs.push(name.to_string());
            } else {
                fixed_dirs.push(dir.to_string_lossy().to_string().replace('\\', "/"));
            }
        }
    }
    Ok(fixed_dirs)
}

fn ensure_extension_manifest_compat(openclaw_dir: &str) -> Result<usize, String> {
    Ok(ensure_extension_manifest_compat_details(openclaw_dir)?.len())
}

fn sanitize_invalid_plugin_manifest_refs(openclaw_dir: &str, error_text: &str) -> Result<usize, String> {
    let re = Regex::new(r"extensions[\\/]+([A-Za-z0-9._-]+)[\\/]")
        .map_err(|e| format!("正则初始化失败: {}", e))?;
    let mut plugin_ids: BTreeSet<String> = BTreeSet::new();
    for cap in re.captures_iter(error_text) {
        let pid = cap.get(1).map(|m| m.as_str().trim()).unwrap_or("");
        if !pid.is_empty() {
            plugin_ids.insert(pid.to_string());
        }
    }
    if plugin_ids.is_empty() {
        return Ok(0);
    }

    let mut root = load_openclaw_config(openclaw_dir)?;
    if !root.is_object() {
        return Ok(0);
    }
    let mut changed = 0usize;
    let obj = root.as_object_mut().expect("config object");
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

    let keys: Vec<String> = e_obj.keys().cloned().collect();
    for k in keys {
        let v = e_obj.get(&k).cloned().unwrap_or_else(|| json!({}));
        let mut should_remove = false;
        for pid in &plugin_ids {
            let pid_lower = pid.to_lowercase();
            let alias = match pid_lower.as_str() {
                "openclaw-dingtalk" => Some("dingtalk"),
                "qqbot" | "openclaw-qq" => Some("qq"),
                "openclaw-feishu" => Some("feishu"),
                "openclaw-discord" => Some("discord"),
                other => Some(other),
            };
            if k.eq_ignore_ascii_case(pid)
                || k.to_lowercase().contains(&pid_lower)
                || alias.map(|a| k.eq_ignore_ascii_case(a)).unwrap_or(false)
            {
                should_remove = true;
                break;
            }
            let text = v.to_string().to_lowercase();
            if text.contains(&pid_lower) || alias.map(|a| text.contains(a)).unwrap_or(false) {
                should_remove = true;
                break;
            }
        }
        if should_remove && e_obj.remove(&k).is_some() {
            changed += 1;
        }
    }

    if let Some(allow) = p_obj.get_mut("allow").and_then(|v| v.as_array_mut()) {
        let before = allow.len();
        allow.retain(|x| {
            let s = x.as_str().unwrap_or("").to_lowercase();
            !plugin_ids.iter().any(|pid| {
                let p = pid.to_lowercase();
                s == p || s.contains(&p)
            })
        });
        changed += before.saturating_sub(allow.len());
    }

    if changed > 0 {
        save_openclaw_config(openclaw_dir, &root)?;
    }
    Ok(changed)
}

fn run_skills_list_json_with_repair(
    exe: &str,
    openclaw_dir: &str,
    env_extra: Option<(&str, &str)>,
) -> Result<String, String> {
    let _ = ensure_extension_manifest_compat(openclaw_dir);
    let (ok, out, err) = run_openclaw_cmd_clean(exe, &["skills", "list", "--json"], env_extra)?;
    if ok {
        return Ok(out);
    }
    let all = format!("{}\n{}", out, err).to_lowercase();
    let need_fix = all.contains("plugin manifest not found")
        || all.contains("config invalid")
        || all.contains("invalid config");
    if !need_fix {
        return Err(format!("读取 skills 失败:\n{}\n{}", out, err));
    }

    let sanitize_changed =
        sanitize_invalid_plugin_manifest_refs(openclaw_dir, &format!("{}\n{}", out, err)).unwrap_or(0);
    let (ok2, out2, err2) = run_openclaw_cmd_clean(exe, &["skills", "list", "--json"], env_extra)?;
    if ok2 {
        return Ok(out2);
    }

    let (fix_ok, fix_out, fix_err) = run_openclaw_cmd_clean(exe, &["doctor", "--fix"], env_extra)?;
    let sanitize_changed2 =
        sanitize_invalid_plugin_manifest_refs(openclaw_dir, &format!("{}\n{}\n{}\n{}", out2, err2, fix_out, fix_err))
            .unwrap_or(0);
    let (ok3, out3, err3) = run_openclaw_cmd_clean(exe, &["skills", "list", "--json"], env_extra)?;
    if ok3 {
        return Ok(out3);
    }
    Err(format!(
        "读取 skills 失败（已尝试自动修复）:\n[首次错误]\n{}\n{}\n\n[首次清理]\nremoved_entries={}\n\n[二次错误]\n{}\n{}\n\n[doctor --fix]\n{}\n{}\n(doctor_success={})\n[二次清理]\nremoved_entries={}\n\n[最终错误]\n{}\n{}",
        out, err, sanitize_changed, out2, err2, fix_out, fix_err, fix_ok, sanitize_changed2, out3, err3
    ))
}

/// 在 gateway.cmd 中注入 OPENCLAW_STATE_DIR，确保计划任务启动的 Gateway 使用用户配置目录
#[tauri::command]
fn check_config_path_consistency(custom_path: Option<String>) -> Result<serde_json::Value, String> {
    let default_dir = resolve_openclaw_dir(None);
    let client_dir = custom_path
        .as_deref()
        .map(|s| s.trim().replace('\\', "/"))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| default_dir.clone());
    let gateway_cmd_default = format!("{}/gateway.cmd", default_dir.replace('/', std::path::MAIN_SEPARATOR_STR));
    let gateway_cmd_client = format!("{}/gateway.cmd", client_dir.replace('/', std::path::MAIN_SEPARATOR_STR));
    let has_openclaw_default = Path::new(&format!("{}/openclaw.json", default_dir)).exists();
    let has_openclaw_client = Path::new(&format!("{}/openclaw.json", client_dir)).exists();
    let gateway_has_state_dir = Path::new(&gateway_cmd_default)
        .exists()
        .then(|| {
            std::fs::read_to_string(&gateway_cmd_default)
                .map(|c| c.contains("OPENCLAW_STATE_DIR"))
                .unwrap_or(false)
        })
        .unwrap_or(false);
    let primary_default = load_openclaw_config(&default_dir)
        .ok()
        .and_then(|c| c.get("agents").and_then(|a| a.get("defaults")).and_then(|d| d.get("model")).and_then(|m| m.get("primary")).and_then(|p| p.as_str().map(String::from)))
        .unwrap_or_else(|| "(未设置)".to_string());
    let primary_client = load_openclaw_config(&client_dir)
        .ok()
        .and_then(|c| c.get("agents").and_then(|a| a.get("defaults")).and_then(|d| d.get("model")).and_then(|m| m.get("primary")).and_then(|p| p.as_str().map(String::from)))
        .unwrap_or_else(|| "(未设置)".to_string());
    let consistent = client_dir == default_dir || (Path::new(&gateway_cmd_client).exists() && has_openclaw_client);
    Ok(json!({
        "clientDir": client_dir,
        "defaultDir": default_dir,
        "consistent": consistent,
        "hasOpenclawDefault": has_openclaw_default,
        "hasOpenclawClient": has_openclaw_client,
        "gatewayHasStateDir": gateway_has_state_dir,
        "primaryDefault": primary_default,
        "primaryClient": primary_client,
        "suggestion": if !consistent && has_openclaw_client && has_openclaw_default && primary_default != primary_client {
            "检测到部署工具与 Gateway 使用不同配置目录，模型不一致。请清空「自定义配置路径」使用默认 ~/.openclaw，或重新点击「启动 Gateway」以同步。"
        } else if !consistent {
            "建议清空「自定义配置路径」使用默认目录，或确保启动 Gateway 时使用相同路径。"
        } else {
            ""
        }
    }))
}

/// 在 gateway.cmd 中注入 OPENCLAW_STATE_DIR，确保计划任务启动的 Gateway 使用用户配置目录
/// 同时 patch 默认 ~/.openclaw 下的 gateway.cmd（OpenClaw 可能总在此创建），使其指向用户路径
fn patch_gateway_cmd_state_dir(state_dir: &str) {
    let state_dir_win = state_dir.replace('/', "\\");
    let inject = format!("set \"OPENCLAW_STATE_DIR={}\"\r\n", state_dir_win);
    let default_dir = resolve_openclaw_dir(None);
    let paths_to_patch: Vec<String> = if state_dir != default_dir {
        vec![
            format!("{}/gateway.cmd", state_dir.replace('/', std::path::MAIN_SEPARATOR_STR)),
            format!("{}/gateway.cmd", default_dir.replace('/', std::path::MAIN_SEPARATOR_STR)),
        ]
    } else {
        vec![format!("{}/gateway.cmd", state_dir.replace('/', std::path::MAIN_SEPARATOR_STR))]
    };
    for gateway_path in paths_to_patch {
        let path = Path::new(&gateway_path);
        if !path.exists() {
            continue;
        }
        let content = match std::fs::read_to_string(&gateway_path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        if content.contains("OPENCLAW_STATE_DIR") {
            continue; // 已包含，跳过
        }
        let new_content = inject.clone() + &content;
        let _ = std::fs::write(&gateway_path, new_content);
    }
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
    // 硅基、国产模型等使用 /chat/completions，需 openai-completions；openai-responses 用 /responses 会 404
    let default_api = if base_url_text.contains("moonshot.cn")
        || base_url_text.contains("moonshot.ai")
        || base_url_text.contains("dashscope.aliyuncs.com")
        || base_url_text.contains("siliconflow.cn")
        || base_url_text.contains("siliconflow.com")
        || base_url_text.contains("deepseek.com")
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
        let prefix = primary_prefix_for_provider(provider);
        // 已带正确 provider 前缀则直接返回
        if raw.to_lowercase().starts_with(&format!("{}/", prefix.to_lowercase())) {
            return raw.to_string();
        }
        // 硅基等返回 "deepseek-ai/DeepSeek-V3" 或 "Pro/xxx"，需加 openai 前缀，否则 Unknown model
        return format!("{}/{}", prefix, raw);
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

fn sync_models_cache_api_key(
    openclaw_dir: &str,
    provider: &str,
    base_url: &str,
    key: &str,
) -> Result<(), String> {
    let agent_dir = format!("{}/agents/main/agent", openclaw_dir.replace('\\', "/"));
    std::fs::create_dir_all(&agent_dir).map_err(|e| format!("创建 agent 目录失败: {}", e))?;
    let models_path = format!("{}/models.json", agent_dir);
    let mut root: Value = if Path::new(&models_path).exists() {
        let txt = std::fs::read_to_string(&models_path).map_err(|e| format!("读取 models.json 失败: {}", e))?;
        serde_json::from_str(&txt).unwrap_or_else(|_| json!({ "providers": {} }))
    } else {
        json!({ "providers": {} })
    };
    if !root.is_object() {
        root = json!({ "providers": {} });
    }
    let obj = root.as_object_mut().expect("models root object");
    let providers = obj.entry("providers".to_string()).or_insert_with(|| json!({}));
    if !providers.is_object() {
        *providers = json!({});
    }
    let providers_obj = providers.as_object_mut().expect("providers object");
    let base_lower = base_url.to_ascii_lowercase();
    let api_mode = if provider == "kimi"
        || provider == "moonshot"
        || provider == "qwen"
        || provider == "bailian"
        || provider == "dashscope"
        || base_lower.contains("moonshot.cn")
        || base_lower.contains("moonshot.ai")
        || base_lower.contains("dashscope.aliyuncs.com")
        || base_lower.contains("siliconflow.cn")
        || base_lower.contains("siliconflow.com")
        || base_lower.contains("deepseek.com")
    {
        "openai-completions"
    } else {
        "openai-responses"
    };
    providers_obj.insert(
        "openai".to_string(),
        json!({
            "baseUrl": base_url,
            "apiKey": key,
            "api": api_mode,
            "models": []
        }),
    );
    // 保存硅基/非 Kimi 时移除 custom-api-moonshot 残留，避免 OpenClaw 仍用 kimi-k2.5
    let is_moonshot = base_lower.contains("moonshot.cn") || base_lower.contains("moonshot.ai");
    if !is_moonshot {
        let custom_keys: Vec<String> = providers_obj
            .keys()
            .filter(|k| k.starts_with("custom-api-"))
            .cloned()
            .collect();
        for k in custom_keys {
            providers_obj.remove(&k);
        }
    }
    // 修复历史 custom provider 残留（如 custom-api-moonshot-cn）导致继续读旧 key
    for (_id, pval) in providers_obj.iter_mut() {
        let Some(pobj) = pval.as_object_mut() else { continue };
        let pbase = pobj
            .get("baseUrl")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if pbase.contains("moonshot.cn") || pbase.contains("moonshot.ai") {
            pobj.insert("baseUrl".to_string(), json!(base_url));
            pobj.insert("apiKey".to_string(), json!(key));
            pobj.insert("api".to_string(), json!("openai-completions"));
        }
    }
    std::fs::write(
        &models_path,
        serde_json::to_string_pretty(&root).map_err(|e| format!("序列化 models.json 失败: {}", e))?,
    )
    .map_err(|e| format!("写入 models.json 失败: {}", e))
}

#[tauri::command]
fn cleanup_legacy_provider_cache(custom_path: Option<String>) -> Result<String, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let agent_dir = format!("{}/agents/main/agent", openclaw_dir.replace('\\', "/"));
    std::fs::create_dir_all(&agent_dir).map_err(|e| format!("创建 agent 目录失败: {}", e))?;
    let models_path = format!("{}/models.json", agent_dir);
    if !Path::new(&models_path).exists() {
        return Ok("未发现 models.json 缓存，无需清理".to_string());
    }

    let txt = std::fs::read_to_string(&models_path).map_err(|e| format!("读取 models.json 失败: {}", e))?;
    let mut root: Value = serde_json::from_str(&txt).unwrap_or_else(|_| json!({ "providers": {} }));
    if !root.is_object() {
        root = json!({ "providers": {} });
    }
    let obj = root.as_object_mut().expect("models root object");
    let providers = obj.entry("providers".to_string()).or_insert_with(|| json!({}));
    if !providers.is_object() {
        *providers = json!({});
    }
    let providers_obj = providers.as_object_mut().expect("providers object");

    let mut canonical_base = "https://api.siliconflow.cn/v1".to_string();
    let mut canonical_key: Option<String> = read_auth_profile_api_key(&openclaw_dir, "openai");
    if let Ok(cfg) = load_openclaw_config(&openclaw_dir) {
        if let Some(openai_obj) = cfg
            .as_object()
            .and_then(|o| o.get("models"))
            .and_then(|v| v.as_object())
            .and_then(|o| o.get("providers"))
            .and_then(|v| v.as_object())
            .and_then(|o| o.get("openai"))
            .and_then(|v| v.as_object())
        {
            if let Some(b) = openai_obj.get("baseUrl").and_then(|v| v.as_str()) {
                let b = b.trim();
                if !b.is_empty() {
                    canonical_base = b.to_string();
                }
            }
            if canonical_key.is_none() {
                canonical_key = openai_obj
                    .get("apiKey")
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());
            }
        }
    }

    let keys: Vec<String> = providers_obj.keys().cloned().collect();
    let mut removed = 0usize;
    let mut updated = 0usize;
    for pid in keys {
        if pid.starts_with("custom-api-") {
            let _ = providers_obj.remove(&pid);
            removed += 1;
            continue;
        }
        let Some(pobj) = providers_obj.get_mut(&pid).and_then(|v| v.as_object_mut()) else { continue };
        let pbase = pobj
            .get("baseUrl")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if pbase.contains("moonshot.cn") || pbase.contains("moonshot.ai") {
            pobj.insert("baseUrl".to_string(), json!(canonical_base.clone()));
            if let Some(ref k) = canonical_key {
                pobj.insert("apiKey".to_string(), json!(k));
            }
            pobj.insert("api".to_string(), json!("openai-completions"));
            updated += 1;
        }
    }

    if let Some(openai_obj) = providers_obj
        .entry("openai".to_string())
        .or_insert_with(|| json!({}))
        .as_object_mut()
    {
        openai_obj.insert("baseUrl".to_string(), json!(canonical_base.clone()));
        if let Some(ref k) = canonical_key {
            openai_obj.insert("apiKey".to_string(), json!(k));
        }
    }

    std::fs::write(
        &models_path,
        serde_json::to_string_pretty(&root).map_err(|e| format!("序列化 models.json 失败: {}", e))?,
    )
    .map_err(|e| format!("写入 models.json 失败: {}", e))?;

    Ok(format!(
        "清理完成：移除历史 provider {} 个，更新缓存 {} 处。当前基准地址：{}",
        removed, updated, canonical_base
    ))
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
    let _ = create_config_snapshot(&openclaw_dir, "pre-write-env");

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

    let mut content = match provider.as_str() {
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
    // 始终写入 OPENAI 兼容变量，便于硅基等代理直连与客户端统一读取
    let openai_base = base_url_for_content
        .clone()
        .unwrap_or_else(|| match provider.as_str() {
            "kimi" | "moonshot" => "https://api.moonshot.cn/v1".to_string(),
            _ => "https://api.siliconflow.cn/v1".to_string(),
        });
    if !content.contains("OPENAI_BASE_URL=") {
        content.push_str(&format!("export OPENAI_BASE_URL={}\n", openai_base));
    }
    if !content.contains("OPENAI_API_KEY=") {
        content.push_str(&format!("export OPENAI_API_KEY={}\n", effective_api_key));
    }

    let _ = sync_models_cache_api_key(
        &openclaw_dir,
        provider.as_str(),
        &openai_base,
        &effective_api_key,
    );

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
        let base_lower = base_url.as_ref().map(|u| u.to_ascii_lowercase()).unwrap_or_default();
        let desired_api = if provider == "kimi" || provider == "moonshot" || provider == "qwen"
            || provider == "bailian" || provider == "dashscope"
            || base_lower.contains("siliconflow") || base_lower.contains("deepseek.com")
        {
            "openai-completions"
        } else {
            "openai-responses"
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
    ensure_gateway_mode_local(&mut cfg);
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
            provider: "openai".to_string(),
            base_url: Some("https://api.siliconflow.cn/v1".to_string()),
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
        if txt.contains("api.moonshot.cn") || txt.contains("api.moonshot.ai") {
            "kimi"
        } else if txt.contains("dashscope.aliyuncs.com/compatible-mode") {
            "qwen"
        } else {
            "openai"
        }
    } else {
        "openai"
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
            let exe_path = Path::new(exe);
            let work_dir = exe_path.parent().filter(|p| p.as_os_str().len() > 0);
            let exe_abs: String = if exe_path.exists() {
                let canonical = std::fs::canonicalize(exe_path)
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|_| exe.to_string());
                // cmd.exe 不支持 \\?\ 长路径前缀，需去掉
                if canonical.starts_with("\\\\?\\") {
                    canonical.strip_prefix("\\\\?\\").unwrap_or(&canonical).to_string()
                } else {
                    canonical
                }
            } else {
                exe.to_string()
            };
            // 使用 cmd /c 运行 .cmd；路径无空格时不要加引号，避免 cmd 解析错误
            let exe_part = if exe_abs.contains(' ') {
                format!("\"{}\"", exe_abs.replace('"', "\"\""))
            } else {
                exe_abs.clone()
            };
            let args_part: Vec<String> = args
                .iter()
                .map(|a| {
                    if a.contains(' ') {
                        format!("\"{}\"", a.replace('"', "\"\""))
                    } else {
                        (*a).to_string()
                    }
                })
                .collect();
            let full_cmd = if args_part.is_empty() {
                exe_part
            } else {
                format!("{} {}", exe_part, args_part.join(" "))
            };
            let mut cmd = Command::new("cmd");
            hide_console_window(&mut cmd);
            cmd.args(["/c", &full_cmd]);
            if let Some(dir) = work_dir {
                let _ = cmd.current_dir(dir);
            }
            // 安装目录加入 PATH，确保 openclaw.cmd 内部能解析 node 等依赖
            if let Some(dir) = work_dir {
                let dir_str = dir.to_string_lossy();
                if let Ok(current_path) = env::var("PATH") {
                    let new_path = format!("{};{}", dir_str, current_path);
                    cmd.env("PATH", new_path);
                }
            }
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

/// Windows 控制台输出多为 GBK，需正确解码避免乱码（如「系统找不到指定路径」）
#[cfg(target_os = "windows")]
fn decode_console_output(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_string();
    }
    let (cow, _, _) = GBK.decode(bytes);
    cow.to_string()
}

#[cfg(not(target_os = "windows"))]
fn decode_console_output(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).to_string()
}

fn run_openclaw_cmd_clean(exe: &str, args: &[&str], env_extra: Option<(&str, &str)>) -> Result<(bool, String, String), String> {
    let output = run_openclaw_cmd(exe, args, env_extra).map_err(|e| format!("执行失败: {}", e))?;
    let stdout = strip_ansi_text(&decode_console_output(&output.stdout));
    let stderr = strip_ansi_text(&decode_console_output(&output.stderr));
    Ok((output.status.success(), stdout, stderr))
}

fn try_repair_control_ui_assets(exe: &str) -> String {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    let exe_path = Path::new(exe);
    if let Some(bin_dir) = exe_path.parent() {
        candidates.push(bin_dir.join("node_modules").join("openclaw"));
        candidates.push(bin_dir.join("..").join("lib").join("node_modules").join("openclaw"));
    }
    if let Ok(out) = run_npm_cmd(&["root", "-g"]) {
        if out.status.success() {
            let root = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !root.is_empty() {
                candidates.push(Path::new(&root).join("openclaw"));
            }
        }
    }

    let mut seen = std::collections::BTreeSet::new();
    let mut last_err = String::new();
    for dir in candidates {
        let key = dir.to_string_lossy().to_string();
        if key.is_empty() || seen.contains(&key) {
            continue;
        }
        seen.insert(key.clone());
        if !dir.join("package.json").exists() {
            continue;
        }
        #[cfg(target_os = "windows")]
        {
            // 方案1：按报错提示在 openclaw 包目录执行 `pnpm ui:build`
            let mut cmd1 = Command::new("cmd");
            hide_console_window(&mut cmd1);
            cmd1.args(["/c", "npm", "exec", "--yes", "pnpm@latest", "--", "run", "ui:build"]);
            cmd1.current_dir(&dir);
            match cmd1.output() {
                Ok(out) => {
                    let so = strip_ansi_text(&decode_console_output(&out.stdout));
                    let se = strip_ansi_text(&decode_console_output(&out.stderr));
                    if out.status.success() {
                        return format!("Control UI 资源修复成功: {}\n{}", key, so);
                    }
                    last_err = format!("方案1失败: {}\n{}\n{}", key, so, se);
                }
                Err(e) => {
                    last_err = format!("方案1执行失败: {} ({})", key, e);
                }
            }

            // 方案2：若脚本名兼容，直接执行 `pnpm ui:build`
            let mut cmd2 = Command::new("cmd");
            hide_console_window(&mut cmd2);
            cmd2.args(["/c", "npm", "exec", "--yes", "pnpm@latest", "--", "ui:build"]);
            cmd2.current_dir(&dir);
            match cmd2.output() {
                Ok(out) => {
                    let so = strip_ansi_text(&decode_console_output(&out.stdout));
                    let se = strip_ansi_text(&decode_console_output(&out.stderr));
                    if out.status.success() {
                        return format!("Control UI 资源修复成功: {}\n{}", key, so);
                    }
                    last_err = format!("{}\n\n方案2失败: {}\n{}\n{}", last_err, key, so, se);
                }
                Err(e) => {
                    last_err = format!("{}\n\n方案2执行失败: {} ({})", last_err, key, e);
                }
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = key;
        }
    }
    if last_err.is_empty() {
        "未找到可修复的 OpenClaw UI 目录（已跳过）".to_string()
    } else {
        last_err
    }
}

#[cfg(target_os = "windows")]
fn cleanup_processes_listening_on_port(port: u16) -> Vec<String> {
    let mut killed: Vec<String> = Vec::new();
    let out = Command::new("cmd")
        .args(["/c", "netstat -ano -p tcp"])
        .output();
    let Ok(out) = out else { return killed };
    if !out.status.success() {
        return killed;
    }
    let txt = decode_console_output(&out.stdout);
    let mut pids = std::collections::BTreeSet::<u32>::new();
    let needle = format!(":{}", port);
    for line in txt.lines() {
        let l = line.trim();
        if l.is_empty() || !l.contains(&needle) || !l.to_ascii_uppercase().contains("LISTENING") {
            continue;
        }
        if let Some(pid_s) = l.split_whitespace().last() {
            if let Ok(pid) = pid_s.parse::<u32>() {
                if pid > 0 {
                    pids.insert(pid);
                }
            }
        }
    }
    for pid in pids {
        let mut cmd = Command::new("cmd");
        hide_console_window(&mut cmd);
        if let Ok(o) = cmd.args(["/c", "taskkill", "/PID", &pid.to_string(), "/F"]).output() {
            if o.status.success() {
                killed.push(format!("已清理占用端口 {} 的进程 PID {}", port, pid));
            }
        }
    }
    killed
}

#[cfg(not(target_os = "windows"))]
fn cleanup_processes_listening_on_port(_port: u16) -> Vec<String> {
    vec![]
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
    let exe = match find_openclaw_executable(install_hint_norm.as_deref().or(config_path)) {
        Some(e) => e,
        None => {
            return Err(
                "未找到 openclaw 可执行文件。请确认：\n1. 已安装 OpenClaw（在「安装 OpenClaw」页面完成安装）\n2. 若为热迁移，请将 D:\\openclow 或 C:\\openclow 加入系统 PATH\n3. 在「安装 OpenClaw」页面点击「刷新」重新检测".to_string(),
            );
        }
    };
    let state_dir = config_dir.clone();
    let _ = get_gateway_auth_token(state_dir.clone());
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

    // 启动前强制用当前配置路径重装 gateway 任务，确保计划任务执行的是用户配置目录下的 gateway.cmd
    // 否则 Gateway 会读 ~/.openclaw 而部署工具可能写入自定义路径，导致模型/Key 不一致
    let _ = run_openclaw_cmd_clean(&exe, &["gateway", "install", "--force"], env_extra);
    if let Some(ref dir) = state_dir {
        patch_gateway_cmd_state_dir(dir);
    }
    std::thread::sleep(Duration::from_secs(1));

    // 启动前清理旧进程，避免端口被占用
    let _ = run_openclaw_cmd_clean(&exe, &["gateway", "stop"], env_extra);
    let cleaned_port_pids = cleanup_processes_listening_on_port(18789);
    std::thread::sleep(Duration::from_secs(2));

    let (ok, stdout, stderr) = run_openclaw_cmd_clean(&exe, &["gateway", "start"], env_extra)?;
    if ok {
        // 启动后延迟探活，避免 Telegram 等渠道“无响应”
        std::thread::sleep(Duration::from_secs(5));
        let (_, status_out, _) = run_openclaw_cmd_clean(&exe, &["gateway", "status"], env_extra).unwrap_or((false, String::new(), String::new()));
        let status_lower = status_out.to_lowercase();
        let rpc_ok = !status_lower.contains("rpc probe") || !status_lower.contains("failed");
        let mut msg = format!(
            "Gateway 已启动\n{}\n\n[路径锁定]\n可执行: {}\n配置目录: {}",
            stdout,
            exe,
            state_dir.as_deref().unwrap_or("(未设置)")
        );
        if !cleaned_port_pids.is_empty() {
            msg.push_str("\n\n[端口清理]");
            for item in &cleaned_port_pids {
                msg.push_str(&format!("\n- {}", item));
            }
        }
        if !rpc_ok {
            msg.push_str("\n\n⚠️ 探活未通过，Telegram/对话可能无响应。建议：\n1. 清空「自定义配置路径」使用默认 ~/.openclaw\n2. 点击「前台启动 Gateway」重试\n3. 或 CMD 执行 openclaw gateway 保持窗口不关");
        }
        return Ok(msg);
    }

    let combined = format!("{}\n{}", stdout, stderr);
    let lower = combined.to_lowercase();
    // 幂等：已在运行时视为成功
    if lower.contains("already running")
        || lower.contains("already started")
        || lower.contains("已在运行")
    {
        // 已在运行也做一次探活，若失败则提示
        std::thread::sleep(Duration::from_secs(2));
        let (_, status_out, _) = run_openclaw_cmd_clean(&exe, &["gateway", "status"], env_extra).unwrap_or((false, String::new(), String::new()));
        let status_lower = status_out.to_lowercase();
        if status_lower.contains("rpc probe") && status_lower.contains("failed") {
            return Ok("Gateway 任务已存在，但探活失败（Telegram 可能无响应）。建议：清空「自定义配置路径」后重新点击「启动 Gateway」，或使用「前台启动 Gateway」。".to_string());
        }
        return Ok("Gateway 已在运行".to_string());
    }
    let diag = format!(
        "可执行文件：{}\n配置目录：{}",
        exe,
        state_dir.as_deref().unwrap_or("(未设置)")
    );
    let path_error = lower.contains("program not found")
        || lower.contains("not recognized as an internal or external command")
        || lower.contains("系统找不到指定的文件")
        || lower.contains("no such file or directory");
    if path_error {
        // gateway.cmd 可能指向已删除路径，尝试强制重写后重试
        let (install_ok, _, _) =
            run_openclaw_cmd_clean(&exe, &["gateway", "install", "--force"], env_extra)?;
        if install_ok {
            std::thread::sleep(Duration::from_secs(1));
            let (start_ok2, stdout2, _) =
                run_openclaw_cmd_clean(&exe, &["gateway", "start"], env_extra)?;
            if start_ok2 {
                return Ok(format!("Gateway 已修复并启动\n{}", stdout2));
            }
        }
        return Err(format!(
            "找不到 openclaw 可执行文件。\n{}\n\n请确认：\n1. D:\\openclow 或 C:\\openclow 下存在 openclaw.cmd\n2. 若为热迁移，请将新安装目录加入 PATH\n3. 在「安装 OpenClaw」页面点击「刷新」重新检测",
            diag
        ));
    }
    if combined.contains("MODULE_NOT_FOUND") || combined.contains("Cannot find module") {
        return Err(format!(
            "检测到 OpenClaw 安装不完整（缺少核心模块）。\n{}\n请返回「安装 OpenClaw」重新安装。",
            diag
        ));
    }
    let missing_service = combined.contains("Gateway service missing")
        || combined.contains("gateway install")
        || combined.contains("schtasks");

    if missing_service {
        // 使用 --force 强制重新生成 gateway.cmd，避免热迁删除源后仍指向旧路径
        let (install_ok, install_out, install_err) =
            run_openclaw_cmd_clean(&exe, &["gateway", "install", "--force"], env_extra)?;
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

    Err(format!(
        "启动失败\n{}\n\n命令输出：\nstdout: {}\nstderr: {}",
        diag, stdout, stderr
    ))
}

#[tauri::command]
fn reset_gateway_auth_and_restart(custom_path: Option<String>, install_hint: Option<String>) -> Result<String, String> {
    let cfg = custom_path
        .as_deref()
        .map(|s| s.trim().replace('\\', "/"))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| resolve_openclaw_dir(None));
    let install_hint_norm = install_hint
        .as_deref()
        .map(|s| s.trim().replace('\\', "/"))
        .filter(|s| !s.is_empty());
    let exe = find_openclaw_executable(install_hint_norm.as_deref().or(Some(cfg.as_str())))
        .unwrap_or_else(|| "openclaw".to_string());
    let env_extra = Some(("OPENCLAW_STATE_DIR", cfg.as_str()));

    let _ = run_openclaw_cmd_clean(&exe, &["gateway", "stop"], env_extra);
    let (_, d_out, d_err) = run_openclaw_cmd_clean(&exe, &["doctor", "--fix"], env_extra)
        .unwrap_or((false, String::new(), String::new()));
    let ui_fix = try_repair_control_ui_assets(&exe);
    let _ = get_gateway_auth_token(custom_path.clone())?;
    let start_msg = start_gateway(custom_path.clone(), install_hint)?;
    let url = get_gateway_dashboard_url(custom_path)?;
    Ok(format!(
        "{}\n\n[doctor --fix]\n{}\n{}\n\n[ui 修复]\n{}\n\n已重置 Gateway 认证并重启。\n请使用此地址进入：{}",
        start_msg, d_out, d_err, ui_fix, url
    ))
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

/// 前台启动 Gateway：在新 cmd 窗口运行 openclaw gateway，计划任务失败时的替代方案
#[tauri::command]
fn start_gateway_foreground(custom_path: Option<String>, install_hint: Option<String>) -> Result<String, String> {
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
        .ok_or("未找到 openclaw 可执行文件，请先完成安装。".to_string())?;
    if let Ok(mut root) = load_openclaw_config(&config_dir) {
        ensure_gateway_mode_local(&mut root);
        let _ = save_openclaw_config(&config_dir, &root);
    }
    #[cfg(target_os = "windows")]
    {
        let exe_win = exe.replace('/', "\\");
        let config_win = config_dir.replace('/', "\\");
        let exe_dir = Path::new(&exe).parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| config_dir.clone());
        let launcher_path = env::temp_dir().join("openclaw-gateway-foreground.cmd");
        let launcher_content = format!(
            "@echo off\r\nset \"OPENCLAW_STATE_DIR={}\"\r\ncall \"{}\" gateway\r\n",
            config_win, exe_win
        );
        std::fs::write(&launcher_path, launcher_content)
            .map_err(|e| format!("写入前台启动脚本失败: {}", e))?;
        let launcher_win = launcher_path.to_string_lossy().to_string().replace('/', "\\");
        let mut cmd = Command::new("cmd");
        cmd.args(["/c", "start", "", "cmd", "/k", &launcher_win]);
        cmd.current_dir(&exe_dir);
        cmd.output().map_err(|e| format!("打开新窗口失败: {}", e))?;
        Ok("已在新窗口启动 Gateway，请保持该窗口不关闭。就绪后访问: http://127.0.0.1:18789/".to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (config_dir, exe);
        Err("当前平台暂不支持前台启动".to_string())
    }
}

#[tauri::command]
fn fix_node() -> Result<String, String> {
    Ok("https://nodejs.org".to_string())
}

#[tauri::command]
fn fix_git() -> Result<String, String> {
    Ok("https://git-scm.com/download/win".to_string())
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
        let config_win = config_dir.replace('/', "\\");
        let exe_win = exe.replace('/', "\\");
        let exe_dir = Path::new(&exe)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| config_dir.clone());
        let launcher_path = env::temp_dir().join("openclaw-onboard-cli-launcher.cmd");
        let launcher_content = format!(
            "@echo off\r\nset \"OPENCLAW_STATE_DIR={}\"\r\ncall \"{}\" onboard\r\n",
            config_win, exe_win
        );
        std::fs::write(&launcher_path, launcher_content)
            .map_err(|e| format!("写入 CLI 启动脚本失败: {}", e))?;
        let launcher_win = launcher_path.to_string_lossy().to_string().replace('/', "\\");
        let mut cmd = Command::new("cmd");
        // 这里故意不隐藏窗口：用户明确要求打开经典终端界面
        cmd.args(["/c", "start", "", "cmd", "/k", &launcher_win]);
        cmd.current_dir(&exe_dir);
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
    let _ = create_config_snapshot(&openclaw_dir, "pre-save-channel");
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

/// 共用逻辑：判断渠道配置是否有效（与 Shell 脚本保持一致）
fn is_channel_configured(channel_id: &str, ch: &Value) -> bool {
    let obj = match ch.as_object() {
        Some(o) => o,
        None => return false,
    };
    let non_empty = |v: Option<&Value>| {
        v.and_then(|x| x.as_str())
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
    };
    match channel_id {
        "telegram" => non_empty(obj.get("botToken")),
        "discord" => non_empty(obj.get("token")) || non_empty(obj.get("botToken")),
        "feishu" | "dingtalk" => {
            let check_acc = |acc: &Value| {
                let o = acc.as_object()?;
                let (id_key, secret_key) = if channel_id == "feishu" {
                    ("appId", "appSecret")
                } else {
                    ("appKey", "appSecret")
                };
                let id_ok = non_empty(o.get(id_key));
                let secret_ok = non_empty(o.get(secret_key));
                Some(id_ok && secret_ok)
            };
            if let Some(accs) = obj.get("accounts").and_then(|v| v.as_object()) {
                accs.values().any(|acc| check_acc(acc).unwrap_or(false))
            } else {
                check_acc(ch).unwrap_or(false)
            }
        }
        "qq" => {
            let app_ok = non_empty(obj.get("appId"));
            let cred_ok = non_empty(obj.get("token")) || non_empty(obj.get("appSecret"));
            app_ok && cred_ok
        }
        _ => false,
    }
}

#[tauri::command]
fn get_channel_config_status(custom_path: Option<String>) -> Result<Value, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let mut result = serde_json::Map::new();
    let channels = ["telegram", "discord", "feishu", "dingtalk", "qq"];
    let root = load_openclaw_config(&openclaw_dir).unwrap_or_else(|_| json!({}));
    let chs = root
        .as_object()
        .and_then(|o| o.get("channels"))
        .and_then(|c| c.as_object())
        .cloned()
        .unwrap_or_default();
    let channels_path = format!("{}/channels.json", openclaw_dir.replace('\\', "/"));
    let chs_legacy: Map<String, Value> = if Path::new(&channels_path).exists() {
        let txt = std::fs::read_to_string(&channels_path).unwrap_or_default();
        serde_json::from_str(&txt).unwrap_or_else(|_| Map::new())
    } else {
        Map::new()
    };
    for id in channels {
        let ch = chs.get(id).or_else(|| chs_legacy.get(id)).cloned().unwrap_or(json!({}));
        result.insert(id.to_string(), json!(is_channel_configured(id, &ch)));
    }
    Ok(Value::Object(result))
}

#[tauri::command]
fn remove_channel_config(channel: String, custom_path: Option<String>) -> Result<String, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let channels_path = format!("{}/channels.json", openclaw_dir.replace('\\', "/"));
    let config_path = format!("{}/openclaw.json", openclaw_dir.replace('\\', "/"));
    let mut modified = false;
    if Path::new(&config_path).exists() {
        let mut root = load_openclaw_config(&openclaw_dir)?;
        if let Some(chs) = root
            .as_object_mut()
            .and_then(|o| o.get_mut("channels"))
            .and_then(|c| c.as_object_mut())
        {
            if chs.remove(&channel).is_some() {
                modified = true;
                save_openclaw_config(&openclaw_dir, &root)?;
            }
        }
    }
    if Path::new(&channels_path).exists() {
        let txt = std::fs::read_to_string(&channels_path)
            .map_err(|e| format!("读取 channels.json 失败: {}", e))?;
        let mut root: Value =
            serde_json::from_str(&txt).map_err(|e| format!("解析 channels.json 失败: {}", e))?;
        if let Some(obj) = root.as_object_mut() {
            if obj.remove(&channel).is_some() {
                modified = true;
                std::fs::write(
                    &channels_path,
                    serde_json::to_string_pretty(&root)
                        .map_err(|e| format!("序列化失败: {}", e))?,
                )
                .map_err(|e| format!("写入失败: {}", e))?;
            }
        }
    }
    if modified {
        Ok(format!("{} 渠道配置已清除", channel))
    } else {
        Ok(format!("{} 渠道无已保存配置", channel))
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
            // 硅基流动等中转使用不同模型 ID，需用 deepseek-ai/DeepSeek-V3 等
            let base_lower = resolved_base.to_lowercase();
            let probe_model = if base_lower.contains("siliconflow") {
                "deepseek-ai/DeepSeek-V3"
            } else {
                match provider.as_str() {
                    "kimi" | "moonshot" => "moonshot-v1-32k",
                    "qwen" | "bailian" | "dashscope" => "qwen-plus",
                    "deepseek" => "deepseek-chat",
                    "openai" => "gpt-4o-mini",
                    _ => "gpt-4o-mini",
                }
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
    if (base_lower.contains("moonshot.cn") || base_lower.contains("moonshot.ai"))
        && !model_lower.contains("moonshot")
    {
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
fn get_gateway_dashboard_url(custom_path: Option<String>) -> Result<String, String> {
    let token = get_gateway_auth_token(custom_path)?;
    Ok(format!("http://127.0.0.1:18789/?token={}", token))
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
        "discord" => {
            let t = obj.get("token").or_else(|| obj.get("botToken"));
            t.and_then(|v| v.as_str()).map(|s| !s.trim().is_empty()).unwrap_or(false)
        }
        "feishu" => {
            let app_id = obj.get("appId").and_then(|v| v.as_str()).map(|s| !s.trim().is_empty()).unwrap_or(false);
            let app_secret = obj.get("appSecret").and_then(|v| v.as_str()).map(|s| !s.trim().is_empty()).unwrap_or(false);
            app_id && app_secret
        }
        "dingtalk" => {
            let acc_obj = obj
                .get("accounts")
                .and_then(|a| a.get("main"))
                .and_then(|v| v.as_object())
                .or_else(|| config.as_object());
            let app_key = acc_obj.and_then(|o| o.get("appKey")).and_then(|v| v.as_str()).map(|s| !s.trim().is_empty()).unwrap_or(false);
            let app_secret = acc_obj.and_then(|o| o.get("appSecret")).and_then(|v| v.as_str()).map(|s| !s.trim().is_empty()).unwrap_or(false);
            app_key && app_secret
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

#[tauri::command]
fn list_config_snapshots(custom_path: Option<String>) -> Result<Vec<String>, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    Ok(list_snapshot_dirs(&openclaw_dir))
}

#[tauri::command]
fn rollback_config_snapshot(snapshot_dir: String, custom_path: Option<String>) -> Result<String, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let src = PathBuf::from(snapshot_dir.trim().replace('\\', "/"));
    if !src.exists() || !src.is_dir() {
        return Err("快照目录不存在".to_string());
    }
    let _ = create_config_snapshot(&openclaw_dir, "pre-rollback");
    let mut restored = Vec::new();
    for f in ["openclaw.json", "channels.json", "env"] {
        let s = src.join(f);
        if s.exists() {
            let d = Path::new(&openclaw_dir).join(f);
            std::fs::copy(&s, &d).map_err(|e| format!("恢复 {} 失败: {}", f, e))?;
            restored.push(f.to_string());
        }
    }
    if restored.is_empty() {
        return Err("快照目录中没有可恢复文件".to_string());
    }
    Ok(format!("已回滚配置：{}", restored.join(", ")))
}

#[tauri::command]
fn run_startup_migrations(custom_path: Option<String>) -> Result<StartupMigrationResult, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let fixed_dirs = ensure_extension_manifest_compat_details(&openclaw_dir)?;
    Ok(StartupMigrationResult {
        fixed_count: fixed_dirs.len(),
        fixed_dirs,
    })
}

#[tauri::command]
fn export_diagnostic_bundle(custom_path: Option<String>, install_hint: Option<String>) -> Result<String, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let install_hint_norm = install_hint
        .as_deref()
        .map(|s| s.trim().replace('\\', "/"))
        .filter(|s| !s.is_empty());
    let exe = find_openclaw_executable(install_hint_norm.as_deref().or(Some(openclaw_dir.as_str())))
        .unwrap_or_else(|| "openclaw".to_string());

    let out_dir = Path::new(&openclaw_dir).join("diagnostics");
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("创建 diagnostics 目录失败: {}", e))?;
    let stamp = now_stamp();
    let report_path = out_dir.join(format!("report-{}.txt", stamp));
    let zip_path = out_dir.join(format!("diagnostic-{}.zip", stamp));

    let mut report = String::new();
    report.push_str("=== OpenClaw Deploy Diagnostic ===\n");
    report.push_str(&format!("time_unix: {}\n", stamp));
    report.push_str(&format!("config_dir: {}\n", openclaw_dir));
    report.push_str(&format!("exe: {}\n\n", exe));
    let env_extra = Some(("OPENCLAW_STATE_DIR", openclaw_dir.as_str()));
    for args in [
        vec!["--version"],
        vec!["status"],
        vec!["gateway", "status"],
        vec!["skills", "check"],
        vec!["plugins", "list"],
    ] {
        let title = format!("$ openclaw {}\n", args.join(" "));
        report.push_str(&title);
        match run_openclaw_cmd_clean(&exe, &args, env_extra) {
            Ok((_ok, out, err)) => {
                report.push_str(&out);
                if !err.trim().is_empty() {
                    report.push('\n');
                    report.push_str("[stderr]\n");
                    report.push_str(&err);
                }
            }
            Err(e) => report.push_str(&format!("执行失败: {}", e)),
        }
        report.push_str("\n\n");
    }
    std::fs::write(&report_path, report).map_err(|e| format!("写入诊断报告失败: {}", e))?;

    #[cfg(target_os = "windows")]
    {
        let mut files_to_pack: Vec<String> = Vec::new();
        for f in ["openclaw.json", "channels.json", "env", "gateway.log"] {
            let p = Path::new(&openclaw_dir).join(f);
            if p.exists() {
                files_to_pack.push(format!("'{}'", p.to_string_lossy().to_string().replace('\'', "''")));
            }
        }
        files_to_pack.push(format!("'{}'", report_path.to_string_lossy().to_string().replace('\'', "''")));
        let zip_s = zip_path.to_string_lossy().to_string().replace('\'', "''");
        let sources = files_to_pack.join(",");
        let script = format!(
            "$src=@({}); if(Test-Path '{}'){{Remove-Item '{}' -Force}}; Compress-Archive -Path $src -DestinationPath '{}' -Force",
            sources, zip_s, zip_s, zip_s
        );
        let mut cmd = Command::new("powershell");
        hide_console_window(&mut cmd);
        let out = cmd.args(["-NoProfile", "-Command", &script]).output().map_err(|e| format!("执行压缩失败: {}", e))?;
        if !out.status.success() {
            return Err(format!("压缩失败：{}", decode_console_output(&out.stderr)));
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        return Ok(report_path.to_string_lossy().to_string());
    }
    Ok(zip_path.to_string_lossy().to_string())
}

fn collect_memory_files_recursively(dir: &Path, files: &mut Vec<PathBuf>) {
    if !dir.exists() || !dir.is_dir() {
        return;
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for ent in entries.flatten() {
            let p = ent.path();
            if p.is_dir() {
                collect_memory_files_recursively(&p, files);
            } else if p
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("md"))
                .unwrap_or(false)
            {
                files.push(p);
            }
        }
    }
}

#[tauri::command]
fn memory_center_status(custom_path: Option<String>) -> Result<MemoryCenterStatus, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let root = load_openclaw_config(&openclaw_dir).unwrap_or_else(|_| json!({}));
    let enabled = root
        .as_object()
        .and_then(|o| o.get("agents"))
        .and_then(|v| v.as_object())
        .and_then(|o| o.get("defaults"))
        .and_then(|v| v.as_object())
        .and_then(|o| o.get("memorySearch"))
        .and_then(|v| v.as_object())
        .and_then(|o| o.get("enabled"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    let ws = Path::new(&openclaw_dir).join("workspace");
    let memory_file = ws.join("MEMORY.md");
    let memory_dir = ws.join("memory");
    let memory_file_exists = memory_file.exists();
    let memory_dir_exists = memory_dir.exists() && memory_dir.is_dir();
    let mut files: Vec<PathBuf> = Vec::new();
    collect_memory_files_recursively(&memory_dir, &mut files);
    let note = if !enabled {
        "记忆已关闭（agents.defaults.memorySearch.enabled=false）".to_string()
    } else if !memory_file_exists && files.is_empty() {
        "尚未发现记忆文件。".to_string()
    } else {
        "记忆功能已启用。".to_string()
    };
    Ok(MemoryCenterStatus {
        enabled,
        memory_file_exists,
        memory_dir_exists,
        memory_file_count: files.len() + if memory_file_exists { 1 } else { 0 },
        note,
    })
}

#[tauri::command]
fn memory_center_read(custom_path: Option<String>) -> Result<String, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let ws = Path::new(&openclaw_dir).join("workspace");
    let memory_file = ws.join("MEMORY.md");
    let memory_dir = ws.join("memory");

    let mut out = String::new();
    if memory_file.exists() {
        out.push_str("=== MEMORY.md ===\n");
        if let Ok(text) = std::fs::read_to_string(&memory_file) {
            let lines: Vec<&str> = text.lines().take(120).collect();
            out.push_str(&lines.join("\n"));
            if text.lines().count() > 120 {
                out.push_str("\n...(已截断)\n");
            }
        } else {
            out.push_str("(读取失败)\n");
        }
        out.push('\n');
    } else {
        out.push_str("=== MEMORY.md ===\n(不存在)\n\n");
    }

    let mut files: Vec<PathBuf> = Vec::new();
    collect_memory_files_recursively(&memory_dir, &mut files);
    files.sort();
    out.push_str("=== memory/*.md ===\n");
    if files.is_empty() {
        out.push_str("(无)\n");
    } else {
        for p in files.iter().take(80) {
            out.push_str("- ");
            out.push_str(&p.to_string_lossy().replace('\\', "/"));
            out.push('\n');
        }
        if files.len() > 80 {
            out.push_str(&format!("...(其余 {} 个已省略)\n", files.len() - 80));
        }
    }
    Ok(out)
}

#[tauri::command]
fn memory_center_clear(custom_path: Option<String>) -> Result<String, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let ws = Path::new(&openclaw_dir).join("workspace");
    let memory_file = ws.join("MEMORY.md");
    let memory_dir = ws.join("memory");
    let mut removed: Vec<String> = Vec::new();

    if memory_file.exists() {
        std::fs::remove_file(&memory_file).map_err(|e| format!("删除 MEMORY.md 失败: {}", e))?;
        removed.push("MEMORY.md".to_string());
    }
    if memory_dir.exists() {
        std::fs::remove_dir_all(&memory_dir).map_err(|e| format!("删除 memory 目录失败: {}", e))?;
        removed.push("memory/".to_string());
    }
    if removed.is_empty() {
        Ok("没有可清空的记忆文件".to_string())
    } else {
        Ok(format!("已清空记忆：{}", removed.join(", ")))
    }
}

#[tauri::command]
fn memory_center_export(custom_path: Option<String>) -> Result<String, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let ws = Path::new(&openclaw_dir).join("workspace");
    let memory_file = ws.join("MEMORY.md");
    let memory_dir = ws.join("memory");
    let out_dir = Path::new(&openclaw_dir).join("diagnostics");
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("创建 diagnostics 目录失败: {}", e))?;
    let stamp = now_stamp();
    let export_path = out_dir.join(format!("memory-export-{}.txt", stamp));

    let mut text = String::new();
    text.push_str("=== OpenClaw Memory Export ===\n");
    text.push_str(&format!("time_unix: {}\n", stamp));
    text.push_str(&format!("config_dir: {}\n\n", openclaw_dir));

    if memory_file.exists() {
        text.push_str("## MEMORY.md\n");
        match std::fs::read_to_string(&memory_file) {
            Ok(t) => text.push_str(&t),
            Err(e) => text.push_str(&format!("(读取失败: {})\n", e)),
        }
        text.push_str("\n\n");
    }

    let mut files: Vec<PathBuf> = Vec::new();
    collect_memory_files_recursively(&memory_dir, &mut files);
    files.sort();
    for p in files {
        text.push_str("## ");
        text.push_str(&p.to_string_lossy().replace('\\', "/"));
        text.push('\n');
        match std::fs::read_to_string(&p) {
            Ok(t) => text.push_str(&t),
            Err(e) => text.push_str(&format!("(读取失败: {})\n", e)),
        }
        text.push_str("\n\n");
    }

    std::fs::write(&export_path, text).map_err(|e| format!("写入导出文件失败: {}", e))?;
    Ok(export_path.to_string_lossy().to_string())
}

#[tauri::command]
fn memory_center_bootstrap(custom_path: Option<String>) -> Result<String, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let ws = Path::new(&openclaw_dir).join("workspace");
    std::fs::create_dir_all(&ws).map_err(|e| format!("创建 workspace 失败: {}", e))?;
    let memory_file = ws.join("MEMORY.md");
    let memory_dir = ws.join("memory");
    std::fs::create_dir_all(&memory_dir).map_err(|e| format!("创建 memory 目录失败: {}", e))?;

    let mut created = Vec::new();
    if !memory_file.exists() {
        let tpl = [
            "# 长期记忆",
            "",
            "## 用户偏好",
            "- 使用中文（简体）交流。",
            "",
            "## 当前目标",
            "- 在此记录长期稳定信息，便于下次快速恢复上下文。",
            "",
            "## 注意",
            "- 不要写入 API Key、密码等敏感信息。",
            "",
        ]
        .join("\n");
        std::fs::write(&memory_file, tpl).map_err(|e| format!("写入 MEMORY.md 失败: {}", e))?;
        created.push("MEMORY.md".to_string());
    }
    let profile_file = memory_dir.join("profile.md");
    if !profile_file.exists() {
        let tpl = [
            "# 用户画像",
            "",
            "- 行业：",
            "- 常用场景：",
            "- 输出偏好：",
            "",
        ]
        .join("\n");
        std::fs::write(&profile_file, tpl).map_err(|e| format!("写入 profile.md 失败: {}", e))?;
        created.push("memory/profile.md".to_string());
    }

    let install_hint_norm = Some(openclaw_dir.replace('\\', "/"));
    let exe = find_openclaw_executable(install_hint_norm.as_deref())
        .unwrap_or_else(|| "openclaw".to_string());
    let env_extra = Some(("OPENCLAW_STATE_DIR", openclaw_dir.as_str()));
    let mut index_msg = "索引未执行".to_string();
    if let Ok((ok, out, err)) = run_openclaw_cmd_clean(&exe, &["memory", "index"], env_extra) {
        if ok {
            index_msg = "已触发 memory index".to_string();
        } else if !out.trim().is_empty() || !err.trim().is_empty() {
            index_msg = format!("memory index 返回：{}\n{}", out, err);
        }
    }

    if created.is_empty() {
        Ok(format!("记忆文件已存在，无需初始化。\n{}", index_msg))
    } else {
        Ok(format!("已初始化记忆文件：{}\n{}", created.join(", "), index_msg))
    }
}

#[tauri::command]
fn auto_install_channel_plugins(
    app: tauri::AppHandle,
    channels: Vec<String>,
    custom_path: Option<String>,
    install_hint: Option<String>,
) -> Result<String, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let _ = ensure_extension_manifest_compat(&openclaw_dir);
    let install_hint_norm = install_hint
        .as_deref()
        .map(|s| s.trim().replace('\\', "/"))
        .filter(|s| !s.is_empty());
    let exe = find_openclaw_executable(install_hint_norm.as_deref().or(Some(openclaw_dir.as_str())))
        .unwrap_or_else(|| "openclaw".to_string());
    let env_extra = Some(("OPENCLAW_STATE_DIR", openclaw_dir.as_str()));

    let mut installed = Vec::new();
    let mut skipped = Vec::new();
    let mut failed = Vec::new();
    let total = channels.len().max(1);
    let mut current = 0usize;

    let emit_progress = |channel: &str, status: &str, message: &str, current_idx: usize| {
        let _ = app.emit(
            "plugin-install-progress",
            json!({
                "channel": channel,
                "status": status,
                "message": message,
                "current": current_idx,
                "total": total
            }),
        );
    };

    for ch in channels {
        let id = ch.trim().to_lowercase();
        current += 1;
        emit_progress(&id, "running", "开始处理渠道插件", current);
        let Some(pkg) = channel_plugin_package(&id) else {
            skipped.push(format!("{}(内置或无需插件)", id));
            emit_progress(&id, "skipped", "内置渠道或无需插件，已跳过", current);
            continue;
        };

        let (list_ok_before, list_out_before, list_err_before) =
            run_openclaw_cmd_clean(&exe, &["plugins", "list"], env_extra)?;
        let list_before = format!("{}\n{}", list_out_before, list_err_before).to_lowercase();
        let pkg_short = pkg.split('/').last().unwrap_or(pkg).to_lowercase();
        if list_ok_before
            && (list_before.contains(&pkg.to_lowercase()) || list_before.contains(&pkg_short))
        {
            skipped.push(format!("{} -> {} (已安装)", id, pkg));
            emit_progress(&id, "skipped", &format!("{} 已安装，跳过", pkg), current);
            continue;
        }

        emit_progress(&id, "running", &format!("正在安装 {}", pkg), current);
        let (ok, out, err) = run_openclaw_cmd_clean(
            &exe,
            &["plugins", "install", &format!("{}@latest", pkg)],
            env_extra,
        )?;
        let lower = format!("{}\n{}", out, err).to_lowercase();
        let duplicate_warn = lower.contains("duplicate plugin id");
        if ok || duplicate_warn {
            installed.push(format!("{} -> {}", id, pkg));
            if duplicate_warn {
                emit_progress(&id, "done", "安装完成（检测到重复插件ID警告，已按已安装处理）", current);
            } else {
                emit_progress(&id, "done", "安装完成", current);
            }
        } else {
            failed.push(format!("{} -> {}\n{}\n{}", id, pkg, out, err));
            emit_progress(&id, "error", "安装失败，请查看详情日志", current);
        }
    }

    let (list_ok, list_out, list_err) = run_openclaw_cmd_clean(&exe, &["plugins", "list"], env_extra)?;
    let verify_text = if list_ok { list_out } else { format!("{}\n{}", list_out, list_err) };

    let mut msg = String::new();
    if !installed.is_empty() {
        msg.push_str(&format!("已安装:\n{}\n\n", installed.join("\n")));
    }
    if !skipped.is_empty() {
        msg.push_str(&format!("已跳过:\n{}\n\n", skipped.join("\n")));
    }
    if !failed.is_empty() {
        msg.push_str(&format!("安装失败:\n{}\n\n", failed.join("\n\n")));
    }
    msg.push_str("插件列表校验:\n");
    msg.push_str(&verify_text);
    if let Ok(n) = ensure_extension_manifest_compat(&openclaw_dir) {
        if n > 0 {
            msg.push_str(&format!("\n\n已自动补齐插件清单文件: {} 项", n));
        }
    }
    let _ = app.emit(
        "plugin-install-progress",
        json!({
            "channel": "summary",
            "status": "done",
            "message": "插件处理完成",
            "current": total,
            "total": total
        }),
    );
    Ok(msg)
}

#[tauri::command]
fn list_skills_catalog(custom_path: Option<String>, install_hint: Option<String>) -> Result<Vec<SkillCatalogItem>, String> {
    let openclaw_dir = resolve_openclaw_dir_for_ops(custom_path.as_deref(), install_hint.as_deref());
    let install_hint_norm = install_hint
        .as_deref()
        .map(|s| s.trim().replace('\\', "/"))
        .filter(|s| !s.is_empty());
    let exe = find_openclaw_executable(install_hint_norm.as_deref().or(Some(openclaw_dir.as_str())))
        .unwrap_or_else(|| "openclaw".to_string());
    let env_extra = Some(("OPENCLAW_STATE_DIR", openclaw_dir.as_str()));
    let out = run_skills_list_json_with_repair(&exe, &openclaw_dir, env_extra)?;
    let parsed: SkillsListResp =
        serde_json::from_str(&out).map_err(|e| format!("解析 skills JSON 失败: {}\n{}", e, out))?;
    let mut items: Vec<SkillCatalogItem> = parsed
        .skills
        .into_iter()
        .map(|s| SkillCatalogItem {
            name: s.name,
            description: s.description.trim().to_string(),
            source: s.source,
            bundled: s.bundled,
            eligible: s.eligible,
            missing: SkillMissing {
                bins: s.missing.bins,
                any_bins: s.missing.any_bins,
                env: s.missing.env,
                config: s.missing.config,
                os: s.missing.os,
            },
        })
        .collect();
    items.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(items)
}

fn summarize_skill_missing(m: &SkillMissing) -> String {
    let mut parts: Vec<String> = Vec::new();
    if !m.bins.is_empty() {
        parts.push(format!("bins:{}", m.bins.join(",")));
    }
    if !m.any_bins.is_empty() {
        parts.push(format!("any:{}", m.any_bins.join(",")));
    }
    if !m.env.is_empty() {
        parts.push(format!("env:{}", m.env.join(",")));
    }
    if !m.config.is_empty() {
        parts.push(format!("cfg:{}", m.config.join(",")));
    }
    if !m.os.is_empty() {
        parts.push(format!("os:{}", m.os.join(",")));
    }
    if parts.is_empty() {
        "无".to_string()
    } else {
        parts.join(" | ")
    }
}

#[tauri::command]
fn repair_selected_skills(
    app: tauri::AppHandle,
    skill_names: Vec<String>,
    custom_path: Option<String>,
    install_hint: Option<String>,
) -> Result<String, String> {
    let openclaw_dir = resolve_openclaw_dir_for_ops(custom_path.as_deref(), install_hint.as_deref());
    let install_hint_norm = install_hint
        .as_deref()
        .map(|s| s.trim().replace('\\', "/"))
        .filter(|s| !s.is_empty());
    let exe = find_openclaw_executable(install_hint_norm.as_deref().or(Some(openclaw_dir.as_str())))
        .unwrap_or_else(|| "openclaw".to_string());
    let env_extra = Some(("OPENCLAW_STATE_DIR", openclaw_dir.as_str()));

    let catalog = list_skills_catalog(Some(openclaw_dir.clone()), install_hint.clone())?;
    let selected: Vec<SkillCatalogItem> = catalog
        .into_iter()
        .filter(|s| skill_names.iter().any(|n| n.eq_ignore_ascii_case(&s.name)))
        .collect();
    let selected_names: Vec<String> = selected.iter().map(|s| s.name.clone()).collect();
    let total = selected.len().max(1);
    let mut idx = 0usize;
    let mut logs: Vec<String> = Vec::new();
    let mut need_plugin_channels: BTreeSet<String> = BTreeSet::new();

    for s in selected {
        idx += 1;
        let _ = app.emit(
            "skills-repair-progress",
            json!({"skill": s.name, "status": "running", "current": idx, "total": total, "message": "分析缺失依赖"}),
        );
        if s.missing.bins.is_empty()
            && s.missing.any_bins.is_empty()
            && s.missing.env.is_empty()
            && s.missing.config.is_empty()
            && s.missing.os.is_empty()
        {
            logs.push(format!("{}: 无缺失依赖", s.name));
            let _ = app.emit(
                "skills-repair-progress",
                json!({"skill": s.name, "status": "done", "current": idx, "total": total, "message": "无缺失依赖"}),
            );
            continue;
        }

        let os_blocked = !s.missing.os.is_empty()
            && s.missing.os.iter().all(|o| {
                let x = o.to_lowercase();
                #[cfg(target_os = "windows")]
                { x != "windows" && x != "win32" }
                #[cfg(target_os = "macos")]
                { x != "darwin" && x != "macos" }
                #[cfg(target_os = "linux")]
                { x != "linux" }
            });
        if os_blocked {
            logs.push(format!("{}: 当前平台不支持（{}），跳过自动修复", s.name, s.missing.os.join(",")));
            let _ = app.emit(
                "skills-repair-progress",
                json!({"skill": s.name, "status": "done", "current": idx, "total": total, "message": "当前平台不支持，已跳过"}),
            );
            continue;
        }

        for b in &s.missing.bins {
            match try_fix_missing_bin(b) {
                Ok(msg) => logs.push(format!("{} -> {}: {}", s.name, b, msg)),
                Err(e) => logs.push(format!("{} -> {}: {}", s.name, b, e)),
            }
        }
        if !s.missing.any_bins.is_empty() {
            let mut fixed_any = false;
            for b in &s.missing.any_bins {
                if let Ok(msg) = try_fix_missing_bin(b) {
                    logs.push(format!("{} -> any({}): {}", s.name, b, msg));
                    fixed_any = true;
                    break;
                }
            }
            if !fixed_any {
                logs.push(format!(
                    "{}: anyBins 无法自动安装，请手动安装其一：{}",
                    s.name,
                    s.missing.any_bins.join(", ")
                ));
            }
        }

        let (i_ok, i_out, i_err) = run_openclaw_cmd_clean(&exe, &["skills", "install", &s.name], env_extra)?;
        if i_ok {
            logs.push(format!("{}: skills install 执行成功", s.name));
        } else {
            let text = format!("{}\n{}", i_out, i_err).to_lowercase();
            if text.contains("already") || text.contains("exists") || text.contains("duplicate") {
                logs.push(format!("{}: skills install 已存在，跳过", s.name));
            } else {
                logs.push(format!("{}: skills install 失败\n{}\n{}", s.name, i_out, i_err));
            }
        }

        for c in &s.missing.config {
            let lower = c.to_lowercase();
            if lower.contains("channels.discord") {
                need_plugin_channels.insert("discord".to_string());
            } else if lower.contains("channels.feishu") {
                need_plugin_channels.insert("feishu".to_string());
            } else if lower.contains("channels.dingtalk") {
                need_plugin_channels.insert("dingtalk".to_string());
            } else if lower.contains("channels.qq") {
                need_plugin_channels.insert("qq".to_string());
            }
            logs.push(format!("{}: 缺少配置 {}", s.name, c));
        }
        for e in &s.missing.env {
            logs.push(format!("{}: 缺少环境变量 {}（需手动填写真实值）", s.name, e));
        }
        for os in &s.missing.os {
            logs.push(format!("{}: 受限平台 {}", s.name, os));
        }
        let _ = app.emit(
            "skills-repair-progress",
            json!({"skill": s.name, "status": "done", "current": idx, "total": total, "message": "修复流程已执行"}),
        );
    }

    if !need_plugin_channels.is_empty() {
        let channels: Vec<String> = need_plugin_channels.into_iter().collect();
        let _ = app.emit(
            "skills-repair-progress",
            json!({"skill": "plugins", "status": "running", "current": total, "total": total, "message": "正在补齐渠道插件"}),
        );
        let plugin_result = auto_install_channel_plugins(app.clone(), channels, Some(openclaw_dir.clone()), install_hint.clone())?;
        logs.push(format!("[渠道插件修复]\n{}", plugin_result));
    }

    let (ck_ok, ck_out, ck_err) = run_openclaw_cmd_clean(&exe, &["skills", "check"], env_extra)?;
    logs.push("[skills check]".to_string());
    logs.push(ck_out);
    if !ck_ok && !ck_err.trim().is_empty() {
        logs.push(ck_err);
    }
    let post_catalog = list_skills_catalog(Some(openclaw_dir.clone()), install_hint.clone()).unwrap_or_default();
    logs.push("\n[修复后状态]".to_string());
    for n in selected_names {
        if let Some(it) = post_catalog.iter().find(|x| x.name.eq_ignore_ascii_case(&n)) {
            if it.eligible {
                logs.push(format!("{}: 可用", it.name));
            } else {
                logs.push(format!(
                    "{}: 仍缺失（自动修复仅覆盖 bins/部分 anyBins） -> {}",
                    it.name,
                    summarize_skill_missing(&it.missing)
                ));
            }
        } else {
            logs.push(format!("{}: 未在当前 skills 列表中找到（可能名称变更）", n));
        }
    }
    let _ = app.emit(
        "skills-repair-progress",
        json!({"skill": "summary", "status": "done", "current": total, "total": total, "message": "全部处理完成"}),
    );
    Ok(logs.join("\n"))
}

#[tauri::command]
fn install_selected_skills(
    app: tauri::AppHandle,
    skill_names: Vec<String>,
    custom_path: Option<String>,
    install_hint: Option<String>,
) -> Result<String, String> {
    let openclaw_dir = resolve_openclaw_dir_for_ops(custom_path.as_deref(), install_hint.as_deref());
    let install_hint_norm = install_hint
        .as_deref()
        .map(|s| s.trim().replace('\\', "/"))
        .filter(|s| !s.is_empty());
    let exe = find_openclaw_executable(install_hint_norm.as_deref().or(Some(openclaw_dir.as_str())))
        .unwrap_or_else(|| "openclaw".to_string());
    let env_extra = Some(("OPENCLAW_STATE_DIR", openclaw_dir.as_str()));

    let selected: Vec<String> = skill_names
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if selected.is_empty() {
        return Ok("未选择任何 Skill".to_string());
    }

    let catalog = list_skills_catalog(Some(openclaw_dir.clone()), install_hint.clone()).unwrap_or_default();
    let selected_names = selected.clone();
    let total = selected.len();
    let mut logs: Vec<String> = Vec::new();
    let mut idx = 0usize;

    for name in selected {
        idx += 1;
        let _ = app.emit(
            "skills-repair-progress",
            json!({"skill": name, "status": "running", "current": idx, "total": total, "message": "安装中"}),
        );
        let info = catalog.iter().find(|s| s.name.eq_ignore_ascii_case(&name));
        let mut done = false;

        // 先尝试 enable（对 bundled / 已安装但未启用的 skill 更稳）
        let (en_ok, en_out, en_err) = run_openclaw_cmd_clean(&exe, &["skills", "enable", &name], env_extra)?;
        if en_ok {
            logs.push(format!("{}: 已启用", name));
            done = true;
        } else {
            let t = format!("{}\n{}", en_out, en_err).to_lowercase();
            if t.contains("already") || t.contains("enabled") || t.contains("not disabled") {
                logs.push(format!("{}: 已启用", name));
                done = true;
            }
        }

        let (ok, out, err) = if done {
            (true, String::new(), String::new())
        } else {
            // 未启用成功则尝试 install（对非 bundled 或未安装 skill）
            let mut r = run_openclaw_cmd_clean(&exe, &["skills", "install", &name], env_extra)?;
            if !r.0 {
                // bundled 再尝试一次 enable 兜底
                if let Some(s) = info {
                    if s.bundled || s.source.to_lowercase().contains("bundled") {
                        let (ok2, out2, err2) = run_openclaw_cmd_clean(&exe, &["skills", "enable", &name], env_extra)?;
                        if ok2 {
                            logs.push(format!("{}: bundled 启用成功（install 失败后兜底）", name));
                            r = (true, out2, err2);
                        }
                    }
                }
            }
            r
        };
        if ok {
            logs.push(format!("{}: 安装完成", name));
        } else {
            let combined = format!("{}\n{}", out, err).to_lowercase();
            if combined.contains("already") || combined.contains("exists") || combined.contains("duplicate") {
                logs.push(format!("{}: 已存在，跳过", name));
            } else {
                logs.push(format!("{}: 安装失败\n{}\n{}", name, out, err));
            }
        }
        let _ = app.emit(
            "skills-repair-progress",
            json!({"skill": name, "status": "done", "current": idx, "total": total, "message": "处理完成"}),
        );
    }

    let _ = app.emit(
        "skills-repair-progress",
        json!({"skill": "summary", "status": "done", "current": total, "total": total, "message": "全部处理完成"}),
    );
    let (ck_ok, ck_out, ck_err) = run_openclaw_cmd_clean(&exe, &["skills", "check"], env_extra)?;
    logs.push("\n[skills check]".to_string());
    logs.push(ck_out);
    if !ck_ok && !ck_err.trim().is_empty() {
        logs.push(ck_err);
    }
    let post_catalog = list_skills_catalog(Some(openclaw_dir.clone()), install_hint.clone()).unwrap_or_default();
    logs.push("\n[安装后状态]".to_string());
    for n in selected_names {
        if let Some(it) = post_catalog.iter().find(|x| x.name.eq_ignore_ascii_case(&n)) {
            if it.eligible {
                logs.push(format!("{}: 可用", it.name));
            } else {
                logs.push(format!(
                    "{}: 仍缺失（可能需要手动配置） -> {}",
                    it.name,
                    summarize_skill_missing(&it.missing)
                ));
            }
        } else {
            logs.push(format!("{}: 未在当前 skills 列表中找到（可能名称变更）", n));
        }
    }
    Ok(logs.join("\n"))
}

#[tauri::command]
fn skills_manage(
    action: String,
    custom_path: Option<String>,
    install_hint: Option<String>,
) -> Result<String, String> {
    let openclaw_dir = resolve_openclaw_dir_for_ops(custom_path.as_deref(), install_hint.as_deref());
    let install_hint_norm = install_hint
        .as_deref()
        .map(|s| s.trim().replace('\\', "/"))
        .filter(|s| !s.is_empty());
    let exe = find_openclaw_executable(install_hint_norm.as_deref().or(Some(openclaw_dir.as_str())))
        .unwrap_or_else(|| "openclaw".to_string());
    let env_extra = Some(("OPENCLAW_STATE_DIR", openclaw_dir.as_str()));
    let act = action.trim().to_lowercase();

    if act == "list" {
        let (ok1, out1, err1) = run_openclaw_cmd_clean(&exe, &["skills", "list"], env_extra)?;
        let (ok2, out2, err2) = run_openclaw_cmd_clean(&exe, &["skills", "check"], env_extra)?;
        let mut msg = String::new();
        msg.push_str("=== 已安装/可用 Skills ===\n");
        msg.push_str(&out1);
        if !ok1 && !err1.trim().is_empty() {
            msg.push_str("\n[skills list stderr]\n");
            msg.push_str(&err1);
        }
        msg.push_str("\n\n=== 依赖检查 ===\n");
        msg.push_str(&out2);
        if !ok2 && !err2.trim().is_empty() {
            msg.push_str("\n[skills check stderr]\n");
            msg.push_str(&err2);
        }
        return Ok(msg);
    }

    let verb = match act.as_str() {
        "install" => "安装",
        "update" => "更新",
        "reinstall" => "重装",
        _ => "执行",
    };
    let _ = create_config_snapshot(&openclaw_dir, "pre-skills-manage");
    let onboard_args = [
        "onboard",
        "--non-interactive",
        "--accept-risk",
        "--mode",
        "local",
        "--auth-choice",
        "skip",
        "--node-manager",
        "npm",
        "--skip-channels",
        "--skip-daemon",
        "--skip-health",
        "--skip-ui",
    ];
    let (ok, out, err) = run_openclaw_cmd_clean(&exe, &onboard_args, env_extra)?;
    let (ck_ok, ck_out, ck_err) = run_openclaw_cmd_clean(&exe, &["skills", "check"], env_extra)?;
    let mut msg = format!("Skills {}结果: {}\n\n", verb, if ok { "成功" } else { "失败" });
    msg.push_str("[onboard 输出]\n");
    msg.push_str(&out);
    if !err.trim().is_empty() {
        msg.push_str("\n[onboard 错误]\n");
        msg.push_str(&err);
    }
    msg.push_str("\n\n[skills check]\n");
    msg.push_str(&ck_out);
    if !ck_ok && !ck_err.trim().is_empty() {
        msg.push_str("\n[skills check 错误]\n");
        msg.push_str(&ck_err);
    }
    Ok(msg)
}

#[tauri::command]
fn run_self_check(custom_path: Option<String>, install_hint: Option<String>) -> Result<Vec<SelfCheckItem>, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let install_hint_norm = install_hint
        .as_deref()
        .map(|s| s.trim().replace('\\', "/"))
        .filter(|s| !s.is_empty());
    let exe = find_openclaw_executable(install_hint_norm.as_deref().or(Some(openclaw_dir.as_str())))
        .unwrap_or_else(|| "openclaw".to_string());
    let env_extra = Some(("OPENCLAW_STATE_DIR", openclaw_dir.as_str()));
    let mut items: Vec<SelfCheckItem> = Vec::new();

    let (g_ok, g_out, g_err) = run_openclaw_cmd_clean(&exe, &["gateway", "status"], env_extra)?;
    let g_text = format!("{}\n{}", g_out, g_err).to_lowercase();
    let gateway_healthy = g_text.contains("rpc probe: ok")
        || g_text.contains("listening:")
        || g_text.contains("service: scheduled task (registered)")
        || g_text.contains("running")
        || g_text.contains("online");
    let gateway_status = if g_ok && gateway_healthy {
        "ok"
    } else if g_ok {
        "warn"
    } else {
        "error"
    };
    items.push(SelfCheckItem {
        key: "gateway".to_string(),
        label: "Gateway".to_string(),
        status: gateway_status.to_string(),
        detail: format!("{}\n{}", g_out, g_err).trim().to_string(),
    });

    let model_res = probe_runtime_model_connection(Some(openclaw_dir.clone()))
        .unwrap_or_else(|e| format!("探活失败: {}", e));
    let model_status = if model_res.contains("通过") {
        "ok"
    } else if model_res.contains("失败") || model_res.contains("error") {
        "error"
    } else {
        "warn"
    };
    items.push(SelfCheckItem {
        key: "model".to_string(),
        label: "模型连通".to_string(),
        status: model_status.to_string(),
        detail: model_res,
    });

    let configured_channels = configured_channels_from_files(&openclaw_dir);
    let (p_ok, p_out, p_err) = run_openclaw_cmd_clean(&exe, &["plugins", "list"], env_extra)?;
    let p_all = format!("{}\n{}", p_out, p_err).to_lowercase();
    let mut missing: Vec<String> = Vec::new();
    for ch in &configured_channels {
        if let Some(pkg) = channel_plugin_package(ch) {
            if !p_all.contains(&pkg.to_lowercase()) {
                missing.push(format!("{}({})", ch, pkg));
            }
        }
    }
    let plugin_status = if !p_ok {
        "warn"
    } else if missing.is_empty() {
        "ok"
    } else {
        "error"
    };
    let plugin_detail = if !p_ok {
        format!("插件列表读取失败：{}\n{}", p_out, p_err)
    } else if missing.is_empty() {
        "渠道插件完整".to_string()
    } else {
        format!("缺少插件：{}", missing.join(", "))
    };
    items.push(SelfCheckItem {
        key: "plugins".to_string(),
        label: "渠道插件".to_string(),
        status: plugin_status.to_string(),
        detail: plugin_detail,
    });

    #[cfg(target_os = "windows")]
    let port_info = {
        let mut cmd = Command::new("powershell");
        hide_console_window(&mut cmd);
        let out = cmd.args([
            "-NoProfile",
            "-Command",
            "Get-NetTCPConnection -LocalPort 18789 -ErrorAction SilentlyContinue | Select-Object -First 1 -Property State,OwningProcess | ConvertTo-Json -Compress",
        ]).output();
        match out {
            Ok(o) => {
                let txt = decode_console_output(&o.stdout);
                if txt.trim().is_empty() {
                    ("warn".to_string(), "端口 18789 未监听".to_string())
                } else {
                    ("ok".to_string(), format!("端口 18789 已监听: {}", txt.trim()))
                }
            }
            Err(e) => ("warn".to_string(), format!("端口检测失败: {}", e)),
        }
    };
    #[cfg(not(target_os = "windows"))]
    let port_info = ("unknown".to_string(), "当前平台未实现端口检测".to_string());
    items.push(SelfCheckItem {
        key: "port".to_string(),
        label: "端口占用".to_string(),
        status: port_info.0,
        detail: port_info.1,
    });

    let consistency = check_config_path_consistency(Some(openclaw_dir.clone()))?;
    let consistent = consistency
        .get("consistent")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let suggestion = consistency
        .get("suggestion")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    items.push(SelfCheckItem {
        key: "config".to_string(),
        label: "配置路径一致性".to_string(),
        status: if consistent { "ok".to_string() } else { "error".to_string() },
        detail: if suggestion.is_empty() {
            "配置路径一致".to_string()
        } else {
            suggestion.to_string()
        },
    });

    let (v_ok, v_out, v_err) = run_openclaw_cmd_clean(&exe, &["--version"], env_extra)?;
    let version_text = v_out.trim().to_string();
    let mut version_status = if v_ok && !version_text.is_empty() {
        "ok".to_string()
    } else if v_ok {
        "warn".to_string()
    } else {
        "error".to_string()
    };
    let mut version_detail = if version_text.is_empty() {
        format!("版本读取输出为空\n{}", v_err.trim())
    } else {
        format!("当前版本: {}", version_text)
    };
    let (_s_ok, s_out, s_err) = run_openclaw_cmd_clean(&exe, &["status"], env_extra)?;
    let status_all = format!("{}\n{}", s_out, s_err).to_lowercase();
    if status_all.contains("update available") || status_all.contains("latest") && status_all.contains("current v") {
        if version_status == "ok" {
            version_status = "warn".to_string();
        }
        version_detail.push_str("\n检测到可能存在更新，建议执行升级并重启 Gateway。");
    }
    items.push(SelfCheckItem {
        key: "version".to_string(),
        label: "版本一致性".to_string(),
        status: version_status,
        detail: version_detail,
    });
    Ok(items)
}

#[tauri::command]
fn run_minimal_repair(
    custom_path: Option<String>,
    install_hint: Option<String>,
) -> Result<String, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let install_hint_norm = install_hint
        .as_deref()
        .map(|s| s.trim().replace('\\', "/"))
        .filter(|s| !s.is_empty());
    let exe = find_openclaw_executable(install_hint_norm.as_deref().or(Some(openclaw_dir.as_str())))
        .unwrap_or_else(|| "openclaw".to_string());
    let env_extra = Some(("OPENCLAW_STATE_DIR", openclaw_dir.as_str()));

    let mut logs: Vec<String> = Vec::new();
    logs.push(format!("配置目录: {}", openclaw_dir));

    // 1) manifest 补齐
    match ensure_extension_manifest_compat_details(&openclaw_dir) {
        Ok(fixed) => logs.push(format!(
            "manifest补齐: {}",
            if fixed.is_empty() {
                "无变更".to_string()
            } else {
                format!("已修复 {} 项 [{}]", fixed.len(), fixed.join(", "))
            }
        )),
        Err(e) => logs.push(format!("manifest补齐失败: {}", e)),
    }

    // 2) 配置清理（针对插件残留）
    let mut clean_removed = 0usize;
    if let Ok((ok, out, err)) = run_openclaw_cmd_clean(&exe, &["skills", "list", "--json"], env_extra) {
        if !ok {
            clean_removed = sanitize_invalid_plugin_manifest_refs(&openclaw_dir, &format!("{}\n{}", out, err))
                .unwrap_or(0);
        }
    }
    logs.push(format!("配置清理: removed_entries={}", clean_removed));

    // 3) plugins 校验
    let (p_ok, p_out, p_err) = run_openclaw_cmd_clean(&exe, &["plugins", "list"], env_extra)?;
    logs.push(format!("plugins校验: {}", if p_ok { "ok" } else { "error" }));
    if !p_ok && !p_err.trim().is_empty() {
        logs.push(format!("plugins错误: {}", p_err.trim()));
    }
    if p_ok && !p_out.trim().is_empty() {
        logs.push(format!("plugins摘要: {}", p_out.lines().next().unwrap_or("ok")));
    }

    // 4) skills check
    let (s_ok, s_out, s_err) = run_openclaw_cmd_clean(&exe, &["skills", "check"], env_extra)?;
    logs.push(format!("skills check: {}", if s_ok { "ok" } else { "error" }));
    if !s_err.trim().is_empty() {
        logs.push(format!("skills错误: {}", s_err.trim()));
    } else if !s_out.trim().is_empty() {
        logs.push(format!("skills摘要: {}", s_out.lines().next().unwrap_or("ok")));
    }

    // 5) gateway 自检
    let self_check = run_self_check(Some(openclaw_dir.clone()), install_hint.clone())?;
    let mut bad = Vec::new();
    for item in &self_check {
        if item.status != "ok" {
            bad.push(format!("{}={}", item.key, item.status));
        }
    }
    logs.push(format!(
        "gateway自检: {}",
        if bad.is_empty() {
            "全部正常".to_string()
        } else {
            format!("存在异常 [{}]", bad.join(", "))
        }
    ));

    Ok(logs.join("\n"))
}

#[tauri::command]
fn fix_self_check_item(
    key: String,
    custom_path: Option<String>,
    install_hint: Option<String>,
) -> Result<String, String> {
    let k = key.trim().to_lowercase();
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let install_hint_norm = install_hint
        .as_deref()
        .map(|s| s.trim().replace('\\', "/"))
        .filter(|s| !s.is_empty());
    let exe = find_openclaw_executable(install_hint_norm.as_deref().or(Some(openclaw_dir.as_str())))
        .unwrap_or_else(|| "openclaw".to_string());
    let env_extra = Some(("OPENCLAW_STATE_DIR", openclaw_dir.as_str()));

    match k.as_str() {
        "gateway" => start_gateway(Some(openclaw_dir.clone()), install_hint.clone()),
        "model" => probe_runtime_model_connection(Some(openclaw_dir.clone())),
        "plugins" => {
            let channels = configured_channels_from_files(&openclaw_dir);
            let mut installed = Vec::new();
            let mut skipped = Vec::new();
            for ch in channels {
                let id = ch.trim().to_lowercase();
                let Some(pkg) = channel_plugin_package(&id) else {
                    skipped.push(format!("{}(内置或无需插件)", id));
                    continue;
                };
                let (ok, out, err) = run_openclaw_cmd_clean(
                    &exe,
                    &["plugins", "install", &format!("{}@latest", pkg)],
                    env_extra,
                )?;
                let lower = format!("{}\n{}", out, err).to_lowercase();
                if ok || lower.contains("duplicate plugin id") {
                    installed.push(format!("{} -> {}", id, pkg));
                } else {
                    return Err(format!("插件修复失败: {}\n{}\n{}", pkg, out, err));
                }
            }
            Ok(format!(
                "插件修复完成\n已安装/处理:\n{}\n\n已跳过:\n{}",
                if installed.is_empty() { "(无)".to_string() } else { installed.join("\n") },
                if skipped.is_empty() { "(无)".to_string() } else { skipped.join("\n") }
            ))
        }
        "port" => {
            let _ = run_openclaw_cmd_clean(&exe, &["gateway", "stop"], env_extra);
            thread::sleep(Duration::from_secs(2));
            start_gateway(Some(openclaw_dir.clone()), install_hint.clone())
        }
        "config" => {
            patch_gateway_cmd_state_dir(&openclaw_dir);
            let _ = run_openclaw_cmd_clean(&exe, &["gateway", "install", "--force"], env_extra);
            Ok("已尝试修复配置路径并重装 Gateway 任务".to_string())
        }
        "version" => {
            let _ = run_openclaw_cmd_clean(&exe, &["gateway", "install", "--force"], env_extra);
            let _ = run_openclaw_cmd_clean(&exe, &["gateway", "stop"], env_extra);
            thread::sleep(Duration::from_secs(2));
            start_gateway(Some(openclaw_dir.clone()), install_hint.clone())
        }
        _ => Err("未知修复项".to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            check_node,
            check_npm,
            check_git,
            check_openclaw,
            install_openclaw,
            install_openclaw_full,
            recommended_install_dir,
            get_openclaw_dir,
            write_env_config,
            cleanup_legacy_provider_cache,
            discover_available_models,
            read_env_config,
            test_model_connection,
            probe_runtime_model_connection,
            start_gateway,
            start_gateway_foreground,
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
            get_channel_config_status,
            remove_channel_config,
            get_gateway_auth_token,
            get_gateway_dashboard_url,
            reset_gateway_auth_and_restart,
            read_runtime_model_info,
            read_key_sync_status,
            test_channel_connection,
            list_pairings,
            approve_pairing,
            open_external_url,
            fix_node,
            fix_npm,
            fix_git,
            fix_openclaw,
            check_npm_path_in_user_env,
            add_npm_to_path,
            check_config_path_consistency,
            detect_openclaw_config_path,
            run_self_check,
            run_minimal_repair,
            fix_self_check_item,
            auto_install_channel_plugins,
            skills_manage,
            export_diagnostic_bundle,
            list_config_snapshots,
            rollback_config_snapshot,
            list_skills_catalog,
            repair_selected_skills,
            install_selected_skills,
            run_startup_migrations,
            memory_center_status,
            memory_center_read,
            memory_center_clear,
            memory_center_export,
            memory_center_bootstrap,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
