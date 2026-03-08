use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct ControlPlaneState {
    pub tasks: Vec<OrchestratorTask>,
    pub agent_capabilities: Vec<AgentCapability>,
    pub skill_graphs: Vec<SkillGraph>,
    pub tickets: Vec<UnifiedTicket>,
    pub memory_records: Vec<MemoryRecord>,
    pub snapshots: Vec<TaskSnapshot>,
    pub prompt_versions: Vec<PromptPolicyVersion>,
    pub role_bindings: Vec<RoleBinding>,
    pub audit_events: Vec<AuditEvent>,
    pub cost_metrics: Vec<CostMetric>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrchestratorTask {
    pub id: String,
    pub title: String,
    pub input: String,
    pub status: String,
    pub steps: Vec<TaskStep>,
    pub final_output: Option<String>,
    pub verifier: Option<VerifierReport>,
    pub route_decision: Option<RouteDecision>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteDecision {
    pub intent: String,
    pub selected_agent: String,
    pub explanation: String,
    pub score_table: Vec<RouteScoreItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteScoreItem {
    pub agent_id: String,
    pub score: f32,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCapability {
    pub agent_id: String,
    pub specialty: String, // code | sheet | vision | general
    pub primary_model: String,
    pub fallback_model: Option<String>,
    pub tools: Vec<String>,
    pub strengths: Vec<String>,
    pub max_cost_tier: String, // low | medium | high
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskStep {
    pub id: String,
    pub name: String,
    pub assigned_agent: String,
    pub status: String,
    pub retry_count: u32,
    pub output: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerifierReport {
    pub passed: bool,
    pub score: f32,
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillGraph {
    pub id: String,
    pub name: String,
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphNode {
    pub id: String,
    pub node_type: String,
    pub config: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphEdge {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnifiedTicket {
    pub id: String,
    pub channel: String,
    pub external_ref: String,
    pub title: String,
    pub payload: Value,
    pub assignee: Option<String>,
    pub status: String,
    pub sla_minutes: u32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryRecord {
    pub id: String,
    pub layer: String,
    pub scope: String,
    pub content: String,
    pub rationale: String,
    pub tags: Vec<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SandboxPreview {
    pub action_type: String,
    pub resource: String,
    pub risk_level: String,
    pub requires_approval: bool,
    pub plan: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebateOpinion {
    pub agent: String,
    pub viewpoint: String,
    pub confidence: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebateResult {
    pub task: String,
    pub opinions: Vec<DebateOpinion>,
    pub judge_summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskSnapshot {
    pub id: String,
    pub task_id: String,
    pub input: String,
    pub tool_calls: Vec<String>,
    pub config: Value,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptPolicyVersion {
    pub id: String,
    pub name: String,
    pub rules: HashMap<String, String>,
    pub traffic_percent: u8,
    pub active: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoleBinding {
    pub user_id: String,
    pub role: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEvent {
    pub id: String,
    pub category: String,
    pub action: String,
    pub subject: String,
    pub detail: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CostMetric {
    pub id: String,
    pub task_id: Option<String>,
    pub tokens: u64,
    pub latency_ms: u64,
    pub success: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CostSummary {
    pub total_tokens: u64,
    pub avg_latency_ms: u64,
    pub success_rate: f32,
    pub total_count: u64,
}
