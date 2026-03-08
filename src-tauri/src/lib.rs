use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::collections::HashMap;
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
use zip::ZipArchive;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

mod domain;
mod repo;
mod services;

use crate::domain::models::{
    AgentCapability, AuditEvent, CostSummary, DebateResult, GraphEdge, GraphNode, MemoryRecord,
    OrchestratorTask, PromptPolicyVersion, RoleBinding, SandboxPreview, SkillGraph, TaskSnapshot,
    UnifiedTicket, VerifierReport,
};

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

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
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
    #[serde(default)]
    pub source_type: String,
    pub bundled: bool,
    pub eligible: bool,
    pub missing: SkillMissing,
    #[serde(default)]
    pub repo_url: Option<String>,
    #[serde(default)]
    pub package_name: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub verified: bool,
    #[serde(default)]
    pub install_method: Option<String>,
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
    if let Some(v) = custom_path
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.replace('\\', "/"))
    {
        return v;
    }

    // 未显式指定路径时，优先跟随 Gateway 实际使用的 OPENCLAW_STATE_DIR，
    // 避免“软件内对话”和“浏览器/Telegram”使用不同配置目录。
    if let Ok(Some(detected)) = detect_openclaw_config_path() {
        return detected;
    }

    let home = env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    format!("{}/.openclaw", home.replace('\\', "/"))
}

fn resolve_runtime_chat_dir(custom_path: Option<&str>, prefer_gateway_dir: bool) -> String {
    // 同步模式下优先跟随 Gateway 目录；隔离模式则使用当前客户端配置路径。
    if prefer_gateway_dir {
        if let Ok(Some(detected)) = detect_openclaw_config_path() {
            return detected;
        }
    }
    resolve_openclaw_dir(custom_path)
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

fn set_default_agent_for_gateway(root: &mut Value, agent_id: &str) {
    let target = agent_id.trim();
    if target.is_empty() {
        return;
    }
    let Some(list) = root
        .get_mut("agents")
        .and_then(|a| a.get_mut("list"))
        .and_then(|l| l.as_array_mut())
    else {
        return;
    };
    for item in list.iter_mut() {
        let Some(obj) = item.as_object_mut() else { continue };
        let is_target = obj
            .get("id")
            .and_then(|v| v.as_str())
            .map(|id| id.trim().eq_ignore_ascii_case(target))
            .unwrap_or(false);
        obj.insert("default".to_string(), Value::Bool(is_target));
    }
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
    // Telegram 在国内网络常见 Node fetch 连接不稳定，默认强制 IPv4 优先并关闭 autoSelectFamily。
    let network = ch_obj
        .entry("network".to_string())
        .or_insert_with(|| json!({}));
    if !network.is_object() {
        *network = json!({});
    }
    if let Some(net_obj) = network.as_object_mut() {
        net_obj
            .entry("autoSelectFamily".to_string())
            .or_insert_with(|| json!(false));
        net_obj
            .entry("dnsResultOrder".to_string())
            .or_insert_with(|| json!("ipv4first"));
    }

    // 若未配置 telegram.proxy，自动探测本机常见代理端口并注入。
    let has_proxy = ch_obj
        .get("proxy")
        .and_then(|v| v.as_str())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    if !has_proxy {
        if let Some(proxy) = detect_local_http_proxy() {
            ch_obj.insert("proxy".to_string(), json!(proxy));
        }
    }
    ch_obj.insert("streaming".to_string(), json!("off"));

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

fn detect_local_http_proxy() -> Option<String> {
    use std::net::{SocketAddr, TcpStream};
    let ports = [7890_u16, 10809_u16, 20171_u16, 9090_u16];
    for port in ports {
        let addr: SocketAddr = format!("127.0.0.1:{}", port).parse().ok()?;
        if TcpStream::connect_timeout(&addr, Duration::from_millis(180)).is_ok() {
            return Some(format!("http://127.0.0.1:{}", port));
        }
    }
    None
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
        // 强制 open 模式，避免 pairing 导致“发了不回”（需先批准配对码）
        ch_obj.insert("dmPolicy".to_string(), json!("open"));
        ensure_telegram_open_requirements(ch_obj);
    }
    // 避免 Telegram 出现“同一条输入回复两次”的体验：显式把 Telegram 队列策略固定为 collect。
    if !root.is_object() {
        *root = json!({});
    }
    let obj = root.as_object_mut().expect("root object");
    let messages = obj.entry("messages".to_string()).or_insert_with(|| json!({}));
    if !messages.is_object() {
        *messages = json!({});
    }
    let queue = messages
        .as_object_mut()
        .expect("messages object")
        .entry("queue".to_string())
        .or_insert_with(|| json!({}));
    if !queue.is_object() {
        *queue = json!({});
    }
    let by_channel = queue
        .as_object_mut()
        .expect("queue object")
        .entry("byChannel".to_string())
        .or_insert_with(|| json!({}));
    if !by_channel.is_object() {
        *by_channel = json!({});
    }
    by_channel
        .as_object_mut()
        .expect("byChannel object")
        .insert("telegram".to_string(), json!("collect"));
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

fn normalize_agents_schema(root: &mut Value) {
    if let Some(agents_obj) = root
        .as_object_mut()
        .and_then(|obj| obj.get_mut("agents"))
        .and_then(|v| v.as_object_mut())
    {
        // 兼容旧版本：当前版本 schema 不支持 agents.bindings
        agents_obj.remove("bindings");
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

fn channel_storage_aliases(channel: &str) -> Vec<String> {
    let id = channel.trim().to_ascii_lowercase();
    match id.as_str() {
        "qq" | "qqbot" => vec!["qqbot".to_string(), "qq".to_string()],
        _ => vec![id],
    }
}

fn channel_primary_storage_key(channel: &str) -> String {
    channel_storage_aliases(channel)
        .into_iter()
        .next()
        .unwrap_or_else(|| channel.trim().to_ascii_lowercase())
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
            let mut cmd = Command::new("cmd");
            hide_console_window(&mut cmd);
            // 关键修复：不要把整条命令拼成字符串（会破坏 JSON 参数中的引号，导致 gateway call 拆参错误）。
            // 改为参数分离传递，让系统按 argv 精确传递每个参数。
            cmd.arg("/c").arg(&exe_abs).args(args);
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

fn run_command_clean(cmd: &mut Command) -> Result<(bool, String, String), String> {
    let output = cmd.output().map_err(|e| format!("执行失败: {}", e))?;
    let stdout = strip_ansi_text(&decode_console_output(&output.stdout));
    let stderr = strip_ansi_text(&decode_console_output(&output.stderr));
    Ok((output.status.success(), stdout, stderr))
}

fn run_npm_exec_cmd_clean(pkg: &str, args: &[&str]) -> Result<(bool, String, String), String> {
    let mut exec_args: Vec<&str> = vec!["exec", "--yes", pkg, "--"];
    exec_args.extend_from_slice(args);
    let output = run_npm_cmd(&exec_args).map_err(|e| format!("执行失败: {}", e))?;
    let stdout = strip_ansi_text(&decode_console_output(&output.stdout));
    let stderr = strip_ansi_text(&decode_console_output(&output.stderr));
    Ok((output.status.success(), stdout, stderr))
}

fn run_clawhub_cmd_clean(openclaw_dir: &str, args: &[&str]) -> Result<(bool, String, String), String> {
    let mut full_args: Vec<&str> = vec!["--workdir", openclaw_dir, "--dir", "skills"];
    full_args.extend_from_slice(args);
    run_npm_exec_cmd_clean("clawhub", &full_args)
}

fn parse_clawhub_search_slugs(stdout: &str, limit: usize) -> Vec<String> {
    let re = Regex::new(r"^([A-Za-z0-9][A-Za-z0-9._-]*)\s{2,}.+\(([0-9.]+)\)\s*$").unwrap();
    stdout
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            let caps = re.captures(trimmed)?;
            caps.get(1).map(|m| m.as_str().to_string())
        })
        .take(limit)
        .collect()
}

fn parse_skill_name_from_skill_md(skill_md_path: &Path) -> Option<String> {
    let txt = std::fs::read_to_string(skill_md_path).ok()?;
    for line in txt.lines().take(40) {
        let trimmed = line.trim();
        if let Some(name) = trimmed.strip_prefix("name:") {
            let value = name.trim().trim_matches('"').trim_matches('\'').trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn find_skill_root(path: &Path) -> Option<PathBuf> {
    if !path.exists() {
        return None;
    }
    if path.is_file() {
        return path
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| name.eq_ignore_ascii_case("SKILL.md"))
            .and_then(|_| path.parent().map(|parent| parent.to_path_buf()));
    }
    let skill_md = path.join("SKILL.md");
    if skill_md.exists() {
        return Some(path.to_path_buf());
    }
    let entries = std::fs::read_dir(path).ok()?;
    for entry in entries.flatten() {
        let child = entry.path();
        if child.is_dir() {
            if let Some(hit) = find_skill_root(&child) {
                return Some(hit);
            }
        } else if child
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.eq_ignore_ascii_case("SKILL.md"))
            .unwrap_or(false)
        {
            return child.parent().map(|parent| parent.to_path_buf());
        }
    }
    None
}

fn copy_dir_recursive(source: &Path, target: &Path) -> Result<(), String> {
    std::fs::create_dir_all(target).map_err(|e| format!("创建目录失败: {}", e))?;
    let entries = std::fs::read_dir(source).map_err(|e| format!("读取目录失败: {}", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取目录项失败: {}", e))?;
        let src_path = entry.path();
        let dst_path = target.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            if let Some(parent) = dst_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
            }
            std::fs::copy(&src_path, &dst_path).map_err(|e| format!("复制文件失败: {}", e))?;
        }
    }
    Ok(())
}

fn extract_zip_to_dir(zip_path: &Path, dest_dir: &Path) -> Result<(), String> {
    let file = std::fs::File::open(zip_path).map_err(|e| format!("打开 ZIP 失败: {}", e))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("解析 ZIP 失败: {}", e))?;
    for idx in 0..archive.len() {
        let mut entry = archive
            .by_index(idx)
            .map_err(|e| format!("读取 ZIP 条目失败: {}", e))?;
        let Some(rel_path) = entry.enclosed_name().map(|p| p.to_path_buf()) else {
            continue;
        };
        let out_path = dest_dir.join(rel_path);
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| format!("创建目录失败: {}", e))?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
        }
        let mut out_file = std::fs::File::create(&out_path).map_err(|e| format!("写入 ZIP 内容失败: {}", e))?;
        std::io::copy(&mut entry, &mut out_file).map_err(|e| format!("解压 ZIP 失败: {}", e))?;
    }
    Ok(())
}

fn install_skill_dir_into_shared_layer(source_dir: &Path, skills_dir: &Path) -> Result<String, String> {
    let skill_md = source_dir.join("SKILL.md");
    if !skill_md.exists() {
        return Err("未找到 SKILL.md，无法识别为有效 Skill".to_string());
    }
    let skill_name = parse_skill_name_from_skill_md(&skill_md)
        .or_else(|| source_dir.file_name().and_then(|name| name.to_str()).map(|s| s.to_string()))
        .filter(|name| !name.trim().is_empty())
        .ok_or_else(|| "无法确定 Skill 名称".to_string())?;
    let target_dir = skills_dir.join(&skill_name);
    if target_dir.exists() {
        std::fs::remove_dir_all(&target_dir).map_err(|e| format!("覆盖已有 Skill 失败: {}", e))?;
    }
    copy_dir_recursive(source_dir, &target_dir)?;
    Ok(format!("已安装本地 Skill 到共享层：{}", target_dir.to_string_lossy()))
}

fn inspect_clawhub_skill(openclaw_dir: &str, slug: &str) -> Option<SkillCatalogItem> {
    let (ok, stdout, stderr) = run_clawhub_cmd_clean(openclaw_dir, &["inspect", slug]).ok()?;
    if !ok {
        let detail = format!("{}\n{}", stdout, stderr);
        return Some(SkillCatalogItem {
            name: slug.to_string(),
            description: detail.trim().to_string(),
            source: "ClawHub".to_string(),
            source_type: "clawhub".to_string(),
            bundled: false,
            eligible: false,
            missing: SkillMissing::default(),
            repo_url: None,
            package_name: Some(slug.to_string()),
            version: None,
            author: None,
            verified: false,
            install_method: Some("clawhub_install".to_string()),
        });
    }
    let mut title = slug.to_string();
    let mut description = String::new();
    let mut owner = None;
    let mut version = None;
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("- ") {
            continue;
        }
        if !trimmed.contains(':') && trimmed.split_whitespace().count() >= 2 {
            let mut parts = trimmed.split_whitespace();
            if let Some(first) = parts.next() {
                title = parts.collect::<Vec<_>>().join(" ");
                if title.is_empty() {
                    title = first.to_string();
                }
            }
            continue;
        }
        if let Some(v) = trimmed.strip_prefix("Summary:") {
            description = v.trim().to_string();
        } else if let Some(v) = trimmed.strip_prefix("Owner:") {
            owner = Some(v.trim().to_string());
        } else if let Some(v) = trimmed.strip_prefix("Latest:") {
            version = Some(v.trim().to_string());
        }
    }
    Some(SkillCatalogItem {
        name: title,
        description,
        source: "ClawHub".to_string(),
        source_type: "clawhub".to_string(),
        bundled: false,
        eligible: false,
        missing: SkillMissing::default(),
        repo_url: None,
        package_name: Some(slug.to_string()),
        version,
        author: owner.clone(),
        verified: owner
            .as_deref()
            .map(|v| v.eq_ignore_ascii_case("openclaw"))
            .unwrap_or(false),
        install_method: Some("clawhub_install".to_string()),
    })
}

#[derive(Debug, Deserialize)]
struct GithubRepoOwner {
    login: String,
}

#[derive(Debug, Deserialize)]
struct GithubRepoItem {
    full_name: String,
    html_url: String,
    description: Option<String>,
    stargazers_count: u64,
    owner: GithubRepoOwner,
}

#[derive(Debug, Deserialize)]
struct GithubSearchResponse {
    items: Vec<GithubRepoItem>,
}

fn search_github_skill_repos(query: &str, limit: usize) -> Vec<SkillCatalogItem> {
    let trimmed = query.trim();
    if trimmed.is_empty() || limit == 0 {
        return Vec::new();
    }
    #[cfg(target_os = "windows")]
    {
        let escaped = trimmed.replace('\'', "''");
        let ps = format!(
            "$q=[uri]::EscapeDataString('{} openclaw skill'); $u='https://api.github.com/search/repositories?q='+$q+'&sort=stars&order=desc&per_page={}'; Invoke-RestMethod -Headers @{{'User-Agent'='openclaw-deploy'}} -Uri $u | ConvertTo-Json -Depth 8 -Compress",
            escaped,
            limit
        );
        let mut cmd = Command::new("powershell");
        hide_console_window(&mut cmd);
        cmd.args(["-NoProfile", "-Command", &ps]);
        let Ok((ok, stdout, _stderr)) = run_command_clean(&mut cmd) else {
            return Vec::new();
        };
        if !ok || stdout.trim().is_empty() {
            return Vec::new();
        }
        let Ok(parsed) = serde_json::from_str::<GithubSearchResponse>(&stdout) else {
            return Vec::new();
        };
        return parsed
            .items
            .into_iter()
            .map(|item| SkillCatalogItem {
                name: item.full_name.clone(),
                description: item.description.unwrap_or_else(|| format!("GitHub 仓库 · {} stars", item.stargazers_count)),
                source: "GitHub".to_string(),
                source_type: "github".to_string(),
                bundled: false,
                eligible: false,
                missing: SkillMissing::default(),
                repo_url: Some(item.html_url),
                package_name: Some(item.full_name),
                version: None,
                author: Some(item.owner.login),
                verified: false,
                install_method: Some("git_clone".to_string()),
            })
            .collect();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (query, limit);
        Vec::new()
    }
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

#[cfg(target_os = "windows")]
fn cleanup_duplicate_gateway_processes() -> Vec<String> {
    let mut killed = Vec::<String>::new();
    let mut cmd = Command::new("powershell");
    hide_console_window(&mut cmd);
    let script = "$ErrorActionPreference='SilentlyContinue'; \
Get-CimInstance Win32_Process | \
Where-Object { ($_.Name -match '^(node|cmd|powershell)\\.exe$') -and $_.CommandLine -and (($_.CommandLine -match 'openclaw\\s+gateway') -or ($_.CommandLine -match 'gateway\\.cmd')) } | \
Select-Object ProcessId, Name, CommandLine | ConvertTo-Json -Compress";
    let out = match cmd.args(["-NoProfile", "-Command", script]).output() {
        Ok(v) => v,
        Err(_) => return killed,
    };
    if !out.status.success() {
        return killed;
    }
    let txt = decode_console_output(&out.stdout);
    if txt.trim().is_empty() || txt.trim() == "null" {
        return killed;
    }
    let val: Value = match serde_json::from_str(&txt) {
        Ok(v) => v,
        Err(_) => return killed,
    };
    let mut pids: Vec<u32> = Vec::new();
    let push_pid = |v: &Value, pids: &mut Vec<u32>| {
        if let Some(pid) = v.get("ProcessId").and_then(|x| x.as_u64()) {
            let pid_u32 = pid as u32;
            if pid_u32 > 0 && pid_u32 != std::process::id() {
                pids.push(pid_u32);
            }
        }
    };
    if let Some(arr) = val.as_array() {
        for it in arr {
            push_pid(it, &mut pids);
        }
    } else {
        push_pid(&val, &mut pids);
    }
    pids.sort_unstable();
    pids.dedup();
    for pid in pids {
        let mut kill_cmd = Command::new("cmd");
        hide_console_window(&mut kill_cmd);
        if let Ok(k) = kill_cmd.args(["/c", "taskkill", "/PID", &pid.to_string(), "/F"]).output() {
            if k.status.success() {
                killed.push(format!("已清理重复 Gateway 进程 PID {}", pid));
            }
        }
    }
    killed
}

#[cfg(not(target_os = "windows"))]
fn cleanup_duplicate_gateway_processes() -> Vec<String> {
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
            normalize_agents_schema(&mut root);
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
    let cleaned_gateway_pids = cleanup_duplicate_gateway_processes();
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
        if !cleaned_gateway_pids.is_empty() {
            msg.push_str("\n\n[重复进程清理]");
            for item in &cleaned_gateway_pids {
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

#[derive(Clone, Serialize)]
struct GatewayStartEvent {
    ok: bool,
    message: String,
}

#[tauri::command]
fn start_gateway_background(
    app: tauri::AppHandle,
    custom_path: Option<String>,
    install_hint: Option<String>,
) -> Result<String, String> {
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let payload = match start_gateway(custom_path, install_hint) {
            Ok(message) => GatewayStartEvent { ok: true, message },
            Err(message) => GatewayStartEvent { ok: false, message },
        };
        let _ = app_handle.emit("gateway-start-finished", payload);
    });
    Ok("已切到后台启动 Gateway，界面可继续操作；完成后会自动回填结果。".to_string())
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
    let url = get_gateway_dashboard_url(custom_path, None)?;
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
    let primary_key = channel_primary_storage_key(&channel);
    let aliases = channel_storage_aliases(&channel);
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
    for alias in &aliases {
        obj.remove(alias);
    }
    obj.insert(primary_key.clone(), effective_config.clone());
    std::fs::write(
        &config_path,
        serde_json::to_string_pretty(&root).map_err(|e| format!("序列化失败: {}", e))?,
    )
    .map_err(|e| format!("写入配置失败: {}", e))?;
    // 同步写入 OpenClaw 真正读取的 openclaw.json（仅内置渠道）
    if is_builtin_channel_for_openclaw(&channel) {
        let mut openclaw_root = load_openclaw_config(&openclaw_dir)?;
        ensure_channel_in_openclaw_config(&mut openclaw_root, &channel, effective_config);
        if channel == "telegram" {
            normalize_openclaw_config_for_telegram(&mut openclaw_root);
        }
        normalize_agents_schema(&mut openclaw_root);
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
            primary_key, openclaw_dir, tip
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
            let cred_ok =
                non_empty(obj.get("clientSecret")) || non_empty(obj.get("token")) || non_empty(obj.get("appSecret"));
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
        let aliases = channel_storage_aliases(id);
        let ch = aliases
            .iter()
            .find_map(|key| chs.get(key).or_else(|| chs_legacy.get(key)).cloned())
            .unwrap_or(json!({}));
        result.insert(id.to_string(), json!(is_channel_configured(id, &ch)));
    }
    Ok(Value::Object(result))
}

#[tauri::command]
fn remove_channel_config(channel: String, custom_path: Option<String>) -> Result<String, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let aliases = channel_storage_aliases(&channel);
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
            let mut removed_any = false;
            for key in &aliases {
                if chs.remove(key).is_some() {
                    removed_any = true;
                }
            }
            if removed_any {
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
            let mut removed_any = false;
            for key in &aliases {
                if obj.remove(key).is_some() {
                    removed_any = true;
                }
            }
            if removed_any {
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
    let aliases = channel_storage_aliases(&channel);
    let channels_path = format!("{}/channels.json", openclaw_dir.replace('\\', "/"));
    if Path::new(&channels_path).exists() {
        let txt = std::fs::read_to_string(&channels_path)
            .map_err(|e| format!("读取 channels.json 失败: {}", e))?;
        if let Ok(root) = serde_json::from_str::<Value>(&txt) {
            if let Some(obj) = root.as_object() {
                for key in &aliases {
                    if let Some(v) = obj.get(key).cloned() {
                        return Ok(v);
                    }
                }
            }
        }
    }

    let root = load_openclaw_config(&openclaw_dir).unwrap_or_else(|_| json!({}));
    let fallback = root
        .as_object()
        .and_then(|obj| obj.get("channels"))
        .and_then(|chs| chs.as_object())
        .and_then(|chs| aliases.iter().find_map(|key| chs.get(key).cloned()))
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
fn get_gateway_dashboard_url(custom_path: Option<String>, gateway_id: Option<String>) -> Result<String, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let token = get_gateway_auth_token(custom_path)?;
    let port = if let Some(gid_raw) = gateway_id.as_deref() {
        let gid = sanitize_gateway_key(gid_raw);
        let settings = load_agent_runtime_settings(&openclaw_dir)?;
        find_gateway_binding(&settings, &gid)
            .and_then(|g| g.listen_port)
            .unwrap_or(18789)
    } else {
        18789
    };
    Ok(format!("http://127.0.0.1:{}/?token={}", port, token))
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
        return Ok(format!(
            "{} 配置已识别；当前 OpenClaw 版本对该渠道不提供可靠的在线连通性验证，平台侧仍可能提示离线（例如“去火星”）。如需稳定对话，建议安装对应插件后再验证，或优先使用 Telegram。",
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
            let client_secret = obj
                .get("clientSecret")
                .and_then(|v| v.as_str())
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);
            let app_secret = obj.get("appSecret").and_then(|v| v.as_str()).map(|s| !s.trim().is_empty()).unwrap_or(false);
            app_id && (token || client_secret || app_secret)
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
fn list_pairings_json(channel: String, custom_path: Option<String>) -> Result<Value, String> {
    let cfg = custom_path
        .as_deref()
        .map(|s| s.trim().replace('\\', "/"))
        .filter(|s| !s.is_empty());
    let exe = find_openclaw_executable(cfg.as_deref()).unwrap_or_else(|| "openclaw".to_string());
    let env_extra = cfg.as_ref().map(|s| ("OPENCLAW_STATE_DIR", s.as_str()));
    let (ok, stdout, stderr) =
        run_openclaw_cmd_clean(&exe, &["pairing", "list", channel.as_str(), "--json"], env_extra)?;
    if !ok {
        return Err(format!("查询配对失败:\n{}\n{}", stdout, stderr));
    }
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Ok(json!({ "channel": channel, "requests": [] }));
    }
    serde_json::from_str(trimmed).map_err(|e| format!("解析配对列表 JSON 失败: {}\n{}", e, stdout))
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
fn fix_telegram_dm_policy(custom_path: Option<String>) -> Result<String, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let mut root = load_openclaw_config(&openclaw_dir).map_err(|e| e.to_string())?;
    normalize_openclaw_config_for_telegram(&mut root);
    normalize_agents_schema(&mut root);
    save_openclaw_config(&openclaw_dir, &root).map_err(|e| e.to_string())?;
    Ok("Telegram 已切换为 open 模式（无需配对即可对话）。请点击「启动 Gateway」或重启 Gateway 使配置生效。".to_string())
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

fn ensure_channel_plugins_installed(
    channels: &[String],
    openclaw_dir: &str,
    install_hint: Option<String>,
) -> Result<Vec<String>, String> {
    let _ = ensure_extension_manifest_compat(openclaw_dir);
    let install_hint_norm = install_hint
        .as_deref()
        .map(|s| s.trim().replace('\\', "/"))
        .filter(|s| !s.is_empty());
    let exe = find_openclaw_executable(install_hint_norm.as_deref().or(Some(openclaw_dir)))
        .unwrap_or_else(|| "openclaw".to_string());
    let env_extra = Some(("OPENCLAW_STATE_DIR", openclaw_dir));
    let mut changed = Vec::new();

    for channel in channels {
        let id = normalize_channel_id(channel);
        let Some(pkg) = channel_plugin_package(&id) else {
            continue;
        };
        let (list_ok_before, list_out_before, list_err_before) =
            run_openclaw_cmd_clean(&exe, &["plugins", "list"], env_extra)?;
        let list_before = format!("{}\n{}", list_out_before, list_err_before).to_lowercase();
        let pkg_short = pkg.split('/').last().unwrap_or(pkg).to_lowercase();
        if list_ok_before
            && (list_before.contains(&pkg.to_lowercase()) || list_before.contains(&pkg_short))
        {
            continue;
        }

        let (ok, out, err) = run_openclaw_cmd_clean(
            &exe,
            &["plugins", "install", &format!("{}@latest", pkg)],
            env_extra,
        )?;
        let lower = format!("{}\n{}", out, err).to_lowercase();
        if ok || lower.contains("duplicate plugin id") {
            changed.push(format!("{} -> {}", id, pkg));
            continue;
        }
        return Err(format!("安装渠道插件失败({} -> {}): {}\n{}", id, pkg, out, err));
    }

    Ok(changed)
}

fn gateway_install_stamp_path(state_dir: &str) -> PathBuf {
    Path::new(state_dir).join(".gateway-installed")
}

fn gateway_start_requires_reinstall(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("program not found")
        || lower.contains("not recognized as an internal or external command")
        || lower.contains("系统找不到指定的文件")
        || lower.contains("no such file or directory")
        || lower.contains("gateway service missing")
        || lower.contains("gateway install")
        || lower.contains("schtasks")
}

fn ensure_gateway_service_installed(
    exe: &str,
    state_dir: &str,
    gateway_id: &str,
    port: Option<u16>,
) -> Result<bool, String> {
    let stamp_path = gateway_install_stamp_path(state_dir);
    if stamp_path.exists() {
        return Ok(false);
    }
    let (ok, out, err) =
        run_openclaw_gateway_cmd_clean(exe, &["gateway", "install", "--force"], state_dir, gateway_id, port)?;
    if !ok {
        return Err(format!("安装网关服务失败: {}\n{}", out, err));
    }
    let stamp = format!(
        "installed_at={}\ngateway_id={}\nport={}\n",
        now_stamp(),
        gateway_id,
        port.map(|v| v.to_string()).unwrap_or_default()
    );
    let _ = std::fs::write(stamp_path, stamp);
    Ok(true)
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
            source_type: "shared".to_string(),
            bundled: s.bundled,
            eligible: s.eligible,
            missing: SkillMissing {
                bins: s.missing.bins,
                any_bins: s.missing.any_bins,
                env: s.missing.env,
                config: s.missing.config,
                os: s.missing.os,
            },
            repo_url: None,
            package_name: None,
            version: None,
            author: None,
            verified: false,
            install_method: None,
        })
        .collect();
    items.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(items)
}

#[tauri::command]
async fn search_market_skills(
    query: String,
    custom_path: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<SkillCatalogItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
        let q = query.trim().to_string();
        if q.is_empty() {
            return Err("请输入要搜索的 Skills 关键词".to_string());
        }
        let max_results = limit.unwrap_or(12).clamp(1, 20);
        let mut results = search_github_skill_repos(&q, max_results);

        match run_clawhub_cmd_clean(&openclaw_dir, &["search", "--limit", &max_results.to_string(), &q]) {
            Ok((ok, stdout, stderr)) => {
                let combined = format!("{}\n{}", stdout, stderr).to_lowercase();
                if ok || (!stdout.trim().is_empty() && !combined.contains("rate limit exceeded")) {
                    for slug in parse_clawhub_search_slugs(&stdout, 3) {
                        if let Some(item) = inspect_clawhub_skill(&openclaw_dir, &slug) {
                            results.push(item);
                        }
                    }
                }
            }
            Err(_) => {
                // 桌面端缺 PATH 时静默降级为 GitHub 搜索。
            }
        }

        let mut seen = BTreeSet::new();
        results.retain(|item| {
            let key = format!(
                "{}:{}",
                item.source_type.to_lowercase(),
                item.package_name
                    .clone()
                    .unwrap_or_else(|| item.name.clone())
                    .to_lowercase()
            );
            seen.insert(key)
        });
        if results.is_empty() {
            return Err("没有找到可用的第三方 Skills 结果。ClawHub 可能被限流，建议直接下载 ZIP 后走“本地 Skills 安装”。".to_string());
        }
        Ok(results)
    })
    .await
    .map_err(|e| format!("搜索任务执行失败: {}", e))?
}

#[tauri::command]
async fn install_market_skill(
    source_type: String,
    package_name: Option<String>,
    repo_url: Option<String>,
    version: Option<String>,
    custom_path: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
        let skills_dir = Path::new(&openclaw_dir).join("skills");
        std::fs::create_dir_all(&skills_dir).map_err(|e| format!("创建 skills 目录失败: {}", e))?;
        let source = source_type.trim().to_lowercase();

        if source == "clawhub" {
            let slug = package_name
                .as_deref()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "缺少 ClawHub skill 标识".to_string())?;
            let mut args = vec!["install", slug.as_str()];
            let version_value = version
                .as_deref()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            if let Some(ref v) = version_value {
                args.push("--version");
                args.push(v.as_str());
            }
            let (ok, stdout, stderr) = run_clawhub_cmd_clean(&openclaw_dir, &args)?;
            if ok {
                return Ok(format!("已安装到共享 Skills 层\n{}", stdout));
            }
            let combined = format!("{}\n{}", stdout, stderr).to_lowercase();
            if combined.contains("rate limit exceeded") {
                return Err("ClawHub 当前限流，建议到网站下载 ZIP 后使用“本地 Skills 安装”导入。".to_string());
            }
            return Err(format!("ClawHub 安装失败:\n{}\n{}", stdout, stderr));
        }

        if source == "github" {
            let repo = repo_url
                .as_deref()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "缺少 GitHub 仓库地址".to_string())?;
            let folder_name = package_name
                .as_deref()
                .and_then(|s| s.split('/').last())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "github-skill".to_string());
            let target_dir = skills_dir.join(folder_name);
            if target_dir.exists() {
                return Ok(format!("共享 Skills 层已存在该仓库：{}", target_dir.to_string_lossy()));
            }
            let mut cmd = Command::new("git");
            hide_console_window(&mut cmd);
            cmd.args([
                "clone",
                "--depth",
                "1",
                repo.as_str(),
                target_dir.to_string_lossy().as_ref(),
            ]);
            let (ok, stdout, stderr) = run_command_clean(&mut cmd)?;
            if ok {
                return Ok(format!("已克隆到共享 Skills 层\n{}\n{}", target_dir.to_string_lossy(), stdout));
            }
            return Err(format!("GitHub 仓库安装失败:\n{}\n{}", stdout, stderr));
        }

        Err(format!("暂不支持的来源类型: {}", source_type))
    })
    .await
    .map_err(|e| format!("安装任务执行失败: {}", e))?
}

#[tauri::command]
async fn install_local_skill(
    local_path: String,
    custom_path: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let src = local_path.trim();
        if src.is_empty() {
            return Err("请先提供本地 Skill 目录或 ZIP 路径".to_string());
        }
        let source_path = PathBuf::from(src);
        if !source_path.exists() {
            return Err(format!("本地路径不存在: {}", src));
        }

        let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
        let skills_dir = Path::new(&openclaw_dir).join("skills");
        std::fs::create_dir_all(&skills_dir).map_err(|e| format!("创建共享 Skills 目录失败: {}", e))?;

        let mut extracted_temp_dir: Option<PathBuf> = None;
        let skill_root = if source_path.is_dir() {
            find_skill_root(&source_path)
                .ok_or_else(|| "所选目录中未找到 SKILL.md，请确认它是一个完整 Skill 目录".to_string())?
        } else {
            let ext = source_path
                .extension()
                .and_then(|ext| ext.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if ext != "zip" {
                return Err("当前只支持本地 Skill 目录或 .zip 压缩包".to_string());
            }
            let temp_dir = env::temp_dir().join(format!("openclaw-skill-import-{}", now_stamp().replace(':', "-")));
            std::fs::create_dir_all(&temp_dir).map_err(|e| format!("创建临时目录失败: {}", e))?;
            extract_zip_to_dir(&source_path, &temp_dir)?;
            let root = find_skill_root(&temp_dir)
                .ok_or_else(|| "ZIP 中未找到 SKILL.md，请确认压缩包内容完整".to_string())?;
            extracted_temp_dir = Some(temp_dir);
            root
        };

        let result = install_skill_dir_into_shared_layer(&skill_root, &skills_dir)?;
        if let Some(temp_dir) = extracted_temp_dir {
            let _ = std::fs::remove_dir_all(temp_dir);
        }
        Ok(result)
    })
    .await
    .map_err(|e| format!("本地安装任务执行失败: {}", e))?
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

// ========== Agents (多 Agent 管理) ==========

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInfo {
    pub id: String,
    pub name: Option<String>,
    pub default: bool,
    pub workspace: Option<String>,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BindingRule {
    pub channel: String,
    pub agent_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peer: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentsListResponse {
    pub agents: Vec<AgentInfo>,
    pub bindings: Vec<BindingRule>,
    pub config_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRuntimeProfile {
    pub agent_id: String,
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentSkillBinding {
    pub agent_id: String,
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub enabled_skills: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub isolated_state_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentChannelRoute {
    pub id: String,
    pub channel: String,
    pub agent_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gateway_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bot_instance: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peer: Option<String>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GatewayRuntimeHealth {
    pub status: String,
    pub detail: String,
    pub checked_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GatewayBinding {
    pub gateway_id: String,
    pub agent_id: String,
    pub channel: String,
    pub instance_id: String,
    #[serde(default)]
    pub channel_instances: BTreeMap<String, String>,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub listen_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(default)]
    pub auto_restart: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health: Option<GatewayRuntimeHealth>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelegramBotInstance {
    pub id: String,
    pub name: String,
    pub bot_token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_id: Option<String>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelBotInstance {
    pub id: String,
    pub name: String,
    pub channel: String,
    pub credential1: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential2: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_id: Option<String>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentRuntimeSettings {
    #[serde(default)]
    pub schema_version: u32,
    #[serde(default)]
    pub profiles: Vec<AgentRuntimeProfile>,
    #[serde(default)]
    pub channel_routes: Vec<AgentChannelRoute>,
    #[serde(default)]
    pub telegram_instances: Vec<TelegramBotInstance>,
    #[serde(default)]
    pub active_telegram_instance: Option<String>,
    #[serde(default)]
    pub channel_instances: Vec<ChannelBotInstance>,
    #[serde(default)]
    pub active_channel_instances: BTreeMap<String, String>,
    #[serde(default)]
    pub gateways: Vec<GatewayBinding>,
    #[serde(default)]
    pub skills_scope: String,
    #[serde(default)]
    pub agent_skill_bindings: Vec<AgentSkillBinding>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRuntimeSettingsResponse {
    pub schema_version: u32,
    pub profiles: Vec<AgentRuntimeProfile>,
    pub channel_routes: Vec<AgentChannelRoute>,
    pub telegram_instances: Vec<TelegramBotInstance>,
    pub active_telegram_instance: Option<String>,
    pub channel_instances: Vec<ChannelBotInstance>,
    pub active_channel_instances: BTreeMap<String, String>,
    pub gateways: Vec<GatewayBinding>,
    pub skills_scope: String,
    pub agent_skill_bindings: Vec<AgentSkillBinding>,
    pub settings_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRouteResolveResult {
    pub agent_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gateway_id: Option<String>,
    pub matched_route_id: Option<String>,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelegramInstanceHealth {
    pub id: String,
    pub ok: bool,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelInstanceHealth {
    pub channel: String,
    pub id: String,
    pub ok: bool,
    pub detail: String,
}

fn agent_runtime_settings_path(openclaw_dir: &str) -> String {
    format!(
        "{}/control_plane/agent_runtime_settings.json",
        openclaw_dir.replace('\\', "/")
    )
}

fn runtime_now_ts() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(v) => v.as_secs() as i64,
        Err(_) => 0,
    }
}

fn sanitize_gateway_key(s: &str) -> String {
    s.trim()
        .to_ascii_lowercase()
        .replace([' ', '/', '\\', ':'], "-")
}

fn gateway_default_id(channel: &str, instance_id: &str) -> String {
    format!(
        "gw-{}-{}",
        sanitize_gateway_key(channel),
        sanitize_gateway_key(instance_id)
    )
}

fn gateway_default_id_for_agent(agent_id: &str) -> String {
    format!("gw-agent-{}", sanitize_gateway_key(agent_id))
}

fn gateway_default_state_dir(openclaw_dir: &str, gateway_id: &str) -> String {
    format!(
        "{}/multi_gateways/{}",
        openclaw_dir.replace('\\', "/"),
        sanitize_gateway_key(gateway_id)
    )
}

fn normalize_gateway_binding(openclaw_dir: &str, g: &mut GatewayBinding) {
    g.gateway_id = if g.gateway_id.trim().is_empty() {
        gateway_default_id(&g.channel, &g.instance_id)
    } else {
        sanitize_gateway_key(&g.gateway_id)
    };
    g.channel = normalize_channel_id(&g.channel);
    g.agent_id = g.agent_id.trim().to_string();
    g.instance_id = g.instance_id.trim().to_string();
    let mut normalized_map = BTreeMap::new();
    for (ch, iid) in g.channel_instances.clone() {
        let ch_norm = normalize_channel_id(&ch);
        let iid_norm = iid.trim().to_string();
        if ch_norm.is_empty() || iid_norm.is_empty() {
            continue;
        }
        normalized_map.insert(ch_norm, iid_norm);
    }
    if normalized_map.is_empty() && !g.channel.is_empty() && !g.instance_id.is_empty() {
        normalized_map.insert(g.channel.clone(), g.instance_id.clone());
    }
    g.channel_instances = normalized_map;
    if (g.channel.is_empty() || g.instance_id.is_empty()) && !g.channel_instances.is_empty() {
        if let Some((ch, iid)) = g.channel_instances.iter().next() {
            g.channel = ch.clone();
            g.instance_id = iid.clone();
        }
    }
    if g.state_dir.as_deref().map(|v| v.trim().is_empty()).unwrap_or(true) {
        g.state_dir = Some(gateway_default_state_dir(openclaw_dir, &g.gateway_id));
    } else {
        g.state_dir = g
            .state_dir
            .as_deref()
            .map(|v| v.trim().replace('\\', "/"))
            .filter(|v| !v.is_empty());
    }
    if g.listen_port.is_none() {
        let seed = g
            .gateway_id
            .as_bytes()
            .iter()
            .fold(0usize, |acc, b| acc.wrapping_add(*b as usize));
        g.listen_port = Some((42000 + (seed % 3000)) as u16);
    }
    if g.health.is_none() {
        g.health = Some(GatewayRuntimeHealth {
            status: "unknown".to_string(),
            detail: "未探活".to_string(),
            checked_at: runtime_now_ts(),
        });
    }
}

fn gateway_channel_pairs(binding: &GatewayBinding) -> Vec<(String, String)> {
    if !binding.channel_instances.is_empty() {
        return binding
            .channel_instances
            .iter()
            .map(|(ch, iid)| (normalize_channel_id(ch), iid.trim().to_string()))
            .filter(|(ch, iid)| !ch.is_empty() && !iid.is_empty())
            .collect();
    }
    let ch = normalize_channel_id(&binding.channel);
    let iid = binding.instance_id.trim().to_string();
    if ch.is_empty() || iid.is_empty() {
        Vec::new()
    } else {
        vec![(ch, iid)]
    }
}

fn infer_agent_id_from_instance_id(channel: &str, instance_id: &str) -> Option<String> {
    let ch = normalize_channel_id(channel);
    let iid = instance_id.trim();
    if ch.is_empty() || iid.is_empty() {
        return None;
    }
    let prefix = if ch == "telegram" {
        "tg-".to_string()
    } else {
        format!("{}-", ch)
    };
    iid.strip_prefix(prefix.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn derive_agent_gateway_channel_map(settings: &AgentRuntimeSettings, agent_id: &str) -> BTreeMap<String, String> {
    let aid = agent_id.trim();
    if aid.is_empty() {
        return BTreeMap::new();
    }

    let mut out = BTreeMap::new();

    for r in settings.channel_routes.iter().filter(|r| r.enabled && r.agent_id.trim() == aid) {
        let ch = normalize_channel_id(&r.channel);
        let iid = r
            .bot_instance
            .as_deref()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        if let Some(iid) = iid {
            if !ch.is_empty() {
                out.entry(ch).or_insert(iid);
            }
        }
    }

    for g in settings.gateways.iter().filter(|g| g.agent_id.trim() == aid) {
        for (ch, iid) in gateway_channel_pairs(g) {
            let inferred = infer_agent_id_from_instance_id(&ch, &iid);
            let derived = derive_gateway_agent_id(settings, &ch, &iid);
            let belongs_to_agent = inferred
                .as_deref()
                .map(|v| v == aid)
                .unwrap_or(false)
                || derived == aid;
            if belongs_to_agent {
                out.entry(ch).or_insert(iid);
            }
        }
    }

    let tg_fallback = format!("tg-{}", aid);
    if !out.contains_key("telegram")
        && settings
            .telegram_instances
            .iter()
            .any(|x| x.enabled && x.id.trim().eq_ignore_ascii_case(tg_fallback.as_str()))
    {
        out.insert("telegram".to_string(), tg_fallback);
    }

    for ch in ["feishu", "dingtalk", "discord", "qq"] {
        let iid = format!("{}-{}", ch, aid);
        if out.contains_key(ch) {
            continue;
        }
        if settings.channel_instances.iter().any(|x| {
            x.enabled
                && normalize_channel_id(&x.channel) == ch
                && x.id.trim().eq_ignore_ascii_case(iid.as_str())
        }) {
            out.insert(ch.to_string(), iid);
        }
    }

    if !out.contains_key("telegram") {
        if let Some(iid) = settings
            .active_telegram_instance
            .as_deref()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
        {
            if derive_gateway_agent_id(settings, "telegram", &iid) == aid {
                out.insert("telegram".to_string(), iid);
            }
        }
    }

    for (channel, iid_raw) in settings.active_channel_instances.iter() {
        let ch = normalize_channel_id(channel);
        let iid = iid_raw.trim().to_string();
        if ch.is_empty() || iid.is_empty() || out.contains_key(&ch) {
            continue;
        }
        if derive_gateway_agent_id(settings, &ch, &iid) == aid {
            out.insert(ch, iid);
        }
    }

    out
}

fn reconcile_gateways_per_agent(openclaw_dir: &str, settings: &mut AgentRuntimeSettings) {
    let mut ordered_agent_ids = Vec::new();
    let mut seen = BTreeSet::new();

    let mut push_agent = |aid_raw: &str| {
        let aid = aid_raw.trim().to_string();
        if aid.is_empty() || seen.contains(&aid) {
            return;
        }
        seen.insert(aid.clone());
        ordered_agent_ids.push(aid);
    };

    for g in settings.gateways.iter() {
        push_agent(&g.agent_id);
    }
    for r in settings.channel_routes.iter() {
        push_agent(&r.agent_id);
    }
    for p in settings.profiles.iter() {
        push_agent(&p.agent_id);
    }

    let old_gateways = settings.gateways.clone();
    let mut merged = Vec::new();

    for aid in ordered_agent_ids {
        let related: Vec<GatewayBinding> = old_gateways
            .iter()
            .filter(|g| g.agent_id.trim() == aid)
            .cloned()
            .collect();
        let channel_map = derive_agent_gateway_channel_map(settings, &aid);
        if channel_map.is_empty() && related.is_empty() {
            continue;
        }

        let gateway_id = related
            .iter()
            .find_map(|g| {
                let gid = sanitize_gateway_key(&g.gateway_id);
                if gid.starts_with("gw-agent-") {
                    Some(gid)
                } else {
                    None
                }
            })
            .or_else(|| {
                related.iter().find_map(|g| {
                    let gid = sanitize_gateway_key(&g.gateway_id);
                    if gid.is_empty() {
                        None
                    } else {
                        Some(gid)
                    }
                })
            })
            .unwrap_or_else(|| gateway_default_id_for_agent(&aid));

        let primary_pair = channel_map
            .iter()
            .next()
            .map(|(ch, iid)| (ch.clone(), iid.clone()))
            .or_else(|| {
                related
                    .iter()
                    .flat_map(gateway_channel_pairs)
                    .next()
            });
        let (channel, instance_id) = primary_pair.unwrap_or_else(|| ("telegram".to_string(), "".to_string()));

        let mut next = GatewayBinding {
            gateway_id,
            agent_id: aid.clone(),
            channel,
            instance_id,
            channel_instances: channel_map,
            enabled: if related.is_empty() {
                true
            } else {
                related.iter().any(|g| g.enabled)
            },
            state_dir: related.iter().find_map(|g| g.state_dir.clone()),
            listen_port: related.iter().find_map(|g| g.listen_port),
            pid: related.iter().find_map(|g| g.pid),
            auto_restart: if related.is_empty() {
                true
            } else {
                related.iter().any(|g| g.auto_restart)
            },
            last_error: related.iter().find_map(|g| g.last_error.clone()),
            health: related.iter().find_map(|g| g.health.clone()),
        };
        normalize_gateway_binding(openclaw_dir, &mut next);
        merged.push(next);
    }

    settings.gateways = merged;
}

fn derive_gateway_agent_id(settings: &AgentRuntimeSettings, channel: &str, instance_id: &str) -> String {
    settings
        .channel_routes
        .iter()
        .find(|r| {
            r.enabled
                && normalize_channel_id(&r.channel) == channel
                && r
                    .bot_instance
                    .as_deref()
                    .map(|s| s.trim().eq_ignore_ascii_case(instance_id))
                    .unwrap_or(false)
        })
        .map(|r| r.agent_id.trim().to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| infer_agent_id_from_instance_id(channel, instance_id))
        .unwrap_or_else(|| "main".to_string())
}

fn normalize_runtime_settings_v2(openclaw_dir: &str, settings: &mut AgentRuntimeSettings) {
    if settings.schema_version < 3 {
        settings.schema_version = 3;
    }

    let scope = settings.skills_scope.trim().to_lowercase();
    settings.skills_scope = if scope == "agent_override" {
        "agent_override".to_string()
    } else {
        "shared".to_string()
    };

    let mut skill_binding_seen = BTreeSet::new();
    settings.agent_skill_bindings.retain_mut(|binding| {
        binding.agent_id = binding.agent_id.trim().to_string();
        if binding.agent_id.is_empty() {
            return false;
        }
        let key = binding.agent_id.to_lowercase();
        if skill_binding_seen.contains(&key) {
            return false;
        }
        skill_binding_seen.insert(key);
        let mode = binding.mode.trim().to_lowercase();
        binding.mode = if mode == "custom" { "custom".to_string() } else { "inherit".to_string() };
        let mut dedup = BTreeSet::new();
        binding.enabled_skills = binding
            .enabled_skills
            .iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .filter(|s| dedup.insert(s.to_lowercase()))
            .collect();
        binding.enabled_skills.sort();
        binding.isolated_state_dir = binding
            .isolated_state_dir
            .as_deref()
            .map(|s| s.trim().replace('\\', "/"))
            .filter(|s| !s.is_empty());
        true
    });

    for it in settings.channel_instances.iter_mut() {
        let ch = normalize_channel_id(&it.channel);
        if ch == "qq" {
            it.credential1 = it.credential1.trim().to_string();
            it.credential2 = it
                .credential2
                .as_deref()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            if let Some(c2) = it.credential2.clone() {
                let prefix = format!("{}:", it.credential1);
                if !it.credential1.is_empty() && c2.starts_with(&prefix) {
                    it.credential2 = Some(c2[prefix.len()..].to_string());
                }
            }
        }
    }

    if settings.gateways.is_empty() {
        if let Some(tg) = settings
            .active_telegram_instance
            .as_deref()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
        {
            settings.gateways.push(GatewayBinding {
                gateway_id: gateway_default_id("telegram", &tg),
                agent_id: derive_gateway_agent_id(settings, "telegram", &tg),
                channel: "telegram".to_string(),
                instance_id: tg,
                channel_instances: BTreeMap::new(),
                enabled: true,
                state_dir: None,
                listen_port: None,
                pid: None,
                auto_restart: true,
                last_error: None,
                health: None,
            });
        }
        for (channel, instance_id) in settings.active_channel_instances.clone() {
            let ch = normalize_channel_id(&channel);
            let iid = instance_id.trim().to_string();
            if ch.is_empty() || iid.is_empty() {
                continue;
            }
            settings.gateways.push(GatewayBinding {
                gateway_id: gateway_default_id(&ch, &iid),
                agent_id: derive_gateway_agent_id(settings, &ch, &iid),
                channel: ch,
                instance_id: iid,
                channel_instances: BTreeMap::new(),
                enabled: true,
                state_dir: None,
                listen_port: None,
                pid: None,
                auto_restart: true,
                last_error: None,
                health: None,
            });
        }
    }

    // v2 增强：即使已有 gateways，也要从已启用路由里补齐缺失的 bot_instance 绑定，
    // 避免“只存在 active_telegram_instance 导致其它实例无网关”的情况。
    let route_snapshots: Vec<(String, String, String)> = settings
        .channel_routes
        .iter()
        .filter(|r| r.enabled)
        .filter_map(|r| {
            let ch = normalize_channel_id(&r.channel);
            let aid = r.agent_id.trim().to_string();
            let iid = r
                .bot_instance
                .as_deref()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())?;
            if ch.is_empty() {
                return None;
            }
            Some((ch, aid, iid))
        })
        .collect();
    for (ch, fallback_agent, instance_id) in route_snapshots {
        let _ = upsert_gateway_binding(
            settings,
            openclaw_dir,
            &ch,
            &instance_id,
            if fallback_agent.is_empty() { None } else { Some(fallback_agent.as_str()) },
        );
    }

    let mut dedup = BTreeSet::new();
    settings.gateways.retain(|g| {
        let key = sanitize_gateway_key(&g.gateway_id);
        if key.is_empty() || dedup.contains(&key) {
            return false;
        }
        dedup.insert(key);
        true
    });
    for g in settings.gateways.iter_mut() {
        normalize_gateway_binding(openclaw_dir, g);
    }
    reconcile_gateways_per_agent(openclaw_dir, settings);
}

fn build_agent_runtime_settings_response(
    openclaw_dir: &str,
    settings: AgentRuntimeSettings,
) -> AgentRuntimeSettingsResponse {
    AgentRuntimeSettingsResponse {
        schema_version: settings.schema_version,
        profiles: settings.profiles,
        channel_routes: settings.channel_routes,
        telegram_instances: settings.telegram_instances,
        active_telegram_instance: settings.active_telegram_instance,
        channel_instances: settings.channel_instances,
        active_channel_instances: settings.active_channel_instances,
        gateways: settings.gateways,
        skills_scope: settings.skills_scope,
        agent_skill_bindings: settings.agent_skill_bindings,
        settings_path: agent_runtime_settings_path(openclaw_dir),
    }
}

fn sync_legacy_fields_from_gateways(settings: &mut AgentRuntimeSettings) {
    let mut active_by_channel = BTreeMap::new();
    for g in settings.gateways.iter().filter(|g| g.enabled) {
        for (ch, iid) in gateway_channel_pairs(g) {
            if ch.is_empty() || iid.trim().is_empty() {
                continue;
            }
            active_by_channel.entry(ch).or_insert(iid);
        }
    }
    settings.active_telegram_instance = active_by_channel.get("telegram").cloned();
    settings.active_channel_instances = active_by_channel
        .into_iter()
        .filter(|(ch, _)| ch != "telegram")
        .collect();
}

fn upsert_gateway_binding(
    settings: &mut AgentRuntimeSettings,
    openclaw_dir: &str,
    channel: &str,
    instance_id: &str,
    fallback_agent: Option<&str>,
) -> String {
    let ch = normalize_channel_id(channel);
    let iid = instance_id.trim().to_string();
    let gid = gateway_default_id(&ch, &iid);
    let aid = fallback_agent
        .map(|s| s.trim().to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| infer_agent_id_from_instance_id(&ch, &iid))
        .unwrap_or_else(|| derive_gateway_agent_id(settings, &ch, &iid));
    if let Some(existing) = settings.gateways.iter_mut().find(|g| g.gateway_id == gid) {
        existing.agent_id = aid.clone();
        existing.channel = ch.clone();
        existing.instance_id = iid.clone();
        existing.enabled = true;
        normalize_gateway_binding(openclaw_dir, existing);
        return gid;
    }
    let mut next = GatewayBinding {
        gateway_id: gid.clone(),
        agent_id: aid,
        channel: ch,
        instance_id: iid,
        channel_instances: BTreeMap::new(),
        enabled: true,
        state_dir: None,
        listen_port: None,
        pid: None,
        auto_restart: true,
        last_error: None,
        health: None,
    };
    normalize_gateway_binding(openclaw_dir, &mut next);
    settings.gateways.push(next);
    gid
}

fn find_gateway_binding_mut<'a>(settings: &'a mut AgentRuntimeSettings, gateway_id: &str) -> Option<&'a mut GatewayBinding> {
    let gid = sanitize_gateway_key(gateway_id);
    settings
        .gateways
        .iter_mut()
        .find(|g| sanitize_gateway_key(&g.gateway_id) == gid)
}

fn find_gateway_binding<'a>(settings: &'a AgentRuntimeSettings, gateway_id: &str) -> Option<&'a GatewayBinding> {
    let gid = sanitize_gateway_key(gateway_id);
    settings
        .gateways
        .iter()
        .find(|g| sanitize_gateway_key(&g.gateway_id) == gid)
}

fn run_openclaw_gateway_cmd_clean(
    exe: &str,
    args: &[&str],
    state_dir: &str,
    gateway_id: &str,
    listen_port: Option<u16>,
) -> Result<(bool, String, String), String> {
    let mut cmd = Command::new(exe);
    #[cfg(target_os = "windows")]
    hide_console_window(&mut cmd);
    cmd.args(args);
    cmd.env("OPENCLAW_STATE_DIR", state_dir);
    cmd.env("OPENCLAW_PROFILE", sanitize_gateway_key(gateway_id));
    if let Some(port) = listen_port {
        cmd.env("OPENCLAW_GATEWAY_PORT", port.to_string());
    }
    let output = cmd.output().map_err(|e| format!("执行失败: {}", e))?;
    let stdout = strip_ansi_text(&decode_console_output(&output.stdout));
    let stderr = strip_ansi_text(&decode_console_output(&output.stderr));
    Ok((output.status.success(), stdout, stderr))
}

fn read_gateway_health_with_state_dir(exe: &str, state_dir: &str, gateway_id: &str) -> GatewayRuntimeHealth {
    match run_openclaw_gateway_cmd_clean(exe, &["gateway", "status"], state_dir, gateway_id, None) {
        Ok((ok, out, err)) => {
            let text = format!("{}\n{}", out, err).trim().to_string();
            let lower = text.to_ascii_lowercase();
            let healthy = ok
                && (lower.contains("rpc probe: ok")
                    || lower.contains("service: scheduled task")
                    || lower.contains("running"));
            GatewayRuntimeHealth {
                status: if healthy { "ok" } else { "warn" }.to_string(),
                detail: if text.is_empty() {
                    if healthy {
                        "gateway 正常".to_string()
                    } else {
                        "gateway 状态未知".to_string()
                    }
                } else {
                    text
                },
                checked_at: runtime_now_ts(),
            }
        }
        Err(e) => GatewayRuntimeHealth {
            status: "error".to_string(),
            detail: e,
            checked_at: runtime_now_ts(),
        },
    }
}

fn update_gateway_runtime_snapshot(
    settings: &mut AgentRuntimeSettings,
    gateway_id: &str,
    health: GatewayRuntimeHealth,
    last_error: Option<String>,
) {
    if let Some(g) = find_gateway_binding_mut(settings, gateway_id) {
        g.health = Some(health);
        g.last_error = last_error;
        if g.health.as_ref().map(|h| h.status.as_str() == "error").unwrap_or(false) {
            g.pid = None;
        }
    }
}

fn load_agent_runtime_settings(openclaw_dir: &str) -> Result<AgentRuntimeSettings, String> {
    let path = agent_runtime_settings_path(openclaw_dir);
    if !Path::new(&path).exists() {
        return Ok(AgentRuntimeSettings::default());
    }
    let txt = std::fs::read_to_string(&path).map_err(|e| format!("读取 Agent 运行时配置失败: {}", e))?;
    let mut parsed = serde_json::from_str::<AgentRuntimeSettings>(&txt)
        .map_err(|e| format!("解析 Agent 运行时配置失败: {}", e))?;
    normalize_runtime_settings_v2(openclaw_dir, &mut parsed);
    Ok(parsed)
}

fn save_agent_runtime_settings(openclaw_dir: &str, settings: &AgentRuntimeSettings) -> Result<(), String> {
    let path = agent_runtime_settings_path(openclaw_dir);
    if let Some(parent) = Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建 Agent 运行时配置目录失败: {}", e))?;
    }
    let mut normalized = settings.clone();
    normalize_runtime_settings_v2(openclaw_dir, &mut normalized);
    sync_legacy_fields_from_gateways(&mut normalized);
    let txt = serde_json::to_string_pretty(&normalized).map_err(|e| format!("序列化 Agent 运行时配置失败: {}", e))?;
    std::fs::write(&path, txt).map_err(|e| format!("写入 Agent 运行时配置失败: {}", e))
}

fn parse_agents_list_cli(stdout: &str) -> Vec<AgentInfo> {
    let mut agents = Vec::new();
    let mut current: Option<AgentInfo> = None;
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            if let Some(a) = current.take() {
                agents.push(a);
            }
            continue;
        }
        if line.starts_with("- ") {
            if let Some(a) = current.take() {
                agents.push(a);
            }
            let id_part = line.trim_start_matches("- ").trim();
            let (id, default) = if id_part.contains("(default)") {
                (id_part.replace("(default)", "").trim().to_string(), true)
            } else {
                (id_part.to_string(), false)
            };
            current = Some(AgentInfo {
                id: id.clone(),
                name: Some(id.clone()),
                default,
                workspace: None,
                model: None,
            });
        } else if let Some(ref mut a) = current {
            if line.starts_with("Workspace:") {
                a.workspace = Some(line.replace("Workspace:", "").trim().to_string());
            } else if line.starts_with("Model:") {
                a.model = Some(line.replace("Model:", "").trim().to_string());
            } else if line.starts_with("Identity:") {
                let identity = line.replace("Identity:", "").trim().to_string();
                if !identity.is_empty() && identity != "-" {
                    a.name = Some(identity);
                }
            }
        }
    }
    if let Some(a) = current {
        agents.push(a);
    }
    if agents.is_empty() {
        agents.push(AgentInfo {
            id: "main".to_string(),
            name: Some("main".to_string()),
            default: true,
            workspace: Some("~/.openclaw/workspace".to_string()),
            model: None,
        });
    }
    agents
}

#[tauri::command]
fn read_agents_list(custom_path: Option<String>) -> Result<AgentsListResponse, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let config_path = format!("{}/openclaw.json", openclaw_dir.replace('\\', "/"));
    if !Path::new(&config_path).exists() {
        return Err(format!("配置文件不存在: {}", config_path));
    }
    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("读取配置失败: {}", e))?;
    let config: Value =
        serde_json::from_str(&content).map_err(|e| format!("解析 JSON 失败: {}", e))?;

    let mut agents: Vec<AgentInfo> = Vec::new();
    let mut bindings: Vec<BindingRule> = Vec::new();

    if let Some(list) = config
        .get("agents")
        .and_then(|a| a.get("list"))
        .and_then(|l| l.as_array())
    {
        for item in list {
            if let Some(obj) = item.as_object() {
                let id = obj
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("main")
                    .to_string();
                let default = obj.get("default").and_then(|v| v.as_bool()).unwrap_or(false);
                let workspace = obj
                    .get("workspace")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let name = obj
                    .get("identity")
                    .and_then(|i| i.get("name"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let model = obj
                    .get("model")
                    .and_then(|m| m.get("primary"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                agents.push(AgentInfo {
                    id,
                    name,
                    default,
                    workspace,
                    model,
                });
            }
        }
    }

    if let Some(bind_list) = config
        .get("agents")
        .and_then(|a| a.get("bindings"))
        .and_then(|b| b.as_array())
    {
        for item in bind_list {
            if let Some(obj) = item.as_object() {
                let channel = obj
                    .get("channel")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let agent_id = obj
                    .get("agent")
                    .or_else(|| obj.get("agentId"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if !channel.is_empty() && !agent_id.is_empty() {
                    bindings.push(BindingRule {
                        channel,
                        agent_id,
                        account: obj.get("account").and_then(|v| v.as_str()).map(|s| s.to_string()),
                        peer: obj.get("peer").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    });
                }
            }
        }
    }

    if agents.is_empty() {
        let exe = find_openclaw_executable(Some(openclaw_dir.as_str()))
            .unwrap_or_else(|| "openclaw".to_string());
        let env_extra = Some(("OPENCLAW_STATE_DIR", openclaw_dir.as_str()));
        let (ok, stdout, _) =
            run_openclaw_cmd_clean(&exe, &["agents", "list", "--bindings"], env_extra)?;
        if ok {
            agents = parse_agents_list_cli(&stdout);
        } else {
            agents = vec![AgentInfo {
                id: "main".to_string(),
                name: Some("main".to_string()),
                default: true,
                workspace: Some("~/.openclaw/workspace".to_string()),
                model: None,
            }];
        }
    }

    Ok(AgentsListResponse {
        agents,
        bindings,
        config_path: config_path.clone(),
    })
}

#[tauri::command]
fn create_agent(
    id: String,
    name: Option<String>,
    workspace: Option<String>,
    custom_path: Option<String>,
) -> Result<(), String> {
    let re = Regex::new(r"^[a-z0-9_-]+$").unwrap();
    if !re.is_match(&id) {
        return Err("Agent id 必须为小写字母、数字、下划线或连字符".to_string());
    }
    if id == "main" {
        return Err("不能创建名为 main 的 agent（main 已存在）".to_string());
    }

    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let workspace_path = workspace.unwrap_or_else(|| {
        format!("{}/workspace-{}", openclaw_dir.replace('\\', "/"), id)
    });

    let exe = find_openclaw_executable(Some(openclaw_dir.as_str()))
        .unwrap_or_else(|| "openclaw".to_string());
    let env_extra = Some(("OPENCLAW_STATE_DIR", openclaw_dir.as_str()));

    let (ok, _stdout, stderr) =
        run_openclaw_cmd_clean(&exe, &["agents", "add", &id, "--workspace", &workspace_path], env_extra)?;
    if !ok {
        return Err(format!("openclaw agents add 失败:\n{}", stderr));
    }

    if name.is_some() {
        let _ = run_openclaw_cmd_clean(
            &exe,
            &["agents", "set-identity", "--agent", &id, "--name", &name.as_ref().unwrap()],
            env_extra,
        );
    }

    Ok(())
}

#[tauri::command]
fn rename_agent(id: String, name: String, custom_path: Option<String>) -> Result<(), String> {
    let id = id.trim().to_string();
    let name = name.trim().to_string();
    if id.is_empty() {
        return Err("Agent id 不能为空".to_string());
    }
    if name.is_empty() {
        return Err("名称不能为空".to_string());
    }

    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let exe = find_openclaw_executable(Some(openclaw_dir.as_str()))
        .unwrap_or_else(|| "openclaw".to_string());
    let env_extra = Some(("OPENCLAW_STATE_DIR", openclaw_dir.as_str()));

    let (ok, _stdout, stderr) = run_openclaw_cmd_clean(
        &exe,
        &["agents", "set-identity", "--agent", &id, "--name", &name],
        env_extra,
    )?;
    if !ok {
        return Err(format!("openclaw agents set-identity 失败:\n{}", stderr));
    }

    Ok(())
}

#[tauri::command]
fn delete_agent(id: String, force: bool, custom_path: Option<String>) -> Result<(), String> {
    if id == "main" {
        return Err("不能删除 main agent".to_string());
    }

    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let exe = find_openclaw_executable(Some(openclaw_dir.as_str()))
        .unwrap_or_else(|| "openclaw".to_string());
    let env_extra = Some(("OPENCLAW_STATE_DIR", openclaw_dir.as_str()));

    let mut args = vec!["agents", "delete", &id];
    if force {
        args.push("--force");
    }

    let (ok, _stdout, stderr) = run_openclaw_cmd_clean(&exe, &args, env_extra)?;
    if !ok {
        return Err(format!("openclaw agents delete 失败:\n{}", stderr));
    }
    Ok(())
}

#[tauri::command]
fn set_default_agent(id: String, custom_path: Option<String>) -> Result<(), String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let mut root = load_openclaw_config(&openclaw_dir).map_err(|e| e.to_string())?;

    let exe = find_openclaw_executable(Some(openclaw_dir.as_str()))
        .unwrap_or_else(|| "openclaw".to_string());
    let env_extra = Some(("OPENCLAW_STATE_DIR", openclaw_dir.as_str()));
    let (ok, stdout, _) = run_openclaw_cmd_clean(&exe, &["agents", "list"], env_extra)?;
    let cli_agents = if ok {
        parse_agents_list_cli(&stdout)
    } else {
        vec![]
    };

    let defaults_workspace = root
        .get("agents")
        .and_then(|a| a.get("defaults"))
        .and_then(|d| d.get("workspace"))
        .and_then(|w| w.as_str())
        .unwrap_or("~/.openclaw/workspace");

    let mut list: Vec<Value> = if let Some(arr) = root
        .get("agents")
        .and_then(|a| a.get("list"))
        .and_then(|l| l.as_array())
    {
        arr.clone()
    } else if cli_agents.is_empty() {
        vec![json!({
            "id": "main",
            "default": id == "main",
            "workspace": defaults_workspace
        })]
    } else {
        cli_agents
            .iter()
            .map(|a| {
                json!({
                    "id": a.id,
                    "default": a.id == id,
                    "workspace": a.workspace.as_deref().unwrap_or(defaults_workspace)
                })
            })
            .collect()
    };

    for item in list.iter_mut() {
        if let Some(obj) = item.as_object_mut() {
            let item_id = obj.get("id").and_then(|v| v.as_str()).unwrap_or("");
            obj.insert(
                "default".to_string(),
                Value::Bool(item_id == id),
            );
        }
    }

    let mut agents_obj = root
        .get("agents")
        .and_then(|a| a.as_object())
        .cloned()
        .unwrap_or_default();
    agents_obj.insert("list".to_string(), Value::Array(list));
    root.as_object_mut()
        .unwrap()
        .insert("agents".to_string(), Value::Object(agents_obj));

    save_openclaw_config(&openclaw_dir, &root)?;
    Ok(())
}

#[tauri::command]
fn update_bindings(bindings: Vec<BindingRule>, custom_path: Option<String>) -> Result<(), String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let mut root = load_openclaw_config(&openclaw_dir).map_err(|e| e.to_string())?;

    let bindings_value: Vec<Value> = bindings
        .into_iter()
        .map(|b| {
            let mut m = Map::new();
            m.insert("channel".to_string(), Value::String(b.channel));
            m.insert("agent".to_string(), Value::String(b.agent_id));
            if let Some(a) = b.account {
                m.insert("account".to_string(), Value::String(a));
            }
            if let Some(p) = b.peer {
                m.insert("peer".to_string(), Value::String(p));
            }
            Value::Object(m)
        })
        .collect();

    let agents = root.get_mut("agents").and_then(|a| a.as_object_mut());
    if let Some(agents_obj) = agents {
        agents_obj.insert(
            "bindings".to_string(),
            Value::Array(bindings_value),
        );
    } else {
        let mut agents_obj = Map::new();
        agents_obj.insert(
            "bindings".to_string(),
            Value::Array(bindings_value),
        );
        root.as_object_mut()
            .unwrap()
            .insert("agents".to_string(), Value::Object(agents_obj));
    }

    save_openclaw_config(&openclaw_dir, &root)?;
    Ok(())
}

#[tauri::command]
fn read_agent_runtime_settings(custom_path: Option<String>) -> Result<AgentRuntimeSettingsResponse, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let mut settings = load_agent_runtime_settings(&openclaw_dir)?;
    // 以当前生效 token 反推 active_telegram_instance，避免 UI 与网关实际状态不一致。
    if let Ok(root) = load_openclaw_config(&openclaw_dir) {
        let active_token = root
            .get("channels")
            .and_then(|v| v.get("telegram"))
            .and_then(|v| v.get("botToken"))
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        if let Some(token) = active_token {
            if let Some(hit) = settings
                .telegram_instances
                .iter()
                .find(|x| x.bot_token.trim() == token)
                .map(|x| x.id.clone())
            {
                settings.active_telegram_instance = Some(hit);
            }
        }
    }
    Ok(build_agent_runtime_settings_response(&openclaw_dir, settings))
}

#[tauri::command]
fn save_gateway_bindings(
    gateways: Vec<GatewayBinding>,
    custom_path: Option<String>,
) -> Result<Vec<GatewayBinding>, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let mut settings = load_agent_runtime_settings(&openclaw_dir)?;
    settings.gateways = gateways
        .into_iter()
        .filter(|g| {
            if g.agent_id.trim().is_empty() {
                return false;
            }
            if !g.channel_instances.is_empty() {
                return g.channel_instances.iter().any(|(ch, iid)| !ch.trim().is_empty() && !iid.trim().is_empty());
            }
            !g.channel.trim().is_empty() && !g.instance_id.trim().is_empty()
        })
        .map(|mut g| {
            normalize_gateway_binding(&openclaw_dir, &mut g);
            g
        })
        .collect();
    normalize_runtime_settings_v2(&openclaw_dir, &mut settings);
    save_agent_runtime_settings(&openclaw_dir, &settings)?;
    Ok(settings.gateways)
}

#[tauri::command]
fn save_skills_scope(
    skills_scope: String,
    custom_path: Option<String>,
) -> Result<AgentRuntimeSettingsResponse, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let mut settings = load_agent_runtime_settings(&openclaw_dir)?;
    settings.skills_scope = skills_scope;
    normalize_runtime_settings_v2(&openclaw_dir, &mut settings);
    save_agent_runtime_settings(&openclaw_dir, &settings)?;
    Ok(build_agent_runtime_settings_response(&openclaw_dir, settings))
}

#[tauri::command]
fn save_agent_skill_binding(
    agent_id: String,
    mode: String,
    enabled_skills: Vec<String>,
    custom_path: Option<String>,
) -> Result<AgentRuntimeSettingsResponse, String> {
    let aid = agent_id.trim().to_string();
    if aid.is_empty() {
        return Err("agent_id 不能为空".to_string());
    }
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let mut settings = load_agent_runtime_settings(&openclaw_dir)?;
    let normalized_mode = if mode.trim().eq_ignore_ascii_case("custom") {
        "custom".to_string()
    } else {
        "inherit".to_string()
    };
    let mut dedup = BTreeSet::new();
    let normalized_skills: Vec<String> = enabled_skills
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .filter(|s| dedup.insert(s.to_lowercase()))
        .collect();

    if let Some(existing) = settings
        .agent_skill_bindings
        .iter_mut()
        .find(|binding| binding.agent_id.eq_ignore_ascii_case(&aid))
    {
        existing.agent_id = aid;
        existing.mode = normalized_mode;
        existing.enabled_skills = normalized_skills;
        existing.isolated_state_dir = None;
    } else {
        settings.agent_skill_bindings.push(AgentSkillBinding {
            agent_id: aid,
            mode: normalized_mode,
            enabled_skills: normalized_skills,
            isolated_state_dir: None,
        });
    }

    normalize_runtime_settings_v2(&openclaw_dir, &mut settings);
    save_agent_runtime_settings(&openclaw_dir, &settings)?;
    Ok(build_agent_runtime_settings_response(&openclaw_dir, settings))
}

#[tauri::command]
fn upsert_agent_runtime_profile(
    agent_id: String,
    provider: String,
    model: String,
    custom_path: Option<String>,
) -> Result<AgentRuntimeProfile, String> {
    let aid = agent_id.trim().to_string();
    if aid.is_empty() {
        return Err("agent_id 不能为空".to_string());
    }
    let p = provider.trim().to_string();
    if p.is_empty() {
        return Err("provider 不能为空".to_string());
    }
    let m = model.trim().to_string();
    if m.is_empty() {
        return Err("model 不能为空".to_string());
    }

    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let mut settings = load_agent_runtime_settings(&openclaw_dir)?;
    let out = AgentRuntimeProfile {
        agent_id: aid.clone(),
        provider: p.clone(),
        model: m.clone(),
    };
    if let Some(existing) = settings.profiles.iter_mut().find(|x| x.agent_id == aid) {
        *existing = out.clone();
    } else {
        settings.profiles.push(out.clone());
    }
    save_agent_runtime_settings(&openclaw_dir, &settings)?;

    // 同步到 openclaw.json 的 agents.list[].model.primary，让 Agent 在运行时使用对应主模型。
    let mut root = load_openclaw_config(&openclaw_dir).map_err(|e| e.to_string())?;
    let primary = normalize_primary_model(&p, Some(&m));
    let mut found = false;
    if let Some(list) = root
        .get_mut("agents")
        .and_then(|a| a.get_mut("list"))
        .and_then(|l| l.as_array_mut())
    {
        for item in list.iter_mut() {
            let Some(obj) = item.as_object_mut() else { continue };
            let Some(id) = obj.get("id").and_then(|v| v.as_str()) else { continue };
            if id != aid {
                continue;
            }
            let mut model_obj = obj
                .get("model")
                .and_then(|m| m.as_object())
                .cloned()
                .unwrap_or_default();
            model_obj.insert("primary".to_string(), Value::String(primary.clone()));
            obj.insert("model".to_string(), Value::Object(model_obj));
            found = true;
            break;
        }
    }
    if !found {
        return Err(format!("未找到 Agent: {}", aid));
    }
    save_openclaw_config(&openclaw_dir, &root)?;
    Ok(out)
}

#[tauri::command]
fn save_agent_channel_routes(
    routes: Vec<AgentChannelRoute>,
    custom_path: Option<String>,
) -> Result<Vec<AgentChannelRoute>, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let mut settings = load_agent_runtime_settings(&openclaw_dir)?;
    settings.channel_routes = routes
        .into_iter()
        .filter(|r| !r.channel.trim().is_empty() && !r.agent_id.trim().is_empty())
        .map(|mut r| {
            r.channel = r.channel.trim().to_string();
            r.agent_id = r.agent_id.trim().to_string();
            r.bot_instance = r
                .bot_instance
                .as_deref()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            r.account = r
                .account
                .as_deref()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            r.peer = r
                .peer
                .as_deref()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            r.gateway_id = r
                .gateway_id
                .as_deref()
                .map(|s| sanitize_gateway_key(s))
                .filter(|s| !s.is_empty());
            if r.id.trim().is_empty() {
                r.id = format!("{}-{}-{}", r.channel, r.agent_id, now_stamp());
            }
            r
        })
        .collect();
    save_agent_runtime_settings(&openclaw_dir, &settings)?;
    Ok(settings.channel_routes)
}

#[tauri::command]
fn save_telegram_instances(
    instances: Vec<TelegramBotInstance>,
    active_instance_id: Option<String>,
    custom_path: Option<String>,
) -> Result<AgentRuntimeSettingsResponse, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let mut settings = load_agent_runtime_settings(&openclaw_dir)?;
    let normalized: Vec<TelegramBotInstance> = instances
        .into_iter()
        .filter_map(|mut it| {
            let id = it.id.trim().to_string();
            let token = it.bot_token.trim().to_string();
            if id.is_empty() || token.is_empty() {
                return None;
            }
            it.id = id;
            it.name = if it.name.trim().is_empty() {
                it.id.clone()
            } else {
                it.name.trim().to_string()
            };
            it.bot_token = token;
            it.chat_id = it
                .chat_id
                .as_deref()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            Some(it)
        })
        .collect();
    let active = active_instance_id
        .as_deref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| normalized.first().map(|x| x.id.clone()));
    settings.telegram_instances = normalized;
    settings.active_telegram_instance = active;
    if let Some(active_id) = settings.active_telegram_instance.clone() {
        let _ = upsert_gateway_binding(&mut settings, &openclaw_dir, "telegram", &active_id, None);
    }
    save_agent_runtime_settings(&openclaw_dir, &settings)?;
    Ok(build_agent_runtime_settings_response(&openclaw_dir, settings))
}

fn normalize_channel_id(channel: &str) -> String {
    channel.trim().to_ascii_lowercase()
}

fn supports_channel_instances(channel: &str) -> bool {
    matches!(channel, "telegram" | "feishu" | "dingtalk" | "discord" | "qq")
}

fn build_channel_config_from_instance(channel: &str, it: &ChannelBotInstance) -> Result<Value, String> {
    let c1 = it.credential1.trim().to_string();
    let c2 = it
        .credential2
        .as_deref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let mut cfg = Map::new();
    match channel {
        "telegram" => {
            if c1.is_empty() {
                return Err(format!("实例 {} 缺少 bot token", it.id));
            }
            cfg.insert("botToken".to_string(), Value::String(c1));
            if let Some(chat) = it
                .chat_id
                .as_deref()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
            {
                cfg.insert("chatId".to_string(), Value::String(chat));
            }
        }
        "discord" => {
            if c1.is_empty() {
                return Err(format!("实例 {} 缺少 token", it.id));
            }
            cfg.insert("token".to_string(), Value::String(c1.clone()));
            cfg.insert("botToken".to_string(), Value::String(c1));
        }
        "feishu" => {
            if c1.is_empty() || c2.is_none() {
                return Err(format!("实例 {} 缺少 appId/appSecret", it.id));
            }
            cfg.insert("appId".to_string(), Value::String(c1));
            cfg.insert("appSecret".to_string(), Value::String(c2.unwrap_or_default()));
            cfg.insert("connectionMode".to_string(), Value::String("websocket".to_string()));
            cfg.insert("enabled".to_string(), Value::Bool(true));
        }
        "dingtalk" => {
            if c1.is_empty() || c2.is_none() {
                return Err(format!("实例 {} 缺少 appKey/appSecret", it.id));
            }
            cfg.insert("appKey".to_string(), Value::String(c1));
            cfg.insert("appSecret".to_string(), Value::String(c2.unwrap_or_default()));
        }
        "qq" => {
            if c1.is_empty() || c2.is_none() {
                return Err(format!("实例 {} 缺少 AppID/AppSecret", it.id));
            }
            let secret = c2.unwrap_or_default();
            let composed = if secret.starts_with(&format!("{}:", c1)) {
                secret.clone()
            } else {
                format!("{}:{}", c1, secret)
            };
            cfg.insert("appId".to_string(), Value::String(c1));
            cfg.insert("clientSecret".to_string(), Value::String(secret.clone()));
            cfg.insert("appSecret".to_string(), Value::String(secret));
            cfg.insert("token".to_string(), Value::String(composed));
        }
        _ => {
            return Err(format!("不支持的渠道: {}", channel));
        }
    }
    Ok(Value::Object(cfg))
}

#[tauri::command]
fn save_channel_instances(
    channel: String,
    instances: Vec<ChannelBotInstance>,
    active_instance_id: Option<String>,
    custom_path: Option<String>,
) -> Result<AgentRuntimeSettingsResponse, String> {
    let ch = normalize_channel_id(&channel);
    if !supports_channel_instances(&ch) {
        return Err(format!("不支持的渠道: {}", ch));
    }
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let mut settings = load_agent_runtime_settings(&openclaw_dir)?;

    let normalized: Vec<ChannelBotInstance> = instances
        .into_iter()
        .filter_map(|mut it| {
            let id = it.id.trim().to_string();
            if id.is_empty() {
                return None;
            }
            it.channel = ch.clone();
            it.id = id;
            it.name = if it.name.trim().is_empty() {
                it.id.clone()
            } else {
                it.name.trim().to_string()
            };
            it.credential1 = it.credential1.trim().to_string();
            it.credential2 = it
                .credential2
                .as_deref()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            it.chat_id = it
                .chat_id
                .as_deref()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            Some(it)
        })
        .collect();

    settings
        .channel_instances
        .retain(|it| normalize_channel_id(&it.channel) != ch);
    settings.channel_instances.extend(normalized.clone());
    let active = active_instance_id
        .as_deref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| normalized.first().map(|x| x.id.clone()));
    if let Some(id) = active.clone() {
        settings.active_channel_instances.insert(ch.clone(), id);
    } else {
        settings.active_channel_instances.remove(&ch);
    }
    if let Some(active_id) = active {
        let _ = upsert_gateway_binding(&mut settings, &openclaw_dir, &ch, &active_id, None);
    }
    save_agent_runtime_settings(&openclaw_dir, &settings)?;
    Ok(build_agent_runtime_settings_response(&openclaw_dir, settings))
}

fn check_telegram_get_me(token: &str) -> Result<(String, Option<String>), String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("token 为空".to_string());
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
        let out = cmd
            .args(["-NoProfile", "-Command", &script])
            .output()
            .map_err(|e| format!("请求失败: {}", e))?;
        let body = String::from_utf8_lossy(&out.stdout).to_string();
        if !body.contains("\"ok\":true") {
            return Err("getMe 返回失败".to_string());
        }
        if let Ok(v) = serde_json::from_str::<Value>(&body) {
            let uname = v
                .get("result")
                .and_then(|r| r.get("username"))
                .and_then(|u| u.as_str())
                .unwrap_or("");
            if !uname.is_empty() {
                return Ok((format!("getMe 成功 @{}", uname), Some(uname.to_string())));
            }
        }
        return Ok(("getMe 成功".to_string(), None));
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("当前平台暂不支持批量 getMe 检查".to_string())
    }
}

#[tauri::command]
fn test_telegram_instances(custom_path: Option<String>) -> Result<Vec<TelegramInstanceHealth>, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let settings = load_agent_runtime_settings(&openclaw_dir)?;
    let mut out: Vec<TelegramInstanceHealth> = Vec::new();
    for it in settings.telegram_instances {
        if !it.enabled {
            out.push(TelegramInstanceHealth {
                id: it.id,
                ok: false,
                detail: "已禁用，跳过".to_string(),
                username: None,
            });
            continue;
        }
        match check_telegram_get_me(&it.bot_token) {
            Ok((detail, username)) => out.push(TelegramInstanceHealth {
                id: it.id,
                ok: true,
                detail,
                username,
            }),
            Err(e) => out.push(TelegramInstanceHealth {
                id: it.id,
                ok: false,
                detail: e,
                username: None,
            }),
        }
    }
    Ok(out)
}

#[tauri::command]
fn test_single_telegram_instance(instance_id: String, custom_path: Option<String>) -> Result<TelegramInstanceHealth, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let settings = load_agent_runtime_settings(&openclaw_dir)?;
    let target = instance_id.trim();
    if target.is_empty() {
        return Err("instance_id 不能为空".to_string());
    }
    let Some(it) = settings
        .telegram_instances
        .iter()
        .find(|x| x.id.trim().eq_ignore_ascii_case(target)) else {
        return Err(format!("未找到 Telegram 实例: {}", target));
    };
    if !it.enabled {
        return Ok(TelegramInstanceHealth {
            id: it.id.clone(),
            ok: false,
            detail: "已禁用，跳过".to_string(),
            username: None,
        });
    }
    match check_telegram_get_me(&it.bot_token) {
        Ok((detail, username)) => Ok(TelegramInstanceHealth {
            id: it.id.clone(),
            ok: true,
            detail,
            username,
        }),
        Err(e) => Ok(TelegramInstanceHealth {
            id: it.id.clone(),
            ok: false,
            detail: e,
            username: None,
        }),
    }
}

#[tauri::command]
fn test_channel_instances(channel: String, custom_path: Option<String>) -> Result<Vec<ChannelInstanceHealth>, String> {
    let ch = normalize_channel_id(&channel);
    if !supports_channel_instances(&ch) {
        return Err(format!("不支持的渠道: {}", ch));
    }
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let settings = load_agent_runtime_settings(&openclaw_dir)?;
    let mut out = Vec::new();
    for it in settings
        .channel_instances
        .iter()
        .filter(|x| normalize_channel_id(&x.channel) == ch)
    {
        if !it.enabled {
            out.push(ChannelInstanceHealth {
                channel: ch.clone(),
                id: it.id.clone(),
                ok: false,
                detail: "已禁用，跳过".to_string(),
            });
            continue;
        }
        let cfg = match build_channel_config_from_instance(&ch, it) {
            Ok(v) => v,
            Err(e) => {
                out.push(ChannelInstanceHealth {
                    channel: ch.clone(),
                    id: it.id.clone(),
                    ok: false,
                    detail: e,
                });
                continue;
            }
        };
        match test_channel_connection(ch.clone(), cfg) {
            Ok(msg) => out.push(ChannelInstanceHealth {
                channel: ch.clone(),
                id: it.id.clone(),
                ok: true,
                detail: msg,
            }),
            Err(e) => out.push(ChannelInstanceHealth {
                channel: ch.clone(),
                id: it.id.clone(),
                ok: false,
                detail: e,
            }),
        }
    }
    Ok(out)
}

#[tauri::command]
fn test_single_channel_instance(
    channel: String,
    instance_id: String,
    custom_path: Option<String>,
) -> Result<ChannelInstanceHealth, String> {
    let ch = normalize_channel_id(&channel);
    if !supports_channel_instances(&ch) {
        return Err(format!("不支持的渠道: {}", ch));
    }
    let target = instance_id.trim();
    if target.is_empty() {
        return Err("instance_id 不能为空".to_string());
    }
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let settings = load_agent_runtime_settings(&openclaw_dir)?;
    let Some(it) = settings.channel_instances.iter().find(|x| {
        normalize_channel_id(&x.channel) == ch && x.id.trim().eq_ignore_ascii_case(target)
    }) else {
        return Err(format!("未找到 {} 实例: {}", ch, target));
    };
    if !it.enabled {
        return Ok(ChannelInstanceHealth {
            channel: ch,
            id: it.id.clone(),
            ok: false,
            detail: "已禁用，跳过".to_string(),
        });
    }
    let cfg = build_channel_config_from_instance(&ch, it)?;
    match test_channel_connection(ch.clone(), cfg) {
        Ok(msg) => Ok(ChannelInstanceHealth {
            channel: ch,
            id: it.id.clone(),
            ok: true,
            detail: msg,
        }),
        Err(e) => Ok(ChannelInstanceHealth {
            channel: ch,
            id: it.id.clone(),
            ok: false,
            detail: e,
        }),
    }
}

fn restart_enabled_agent_gateways(openclaw_dir: &str) -> Result<Vec<String>, String> {
    let settings = load_agent_runtime_settings(openclaw_dir)?;
    let targets: Vec<String> = settings
        .gateways
        .iter()
        .filter(|g| g.enabled)
        .map(|g| g.gateway_id.clone())
        .collect();
    let mut restarted = Vec::new();
    for gid in targets {
        start_gateway_instance(
            gid.clone(),
            Some(openclaw_dir.to_string()),
            Some(openclaw_dir.to_string()),
        )?;
        restarted.push(gid);
    }
    Ok(restarted)
}

#[tauri::command]
fn apply_channel_instance(
    channel: String,
    instance_id: String,
    custom_path: Option<String>,
) -> Result<String, String> {
    let ch = normalize_channel_id(&channel);
    if !supports_channel_instances(&ch) {
        return Err(format!("不支持的渠道: {}", ch));
    }
    let target = instance_id.trim();
    if target.is_empty() {
        return Err("instance_id 不能为空".to_string());
    }
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let mut settings = load_agent_runtime_settings(&openclaw_dir)?;
    let Some(instance) = settings.channel_instances.iter().find(|x| {
        x.enabled
            && normalize_channel_id(&x.channel) == ch
            && x.id.trim().eq_ignore_ascii_case(target)
    }) else {
        return Err(format!("未找到可用实例: {} / {}", ch, target));
    };
    let instance_id_cloned = instance.id.clone();
    let cfg = build_channel_config_from_instance(&ch, instance)?;
    let _ = save_channel_config(ch.clone(), cfg, Some(openclaw_dir.clone()))?;
    settings
        .active_channel_instances
        .insert(ch.clone(), instance_id_cloned.clone());
    let _ = upsert_gateway_binding(&mut settings, &openclaw_dir, &ch, &instance_id_cloned, None);
    save_agent_runtime_settings(&openclaw_dir, &settings)?;
    let restarted = restart_enabled_agent_gateways(&openclaw_dir)?;
    Ok(format!(
        "已应用 {} 实例: {}（已刷新 {} 条 Agent 网关：{}）",
        ch,
        instance_id_cloned,
        restarted.len(),
        if restarted.is_empty() {
            "无".to_string()
        } else {
            restarted.join(", ")
        }
    ))
}

#[tauri::command]
fn apply_telegram_instance(instance_id: String, custom_path: Option<String>) -> Result<String, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let mut settings = load_agent_runtime_settings(&openclaw_dir)?;
    let target = instance_id.trim();
    if target.is_empty() {
        return Err("instance_id 不能为空".to_string());
    }
    let Some(instance) = settings
        .telegram_instances
        .iter()
        .find(|x| x.id.trim().eq_ignore_ascii_case(target) && x.enabled) else {
        return Err(format!("未找到可用 Telegram 实例: {}", target));
    };
    let instance_id_cloned = instance.id.clone();

    let mut cfg = serde_json::Map::new();
    cfg.insert("botToken".to_string(), Value::String(instance.bot_token.clone()));
    if let Some(chat) = instance.chat_id.as_deref().filter(|s| !s.trim().is_empty()) {
        cfg.insert("chatId".to_string(), Value::String(chat.trim().to_string()));
    }
    let _ = save_channel_config(
        "telegram".to_string(),
        Value::Object(cfg),
        Some(openclaw_dir.clone()),
    )?;
    // OpenClaw 当前版本对 inbound Telegram 仍以“默认 agent”作为主要入口；
    // 因此在切换实例时，同步把默认 agent 切到该实例绑定的 agent，避免“看起来切了 bot 但还进 main”。
    let mapped_agent = settings
        .channel_routes
        .iter()
        .find(|r| {
            r.enabled
                && r.channel.trim().eq_ignore_ascii_case("telegram")
                && r
                    .bot_instance
                    .as_deref()
                    .map(|s| s.trim().eq_ignore_ascii_case(instance_id_cloned.as_str()))
                    .unwrap_or(false)
        })
        .map(|r| r.agent_id.trim().to_string())
        .filter(|s| !s.is_empty());
    if let Some(agent_id) = mapped_agent.clone() {
        if let Ok(mut root) = load_openclaw_config(&openclaw_dir) {
            if let Some(list) = root
                .get_mut("agents")
                .and_then(|a| a.get_mut("list"))
                .and_then(|l| l.as_array_mut())
            {
                for item in list.iter_mut() {
                    if let Some(obj) = item.as_object_mut() {
                        let is_target = obj
                            .get("id")
                            .and_then(|v| v.as_str())
                            .map(|id| id == agent_id)
                            .unwrap_or(false);
                        obj.insert("default".to_string(), Value::Bool(is_target));
                    }
                }
                let _ = save_openclaw_config(&openclaw_dir, &root);
            }
        }
    }
    settings.active_telegram_instance = Some(instance_id_cloned.clone());
    let _ = upsert_gateway_binding(
        &mut settings,
        &openclaw_dir,
        "telegram",
        &instance_id_cloned,
        mapped_agent.as_deref(),
    );
    save_agent_runtime_settings(&openclaw_dir, &settings)?;
    let restarted = restart_enabled_agent_gateways(&openclaw_dir)?;
    Ok(format!(
        "已应用 Telegram 实例: {}（已刷新 {} 条 Agent 网关：{}{}）",
        instance_id_cloned,
        restarted.len(),
        if restarted.is_empty() {
            "无".to_string()
        } else {
            restarted.join(", ")
        },
        mapped_agent
            .as_deref()
            .map(|a| format!("，默认 Agent -> {}", a))
            .unwrap_or_else(|| "".to_string())
    ))
}

fn channel_configs_from_binding(settings: &AgentRuntimeSettings, binding: &GatewayBinding) -> Result<Vec<(String, Value)>, String> {
    let pairs = gateway_channel_pairs(binding);
    if pairs.is_empty() {
        return Err(format!("网关 {} 未配置有效渠道实例", binding.gateway_id));
    }
    let mut out = Vec::new();
    for (ch, iid) in pairs {
        if ch == "telegram" {
            let Some(instance) = settings
                .telegram_instances
                .iter()
                .find(|x| x.enabled && x.id.trim().eq_ignore_ascii_case(iid.as_str())) else {
                return Err(format!("未找到可用 Telegram 实例: {}", iid));
            };
            let mut cfg = serde_json::Map::new();
            cfg.insert("botToken".to_string(), Value::String(instance.bot_token.clone()));
            if let Some(chat) = instance.chat_id.as_deref().filter(|s| !s.trim().is_empty()) {
                cfg.insert("chatId".to_string(), Value::String(chat.trim().to_string()));
            }
            out.push((ch, Value::Object(cfg)));
            continue;
        }
        let Some(instance) = settings.channel_instances.iter().find(|x| {
            x.enabled
                && normalize_channel_id(&x.channel) == ch
                && x.id.trim().eq_ignore_ascii_case(iid.as_str())
        }) else {
            return Err(format!("未找到可用实例: {} / {}", ch, iid));
        };
        out.push((ch.clone(), build_channel_config_from_instance(&ch, instance)?));
    }
    Ok(out)
}

fn save_gateway_health_snapshot(
    settings: &mut AgentRuntimeSettings,
    gateway_id: &str,
    exe: &str,
    state_dir: &str,
    fallback_error: Option<String>,
) {
    let health = read_gateway_health_with_state_dir(exe, state_dir, gateway_id);
    let err = if health.status == "error" {
        Some(health.detail.clone())
    } else {
        fallback_error
    };
    update_gateway_runtime_snapshot(settings, gateway_id, health, err);
}

fn copy_file_if_exists(src: &Path, dst: &Path) -> Result<bool, String> {
    if !src.exists() {
        return Ok(false);
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败 ({}): {}", parent.display(), e))?;
    }
    std::fs::copy(src, dst).map_err(|e| format!("复制文件失败 ({} -> {}): {}", src.display(), dst.display(), e))?;
    Ok(true)
}

fn sync_gateway_state_runtime_assets(base_openclaw_dir: &str, state_dir: &str) -> Result<Vec<String>, String> {
    let mut copied = Vec::new();
    let base = Path::new(base_openclaw_dir);
    let state = Path::new(state_dir);

    let pairs = [
        ("openclaw.json", "openclaw.json"),
        ("channels.json", "channels.json"),
        ("env", "env"),
        ("agents/main/agent/auth-profiles.json", "agents/main/agent/auth-profiles.json"),
        ("agents/main/agent/models.json", "agents/main/agent/models.json"),
    ];
    for (src_rel, dst_rel) in pairs {
        let src = base.join(src_rel);
        let dst = state.join(dst_rel);
        if copy_file_if_exists(&src, &dst)? {
            copied.push(dst.to_string_lossy().to_string().replace('\\', "/"));
        }
    }
    Ok(copied)
}

#[tauri::command]
fn list_gateway_instances(custom_path: Option<String>) -> Result<Vec<GatewayBinding>, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let mut settings = load_agent_runtime_settings(&openclaw_dir)?;
    let exe = find_openclaw_executable(Some(openclaw_dir.as_str())).unwrap_or_else(|| "openclaw".to_string());
    for g in settings.gateways.iter_mut() {
        normalize_gateway_binding(&openclaw_dir, g);
        let state_dir = g
            .state_dir
            .clone()
            .unwrap_or_else(|| gateway_default_state_dir(&openclaw_dir, &g.gateway_id));
        g.state_dir = Some(state_dir.clone());
        g.health = Some(read_gateway_health_with_state_dir(&exe, &state_dir, &g.gateway_id));
        if g.health.as_ref().map(|h| h.status.as_str() == "error").unwrap_or(false) {
            g.pid = None;
        }
    }
    save_agent_runtime_settings(&openclaw_dir, &settings)?;
    Ok(settings.gateways)
}

#[tauri::command]
fn health_gateway_instance(gateway_id: String, custom_path: Option<String>) -> Result<GatewayBinding, String> {
    let gid = sanitize_gateway_key(&gateway_id);
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let mut settings = load_agent_runtime_settings(&openclaw_dir)?;
    let exe = find_openclaw_executable(Some(openclaw_dir.as_str())).unwrap_or_else(|| "openclaw".to_string());
    let state_dir = find_gateway_binding(&settings, &gid)
        .and_then(|g| g.state_dir.clone())
        .unwrap_or_else(|| gateway_default_state_dir(&openclaw_dir, &gid));
    save_gateway_health_snapshot(&mut settings, &gid, &exe, &state_dir, None);
    save_agent_runtime_settings(&openclaw_dir, &settings)?;
    find_gateway_binding(&settings, &gid)
        .cloned()
        .ok_or_else(|| format!("未找到网关绑定: {}", gid))
}

#[tauri::command]
fn start_gateway_instance(
    gateway_id: String,
    custom_path: Option<String>,
    install_hint: Option<String>,
) -> Result<String, String> {
    let gid = sanitize_gateway_key(&gateway_id);
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let mut settings = load_agent_runtime_settings(&openclaw_dir)?;
    let binding = find_gateway_binding(&settings, &gid)
        .cloned()
        .ok_or_else(|| format!("未找到网关绑定: {}", gid))?;
    if !binding.enabled {
        return Err(format!("网关 {} 已禁用", gid));
    }
    let state_dir = binding
        .state_dir
        .clone()
        .unwrap_or_else(|| gateway_default_state_dir(&openclaw_dir, &gid));
    std::fs::create_dir_all(&state_dir).map_err(|e| format!("创建网关状态目录失败: {}", e))?;
    let synced_assets = sync_gateway_state_runtime_assets(&openclaw_dir, &state_dir)?;

    let plugin_channels: Vec<String> = gateway_channel_pairs(&binding)
        .into_iter()
        .map(|(ch, _)| ch)
        .filter(|ch| !is_builtin_channel_for_openclaw(ch))
        .collect();
    let installed_plugins = ensure_channel_plugins_installed(&plugin_channels, &state_dir, install_hint.clone())?;

    let channel_cfgs = channel_configs_from_binding(&settings, &binding)?;
    let has_qq = channel_cfgs.iter().any(|(ch, _)| ch.eq_ignore_ascii_case("qq"));
    let has_feishu = channel_cfgs.iter().any(|(ch, _)| ch.eq_ignore_ascii_case("feishu"));
    for (ch, cfg) in channel_cfgs.iter() {
        let _ = save_channel_config(ch.clone(), cfg.clone(), Some(state_dir.clone()))?;
    }

    let mut root = load_openclaw_config(&state_dir).map_err(|e| e.to_string())?;
    ensure_gateway_mode_local(&mut root);
    set_default_agent_for_gateway(&mut root, &binding.agent_id);
    // 仅保留绑定内的渠道，移除 base 同步来的多余渠道，避免 getUpdates 冲突（如飞书网关误带 tg-code token）
    let binding_channel_keys: std::collections::HashSet<String> = gateway_channel_pairs(&binding)
        .into_iter()
        .map(|(ch, _)| {
            if ch.eq_ignore_ascii_case("qq") {
                "qqbot".to_string()
            } else {
                ch.to_ascii_lowercase()
            }
        })
        .collect();
    if let Some(obj) = root.as_object_mut() {
        if let Some(chs) = obj.get_mut("channels").and_then(|v| v.as_object_mut()) {
            let to_remove: Vec<String> = chs
                .keys()
                .filter(|k| !binding_channel_keys.contains(*k))
                .cloned()
                .collect();
            for k in to_remove {
                chs.remove(&k);
            }
        }
        if let Some(plugins) = obj.get_mut("plugins").and_then(|p| p.as_object_mut()) {
            if let Some(entries) = plugins.get_mut("entries").and_then(|e| e.as_object_mut()) {
                let to_remove: Vec<String> = entries
                    .keys()
                    .filter(|k| !binding_channel_keys.contains(*k))
                    .cloned()
                    .collect();
                for k in to_remove {
                    entries.remove(&k);
                }
            }
        }
    }
    // 若网关绑定含 QQ，将 channels.json 的 qqbot 合并进 openclaw.json，并启用 qqbot 插件
    if has_qq {
        let channels_path = format!("{}/channels.json", state_dir.replace('\\', "/"));
        if let Ok(txt) = std::fs::read_to_string(&channels_path) {
            if let Ok(legacy) = serde_json::from_str::<Value>(&txt) {
                if let Some(obj) = legacy.as_object() {
                    let qq_cfg = obj.get("qqbot").or_else(|| obj.get("qq"));
                    if let Some(qq) = qq_cfg {
                        let app_id = qq.get("appId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        if !app_id.is_empty() {
                            let client_secret = qq
                                .get("clientSecret")
                                .or_else(|| qq.get("appSecret"))
                                .and_then(|v| v.as_str())
                                .map(String::from)
                                .or_else(|| {
                                    qq.get("token")
                                        .and_then(|v| v.as_str())
                                        .and_then(|t| t.split_once(':').map(|(_, s)| s.to_string()))
                                })
                                .unwrap_or_default();
                            if !client_secret.is_empty() {
                                let obj_mut = root.as_object_mut().expect("root object");
                                let chs = obj_mut.entry("channels".to_string()).or_insert_with(|| json!({}));
                                if let Some(chs_obj) = chs.as_object_mut() {
                                    chs_obj.insert(
                                        "qqbot".to_string(),
                                        json!({
                                            "enabled": true,
                                            "allowFrom": ["*"],
                                            "appId": app_id,
                                            "clientSecret": client_secret
                                        }),
                                    );
                                }
                                let plugins = obj_mut.entry("plugins".to_string()).or_insert_with(|| json!({}));
                                if let Some(p) = plugins.as_object_mut() {
                                    let entries = p.entry("entries".to_string()).or_insert_with(|| json!({}));
                                    if let Some(e) = entries.as_object_mut() {
                                        e.insert("qqbot".to_string(), json!({"enabled": true}));
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    if has_feishu {
        let channels_path = format!("{}/channels.json", state_dir.replace('\\', "/"));
        if let Ok(txt) = std::fs::read_to_string(&channels_path) {
            if let Ok(legacy) = serde_json::from_str::<Value>(&txt) {
                if let Some(obj) = legacy.as_object() {
                    if let Some(feishu) = obj.get("feishu") {
                        let app_id = feishu
                            .get("appId")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .trim()
                            .to_string();
                        let app_secret = feishu
                            .get("appSecret")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .trim()
                            .to_string();
                        if !app_id.is_empty() && !app_secret.is_empty() {
                            let obj_mut = root.as_object_mut().expect("root object");
                            let chs = obj_mut.entry("channels".to_string()).or_insert_with(|| json!({}));
                            if let Some(chs_obj) = chs.as_object_mut() {
                                chs_obj.insert(
                                    "feishu".to_string(),
                                    json!({
                                        "enabled": true,
                                        "appId": app_id,
                                        "appSecret": app_secret,
                                        "connectionMode": "websocket"
                                    }),
                                );
                            }
                            let plugins = obj_mut.entry("plugins".to_string()).or_insert_with(|| json!({}));
                            if let Some(p) = plugins.as_object_mut() {
                                let entries = p.entry("entries".to_string()).or_insert_with(|| json!({}));
                                if let Some(e) = entries.as_object_mut() {
                                    e.insert("feishu".to_string(), json!({"enabled": true}));
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    let port = binding.listen_port.unwrap_or(18789);
    if !root.is_object() {
        root = json!({});
    }
    let obj = root.as_object_mut().expect("object");
    let gateway = obj.entry("gateway".to_string()).or_insert_with(|| json!({}));
    if !gateway.is_object() {
        *gateway = json!({});
    }
    let gw_obj = gateway.as_object_mut().expect("gateway object");
    gw_obj.insert("port".to_string(), json!(port));
    save_openclaw_config(&state_dir, &root)?;

    let exe = find_openclaw_executable(Some(openclaw_dir.as_str()))
        .or_else(|| find_openclaw_executable(install_hint.as_deref()))
        .unwrap_or_else(|| "openclaw".to_string());
    let _ = ensure_gateway_service_installed(&exe, &state_dir, &gid, Some(port));
    let _ = run_openclaw_gateway_cmd_clean(&exe, &["gateway", "stop"], &state_dir, &gid, Some(port));
    let mut start_res = run_openclaw_gateway_cmd_clean(&exe, &["gateway", "start"], &state_dir, &gid, Some(port));
    if let Ok((ok, out, err)) = &start_res {
        if !*ok && gateway_start_requires_reinstall(&format!("{}\n{}", out, err)) {
            let _ = std::fs::remove_file(gateway_install_stamp_path(&state_dir));
            ensure_gateway_service_installed(&exe, &state_dir, &gid, Some(port))?;
            start_res = run_openclaw_gateway_cmd_clean(&exe, &["gateway", "start"], &state_dir, &gid, Some(port));
        }
    }
    let start_err = start_res
        .as_ref()
        .err()
        .map(|e| e.to_string())
        .or_else(|| {
            start_res
                .as_ref()
                .ok()
                .filter(|(ok, _, _)| !ok)
                .map(|(_, _, se)| se.clone())
        });
    save_gateway_health_snapshot(&mut settings, &gid, &exe, &state_dir, start_err.clone());
    if let Some(g) = find_gateway_binding_mut(&mut settings, &gid) {
        g.state_dir = Some(state_dir.clone());
        g.listen_port = Some(port);
    }
    save_agent_runtime_settings(&openclaw_dir, &settings)?;
    if let Some(err) = start_err {
        return Err(format!("网关 {} 启动失败: {}", gid, err));
    }
    Ok(format!(
        "网关已启动: {} (agent={}, channels={}, port={}, synced_assets={}, plugins={})",
        gid,
        binding.agent_id,
        gateway_channel_pairs(&binding)
            .into_iter()
            .map(|(ch, iid)| format!("{}/{}", ch, iid))
            .collect::<Vec<String>>()
            .join(","),
        port,
        synced_assets.len(),
        if installed_plugins.is_empty() {
            "ok".to_string()
        } else {
            installed_plugins.join("; ")
        }
    ))
}

#[tauri::command]
fn stop_gateway_instance(
    gateway_id: String,
    custom_path: Option<String>,
    install_hint: Option<String>,
) -> Result<String, String> {
    let gid = sanitize_gateway_key(&gateway_id);
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let mut settings = load_agent_runtime_settings(&openclaw_dir)?;
    let binding = find_gateway_binding(&settings, &gid)
        .cloned()
        .ok_or_else(|| format!("未找到网关绑定: {}", gid))?;
    let state_dir = binding
        .state_dir
        .clone()
        .unwrap_or_else(|| gateway_default_state_dir(&openclaw_dir, &gid));
    let exe = find_openclaw_executable(Some(openclaw_dir.as_str()))
        .or_else(|| find_openclaw_executable(install_hint.as_deref()))
        .unwrap_or_else(|| "openclaw".to_string());
    let stop_res = run_openclaw_gateway_cmd_clean(
        &exe,
        &["gateway", "stop"],
        &state_dir,
        &gid,
        binding.listen_port,
    );
    let mut stop_msg = "已请求停止".to_string();
    if let Ok((ok, out, err)) = &stop_res {
        stop_msg = if *ok {
            format!("已停止: {}", out.trim())
        } else {
            format!("停止返回异常: {}", err.trim())
        };
    }
    save_gateway_health_snapshot(
        &mut settings,
        &gid,
        &exe,
        &state_dir,
        stop_res.err().map(|e| e.to_string()),
    );
    if let Some(g) = find_gateway_binding_mut(&mut settings, &gid) {
        g.pid = None;
    }
    save_agent_runtime_settings(&openclaw_dir, &settings)?;
    Ok(format!("网关 {} {}", gid, stop_msg))
}

#[tauri::command]
fn restart_gateway_instance(
    gateway_id: String,
    custom_path: Option<String>,
    install_hint: Option<String>,
) -> Result<String, String> {
    let _ = stop_gateway_instance(gateway_id.clone(), custom_path.clone(), install_hint.clone());
    start_gateway_instance(gateway_id, custom_path, install_hint)
}

#[tauri::command]
fn tail_gateway_logs(
    gateway_id: String,
    lines: Option<usize>,
    custom_path: Option<String>,
) -> Result<String, String> {
    let gid = sanitize_gateway_key(&gateway_id);
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let settings = load_agent_runtime_settings(&openclaw_dir)?;
    let binding = find_gateway_binding(&settings, &gid)
        .ok_or_else(|| format!("未找到网关绑定: {}", gid))?;
    let state_dir = binding
        .state_dir
        .clone()
        .unwrap_or_else(|| gateway_default_state_dir(&openclaw_dir, &gid));
    let path = Path::new(&state_dir).join("gateway.log");
    if !path.exists() {
        return Ok(format!(
            "未找到日志文件：{}\n提示：先启动该网关实例后再查看日志。",
            path.to_string_lossy()
        ));
    }
    let txt = std::fs::read_to_string(&path).map_err(|e| format!("读取日志失败: {}", e))?;
    let max_lines = lines.unwrap_or(160).max(20).min(1000);
    let mut all: Vec<&str> = txt.lines().collect();
    if all.len() > max_lines {
        all = all.split_off(all.len() - max_lines);
    }
    Ok(all.join("\n"))
}

#[tauri::command]
fn start_all_enabled_gateways(
    custom_path: Option<String>,
    install_hint: Option<String>,
) -> Result<String, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let settings = load_agent_runtime_settings(&openclaw_dir)?;
    let targets: Vec<String> = settings
        .gateways
        .iter()
        .filter(|g| g.enabled)
        .map(|g| g.gateway_id.clone())
        .collect();
    if targets.is_empty() {
        return Ok("未找到启用中的网关绑定".to_string());
    }
    let mut ok_msgs = Vec::new();
    let mut fail_msgs = Vec::new();
    for gid in targets {
        match start_gateway_instance(gid.clone(), Some(openclaw_dir.clone()), install_hint.clone()) {
            Ok(m) => ok_msgs.push(m),
            Err(e) => fail_msgs.push(format!("{} -> {}", gid, e)),
        }
    }
    let mut out = format!("批量启动完成：成功 {}，失败 {}", ok_msgs.len(), fail_msgs.len());
    if !ok_msgs.is_empty() {
        out.push_str("\n\n[成功]\n");
        out.push_str(&ok_msgs.join("\n"));
    }
    if !fail_msgs.is_empty() {
        out.push_str("\n\n[失败]\n");
        out.push_str(&fail_msgs.join("\n"));
    }
    Ok(out)
}

#[tauri::command]
fn health_all_enabled_gateways(custom_path: Option<String>) -> Result<Vec<GatewayBinding>, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let settings = load_agent_runtime_settings(&openclaw_dir)?;
    let targets: Vec<String> = settings
        .gateways
        .iter()
        .filter(|g| g.enabled)
        .map(|g| g.gateway_id.clone())
        .collect();
    for gid in targets {
        let _ = health_gateway_instance(gid, Some(openclaw_dir.clone()));
    }
    list_gateway_instances(Some(openclaw_dir))
}

#[tauri::command]
fn export_multi_gateway_diagnostic_report(custom_path: Option<String>) -> Result<String, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let list = list_gateway_instances(Some(openclaw_dir.clone()))?;
    let mut lines = Vec::new();
    lines.push(format!("OpenClaw 多网关诊断报告 {}", now_stamp()));
    lines.push(format!("config_dir: {}", openclaw_dir));
    lines.push(String::new());
    for g in list {
        lines.push(format!("- gateway_id: {}", g.gateway_id));
        lines.push(format!("  agent_id: {}", g.agent_id));
        let channel_pairs = gateway_channel_pairs(&g)
            .into_iter()
            .map(|(ch, iid)| format!("{}/{}", ch, iid))
            .collect::<Vec<String>>()
            .join(", ");
        lines.push(format!("  channels: {}", channel_pairs));
        lines.push(format!("  enabled: {}", g.enabled));
        lines.push(format!("  state_dir: {}", g.state_dir.unwrap_or_default()));
        lines.push(format!("  port: {}", g.listen_port.map(|v| v.to_string()).unwrap_or_default()));
        lines.push(format!(
            "  health: {}",
            g.health
                .as_ref()
                .map(|h| format!("{} ({})", h.status, h.checked_at))
                .unwrap_or_else(|| "unknown".to_string())
        ));
        if let Ok(log_tail) = tail_gateway_logs(g.gateway_id.clone(), Some(60), Some(openclaw_dir.clone())) {
            lines.push("  ---- tail gateway.log ----".to_string());
            for l in log_tail.lines() {
                lines.push(format!("  {}", l));
            }
            lines.push("  ---- end log ----".to_string());
        }
        lines.push(String::new());
    }
    let report_dir = Path::new(&openclaw_dir).join("control_plane");
    std::fs::create_dir_all(&report_dir).map_err(|e| format!("创建报告目录失败: {}", e))?;
    let file_path = report_dir.join(format!("gateway-diagnostic-{}.txt", now_stamp()));
    std::fs::write(&file_path, lines.join("\n")).map_err(|e| format!("写入诊断报告失败: {}", e))?;
    Ok(file_path.to_string_lossy().to_string().replace('\\', "/"))
}

#[tauri::command]
fn resolve_agent_channel_route(
    channel: String,
    gateway_id: Option<String>,
    bot_instance: Option<String>,
    account: Option<String>,
    peer: Option<String>,
    fallback_agent: Option<String>,
    custom_path: Option<String>,
) -> Result<AgentRouteResolveResult, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let settings = load_agent_runtime_settings(&openclaw_dir)?;
    let channel_norm = channel.trim().to_ascii_lowercase();
    if channel_norm.is_empty() {
        return Err("channel 不能为空".to_string());
    }
    let account_norm = account
        .as_deref()
        .map(|s| s.trim().trim_start_matches('@').to_ascii_lowercase())
        .filter(|s| !s.is_empty());
    let peer_norm = peer
        .as_deref()
        .map(|s| s.trim().trim_start_matches('@').to_ascii_lowercase())
        .filter(|s| !s.is_empty());
    let bot_instance_norm = bot_instance
        .as_deref()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty());
    let gateway_id_norm = gateway_id
        .as_deref()
        .map(|s| sanitize_gateway_key(s))
        .filter(|s| !s.is_empty());

    let input_tokens: Vec<&str> = [account_norm.as_deref(), peer_norm.as_deref()]
        .into_iter()
        .flatten()
        .collect();
    let matches_input = |expected: Option<&String>| -> bool {
        let Some(raw) = expected else { return true };
        let exp = raw.trim().trim_start_matches('@').to_ascii_lowercase();
        if exp.is_empty() {
            return true;
        }
        input_tokens.iter().any(|v| *v == exp.as_str())
    };

    let mut picked: Option<(usize, &AgentChannelRoute)> = None;
    let mut same_channel_count = 0usize;
    let mut blocked_by_account = 0usize;
    let mut blocked_by_peer = 0usize;
    for route in settings.channel_routes.iter().filter(|r| r.enabled) {
        if route.channel.trim().to_ascii_lowercase() != channel_norm {
            continue;
        }
        let route_gateway = route
            .gateway_id
            .as_deref()
            .map(|s| sanitize_gateway_key(s))
            .filter(|s| !s.is_empty());
        if let Some(input_gateway) = gateway_id_norm.as_deref() {
            if let Some(expect_gateway) = route_gateway.as_deref() {
                if expect_gateway != input_gateway {
                    continue;
                }
            }
        }
        if let Some(expect_bot) = route
            .bot_instance
            .as_deref()
            .map(|s| s.trim().to_ascii_lowercase())
            .filter(|s| !s.is_empty())
        {
            let Some(input_bot) = bot_instance_norm.as_deref() else { continue };
            if expect_bot != input_bot {
                continue;
            }
        }
        same_channel_count += 1;
        if !matches_input(route.account.as_ref()) {
            blocked_by_account += 1;
            continue;
        }
        if !matches_input(route.peer.as_ref()) {
            blocked_by_peer += 1;
            continue;
        }
        let mut score = usize::from(route.account.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false))
            + usize::from(route.peer.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false));
        if let (Some(expect), Some(input)) = (route_gateway.as_deref(), gateway_id_norm.as_deref()) {
            if expect == input {
                score += 4;
            }
        }
        match picked {
            Some((best, _)) if best >= score => {}
            _ => picked = Some((score, route)),
        }
    }

    if let Some((_, route)) = picked {
        let resolved_gateway = route
            .gateway_id
            .clone()
            .or_else(|| {
                route.bot_instance.as_deref().and_then(|iid| {
                    settings
                        .gateways
                        .iter()
                        .find(|g| {
                            g.enabled
                                && normalize_channel_id(&g.channel) == channel_norm
                                && g.instance_id.trim().eq_ignore_ascii_case(iid.trim())
                        })
                        .map(|g| g.gateway_id.clone())
                })
            })
            .or_else(|| gateway_id_norm.clone());
        return Ok(AgentRouteResolveResult {
            agent_id: route.agent_id.clone(),
            gateway_id: resolved_gateway,
            matched_route_id: Some(route.id.clone()),
            detail: format!("命中路由 {}", route.id),
        });
    }

    let fallback = fallback_agent
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or("main")
        .to_string();
    Ok(AgentRouteResolveResult {
        agent_id: fallback,
        gateway_id: gateway_id_norm,
        matched_route_id: None,
        detail: if settings.channel_routes.iter().any(|r| r.enabled) {
            format!(
                "未命中路由，使用默认 Agent（同渠道规则 {} 条；account 不匹配 {} 条；peer 不匹配 {} 条）",
                same_channel_count, blocked_by_account, blocked_by_peer
            )
        } else {
            "未命中路由，使用默认 Agent（当前没有启用的渠道路由规则）".to_string()
        },
    })
}

#[tauri::command]
fn cleanup_browser_sessions_for_telegram_bindings(custom_path: Option<String>) -> Result<String, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let settings = load_agent_runtime_settings(&openclaw_dir)?;
    let mut keep_keys = BTreeSet::new();
    for route in settings.channel_routes.iter().filter(|r| {
        r.enabled
            && r.channel.trim().eq_ignore_ascii_case("telegram")
            && !r.agent_id.trim().is_empty()
    }) {
        let agent_id = route.agent_id.trim();
        keep_keys.insert(format!("agent:{}:main", agent_id));
    }
    if keep_keys.is_empty() {
        return Err("未找到启用中的 Telegram 路由，已取消会话清理".to_string());
    }

    let agents_root = Path::new(&openclaw_dir).join("agents");
    if !agents_root.exists() {
        return Err(format!("agents 目录不存在: {}", agents_root.display()));
    }

    let mut touched_files = 0usize;
    let mut removed_count = 0usize;
    let mut kept_count = 0usize;
    for entry in std::fs::read_dir(&agents_root).map_err(|e| format!("读取 agents 目录失败: {}", e))? {
        let entry = entry.map_err(|e| format!("读取 agents 子目录失败: {}", e))?;
        let agent_dir = entry.path();
        if !agent_dir.is_dir() {
            continue;
        }
        let sessions_path = agent_dir.join("sessions").join("sessions.json");
        if !sessions_path.exists() {
            continue;
        }
        let txt = std::fs::read_to_string(&sessions_path)
            .map_err(|e| format!("读取 sessions.json 失败 ({}): {}", sessions_path.display(), e))?;
        let mut root: Value = serde_json::from_str(&txt)
            .map_err(|e| format!("解析 sessions.json 失败 ({}): {}", sessions_path.display(), e))?;
        let Some(obj) = root.as_object_mut() else {
            continue;
        };
        let all_keys: Vec<String> = obj.keys().cloned().collect();
        let mut changed = false;
        for key in all_keys {
            if keep_keys.contains(&key) {
                kept_count += 1;
                continue;
            }
            if obj.remove(&key).is_some() {
                removed_count += 1;
                changed = true;
            }
        }
        if changed {
            touched_files += 1;
            let serialized = serde_json::to_string_pretty(&Value::Object(obj.clone()))
                .map_err(|e| format!("序列化 sessions.json 失败 ({}): {}", sessions_path.display(), e))?;
            std::fs::write(&sessions_path, serialized)
                .map_err(|e| format!("写入 sessions.json 失败 ({}): {}", sessions_path.display(), e))?;
        }
    }

    Ok(format!(
        "会话清理完成：保留键 {} 个，移除键 {} 个，更新文件 {} 个。保留目标: {}",
        kept_count,
        removed_count,
        touched_files,
        keep_keys.into_iter().collect::<Vec<String>>().join(", ")
    ))
}

#[tauri::command]
fn get_gateway_url(custom_path: Option<String>) -> Result<String, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    let root = load_openclaw_config(&openclaw_dir).map_err(|e| e.to_string())?;

    let port = root
        .get("gateway")
        .and_then(|g| g.get("port"))
        .and_then(|p| p.as_u64())
        .unwrap_or(18789);

    let base_path = root
        .get("gateway")
        .and_then(|g| g.get("controlUi"))
        .and_then(|c| c.get("basePath"))
        .and_then(|b| b.as_str())
        .unwrap_or("/openclaw");

    Ok(format!("http://127.0.0.1:{}{}", port, base_path))
}

fn get_agent_workspace(agent_id: String, custom_path: Option<String>) -> Result<String, String> {
    let resp = read_agents_list(custom_path)?;
    let agent = resp
        .agents
        .iter()
        .find(|a| a.id == agent_id)
        .ok_or_else(|| format!("Agent 未找到: {}", agent_id))?;
    let ws = agent
        .workspace
        .as_deref()
        .unwrap_or("~/.openclaw/workspace");
    let home = env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    let expanded = if ws.starts_with("~/") {
        format!("{}{}", home.replace('\\', "/"), &ws[1..])
    } else {
        ws.to_string()
    };
    Ok(expanded.replace('\\', "/"))
}

#[tauri::command]
fn read_workspace_file(
    agent_id: String,
    relative_path: String,
    custom_path: Option<String>,
) -> Result<String, String> {
    let base = PathBuf::from(get_agent_workspace(agent_id, custom_path)?);
    let path = base.join(&relative_path);
    if path.components().any(|c| c == std::path::Component::ParentDir) {
        return Err("路径不能包含 ..".to_string());
    }
    std::fs::read_to_string(&path).map_err(|e| format!("读取失败: {}", e))
}

#[tauri::command]
fn write_workspace_file(
    agent_id: String,
    relative_path: String,
    content: String,
    custom_path: Option<String>,
) -> Result<(), String> {
    let base = PathBuf::from(get_agent_workspace(agent_id, custom_path)?);
    let path = base.join(&relative_path);
    if path.components().any(|c| c == std::path::Component::ParentDir) {
        return Err("路径不能包含 ..".to_string());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }
    std::fs::write(&path, content).map_err(|e| format!("写入失败: {}", e))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatUiMessage {
    pub id: String,
    pub role: String,
    pub text: String,
    pub timestamp: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatHistoryResponse {
    pub session_key: String,
    pub messages: Vec<ChatUiMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatHistoryDeltaResponse {
    pub session_key: String,
    pub cursor: usize,
    pub messages: Vec<ChatUiMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatSendResponse {
    pub session_key: String,
    pub run_id: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReplyFinishedEvent {
    pub request_id: String,
    pub agent_id: String,
    pub session_name: String,
    pub ok: bool,
    pub text: Option<String>,
    pub error: Option<String>,
}

fn build_chat_session_key(agent_id: &str, session_name: Option<&str>) -> String {
    // Canonical agent session key format expected by gateway: agent:<agentId>:<sessionName>
    let name = session_name
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or("main");
    format!("agent:{}:{}", agent_id.trim(), name)
}

fn extract_json_payload(stdout: &str) -> Result<Value, String> {
    let s = stdout.trim();
    if s.is_empty() {
        return Err("网关返回为空".to_string());
    }
    if let Ok(v) = serde_json::from_str::<Value>(s) {
        return Ok(v);
    }
    // 兼容偶发混合输出：取最后一个 JSON 起始位置重试
    if let Some(pos) = s.rfind('{').or_else(|| s.rfind('[')) {
        let tail = &s[pos..];
        if let Ok(v) = serde_json::from_str::<Value>(tail) {
            return Ok(v);
        }
    }
    Err(format!("无法解析网关 JSON 返回: {}", s))
}

fn normalize_message_text(v: &Value) -> String {
    if let Some(s) = v.as_str() {
        return s.to_string();
    }
    if let Some(arr) = v.as_array() {
        let mut parts = Vec::new();
        for item in arr {
            if let Some(t) = item.get("text").and_then(|x| x.as_str()) {
                if !t.trim().is_empty() {
                    parts.push(t.to_string());
                }
            } else if let Some(t) = item.as_str() {
                if !t.trim().is_empty() {
                    parts.push(t.to_string());
                }
            }
        }
        return parts.join("\n");
    }
    if let Some(obj) = v.as_object() {
        if let Some(t) = obj.get("text").and_then(|x| x.as_str()) {
            return t.to_string();
        }
        if let Some(t) = obj.get("content") {
            return normalize_message_text(t);
        }
    }
    String::new()
}

fn parse_chat_messages(value: &Value) -> Vec<ChatUiMessage> {
    let entries = value
        .get("messages")
        .or_else(|| value.get("entries"))
        .or_else(|| value.get("data").and_then(|d| d.get("messages")))
        .or_else(|| value.get("data").and_then(|d| d.get("entries")))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut out = Vec::new();
    for (idx, item) in entries.iter().enumerate() {
        let role = item
            .get("role")
            .and_then(|v| v.as_str())
            .or_else(|| item.get("author").and_then(|v| v.as_str()))
            .unwrap_or("assistant")
            .to_string();
        let text = item
            .get("text")
            .map(normalize_message_text)
            .or_else(|| item.get("content").map(normalize_message_text))
            .unwrap_or_default();
        if text.trim().is_empty() {
            continue;
        }
        let id = item
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("msg-{}", idx));
        let timestamp = item
            .get("timestamp")
            .or_else(|| item.get("createdAt"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        out.push(ChatUiMessage {
            id,
            role,
            text,
            timestamp,
        });
    }
    out
}

fn make_chat_message_fingerprint(message: &ChatUiMessage) -> String {
    format!(
        "{}|{}|{}",
        message.role.trim(),
        message.timestamp.clone().unwrap_or_default().trim(),
        message.text.split_whitespace().collect::<Vec<_>>().join(" ")
    )
}

fn latest_new_assistant_text(messages: &[ChatUiMessage], known: &BTreeSet<String>) -> Option<String> {
    messages
        .iter()
        .rev()
        .find(|m| m.role.eq_ignore_ascii_case("assistant") && !known.contains(&make_chat_message_fingerprint(m)))
        .map(|m| m.text.clone())
        .filter(|t| !t.trim().is_empty())
}

fn gateway_call_value(
    openclaw_dir: &str,
    method: &str,
    params: Value,
    expect_final: bool,
) -> Result<Value, String> {
    let exe = find_openclaw_executable(Some(openclaw_dir))
        .unwrap_or_else(|| "openclaw".to_string());
    let env_extra = Some(("OPENCLAW_STATE_DIR", openclaw_dir));
    let params_str =
        serde_json::to_string(&params).map_err(|e| format!("参数序列化失败: {}", e))?;
    let mut args = vec![
        "gateway",
        "call",
        method,
        "--json",
        "--params",
        params_str.as_str(),
        "--timeout",
        "20000",
    ];
    if expect_final {
        args.push("--expect-final");
    }
    let (ok, stdout, stderr) = run_openclaw_cmd_clean(&exe, &args, env_extra)?;
    if !ok {
        return Err(format!("gateway call 失败 [{}]: {}", method, stderr));
    }
    extract_json_payload(&stdout)
}

fn resolve_chat_runtime_dir(
    custom_path: Option<&str>,
    prefer_gateway_dir: bool,
    gateway_id: Option<&str>,
) -> Result<String, String> {
    let openclaw_dir = resolve_runtime_chat_dir(custom_path, prefer_gateway_dir);
    let Some(gid_raw) = gateway_id else {
        return Ok(openclaw_dir);
    };
    let gid = sanitize_gateway_key(gid_raw);
    if gid.is_empty() {
        return Ok(openclaw_dir);
    }
    let settings = load_agent_runtime_settings(&openclaw_dir)?;
    let Some(binding) = find_gateway_binding(&settings, &gid) else {
        return Err(format!("未找到网关绑定: {}", gid));
    };
    let state_dir = binding
        .state_dir
        .clone()
        .unwrap_or_else(|| gateway_default_state_dir(&openclaw_dir, &gid));
    Ok(state_dir)
}

#[tauri::command]
fn chat_list_history(
    agent_id: String,
    session_name: Option<String>,
    gateway_id: Option<String>,
    custom_path: Option<String>,
    prefer_gateway_dir: Option<bool>,
) -> Result<ChatHistoryResponse, String> {
    let openclaw_dir = resolve_chat_runtime_dir(
        custom_path.as_deref(),
        prefer_gateway_dir.unwrap_or(true),
        gateway_id.as_deref(),
    )?;
    let session_key = build_chat_session_key(&agent_id, session_name.as_deref());
    let value = gateway_call_value(
        &openclaw_dir,
        "chat.history",
        json!({
            "sessionKey": session_key,
            "limit": 80
        }),
        false,
    )?;
    let messages = parse_chat_messages(&value);
    Ok(ChatHistoryResponse {
        session_key,
        messages,
    })
}

#[tauri::command]
fn chat_list_history_delta(
    agent_id: String,
    session_name: Option<String>,
    cursor: usize,
    gateway_id: Option<String>,
    custom_path: Option<String>,
    prefer_gateway_dir: Option<bool>,
    known_fingerprints: Option<Vec<String>>,
    limit: Option<usize>,
) -> Result<ChatHistoryDeltaResponse, String> {
    let openclaw_dir = resolve_chat_runtime_dir(
        custom_path.as_deref(),
        prefer_gateway_dir.unwrap_or(true),
        gateway_id.as_deref(),
    )?;
    let session_key = build_chat_session_key(&agent_id, session_name.as_deref());
    let value = gateway_call_value(
        &openclaw_dir,
        "chat.history",
        json!({
            "sessionKey": session_key,
            "limit": limit.unwrap_or(80)
        }),
        false,
    )?;
    let all = parse_chat_messages(&value);
    let total = all.len();
    let known: BTreeSet<String> = known_fingerprints
        .unwrap_or_default()
        .into_iter()
        .filter(|x| !x.trim().is_empty())
        .collect();
    let messages = if !known.is_empty() {
        all.into_iter()
            .filter(|m| !known.contains(&make_chat_message_fingerprint(m)))
            .collect()
    } else {
        let from = cursor.min(total);
        if from >= total {
            Vec::new()
        } else {
            all[from..].to_vec()
        }
    };
    let next_cursor = if !known.is_empty() {
        cursor.saturating_add(messages.len())
    } else {
        total
    };
    Ok(ChatHistoryDeltaResponse {
        session_key,
        cursor: next_cursor,
        messages,
    })
}

#[tauri::command]
fn chat_send(
    agent_id: String,
    session_name: Option<String>,
    text: String,
    gateway_id: Option<String>,
    custom_path: Option<String>,
    prefer_gateway_dir: Option<bool>,
) -> Result<ChatSendResponse, String> {
    let msg = text.trim();
    if msg.is_empty() {
        return Err("消息不能为空".to_string());
    }
    let openclaw_dir = resolve_chat_runtime_dir(
        custom_path.as_deref(),
        prefer_gateway_dir.unwrap_or(true),
        gateway_id.as_deref(),
    )?;
    let session_key = build_chat_session_key(&agent_id, session_name.as_deref());

    // 先尝试 text 参数；失败时自动回退 message 参数
    let first = gateway_call_value(
        &openclaw_dir,
        "chat.send",
        json!({
            "sessionKey": session_key,
            "text": msg,
            "idempotencyKey": format!("{}-{}", agent_id, now_stamp())
        }),
        false,
    );
    let value = match first {
        Ok(v) => v,
        Err(_) => gateway_call_value(
            &openclaw_dir,
            "chat.send",
            json!({
                "sessionKey": session_key,
                "message": msg,
                "idempotencyKey": format!("{}-{}", agent_id, now_stamp())
            }),
            false,
        )?,
    };

    let run_id = value
        .get("runId")
        .or_else(|| value.get("data").and_then(|d| d.get("runId")))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let status = value
        .get("status")
        .or_else(|| value.get("data").and_then(|d| d.get("status")))
        .and_then(|v| v.as_str())
        .unwrap_or("started")
        .to_string();
    Ok(ChatSendResponse {
        session_key,
        run_id,
        status,
    })
}

#[tauri::command]
fn chat_abort(
    agent_id: String,
    session_name: Option<String>,
    gateway_id: Option<String>,
    custom_path: Option<String>,
    prefer_gateway_dir: Option<bool>,
) -> Result<String, String> {
    let openclaw_dir = resolve_chat_runtime_dir(
        custom_path.as_deref(),
        prefer_gateway_dir.unwrap_or(true),
        gateway_id.as_deref(),
    )?;
    let session_key = build_chat_session_key(&agent_id, session_name.as_deref());
    let _ = gateway_call_value(
        &openclaw_dir,
        "chat.abort",
        json!({
            "sessionKey": session_key
        }),
        false,
    )?;
    Ok("已请求停止当前会话生成".to_string())
}

#[tauri::command]
fn chat_wait_for_reply_background(
    app: tauri::AppHandle,
    request_id: String,
    agent_id: String,
    session_name: String,
    gateway_id: Option<String>,
    custom_path: Option<String>,
    prefer_gateway_dir: Option<bool>,
    known_fingerprints: Option<Vec<String>>,
) -> Result<String, String> {
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let openclaw_dir = match resolve_chat_runtime_dir(
            custom_path.as_deref(),
            prefer_gateway_dir.unwrap_or(true),
            gateway_id.as_deref(),
        ) {
            Ok(dir) => dir,
            Err(err) => {
                let _ = app_handle.emit(
                    "chat-reply-finished",
                    ChatReplyFinishedEvent {
                        request_id,
                        agent_id,
                        session_name,
                        ok: false,
                        text: None,
                        error: Some(err),
                    },
                );
                return;
            }
        };
        let session_key = build_chat_session_key(&agent_id, Some(session_name.as_str()));
        let known: BTreeSet<String> = known_fingerprints
            .unwrap_or_default()
            .into_iter()
            .filter(|x| !x.trim().is_empty())
            .collect();
        let delays_ms = [1800_u64, 2600, 3600, 5000, 6500];

        for delay in delays_ms {
            thread::sleep(Duration::from_millis(delay));
            let value = match gateway_call_value(
                &openclaw_dir,
                "chat.history",
                json!({
                    "sessionKey": session_key,
                    "limit": 24
                }),
                false,
            ) {
                Ok(value) => value,
                Err(err) => {
                    let _ = app_handle.emit(
                        "chat-reply-finished",
                        ChatReplyFinishedEvent {
                            request_id,
                            agent_id,
                            session_name,
                            ok: false,
                            text: None,
                            error: Some(err),
                        },
                    );
                    return;
                }
            };
            let messages = parse_chat_messages(&value);
            if let Some(text) = latest_new_assistant_text(&messages, &known) {
                let _ = app_handle.emit(
                    "chat-reply-finished",
                    ChatReplyFinishedEvent {
                        request_id,
                        agent_id,
                        session_name,
                        ok: true,
                        text: Some(text),
                        error: None,
                    },
                );
                return;
            }
        }

        let fallback = gateway_call_value(
            &openclaw_dir,
            "chat.history",
            json!({
                "sessionKey": session_key,
                "limit": 80
            }),
            false,
        )
        .ok()
        .and_then(|value| latest_new_assistant_text(&parse_chat_messages(&value), &known));

        let payload = if let Some(text) = fallback {
            ChatReplyFinishedEvent {
                request_id,
                agent_id,
                session_name,
                ok: true,
                text: Some(text),
                error: None,
            }
        } else {
            ChatReplyFinishedEvent {
                request_id,
                agent_id,
                session_name,
                ok: false,
                text: None,
                error: Some("等待回复超时，未检测到新的 assistant 消息".to_string()),
            }
        };
        let _ = app_handle.emit("chat-reply-finished", payload);
    });
    Ok("已在后台等待回复结果".to_string())
}

#[tauri::command]
fn orchestrator_submit_task(
    title: String,
    input: String,
    custom_path: Option<String>,
) -> Result<OrchestratorTask, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    services::control_plane::orchestrator_submit_task(&openclaw_dir, title, input)
}

#[tauri::command]
fn orchestrator_list_tasks(custom_path: Option<String>) -> Result<Vec<OrchestratorTask>, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    services::control_plane::orchestrator_list_tasks(&openclaw_dir)
}

#[tauri::command]
fn orchestrator_retry_step(
    task_id: String,
    step_id: String,
    custom_path: Option<String>,
) -> Result<OrchestratorTask, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    services::control_plane::orchestrator_retry_step(&openclaw_dir, task_id, step_id)
}

#[tauri::command]
fn capabilities_list(custom_path: Option<String>) -> Result<Vec<AgentCapability>, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    services::control_plane::capabilities_list(&openclaw_dir)
}

#[tauri::command]
fn capabilities_upsert(
    agent_id: String,
    specialty: String,
    primary_model: String,
    fallback_model: Option<String>,
    tools: Vec<String>,
    strengths: Vec<String>,
    max_cost_tier: String,
    custom_path: Option<String>,
) -> Result<AgentCapability, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    services::control_plane::capabilities_upsert(
        &openclaw_dir,
        agent_id,
        specialty,
        primary_model,
        fallback_model,
        tools,
        strengths,
        max_cost_tier,
    )
}

#[tauri::command]
fn verifier_check_output(output: String, constraints: Vec<String>) -> Result<VerifierReport, String> {
    Ok(services::control_plane::verifier_check_output(output, constraints))
}

#[tauri::command]
fn skill_graph_save(
    name: String,
    nodes: Vec<GraphNode>,
    edges: Vec<GraphEdge>,
    custom_path: Option<String>,
) -> Result<SkillGraph, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    services::control_plane::save_skill_graph(&openclaw_dir, name, nodes, edges)
}

#[tauri::command]
fn skill_graph_list(custom_path: Option<String>) -> Result<Vec<SkillGraph>, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    services::control_plane::list_skill_graphs(&openclaw_dir)
}

#[tauri::command]
fn skill_graph_execute(
    graph_id: String,
    input: String,
    custom_path: Option<String>,
) -> Result<OrchestratorTask, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    services::control_plane::execute_skill_graph(&openclaw_dir, graph_id, input)
}

#[tauri::command]
fn ticket_ingest(
    channel: String,
    external_ref: String,
    title: String,
    payload: Value,
    custom_path: Option<String>,
) -> Result<UnifiedTicket, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    services::control_plane::ticket_ingest(&openclaw_dir, channel, external_ref, title, payload)
}

#[tauri::command]
fn ticket_list(custom_path: Option<String>) -> Result<Vec<UnifiedTicket>, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    services::control_plane::ticket_list(&openclaw_dir)
}

#[tauri::command]
fn ticket_update(
    ticket_id: String,
    status: String,
    assignee: Option<String>,
    custom_path: Option<String>,
) -> Result<UnifiedTicket, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    services::control_plane::ticket_update(&openclaw_dir, ticket_id, status, assignee)
}

#[tauri::command]
fn memory_write_layered(
    layer: String,
    scope: String,
    content: String,
    rationale: String,
    tags: Vec<String>,
    custom_path: Option<String>,
) -> Result<MemoryRecord, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    services::control_plane::memory_write(&openclaw_dir, layer, scope, content, rationale, tags)
}

#[tauri::command]
fn memory_query_layered(
    layer: Option<String>,
    query: Option<String>,
    custom_path: Option<String>,
) -> Result<Vec<MemoryRecord>, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    services::control_plane::memory_query(&openclaw_dir, layer, query)
}

#[tauri::command]
fn sandbox_preview_action(action_type: String, resource: String) -> Result<SandboxPreview, String> {
    Ok(services::control_plane::sandbox_preview(action_type, resource))
}

#[tauri::command]
fn sandbox_execute_action(
    action_type: String,
    resource: String,
    approved: bool,
    custom_path: Option<String>,
) -> Result<String, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    services::control_plane::sandbox_execute(&openclaw_dir, action_type, resource, approved)
}

#[tauri::command]
fn debate_run(task: String) -> Result<DebateResult, String> {
    Ok(services::control_plane::debate_run(task))
}

#[tauri::command]
fn replay_snapshot_create(
    task_id: String,
    input: String,
    tool_calls: Vec<String>,
    config: Value,
    custom_path: Option<String>,
) -> Result<TaskSnapshot, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    services::control_plane::snapshot_create(&openclaw_dir, task_id, input, tool_calls, config)
}

#[tauri::command]
fn replay_snapshot_list(custom_path: Option<String>) -> Result<Vec<TaskSnapshot>, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    services::control_plane::snapshot_list(&openclaw_dir)
}

#[tauri::command]
fn replay_snapshot_replay(snapshot_id: String, custom_path: Option<String>) -> Result<OrchestratorTask, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    services::control_plane::snapshot_replay(&openclaw_dir, snapshot_id)
}

#[tauri::command]
fn promptops_create_version(
    name: String,
    rules: HashMap<String, String>,
    traffic_percent: u8,
    custom_path: Option<String>,
) -> Result<PromptPolicyVersion, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    services::control_plane::promptops_create_version(&openclaw_dir, name, rules, traffic_percent)
}

#[tauri::command]
fn promptops_activate(version_id: String, custom_path: Option<String>) -> Result<Vec<PromptPolicyVersion>, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    services::control_plane::promptops_activate(&openclaw_dir, version_id)
}

#[tauri::command]
fn promptops_list(custom_path: Option<String>) -> Result<Vec<PromptPolicyVersion>, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    services::control_plane::promptops_list(&openclaw_dir)
}

#[tauri::command]
fn enterprise_set_role(user_id: String, role: String, custom_path: Option<String>) -> Result<RoleBinding, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    services::control_plane::role_binding_set(&openclaw_dir, user_id, role)
}

#[tauri::command]
fn enterprise_list_roles(custom_path: Option<String>) -> Result<Vec<RoleBinding>, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    services::control_plane::role_binding_list(&openclaw_dir)
}

#[tauri::command]
fn enterprise_list_audit(category: Option<String>, custom_path: Option<String>) -> Result<Vec<AuditEvent>, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    services::control_plane::audit_list(&openclaw_dir, category)
}

#[tauri::command]
fn enterprise_cost_summary(custom_path: Option<String>) -> Result<CostSummary, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    services::control_plane::cost_summary(&openclaw_dir)
}

#[tauri::command]
fn control_plane_seed_demo(custom_path: Option<String>) -> Result<String, String> {
    let openclaw_dir = resolve_openclaw_dir(custom_path.as_deref());
    services::control_plane::seed_demo_data(&openclaw_dir)
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
            start_gateway_background,
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
            list_pairings_json,
            approve_pairing,
            fix_telegram_dm_policy,
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
            search_market_skills,
            install_market_skill,
            install_local_skill,
            repair_selected_skills,
            install_selected_skills,
            run_startup_migrations,
            memory_center_status,
            memory_center_read,
            memory_center_clear,
            memory_center_export,
            memory_center_bootstrap,
            read_agents_list,
            create_agent,
            rename_agent,
            delete_agent,
            set_default_agent,
            update_bindings,
            read_agent_runtime_settings,
            save_gateway_bindings,
            save_skills_scope,
            save_agent_skill_binding,
            list_gateway_instances,
            start_gateway_instance,
            stop_gateway_instance,
            restart_gateway_instance,
            health_gateway_instance,
            tail_gateway_logs,
            start_all_enabled_gateways,
            health_all_enabled_gateways,
            export_multi_gateway_diagnostic_report,
            upsert_agent_runtime_profile,
            save_agent_channel_routes,
            save_telegram_instances,
            save_channel_instances,
            apply_telegram_instance,
            apply_channel_instance,
            test_telegram_instances,
            test_single_telegram_instance,
            test_channel_instances,
            test_single_channel_instance,
            cleanup_browser_sessions_for_telegram_bindings,
            resolve_agent_channel_route,
            get_gateway_url,
            read_workspace_file,
            write_workspace_file,
            chat_list_history,
            chat_list_history_delta,
            chat_send,
            chat_abort,
            chat_wait_for_reply_background,
            orchestrator_submit_task,
            orchestrator_list_tasks,
            orchestrator_retry_step,
            capabilities_list,
            capabilities_upsert,
            verifier_check_output,
            skill_graph_save,
            skill_graph_list,
            skill_graph_execute,
            ticket_ingest,
            ticket_list,
            ticket_update,
            memory_write_layered,
            memory_query_layered,
            sandbox_preview_action,
            sandbox_execute_action,
            debate_run,
            replay_snapshot_create,
            replay_snapshot_list,
            replay_snapshot_replay,
            promptops_create_version,
            promptops_activate,
            promptops_list,
            enterprise_set_role,
            enterprise_list_roles,
            enterprise_list_audit,
            enterprise_cost_summary,
            control_plane_seed_demo,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
