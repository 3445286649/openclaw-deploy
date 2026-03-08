use crate::domain::models::ControlPlaneState;
use std::fs;
use std::path::PathBuf;

fn control_plane_dir(openclaw_dir: &str) -> PathBuf {
    let mut p = PathBuf::from(openclaw_dir);
    p.push("control_plane");
    p
}

fn control_plane_state_file(openclaw_dir: &str) -> PathBuf {
    let mut p = control_plane_dir(openclaw_dir);
    p.push("state.json");
    p
}

pub fn load_state(openclaw_dir: &str) -> Result<ControlPlaneState, String> {
    let path = control_plane_state_file(openclaw_dir);
    if !path.exists() {
        return Ok(ControlPlaneState::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("读取控制平面状态失败: {}", e))?;
    if raw.trim().is_empty() {
        return Ok(ControlPlaneState::default());
    }
    serde_json::from_str::<ControlPlaneState>(&raw).map_err(|e| format!("解析控制平面状态失败: {}", e))
}

pub fn save_state(openclaw_dir: &str, state: &ControlPlaneState) -> Result<(), String> {
    let dir = control_plane_dir(openclaw_dir);
    fs::create_dir_all(&dir).map_err(|e| format!("创建控制平面目录失败: {}", e))?;
    let path = control_plane_state_file(openclaw_dir);
    let body = serde_json::to_string_pretty(state).map_err(|e| format!("序列化控制平面状态失败: {}", e))?;
    fs::write(&path, body).map_err(|e| format!("写入控制平面状态失败: {}", e))
}
