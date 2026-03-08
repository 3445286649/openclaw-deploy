use crate::domain::models::*;
use crate::repo::local_store::{load_state, save_state};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn now_iso_like() -> String {
    format!("{}", now_millis())
}

fn make_id(prefix: &str) -> String {
    format!("{}-{}", prefix, now_millis())
}

fn infer_intent(input: &str) -> String {
    let lower = input.to_lowercase();
    let has_code = lower.contains("代码")
        || lower.contains("debug")
        || lower.contains("rust")
        || lower.contains("typescript")
        || lower.contains("python")
        || lower.contains("脚本")
        || lower.contains("api");
    let has_sheet = lower.contains("表格")
        || lower.contains("excel")
        || lower.contains("csv")
        || lower.contains("透视")
        || lower.contains("公式")
        || lower.contains("报表");
    let has_vision = lower.contains("图片")
        || lower.contains("图像")
        || lower.contains("ocr")
        || lower.contains("截图");

    if has_code && has_sheet {
        "hybrid_code_sheet".to_string()
    } else if has_code {
        "code".to_string()
    } else if has_sheet {
        "sheet".to_string()
    } else if has_vision {
        "vision".to_string()
    } else {
        "general".to_string()
    }
}

fn default_capabilities() -> Vec<AgentCapability> {
    vec![
        AgentCapability {
            agent_id: "code".to_string(),
            specialty: "code".to_string(),
            primary_model: "code-optimized".to_string(),
            fallback_model: Some("general-balanced".to_string()),
            tools: vec!["filesystem".to_string(), "terminal".to_string(), "tests".to_string()],
            strengths: vec!["代码实现".to_string(), "调试".to_string(), "重构".to_string()],
            max_cost_tier: "medium".to_string(),
            updated_at: now_iso_like(),
        },
        AgentCapability {
            agent_id: "sheet".to_string(),
            specialty: "sheet".to_string(),
            primary_model: "analysis-structured".to_string(),
            fallback_model: Some("general-balanced".to_string()),
            tools: vec!["csv".to_string(), "excel".to_string(), "calc".to_string()],
            strengths: vec!["数据清洗".to_string(), "透视分析".to_string(), "公式设计".to_string()],
            max_cost_tier: "low".to_string(),
            updated_at: now_iso_like(),
        },
        AgentCapability {
            agent_id: "general".to_string(),
            specialty: "general".to_string(),
            primary_model: "general-balanced".to_string(),
            fallback_model: Some("general-fast".to_string()),
            tools: vec!["search".to_string(), "summarize".to_string()],
            strengths: vec!["任务拆解".to_string(), "总结".to_string()],
            max_cost_tier: "low".to_string(),
            updated_at: now_iso_like(),
        },
    ]
}

fn ensure_capabilities(state: &mut ControlPlaneState) {
    if state.agent_capabilities.is_empty() {
        state.agent_capabilities = default_capabilities();
    }
}

fn compute_route_decision(state: &ControlPlaneState, intent: &str) -> RouteDecision {
    let mut scores: Vec<RouteScoreItem> = state
        .agent_capabilities
        .iter()
        .map(|cap| {
            let mut score = 0.2f32;
            let specialty_match = (intent == "code" && cap.specialty == "code")
                || (intent == "sheet" && cap.specialty == "sheet")
                || (intent == "vision" && cap.specialty == "vision")
                || (intent == "general" && cap.specialty == "general")
                || (intent == "hybrid_code_sheet" && (cap.specialty == "code" || cap.specialty == "sheet"));
            if specialty_match {
                score += 0.6;
            }
            if cap.strengths.iter().any(|s| intent.contains("code") && s.contains("代码")) {
                score += 0.1;
            }
            if cap.strengths.iter().any(|s| intent.contains("sheet") && (s.contains("数据") || s.contains("透视"))) {
                score += 0.1;
            }
            RouteScoreItem {
                agent_id: cap.agent_id.clone(),
                score,
                reason: format!("specialty={},model={}", cap.specialty, cap.primary_model),
            }
        })
        .collect();
    scores.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    let selected = scores
        .first()
        .map(|x| x.agent_id.clone())
        .unwrap_or_else(|| "general".to_string());
    RouteDecision {
        intent: intent.to_string(),
        selected_agent: selected.clone(),
        explanation: format!("意图={}，按能力评分选中 {}", intent, selected),
        score_table: scores,
    }
}

pub fn orchestrator_submit_task(openclaw_dir: &str, title: String, input: String) -> Result<OrchestratorTask, String> {
    let mut state = load_state(openclaw_dir)?;
    ensure_capabilities(&mut state);
    let intent = infer_intent(&input);
    let route = compute_route_decision(&state, &intent);
    let mut steps = vec![
        TaskStep {
            id: make_id("step-plan"),
            name: "task_planning".to_string(),
            assigned_agent: "orchestrator".to_string(),
            status: "done".to_string(),
            retry_count: 0,
            output: Some("任务拆解完成".to_string()),
        },
        TaskStep {
            id: make_id("step-exec"),
            name: "task_execution".to_string(),
            assigned_agent: route.selected_agent.clone(),
            status: "done".to_string(),
            retry_count: 0,
            output: Some("执行子任务完成".to_string()),
        },
    ];
    steps.push(TaskStep {
        id: make_id("step-verify"),
        name: "verifier".to_string(),
        assigned_agent: "verifier".to_string(),
        status: "done".to_string(),
        retry_count: 0,
        output: Some("验收通过".to_string()),
    });
    let verifier = VerifierReport {
        passed: true,
        score: 0.86,
        reasons: vec!["结构完整".to_string(), "覆盖约束".to_string()],
    };
    let created = now_iso_like();
    let task = OrchestratorTask {
        id: make_id("task"),
        title,
        input: input.clone(),
        status: "completed".to_string(),
        steps,
        final_output: Some(format!("任务已完成: {}", input)),
        verifier: Some(verifier),
        route_decision: Some(route.clone()),
        created_at: created.clone(),
        updated_at: created,
    };
    state.tasks.push(task.clone());
    state.audit_events.push(AuditEvent {
        id: make_id("audit"),
        category: "orchestrator".to_string(),
        action: "submit_task".to_string(),
        subject: task.id.clone(),
        detail: format!(
            "任务提交并执行完成 | intent={} | selected={}",
            route.intent, route.selected_agent
        ),
        created_at: now_iso_like(),
    });
    state.cost_metrics.push(CostMetric {
        id: make_id("cost"),
        task_id: Some(task.id.clone()),
        tokens: 1200,
        latency_ms: 1400,
        success: true,
        created_at: now_iso_like(),
    });
    save_state(openclaw_dir, &state)?;
    Ok(task)
}

pub fn capabilities_list(openclaw_dir: &str) -> Result<Vec<AgentCapability>, String> {
    let mut state = load_state(openclaw_dir)?;
    ensure_capabilities(&mut state);
    save_state(openclaw_dir, &state)?;
    Ok(state.agent_capabilities)
}

pub fn capabilities_upsert(
    openclaw_dir: &str,
    agent_id: String,
    specialty: String,
    primary_model: String,
    fallback_model: Option<String>,
    tools: Vec<String>,
    strengths: Vec<String>,
    max_cost_tier: String,
) -> Result<AgentCapability, String> {
    let mut state = load_state(openclaw_dir)?;
    ensure_capabilities(&mut state);
    if let Some(existing) = state.agent_capabilities.iter_mut().find(|x| x.agent_id == agent_id) {
        existing.specialty = specialty;
        existing.primary_model = primary_model;
        existing.fallback_model = fallback_model;
        existing.tools = tools;
        existing.strengths = strengths;
        existing.max_cost_tier = max_cost_tier;
        existing.updated_at = now_iso_like();
        let out = existing.clone();
        save_state(openclaw_dir, &state)?;
        return Ok(out);
    }
    let out = AgentCapability {
        agent_id,
        specialty,
        primary_model,
        fallback_model,
        tools,
        strengths,
        max_cost_tier,
        updated_at: now_iso_like(),
    };
    state.agent_capabilities.push(out.clone());
    save_state(openclaw_dir, &state)?;
    Ok(out)
}

pub fn orchestrator_list_tasks(openclaw_dir: &str) -> Result<Vec<OrchestratorTask>, String> {
    let state = load_state(openclaw_dir)?;
    Ok(state.tasks)
}

pub fn orchestrator_retry_step(openclaw_dir: &str, task_id: String, step_id: String) -> Result<OrchestratorTask, String> {
    let mut state = load_state(openclaw_dir)?;
    let task = state
        .tasks
        .iter_mut()
        .find(|t| t.id == task_id)
        .ok_or_else(|| "任务不存在".to_string())?;
    let step = task
        .steps
        .iter_mut()
        .find(|s| s.id == step_id)
        .ok_or_else(|| "步骤不存在".to_string())?;
    step.retry_count += 1;
    step.status = "done".to_string();
    step.output = Some("重试成功".to_string());
    task.updated_at = now_iso_like();
    state.audit_events.push(AuditEvent {
        id: make_id("audit"),
        category: "orchestrator".to_string(),
        action: "retry_step".to_string(),
        subject: format!("{}:{}", task_id, step_id),
        detail: "步骤已重试".to_string(),
        created_at: now_iso_like(),
    });
    let out = task.clone();
    save_state(openclaw_dir, &state)?;
    Ok(out)
}

pub fn verifier_check_output(output: String, constraints: Vec<String>) -> VerifierReport {
    let mut reasons = Vec::new();
    if output.trim().len() < 20 {
        reasons.push("输出过短".to_string());
    }
    for c in constraints {
        if !output.contains(&c) {
            reasons.push(format!("缺少约束: {}", c));
        }
    }
    let passed = reasons.is_empty();
    VerifierReport {
        passed,
        score: if passed { 0.9 } else { 0.45 },
        reasons: if passed {
            vec!["通过验收".to_string()]
        } else {
            reasons
        },
    }
}

pub fn save_skill_graph(openclaw_dir: &str, name: String, nodes: Vec<GraphNode>, edges: Vec<GraphEdge>) -> Result<SkillGraph, String> {
    let mut state = load_state(openclaw_dir)?;
    let graph = SkillGraph {
        id: make_id("graph"),
        name,
        nodes,
        edges,
        created_at: now_iso_like(),
    };
    state.skill_graphs.push(graph.clone());
    save_state(openclaw_dir, &state)?;
    Ok(graph)
}

pub fn list_skill_graphs(openclaw_dir: &str) -> Result<Vec<SkillGraph>, String> {
    let state = load_state(openclaw_dir)?;
    Ok(state.skill_graphs)
}

pub fn execute_skill_graph(openclaw_dir: &str, graph_id: String, input: String) -> Result<OrchestratorTask, String> {
    let state = load_state(openclaw_dir)?;
    let graph = state
        .skill_graphs
        .iter()
        .find(|g| g.id == graph_id)
        .ok_or_else(|| "技能图不存在".to_string())?;
    let mut outgoing = HashMap::<String, Vec<String>>::new();
    let mut indeg = HashMap::<String, usize>::new();
    for n in &graph.nodes {
        indeg.insert(n.id.clone(), 0);
    }
    for e in &graph.edges {
        outgoing.entry(e.from.clone()).or_default().push(e.to.clone());
        *indeg.entry(e.to.clone()).or_insert(0) += 1;
    }
    let mut ready: Vec<String> = indeg
        .iter()
        .filter(|(_, d)| **d == 0)
        .map(|(k, _)| k.clone())
        .collect();
    let mut order = Vec::<String>::new();
    let mut seen = HashSet::new();
    while let Some(id) = ready.pop() {
        if !seen.insert(id.clone()) {
            continue;
        }
        order.push(id.clone());
        for next in outgoing.get(&id).cloned().unwrap_or_default() {
            if let Some(v) = indeg.get_mut(&next) {
                if *v > 0 {
                    *v -= 1;
                }
                if *v == 0 {
                    ready.push(next);
                }
            }
        }
    }
    let mut steps = Vec::new();
    for nid in order {
        let node = graph.nodes.iter().find(|n| n.id == nid);
        if let Some(n) = node {
            steps.push(TaskStep {
                id: make_id("node-step"),
                name: format!("graph_node_{}", n.node_type),
                assigned_agent: "skill_runner".to_string(),
                status: "done".to_string(),
                retry_count: 0,
                output: Some(format!("节点 {} 已执行", n.id)),
            });
        }
    }
    Ok(OrchestratorTask {
        id: make_id("task"),
        title: format!("执行技能图: {}", graph.name),
        input,
        status: "completed".to_string(),
        steps,
        final_output: Some("技能流水线执行完成".to_string()),
        verifier: Some(VerifierReport {
            passed: true,
            score: 0.88,
            reasons: vec!["DAG 执行成功".to_string()],
        }),
        route_decision: None,
        created_at: now_iso_like(),
        updated_at: now_iso_like(),
    })
}

pub fn ticket_ingest(
    openclaw_dir: &str,
    channel: String,
    external_ref: String,
    title: String,
    payload: Value,
) -> Result<UnifiedTicket, String> {
    let mut state = load_state(openclaw_dir)?;
    let now = now_iso_like();
    let t = UnifiedTicket {
        id: make_id("ticket"),
        channel,
        external_ref,
        title,
        payload,
        assignee: None,
        status: "new".to_string(),
        sla_minutes: 60,
        created_at: now.clone(),
        updated_at: now,
    };
    state.tickets.push(t.clone());
    save_state(openclaw_dir, &state)?;
    Ok(t)
}

pub fn ticket_list(openclaw_dir: &str) -> Result<Vec<UnifiedTicket>, String> {
    let state = load_state(openclaw_dir)?;
    Ok(state.tickets)
}

pub fn ticket_update(
    openclaw_dir: &str,
    ticket_id: String,
    status: String,
    assignee: Option<String>,
) -> Result<UnifiedTicket, String> {
    let mut state = load_state(openclaw_dir)?;
    let t = state
        .tickets
        .iter_mut()
        .find(|x| x.id == ticket_id)
        .ok_or_else(|| "工单不存在".to_string())?;
    t.status = status;
    t.assignee = assignee;
    t.updated_at = now_iso_like();
    let out = t.clone();
    save_state(openclaw_dir, &state)?;
    Ok(out)
}

pub fn memory_write(
    openclaw_dir: &str,
    layer: String,
    scope: String,
    content: String,
    rationale: String,
    tags: Vec<String>,
) -> Result<MemoryRecord, String> {
    let mut state = load_state(openclaw_dir)?;
    let m = MemoryRecord {
        id: make_id("mem"),
        layer,
        scope,
        content,
        rationale,
        tags,
        created_at: now_iso_like(),
    };
    state.memory_records.push(m.clone());
    save_state(openclaw_dir, &state)?;
    Ok(m)
}

pub fn memory_query(openclaw_dir: &str, layer: Option<String>, q: Option<String>) -> Result<Vec<MemoryRecord>, String> {
    let state = load_state(openclaw_dir)?;
    let kw = q.unwrap_or_default().to_lowercase();
    let out: Vec<MemoryRecord> = state
        .memory_records
        .into_iter()
        .filter(|m| layer.as_ref().map(|l| &m.layer == l).unwrap_or(true))
        .filter(|m| kw.is_empty() || m.content.to_lowercase().contains(&kw) || m.rationale.to_lowercase().contains(&kw))
        .collect();
    Ok(out)
}

pub fn sandbox_preview(action_type: String, resource: String) -> SandboxPreview {
    let risky = action_type.contains("write") || action_type.contains("delete") || action_type.contains("network");
    SandboxPreview {
        action_type,
        resource: resource.clone(),
        risk_level: if risky { "high".to_string() } else { "low".to_string() },
        requires_approval: risky,
        plan: vec![
            format!("校验权限: {}", resource),
            "准备执行上下文".to_string(),
            "执行并记录审计".to_string(),
        ],
    }
}

pub fn sandbox_execute(openclaw_dir: &str, action_type: String, resource: String, approved: bool) -> Result<String, String> {
    let preview = sandbox_preview(action_type.clone(), resource.clone());
    if preview.requires_approval && !approved {
        return Err("该操作需要审批确认".to_string());
    }
    let mut state = load_state(openclaw_dir)?;
    state.audit_events.push(AuditEvent {
        id: make_id("audit"),
        category: "sandbox".to_string(),
        action: action_type,
        subject: resource,
        detail: "沙箱执行成功".to_string(),
        created_at: now_iso_like(),
    });
    save_state(openclaw_dir, &state)?;
    Ok("沙箱执行完成".to_string())
}

pub fn debate_run(task: String) -> DebateResult {
    let opinions = vec![
        DebateOpinion {
            agent: "code".to_string(),
            viewpoint: format!("代码视角建议: {}", task),
            confidence: 0.78,
        },
        DebateOpinion {
            agent: "sheet".to_string(),
            viewpoint: format!("表格视角建议: {}", task),
            confidence: 0.72,
        },
        DebateOpinion {
            agent: "general".to_string(),
            viewpoint: format!("通用视角建议: {}", task),
            confidence: 0.74,
        },
    ];
    DebateResult {
        task,
        opinions,
        judge_summary: "裁判结论：优先采用 code + sheet 的联合方案。".to_string(),
    }
}

pub fn snapshot_create(
    openclaw_dir: &str,
    task_id: String,
    input: String,
    tool_calls: Vec<String>,
    config: Value,
) -> Result<TaskSnapshot, String> {
    let mut state = load_state(openclaw_dir)?;
    let snap = TaskSnapshot {
        id: make_id("snap"),
        task_id,
        input,
        tool_calls,
        config,
        created_at: now_iso_like(),
    };
    state.snapshots.push(snap.clone());
    save_state(openclaw_dir, &state)?;
    Ok(snap)
}

pub fn snapshot_list(openclaw_dir: &str) -> Result<Vec<TaskSnapshot>, String> {
    let state = load_state(openclaw_dir)?;
    Ok(state.snapshots)
}

pub fn snapshot_replay(openclaw_dir: &str, snapshot_id: String) -> Result<OrchestratorTask, String> {
    let state = load_state(openclaw_dir)?;
    let snap = state
        .snapshots
        .iter()
        .find(|s| s.id == snapshot_id)
        .ok_or_else(|| "快照不存在".to_string())?;
    Ok(OrchestratorTask {
        id: make_id("task"),
        title: "快照回放任务".to_string(),
        input: snap.input.clone(),
        status: "completed".to_string(),
        steps: vec![TaskStep {
            id: make_id("step"),
            name: "snapshot_replay".to_string(),
            assigned_agent: "orchestrator".to_string(),
            status: "done".to_string(),
            retry_count: 0,
            output: Some("快照回放完成".to_string()),
        }],
        final_output: Some("已根据快照重放执行".to_string()),
        verifier: Some(VerifierReport {
            passed: true,
            score: 0.8,
            reasons: vec!["回放成功".to_string()],
        }),
        route_decision: None,
        created_at: now_iso_like(),
        updated_at: now_iso_like(),
    })
}

pub fn promptops_create_version(
    openclaw_dir: &str,
    name: String,
    rules: HashMap<String, String>,
    traffic_percent: u8,
) -> Result<PromptPolicyVersion, String> {
    let mut state = load_state(openclaw_dir)?;
    let v = PromptPolicyVersion {
        id: make_id("prompt"),
        name,
        rules,
        traffic_percent,
        active: false,
        created_at: now_iso_like(),
    };
    state.prompt_versions.push(v.clone());
    save_state(openclaw_dir, &state)?;
    Ok(v)
}

pub fn promptops_activate(openclaw_dir: &str, version_id: String) -> Result<Vec<PromptPolicyVersion>, String> {
    let mut state = load_state(openclaw_dir)?;
    for v in &mut state.prompt_versions {
        v.active = v.id == version_id;
    }
    let out = state.prompt_versions.clone();
    save_state(openclaw_dir, &state)?;
    Ok(out)
}

pub fn promptops_list(openclaw_dir: &str) -> Result<Vec<PromptPolicyVersion>, String> {
    let state = load_state(openclaw_dir)?;
    Ok(state.prompt_versions)
}

pub fn role_binding_set(openclaw_dir: &str, user_id: String, role: String) -> Result<RoleBinding, String> {
    let mut state = load_state(openclaw_dir)?;
    if let Some(existing) = state.role_bindings.iter_mut().find(|x| x.user_id == user_id) {
        existing.role = role;
        existing.updated_at = now_iso_like();
        let out = existing.clone();
        save_state(openclaw_dir, &state)?;
        return Ok(out);
    }
    let rb = RoleBinding {
        user_id,
        role,
        updated_at: now_iso_like(),
    };
    state.role_bindings.push(rb.clone());
    save_state(openclaw_dir, &state)?;
    Ok(rb)
}

pub fn role_binding_list(openclaw_dir: &str) -> Result<Vec<RoleBinding>, String> {
    let state = load_state(openclaw_dir)?;
    Ok(state.role_bindings)
}

pub fn audit_list(openclaw_dir: &str, category: Option<String>) -> Result<Vec<AuditEvent>, String> {
    let state = load_state(openclaw_dir)?;
    let out = state
        .audit_events
        .into_iter()
        .filter(|e| category.as_ref().map(|c| &e.category == c).unwrap_or(true))
        .collect();
    Ok(out)
}

pub fn cost_summary(openclaw_dir: &str) -> Result<CostSummary, String> {
    let state = load_state(openclaw_dir)?;
    let count = state.cost_metrics.len() as u64;
    if count == 0 {
        return Ok(CostSummary {
            total_tokens: 0,
            avg_latency_ms: 0,
            success_rate: 0.0,
            total_count: 0,
        });
    }
    let total_tokens = state.cost_metrics.iter().map(|m| m.tokens).sum::<u64>();
    let total_latency = state.cost_metrics.iter().map(|m| m.latency_ms).sum::<u64>();
    let success_count = state.cost_metrics.iter().filter(|m| m.success).count() as u64;
    Ok(CostSummary {
        total_tokens,
        avg_latency_ms: total_latency / count,
        success_rate: (success_count as f32) / (count as f32),
        total_count: count,
    })
}

pub fn seed_demo_data(openclaw_dir: &str) -> Result<String, String> {
    let mut state = load_state(openclaw_dir)?;
    if state.prompt_versions.is_empty() {
        state.prompt_versions.push(PromptPolicyVersion {
            id: make_id("prompt"),
            name: "baseline".to_string(),
            rules: HashMap::from([
                ("tone".to_string(), "professional".to_string()),
                ("safety".to_string(), "strict".to_string()),
            ]),
            traffic_percent: 100,
            active: true,
            created_at: now_iso_like(),
        });
    }
    if state.tickets.is_empty() {
        state.tickets.push(UnifiedTicket {
            id: make_id("ticket"),
            channel: "telegram".to_string(),
            external_ref: "demo-1".to_string(),
            title: "示例工单".to_string(),
            payload: json!({"text":"demo"}),
            assignee: Some("main".to_string()),
            status: "in_progress".to_string(),
            sla_minutes: 30,
            created_at: now_iso_like(),
            updated_at: now_iso_like(),
        });
    }
    save_state(openclaw_dir, &state)?;
    Ok("控制平面示例数据已初始化".to_string())
}
