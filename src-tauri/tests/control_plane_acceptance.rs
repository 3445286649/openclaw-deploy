mod domain {
    pub mod models {
        include!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/domain/models.rs"));
    }
}

mod repo {
    pub mod local_store {
        include!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/repo/local_store.rs"));
    }
}

mod services {
    pub mod control_plane {
        include!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/services/control_plane.rs"));
    }
}

use serde_json::json;
use services::control_plane;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_openclaw_dir() -> PathBuf {
    let mut p = std::env::temp_dir();
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    p.push(format!("openclaw-acceptance-{}", stamp));
    fs::create_dir_all(&p).expect("create temp dir failed");
    p
}

#[test]
fn control_plane_end_to_end_acceptance() {
    let temp_dir = temp_openclaw_dir();
    let openclaw_dir = temp_dir.to_string_lossy().to_string();

    // 0) seed demo
    let seed = control_plane::seed_demo_data(&openclaw_dir).expect("seed_demo_data");
    assert!(seed.contains("已初始化"));

    // 1) orchestrator + verifier + retry
    let task = control_plane::orchestrator_submit_task(
        &openclaw_dir,
        "验收任务".to_string(),
        "请生成表格并总结".to_string(),
    )
    .expect("orchestrator_submit_task");
    assert_eq!(task.status, "completed");
    assert!(!task.steps.is_empty());
    let retry_target = task.steps[0].id.clone();
    let retried = control_plane::orchestrator_retry_step(&openclaw_dir, task.id.clone(), retry_target.clone())
        .expect("orchestrator_retry_step");
    let retried_step = retried
        .steps
        .iter()
        .find(|s| s.id == retry_target)
        .expect("retried step exists");
    assert!(retried_step.retry_count >= 1);
    let verifier = control_plane::verifier_check_output(
        "结构完整，给出步骤和结论".to_string(),
        vec!["结构完整".to_string(), "步骤".to_string()],
    );
    assert!(verifier.passed);

    // 2) skill graph
    let graph = control_plane::save_skill_graph(
        &openclaw_dir,
        "demo graph".to_string(),
        vec![
            domain::models::GraphNode {
                id: "n1".to_string(),
                node_type: "fetch".to_string(),
                config: json!({"url":"https://example.com"}),
            },
            domain::models::GraphNode {
                id: "n2".to_string(),
                node_type: "generate".to_string(),
                config: json!({}),
            },
        ],
        vec![domain::models::GraphEdge {
            from: "n1".to_string(),
            to: "n2".to_string(),
        }],
    )
    .expect("save_skill_graph");
    let graphs = control_plane::list_skill_graphs(&openclaw_dir).expect("list_skill_graphs");
    assert!(!graphs.is_empty());
    let graph_task = control_plane::execute_skill_graph(&openclaw_dir, graph.id.clone(), "input".to_string())
        .expect("execute_skill_graph");
    assert_eq!(graph_task.status, "completed");

    // 3) ticket hub
    let ticket = control_plane::ticket_ingest(
        &openclaw_dir,
        "telegram".to_string(),
        "ext-1".to_string(),
        "渠道工单".to_string(),
        json!({"text":"hello"}),
    )
    .expect("ticket_ingest");
    assert_eq!(ticket.status, "new");
    let updated = control_plane::ticket_update(
        &openclaw_dir,
        ticket.id.clone(),
        "in_progress".to_string(),
        Some("code".to_string()),
    )
    .expect("ticket_update");
    assert_eq!(updated.status, "in_progress");

    // 4) layered memory
    let mem = control_plane::memory_write(
        &openclaw_dir,
        "project".to_string(),
        "demo".to_string(),
        "用户偏好：简洁回答".to_string(),
        "来自长期对话".to_string(),
        vec!["preference".to_string()],
    )
    .expect("memory_write");
    assert_eq!(mem.layer, "project");
    let mem_list = control_plane::memory_query(&openclaw_dir, Some("project".to_string()), Some("简洁".to_string()))
        .expect("memory_query");
    assert!(!mem_list.is_empty());

    // 5) sandbox
    let preview = control_plane::sandbox_preview("write_file".to_string(), "./tmp.txt".to_string());
    assert!(preview.requires_approval);
    let denied = control_plane::sandbox_execute(
        &openclaw_dir,
        "write_file".to_string(),
        "./tmp.txt".to_string(),
        false,
    );
    assert!(denied.is_err());
    let executed = control_plane::sandbox_execute(
        &openclaw_dir,
        "write_file".to_string(),
        "./tmp.txt".to_string(),
        true,
    )
    .expect("sandbox_execute approved");
    assert!(executed.contains("完成"));

    // 6) debate
    let debate = control_plane::debate_run("给出代码和表格联合方案".to_string());
    assert_eq!(debate.opinions.len(), 3);

    // 7) snapshot
    let snap = control_plane::snapshot_create(
        &openclaw_dir,
        task.id.clone(),
        "snapshot input".to_string(),
        vec!["fetch".to_string(), "generate".to_string()],
        json!({"mode":"demo"}),
    )
    .expect("snapshot_create");
    let snaps = control_plane::snapshot_list(&openclaw_dir).expect("snapshot_list");
    assert!(!snaps.is_empty());
    let replay_task = control_plane::snapshot_replay(&openclaw_dir, snap.id.clone()).expect("snapshot_replay");
    assert_eq!(replay_task.status, "completed");

    // 8) promptops
    let pv = control_plane::promptops_create_version(
        &openclaw_dir,
        "policy-A".to_string(),
        std::collections::HashMap::from([("tone".to_string(), "professional".to_string())]),
        30,
    )
    .expect("promptops_create_version");
    let activated = control_plane::promptops_activate(&openclaw_dir, pv.id.clone()).expect("promptops_activate");
    assert!(activated.iter().any(|v| v.id == pv.id && v.active));

    // 9) enterprise role + audit + cost
    let role = control_plane::role_binding_set(&openclaw_dir, "u1".to_string(), "admin".to_string())
        .expect("role_binding_set");
    assert_eq!(role.role, "admin");
    let roles = control_plane::role_binding_list(&openclaw_dir).expect("role_binding_list");
    assert!(!roles.is_empty());
    let audits = control_plane::audit_list(&openclaw_dir, None).expect("audit_list");
    assert!(!audits.is_empty());
    let cost = control_plane::cost_summary(&openclaw_dir).expect("cost_summary");
    assert!(cost.total_count >= 1);

    // cleanup
    let _ = fs::remove_dir_all(&temp_dir);
}
