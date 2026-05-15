import { Suspense, lazy, useState, useEffect, useRef, useMemo, useCallback, memo, startTransition, type CSSProperties, type UIEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open } from "@tauri-apps/plugin-dialog";
import {
  appendDeltaUniqueMessages,
  buildChatPreviewFromMessages,
  isSameChatMessageList,
  normalizeChatText,
  sanitizeChatMessageForCache,
  trimChatMessagesForUi,
  type ChatPreviewMeta,
} from "./chatState";
import { useBufferedLogState } from "./hooks/useBufferedLogState";
import { useTauriListener } from "./hooks/useTauriListener";
import { cancelIdleTask, measureAsync, recordPerfMetric, scheduleIdleTask, waitForNextPaint } from "./perf";
import {
  CheckCircle2,
  XCircle,
  Loader2,
  ChevronRight,
  Download,
  Key,
  Play,
  ExternalLink,
  Wrench,
  SlidersHorizontal,
  Sparkles,
  Brain,
  ShieldCheck,
  House,
  MessageSquareText,
} from "lucide-react";
const ChatPage = lazy(() => import("./pages/ChatPage"));
const TuningAgentsSection = lazy(() => import("./pages/TuningAgentsSection"));
const TuningHealthSection = lazy(() => import("./pages/TuningHealthSection"));

interface EnvCheckResult {
  ok: boolean;
  version?: string;
  message: string;
}

interface InstallResult {
  config_dir: string;
  install_dir: string;
}

interface InstallOpenclawFinishedEvent {
  ok: boolean;
  message: string;
  result?: InstallResult | null;
}

interface UninstallOpenclawFinishedEvent {
  ok: boolean;
  message: string;
}

interface UninstallOpenclawPreview {
  install_dir: string;
  config_dirs: string[];
  warnings: string[];
}

interface ChannelConfig {
  botToken?: string;
  chatId?: string;
  appId?: string;
  appSecret?: string;
  appKey?: string;
  token?: string;
  webhook?: string;
}

interface SavedAiConfig {
  provider: string;
  base_url?: string;
  proxy_url?: string;
  no_proxy?: string;
  has_api_key: boolean;
  config_path: string;
}

interface LocalOpenclawInfo {
  installed: boolean;
  install_dir?: string;
  executable?: string;
  version?: string;
}

interface RuntimeModelInfo {
  model?: string;
  provider_api?: string;
  base_url?: string;
  key_prefix?: string;
}

interface ChannelHealthInfo {
  configured: HealthState;
  token: HealthState;
  gateway: HealthState;
  pairing: HealthState;
  detail: string;
}

interface KeySyncStatus {
  synced: boolean;
  openclaw_json_key_prefix?: string;
  env_key_prefix?: string;
  auth_profile_key_prefix?: string;
  detail: string;
}

interface SelfCheckItem {
  key: string;
  label: string;
  status: "ok" | "warn" | "error" | "unknown" | string;
  detail: string;
}

interface PluginInstallProgressEvent {
  channel: string;
  status: "running" | "done" | "error" | "skipped" | string;
  message: string;
  current: number;
  total: number;
}

interface PairingRequestItem {
  code?: string;
  senderId?: string;
  senderLabel?: string;
  displayName?: string;
  from?: string;
  meta?: Record<string, string | undefined>;
  [key: string]: unknown;
}

interface PairingListResponse {
  channel?: string;
  requests?: PairingRequestItem[];
}

interface SkillMissing {
  bins: string[];
  any_bins: string[];
  env: string[];
  config: string[];
  os: string[];
}

interface SkillCatalogItem {
  name: string;
  description: string;
  source: string;
  source_type?: string;
  bundled: boolean;
  eligible: boolean;
  missing: SkillMissing;
  repo_url?: string | null;
  package_name?: string | null;
  version?: string | null;
  author?: string | null;
  verified?: boolean;
  install_method?: string | null;
}

interface AgentListItem {
  id: string;
  name?: string;
  default: boolean;
  workspace?: string;
  model?: string;
}

interface AgentBindingItem {
  channel: string;
  agent_id: string;
}

interface AgentsListPayload {
  agents: AgentListItem[];
  bindings: AgentBindingItem[];
  config_path: string;
}

interface AgentRuntimeProfile {
  agent_id: string;
  provider: string;
  model: string;
}

interface AgentSkillBinding {
  agent_id: string;
  mode: string;
  enabled_skills: string[];
  isolated_state_dir?: string | null;
}

interface AgentChannelRoute {
  id: string;
  channel: string;
  agent_id: string;
  gateway_id?: string;
  bot_instance?: string;
  account?: string;
  peer?: string;
  enabled: boolean;
}

interface TelegramBotInstance {
  id: string;
  name: string;
  bot_token: string;
  chat_id?: string;
  enabled: boolean;
}

interface ChannelBotInstance {
  id: string;
  name: string;
  channel: string;
  credential1: string;
  credential2?: string;
  chat_id?: string;
  enabled: boolean;
}

interface AgentRuntimeSettingsPayload {
  schema_version: number;
  profiles: AgentRuntimeProfile[];
  channel_routes: AgentChannelRoute[];
  telegram_instances: TelegramBotInstance[];
  active_telegram_instance?: string | null;
  channel_instances: ChannelBotInstance[];
  active_channel_instances: Record<string, string>;
  gateways: GatewayBinding[];
  skills_scope: "shared" | "agent_override" | string;
  agent_skill_bindings: AgentSkillBinding[];
  settings_path: string;
}

interface AgentRouteResolveResult {
  agent_id: string;
  gateway_id?: string | null;
  matched_route_id?: string | null;
  detail: string;
}

interface GatewayRuntimeHealth {
  status: string;
  detail: string;
  checked_at: number;
}

interface GatewayBinding {
  gateway_id: string;
  agent_id: string;
  channel: string;
  instance_id: string;
  channel_instances?: Record<string, string>;
  enabled: boolean;
  state_dir?: string;
  listen_port?: number;
  pid?: number;
  auto_restart?: boolean;
  last_error?: string;
  health?: GatewayRuntimeHealth;
}

interface RuntimeDirtyFlags {
  agentsDirty: boolean;
  runtimeConfigDirty: boolean;
  gatewayHealthDirty: boolean;
  channelLinkDirty: boolean;
}

interface RuntimeFreshnessState {
  staticSnapshotAt: number | null;
  gatewaySnapshotAt: number | null;
}

interface TelegramInstanceHealth {
  id: string;
  ok: boolean;
  detail: string;
  username?: string | null;
}

interface ChannelInstanceHealth {
  channel: string;
  id: string;
  ok: boolean;
  detail: string;
}

type NonTelegramChannel = "feishu" | "dingtalk" | "discord" | "qq";
type ChannelEditorChannel = "telegram" | NonTelegramChannel;
type PairingChannel = "telegram" | "feishu" | "qq";

const EMPTY_RUNTIME_DIRTY_FLAGS: RuntimeDirtyFlags = {
  agentsDirty: false,
  runtimeConfigDirty: false,
  gatewayHealthDirty: false,
  channelLinkDirty: false,
};

const EMPTY_RUNTIME_FRESHNESS: RuntimeFreshnessState = {
  staticSnapshotAt: null,
  gatewaySnapshotAt: null,
};

interface ChatUiMessage {
  id: string;
  role: string;
  text: string;
  timestamp?: string;
  status?: "sending" | "sent" | "failed";
}

interface ChatReplyFinishedEvent {
  requestId: string;
  agentId: string;
  sessionName: string;
  ok: boolean;
  text?: string | null;
  error?: string | null;
  cursor?: number | null;
}

interface ChatSendFinishedEvent {
  requestId: string;
  agentId: string;
  sessionName: string;
  ok: boolean;
  error?: string | null;
}

interface PendingChatRequestMeta {
  requestId: string;
  targetId: string;
  userMsgId: string;
  mode: "direct" | "orchestrator";
  flowSummary?: string;
  afterCursor?: number;
}

interface ChatCachePayload {
  version: 1;
  selectedAgentId: string;
  messagesByAgent: Record<string, ChatUiMessage[]>;
  chatHistoryLoadedByAgent: Record<string, boolean>;
  sessionNamesByAgent: Record<string, string>;
}

interface ChatCacheRecord {
  cacheKey: string;
  payload: ChatCachePayload;
  updatedAt: number;
}

interface CpTaskStep {
  id: string;
  name: string;
  assigned_agent: string;
  status: string;
  retry_count: number;
  output?: string;
}

interface CpVerifierReport {
  passed: boolean;
  score: number;
  reasons: string[];
}

interface CpOrchestratorTask {
  id: string;
  title: string;
  input: string;
  status: string;
  steps: CpTaskStep[];
  final_output?: string;
  verifier?: CpVerifierReport;
  route_decision?: {
    intent: string;
    selected_agent: string;
    explanation: string;
    score_table: { agent_id: string; score: number; reason: string }[];
  };
  created_at: string;
  updated_at: string;
}

interface CpAgentCapability {
  agent_id: string;
  specialty: string;
  primary_model: string;
  fallback_model?: string;
  tools: string[];
  strengths: string[];
  max_cost_tier: string;
  updated_at: string;
}

interface CpGraphNode {
  id: string;
  node_type: string;
  config: Record<string, unknown>;
}

interface CpGraphEdge {
  from: string;
  to: string;
}

interface CpSkillGraph {
  id: string;
  name: string;
  nodes: CpGraphNode[];
  edges: CpGraphEdge[];
  created_at: string;
}

interface CpTicket {
  id: string;
  channel: string;
  external_ref: string;
  title: string;
  payload: Record<string, unknown>;
  assignee?: string;
  status: string;
  sla_minutes: number;
  created_at: string;
  updated_at: string;
}

interface CpMemoryRecord {
  id: string;
  layer: string;
  scope: string;
  content: string;
  rationale: string;
  tags: string[];
  created_at: string;
}

interface CpSandboxPreview {
  action_type: string;
  resource: string;
  risk_level: string;
  requires_approval: boolean;
  plan: string[];
}

interface CpDebateOpinion {
  agent: string;
  viewpoint: string;
  confidence: number;
}

interface CpDebateResult {
  task: string;
  opinions: CpDebateOpinion[];
  judge_summary: string;
}

interface CpSnapshot {
  id: string;
  task_id: string;
  input: string;
  tool_calls: string[];
  config: Record<string, unknown>;
  created_at: string;
}

interface CpPromptPolicyVersion {
  id: string;
  name: string;
  rules: Record<string, string>;
  traffic_percent: number;
  active: boolean;
  created_at: string;
}

interface CpRoleBinding {
  user_id: string;
  role: string;
  updated_at: string;
}

interface CpAuditEvent {
  id: string;
  category: string;
  action: string;
  subject: string;
  detail: string;
  created_at: string;
}

interface CpCostSummary {
  total_tokens: number;
  avg_latency_ms: number;
  success_rate: number;
  total_count: number;
}

const CHAT_RENDER_BATCH = 48;
const CHAT_CACHE_MAX_MESSAGES = 120;
const CHAT_CACHE_DB_NAME = "openclaw-chat-cache";
const CHAT_CACHE_STORE_NAME = "snapshots";
const DEFAULT_SYNC_SESSION_NAME = "main";
const DEFAULT_ISOLATED_SESSION_NAME = "desktop";
const PAGE_AUTO_REFRESH_TTL_MS = 45000;
const EMPTY_AGENTS: AgentListItem[] = [];
const EMPTY_CHAT_MESSAGES: ChatUiMessage[] = [];
type ChatSessionMode = "isolated" | "synced";

function isSameJsonShape<T>(a: T, b: T): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function buildChatCacheKey(configPath: string): string {
  const scope = normalizeConfigPath(configPath) || "default";
  return `openclaw_chat_cache_v2::${scope}::synced`;
}

function openChatCacheDb(): Promise<IDBDatabase | null> {
  if (typeof window === "undefined" || !("indexedDB" in window)) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const request = window.indexedDB.open(CHAT_CACHE_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(CHAT_CACHE_STORE_NAME)) {
          db.createObjectStore(CHAT_CACHE_STORE_NAME, { keyPath: "cacheKey" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function readChatCacheSnapshot(cacheKey: string): Promise<ChatCachePayload | null> {
  const db = await openChatCacheDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(CHAT_CACHE_STORE_NAME, "readonly");
      const store = tx.objectStore(CHAT_CACHE_STORE_NAME);
      const request = store.get(cacheKey);
      request.onsuccess = () => {
        const record = request.result as ChatCacheRecord | undefined;
        resolve(record?.payload || null);
      };
      request.onerror = () => resolve(null);
      tx.oncomplete = () => db.close();
      tx.onerror = () => db.close();
    } catch {
      db.close();
      resolve(null);
    }
  });
}

async function writeChatCacheSnapshot(cacheKey: string, payload: ChatCachePayload): Promise<void> {
  const db = await openChatCacheDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(CHAT_CACHE_STORE_NAME, "readwrite");
      const store = tx.objectStore(CHAT_CACHE_STORE_NAME);
      store.put({
        cacheKey,
        payload,
        updatedAt: Date.now(),
      } satisfies ChatCacheRecord);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}

async function deleteChatCacheSnapshot(cacheKey: string): Promise<void> {
  const db = await openChatCacheDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(CHAT_CACHE_STORE_NAME, "readwrite");
      const store = tx.objectStore(CHAT_CACHE_STORE_NAME);
      store.delete(cacheKey);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}

function isSameChannelHealthInfo(a: ChannelHealthInfo, b: ChannelHealthInfo): boolean {
  return (
    a.configured === b.configured &&
    a.token === b.token &&
    a.gateway === b.gateway &&
    a.pairing === b.pairing &&
    a.detail === b.detail
  );
}

function hasManualSkillGaps(s: SkillCatalogItem): boolean {
  return s.missing.env.length > 0 || s.missing.config.length > 0 || s.missing.os.length > 0;
}

function isAutoFixableSkill(s: SkillCatalogItem): boolean {
  if (s.eligible) return false;
  if (hasManualSkillGaps(s)) return false;
  return s.missing.bins.length > 0 || s.missing.any_bins.length > 0;
}

function buildManualFixHint(s: SkillCatalogItem): string {
  const lines: string[] = [`Skill: ${s.name}`];
  if (s.missing.env.length) {
    lines.push(`环境变量: ${s.missing.env.join(", ")}`);
    for (const key of s.missing.env) {
      lines.push(`export ${key}=<your_value>`);
    }
  }
  if (s.missing.config.length) {
    lines.push(`配置项: ${s.missing.config.join(", ")}`);
  }
  if (s.missing.os.length) {
    lines.push(`平台限制: ${s.missing.os.join(", ")}`);
  }
  if (!s.missing.env.length && !s.missing.config.length && !s.missing.os.length) {
    lines.push("未检测到需手动处理项。");
  }
  return lines.join("\n");
}

const SkillTableRow = memo(function SkillTableRow({
  skill,
  checked,
  onToggle,
  onCopyManualHint,
  agentEnabled,
  showAgentToggle,
  onToggleAgentSkill,
  repairState,
}: {
  skill: SkillCatalogItem;
  checked: boolean;
  onToggle: (name: string, checked: boolean) => void;
  onCopyManualHint: (skill: SkillCatalogItem) => void;
  agentEnabled: boolean;
  showAgentToggle: boolean;
  onToggleAgentSkill: (name: string, enabled: boolean) => void;
  repairState?: "fixed" | "still_missing" | "manual";
}) {
  const missingParts = [
    skill.missing.bins.length ? `bins:${skill.missing.bins.join(",")}` : "",
    skill.missing.any_bins.length ? `any:${skill.missing.any_bins.join(",")}` : "",
    skill.missing.env.length ? `env:${skill.missing.env.join(",")}` : "",
    skill.missing.config.length ? `cfg:${skill.missing.config.slice(0, 2).join(",")}` : "",
    skill.missing.os.length ? `os:${skill.missing.os.join(",")}` : "",
  ].filter(Boolean);
  const manual = hasManualSkillGaps(skill);
  const autoFixable = isAutoFixableSkill(skill);
  const statusText = skill.eligible
    ? "可用"
    : manual
      ? "需手动处理"
      : repairState === "still_missing"
        ? "仍缺依赖（已尝试修复）"
        : "缺依赖（可修复）";
  const statusClass = skill.eligible
    ? "text-emerald-400"
    : manual
      ? "text-rose-300"
      : repairState === "still_missing"
        ? "text-amber-200"
        : "text-amber-300";

  return (
    <tr className="border-t border-slate-800">
      <td className="px-2 py-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onToggle(skill.name, e.target.checked)}
        />
      </td>
      <td className="px-2 py-2 text-slate-200">{skill.name}</td>
      <td className="px-2 py-2">
        <div className="flex flex-col gap-1">
          <span>{skill.source || (skill.bundled ? "bundled" : "unknown")}</span>
          {(skill.author || skill.version) && (
            <span className="text-[11px] text-slate-500">
              {[skill.author, skill.version].filter(Boolean).join(" · ")}
            </span>
          )}
        </div>
      </td>
      <td className={`px-2 py-2 ${statusClass}`}>
        {statusText}
      </td>
      <td className={`px-2 py-2 ${agentEnabled ? "text-emerald-300" : "text-slate-500"}`}>
        {agentEnabled ? "已启用" : "未启用"}
      </td>
      <td className="px-2 py-2 text-slate-400">{missingParts.join(" | ") || "-"}</td>
      <td className="px-2 py-2">
        <div className="flex flex-wrap items-center gap-2">
          {manual ? (
            <button
              onClick={() => onCopyManualHint(skill)}
              className="px-2 py-1 bg-amber-700 hover:bg-amber-600 rounded text-xs"
            >
              复制手动指引
            </button>
          ) : autoFixable ? (
            <span className="text-emerald-300 text-xs">
              {repairState === "still_missing" ? "仍缺依赖，说明还没修好，可再次尝试或手动处理" : "可点“修复缺失依赖（选中）”"}
            </span>
          ) : (
            <span className="text-slate-500 text-xs">-</span>
          )}
          {showAgentToggle && (
            <button
              onClick={() => onToggleAgentSkill(skill.name, !agentEnabled)}
              className={`px-2 py-1 rounded text-xs ${
                agentEnabled ? "bg-slate-700 hover:bg-slate-600 text-slate-200" : "bg-sky-700 hover:bg-sky-600 text-white"
              }`}
            >
              {agentEnabled ? "对当前 Agent 禁用" : "对当前 Agent 启用"}
            </button>
          )}
        </div>
      </td>
    </tr>
  );
});
type QuickMode = "stable" | "balanced" | "performance";
type TuneLength = "short" | "medium" | "long";
type TuneTone = "professional" | "friendly" | "concise";
type TuneProactivity = "low" | "balanced" | "high";
type TunePermission = "suggest" | "confirm" | "auto_low_risk";
type MemoryMode = "off" | "session" | "long";
type ScenarioPreset = "none" | "customer_support" | "short_video" | "office" | "developer";

interface SkillsRepairProgressEvent {
  skill: string;
  status: string;
  current: number;
  total: number;
  message: string;
}

interface PluginInstallFinishedEvent {
  ok: boolean;
  message: string;
}

interface SkillImportProgressEvent {
  kind: "market" | "local" | string;
  label: string;
  status: string;
  message: string;
  current: number;
  total: number;
}

interface SkillImportFinishedEvent {
  kind: "market" | "local" | string;
  label: string;
  ok: boolean;
  message: string;
}

interface SkillsManageFinishedEvent {
  action: string;
  ok: boolean;
  message: string;
}

interface SkillsSelectionFinishedEvent {
  action: "install" | "repair" | string;
  skillNames: string[];
  ok: boolean;
  message: string;
}

interface TelegramBatchTestFinishedEvent {
  ok: boolean;
  results?: TelegramInstanceHealth[] | null;
  error?: string | null;
}

interface ChannelBatchTestFinishedEvent {
  channel: NonTelegramChannel | string;
  ok: boolean;
  results?: ChannelInstanceHealth[] | null;
  error?: string | null;
}

interface StartupMigrationResult {
  fixed_count: number;
  fixed_dirs: string[];
}

interface MemoryCenterStatus {
  enabled: boolean;
  memory_file_exists: boolean;
  memory_dir_exists: boolean;
  memory_file_count: number;
  note: string;
}

interface GatewayStartEvent {
  ok: boolean;
  message: string;
}

interface GatewayInstanceActionFinishedEvent {
  gatewayId: string;
  action: "start" | "stop" | "restart" | string;
  ok: boolean;
  message: string;
  row?: GatewayBinding | null;
}

interface GatewayBatchStartEvent {
  ok: boolean;
  message: string;
  succeeded?: number;
  failed?: number;
  action?: "start" | "restart" | string;
}

interface GatewayBatchProgressState {
  action: "start" | "restart";
  total: number;
  done: number;
  succeeded: number;
  failed: number;
  active: boolean;
}

interface SelfCheckFinishedEvent {
  ok: boolean;
  items?: SelfCheckItem[] | null;
  error?: string | null;
}

interface TuningSelfHealFinishedEvent {
  ok: boolean;
  message: string;
}

interface TelegramSelfHealFinishedEvent {
  ok: boolean;
  gatewayIds?: string[] | null;
  message: string;
}

interface RepairHealthFinishedEvent {
  ok: boolean;
  telegram?: ChannelHealthInfo | null;
  error?: string | null;
}

interface PairingRequestsChannelResult {
  channel: PairingChannel | string;
  requests?: PairingRequestItem[] | null;
  error?: string | null;
}

interface PairingRequestsFinishedEvent {
  items?: PairingRequestsChannelResult[] | null;
}

type QueueTaskStatus = "queued" | "running" | "done" | "error" | "cancelled";
interface QueueTaskItem {
  id: string;
  name: string;
  status: QueueTaskStatus;
  retryCount: number;
  maxRetries: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}

type HealthState = "ok" | "warn" | "error" | "unknown";

type InstallStepStatus = "pending" | "running" | "done" | "error";
type OpenclawManageMode = "install" | "update";

interface InstallStepItem {
  key: string;
  label: string;
  status: InstallStepStatus;
}

const INSTALL_STEPS: InstallStepItem[] = [
  { key: "prepare_dir", label: "准备安装目录", status: "pending" },
  { key: "npm_install", label: "下载并安装 OpenClaw", status: "pending" },
  { key: "verify_files", label: "校验核心文件", status: "pending" },
  { key: "verify_cli", label: "验证命令可执行", status: "pending" },
  { key: "write_path", label: "写入 PATH", status: "pending" },
  { key: "create_config", label: "创建配置目录", status: "pending" },
];

const UPDATE_STEPS: InstallStepItem[] = [
  { key: "stop_gateways", label: "停止现有 Gateway", status: "pending" },
  { key: "prepare_dir", label: "准备更新目录", status: "pending" },
  { key: "npm_install", label: "更新程序文件", status: "pending" },
  { key: "verify_files", label: "校验核心文件", status: "pending" },
  { key: "verify_cli", label: "验证命令可执行", status: "pending" },
  { key: "write_path", label: "校验 PATH", status: "pending" },
  { key: "preserve_config", label: "保留现有配置", status: "pending" },
];

function stripAnsi(input: string): string {
  return input.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function clampLogText(input: string, maxChars = 12000): string {
  if (!input) return input;
  if (input.length <= maxChars) return input;
  return `${input.slice(0, maxChars)}\n\n...(日志过长，已截断 ${input.length - maxChars} 字符)`;
}

function makeTicketSummary(action: string, error: unknown, extra?: string): string {
  const msg = String(error ?? "unknown");
  const firstLine = msg.split(/\r?\n/)[0] || msg;
  const ts = new Date().toISOString();
  return [
    `时间: ${ts}`,
    `操作: ${action}`,
    `错误摘要: ${firstLine}`,
    extra ? `上下文: ${extra}` : "",
    "建议: 点击“最小修复”后重试；若仍失败请附上完整日志与截图。",
  ]
    .filter(Boolean)
    .join("\n");
}

function getAiServiceLabel(provider: string): string {
  return provider === "kimi" ? "Kimi" : "硅基流动";
}

function normalizeConfigPath(input: string): string {
  const p = input.trim().replace(/\\/g, "/");
  if (!p) return "";
  if (p.endsWith("/.openclaw/openclaw")) return p.slice(0, -"/openclaw".length);
  return p;
}

function isGatewayStatePath(input: string): boolean {
  const v = normalizeConfigPath(input).toLowerCase();
  if (!v) return false;
  return v.includes("/multi_gateways/");
}

function looksLikeApiKey(input: string): boolean {
  const v = input.trim();
  return /(^|\s)sk-[A-Za-z0-9._-]{12,}($|\s)/.test(v);
}

function isLikelyConfigPath(input: string): boolean {
  const v = normalizeConfigPath(input);
  if (!v) return false;
  if (looksLikeApiKey(v)) return false;
  if (isGatewayStatePath(v)) return false;
  return (
    v.startsWith("~/") ||
    /^[A-Za-z]:\//.test(v) ||
    v.startsWith("/") ||
    v.includes("/")
  );
}

function buildUninstallConfirmMessage(preview: UninstallOpenclawPreview): string {
  const lines = ["确认彻底卸载 OpenClaw 吗？", `安装目录：${preview.install_dir}`];
  if (preview.config_dirs.length > 0) {
    lines.push("", "还会删除以下配置目录（避免下次安装配置污染）：");
    for (const dir of preview.config_dirs) {
      lines.push(`- ${dir}`);
    }
  } else {
    lines.push("", "未检测到与当前安装关联的 OpenClaw 配置目录，将仅删除程序文件并清理当前用户 PATH。");
  }
  if (preview.warnings.length > 0) {
    lines.push("", "注意：");
    for (const warning of preview.warnings) {
      lines.push(`- ${warning}`);
    }
  }
  return lines.join("\n");
}

function preferredPrimaryModelForProvider(provider: string): string {
  switch (provider) {
    case "kimi":
      return "openai/moonshot-v1-32k";
    case "qwen":
    case "bailian":
      return "openai/qwen-plus";
    case "deepseek":
      return "openai/deepseek-chat";
    case "openai":
      return "openai/gpt-4o-mini";
    case "anthropic":
      return "anthropic/claude-3-5-haiku-latest";
    default:
      return "openai/gpt-4o-mini";
  }
}

function inferModelContextWindow(modelName: string): number | null {
  const s = modelName.trim().toLowerCase();
  if (!s) return null;
  if (s.includes("200k")) return 200000;
  if (s.includes("128k")) return 128000;
  if (s.includes("64k")) return 64000;
  if (s.includes("32k")) return 32000;
  if (s.includes("16k")) return 16000;
  if (s.includes("8k")) return 8192;
  if (s === "gpt-4") return 8192;
  if (s.includes("gpt-4o")) return 128000;
  return null;
}

const PRIMARY_NAV_ITEMS = [
  { id: "home", label: "首页", icon: House },
  { id: "chat", label: "聊天", icon: MessageSquareText },
  { id: "tuning", label: "调教中心", icon: SlidersHorizontal },
  { id: "repair", label: "修复中心", icon: ShieldCheck },
] as const;
const PAGE_TRANSITION_PENDING_KEY = "__page-transition__";

const TUNING_NAV_ITEMS = [
  { id: "agents", label: "Agent 管理", section: "agents", agentTab: "overview" },
  { id: "channels", label: "渠道配置", section: "agents", agentTab: "channels" },
  { id: "skills", label: "Skills", section: "skills" },
  { id: "memory", label: "记忆", section: "memory" },
  { id: "templates", label: "模板", section: "scene" },
  { id: "advanced", label: "高级设置", section: "control" },
] as const;

const AI_SERVICE_OPTIONS = [
  { id: "openai", label: "硅基流动", desc: "新手默认推荐，价格友好，适合高频使用" },
  { id: "kimi", label: "Kimi", desc: "长文本更稳，适合深度问答和长上下文" },
  { id: "official", label: "官方线路", desc: "后续上线，敬请期待" },
] as const;

const DEFAULT_OPENAI_BASE_URL = "https://api.siliconflow.cn/v1";
const DEFAULT_KIMI_BASE_URL = "https://api.moonshot.cn/v1";
const DEFAULT_RELAY_STATION_URL = (import.meta.env.VITE_YUNRUI_RELAY_STATION_URL || "").trim();
const RECOMMENDED_MODEL_FALLBACK = "deepseek-ai/DeepSeek-V3";

/** 固定硅基流动模型列表（引流用，后续接入自建中转支持更多） */
const FIXED_SILICONFLOW_MODELS: { id: string; label: string }[] = [
  { id: "deepseek-ai/DeepSeek-V3", label: "DeepSeek V3（推荐）" },
  { id: "Qwen/Qwen2.5-72B-Instruct", label: "Qwen2.5 72B" },
  { id: "GLM-4-9B-Chat", label: "GLM-4-9B / GLM-5" },
  { id: "moonshotai/Kimi-K2-Instruct-0905", label: "Kimi K2（可对话）" },
  { id: "deepseek-ai/DeepSeek-R1", label: "DeepSeek R1（备选）" },
];
const CHANNEL_DISPLAY_NAME: Record<ChannelEditorChannel, string> = {
  telegram: "Telegram",
  feishu: "飞书",
  dingtalk: "钉钉",
  discord: "Discord",
  qq: "QQ",
};

function getChannelDisplayName(channel: string): string {
  if ((channel || "").trim().toLowerCase() === "local") return "本地对话";
  return CHANNEL_DISPLAY_NAME[channel as ChannelEditorChannel] || channel;
}

function hasConfiguredTelegramDraftInstance(row?: TelegramBotInstance | null): boolean {
  return !!(row?.bot_token || "").trim();
}

function hasConfiguredChannelDraftInstance(channel: NonTelegramChannel, row?: ChannelBotInstance | null): boolean {
  const c1 = (row?.credential1 || "").trim();
  const c2 = (row?.credential2 || "").trim();
  if (channel === "discord") return !!c1;
  return !!c1 && !!c2;
}

function inferAgentIdFromChannelInstance(channel: string, instanceId: string): string | null {
  const ch = (channel || "").trim().toLowerCase();
  const iid = (instanceId || "").trim();
  if (!ch || !iid) return null;
  if (ch === "local") {
    return iid.startsWith("local-") ? iid.slice("local-".length).trim() || null : null;
  }
  if (ch === "telegram") {
    return iid.startsWith("tg-") ? iid.slice(3).trim() || null : null;
  }
  const prefix = `${ch}-`;
  return iid.startsWith(prefix) ? iid.slice(prefix.length).trim() || null : null;
}

function channelInstanceBelongsToAgent(channel: string, instanceId: string, agentId: string): boolean {
  const inferred = inferAgentIdFromChannelInstance(channel, instanceId);
  return !!inferred && inferred.toLowerCase() === (agentId || "").trim().toLowerCase();
}
const DEPLOY_SUCCESS_DIALOG =
  "恭喜部署完成！如果后续在使用、配置或渠道接入过程中遇到问题，可以加入 QQ 群 1085253453 交流反馈。";

function defaultBaseUrlForProvider(provider: string): string {
  if (provider === "kimi") return DEFAULT_KIMI_BASE_URL;
  if (provider === "qwen" || provider === "bailian") return "https://dashscope.aliyuncs.com/compatible-mode/v1";
  if (provider === "deepseek") return "https://api.deepseek.com/v1";
  if (provider === "anthropic") return "https://api.anthropic.com/v1";
  return DEFAULT_OPENAI_BASE_URL;
}

function FeedbackCard({
  toneClassName,
  title,
  headline,
  detail,
  className = "",
  detailAsPre = false,
  badge,
  detailClassName = "",
}: {
  toneClassName: string;
  title: string;
  headline?: string;
  detail?: string;
  className?: string;
  detailAsPre?: boolean;
  badge?: string;
  detailClassName?: string;
}) {
  if (!headline && !detail) return null;
  return (
    <div className={`rounded-lg border px-3 py-3 ${toneClassName} ${className}`.trim()}>
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium">{title}</p>
        {badge ? <span className="text-[11px] opacity-70">{badge}</span> : null}
      </div>
      {headline ? <p className="mt-2 whitespace-pre-wrap">{headline}</p> : null}
      {detail
        ? detailAsPre
          ? (
            <pre className={`mt-2 overflow-auto whitespace-pre-wrap text-[11px] opacity-90 ${detailClassName}`.trim()}>{detail}</pre>
          )
          : (
            <p className={`mt-1 whitespace-pre-wrap text-[11px] opacity-90 ${detailClassName}`.trim()}>{detail}</p>
          )
        : null}
    </div>
  );
}

function App() {
  const [step, setStep] = useState(0);
  const [nodeCheck, setNodeCheck] = useState<EnvCheckResult | null>(null);
  const [npmCheck, setNpmCheck] = useState<EnvCheckResult | null>(null);
  const [gitCheck, setGitCheck] = useState<EnvCheckResult | null>(null);
  const [openclawCheck, setOpenclawCheck] = useState<EnvCheckResult | null>(null);
  const [npmPathInPath, setNpmPathInPath] = useState<boolean | null>(null);
  const [npmPath, setNpmPath] = useState<string>("");
  const [addingPath, setAddingPath] = useState(false);
  const [pathAddResult, setPathAddResult] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);

  const [installing, setInstalling] = useState(false);
  const [openclawManageMode, setOpenclawManageMode] = useState<OpenclawManageMode>("install");
  const [installResult, setInstallResult] = useState<string | null>(null);
  const [installSteps, setInstallSteps] = useState<InstallStepItem[]>(INSTALL_STEPS);
  const [uninstallLog, setUninstallLog] = useState<string[]>([]);
  const logEndRef = useRef<HTMLPreElement>(null);
  const chatViewportRef = useRef<HTMLDivElement | null>(null);
  const chatStickBottomByAgentRef = useRef<Record<string, boolean>>({});
  const chatCursorByAgentRef = useRef<Record<string, number>>({});
  const loadSkillsCatalogRef = useRef<() => Promise<SkillCatalogItem[]>>(async () => []);
  const refreshMemoryCenterStatusRef = useRef<() => Promise<void>>(async () => {});
  const probeRuntimeModelConnectionRef = useRef<(cfgPath?: string) => Promise<void>>(async () => {});
  const refreshAllChannelHealthRef = useRef<(force?: boolean) => Promise<void>>(async () => {});
  const refreshLocalInfoRef = useRef<(installHint?: string, cfgPath?: string) => Promise<void>>(async () => {});
  const repairPanelWarmupTimerRef = useRef<number | null>(null);
  const startupAgentsPrewarmTimerRef = useRef<number | null>(null);
  const startupRuntimePrewarmTimerRef = useRef<number | null>(null);
  const agentEntryRuntimeRefreshTimerRef = useRef<number | null>(null);
  const agentRuntimeRefreshInFlightRef = useRef<Map<string, Promise<void>>>(new Map());
  const deferredRuntimeAdvancedApplyTimerRef = useRef<number | null>(null);
  const repairHealthRefreshPendingRef = useRef(false);
  const pairingRefreshPendingRef = useRef(false);
  const manualPairingQueryChannelRef = useRef<PairingChannel | null>(null);
  const channelInstanceAutosaveTimerRef = useRef<Record<string, number | null>>({});
  const chatSessionNameByAgentRef = useRef<Record<string, string>>({});
  const chatSessionModeRef = useRef<ChatSessionMode>("synced");
  const chatSendLockByAgentRef = useRef<Record<string, boolean>>({});
  const pendingChatRequestsRef = useRef<Record<string, PendingChatRequestMeta>>({});
  const pendingChatRequestIdByAgentRef = useRef<Record<string, string>>({});
  const lastSentFingerprintRef = useRef<Record<string, { text: string; at: number }>>({});
  const agentIdentitySyncedRef = useRef<Record<string, string>>({});
  const chatCacheHydratedKeyRef = useRef<string | null>(null);
  const chatCachePersistTimerRef = useRef<number | null>(null);
  const stepRef = useRef(0);
  const selectedAgentIdRef = useRef("");
  const lastChannelPanelAgentRef = useRef("");

  const [provider, setProvider] = useState("openai");
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [apiEntryMode, setApiEntryMode] = useState<"undecided" | "own" | "relay">("undecided");
  const [relayStationUrl, setRelayStationUrl] = useState("");
  const [baseUrl, setBaseUrl] = useState(DEFAULT_OPENAI_BASE_URL);
  const [proxyUrl, setProxyUrl] = useState("");
  const [noProxy, setNoProxy] = useState("");
  const [customConfigPath, setCustomConfigPath] = useState("");
  const [customInstallPath, setCustomInstallPath] = useState("");
  const [recommendedInstallDir, setRecommendedInstallDir] = useState("");
  const [lastInstallDir, setLastInstallDir] = useState("");
  const [saving, setSaving] = useState(false);
  const [cleaningLegacy, setCleaningLegacy] = useState(false);
  const [saveResult, setSaveResult] = useState<string | null>(null);
  const [modelTesting, setModelTesting] = useState(false);
  const [modelTestResult, setModelTestResult] = useState<string | null>(null);
  const [showAiAdvancedSettings, setShowAiAdvancedSettings] = useState(false);
  const [selectedModel, setSelectedModel] = useState(RECOMMENDED_MODEL_FALLBACK);
  const [runtimeModelInfo, setRuntimeModelInfo] = useState<RuntimeModelInfo | null>(null);
  const [keySyncStatus, setKeySyncStatus] = useState<KeySyncStatus | null>(null);
  const [runtimeProbeResult, setRuntimeProbeResult] = useState<string | null>(null);
  const [runtimeProbeLoading, setRuntimeProbeLoading] = useState(false);

  const [starting, setStarting] = useState(false);
  const [startResult, setStartResult] = useState<string | null>(null);
  const [telegramConfig, setTelegramConfig] = useState<ChannelConfig>({});
  const [pairingLoading, setPairingLoading] = useState<string | null>(null);
  const [pairingCodeByChannel, setPairingCodeByChannel] = useState<Record<PairingChannel, string>>({
    telegram: "",
    feishu: "",
    qq: "",
  });
  const [pairingRequestsByChannel, setPairingRequestsByChannel] = useState<Record<PairingChannel, PairingRequestItem[]>>({
    telegram: [],
    feishu: [],
    qq: [],
  });
  const [channelResult, setChannelResult] = useState<string | null>(null);
  const [, setTelegramHealth] = useState<{
    configured: HealthState;
    token: HealthState;
    gateway: HealthState;
    pairing: HealthState;
    detail: string;
  }>({
    configured: "unknown",
    token: "unknown",
    gateway: "unknown",
    pairing: "unknown",
    detail: "未检测",
  });
  const [autoRefreshHealth] = useState(false);
  const [savedAiHint, setSavedAiHint] = useState<string | null>(null);
  const [localInfo, setLocalInfo] = useState<LocalOpenclawInfo | null>(null);
  const [uninstalling, setUninstalling] = useState(false);
  const [selfCheckItems, setSelfCheckItems] = useState<SelfCheckItem[]>([]);
  const [selfCheckResult, setSelfCheckResult] = useState<string | null>(null);
  const [pluginSelection, setPluginSelection] = useState<Record<string, boolean>>({
    telegram: false,
    qq: false,
    feishu: false,
    discord: false,
    dingtalk: false,
  });
  const [pluginSelectionTouched, setPluginSelectionTouched] = useState(false);
  const [pluginInstallLoading, setPluginInstallLoading] = useState(false);
  const [pluginInstallResult, setPluginInstallResult] = useState<string | null>(null);
  const [pluginInstallProgress, setPluginInstallProgress] = useState<PluginInstallProgressEvent | null>(null);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsResult, setSkillsResult] = useState<string | null>(null);
  const [skillsCatalogLoading, setSkillsCatalogLoading] = useState(false);
  const [skillsCatalog, setSkillsCatalog] = useState<SkillCatalogItem[]>([]);
  const [skillsScopeSaving, setSkillsScopeSaving] = useState(false);
  const [skillsSelectedAgentId, setSkillsSelectedAgentId] = useState("");
  const [selectedSkills, setSelectedSkills] = useState<Record<string, boolean>>({});
  const [skillsRepairLoading, setSkillsRepairLoading] = useState(false);
  const [skillsAction, setSkillsAction] = useState<"install" | "repair" | null>(null);
  const [skillsRepairProgress, setSkillsRepairProgress] = useState<SkillsRepairProgressEvent | null>(null);
  const [serviceSkillsRenderLimit, setServiceSkillsRenderLimit] = useState(40);
  const [marketQuery, setMarketQuery] = useState("");
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketResults, setMarketResults] = useState<SkillCatalogItem[]>([]);
  const [marketInstallKey, setMarketInstallKey] = useState<string | null>(null);
  const [marketResult, setMarketResult] = useState<string | null>(null);
  const [skillImportProgress, setSkillImportProgress] = useState<SkillImportProgressEvent | null>(null);
  const [localSkillPath, setLocalSkillPath] = useState("");
  const [localSkillInstalling, setLocalSkillInstalling] = useState(false);
  const [skillRepairStateByName, setSkillRepairStateByName] = useState<Record<string, "fixed" | "still_missing" | "manual">>({});
  const persistAgentSkillBindingRef = useRef(
    async (_agentId: string, _mode: "inherit" | "custom", _enabledSkills: string[], _message: string) => {}
  );
  const pendingSkillImportRef = useRef<{
    kind: "market" | "local";
    key: string;
    enableForCurrentAgent?: boolean;
    targetAgentId?: string;
    skillName?: string;
    currentBindingMode?: string;
    currentEnabledSkills?: string[];
  } | null>(null);
  const [startupMigrationResult] = useState<StartupMigrationResult | null>(null);
  const [queueTasks, setQueueTasks] = useState<QueueTaskItem[]>([]);
  const queueRunnersRef = useRef<Record<string, () => Promise<void>>>({});
  const cancelledRunningTasksRef = useRef<Set<string>>(new Set());
  const [, setTicketSummary] = useState<string | null>(null);
  const installLogs = useBufferedLogState({ maxLines: 600, flushMs: 180 });
  const pluginLogs = useBufferedLogState({ maxLines: 100, flushMs: 180 });
  const skillImportLogs = useBufferedLogState({ maxLines: 120, flushMs: 180 });
  const skillsLogs = useBufferedLogState({ maxLines: 140, flushMs: 180 });
  const installLog = installLogs.lines;
  const pluginInstallProgressLog = pluginLogs.lines;
  const skillImportProgressLog = skillImportLogs.lines;
  const skillsRepairProgressLog = skillsLogs.lines;

  const [fixing, setFixing] = useState<"node" | "npm" | "git" | "openclaw" | null>(null);
  const [fixResult, setFixResult] = useState<string | null>(null);
  const [quickMode, setQuickMode] = useState<QuickMode>("stable");
  const [scenarioPreset, setScenarioPreset] = useState<ScenarioPreset>("none");
  const [tuneLength, setTuneLength] = useState<TuneLength>("medium");
  const [tuneTone, setTuneTone] = useState<TuneTone>("professional");
  const [tuneProactivity, setTuneProactivity] = useState<TuneProactivity>("balanced");
  const [tunePermission, setTunePermission] = useState<TunePermission>("confirm");
  const [memoryMode, setMemoryMode] = useState<MemoryMode>("session");
  const [tuningSection, setTuningSection] = useState<
    "quick" | "scene" | "personal" | "memory" | "health" | "skills" | "agents" | "control"
  >("quick");
  const [memoryStatus, setMemoryStatus] = useState<MemoryCenterStatus | null>(null);
  const [memorySummary, setMemorySummary] = useState<string | null>(null);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryActionLoading, setMemoryActionLoading] = useState<"read" | "clear" | "export" | "init" | null>(null);
  const [tuningActionLoading, setTuningActionLoading] = useState<"check" | "heal" | null>(null);
  const [agentCenterTab, setAgentCenterTab] = useState<"overview" | "channels">("overview");
  const [wizardOpen, setWizardOpen] = useState(false);
  const [showCommunityHub, setShowCommunityHub] = useState(false);
  const [communityHubView, setCommunityHubView] = useState<"links" | "qq-qr">("links");
  const [communityActionResult, setCommunityActionResult] = useState<string | null>(null);
  const [agentsList, setAgentsList] = useState<AgentsListPayload | null>(null);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [agentRuntimeSettings, setAgentRuntimeSettings] = useState<AgentRuntimeSettingsPayload | null>(null);
  const [agentRuntimeLoading, setAgentRuntimeLoading] = useState(false);
  const [agentProfileDrafts, setAgentProfileDrafts] = useState<Record<string, { provider: string; model: string }>>({});
  const [agentModelsByProvider, setAgentModelsByProvider] = useState<Record<string, string[]>>({});
  const [agentModelsLoadingByProvider, setAgentModelsLoadingByProvider] = useState<Record<string, boolean>>({});
  const [agentRuntimeSaving, setAgentRuntimeSaving] = useState(false);
  const [agentRuntimeResult, setAgentRuntimeResult] = useState<string | null>(null);
  const [runtimeDirtyFlags, setRuntimeDirtyFlags] = useState<RuntimeDirtyFlags>(EMPTY_RUNTIME_DIRTY_FLAGS);
  const [runtimeFreshness, setRuntimeFreshness] = useState<RuntimeFreshnessState>(EMPTY_RUNTIME_FRESHNESS);
  const [telegramSelfHealResult, setTelegramSelfHealResult] = useState<string | null>(null);
  const [channelRoutesDraft, setChannelRoutesDraft] = useState<AgentChannelRoute[]>([]);
  const [gatewayBindingsDraft, setGatewayBindingsDraft] = useState<GatewayBinding[]>([]);
  const [gatewayRuntimeLoading, setGatewayRuntimeLoading] = useState(false);
  const [gatewaySelectedIdForRouteTest, setGatewaySelectedIdForRouteTest] = useState("");
  const [gatewayActionLoadingById, setGatewayActionLoadingById] = useState<Record<string, boolean>>({});
  const [gatewayActionHintById, setGatewayActionHintById] = useState<Record<string, string>>({});
  const [gatewayLogsById, setGatewayLogsById] = useState<Record<string, string>>({});
  const [gatewayLogViewerId, setGatewayLogViewerId] = useState<string | null>(null);
  const [gatewayBatchLoading, setGatewayBatchLoading] = useState<"start" | "restart" | "stop" | "health" | "report" | null>(null);
  const [gatewayBatchProgress, setGatewayBatchProgress] = useState<GatewayBatchProgressState | null>(null);
  const gatewayBatchSeenRef = useRef<Record<string, boolean>>({});
  const [telegramInstancesDraft, setTelegramInstancesDraft] = useState<TelegramBotInstance[]>([]);
  const [channelInstancesDraft, setChannelInstancesDraft] = useState<ChannelBotInstance[]>([]);
  const [activeChannelInstanceByChannel, setActiveChannelInstanceByChannel] = useState<Record<string, string>>({});
  const [channelInstanceAutosaveStateByChannel, setChannelInstanceAutosaveStateByChannel] = useState<
    Record<string, "idle" | "saving" | "saved" | "error">
  >({});
  const [channelInstancesEditorChannel, setChannelInstancesEditorChannel] = useState<ChannelEditorChannel>("telegram");
  const [channelBatchTestingByChannel, setChannelBatchTestingByChannel] = useState<Record<string, boolean>>({});
  const [channelSingleTestingByInstanceId, setChannelSingleTestingByInstanceId] = useState<Record<string, boolean>>({});
  const [channelWizardRunningByChannel, setChannelWizardRunningByChannel] = useState<Record<string, boolean>>({});
  const [activeTelegramInstanceId, setActiveTelegramInstanceId] = useState("");
  const [telegramWizardRunning, setTelegramWizardRunning] = useState(false);
  const [telegramBatchTesting, setTelegramBatchTesting] = useState(false);
  const [telegramSessionCleanupRunning, setTelegramSessionCleanupRunning] = useState(false);
  const [telegramSingleTestingByInstanceId, setTelegramSingleTestingByInstanceId] = useState<Record<string, boolean>>({});
  const [telegramUsernameByInstanceId, setTelegramUsernameByInstanceId] = useState<Record<string, string>>({});
  const [routeTestBotInstance, setRouteTestBotInstance] = useState("");
  const [routeTestChannel, setRouteTestChannel] = useState("telegram");
  const [routeTestAccount, setRouteTestAccount] = useState("");
  const [routeTestPeer, setRouteTestPeer] = useState("");
  const [routeTesting, setRouteTesting] = useState(false);
  const [routeTestResult, setRouteTestResult] = useState<string | null>(null);
  useEffect(() => {
    if (pluginSelectionTouched) return;
    const channel = (channelInstancesEditorChannel || "").trim().toLowerCase();
    if (!channel) return;
    setPluginSelection({
      telegram: channel === "telegram",
      qq: channel === "qq",
      feishu: channel === "feishu",
      discord: channel === "discord",
      dingtalk: channel === "dingtalk",
    });
  }, [channelInstancesEditorChannel, pluginSelectionTouched]);
  const [showCreateAgent, setShowCreateAgent] = useState(false);
  const [createAgentId, setCreateAgentId] = useState("");
  const [createAgentName, setCreateAgentName] = useState("");
  const [createAgentWorkspace, setCreateAgentWorkspace] = useState("");
  const [creatingAgent, setCreatingAgent] = useState(false);
  const [agentNameDrafts, setAgentNameDrafts] = useState<Record<string, string>>({});
  const [renamingAgentId, setRenamingAgentId] = useState<string | null>(null);
  const [agentsActionResult, setAgentsActionResult] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [messagesByAgent, setMessagesByAgent] = useState<Record<string, ChatUiMessage[]>>({});
  const [chatPreviewByAgent, setChatPreviewByAgent] = useState<Record<string, ChatPreviewMeta>>({});
  const [chatHistoryLoadedByAgent, setChatHistoryLoadedByAgent] = useState<Record<string, boolean>>({});
  const [chatHistorySuppressedByAgent, setChatHistorySuppressedByAgent] = useState<Record<string, boolean>>({});
  const [chatCacheHydrating, setChatCacheHydrating] = useState(true);
  const [chatRenderLimitByAgent, setChatRenderLimitByAgent] = useState<Record<string, number>>({});
  const [chatLoading, setChatLoading] = useState(false);
  const [chatSendingByAgent, setChatSendingByAgent] = useState<Record<string, boolean>>({});
  const [chatError, setChatError] = useState<string | null>(null);
  const [routeMode, setRouteMode] = useState<"manual" | "auto">("manual");
  const [simpleModeForAgent, setSimpleModeForAgent] = useState(true);
  const [showAdvancedRouteRules, setShowAdvancedRouteRules] = useState(false);
  const [showAgentAdvancedSettings, setShowAgentAdvancedSettings] = useState(false);
  const [showGatewayAdvancedActions, setShowGatewayAdvancedActions] = useState(false);
  const [autoStopGatewaysOnClose, setAutoStopGatewaysOnClose] = useState(false);
  const [chatExecutionMode, setChatExecutionMode] = useState<"orchestrator" | "direct">("direct");
  const [routeHint, setRouteHint] = useState<string | null>(null);
  const [unreadByAgent, setUnreadByAgent] = useState<Record<string, number>>({});
  const [preferredGatewayByAgent, setPreferredGatewayByAgent] = useState<Record<string, string>>({});
  const [selectedChatStickBottom, setSelectedChatStickBottom] = useState(true);
  const selectedChatSending = selectedAgentId ? !!chatSendingByAgent[selectedAgentId] : false;
  const anyChatSending = useMemo(() => Object.values(chatSendingByAgent).some(Boolean), [chatSendingByAgent]);
  const messagesByAgentRef = useRef<Record<string, ChatUiMessage[]>>({});
  const dirtyChatPreviewAgentIdsRef = useRef<Set<string>>(new Set());
  const chatCachePayloadRef = useRef<ChatCachePayload | null>(null);
  const lastCachedMessagesByAgentRef = useRef<Record<string, ChatUiMessage[]>>({});
  const chatRenderLimitByAgentRef = useRef<Record<string, number>>({});
  const chatHistorySuppressedRef = useRef<Record<string, boolean>>({});
  const lastTypingAtRef = useRef(0);
  const chatInteractTimerRef = useRef<number | null>(null);
  const chatInteractingRef = useRef(false);
  const [showServiceQueueDetails, setShowServiceQueueDetails] = useState(false);
  const [showRouteTestPanel, setShowRouteTestPanel] = useState(false);
  const autoStopCloseRunningRef = useRef(false);
  const autoAgentsRefreshKeyRef = useRef("");
  const autoAgentRuntimeRefreshKeyRef = useRef("");
  const startupAgentsPrewarmKeyRef = useRef("");
  const startupRuntimePrewarmKeyRef = useRef("");
  const autoAgentRuntimeRefreshAtRef = useRef(0);
  const repairWarmupKeyRef = useRef("");
  const repairWarmupAtRef = useRef(0);
  const startupAgentRuntimeRefreshKeyRef = useRef("");
  const openclawRuntimeClearedRef = useRef(false);
  const clearOpenclawRuntimeState = useCallback(() => {
    openclawRuntimeClearedRef.current = true;
    autoAgentsRefreshKeyRef.current = "";
    autoAgentRuntimeRefreshKeyRef.current = "";
    autoAgentRuntimeRefreshAtRef.current = 0;
    repairWarmupKeyRef.current = "";
    repairWarmupAtRef.current = 0;
    startupAgentRuntimeRefreshKeyRef.current = "";
    setAgentsList(null);
    setAgentsError(null);
    setAgentRuntimeSettings(null);
    setAgentProfileDrafts({});
    setAgentModelsByProvider({});
    setAgentModelsLoadingByProvider({});
    setAgentRuntimeSaving(false);
    setAgentRuntimeResult(null);
    setRuntimeDirtyFlags(EMPTY_RUNTIME_DIRTY_FLAGS);
    setRuntimeFreshness(EMPTY_RUNTIME_FRESHNESS);
    setTelegramSelfHealResult(null);
    setChannelRoutesDraft([]);
    setGatewayBindingsDraft([]);
    setGatewayRuntimeLoading(false);
    setGatewaySelectedIdForRouteTest("");
    setGatewayActionLoadingById({});
    setGatewayActionHintById({});
    setGatewayLogsById({});
    setGatewayLogViewerId(null);
    setGatewayBatchLoading(null);
    setGatewayBatchProgress(null);
    gatewayBatchSeenRef.current = {};
    setTelegramInstancesDraft([]);
    setChannelInstancesDraft([]);
    setActiveChannelInstanceByChannel({});
    setChannelInstanceAutosaveStateByChannel({});
    setChannelBatchTestingByChannel({});
    setChannelSingleTestingByInstanceId({});
    setChannelWizardRunningByChannel({});
    setActiveTelegramInstanceId("");
    setTelegramWizardRunning(false);
    setTelegramBatchTesting(false);
    setTelegramSessionCleanupRunning(false);
    setTelegramSingleTestingByInstanceId({});
    setTelegramUsernameByInstanceId({});
    setRouteTestBotInstance("");
    setRouteTestResult(null);
    setAgentNameDrafts({});
    setRenamingAgentId(null);
    setAgentsActionResult(null);
    setSelectedAgentId("");
    setMessagesByAgent({});
    setChatPreviewByAgent({});
    setChatHistoryLoadedByAgent({});
    setChatHistorySuppressedByAgent({});
    setChatRenderLimitByAgent({});
    setChatLoading(false);
    setChatSendingByAgent({});
    setChatError(null);
    setUnreadByAgent({});
    setPreferredGatewayByAgent({});
    messagesByAgentRef.current = {};
    dirtyChatPreviewAgentIdsRef.current.clear();
    lastCachedMessagesByAgentRef.current = {};
    chatRenderLimitByAgentRef.current = {};
    chatHistorySuppressedRef.current = {};
  }, []);
  const updateRuntimeDirtyFlags = useCallback((patch: Partial<RuntimeDirtyFlags>) => {
    setRuntimeDirtyFlags((prev) => {
      let changed = false;
      const next = { ...prev };
      (Object.keys(patch) as (keyof RuntimeDirtyFlags)[]).forEach((key) => {
        const value = patch[key];
        if (typeof value !== "boolean" || next[key] === value) return;
        next[key] = value;
        changed = true;
      });
      return changed ? next : prev;
    });
  }, []);
  const updateRuntimeFreshness = useCallback((patch: Partial<RuntimeFreshnessState>) => {
    setRuntimeFreshness((prev) => {
      const next: RuntimeFreshnessState = {
        staticSnapshotAt: patch.staticSnapshotAt === undefined ? prev.staticSnapshotAt : patch.staticSnapshotAt,
        gatewaySnapshotAt: patch.gatewaySnapshotAt === undefined ? prev.gatewaySnapshotAt : patch.gatewaySnapshotAt,
      };
      return next.staticSnapshotAt === prev.staticSnapshotAt && next.gatewaySnapshotAt === prev.gatewaySnapshotAt ? prev : next;
    });
  }, []);
  const applyGatewayBindingsSnapshot = useCallback(
    (
      nextGateways: GatewayBinding[],
      options?: {
        source?: "snapshot" | "live";
        refreshedAt?: number;
        clearDirty?: Partial<RuntimeDirtyFlags>;
      }
    ) => {
      const source = options?.source || "snapshot";
      setGatewayBindingsDraft((prev) => {
        const prevById = new Map(prev.map((item) => [item.gateway_id, item]));
        const merged = (nextGateways || []).map((gateway) => {
          const current = prevById.get(gateway.gateway_id);
          if (source !== "snapshot" || !current) {
            return gateway;
          }
          return {
            ...gateway,
            listen_port: current.listen_port ?? gateway.listen_port,
            pid: current.pid ?? gateway.pid,
            last_error: current.last_error ?? gateway.last_error,
            health: current.health ?? gateway.health,
          };
        });
        return isSameJsonShape(prev, merged) ? prev : merged;
      });
      setGatewaySelectedIdForRouteTest((prev) => {
        if (prev && (nextGateways || []).some((gateway) => gateway.gateway_id === prev)) return prev;
        const fallback = nextGateways?.[0]?.gateway_id || "";
        return prev === fallback ? prev : fallback;
      });
      if (typeof options?.refreshedAt === "number") {
        updateRuntimeFreshness({ gatewaySnapshotAt: options.refreshedAt });
      }
      if (options?.clearDirty) {
        const nextDirtyPatch = Object.fromEntries(
          Object.entries(options.clearDirty)
            .filter(([, value]) => value === true)
            .map(([key]) => [key, false])
        ) as Partial<RuntimeDirtyFlags>;
        updateRuntimeDirtyFlags(nextDirtyPatch);
      }
    },
    [updateRuntimeDirtyFlags, updateRuntimeFreshness]
  );
  const upsertGatewayBindingRow = useCallback((row?: GatewayBinding | null) => {
    if (!row?.gateway_id) return;
    setGatewayBindingsDraft((prev) => {
      const idx = prev.findIndex((item) => item.gateway_id === row.gateway_id);
      if (idx < 0) return [...prev, row];
      const next = prev.slice();
      next[idx] = row;
      return next;
    });
    updateRuntimeFreshness({ gatewaySnapshotAt: Date.now() });
    updateRuntimeDirtyFlags({ gatewayHealthDirty: false });
  }, [updateRuntimeDirtyFlags, updateRuntimeFreshness]);
  const isGatewayPortOnlyHealth = useCallback((health?: GatewayRuntimeHealth | null) => {
    if (!health || health.status !== "ok") return false;
    const raw = String(health.detail || "").toLowerCase();
    return (
      raw.includes("channel providers not verified") ||
      raw.includes("transport ok") ||
      raw.includes("status fallback")
    );
  }, []);
  const describeGatewayAction = useCallback((action: string, ok: boolean, message?: string | null) => {
    const label = action === "start" ? "启动" : action === "stop" ? "停止" : action === "restart" ? "重启" : action;
    const summary = stripAnsi(String(message || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "");
    if (!summary) return `${label}${ok ? "完成" : "失败"}`;
    return `${label}${ok ? "完成" : "失败"}：${summary}`;
  }, []);
  const setAgentChatSendingState = useCallback((agentId: string, sending: boolean) => {
    if (!agentId) return;
    setChatSendingByAgent((prev) => {
      const current = !!prev[agentId];
      if (current === sending) return prev;
      const next = { ...prev };
      if (sending) {
        next[agentId] = true;
      } else {
        delete next[agentId];
      }
      return next;
    });
  }, []);

  const releasePendingChatRequest = useCallback(
    (agentId: string, requestId?: string | null) => {
      if (!agentId) return;
      if (requestId && pendingChatRequestIdByAgentRef.current[agentId] !== requestId) return;
      delete pendingChatRequestIdByAgentRef.current[agentId];
      delete chatSendLockByAgentRef.current[agentId];
      setAgentChatSendingState(agentId, false);
    },
    [setAgentChatSendingState]
  );

  const scrollChatViewportToBottom = useCallback((delayMs = 0) => {
    const run = () => {
      let remainingFrames = 3;
      const tick = () => {
        const el = chatViewportRef.current;
        if (el) {
          el.scrollTop = el.scrollHeight;
        }
        remainingFrames -= 1;
        if (remainingFrames > 0) {
          window.requestAnimationFrame(tick);
        }
      };
      window.requestAnimationFrame(tick);
    };
    if (delayMs > 0) {
      window.setTimeout(run, delayMs);
    } else {
      run();
    }
  }, []);
  const [cpLoading, setCpLoading] = useState(false);
  const [cpResult, setCpResult] = useState<string | null>(null);
  const [cpTasks, setCpTasks] = useState<CpOrchestratorTask[]>([]);
  const [cpGraphs, setCpGraphs] = useState<CpSkillGraph[]>([]);
  const [cpTickets, setCpTickets] = useState<CpTicket[]>([]);
  const [cpMemory, setCpMemory] = useState<CpMemoryRecord[]>([]);
  const [cpSnapshots, setCpSnapshots] = useState<CpSnapshot[]>([]);
  const [cpPrompts, setCpPrompts] = useState<CpPromptPolicyVersion[]>([]);
  const [cpCapabilities, setCpCapabilities] = useState<CpAgentCapability[]>([]);
  const [cpRoles, setCpRoles] = useState<CpRoleBinding[]>([]);
  const [cpAudit, setCpAudit] = useState<CpAuditEvent[]>([]);
  const [cpCost, setCpCost] = useState<CpCostSummary | null>(null);
  const [cpTaskTitle, setCpTaskTitle] = useState("多Agent综合任务");
  const [cpTaskInput, setCpTaskInput] = useState("");
  const [cpVerifierOutput, setCpVerifierOutput] = useState("");
  const [cpVerifierConstraints, setCpVerifierConstraints] = useState("结构完整\n给出步骤");
  const [cpVerifierReport, setCpVerifierReport] = useState<CpVerifierReport | null>(null);
  const [cpGraphName, setCpGraphName] = useState("抓取-清洗-生成-发送");
  const [cpGraphNodesJson, setCpGraphNodesJson] = useState(
    '[{"id":"n1","node_type":"fetch","config":{"url":"https://example.com"}},{"id":"n2","node_type":"clean","config":{}},{"id":"n3","node_type":"generate","config":{}},{"id":"n4","node_type":"send","config":{"channel":"telegram"}}]'
  );
  const [cpGraphEdgesJson, setCpGraphEdgesJson] = useState(
    '[{"from":"n1","to":"n2"},{"from":"n2","to":"n3"},{"from":"n3","to":"n4"}]'
  );
  const [cpSelectedGraphId, setCpSelectedGraphId] = useState("");
  const [cpTicketChannel, setCpTicketChannel] = useState("telegram");
  const [cpTicketExternalRef, setCpTicketExternalRef] = useState("demo-ext");
  const [cpTicketTitle, setCpTicketTitle] = useState("渠道消息工单");
  const [cpTicketPayload, setCpTicketPayload] = useState('{"text":"need follow up"}');
  const [cpMemoryLayer, setCpMemoryLayer] = useState("project");
  const [cpMemoryScope, setCpMemoryScope] = useState("default");
  const [cpMemoryContent, setCpMemoryContent] = useState("");
  const [cpMemoryRationale, setCpMemoryRationale] = useState("");
  const [cpMemoryTags, setCpMemoryTags] = useState("demo,important");
  const [cpSandboxActionType, setCpSandboxActionType] = useState("write_file");
  const [cpSandboxResource, setCpSandboxResource] = useState("./workspace/demo.txt");
  const [cpSandboxPreview, setCpSandboxPreview] = useState<CpSandboxPreview | null>(null);
  const [cpSandboxApproved, setCpSandboxApproved] = useState(false);
  const [cpDebateTask, setCpDebateTask] = useState("给出代码+表格的协同方案");
  const [cpDebateResult, setCpDebateResult] = useState<CpDebateResult | null>(null);
  const [cpSnapshotTaskId, setCpSnapshotTaskId] = useState("");
  const [cpSnapshotInput, setCpSnapshotInput] = useState("");
  const [cpSnapshotTools, setCpSnapshotTools] = useState("fetch,clean,generate");
  const [cpSnapshotConfig, setCpSnapshotConfig] = useState('{"mode":"demo"}');
  const [cpPromptName, setCpPromptName] = useState("policy-a");
  const [cpPromptRules, setCpPromptRules] = useState('{"tone":"professional","safety":"strict"}');
  const [cpPromptTraffic, setCpPromptTraffic] = useState(50);
  const [cpRoleUserId, setCpRoleUserId] = useState("local-admin");
  const [cpRoleName, setCpRoleName] = useState("admin");
  const [cpCapAgentId, setCpCapAgentId] = useState("code");
  const [cpCapSpecialty, setCpCapSpecialty] = useState("code");
  const [cpCapPrimaryModel, setCpCapPrimaryModel] = useState("code-optimized");
  const [cpCapFallbackModel, setCpCapFallbackModel] = useState("general-balanced");
  const [cpCapTools, setCpCapTools] = useState("filesystem,terminal,tests");
  const [cpCapStrengths, setCpCapStrengths] = useState("代码实现,调试,重构");
  const [cpCapCostTier, setCpCapCostTier] = useState("medium");
  const [wizardUseCase, setWizardUseCase] = useState<ScenarioPreset>("customer_support");
  const [wizardTone, setWizardTone] = useState<TuneTone>("friendly");
  const [wizardMemory, setWizardMemory] = useState<MemoryMode>("session");
  const isChatPage = step === 3;
  const isRepairPage = step === 4 && tuningSection === "health";
  const isSkillsPage = step === 4 && tuningSection === "skills";
  const isAgentOverviewPage = step === 4 && tuningSection === "agents" && agentCenterTab === "overview";
  const isAgentChannelsPage = step === 4 && tuningSection === "agents" && agentCenterTab === "channels";
  const selectedSkillItems = useMemo(
    () => (isSkillsPage ? skillsCatalog.filter((s) => !!selectedSkills[s.name]) : []),
    [isSkillsPage, skillsCatalog, selectedSkills]
  );
  const selectedManualSkillItems = useMemo(
    () => (isSkillsPage ? selectedSkillItems.filter((s) => hasManualSkillGaps(s)) : []),
    [isSkillsPage, selectedSkillItems]
  );
  const selectedAutoFixableItems = useMemo(
    () => (isSkillsPage ? selectedSkillItems.filter((s) => isAutoFixableSkill(s)) : []),
    [isSkillsPage, selectedSkillItems]
  );
  const currentSkillsScope = agentRuntimeSettings?.skills_scope === "agent_override" ? "agent_override" : "shared";
  const skillsAgents = agentsList?.agents || [];
  const effectiveSkillsAgentId = skillsSelectedAgentId || selectedAgentId || skillsAgents[0]?.id || "";
  const currentAgentSkillBinding = useMemo(
    () =>
      isSkillsPage
        ? (agentRuntimeSettings?.agent_skill_bindings || []).find((binding) => binding.agent_id === effectiveSkillsAgentId) || null
        : null,
    [agentRuntimeSettings?.agent_skill_bindings, effectiveSkillsAgentId, isSkillsPage]
  );
  const effectiveAgentEnabledSkillSet = useMemo(() => {
    if (!isSkillsPage) return new Set<string>();
    const allNames = new Set(skillsCatalog.map((skill) => skill.name));
    if (currentSkillsScope !== "agent_override") return allNames;
    if (!currentAgentSkillBinding || currentAgentSkillBinding.mode !== "custom") return allNames;
    return new Set(currentAgentSkillBinding.enabled_skills || []);
  }, [isSkillsPage, skillsCatalog, currentSkillsScope, currentAgentSkillBinding]);
  const effectiveAgentEnabledSkillCount = useMemo(
    () => (isSkillsPage ? skillsCatalog.filter((skill) => effectiveAgentEnabledSkillSet.has(skill.name)).length : 0),
    [isSkillsPage, skillsCatalog, effectiveAgentEnabledSkillSet]
  );
  const loadedStepDataRef = useRef<{ install: boolean; model: boolean; channel: boolean }>({
    install: false,
    model: false,
    channel: false,
  });
  const configReloadTimerRef = useRef<number | null>(null);
  const startupBootstrapDoneRef = useRef(false);
  const deferredEnvCheckTimerRef = useRef<number | null>(null);
  const appMountedAtRef = useRef(typeof performance !== "undefined" ? performance.now() : Date.now());
  const baselineMilestonesRef = useRef({ chat: false, agents: false });
  const gatewayPageRefreshStartedAtRef = useRef<number | null>(null);
  const deferredPageRenderTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const savedInstall = localStorage.getItem("openclaw_install_dir") ?? "";
    const savedConfig = localStorage.getItem("openclaw_config_dir") ?? "";
    const savedRouteMode = localStorage.getItem("openclaw_chat_route_mode");
    const savedExecutionMode = localStorage.getItem("openclaw_chat_execution_mode");
    const savedAutoStopOnClose = localStorage.getItem("openclaw_auto_stop_gateways_on_close");
    const savedApiEntryMode = localStorage.getItem("openclaw_api_entry_mode");
    const savedRelayStationUrl = localStorage.getItem("openclaw_relay_station_url") ?? DEFAULT_RELAY_STATION_URL;
    let cancelled = false;
    startupBootstrapDoneRef.current = false;
    if (savedInstall) setCustomInstallPath(savedInstall);
    if (savedAutoStopOnClose === "1") setAutoStopGatewaysOnClose(true);
    if (savedApiEntryMode === "own" || savedApiEntryMode === "relay") {
      setApiEntryMode(savedApiEntryMode);
    }
    if (savedRelayStationUrl) setRelayStationUrl(savedRelayStationUrl);
    chatSessionModeRef.current = "synced";
    localStorage.setItem("openclaw_chat_session_mode", "synced");
    localStorage.removeItem("openclaw_chat_session_mode_user_set");
    if (savedRouteMode === "manual" || savedRouteMode === "auto") {
      setRouteMode(savedRouteMode);
    }
    if (savedExecutionMode === "direct" || savedExecutionMode === "orchestrator") {
      setChatExecutionMode(savedExecutionMode);
    }
    if (savedConfig) {
      if (!isLikelyConfigPath(savedConfig)) {
        localStorage.removeItem("openclaw_config_dir");
        if (looksLikeApiKey(savedConfig)) {
          setSaveResult("检测到你曾把 API Key 填到“自定义配置路径”，已自动清理该路径缓存，请在 API Key 输入框填写后保存。");
        } else if (isGatewayStatePath(savedConfig)) {
          setSaveResult("检测到你曾把单个 Gateway 的 state_dir 填到“自定义配置路径”，已自动清理并回退到主配置目录。");
        }
      } else {
        setCustomConfigPath(savedConfig);
      }
    }
    if (!savedConfig && savedInstall) {
      const installConfig = normalizeConfigPath(`${savedInstall.replace(/\\/g, "/").replace(/\/+$/, "")}/.openclaw`);
      if (installConfig) {
        setCustomConfigPath(installConfig);
        localStorage.setItem("openclaw_config_dir", installConfig);
      }
    }
    void (async () => {
      let resolvedConfig =
        normalizeConfigPath(savedConfig) ||
        normalizeConfigPath(savedInstall ? `${savedInstall.replace(/\\/g, "/").replace(/\/+$/, "")}/.openclaw` : "");
      if (!resolvedConfig) {
        try {
          const detected = await measureAsync(
            "startup.detect_openclaw_config_path",
            async () => invoke<string | null>("detect_openclaw_config_path"),
            "initial bootstrap"
          );
          if (!cancelled && detected && isLikelyConfigPath(detected)) {
            resolvedConfig = normalizeConfigPath(detected);
            if (resolvedConfig) {
              setCustomConfigPath(resolvedConfig);
              localStorage.setItem("openclaw_config_dir", resolvedConfig);
              setSaveResult("已自动对齐到 Gateway 配置目录。");
            }
          }
        } catch {
          // ignore bootstrap path detection failures
        }
      }
      if (cancelled) return;
      await Promise.all([
        refreshLocalInfoRef.current(savedInstall || undefined, resolvedConfig || undefined),
        loadSavedAiConfig(resolvedConfig || undefined),
        loadRuntimeModelInfo(resolvedConfig || undefined),
        loadKeySyncStatus(resolvedConfig || undefined),
      ]);
      if (cancelled) return;
      startupBootstrapDoneRef.current = true;
      recordPerfMetric("baseline.cold_start_first_screen", performance.now() - appMountedAtRef.current);
      deferredEnvCheckTimerRef.current = scheduleIdleTask(() => {
        void runEnvCheck(savedInstall || undefined);
      }, 1800);
    })();
    return () => {
      cancelled = true;
      cancelIdleTask(deferredEnvCheckTimerRef.current);
      deferredEnvCheckTimerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const prefetchHandle = scheduleIdleTask(() => {
      void import("./pages/ChatPage");
      void import("./pages/TuningAgentsSection");
      void import("./pages/TuningHealthSection");
    }, 1200);
    return () => {
      cancelIdleTask(prefetchHandle);
    };
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("openclaw_tuning_prefs");
      if (!raw) return;
      const p = JSON.parse(raw) as Partial<{
        quickMode: QuickMode;
        scenarioPreset: ScenarioPreset;
        tuneLength: TuneLength;
        tuneTone: TuneTone;
        tuneProactivity: TuneProactivity;
        tunePermission: TunePermission;
        memoryMode: MemoryMode;
      }>;
      if (p.quickMode) setQuickMode(p.quickMode);
      if (p.scenarioPreset) setScenarioPreset(p.scenarioPreset);
      if (p.tuneLength) setTuneLength(p.tuneLength);
      if (p.tuneTone) setTuneTone(p.tuneTone);
      if (p.tuneProactivity) setTuneProactivity(p.tuneProactivity);
      if (p.tunePermission) setTunePermission(p.tunePermission);
      if (p.memoryMode) setMemoryMode(p.memoryMode);
    } catch {
      // ignore invalid local cache
    }
  }, []);

  useEffect(() => {
    setServiceSkillsRenderLimit((prev) => {
      const target = Math.min(40, skillsCatalog.length || 40);
      return prev === target ? prev : target;
    });
  }, [skillsCatalog.length]);

  useEffect(() => {
    const payload = {
      quickMode,
      scenarioPreset,
      tuneLength,
      tuneTone,
      tuneProactivity,
      tunePermission,
      memoryMode,
    };
    localStorage.setItem("openclaw_tuning_prefs", JSON.stringify(payload));
  }, [quickMode, scenarioPreset, tuneLength, tuneTone, tuneProactivity, tunePermission, memoryMode]);

  useEffect(() => {
    const done = localStorage.getItem("openclaw_easy_onboarding_done");
    if (!done) {
      setWizardOpen(true);
    }
  }, []);

  useEffect(() => {
    if (installing || uninstalling) return;
    if (!startupBootstrapDoneRef.current) return;
    if (step !== 3 && !(step === 4 && (tuningSection === "agents" || tuningSection === "skills"))) return;
    const cfgPath = normalizeConfigPath(customConfigPath) || "default";
    if (step === 4 && tuningSection === "agents" && agentsList) {
      autoAgentsRefreshKeyRef.current = cfgPath;
      return;
    }
    if (autoAgentsRefreshKeyRef.current === cfgPath && agentsList) return;
    autoAgentsRefreshKeyRef.current = cfgPath;
    void refreshAgentsList();
  }, [agentsList, customConfigPath, installing, step, tuningSection, uninstalling]);

  useEffect(() => {
    if (step !== 4) return;
    if (tuningSection !== "memory") return;
    if (memoryStatus || memoryLoading) return;
    void refreshMemoryCenterStatus();
  }, [step, tuningSection, memoryStatus, memoryLoading, customConfigPath]);

  const selectedChatHistoryLoaded = selectedAgentId ? !!chatHistoryLoadedByAgent[selectedAgentId] : false;
  const selectedChatHistorySuppressed = selectedAgentId ? !!chatHistorySuppressedByAgent[selectedAgentId] : false;
  const chatCacheKey = useMemo(() => buildChatCacheKey(customConfigPath), [customConfigPath]);
  const isChatInteracting = useCallback(() => chatInteractingRef.current, []);
  const markChatPreviewDirty = useCallback((agentId: string) => {
    if (!agentId) return;
    dirtyChatPreviewAgentIdsRef.current.add(agentId);
  }, []);

  useEffect(() => {
    stepRef.current = step;
  }, [step]);

  useEffect(() => {
    if (step === 3 && !baselineMilestonesRef.current.chat) {
      baselineMilestonesRef.current.chat = true;
      recordPerfMetric("baseline.enter_chat_page", performance.now() - appMountedAtRef.current);
    }
    if (step === 4 && tuningSection === "agents" && !baselineMilestonesRef.current.agents) {
      baselineMilestonesRef.current.agents = true;
      recordPerfMetric("baseline.enter_agent_page", performance.now() - appMountedAtRef.current);
    }
  }, [step, tuningSection]);

  useEffect(() => {
    selectedAgentIdRef.current = selectedAgentId;
  }, [selectedAgentId]);

  useEffect(() => {
    if (step !== 3) return;
    if (chatCacheHydratedKeyRef.current === chatCacheKey) return;
    setChatCacheHydrating(true);
    void (async () => {
      try {
        const normalizedScope = normalizeConfigPath(customConfigPath) || "default";
        const legacyIsolatedKey = `openclaw_chat_cache_v1::${normalizedScope}::isolated`;
        const legacySyncedKey = `openclaw_chat_cache_v1::${normalizedScope}::synced`;
        await Promise.all([
          deleteChatCacheSnapshot(legacyIsolatedKey),
          deleteChatCacheSnapshot(legacySyncedKey),
        ]);
        try {
          localStorage.removeItem(legacyIsolatedKey);
          localStorage.removeItem(legacySyncedKey);
        } catch {
          // ignore storage cleanup error
        }
        let parsed = (await readChatCacheSnapshot(chatCacheKey)) as Partial<ChatCachePayload> | null;
        if (!parsed) {
          const legacyRaw = localStorage.getItem(chatCacheKey);
          if (legacyRaw) {
            parsed = JSON.parse(legacyRaw) as Partial<ChatCachePayload>;
            if (parsed) {
              await writeChatCacheSnapshot(chatCacheKey, {
                version: 1,
                selectedAgentId: parsed.selectedAgentId || "",
                messagesByAgent: (parsed.messagesByAgent || {}) as Record<string, ChatUiMessage[]>,
                chatHistoryLoadedByAgent: parsed.chatHistoryLoadedByAgent || {},
                sessionNamesByAgent: parsed.sessionNamesByAgent || {},
              });
              localStorage.removeItem(chatCacheKey);
            }
          }
        }
        if (!parsed) {
          chatCachePayloadRef.current = {
            version: 1,
            selectedAgentId: "",
            messagesByAgent: {},
            chatHistoryLoadedByAgent: {},
            sessionNamesByAgent: {},
          };
          lastCachedMessagesByAgentRef.current = {};
          chatCacheHydratedKeyRef.current = chatCacheKey;
          setChatCacheHydrating(false);
          return;
        }
        const cachedMessages = Object.fromEntries(
          Object.entries(parsed.messagesByAgent || {}).map(([agentId, list]) => [
            agentId,
            Array.isArray(list)
              ? trimChatMessagesForUi(
                  list
                    .map((item) => sanitizeChatMessageForCache(item as ChatUiMessage))
                    .filter((item) => item.id && item.text.trim()),
                  CHAT_CACHE_MAX_MESSAGES
                )
              : [],
          ])
        ) as Record<string, ChatUiMessage[]>;
        const loadedByAgent = { ...(parsed.chatHistoryLoadedByAgent || {}) };
        for (const [agentId, list] of Object.entries(cachedMessages)) {
          if ((list || []).length > 0) loadedByAgent[agentId] = true;
        }
        dirtyChatPreviewAgentIdsRef.current = new Set(Object.keys(cachedMessages || {}));
        startTransition(() => {
          setMessagesByAgent(cachedMessages);
          setChatHistoryLoadedByAgent(loadedByAgent);
          if (parsed?.selectedAgentId) {
            setSelectedAgentId((prev) => prev || parsed?.selectedAgentId || "");
          }
        });
        if (parsed.sessionNamesByAgent && typeof parsed.sessionNamesByAgent === "object") {
          chatSessionNameByAgentRef.current = {
            ...chatSessionNameByAgentRef.current,
            ...parsed.sessionNamesByAgent,
          };
        }
        chatCachePayloadRef.current = {
          version: 1,
          selectedAgentId: parsed.selectedAgentId || "",
          messagesByAgent: cachedMessages,
          chatHistoryLoadedByAgent: loadedByAgent,
          sessionNamesByAgent: { ...chatSessionNameByAgentRef.current },
        };
        lastCachedMessagesByAgentRef.current = cachedMessages;
      } catch {
        try {
          localStorage.removeItem(chatCacheKey);
        } catch {
          // ignore storage error
        }
        chatCachePayloadRef.current = {
          version: 1,
          selectedAgentId: "",
          messagesByAgent: {},
          chatHistoryLoadedByAgent: {},
          sessionNamesByAgent: {},
        };
        lastCachedMessagesByAgentRef.current = {};
      } finally {
        chatCacheHydratedKeyRef.current = chatCacheKey;
        setChatCacheHydrating(false);
      }
    })();
  }, [chatCacheKey, step]);

  useEffect(() => {
    if (chatCacheHydratedKeyRef.current !== chatCacheKey) return;
    if (chatCachePersistTimerRef.current !== null) {
      window.clearTimeout(chatCachePersistTimerRef.current);
      chatCachePersistTimerRef.current = null;
    }
    chatCachePersistTimerRef.current = window.setTimeout(() => {
      const persist = () => {
        void (async () => {
          try {
            const payload: ChatCachePayload = chatCachePayloadRef.current || {
              version: 1,
              selectedAgentId: "",
              messagesByAgent: {},
              chatHistoryLoadedByAgent: {},
              sessionNamesByAgent: {},
            };
            const prevMessages = lastCachedMessagesByAgentRef.current;
            const changedAgents = new Set<string>([
              ...Object.keys(prevMessages || {}),
              ...Object.keys(messagesByAgent || {}),
            ]);
            payload.version = 1;
            payload.selectedAgentId = selectedAgentIdRef.current;
            payload.chatHistoryLoadedByAgent = { ...chatHistoryLoadedByAgent };
            payload.sessionNamesByAgent = { ...chatSessionNameByAgentRef.current };
            for (const agentId of changedAgents) {
              const previous = prevMessages[agentId] || [];
              const current = messagesByAgent[agentId] || [];
              if (isSameChatMessageList(previous, current)) continue;
              const sanitized = trimChatMessagesForUi(
                (current || []).map(sanitizeChatMessageForCache).filter((item) => item.text.trim()),
                CHAT_CACHE_MAX_MESSAGES
              );
              if (sanitized.length > 0) {
                payload.messagesByAgent[agentId] = sanitized;
              } else {
                delete payload.messagesByAgent[agentId];
              }
            }
            chatCachePayloadRef.current = payload;
            lastCachedMessagesByAgentRef.current = messagesByAgent;
            await writeChatCacheSnapshot(chatCacheKey, payload);
          } finally {
            chatCachePersistTimerRef.current = null;
          }
        })();
      };
      const maybeWindow = window as Window & {
        requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      };
      if (isChatInteracting()) {
        window.setTimeout(persist, 420);
      } else if (typeof maybeWindow.requestIdleCallback === "function") {
        maybeWindow.requestIdleCallback(persist, { timeout: 1200 });
      } else {
        window.setTimeout(persist, 60);
      }
    }, isChatInteracting() ? 900 : 520);
    return () => {
      if (chatCachePersistTimerRef.current !== null) {
        window.clearTimeout(chatCachePersistTimerRef.current);
        chatCachePersistTimerRef.current = null;
      }
    };
  }, [chatCacheKey, chatHistoryLoadedByAgent, isChatInteracting, messagesByAgent]);

  useEffect(() => {
    messagesByAgentRef.current = messagesByAgent;
  }, [messagesByAgent]);

  useEffect(() => {
    const dirtyAgentIds = Array.from(dirtyChatPreviewAgentIdsRef.current);
    if (dirtyAgentIds.length === 0) return;
    dirtyChatPreviewAgentIdsRef.current.clear();
    startTransition(() => {
      setChatPreviewByAgent((prev) => {
        let next = prev;
        let changed = false;
        for (const agentId of dirtyAgentIds) {
          const current = messagesByAgent[agentId] || [];
          if (current.length === 0) {
            if (agentId in next) {
              if (!changed) next = { ...prev };
              delete next[agentId];
              changed = true;
            }
            continue;
          }
          const preview = buildChatPreviewFromMessages(current);
          if (!isSameJsonShape(prev[agentId], preview)) {
            if (!changed) next = { ...prev };
            next[agentId] = preview;
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    });
  }, [messagesByAgent]);

  useEffect(() => {
    chatRenderLimitByAgentRef.current = chatRenderLimitByAgent;
  }, [chatRenderLimitByAgent]);

  useEffect(() => {
    chatHistorySuppressedRef.current = chatHistorySuppressedByAgent;
  }, [chatHistorySuppressedByAgent]);

  useEffect(() => {
    if (!selectedAgentId) return;
    if (chatStickBottomByAgentRef.current[selectedAgentId] === undefined) {
      chatStickBottomByAgentRef.current[selectedAgentId] = true;
    }
    setSelectedChatStickBottom(!!chatStickBottomByAgentRef.current[selectedAgentId]);
    setChatRenderLimitByAgent((prev) => {
      if (prev[selectedAgentId]) return prev;
      return { ...prev, [selectedAgentId]: CHAT_RENDER_BATCH };
    });
  }, [selectedAgentId]);

  useEffect(() => {
    if (step !== 3 || !selectedAgentId) return;
    chatStickBottomByAgentRef.current[selectedAgentId] = true;
    setSelectedChatStickBottom(true);
    setUnreadByAgent((prev) => {
      if ((prev[selectedAgentId] || 0) === 0) return prev;
      return { ...prev, [selectedAgentId]: 0 };
    });
    scrollChatViewportToBottom(12);
  }, [step, selectedAgentId, scrollChatViewportToBottom]);

  useEffect(() => {
    if (step !== 3 || !selectedAgentId) return;
    if (!chatStickBottomByAgentRef.current[selectedAgentId]) return;
    scrollChatViewportToBottom(12);
  }, [step, selectedAgentId, messagesByAgent[selectedAgentId]?.length, chatRenderLimitByAgent[selectedAgentId], scrollChatViewportToBottom]);

  useEffect(() => {
    if (step !== 3) return;
    if (!selectedAgentId) return;
    if (!selectedChatHistoryLoaded) return;
    if (selectedChatHistorySuppressed) return;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      if (selectedChatSending) return;
      if (isChatInteracting()) return;
      if (Date.now() - lastTypingAtRef.current < 1200) return;
      // 用户正在上滑查看历史时，暂停轮询，避免滚动卡顿和视图抖动
      if (!chatStickBottomByAgentRef.current[selectedAgentId]) return;
      scheduleIdleTask(() => {
        void loadAgentHistoryDelta(selectedAgentId, { silent: true });
      }, 1200);
    }, 12000);
    return () => window.clearInterval(timer);
  }, [customConfigPath, isChatInteracting, selectedAgentId, selectedChatHistoryLoaded, selectedChatHistorySuppressed, selectedChatSending, step]);

  const markChatInteracting = useCallback((cooldownMs = 900) => {
    chatInteractingRef.current = true;
    if (chatInteractTimerRef.current) {
      window.clearTimeout(chatInteractTimerRef.current);
    }
    chatInteractTimerRef.current = window.setTimeout(() => {
      chatInteractingRef.current = false;
      chatInteractTimerRef.current = null;
    }, cooldownMs);
  }, []);

  useEffect(
    () => () => {
      if (chatInteractTimerRef.current) {
        window.clearTimeout(chatInteractTimerRef.current);
      }
    },
    []
  );

  const handleChatTypingActivity = useCallback(() => {
    lastTypingAtRef.current = Date.now();
    markChatInteracting(1000);
  }, [markChatInteracting]);

  const enqueueTask = (
    name: string,
    runner: () => Promise<void>,
    options?: { maxRetries?: number }
  ) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    queueRunnersRef.current[id] = runner;
    setQueueTasks((prev) => [
      ...prev,
      {
        id,
        name,
        status: "queued",
        retryCount: 0,
        maxRetries: options?.maxRetries ?? 1,
        createdAt: Date.now(),
      },
    ]);
    return id;
  };

  const cancelTask = (id: string) => {
    setQueueTasks((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t;
        if (t.status === "queued") return { ...t, status: "cancelled", finishedAt: Date.now() };
        if (t.status === "running") {
          cancelledRunningTasksRef.current.add(id);
          return { ...t, status: "cancelled", finishedAt: Date.now() };
        }
        return t;
      })
    );
  };

  const retryTask = (id: string) => {
    setQueueTasks((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t;
        if (t.retryCount >= t.maxRetries) return t;
        return {
          ...t,
          status: "queued",
          retryCount: t.retryCount + 1,
          error: undefined,
          finishedAt: undefined,
          startedAt: undefined,
        };
      })
    );
  };

  useEffect(() => {
    const running = queueTasks.find((t) => t.status === "running");
    if (running) return;
    const next = queueTasks.find((t) => t.status === "queued");
    if (!next) return;
    const run = queueRunnersRef.current[next.id];
    if (!run) {
      setQueueTasks((prev) =>
        prev.map((t) =>
          t.id === next.id ? { ...t, status: "error", error: "任务执行器丢失", finishedAt: Date.now() } : t
        )
      );
      return;
    }

    setQueueTasks((prev) =>
      prev.map((t) => (t.id === next.id ? { ...t, status: "running", startedAt: Date.now() } : t))
    );

    Promise.resolve()
      .then(() => run())
      .then(() => {
        if (cancelledRunningTasksRef.current.has(next.id)) {
          cancelledRunningTasksRef.current.delete(next.id);
          return;
        }
        setQueueTasks((prev) =>
          prev.map((t) => (t.id === next.id ? { ...t, status: "done", finishedAt: Date.now() } : t))
        );
      })
      .catch((e) => {
        if (cancelledRunningTasksRef.current.has(next.id)) {
          cancelledRunningTasksRef.current.delete(next.id);
          return;
        }
        setQueueTasks((prev) =>
          prev.map((t) =>
            t.id === next.id
              ? { ...t, status: "error", error: String(e), finishedAt: Date.now() }
              : t
          )
        );
      })
      .finally(() => {
        delete queueRunnersRef.current[next.id];
      });
  }, [queueTasks]);

  useEffect(() => {
    localStorage.setItem("openclaw_api_entry_mode", apiEntryMode);
  }, [apiEntryMode]);

  useEffect(() => {
    if (relayStationUrl.trim()) {
      localStorage.setItem("openclaw_relay_station_url", relayStationUrl.trim());
    } else {
      localStorage.removeItem("openclaw_relay_station_url");
    }
  }, [relayStationUrl]);

  useEffect(() => {
    if (customInstallPath.trim()) {
      localStorage.setItem("openclaw_install_dir", customInstallPath.trim());
    }
  }, [customInstallPath]);

  useEffect(() => {
    const normalized = normalizeConfigPath(customConfigPath);
    if (normalized && isLikelyConfigPath(normalized)) {
      localStorage.setItem("openclaw_config_dir", normalized);
    } else if (!normalized) {
      localStorage.removeItem("openclaw_config_dir");
    }
  }, [customConfigPath]);

  useEffect(() => {
    localStorage.setItem("openclaw_chat_route_mode", routeMode);
  }, [routeMode]);

  useEffect(() => {
    localStorage.setItem("openclaw_chat_execution_mode", chatExecutionMode);
  }, [chatExecutionMode]);

  useEffect(() => {
    localStorage.setItem("openclaw_auto_stop_gateways_on_close", autoStopGatewaysOnClose ? "1" : "0");
  }, [autoStopGatewaysOnClose]);

  useEffect(() => {
    if (!autoStopGatewaysOnClose) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const currentWindow = getCurrentWindow();
    void currentWindow
      .onCloseRequested(async (event) => {
        if (autoStopCloseRunningRef.current) return;
        event.preventDefault();
        autoStopCloseRunningRef.current = true;
        try {
          const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
          const installHint = (localInfo?.install_dir || customInstallPath || lastInstallDir || "").trim() || undefined;
          await invoke<string>("stop_all_gateways", {
            customPath: cfgPath,
            installHint,
          });
        } catch (error) {
          console.error("stop_all_gateways on close failed", error);
        } finally {
          if (unlisten) {
            unlisten();
            unlisten = null;
          }
          await currentWindow.close();
        }
      })
      .then((fn) => {
        if (disposed) {
          fn();
          return;
        }
        unlisten = fn;
      });
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, [autoStopGatewaysOnClose, customConfigPath, customInstallPath, localInfo?.install_dir, lastInstallDir]);

  useEffect(() => {
    if (installing || uninstalling) return;
    if (!startupBootstrapDoneRef.current) return;
    if (configReloadTimerRef.current !== null) {
      window.clearTimeout(configReloadTimerRef.current);
      configReloadTimerRef.current = null;
    }
    const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
    configReloadTimerRef.current = window.setTimeout(() => {
      if (step >= 1) {
        void refreshLocalInfo(undefined, cfgPath);
      }
      if (step >= 2) {
        void Promise.all([
          loadSavedAiConfig(cfgPath),
          loadRuntimeModelInfo(cfgPath),
          loadKeySyncStatus(cfgPath),
        ]);
      }
    }, 350);
    return () => {
      if (configReloadTimerRef.current !== null) {
        window.clearTimeout(configReloadTimerRef.current);
        configReloadTimerRef.current = null;
      }
    };
  }, [customConfigPath, installing, uninstalling]);

  // 窗口重新获得焦点时刷新安装状态（例如脚本删除后切回应用）
  useEffect(() => {
    const onFocus = () => {
      if (installing || uninstalling) return;
      if (step >= 1) {
        const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
        const installHint = (localInfo?.install_dir || customInstallPath || lastInstallDir || "").trim() || undefined;
        void refreshLocalInfo(installHint, cfgPath);
      }
    };
    const handler = () => document.visibilityState === "visible" && onFocus();
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [step, customConfigPath, customInstallPath, installing, localInfo?.install_dir, lastInstallDir, uninstalling]);

  useEffect(() => {
    if (installing || uninstalling) return;
    const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
    const installHint = customInstallPath.trim() || undefined;
    if (step === 1 && !loadedStepDataRef.current.install) {
      loadedStepDataRef.current.install = true;
      void refreshLocalInfo(installHint, cfgPath);
    }
    if (step === 2 && !loadedStepDataRef.current.model) {
      loadedStepDataRef.current.model = true;
      void Promise.all([
        loadSavedAiConfig(cfgPath),
        loadRuntimeModelInfo(cfgPath),
        loadKeySyncStatus(cfgPath),
      ]);
    }
    if (step === 4 && tuningSection === "health" && !loadedStepDataRef.current.channel) {
      loadedStepDataRef.current.channel = true;
      scheduleIdleTask(() => {
        void loadSavedChannels(cfgPath);
      }, 1200);
    }
    if (step === 4 && tuningSection === "memory") {
      scheduleIdleTask(() => {
        void refreshMemoryCenterStatus();
      }, 1200);
    }
  }, [step, tuningSection, customConfigPath, customInstallPath, installing, uninstalling]);

  useEffect(() => {
    if (!installing) return;
    logEndRef.current?.scrollIntoView({ behavior: "auto" });
  }, [installLog]);

  const appendInstallLog = installLogs.append;
  const flushInstallLogs = installLogs.flush;

  const appendUninstallLog = useCallback((line: string) => {
    const nextLine = stripAnsi(String(line || "").trim());
    if (!nextLine) return;
    setUninstallLog((prev) => {
      const merged = [...prev, nextLine];
      return merged.length > 120 ? merged.slice(-120) : merged;
    });
  }, []);

  useEffect(() => {
    const unlistenPromise = listen<string>("install-output", (e) => {
      const raw = String(e.payload ?? "");
      if (raw.startsWith("__STEP__|")) {
        const parts = raw.split("|");
        const key = parts[1];
        const status = parts[2] as InstallStepStatus;
        const text = parts.slice(3).join("|");
        setInstallSteps((prev) =>
          prev.map((item) => (item.key === key ? { ...item, status } : item))
        );
        if (text) appendInstallLog(text);
        return;
      }
      appendInstallLog(stripAnsi(raw));
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    const unlistenPromise = listen<InstallOpenclawFinishedEvent>("install-openclaw-finished", (event) => {
      const payload = event.payload;
      if (!payload) return;
      void (async () => {
        flushInstallLogs();
        setInstalling(false);
        if (payload.ok && payload.result) {
          const result = payload.result;
          setCustomConfigPath(normalizeConfigPath(result.config_dir));
          setLastInstallDir(result.install_dir);
          setCustomInstallPath(result.install_dir);
          setInstallResult(payload.message || "安装成功");
          await runEnvCheck(result.install_dir);
          await refreshLocalInfoRef.current(result.install_dir, result.config_dir);
          return;
        }
        setInstallResult(payload.message || "安装失败");
      })();
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    const unlistenPromise = listen<string>("update-output", (e) => {
      const raw = String(e.payload ?? "");
      if (raw.startsWith("__STEP__|")) {
        const parts = raw.split("|");
        const key = parts[1];
        const status = parts[2] as InstallStepStatus;
        const text = parts.slice(3).join("|");
        setInstallSteps((prev) =>
          prev.map((item) => (item.key === key ? { ...item, status } : item))
        );
        if (text) appendInstallLog(text);
        return;
      }
      appendInstallLog(stripAnsi(raw));
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    const unlistenPromise = listen<InstallOpenclawFinishedEvent>("update-openclaw-finished", (event) => {
      const payload = event.payload;
      if (!payload) return;
      void (async () => {
        flushInstallLogs();
        setInstalling(false);
        if (payload.ok && payload.result) {
          const result = payload.result;
          setCustomConfigPath(normalizeConfigPath(result.config_dir));
          setLastInstallDir(result.install_dir);
          setCustomInstallPath(result.install_dir);
          setInstallResult(payload.message || "更新成功");
          await runEnvCheck(result.install_dir);
          await refreshLocalInfoRef.current(result.install_dir, result.config_dir);
          return;
        }
        setInstallResult(payload.message || "更新失败");
      })();
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    const unlistenPromise = listen<string>("uninstall-output", (e) => {
      const raw = String(e.payload ?? "");
      if (raw.startsWith("__STEP__|")) {
        const parts = raw.split("|");
        const text = parts.slice(3).join("|");
        appendUninstallLog(text);
        return;
      }
      appendUninstallLog(raw);
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [appendUninstallLog]);

  useTauriListener<UninstallOpenclawFinishedEvent>("uninstall-openclaw-finished", (event) => {
    const payload = event.payload;
    if (!payload) return;
    void (async () => {
      setUninstalling(false);
      setInstallResult(payload.message || (payload.ok ? "OpenClaw 已卸载" : "卸载失败"));
      if (!payload.ok) return;
      setOpenclawCheck({ ok: false, message: "OpenClaw 已卸载", version: undefined });
      setCustomConfigPath("");
      setCustomInstallPath("");
      setLastInstallDir("");
      clearOpenclawRuntimeState();
      localStorage.removeItem("openclaw_config_dir");
      localStorage.removeItem("openclaw_install_dir");
      await runEnvCheck();
      await refreshLocalInfoRef.current(undefined, undefined);
    })();
  });

  const appendPluginLog = pluginLogs.append;
  const flushPluginLogs = pluginLogs.flush;
  const appendSkillImportLog = skillImportLogs.append;
  const flushSkillImportLogs = skillImportLogs.flush;
  const appendSkillsLog = skillsLogs.append;
  const flushSkillsLogs = skillsLogs.flush;

  useEffect(() => {
    setModelTestResult(null);
    const ids = FIXED_SILICONFLOW_MODELS.map((m) => m.id);
    setSelectedModel((prev) => (ids.includes(prev) ? prev : RECOMMENDED_MODEL_FALLBACK));
  }, [provider, baseUrl, apiKey]);

  useEffect(() => {
    const loadRecommendedDir = async () => {
      try {
        const dir = await invoke<string>("recommended_install_dir");
        setRecommendedInstallDir(normalizeConfigPath(dir));
      } catch {
        // ignore and fallback to manual defaults
      }
    };
    void loadRecommendedDir();
  }, []);

  useEffect(() => {
    return () => {
      if (configReloadTimerRef.current !== null) {
        window.clearTimeout(configReloadTimerRef.current);
      }
      cancelIdleTask(deferredEnvCheckTimerRef.current);
      cancelIdleTask(deferredPageRenderTimerRef.current);
      cancelIdleTask(repairPanelWarmupTimerRef.current);
      cancelIdleTask(startupAgentsPrewarmTimerRef.current);
      cancelIdleTask(startupRuntimePrewarmTimerRef.current);
      cancelIdleTask(agentEntryRuntimeRefreshTimerRef.current);
      cancelIdleTask(deferredRuntimeAdvancedApplyTimerRef.current);
    };
  }, []);

  const ENV_CHECK_TIMEOUT_MS = 10000;

  const runEnvCheck = async (installHint?: string) => {
    setChecking(true);
    try {
      const openclawHint =
        installHint?.trim() ||
        lastInstallDir.trim() ||
        customInstallPath.trim() ||
        undefined;
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("环境检测超时，请检查 Node.js 是否已正确安装")), ENV_CHECK_TIMEOUT_MS)
      );
      const [node, npm, git, openclaw, pathCheck] = await measureAsync(
        "frontend.runEnvCheck",
        async () => {
          const checkPromise = Promise.all([
            invoke<EnvCheckResult>("check_node"),
            invoke<EnvCheckResult>("check_npm"),
            invoke<EnvCheckResult>("check_git"),
            invoke<EnvCheckResult>("check_openclaw", { installHint: openclawHint }),
            invoke<{ in_path: boolean; path: string }>("check_npm_path_in_user_env"),
          ]);
          return Promise.race([checkPromise, timeoutPromise]);
        },
        openclawHint || "default"
      );
      setNodeCheck(node);
      setNpmCheck(npm);
      setGitCheck(git);
      setOpenclawCheck(openclaw);
      setNpmPathInPath(pathCheck.in_path);
      setNpmPath(pathCheck.path);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setNodeCheck({ ok: false, message: msg.includes("超时") ? msg : `检测失败: ${msg}` });
      setNpmCheck({ ok: false, message: msg.includes("超时") ? msg : "检测失败" });
      setGitCheck({ ok: false, message: msg.includes("超时") ? msg : "检测失败" });
      setOpenclawCheck({ ok: false, message: msg.includes("超时") ? msg : "检测失败" });
      setNpmPathInPath(null);
    } finally {
      setChecking(false);
    }
  };

  const loadSavedAiConfig = async (cfgPath?: string) => {
    try {
      const data = await invoke<SavedAiConfig>("read_env_config", {
        customPath: normalizeConfigPath(cfgPath || customConfigPath) || undefined,
      });
      if (data.provider) setProvider(data.provider);
      if (data.base_url) setBaseUrl(data.base_url);
      setProxyUrl((data.proxy_url || "").trim());
      setNoProxy((data.no_proxy || "").trim());
      if (data.has_api_key) {
        setSavedAiHint("已检测到本地已保存 API Key（已保护，不在界面显示）。");
      } else {
        setSavedAiHint(null);
      }
    } catch {
      setSavedAiHint(null);
    }
  };

  const refreshLocalInfo = useCallback(async (installHint?: string, cfgPath?: string) => {
    const normalizedCfgPath = normalizeConfigPath(cfgPath || customConfigPath) || undefined;
    const resolvedInstallHint = installHint || customInstallPath || undefined;
    const nextLocalInfo = await measureAsync(
      "frontend.refreshLocalInfo",
      async () =>
        invoke<LocalOpenclawInfo>("get_local_openclaw", {
          installHint: resolvedInstallHint,
          customPath: normalizedCfgPath,
        }),
      normalizedCfgPath || resolvedInstallHint || "default"
    ).catch(() => null);
    if (nextLocalInfo) {
      openclawRuntimeClearedRef.current = !nextLocalInfo.installed ? openclawRuntimeClearedRef.current : false;
      setLocalInfo((prev) => {
        if (
          prev?.installed === nextLocalInfo.installed &&
          prev?.install_dir === nextLocalInfo.install_dir &&
          prev?.executable === nextLocalInfo.executable &&
          prev?.version === nextLocalInfo.version
        ) {
          return prev;
        }
        return nextLocalInfo;
      });
    } else {
      setLocalInfo((prev) => (prev === null ? prev : null));
    }
    if (!nextLocalInfo?.installed && !openclawRuntimeClearedRef.current) {
      clearOpenclawRuntimeState();
    }
  }, [clearOpenclawRuntimeState, customConfigPath, customInstallPath]);
  refreshLocalInfoRef.current = refreshLocalInfo;

  const loadRuntimeModelInfo = async (cfgPath?: string) => {
    try {
      const data = await invoke<RuntimeModelInfo>("read_runtime_model_info", {
        customPath: normalizeConfigPath(cfgPath || customConfigPath) || undefined,
      });
      setRuntimeModelInfo(data);
      const raw = data.model?.includes("/") ? data.model.split("/").slice(1).join("/") : data.model;
      const ids = FIXED_SILICONFLOW_MODELS.map((m) => m.id);
      if (raw && ids.includes(raw)) setSelectedModel(raw);
      else if (raw) setSelectedModel(RECOMMENDED_MODEL_FALLBACK);
    } catch {
      setRuntimeModelInfo(null);
    }
  };

  const loadKeySyncStatus = async (cfgPath?: string) => {
    try {
      const data = await invoke<KeySyncStatus>("read_key_sync_status", {
        customPath: normalizeConfigPath(cfgPath || customConfigPath) || undefined,
      });
      setKeySyncStatus(data);
    } catch {
      setKeySyncStatus(null);
    }
  };


  const probeRuntimeModelConnection = async (cfgPath?: string) => {
    if (runtimeProbeLoading) return;
    setRuntimeProbeLoading(true);
    setRuntimeProbeResult(null);
    try {
      const result = await invoke<string>("probe_runtime_model_connection", {
        customPath: normalizeConfigPath(cfgPath || customConfigPath) || undefined,
      });
      setRuntimeProbeResult(result);
    } catch (e) {
      setRuntimeProbeResult(`启动自动探活：${e}`);
    } finally {
      setRuntimeProbeLoading(false);
    }
  };
  probeRuntimeModelConnectionRef.current = probeRuntimeModelConnection;

  const loadSavedChannels = async (cfgPath?: string) => {
    try {
      const customPath = normalizeConfigPath(cfgPath || customConfigPath) || undefined;
      const [tg, fs, qq, dc, dt] = await Promise.all([
        invoke<ChannelConfig>("read_channel_config", { channel: "telegram", customPath }),
        invoke<ChannelConfig>("read_channel_config", { channel: "feishu", customPath }),
        invoke<ChannelConfig>("read_channel_config", { channel: "qq", customPath }),
        invoke<ChannelConfig>("read_channel_config", { channel: "discord", customPath }),
        invoke<ChannelConfig>("read_channel_config", { channel: "dingtalk", customPath }),
      ]);
      setTelegramConfig({
        botToken: tg?.botToken ?? "",
        chatId: tg?.chatId ?? "",
      });
      void fs;
      void qq;
      void dc;
      void dt;
    } catch {
      // ignore load failures to keep manual input path usable
    }
  };

  const handleInstallDefault = async () => {
    const installDir =
      recommendedInstallDir ||
      customInstallPath.trim() ||
      "C:/openclaw";
    setOpenclawManageMode("install");
    setInstalling(true);
    setInstallResult(null);
    installLogs.reset();
    setUninstallLog([]);
    setInstallSteps(INSTALL_STEPS.map((s) => ({ ...s, status: "pending" })));
    try {
      await invoke<string>("install_openclaw_full_background", {
        installDir,
      });
    } catch (e) {
      setInstallResult(`错误: ${e}`);
      flushInstallLogs();
      setInstalling(false);
    }
  };

  const handleUpdateOpenclaw = async () => {
    const installDir = (localInfo?.install_dir || customInstallPath || lastInstallDir || "").trim();
    if (!installDir) {
      setInstallResult("错误: 未找到安装目录，无法更新");
      return;
    }
    const ok = window.confirm(`确认更新 OpenClaw 吗？\n安装目录：${installDir}`);
    if (!ok) return;
    setOpenclawManageMode("update");
    setInstalling(true);
    setInstallResult("正在更新 OpenClaw...");
    installLogs.reset();
    setUninstallLog([]);
    setInstallSteps(UPDATE_STEPS.map((s) => ({ ...s, status: "pending" })));
    try {
      await invoke<string>("update_openclaw_background", {
        installDir,
        customPath: normalizeConfigPath(customConfigPath) || undefined,
      });
    } catch (e) {
      setInstallResult(`更新失败: ${e}`);
      flushInstallLogs();
      setInstalling(false);
    }
  };

  const handleSaveConfig = async () => {
    if (apiEntryMode === "relay" && !apiKey.trim()) {
      setSaveResult("请先去中转站获取 API Key，拿到后切回“我已经有 API Key”再保存。");
      return;
    }
    if (looksLikeApiKey(customConfigPath)) {
      setApiKey(customConfigPath.trim());
      setCustomConfigPath("");
      setSaveResult("检测到你把 API Key 填在“自定义配置路径”了，已自动移动到 API Key 输入框。请确认后重新点“保存配置”。");
      return;
    }
    const modelIdForValidation =
      selectedModel.trim() || preferredPrimaryModelForProvider(provider).split("/").slice(1).join("/");
    const inferredWindow = inferModelContextWindow(modelIdForValidation);
    if (inferredWindow !== null && inferredWindow < 16000) {
      setSaveResult(
        `保存失败：所选模型 ${modelIdForValidation} 上下文窗口仅 ${inferredWindow}，系统最低要求 16000。请改选 16k/32k/128k 模型。`
      );
      return;
    }
    const runtimeModelRaw =
      runtimeModelInfo?.model?.includes("/") ? runtimeModelInfo.model.split("/").slice(1).join("/") : runtimeModelInfo?.model;
    const targetPrimaryModel = selectedModel.trim()
      ? `${provider === "anthropic" ? "anthropic" : "openai"}/${selectedModel.trim()}`
      : preferredPrimaryModelForProvider(provider);
    const runtimeBase = (runtimeModelInfo?.base_url || "").trim();
    const nextBase = (baseUrl || "").trim();
    const isSwitchingConfig =
      (!!runtimeModelInfo?.model && runtimeModelInfo.model.trim() !== targetPrimaryModel.trim()) ||
      (!!selectedModel && !!runtimeModelRaw && selectedModel.trim() !== runtimeModelRaw.trim()) ||
      (!!nextBase && !!runtimeBase && nextBase !== runtimeBase);
    const shouldResetSessions = isSwitchingConfig || !!apiKey.trim();
    if (isSwitchingConfig && !apiKey.trim()) {
      setSaveResult("你正在切换模型或 API 地址，但未输入 API Key。为避免沿用旧 Key，请重新输入 API Key 后再保存。");
      return;
    }
    setSaving(true);
    setSaveResult(null);
    try {
      const customPathNormalized = normalizeConfigPath(customConfigPath) || undefined;
      const result = await invoke<string>("write_env_config", {
        apiKey: apiKey.trim() || undefined,
        provider,
        baseUrl: baseUrl.trim() || undefined,
        selectedModel: selectedModel.trim() || undefined,
        resetSessions: shouldResetSessions,
        proxyUrl: proxyUrl.trim() || undefined,
        noProxy: noProxy.trim() || undefined,
        customPath: customPathNormalized,
      });
      setSaveResult(result);
      await loadSavedAiConfig();
      await loadRuntimeModelInfo();
      await loadKeySyncStatus();
      try {
        await invoke<string>("test_model_connection", {
          provider,
          baseUrl: baseUrl.trim() || undefined,
          apiKey: apiKey.trim() || undefined,
          customPath: customPathNormalized,
        });
        setModelTestResult("配置已保存，连通性检测通过");
      } catch (e) {
        setModelTestResult(`配置已保存，但连通性检测失败: ${e}`);
      }
    } catch (e) {
      setSaveResult(`保存失败: ${e}`);
    } finally {
      setSaving(false);
    }
  };

  const handleTestModel = async () => {
    if (apiEntryMode === "relay" && !apiKey.trim()) {
      setModelTestResult("请先去中转站获取 API Key，拿到后切回“我已经有 API Key”再验证。");
      return;
    }
    if (looksLikeApiKey(customConfigPath)) {
      setApiKey(customConfigPath.trim());
      setCustomConfigPath("");
      setModelTestResult("检测到你把 API Key 填在“自定义配置路径”了，已自动移动到 API Key 输入框。请重新点“模型连通性检测”。");
      return;
    }
    setModelTesting(true);
    setModelTestResult(null);
    try {
      const result = await invoke<string>("test_model_connection", {
        provider,
        baseUrl: baseUrl.trim() || undefined,
        apiKey: apiKey.trim() || undefined,
        customPath: normalizeConfigPath(customConfigPath) || undefined,
      });
      setModelTestResult(result);
      await loadRuntimeModelInfo();
    } catch (e) {
      setModelTestResult(`检测失败: ${e}`);
    } finally {
      setModelTesting(false);
    }
  };

  const handleCleanupLegacyCache = async () => {
    setCleaningLegacy(true);
    setSaveResult(null);
    try {
      const result = await invoke<string>("cleanup_legacy_provider_cache", {
        customPath: normalizeConfigPath(customConfigPath) || undefined,
      });
      setSaveResult(result);
      await Promise.all([
        loadSavedAiConfig(),
        loadRuntimeModelInfo(),
        loadKeySyncStatus(),
      ]);
    } catch (e) {
      setSaveResult(`清理失败: ${e}`);
    } finally {
      setCleaningLegacy(false);
    }
  };

  const handleUninstall = async () => {
    const dir = (localInfo?.install_dir || customInstallPath || "").trim();
    if (!dir) {
      setInstallResult("错误: 未找到安装目录，无法卸载");
      return;
    }
    const customPathNormalized = normalizeConfigPath(customConfigPath) || undefined;
    let preview: UninstallOpenclawPreview;
    try {
      preview = await invoke<UninstallOpenclawPreview>("preview_uninstall_openclaw", {
        installDir: dir,
        customPath: customPathNormalized,
      });
    } catch (e) {
      setInstallResult(`卸载前校验失败: ${e}`);
      return;
    }
    const ok = window.confirm(buildUninstallConfirmMessage(preview));
    if (!ok) return;
    setUninstalling(true);
    setInstallResult("正在卸载 OpenClaw...");
    setUninstallLog([]);
    try {
      await invoke<string>("uninstall_openclaw_background", {
        installDir: dir,
        customPath: customPathNormalized,
      });
    } catch (e) {
      setInstallResult(`卸载失败: ${e}`);
      setUninstalling(false);
    }
  };

  const resolvePairingGatewayId = useCallback(() => {
    const agentId = selectedAgentId || agentsList?.agents.find((a) => a.default)?.id || agentsList?.agents[0]?.id || "";
    return agentId ? `gw-agent-${agentId.trim().replace(/[ /\\:]+/g, "-")}` : undefined;
  }, [selectedAgentId, agentsList]);

  const fetchPairingRequests = useCallback(
    async (channel: PairingChannel): Promise<PairingRequestItem[]> => {
      const gatewayId = resolvePairingGatewayId();
      const jsonResp = await invoke<PairingListResponse>("list_pairings_json", {
        channel,
        customPath: normalizeConfigPath(customConfigPath) || undefined,
        gatewayId,
      });
      const requests = Array.isArray(jsonResp?.requests) ? jsonResp.requests : [];
      setPairingRequestsByChannel((prev) => ({ ...prev, [channel]: requests }));
      return requests;
    },
    [customConfigPath, resolvePairingGatewayId],
  );

  const refreshAllPairingRequests = useCallback(
    async (channels?: PairingChannel[]) => {
      if (pairingRefreshPendingRef.current) return;
      pairingRefreshPendingRef.current = true;
      try {
        const gatewayId = resolvePairingGatewayId();
        await invoke<string>("refresh_pairings_background", {
          channels: channels ?? (["telegram", "feishu", "qq"] as PairingChannel[]),
          customPath: normalizeConfigPath(customConfigPath) || undefined,
          gatewayId,
        });
      } catch {
        pairingRefreshPendingRef.current = false;
      }
    },
    [customConfigPath, resolvePairingGatewayId],
  );

  const handleListPairings = async (channel: "telegram" | "feishu" | "qq") => {
    setPairingLoading(channel);
    setChannelResult(null);
    if (pairingRefreshPendingRef.current) {
      setChannelResult("后台正在刷新待审批列表，请稍候再试。");
      setPairingLoading(null);
      return;
    }
    manualPairingQueryChannelRef.current = channel;
    pairingRefreshPendingRef.current = true;
    try {
      const gatewayId = resolvePairingGatewayId();
      await invoke<string>("refresh_pairings_background", {
        channels: [channel],
        customPath: normalizeConfigPath(customConfigPath) || undefined,
        gatewayId,
      });
    } catch (e) {
      manualPairingQueryChannelRef.current = null;
      pairingRefreshPendingRef.current = false;
      setPairingRequestsByChannel((prev) => ({ ...prev, [channel]: [] }));
      setChannelResult(`查询配对失败: ${e}`);
      setPairingLoading(null);
    }
  };

  const handleApprovePairing = useCallback(
    async (channel: "telegram" | "feishu" | "qq", codeOverride?: string) => {
      setPairingLoading(channel);
      setChannelResult(null);
      try {
        const code = (codeOverride ?? pairingCodeByChannel[channel]).trim();
        const gatewayId = resolvePairingGatewayId();
        const result = await invoke<string>("approve_pairing", {
          channel,
          code,
          customPath: normalizeConfigPath(customConfigPath) || undefined,
          gatewayId,
        });
        setChannelResult(result);
        setPairingCodeByChannel((prev) => ({ ...prev, [channel]: "" }));
        try {
          await fetchPairingRequests(channel);
        } catch {}
      } catch (e) {
        setChannelResult(`配对失败: ${e}`);
      } finally {
        setPairingLoading(null);
      }
    },
    [customConfigPath, fetchPairingRequests, pairingCodeByChannel, resolvePairingGatewayId],
  );

  const runtimeHealthPanelVisible = step === 4 && tuningSection === "health";

  const refreshAllChannelHealth = async (force = false) => {
    if (starting || anyChatSending || isChatInteracting()) return;
    if (!force && !runtimeHealthPanelVisible) return;
    if (repairHealthRefreshPendingRef.current) return;
    repairHealthRefreshPendingRef.current = true;
    try {
      const installHint = (localInfo?.install_dir || customInstallPath || lastInstallDir || "").trim() || undefined;
      await invoke<string>("refresh_repair_health_background", {
        customPath: normalizeConfigPath(customConfigPath) || undefined,
        installHint,
        telegramConfig,
      });
    } catch (e) {
      repairHealthRefreshPendingRef.current = false;
      const next: ChannelHealthInfo = {
        configured: "unknown",
        token: "unknown",
        gateway: "unknown",
        pairing: "unknown",
        detail: `刷新失败: ${e}`,
      };
      setTelegramHealth((prev) => (isSameChannelHealthInfo(prev, next) ? prev : next));
    }
  };
  refreshAllChannelHealthRef.current = refreshAllChannelHealth;

  useEffect(() => {
    if (!runtimeHealthPanelVisible || starting || !autoRefreshHealth) return;
    if (repairPanelWarmupTimerRef.current !== null) {
      cancelIdleTask(repairPanelWarmupTimerRef.current);
      repairPanelWarmupTimerRef.current = null;
    }
    const repairWarmupKey = `${normalizeConfigPath(customConfigPath) || "default"}::health`;
    if (
      repairWarmupKeyRef.current === repairWarmupKey &&
      Date.now() - repairWarmupAtRef.current < PAGE_AUTO_REFRESH_TTL_MS
    ) {
      return;
    }
    const runWarmup = () => {
      if (document.hidden) return;
      repairWarmupKeyRef.current = repairWarmupKey;
      repairWarmupAtRef.current = Date.now();
      void refreshAllChannelHealth();
      void refreshAllPairingRequests();
    };
    repairPanelWarmupTimerRef.current = scheduleIdleTask(runWarmup, 1800);
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void refreshAllChannelHealth();
      void refreshAllPairingRequests();
    }, 60000);
    return () => {
      window.clearInterval(timer);
      if (repairPanelWarmupTimerRef.current !== null) {
        cancelIdleTask(repairPanelWarmupTimerRef.current);
        repairPanelWarmupTimerRef.current = null;
      }
    };
  }, [runtimeHealthPanelVisible, customConfigPath, starting, autoRefreshHealth, anyChatSending, refreshAllPairingRequests]);

  useEffect(() => {
    const unlistenPromise = listen<GatewayStartEvent>("gateway-start-finished", (event) => {
      const payload = event.payload;
      if (!payload) return;
      setStarting(false);
      setStartResult(stripAnsi(payload.message || ""));
      if (payload.ok) {
        setStep(3);
      }
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useTauriListener<GatewayInstanceActionFinishedEvent>("gateway-instance-action-finished", (event) => {
    const payload = event.payload;
    if (!payload?.gatewayId) return;
    const actionRecoveredByHealth =
      (payload.action === "start" || payload.action === "restart") && payload.row?.health?.status === "ok";
    const effectiveOk = !!payload.ok || actionRecoveredByHealth;
    const effectiveMessage = actionRecoveredByHealth
      ? `网关 ${payload.gatewayId} 已启动${payload.row?.health?.detail ? `：${payload.row.health.detail}` : ""}`
      : payload.message;
    setGatewayActionLoadingById((prev) => ({ ...prev, [payload.gatewayId]: false }));
    if (payload.row) {
      upsertGatewayBindingRow(payload.row);
    }
    setGatewayActionHintById((prev) => ({
      ...prev,
      [payload.gatewayId]: describeGatewayAction(payload.action, effectiveOk, effectiveMessage),
    }));
    if (
      gatewayBatchProgress?.active &&
      payload.action === gatewayBatchProgress.action &&
      !gatewayBatchSeenRef.current[payload.gatewayId]
    ) {
      gatewayBatchSeenRef.current[payload.gatewayId] = true;
      setGatewayBatchProgress((prev) =>
        prev
          ? {
              ...prev,
              done: Math.min(prev.total, prev.done + 1),
              succeeded: prev.succeeded + (effectiveOk ? 1 : 0),
              failed: prev.failed + (effectiveOk ? 0 : 1),
            }
          : prev
      );
    }
    if (stepRef.current === 3 && (payload.action === "start" || payload.action === "restart" || payload.action === "stop")) {
      setStartResult(stripAnsi(effectiveMessage || `${payload.action} 完成`));
      setStarting(false);
    }
    setAgentRuntimeResult(stripAnsi(effectiveMessage || `${payload.action} 完成`));
  });

  useTauriListener<TelegramSelfHealFinishedEvent>("telegram-self-heal-finished", (event) => {
    const payload = event.payload;
    if (!payload?.message) return;
    const message = stripAnsi(payload.message || "Telegram 自动自愈已执行");
    setTelegramSelfHealResult(message);
    const gatewayIds = (payload.gatewayIds || []).filter((id): id is string => !!(id || "").trim());
    if (gatewayIds.length) {
      const hint = message.split("\n")[0] || "Telegram 长轮询卡死，已自动重启";
      setGatewayActionHintById((prev) => {
        const next = { ...prev };
        for (const gatewayId of gatewayIds) {
          next[gatewayId] = hint;
        }
        return next;
      });
    }
    void (async () => {
      try {
        const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
        const list = await invoke<GatewayBinding[]>("list_gateway_instances", { customPath: cfgPath });
        applyGatewayBindingsSnapshot(list || [], { source: "live", refreshedAt: Date.now() });
      } catch (error) {
        console.error("refresh gateways after telegram self-heal failed", error);
      }
    })();
  });

  useEffect(() => {
    const unlistenPromise = listen<RepairHealthFinishedEvent>("repair-health-finished", (event) => {
      repairHealthRefreshPendingRef.current = false;
      const payload = event.payload;
      if (!payload?.ok || !payload.telegram) {
        const next: ChannelHealthInfo = {
          configured: "unknown",
          token: "unknown",
          gateway: "unknown",
          pairing: "unknown",
          detail: payload?.error || "修复中心健康状态刷新失败",
        };
        setTelegramHealth((prev) => (isSameChannelHealthInfo(prev, next) ? prev : next));
        return;
      }
      setTelegramHealth((prev) => (isSameChannelHealthInfo(prev, payload.telegram as ChannelHealthInfo) ? prev : (payload.telegram as ChannelHealthInfo)));
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    const unlistenPromise = listen<PairingRequestsFinishedEvent>("pairing-requests-finished", (event) => {
      pairingRefreshPendingRef.current = false;
      const items = event.payload?.items || [];
      let manualMessage: string | null = null;
      const manualChannel = manualPairingQueryChannelRef.current;
      setPairingRequestsByChannel((prev) => {
        const next = { ...prev };
        let changed = false;
        items.forEach((item) => {
          const channel = item.channel;
          if (channel !== "telegram" && channel !== "feishu" && channel !== "qq") return;
          if (item.error) {
            if (manualChannel === channel) {
              manualMessage = `查询配对失败: ${item.error}`;
            }
            return;
          }
          const requests = Array.isArray(item.requests) ? item.requests : [];
          if (prev[channel] !== requests) {
            next[channel] = requests;
            changed = true;
          }
          if (manualChannel === channel) {
            manualMessage = requests.length === 0 ? "当前没有待审批配对请求。" : `已找到 ${requests.length} 条待审批配对请求。`;
          }
        });
        return changed ? next : prev;
      });
      if (manualChannel) {
        setPairingLoading(null);
        setChannelResult(manualMessage || "待审批列表已刷新。");
        manualPairingQueryChannelRef.current = null;
      }
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    const unlistenPromise = listen<SelfCheckFinishedEvent>("self-check-finished", (event) => {
      const payload = event.payload;
      if (!payload) return;
      setTuningActionLoading(null);
      if (!payload.ok) {
        setSelfCheckResult(`体检失败: ${payload.error || "未知错误"}`);
        return;
      }
      setSelfCheckItems(payload.items || []);
      setSelfCheckResult("调教中心体检完成");
      void Promise.all([loadSkillsCatalogRef.current(), refreshAllChannelHealthRef.current(true)]);
      void probeRuntimeModelConnectionRef.current();
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    const unlistenPromise = listen<TuningSelfHealFinishedEvent>("tuning-self-heal-finished", (event) => {
      const payload = event.payload;
      if (!payload) return;
      setTuningActionLoading(null);
      setSelfCheckResult(clampLogText(payload.message || "一键修复完成"));
      if (!payload.ok) return;
      void Promise.all([
        loadSkillsCatalogRef.current(),
        refreshAllChannelHealthRef.current(true),
        refreshMemoryCenterStatusRef.current(),
      ]);
      void probeRuntimeModelConnectionRef.current();
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    const unlistenPromise = listen<PluginInstallProgressEvent>("plugin-install-progress", (event) => {
      const payload = event.payload;
      if (!payload) return;
      setPluginInstallProgress(payload);
      appendPluginLog(`[${payload.current}/${payload.total}] ${payload.channel}: ${payload.message}`);
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    const unlistenPromise = listen<PluginInstallFinishedEvent>("plugin-install-finished", (event) => {
      const payload = event.payload;
      if (!payload) return;
      flushPluginLogs();
      setPluginInstallLoading(false);
      setPluginInstallResult(clampLogText(payload.message || (payload.ok ? "插件安装完成" : "插件安装失败")));
      if (!payload.ok) {
        setTicketSummary(makeTicketSummary("渠道插件自动安装", payload.message || "未知错误", "auto_install_channel_plugins_background"));
      }
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    const unlistenPromise = listen<SkillsRepairProgressEvent>("skills-repair-progress", (event) => {
      const payload = event.payload;
      if (!payload) return;
      setSkillsRepairProgress(payload);
      appendSkillsLog(`[${payload.current}/${payload.total}] ${payload.skill}: ${payload.message}`);
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    const unlistenPromise = listen<SkillsManageFinishedEvent>("skills-manage-finished", (event) => {
      const payload = event.payload;
      if (!payload) return;
      setSkillsLoading(false);
      setSkillsResult(clampLogText(payload.message || (payload.ok ? "Skills 操作完成" : "Skills 操作失败")));
      if (payload.ok) {
        void loadSkillsCatalogRef.current();
      }
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    const unlistenPromise = listen<SkillsSelectionFinishedEvent>("skills-selection-finished", (event) => {
      const payload = event.payload;
      if (!payload) return;
      flushSkillsLogs();
      setSkillsRepairLoading(false);
      setSkillsAction(null);
      setSkillsResult(clampLogText(payload.message || (payload.ok ? "Skills 任务完成" : "Skills 任务失败")));
      if (!payload.ok) {
        setTicketSummary(makeTicketSummary(`${payload.action} 选中Skills`, payload.message || "未知错误", `skills_selection_${payload.action}`));
        return;
      }
      void loadSkillsCatalogRef.current().then((refreshed) => {
        setSkillRepairStateByName((prev) => {
          const next = { ...prev };
          for (const name of payload.skillNames || []) {
            const hit = refreshed.find((item) => item.name === name);
            if (!hit) continue;
            next[name] = hit.eligible ? "fixed" : hasManualSkillGaps(hit) ? "manual" : "still_missing";
          }
          return next;
        });
      });
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    const unlistenPromise = listen<SkillImportProgressEvent>("skill-import-progress", (event) => {
      const payload = event.payload;
      if (!payload) return;
      setSkillImportProgress(payload);
      appendSkillImportLog(`[${payload.current}/${payload.total}] ${payload.label}: ${payload.message}`);
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    const unlistenPromise = listen<SkillImportFinishedEvent>("skill-import-finished", (event) => {
      const payload = event.payload;
      if (!payload) return;
      flushSkillImportLogs();
      setMarketInstallKey(null);
      setLocalSkillInstalling(false);
      setMarketResult(clampLogText(payload.message || (payload.ok ? "Skill 导入完成" : "Skill 导入失败")));
      if (!payload.ok) {
        setTicketSummary(makeTicketSummary(
          payload.kind === "local" ? "本地 Skill 导入" : "第三方 Skill 安装",
          payload.message || "未知错误",
          payload.kind === "local" ? "install_local_skill_background" : "install_market_skill_background"
        ));
        pendingSkillImportRef.current = null;
        return;
      }
      const pending = pendingSkillImportRef.current;
      void loadSkillsCatalogRef.current().then(async (refreshed) => {
        if (
          pending &&
          pending.kind === payload.kind &&
          pending.enableForCurrentAgent &&
          pending.targetAgentId &&
          pending.skillName
        ) {
          const baseSet =
            pending.currentBindingMode === "custom"
              ? new Set(pending.currentEnabledSkills || [])
              : new Set(refreshed.map((item) => item.name));
          baseSet.add(pending.skillName);
          try {
            await persistAgentSkillBindingRef.current(
              pending.targetAgentId,
              "custom",
              Array.from(baseSet),
              `${payload.message}\n\n并已加入 ${pending.targetAgentId} 的独立 Skills 清单`
            );
            setMarketResult(`${payload.message}\n\n并已加入 ${pending.targetAgentId} 的独立 Skills 清单`);
          } catch (e) {
            setMarketResult(`${payload.message}\n\n但加入 ${pending.targetAgentId} 的独立 Skills 清单失败：${e}`);
          }
        }
        pendingSkillImportRef.current = null;
      });
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    const unlistenPromise = listen<TelegramBatchTestFinishedEvent>("telegram-batch-test-finished", (event) => {
      const payload = event.payload;
      if (!payload) return;
      setTelegramBatchTesting(false);
      if (!payload.ok) {
        setAgentRuntimeResult(`批量 getMe 检查失败: ${payload.error || "未知错误"}`);
        return;
      }
      const result = payload.results || [];
      if (!result.length) {
        setAgentRuntimeResult("批量检查完成：没有可检查的 Telegram 实例。");
        return;
      }
      const usernameMap: Record<string, string> = {};
      for (const r of result) {
        const uname = (r.username || "").trim();
        if (uname) usernameMap[r.id] = uname;
      }
      setTelegramUsernameByInstanceId((prev) => ({ ...prev, ...usernameMap }));
      const lines = result.map((r) => {
        const uname = (r.username || "").trim();
        return `${r.ok ? "✅" : "❌"} ${r.id}${uname ? ` (@${uname})` : ""} - ${r.detail}`;
      });
      const okCount = result.filter((r) => r.ok).length;
      setAgentRuntimeResult(`批量 getMe 检查完成：${okCount}/${result.length} 通过\n${lines.join("\n")}`);
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    const unlistenPromise = listen<ChannelBatchTestFinishedEvent>("channel-batch-test-finished", (event) => {
      const payload = event.payload;
      if (!payload?.channel) return;
      const channel = payload.channel as NonTelegramChannel;
      setChannelBatchTestingByChannel((prev) => ({ ...prev, [channel]: false }));
      if (!payload.ok) {
        setAgentRuntimeResult(`${channel} 批量检测失败: ${payload.error || "未知错误"}`);
        return;
      }
      const result = payload.results || [];
      if (!result.length) {
        setAgentRuntimeResult(`${channel} 批量检测完成：没有可检查的实例。`);
        return;
      }
      const okCount = result.filter((r) => r.ok).length;
      const lines = result.map((r) => `${r.ok ? "✅" : "❌"} ${r.id} - ${r.detail}`);
      setAgentRuntimeResult(`${channel} 批量检测完成：${okCount}/${result.length} 通过\n${lines.join("\n")}`);
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useTauriListener<ChatSendFinishedEvent>("chat-send-finished", (event) => {
    const payload = event.payload;
    if (!payload?.requestId || payload.ok) return;
    const meta = pendingChatRequestsRef.current[payload.requestId];
    if (!meta) return;
    delete pendingChatRequestsRef.current[payload.requestId];
    releasePendingChatRequest(meta.targetId, payload.requestId);
    setChatError(payload.error || "消息发送失败");
    markChatPreviewDirty(meta.targetId);
    setMessagesByAgent((prev) => ({
      ...prev,
      [meta.targetId]: (prev[meta.targetId] || []).map((m) =>
        m.id === meta.userMsgId ? { ...m, status: "failed" as const } : m
      ),
    }));
  });

  useTauriListener<ChatReplyFinishedEvent>("chat-reply-finished", (event) => {
    const payload = event.payload;
    if (!payload?.requestId) return;
    const meta = pendingChatRequestsRef.current[payload.requestId];
    if (!meta) return;
    delete pendingChatRequestsRef.current[payload.requestId];
    releasePendingChatRequest(meta.targetId, payload.requestId);
    if (typeof payload.cursor === "number") {
      chatCursorByAgentRef.current[meta.targetId] = payload.cursor;
    }
    if (!payload.ok) {
      setChatError(payload.error || "等待回复失败");
      markChatPreviewDirty(meta.targetId);
      setMessagesByAgent((prev) => ({
        ...prev,
        [meta.targetId]: (prev[meta.targetId] || []).map((m) =>
          m.id === meta.userMsgId ? { ...m, status: "failed" as const } : m
        ),
      }));
      return;
    }
    const replyText = String(payload.text || "").trim();
    const finalText =
      meta.mode === "orchestrator"
        ? `${meta.flowSummary || "【流程】"}\n${replyText || "暂未获取到最终回答（可切到“直连对话”重试）。"}`
        : replyText;
    if (!finalText) {
      setChatError("已结束等待，但未拿到回复内容");
      return;
    }
    const assistantMsg: ChatUiMessage = {
      id: `local-assistant-bg-${payload.requestId}`,
      role: "assistant",
      text: finalText,
      status: "sent",
      timestamp: new Date().toISOString(),
    };
    startTransition(() => {
      markChatPreviewDirty(meta.targetId);
      setMessagesByAgent((prev) => {
        const local = prev[meta.targetId] || [];
        const merged = trimChatMessagesForUi(
          appendDeltaUniqueMessages(
            local.map((m) => (m.id === meta.userMsgId ? { ...m, status: "sent" as const } : m)),
            [assistantMsg]
          )
        );
        if (isSameChatMessageList(local, merged)) return prev;
        return {
          ...prev,
          [meta.targetId]: merged,
        };
      });
    });
    const targetVisible =
      stepRef.current === 3 &&
      selectedAgentIdRef.current === meta.targetId &&
      document.visibilityState === "visible";
    if (!targetVisible) {
      setUnreadByAgent((prev) => ({ ...prev, [meta.targetId]: (prev[meta.targetId] || 0) + 1 }));
    } else {
      scrollChatViewportToBottom(24);
    }
  });

  const handleFix = async (type: "node" | "npm" | "git" | "openclaw") => {
    setFixing(type);
    setFixResult(null);
    try {
      if (type === "node") {
        const url = await invoke<string>("fix_node");
        await openUrl(url);
        setFixResult("已打开 Node.js 下载页面，请下载安装 LTS 版本后重新检测");
      } else if (type === "npm") {
        const result = await invoke<string>("fix_npm");
        setFixResult(result);
        await runEnvCheck();
      } else if (type === "git") {
        const url = await invoke<string>("fix_git");
        await openUrl(url);
        setFixResult("已打开 Git 下载页面，安装后重新检测。若安装失败并提示 spawn git，请先安装 Git。");
      } else {
        setStep(1);
        setFixResult("请在下一步「安装 OpenClaw」页面执行安装。");
      }
    } catch (e) {
      setFixResult(`修复失败: ${e}`);
    } finally {
      setFixing(null);
    }
  };

  const handleStart = async () => {
    if (starting) return;
    setStarting(true);
    const resolveStartTarget = (gateways: GatewayBinding[]) => {
      const targetAgentId =
        selectedAgentId ||
        agentsList?.agents?.find((a) => a.default)?.id ||
        agentsList?.agents?.[0]?.id ||
        "";
      const targetGatewayId =
        (targetAgentId ? getPreferredGatewayIdForAgent(targetAgentId) : undefined) ||
        (gateways.find((g) => g.enabled)?.gateway_id || gateways[0]?.gateway_id || "");
      const targetGatewayBinding =
        (targetAgentId
          ? gateways.find((g) => (g.agent_id || "").trim() === targetAgentId && g.gateway_id === targetGatewayId)
          : null) || gateways.find((g) => g.gateway_id === targetGatewayId) || null;
      return { targetAgentId, targetGatewayId, targetGatewayBinding };
    };

    let runtimeGateways = gatewayBindingsDraft || [];
    let { targetGatewayId, targetGatewayBinding } = resolveStartTarget(runtimeGateways);
    if (!targetGatewayId) {
      try {
        const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
        const liveGateways = await invoke<GatewayBinding[]>("list_gateway_instances", {
          customPath: cfgPath,
        });
        if ((liveGateways || []).length > 0) {
          runtimeGateways = liveGateways || [];
          applyGatewayBindingsSnapshot(runtimeGateways, { source: "live", refreshedAt: Date.now() });
          ({ targetGatewayId, targetGatewayBinding } = resolveStartTarget(runtimeGateways));
        }
      } catch {
        // ignore bootstrap refresh failure and fall back to existing empty-state hint
      }
    }
    if (!targetGatewayId) {
      setStarting(false);
      setStartResult(
        "当前还没有可启动的 Agent 网关。\n请先去调教中心 -> 渠道配置点一次“保存配置”，系统会为当前 Agent 生成网关。\n生成后再去聊天页或当前 Agent 配置页点击“启动当前 Agent 网关”，就可以直接网页对话和客户端对话。"
      );
      return;
    }
    const targetGatewayStatus = targetGatewayBinding?.health?.status || "";
    if (targetGatewayStatus === "ok") {
      setStarting(false);
      setStep(3);
      setStartResult(
        `当前 Agent 网关已在运行：${targetGatewayId}\n可以直接网页对话和客户端对话；如果刚改完配置，请点“重启当前 Agent 网关”。`
      );
      return;
    }
    setStartResult(`正在提交当前 Agent 网关启动：${targetGatewayId}`);
    try {
      await runGatewayAction("start", targetGatewayId);
      setStep(3);
      void waitForGatewayReady(targetGatewayId)
        .then((ready) => {
          setStarting(false);
          if (!ready) return;
          setStartResult((prev) => {
            const current = stripAnsi(String(prev || ""));
            if (/(已在运行|已启动|启动成功)/.test(current) && !/正在提交当前 Agent 网关启动/.test(current)) {
              return prev;
            }
            return `当前 Agent 网关已启动：${targetGatewayId}\n可以直接网页对话和客户端对话。`;
          });
        })
        .catch(() => {
          setStarting(false);
        });
    } catch (e) {
      setStartResult(stripAnsi(`启动失败: ${e}`));
      setStarting(false);
    }
  };

  const handleOpenBrowserChat = async () => {
    try {
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      const gatewayId = selectedAgentId ? getPreferredGatewayIdForAgent(selectedAgentId) : undefined;
      const gateway =
        (selectedAgentId
          ? gatewayBindingsDraft.find((g) => (g.agent_id || "").trim() === selectedAgentId && g.gateway_id === gatewayId)
          : null) || gatewayBindingsDraft.find((g) => g.gateway_id === gatewayId) || null;
      if (!gatewayId || gateway?.health?.status !== "ok") {
        setStartResult("当前 Agent 网关还没真正启动成功，请先点“启动当前 Agent 网关”并确认状态显示可用。");
        return;
      }
      const url = await invoke<string>("get_gateway_dashboard_url", { customPath: cfgPath, gatewayId });
      try {
        await openUrl(url);
      } catch {
        await invoke<string>("open_external_url", { url });
      }
    } catch (e) {
      setStartResult(`打开浏览器对话失败: ${e}`);
    }
  };

  const handleOpenCommunityLink = useCallback(async (url: string, successText: string) => {
    try {
      await openUrl(url);
      setCommunityActionResult(successText);
    } catch (e) {
      setCommunityActionResult(`打开失败: ${e}`);
    }
  }, []);

  const handleCopyCommunityText = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCommunityActionResult(`已复制${label}：${text}`);
    } catch {
      setCommunityActionResult(`复制失败，请手动复制${label}：${text}`);
    }
  }, []);

  const handleOpenTelegramCommunity = useCallback(async () => {
    const tgUrl = "tg://openmessage?chat_id=5292442705";
    try {
      await openUrl(tgUrl);
      setCommunityActionResult("已尝试打开 Telegram 群");
    } catch {
      try {
        await navigator.clipboard.writeText(tgUrl);
      } catch {}
      try {
        await openUrl("https://web.telegram.org/");
        setCommunityActionResult("当前环境不允许直接打开 tg:// 链接，已为你打开 Telegram Web，并复制群链接到剪贴板。");
      } catch (e) {
        setCommunityActionResult(`打开 Telegram 失败：${e}\n已尝试复制群链接：${tgUrl}`);
      }
    }
  }, []);

  const handleResetGatewayAuth = async () => {
    if (starting) return;
    setStarting(true);
    const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
    const installHint = (localInfo?.install_dir || customInstallPath || lastInstallDir || "").trim() || undefined;
    try {
      const result = await invoke<string>("reset_gateway_auth_and_restart", {
        customPath: cfgPath,
        installHint,
      });
      setStartResult(stripAnsi(result));
      setStep(3);
    } catch (e) {
      setStartResult(stripAnsi(`重置认证失败: ${e}`));
    } finally {
      setStarting(false);
    }
  };

  const handleAutoInstallPlugins = async () => {
    enqueueTask("渠道插件自动安装", async () => {
      if (pluginInstallLoading) return;
      setPluginInstallLoading(true);
      setPluginInstallResult(null);
      setPluginInstallProgress(null);
      pluginLogs.reset();
      try {
        const installHint = (localInfo?.install_dir || customInstallPath || lastInstallDir || "").trim() || undefined;
        const selectedChannels = Object.keys(pluginSelection).filter((k) => pluginSelection[k]);
        if (selectedChannels.length === 0) {
          setPluginInstallResult("请先勾选至少一个渠道，再执行安装/校验插件。");
          setPluginInstallLoading(false);
          return;
        }
        const result = await invoke<string>("auto_install_channel_plugins_background", {
          channels: selectedChannels,
          customPath: normalizeConfigPath(customConfigPath) || undefined,
          installHint,
        });
        setPluginInstallResult(result);
      } catch (e) {
        setPluginInstallResult(`自动安装插件失败: ${e}`);
        setPluginInstallLoading(false);
        setTicketSummary(makeTicketSummary("渠道插件自动安装", e, "auto_install_channel_plugins_background"));
        throw e;
      }
    });
  };

  const handleSkillsManage = async (action: "list" | "install" | "update" | "reinstall") => {
    if (skillsLoading) return;
    setSkillsLoading(true);
    setSkillsResult(null);
    try {
      const installHint = (localInfo?.install_dir || customInstallPath || lastInstallDir || "").trim() || undefined;
      const result = await invoke<string>("skills_manage_background", {
        action,
        customPath: normalizeConfigPath(customConfigPath) || undefined,
        installHint,
      });
      setSkillsResult(result);
    } catch (e) {
      setSkillsResult(`Skills 操作失败: ${e}`);
      setSkillsLoading(false);
    }
  };

  const loadSkillsCatalog = async (): Promise<SkillCatalogItem[]> => {
    if (skillsCatalogLoading) return skillsCatalog;
    setSkillsCatalogLoading(true);
    setSkillsResult(null);
    try {
      const installHint = (localInfo?.install_dir || customInstallPath || lastInstallDir || "").trim() || undefined;
      const list = await invoke<SkillCatalogItem[]>("list_skills_catalog", {
        customPath: normalizeConfigPath(customConfigPath) || undefined,
        installHint,
      });
      setSkillsCatalog(list || []);
      setSelectedSkills((prev) => {
        const next: Record<string, boolean> = {};
        for (const s of list || []) {
          next[s.name] = prev[s.name] ?? false;
        }
        return next;
      });
      return list || [];
    } catch (e) {
      setSkillsResult(`加载 Skills 列表失败: ${e}`);
      return [];
    } finally {
      setSkillsCatalogLoading(false);
    }
  };
  loadSkillsCatalogRef.current = loadSkillsCatalog;

  const persistAgentSkillBinding = useCallback(
    async (agentId: string, mode: "inherit" | "custom", enabledSkills: string[], message: string) => {
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      const resp = await invoke<AgentRuntimeSettingsPayload>("save_agent_skill_binding", {
        agentId,
        mode,
        enabledSkills,
        customPath: cfgPath,
      });
      setAgentRuntimeSettings(resp);
      setSkillsResult(message);
    },
    [customConfigPath]
  );
  persistAgentSkillBindingRef.current = persistAgentSkillBinding;

  const handleSaveSkillsScope = useCallback(
    async (nextScope: "shared" | "agent_override") => {
      if (skillsScopeSaving) return;
      setSkillsScopeSaving(true);
      setSkillsResult(null);
      try {
        const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
        const resp = await invoke<AgentRuntimeSettingsPayload>("save_skills_scope", {
          skillsScope: nextScope,
          customPath: cfgPath,
        });
        setAgentRuntimeSettings(resp);
        setSkillsResult(nextScope === "shared" ? "已切换为共享 Skills 模式" : "已切换为 Agent 覆盖模式");
      } catch (e) {
        setSkillsResult(`切换 Skills 作用域失败: ${e}`);
      } finally {
        setSkillsScopeSaving(false);
      }
    },
    [customConfigPath, skillsScopeSaving]
  );

  const handleRestoreAgentSkillInheritance = useCallback(async () => {
    if (!effectiveSkillsAgentId) return;
    setSkillsScopeSaving(true);
    try {
      await persistAgentSkillBinding(effectiveSkillsAgentId, "inherit", [], `已恢复 ${effectiveSkillsAgentId} 的共享继承`);
    } catch (e) {
      setSkillsResult(`恢复共享继承失败: ${e}`);
    } finally {
      setSkillsScopeSaving(false);
    }
  }, [effectiveSkillsAgentId, persistAgentSkillBinding]);

  const handleMakeAgentSkillCustom = useCallback(async () => {
    if (!effectiveSkillsAgentId) return;
    setSkillsScopeSaving(true);
    try {
      await persistAgentSkillBinding(
        effectiveSkillsAgentId,
        "custom",
        skillsCatalog.map((skill) => skill.name),
        `已为 ${effectiveSkillsAgentId} 创建独立 Skills 清单`
      );
    } catch (e) {
      setSkillsResult(`创建独立 Skills 清单失败: ${e}`);
    } finally {
      setSkillsScopeSaving(false);
    }
  }, [effectiveSkillsAgentId, persistAgentSkillBinding, skillsCatalog]);

  const handleToggleSkillForAgent = useCallback(
    async (skillName: string, enabled: boolean) => {
      if (!effectiveSkillsAgentId) return;
      if (currentSkillsScope !== "agent_override") {
        setSkillsResult("请先切到“Agent 覆盖”模式，再单独启用/禁用 Skills");
        return;
      }
      setSkillsScopeSaving(true);
      try {
        const baseSet =
          currentAgentSkillBinding?.mode === "custom"
            ? new Set(currentAgentSkillBinding.enabled_skills || [])
            : new Set(skillsCatalog.map((skill) => skill.name));
        if (enabled) baseSet.add(skillName);
        else baseSet.delete(skillName);
        await persistAgentSkillBinding(
          effectiveSkillsAgentId,
          "custom",
          Array.from(baseSet),
          `${effectiveSkillsAgentId} 已${enabled ? "启用" : "禁用"} ${skillName}`
        );
      } catch (e) {
        setSkillsResult(`更新 Agent Skills 清单失败: ${e}`);
      } finally {
        setSkillsScopeSaving(false);
      }
    },
    [currentAgentSkillBinding, currentSkillsScope, effectiveSkillsAgentId, persistAgentSkillBinding, skillsCatalog]
  );

  const handleSearchMarketSkills = useCallback(async () => {
    if (marketLoading) return;
    const query = marketQuery.trim();
    if (!query) {
      setMarketResult("请先输入要搜索的 skill 关键词");
      return;
    }
    setMarketLoading(true);
    setMarketResult(null);
    try {
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      const list = await invoke<SkillCatalogItem[]>("search_market_skills", {
        query,
        customPath: cfgPath,
        limit: 12,
      });
      setMarketResults(list || []);
      setMarketResult(`已找到 ${(list || []).length} 条第三方 Skills 结果`);
    } catch (e) {
      setMarketResult(`搜索第三方 Skills 失败: ${e}`);
      setMarketResults([]);
    } finally {
      setMarketLoading(false);
    }
  }, [customConfigPath, marketLoading, marketQuery]);

  const handleInstallMarketSkill = useCallback(
    async (skill: SkillCatalogItem, enableForCurrentAgent = false) => {
      const key = `${skill.source_type || "remote"}:${skill.package_name || skill.name}`;
      if (marketInstallKey) return;
      setMarketInstallKey(key);
      setSkillImportProgress(null);
      skillImportLogs.reset();
      pendingSkillImportRef.current = {
        kind: "market",
        key,
        enableForCurrentAgent,
        targetAgentId: effectiveSkillsAgentId || undefined,
        skillName: skill.package_name || skill.name,
        currentBindingMode: currentAgentSkillBinding?.mode,
        currentEnabledSkills: currentAgentSkillBinding?.enabled_skills || [],
      };
      setMarketResult(`正在安装 ${skill.name} 到共享 Skills 层...`);
      try {
        const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
        const result = await invoke<string>("install_market_skill_background", {
          sourceType: skill.source_type || "github",
          packageName: skill.package_name || skill.name,
          repoUrl: skill.repo_url || undefined,
          version: skill.version || undefined,
          customPath: cfgPath,
        });
        setMarketResult(result || `已切到后台安装 ${skill.name}`);
      } catch (e) {
        setMarketResult(`安装第三方 Skill 失败: ${e}`);
        setMarketInstallKey(null);
        pendingSkillImportRef.current = null;
      } finally {
      }
    },
    [customConfigPath, currentAgentSkillBinding, effectiveSkillsAgentId, marketInstallKey]
  );

  const handlePickLocalSkillFolder = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择本地 Skill 目录",
    });
    if (typeof selected === "string") {
      setLocalSkillPath(selected);
    }
  }, []);

  const handlePickLocalSkillZip = useCallback(async () => {
    const selected = await open({
      directory: false,
      multiple: false,
      title: "选择 Skill ZIP 压缩包",
      filters: [{ name: "ZIP", extensions: ["zip"] }],
    });
    if (typeof selected === "string") {
      setLocalSkillPath(selected);
    }
  }, []);

  const handleInstallLocalSkill = useCallback(async () => {
    if (localSkillInstalling) return;
    const path = localSkillPath.trim();
    if (!path) {
      setMarketResult("请先选择或粘贴本地 Skill 目录 / ZIP 路径");
      return;
    }
    setLocalSkillInstalling(true);
    setSkillImportProgress(null);
    skillImportLogs.reset();
    pendingSkillImportRef.current = {
      kind: "local",
      key: path,
    };
    setMarketResult("正在导入本地 Skill 到共享层...");
    try {
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      const result = await invoke<string>("install_local_skill_background", {
        localPath: path,
        customPath: cfgPath,
      });
      setMarketResult(result || "已切到后台导入本地 Skill");
    } catch (e) {
      setMarketResult(`导入本地 Skill 失败: ${e}`);
      setLocalSkillInstalling(false);
      pendingSkillImportRef.current = null;
    }
  }, [customConfigPath, localSkillInstalling, localSkillPath]);

  const handleInstallSelectedSkills = async () => {
    enqueueTask("安装选中Skills", async () => {
      if (skillsRepairLoading) return;
      const selected = Object.keys(selectedSkills).filter((k) => selectedSkills[k]);
      if (!selected.length) {
        setSkillsResult("请先勾选至少一个 skill");
        return;
      }
      setSkillsRepairLoading(true);
      setSkillsAction("install");
      setSkillsResult("安装任务已开始，请稍候...");
      setSkillsRepairProgress(null);
      skillsLogs.reset();
      try {
        const installHint = (localInfo?.install_dir || customInstallPath || lastInstallDir || "").trim() || undefined;
        const result = await invoke<string>("install_selected_skills_background", {
          skillNames: selected,
          customPath: normalizeConfigPath(customConfigPath) || undefined,
          installHint,
        });
        setSkillsResult(result || "安装任务已切到后台，请稍候...");
      } catch (e) {
        setSkillsResult(`安装失败: ${e}`);
        setSkillsRepairLoading(false);
        setSkillsAction(null);
        setTicketSummary(makeTicketSummary("安装选中Skills", e, "install_selected_skills_background"));
        throw e;
      }
    });
  };

  const handleRepairSelectedSkills = async () => {
    enqueueTask("修复选中Skills", async () => {
      if (skillsRepairLoading) return;
      const selected = Object.keys(selectedSkills).filter((k) => selectedSkills[k]);
      if (!selected.length) {
        setSkillsResult("请先勾选至少一个 skill");
        return;
      }
      setSkillsRepairLoading(true);
      setSkillsAction("repair");
      setSkillsResult("修复任务已开始，请稍候...");
      setSkillsRepairProgress(null);
      skillsLogs.reset();
      try {
        const installHint = (localInfo?.install_dir || customInstallPath || lastInstallDir || "").trim() || undefined;
        const result = await invoke<string>("repair_selected_skills_background", {
          skillNames: selected,
          customPath: normalizeConfigPath(customConfigPath) || undefined,
          installHint,
        });
        setSkillsResult(result || "修复任务已切到后台，请稍候...");
      } catch (e) {
        setSkillsResult(`修复失败: ${e}`);
        setSkillsRepairLoading(false);
        setSkillsAction(null);
        setTicketSummary(makeTicketSummary("修复选中Skills", e, "repair_selected_skills_background"));
        throw e;
      }
    });
  };

  const applyQuickModePreset = (mode: QuickMode) => {
    setQuickMode(mode);
    if (mode === "stable") {
      setProvider("openai");
      setBaseUrl(DEFAULT_OPENAI_BASE_URL);
      setSelectedModel("deepseek-ai/DeepSeek-V3");
      setMemoryMode("session");
      setTunePermission("confirm");
      setTuneProactivity("balanced");
    } else if (mode === "balanced") {
      setProvider("openai");
      setBaseUrl(DEFAULT_OPENAI_BASE_URL);
      setSelectedModel("Qwen/Qwen2.5-72B-Instruct");
      setMemoryMode("session");
      setTunePermission("confirm");
      setTuneProactivity("balanced");
    } else {
      setProvider("openai");
      setBaseUrl(DEFAULT_OPENAI_BASE_URL);
      setSelectedModel("deepseek-ai/DeepSeek-R1");
      setMemoryMode("long");
      setTunePermission("auto_low_risk");
      setTuneProactivity("high");
    }
    setSaveResult("已套用快速模式，请点击“保存配置”使模型设置生效。");
  };

  const applyScenarioPreset = (preset: ScenarioPreset) => {
    setScenarioPreset(preset);
    if (preset === "customer_support") {
      setTuneTone("friendly");
      setTuneLength("short");
      setTuneProactivity("low");
      setTunePermission("confirm");
    } else if (preset === "short_video") {
      setTuneTone("friendly");
      setTuneLength("medium");
      setTuneProactivity("high");
      setTunePermission("confirm");
    } else if (preset === "office") {
      setTuneTone("professional");
      setTuneLength("medium");
      setTuneProactivity("balanced");
      setTunePermission("confirm");
    } else if (preset === "developer") {
      setTuneTone("concise");
      setTuneLength("long");
      setTuneProactivity("balanced");
      setTunePermission("auto_low_risk");
    }
    setSkillsResult("已应用场景模板（行为偏好已更新）。");
  };

  const refreshAgentsList = useCallback(
    async (options?: { installHint?: string; cfgPath?: string; silent?: boolean }) => {
      if (!options?.silent) {
        setAgentsLoading(true);
        setAgentsError(null);
      }
      try {
        const cfgPath = normalizeConfigPath(options?.cfgPath || customConfigPath) || undefined;
        const installHint =
          options?.installHint ||
          (localInfo?.install_dir || customInstallPath || lastInstallDir || "").trim() ||
          undefined;
        const [local, resp] = await measureAsync(
          "frontend.refreshAgentsList",
          async () => {
            const localResult = await invoke<LocalOpenclawInfo>("get_local_openclaw", {
              installHint,
              customPath: cfgPath,
            });
            if (!localResult.installed) {
              return [localResult, null] as const;
            }
            const agentsResult = await invoke<AgentsListPayload>("read_agents_list", {
              customPath: cfgPath,
            });
            return [localResult, agentsResult] as const;
          },
          cfgPath || installHint || "default"
        );
        openclawRuntimeClearedRef.current = !local.installed ? openclawRuntimeClearedRef.current : false;
        setLocalInfo((prev) => {
          if (
            prev?.installed === local.installed &&
            prev?.install_dir === local.install_dir &&
            prev?.executable === local.executable &&
            prev?.version === local.version
          ) {
            return prev;
          }
          return local;
        });
        if (!local.installed || !resp) {
          if (!openclawRuntimeClearedRef.current) {
            clearOpenclawRuntimeState();
          }
          if (!options?.silent) {
            setAgentsError("未检测到本地 OpenClaw，Agent 列表已清空。");
          }
          return;
        }
        openclawRuntimeClearedRef.current = false;
        setAgentsList(resp);
        updateRuntimeDirtyFlags({ agentsDirty: false });
        for (const a of resp.agents || []) {
          chatSessionNameByAgentRef.current[a.id] =
            chatSessionModeRef.current === "synced" ? DEFAULT_SYNC_SESSION_NAME : DEFAULT_ISOLATED_SESSION_NAME;
        }
        const def = resp.agents.find((a) => a.default)?.id || resp.agents[0]?.id || "";
        setSelectedAgentId((prev) => prev || def);
        setUnreadByAgent((prev) => {
          const next = { ...prev };
          for (const a of resp.agents) {
            if (typeof next[a.id] !== "number") next[a.id] = 0;
          }
          return next;
        });
      } catch (e) {
        if (!options?.silent) {
          setAgentsError(String(e));
          setAgentsList(null);
        }
      } finally {
        if (!options?.silent) {
          setAgentsLoading(false);
        }
      }
    },
    [clearOpenclawRuntimeState, customConfigPath, customInstallPath, lastInstallDir, localInfo?.install_dir, updateRuntimeDirtyFlags]
  );

  const parseProviderAndModelFromPrimary = useCallback((primary?: string): { provider: string; model: string } => {
    const raw = (primary || "").trim();
    if (!raw) return { provider: "openai", model: RECOMMENDED_MODEL_FALLBACK };
    const [prefix, ...rest] = raw.split("/");
    if (rest.length === 0) {
      return { provider: "openai", model: raw };
    }
    const providerGuess = prefix === "anthropic" ? "anthropic" : "openai";
    return { provider: providerGuess, model: rest.join("/") };
  }, []);

  const summarizeGatewayHealthDetail = useCallback((detail?: string | null) => {
    const raw = String(detail || "").replace(/\s+/g, " ").trim();
    if (!raw) return "未探活";
    const lower = raw.toLowerCase();
    if (lower.includes("channel providers not verified")) {
      return lower.includes("status fallback")
        ? "端口已监听（状态回退，渠道未验证）"
        : "端口已监听（渠道未验证）";
    }
    if (raw.includes("Service: Scheduled Task")) return "运行中";
    if (raw.includes("running")) return "运行中";
    if (raw.includes("listening on")) return "端口已监听";
    if (raw.includes("未监听")) return "未启动";
    if (raw.includes("loopback-only")) return "仅本机可访问";
    return raw.length > 72 ? `${raw.slice(0, 72)}...` : raw;
  }, []);

  const getFocusedAgentIdForChannelPanel = useCallback(() => {
    return selectedAgentId || agentsList?.agents.find((a) => a.default)?.id || agentsList?.agents[0]?.id || "";
  }, [selectedAgentId, agentsList]);

  const applyAgentRuntimePayload = useCallback(
    (
      resp: AgentRuntimeSettingsPayload,
      agentsForFallback?: AgentListItem[],
      options?: {
        gatewaySource?: "snapshot" | "live" | "ignore";
        staticRefreshedAt?: number;
        gatewayRefreshedAt?: number;
        clearDirty?: Partial<RuntimeDirtyFlags>;
      }
    ) => {
      const nextRoutes = resp.channel_routes || [];
      const nextGateways = resp.gateways || [];
      const nextTelegramInstances = resp.telegram_instances || [];
      const nextChannelInstances = resp.channel_instances || [];
      const nextActiveChannelInstances = resp.active_channel_instances || {};
      const nextActiveTelegramInstance = resp.active_telegram_instance || "";
      const profiles = new Map((resp.profiles || []).map((p) => [p.agent_id, p]));
      const drafts: Record<string, { provider: string; model: string }> = {};
      const sourceAgents = agentsForFallback || agentsList?.agents || [];
      for (const a of sourceAgents) {
        const p = profiles.get(a.id);
        if (p) {
          drafts[a.id] = { provider: p.provider || "openai", model: p.model || RECOMMENDED_MODEL_FALLBACK };
        } else {
          drafts[a.id] = parseProviderAndModelFromPrimary(a.model);
        }
      }

      cancelIdleTask(deferredRuntimeAdvancedApplyTimerRef.current);
      const applyCoreRuntimeState = () => {
        setAgentRuntimeSettings((prev) => (isSameJsonShape(prev, resp) ? prev : resp));
        if (options?.gatewaySource !== "ignore") {
          applyGatewayBindingsSnapshot(nextGateways, {
            source: options?.gatewaySource || "snapshot",
            refreshedAt: options?.gatewayRefreshedAt,
          });
        }
        setTelegramInstancesDraft((prev) => (isSameJsonShape(prev, nextTelegramInstances) ? prev : nextTelegramInstances));
        setChannelInstancesDraft((prev) => (isSameJsonShape(prev, nextChannelInstances) ? prev : nextChannelInstances));
        setActiveChannelInstanceByChannel((prev) =>
          isSameJsonShape(prev, nextActiveChannelInstances) ? prev : nextActiveChannelInstances
        );
        setActiveTelegramInstanceId((prev) => (prev === nextActiveTelegramInstance ? prev : nextActiveTelegramInstance));
      };

      const applyAdvancedRuntimeState = () => {
        setChannelRoutesDraft((prev) => (isSameJsonShape(prev, nextRoutes) ? prev : nextRoutes));
        setTelegramUsernameByInstanceId((prev) => {
          const next: Record<string, string> = {};
          for (const it of nextTelegramInstances) {
            if (prev[it.id]) next[it.id] = prev[it.id];
          }
          return isSameJsonShape(prev, next) ? prev : next;
        });
        setAgentProfileDrafts((prev) => (isSameJsonShape(prev, drafts) ? prev : drafts));
      };

      const isAgentPage = step === 4 && tuningSection === "agents";
      const shouldDeferAdvancedState =
        !showAgentAdvancedSettings ||
        (isAgentPage && agentCenterTab === "channels" && !showAdvancedRouteRules);

      if (typeof options?.staticRefreshedAt === "number") {
        updateRuntimeFreshness({ staticSnapshotAt: options.staticRefreshedAt });
      }
      if (options?.clearDirty) {
        const nextDirtyPatch = Object.fromEntries(
          Object.entries(options.clearDirty)
            .filter(([, value]) => value === true)
            .map(([key]) => [key, false])
        ) as Partial<RuntimeDirtyFlags>;
        updateRuntimeDirtyFlags(nextDirtyPatch);
      }

      startTransition(() => {
        applyCoreRuntimeState();
      });

      if (!shouldDeferAdvancedState) {
        startTransition(() => {
          applyAdvancedRuntimeState();
        });
        return;
      }

      deferredRuntimeAdvancedApplyTimerRef.current = scheduleIdleTask(() => {
        startTransition(() => {
          applyAdvancedRuntimeState();
        });
        deferredRuntimeAdvancedApplyTimerRef.current = null;
      }, 180);
    },
    [
      agentCenterTab,
      agentsList?.agents,
      parseProviderAndModelFromPrimary,
      applyGatewayBindingsSnapshot,
      selectedAgentId,
      showAdvancedRouteRules,
      showAgentAdvancedSettings,
      step,
      tuningSection,
      updateRuntimeDirtyFlags,
      updateRuntimeFreshness,
    ]
  );

  const buildChannelPublishResult = useCallback(
    (channel: ChannelEditorChannel, gateways?: GatewayBinding[]) => {
      const focusedAgentId = getFocusedAgentIdForChannelPanel();
      const gatewayList = gateways || gatewayBindingsDraft || [];
      const currentGatewayBinding =
        gatewayList.find((g) => (g.agent_id || "").trim() === focusedAgentId && g.enabled !== false) ||
        gatewayList.find((g) => (g.agent_id || "").trim() === focusedAgentId) ||
        null;
      const gatewayStatus = currentGatewayBinding?.health?.status || "";
      const gatewayLooksRunning = gatewayStatus === "ok";
      const label = getChannelDisplayName(channel);
      if (!currentGatewayBinding?.gateway_id) {
        return `已保存 ${label} 配置，并接入当前 Agent。\n下一步：请去聊天页或当前 Agent 配置页启动当前 Agent 网关。启动成功后，就可以直接网页对话和客户端对话。`;
      }
      if (gatewayLooksRunning) {
        return `已保存 ${label} 配置，并更新到当前 Agent。\n检测到当前网关正在运行，请去聊天页或当前 Agent 配置页重启当前 Agent 网关后生效。`;
      }
      return `已保存 ${label} 配置，并更新到当前 Agent。\n当前网关未运行，请去聊天页或当前 Agent 配置页启动当前 Agent 网关。启动成功后即可直接网页对话和客户端对话。`;
    },
    [getFocusedAgentIdForChannelPanel, gatewayBindingsDraft, summarizeGatewayHealthDetail]
  );

  const formatOrderedChannelBindings = useCallback((binding?: Record<string, string>, fallback?: { channel?: string; instance_id?: string }) => {
    const order = ["local", "telegram", "qq", "feishu", "discord", "dingtalk"];
    const entries = Object.entries(binding || {}).filter(([, iid]) => String(iid || "").trim());
    if (entries.length === 0) {
      const ch = String(fallback?.channel || "").trim();
      const iid = String(fallback?.instance_id || "").trim();
      return ch && iid ? `${getChannelDisplayName(ch)}${ch === "local" ? "" : `: ${iid}`}` : "-";
    }
    return entries
      .sort((a, b) => {
        const ai = order.indexOf(a[0]);
        const bi = order.indexOf(b[0]);
        const av = ai >= 0 ? ai : 999;
        const bv = bi >= 0 ? bi : 999;
        return av - bv || a[0].localeCompare(b[0]);
      })
      .map(([ch, iid]) => `${getChannelDisplayName(ch)}${ch === "local" ? "" : `: ${iid}`}`)
      .join(" | ");
  }, []);

  const refreshGatewayInstances = useCallback(
    async (options?: { cfgPath?: string; silent?: boolean }) => {
      if (!options?.silent) {
        setGatewayRuntimeLoading(true);
      }
      try {
        const cfgPath = normalizeConfigPath(options?.cfgPath || customConfigPath) || undefined;
        const list = await measureAsync(
          "frontend.listGatewayInstances",
          async () =>
            invoke<GatewayBinding[]>("list_gateway_instances", {
              customPath: cfgPath,
            }),
          cfgPath || "default"
        );
        applyGatewayBindingsSnapshot(list || [], {
          source: "live",
          refreshedAt: Date.now(),
          clearDirty: {
            gatewayHealthDirty: true,
            channelLinkDirty: true,
          },
        });
        return list || [];
      } catch (e) {
        if (!options?.silent) {
          setAgentRuntimeResult(`刷新网关实例失败: ${e}`);
        }
        return null;
      } finally {
        if (!options?.silent) {
          setGatewayRuntimeLoading(false);
        }
      }
    },
    [applyGatewayBindingsSnapshot, customConfigPath]
  );

  const refreshAgentRuntimeSettings = useCallback(
    async (agentsForFallback?: AgentListItem[], options?: { probeLive?: boolean; cfgPath?: string; silent?: boolean }) => {
      if (!options?.silent) {
        setAgentRuntimeLoading(true);
      }
      const cfgPath = normalizeConfigPath(options?.cfgPath || customConfigPath) || undefined;
      const sourceAgents = agentsForFallback || agentsList?.agents || [];
      const requestKey = `${cfgPath || "default"}::${options?.probeLive ? "live" : "cached"}::${sourceAgents
        .map((item) => item.id)
        .join(",")}`;
      const existing = agentRuntimeRefreshInFlightRef.current.get(requestKey);
      if (existing) {
        try {
          await existing;
        } finally {
          if (!options?.silent) {
            setAgentRuntimeLoading(false);
          }
        }
        return;
      }
      const run = (async () => {
        try {
          const resp = await measureAsync(
            "frontend.refreshAgentRuntimeSettings",
            async () =>
              invoke<AgentRuntimeSettingsPayload>("read_agent_runtime_settings", {
                customPath: cfgPath,
              }),
            options?.probeLive ? `${cfgPath || "default"}::live` : cfgPath || "default"
          );
          const refreshedAt = Date.now();
          applyAgentRuntimePayload(resp, agentsForFallback, {
            gatewaySource: options?.probeLive ? "ignore" : "snapshot",
            staticRefreshedAt: refreshedAt,
            gatewayRefreshedAt: options?.probeLive ? undefined : refreshedAt,
            clearDirty: {
              runtimeConfigDirty: true,
              channelLinkDirty: !options?.probeLive,
            },
          });
          if (options?.probeLive) {
            await refreshGatewayInstances({ cfgPath, silent: true });
          }
        } catch (e) {
          setAgentRuntimeResult(`读取 Agent 运行时配置失败: ${e}`);
        } finally {
          agentRuntimeRefreshInFlightRef.current.delete(requestKey);
        }
      })();
      agentRuntimeRefreshInFlightRef.current.set(requestKey, run);
      try {
        await run;
      } finally {
        if (!options?.silent) {
          setAgentRuntimeLoading(false);
        }
      }
    },
    [agentsList?.agents, applyAgentRuntimePayload, customConfigPath, refreshGatewayInstances]
  );

  useEffect(() => {
    if (installing || uninstalling) return;
    if (step !== 3) return;
    const list = agentsList?.agents || [];
    if (list.length === 0) {
      startupAgentRuntimeRefreshKeyRef.current = "";
      return;
    }
    const cfgPath = normalizeConfigPath(customConfigPath) || "default";
    const nextKey = `${cfgPath}::${list.map((item) => item.id).join(",")}`;
    if (
      startupAgentRuntimeRefreshKeyRef.current === nextKey &&
      (agentRuntimeSettings || gatewayBindingsDraft.length > 0)
    ) {
      return;
    }
    startupAgentRuntimeRefreshKeyRef.current = nextKey;
    void refreshAgentRuntimeSettings(list, { probeLive: false });
  }, [
    agentsList?.agents,
    customConfigPath,
    installing,
    uninstalling,
    step,
    agentRuntimeSettings,
    gatewayBindingsDraft.length,
    refreshAgentRuntimeSettings,
  ]);

  useEffect(() => {
    cancelIdleTask(agentEntryRuntimeRefreshTimerRef.current);
    if (step !== 4 || tuningSection !== "agents") return;
    const list = agentsList?.agents || [];
    if (list.length === 0) {
      autoAgentRuntimeRefreshKeyRef.current = "";
      return;
    }
    if (agentRuntimeSettings) return;
    const cfgPath = normalizeConfigPath(customConfigPath) || "default";
    const nextKey = `${cfgPath}::snapshot::${list.map((item) => item.id).join(",")}`;
    if (autoAgentRuntimeRefreshKeyRef.current === nextKey) return;
    agentEntryRuntimeRefreshTimerRef.current = scheduleIdleTask(() => {
      if (!agentRuntimeSettings) {
        autoAgentRuntimeRefreshKeyRef.current = nextKey;
        void refreshAgentRuntimeSettings(list, { probeLive: false, silent: true });
      }
      agentEntryRuntimeRefreshTimerRef.current = null;
    }, 320);
    return () => {
      cancelIdleTask(agentEntryRuntimeRefreshTimerRef.current);
      agentEntryRuntimeRefreshTimerRef.current = null;
    };
  }, [
    step,
    tuningSection,
    agentsList?.agents,
    customConfigPath,
    refreshAgentRuntimeSettings,
    agentRuntimeSettings,
  ]);

  useEffect(() => {
    cancelIdleTask(startupAgentsPrewarmTimerRef.current);
    if (installing || uninstalling) return;
    if (!startupBootstrapDoneRef.current) return;
    if (localInfo && !localInfo.installed) return;
    if (agentsList?.agents?.length) return;
    const cfgPath = normalizeConfigPath(customConfigPath) || "default";
    if (startupAgentsPrewarmKeyRef.current === cfgPath) return;
    startupAgentsPrewarmTimerRef.current = scheduleIdleTask(() => {
      startupAgentsPrewarmKeyRef.current = cfgPath;
      void refreshAgentsList({ cfgPath, silent: true });
      startupAgentsPrewarmTimerRef.current = null;
    }, 1800);
    return () => {
      cancelIdleTask(startupAgentsPrewarmTimerRef.current);
      startupAgentsPrewarmTimerRef.current = null;
    };
  }, [agentsList?.agents?.length, customConfigPath, installing, localInfo?.installed, refreshAgentsList, uninstalling]);

  useEffect(() => {
    cancelIdleTask(startupRuntimePrewarmTimerRef.current);
    if (installing || uninstalling) return;
    if (!startupBootstrapDoneRef.current) return;
    const list = agentsList?.agents || [];
    if (list.length === 0) return;
    const cfgPath = normalizeConfigPath(customConfigPath) || "default";
    const nextKey = `${cfgPath}::${list.map((item) => item.id).join(",")}`;
    if (startupRuntimePrewarmKeyRef.current === nextKey) return;
    startupRuntimePrewarmTimerRef.current = scheduleIdleTask(() => {
      startupRuntimePrewarmKeyRef.current = nextKey;
      void refreshAgentRuntimeSettings(list, { cfgPath, probeLive: false, silent: true });
      void loadSavedChannels(cfgPath);
      startupRuntimePrewarmTimerRef.current = null;
    }, 2200);
    return () => {
      cancelIdleTask(startupRuntimePrewarmTimerRef.current);
      startupRuntimePrewarmTimerRef.current = null;
    };
  }, [agentsList?.agents, customConfigPath, installing, refreshAgentRuntimeSettings, uninstalling]);

  useEffect(() => {
    if (step === 4 && tuningSection === "agents" && agentCenterTab === "channels") {
      gatewayPageRefreshStartedAtRef.current = performance.now();
    } else {
      gatewayPageRefreshStartedAtRef.current = null;
    }
  }, [agentCenterTab, step, tuningSection, customConfigPath]);

  useEffect(() => {
    if (step !== 4 || tuningSection !== "agents" || agentCenterTab !== "channels") return;
    if (agentRuntimeLoading) return;
    if (gatewayPageRefreshStartedAtRef.current === null) return;
    recordPerfMetric(
      "baseline.gateway_page_refresh",
      performance.now() - gatewayPageRefreshStartedAtRef.current,
      `${gatewayBindingsDraft.length} gateways`
    );
    gatewayPageRefreshStartedAtRef.current = null;
  }, [agentCenterTab, agentRuntimeLoading, gatewayBindingsDraft.length, step, tuningSection]);

  useEffect(() => {
    if (skillsSelectedAgentId) return;
    const fallback = selectedAgentId || agentsList?.agents?.[0]?.id || "";
    if (fallback) setSkillsSelectedAgentId(fallback);
  }, [skillsSelectedAgentId, selectedAgentId, agentsList?.agents]);

  useEffect(() => {
    if (!agentsList?.agents) return;
    setAgentNameDrafts((prev) => {
      const next: Record<string, string> = {};
      for (const agent of agentsList.agents) {
        next[agent.id] = prev[agent.id] ?? agent.name ?? "";
      }
      return next;
    });
  }, [agentsList]);

  const refreshModelsForProvider = useCallback(
    async (providerName: string) => {
      const normalizedProvider = (providerName || "openai").trim() || "openai";
      setAgentModelsLoadingByProvider((prev) => ({ ...prev, [normalizedProvider]: true }));
      try {
        const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
        const models = await invoke<string[]>("discover_available_models", {
          provider: normalizedProvider,
          baseUrl: defaultBaseUrlForProvider(normalizedProvider),
          apiKey: apiKey.trim() || undefined,
          customPath: cfgPath,
        });
        const next = (models || []).filter((m) => !!m && m.trim().length > 0);
        setAgentModelsByProvider((prev) => ({ ...prev, [normalizedProvider]: next }));
        setAgentRuntimeResult(`已刷新 ${normalizedProvider} 模型 ${next.length} 个`);
      } catch (e) {
        setAgentRuntimeResult(`刷新模型失败（${normalizedProvider}）: ${e}`);
      } finally {
        setAgentModelsLoadingByProvider((prev) => ({ ...prev, [normalizedProvider]: false }));
      }
    },
    [customConfigPath, apiKey]
  );

  const saveAgentProfile = useCallback(
    async (agentId: string) => {
      const draft = agentProfileDrafts[agentId];
      if (!draft || !draft.provider || !draft.model) {
        setAgentRuntimeResult("请先选择 provider 与 model");
        return;
      }
      setAgentRuntimeSaving(true);
      setAgentRuntimeResult(null);
      try {
        updateRuntimeDirtyFlags({ runtimeConfigDirty: true });
        const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
        await invoke("upsert_agent_runtime_profile", {
          agentId,
          provider: draft.provider,
          model: draft.model,
          customPath: cfgPath,
        });
        await Promise.all([refreshAgentsList(), refreshAgentRuntimeSettings(undefined, { probeLive: false })]);
        setAgentRuntimeResult(`已保存 ${agentId} 的模型配置`);
      } catch (e) {
        setAgentRuntimeResult(`保存失败: ${e}`);
      } finally {
        setAgentRuntimeSaving(false);
      }
    },
    [agentProfileDrafts, customConfigPath, refreshAgentsList, refreshAgentRuntimeSettings, updateRuntimeDirtyFlags]
  );

  const saveChannelRoutes = useCallback(async () => {
    setAgentRuntimeSaving(true);
    setAgentRuntimeResult(null);
    try {
      updateRuntimeDirtyFlags({ runtimeConfigDirty: true, channelLinkDirty: true });
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      const cleaned = channelRoutesDraft.map((r) => ({
        ...r,
        channel: (r.channel || "").trim(),
        agent_id: (r.agent_id || "").trim(),
        gateway_id: (r.gateway_id || "").trim() || undefined,
        bot_instance: (r.bot_instance || "").trim() || undefined,
        account: (r.account || "").trim() || undefined,
        peer: (r.peer || "").trim() || undefined,
      }));
      await invoke("save_agent_channel_routes", {
        routes: cleaned,
        customPath: cfgPath,
      });
      await refreshAgentRuntimeSettings(undefined, { probeLive: false });
      setAgentRuntimeResult("渠道调阅路由已保存");
    } catch (e) {
      setAgentRuntimeResult(`保存渠道路由失败: ${e}`);
    } finally {
      setAgentRuntimeSaving(false);
    }
  }, [channelRoutesDraft, customConfigPath, refreshAgentRuntimeSettings, updateRuntimeDirtyFlags]);

  const parseGatewayChannelInstances = useCallback((input: unknown, fallbackChannel?: string, fallbackInstanceId?: string) => {
    const out: Record<string, string> = {};
    if (input && typeof input === "object") {
      for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
        const ch = (k || "").trim().toLowerCase();
        const iid = typeof v === "string" ? v.trim() : "";
        if (!ch || !iid) continue;
        out[ch] = iid;
      }
    }
    const fallbackCh = (fallbackChannel || "").trim().toLowerCase();
    const fallbackIid = (fallbackInstanceId || "").trim();
    if (fallbackCh && fallbackIid && Object.keys(out).length === 0) {
      out[fallbackCh] = fallbackIid;
    }
    return out;
  }, []);

  const parseGatewayChannelInstancesText = useCallback(
    (text: string, fallbackChannel?: string, fallbackInstanceId?: string): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const part of (text || "").split(",")) {
        const seg = part.trim();
        if (!seg) continue;
        const idx = seg.indexOf(":");
        if (idx <= 0) continue;
        const ch = seg.slice(0, idx).trim().toLowerCase();
        const iid = seg.slice(idx + 1).trim();
        if (!ch || !iid) continue;
        out[ch] = iid;
      }
      return parseGatewayChannelInstances(out, fallbackChannel, fallbackInstanceId);
    },
    [parseGatewayChannelInstances]
  );

  const stringifyGatewayChannelInstances = useCallback(
    (input: unknown, fallbackChannel?: string, fallbackInstanceId?: string): string =>
      Object.entries(parseGatewayChannelInstances(input, fallbackChannel, fallbackInstanceId))
        .map(([ch, iid]) => `${ch}:${iid}`)
        .join(","),
    [parseGatewayChannelInstances]
  );

  const getPreferredChannelEditorForAgent = useCallback(
    (agentId: string): ChannelEditorChannel => {
      const aid = (agentId || "").trim();
      if (!aid) return "telegram";
      const orderedChannels: ChannelEditorChannel[] = ["telegram", "qq", "feishu", "discord", "dingtalk"];
      const currentGatewayBinding =
        gatewayBindingsDraft.find((g) => (g.agent_id || "").trim() === aid && g.enabled !== false) ||
        gatewayBindingsDraft.find((g) => (g.agent_id || "").trim() === aid) ||
        null;
      const currentGatewayMap = parseGatewayChannelInstances(
        currentGatewayBinding?.channel_instances,
        currentGatewayBinding?.channel,
        currentGatewayBinding?.instance_id
      );
      for (const channel of orderedChannels) {
        const iid = (currentGatewayMap[channel] || "").trim();
        if (!iid) continue;
        if (channel === "telegram") {
          if (
            channelInstanceBelongsToAgent("telegram", iid, aid) &&
            (telegramInstancesDraft || []).some(
              (it) => (it.id || "").trim() === iid && it.enabled !== false && hasConfiguredTelegramDraftInstance(it)
            )
          ) {
            return "telegram";
          }
          continue;
        }
        if (
          channelInstanceBelongsToAgent(channel, iid, aid) &&
          (channelInstancesDraft || []).some(
            (it) =>
              (it.channel || "").trim().toLowerCase() === channel &&
              (it.id || "").trim() === iid &&
              it.enabled !== false &&
              hasConfiguredChannelDraftInstance(channel as NonTelegramChannel, it)
          )
        ) {
          return channel;
        }
      }
      if (
        (telegramInstancesDraft || []).some(
          (it) =>
            channelInstanceBelongsToAgent("telegram", it.id || "", aid) &&
            it.enabled !== false &&
            hasConfiguredTelegramDraftInstance(it)
        )
      ) {
        return "telegram";
      }
      for (const channel of orderedChannels.filter((ch) => ch !== "telegram")) {
        if (
          (channelInstancesDraft || []).some(
            (it) =>
              (it.channel || "").trim().toLowerCase() === channel &&
              channelInstanceBelongsToAgent(channel, it.id || "", aid) &&
              it.enabled !== false &&
              hasConfiguredChannelDraftInstance(channel as NonTelegramChannel, it)
          )
        ) {
          return channel;
        }
      }
      return "telegram";
    },
    [gatewayBindingsDraft, parseGatewayChannelInstances, telegramInstancesDraft, channelInstancesDraft]
  );

  useEffect(() => {
    if (step !== 4 || tuningSection !== "agents" || agentCenterTab !== "channels") return;
    const focusedAgentId = getFocusedAgentIdForChannelPanel();
    if (!focusedAgentId) return;
    if (lastChannelPanelAgentRef.current === focusedAgentId) return;
    const currentChannel = channelInstancesEditorChannel;
    const currentChannelLooksReady =
      currentChannel === "telegram"
        ? (telegramInstancesDraft || []).some(
            (it) =>
              channelInstanceBelongsToAgent("telegram", it.id || "", focusedAgentId) &&
              it.enabled !== false &&
              hasConfiguredTelegramDraftInstance(it)
          )
        : (channelInstancesDraft || []).some(
            (it) =>
              (it.channel || "").trim().toLowerCase() === currentChannel &&
              channelInstanceBelongsToAgent(currentChannel, it.id || "", focusedAgentId) &&
              it.enabled !== false &&
              hasConfiguredChannelDraftInstance(currentChannel as NonTelegramChannel, it)
          );
    lastChannelPanelAgentRef.current = focusedAgentId;
    if (currentChannelLooksReady) return;
    const nextChannel = getPreferredChannelEditorForAgent(focusedAgentId);
    setChannelInstancesEditorChannel((prev) => (prev === nextChannel ? prev : nextChannel));
  }, [
    step,
    tuningSection,
    agentCenterTab,
    channelInstancesDraft,
    channelInstancesEditorChannel,
    getFocusedAgentIdForChannelPanel,
    getPreferredChannelEditorForAgent,
    telegramInstancesDraft,
  ]);

  const buildCurrentActiveChannelInstanceMap = useCallback((): Record<string, string> => {
    const out: Record<string, string> = {};
    const tg = (activeTelegramInstanceId || "").trim();
    if (
      tg &&
      (telegramInstancesDraft || []).some(
        (it) => (it.id || "").trim() === tg && it.enabled !== false && hasConfiguredTelegramDraftInstance(it)
      )
    ) {
      out.telegram = tg;
    }
    for (const [ch, iid] of Object.entries(activeChannelInstanceByChannel || {})) {
      const chNorm = (ch || "").trim().toLowerCase();
      const iidNorm = (iid || "").trim();
      if (!chNorm || !iidNorm) continue;
      if (
        (channelInstancesDraft || []).some(
          (it) =>
            (it.channel || "").trim().toLowerCase() === chNorm &&
            (it.id || "").trim() === iidNorm &&
            it.enabled !== false &&
            hasConfiguredChannelDraftInstance(chNorm as NonTelegramChannel, it)
        )
      ) {
        out[chNorm] = iidNorm;
      }
    }
    return out;
  }, [activeTelegramInstanceId, activeChannelInstanceByChannel, telegramInstancesDraft, channelInstancesDraft]);

  const buildLocalOnlyGatewayBinding = useCallback(
    (agentId: string, old?: GatewayBinding): GatewayBinding => {
      const normalizedAgentId = (agentId || "").trim();
      const gatewaySafeId = normalizedAgentId.replace(/[ /\\:]+/g, "-");
      const localInstanceId = `local-${gatewaySafeId}`;
      return {
        gateway_id: old?.gateway_id || `gw-agent-${gatewaySafeId}`,
        agent_id: normalizedAgentId,
        channel: "local",
        instance_id: localInstanceId,
        channel_instances: { local: localInstanceId },
        enabled: old?.enabled ?? true,
        auto_restart: old?.auto_restart ?? true,
        state_dir: old?.state_dir,
        listen_port: old?.listen_port,
        pid: old?.pid,
        last_error: old?.last_error,
        health: old?.health,
      };
    },
    []
  );

  const buildChannelInstanceMapForAgent = useCallback(
    (agentId: string): Record<string, string> => {
      const base: Record<string, string> = {};
      const aid = (agentId || "").trim();
      if (!aid) return base;

      // 优先使用“路由里该 Agent 的 bot_instance”，避免多个网关抢同一个 Telegram token。
      for (const r of channelRoutesDraft || []) {
        if (!r.enabled) continue;
        if ((r.agent_id || "").trim() !== aid) continue;
        const ch = (r.channel || "").trim().toLowerCase();
        const iid = (r.bot_instance || "").trim();
        if (!ch || !iid) continue;
        if (
          ch === "telegram" &&
          (telegramInstancesDraft || []).some(
            (it) => (it.id || "").trim() === iid && it.enabled !== false && hasConfiguredTelegramDraftInstance(it)
          )
        ) {
          base[ch] = iid;
          continue;
        }
        if (
          ch !== "telegram" &&
          (channelInstancesDraft || []).some(
            (it) =>
              (it.channel || "").trim().toLowerCase() === ch &&
              (it.id || "").trim() === iid &&
              it.enabled !== false &&
              hasConfiguredChannelDraftInstance(ch as NonTelegramChannel, it)
          )
        ) {
          base[ch] = iid;
        }
      }

      // Telegram 兜底：常见命名 tg-<agentId>
      if (!base.telegram) {
        const fallbackTgId = `tg-${aid}`;
        if (
          (telegramInstancesDraft || []).some(
            (x) => (x.id || "").trim() === fallbackTgId && x.enabled !== false && hasConfiguredTelegramDraftInstance(x)
          )
        ) {
          base.telegram = fallbackTgId;
        }
      }

      // 非 Telegram 渠道兜底：按 `<channel>-<agentId>` 命名自动归属到对应 Agent。
      for (const row of channelInstancesDraft || []) {
        const ch = (row.channel || "").trim().toLowerCase();
        const iid = (row.id || "").trim();
        if (!ch || !iid || base[ch]) continue;
        if (!row.enabled) continue;
        if (iid === `${ch}-${aid}` && hasConfiguredChannelDraftInstance(ch as NonTelegramChannel, row)) {
          base[ch] = iid;
        }
      }

      const activeTelegramId = (activeTelegramInstanceId || "").trim();
      if (
        !base.telegram &&
        activeTelegramId &&
        channelInstanceBelongsToAgent("telegram", activeTelegramId, aid) &&
        (telegramInstancesDraft || []).some(
          (it) => (it.id || "").trim() === activeTelegramId && it.enabled !== false && hasConfiguredTelegramDraftInstance(it)
        )
      ) {
        base.telegram = activeTelegramId;
      }

      for (const [ch, iidRaw] of Object.entries(activeChannelInstanceByChannel || {})) {
        const chNorm = (ch || "").trim().toLowerCase();
        const iid = (iidRaw || "").trim();
        if (!chNorm || !iid || base[chNorm]) continue;
        if (!channelInstanceBelongsToAgent(chNorm, iid, aid)) continue;
        if (
          (channelInstancesDraft || []).some(
            (it) =>
              (it.channel || "").trim().toLowerCase() === chNorm &&
              (it.id || "").trim() === iid &&
              it.enabled !== false &&
              hasConfiguredChannelDraftInstance(chNorm as NonTelegramChannel, it)
          )
        ) {
          base[chNorm] = iid;
        }
      }
      return base;
    },
    [channelRoutesDraft, telegramInstancesDraft, channelInstancesDraft, activeTelegramInstanceId, activeChannelInstanceByChannel]
  );

  const buildAutoGatewayBindingsDraft = useCallback((existingDraft?: GatewayBinding[]) => {
    const agents = agentsList?.agents || [];
    const globalActiveMap = buildCurrentActiveChannelInstanceMap();
    if (agents.length === 0) return [];

    const existingByAgent = new Map<string, GatewayBinding[]>();
    for (const row of existingDraft || gatewayBindingsDraft || []) {
      const aid = (row.agent_id || "").trim();
      if (!aid) continue;
      if (!existingByAgent.has(aid)) existingByAgent.set(aid, []);
      existingByAgent.get(aid)!.push(row);
    }

    return agents.map((a) => {
      const channelMap = buildChannelInstanceMapForAgent(a.id);
      const old = (existingByAgent.get(a.id) || [])[0];
      if (Object.keys(globalActiveMap).length === 0) {
        return buildLocalOnlyGatewayBinding(a.id, old);
      }
      const channelKeys = Object.keys(channelMap);
      if (channelKeys.length === 0) {
        return buildLocalOnlyGatewayBinding(a.id, old);
      }
      const fallbackChannel =
        ((old?.channel || "").trim() && channelMap[(old?.channel || "").trim().toLowerCase()]
          ? (old?.channel || "").trim().toLowerCase()
          : channelKeys[0]) || "local";
      const fallbackInstance = channelMap[fallbackChannel] || channelMap.telegram || Object.values(channelMap)[0] || "";
      return {
        gateway_id: old?.gateway_id || `gw-agent-${a.id}`,
        agent_id: a.id,
        channel: fallbackChannel,
        instance_id: fallbackInstance,
        channel_instances: { ...channelMap },
        enabled: old?.enabled ?? true,
        auto_restart: old?.auto_restart ?? true,
        state_dir: old?.state_dir,
        listen_port: old?.listen_port,
        pid: old?.pid,
        last_error: old?.last_error,
        health: old?.health,
      };
    });
  }, [agentsList?.agents, buildCurrentActiveChannelInstanceMap, buildChannelInstanceMapForAgent, buildLocalOnlyGatewayBinding, gatewayBindingsDraft]);

  const persistGatewayBindingsDraft = useCallback(async (draft: GatewayBinding[]) => {
    const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
    const cleaned = (draft || []).map((g) => ({
      ...g,
      gateway_id: (g.gateway_id || "").trim(),
      agent_id: (g.agent_id || "").trim(),
      channel: (g.channel || "").trim(),
      instance_id: (g.instance_id || "").trim(),
      channel_instances: parseGatewayChannelInstances(g.channel_instances, g.channel, g.instance_id),
      state_dir: (g.state_dir || "").trim() || undefined,
      listen_port: Number.isFinite(Number(g.listen_port)) ? Number(g.listen_port) : undefined,
    }));
    return invoke<GatewayBinding[]>("save_gateway_bindings", {
      gateways: cleaned,
      customPath: cfgPath,
    });
  }, [customConfigPath, parseGatewayChannelInstances]);

  const generateGatewayBindingsByAgent = useCallback(() => {
    const next = buildAutoGatewayBindingsDraft();
    if (next.length === 0) {
      setAgentRuntimeResult("当前没有可自动生成的 Agent 网关。请先创建 Agent，或先保存一次渠道配置。");
      return;
    }
    setGatewayBindingsDraft(next);
    setAgentRuntimeResult(
      Object.keys(buildCurrentActiveChannelInstanceMap()).length === 0
        ? `已按 Agent 自动生成 ${next.length} 条网关：当前未选择外部激活实例，先为每个 Agent 生成本地对话网关。`
        : `已按 Agent 自动生成 ${next.length} 条网关：每个 Agent 一条，并自动挂上该 Agent 的多渠道配置。`
    );
  }, [buildAutoGatewayBindingsDraft, buildCurrentActiveChannelInstanceMap]);

  const saveGatewayBindings = useCallback(async () => {
    setAgentRuntimeSaving(true);
    setAgentRuntimeResult(null);
    try {
      updateRuntimeDirtyFlags({ runtimeConfigDirty: true, channelLinkDirty: true });
      const next = await persistGatewayBindingsDraft(gatewayBindingsDraft || []);
      const refreshedAt = Date.now();
      applyGatewayBindingsSnapshot(next || [], {
        source: "snapshot",
        refreshedAt: runtimeFreshness.gatewaySnapshotAt ?? refreshedAt,
        clearDirty: {
          runtimeConfigDirty: true,
          channelLinkDirty: true,
        },
      });
      updateRuntimeFreshness({ staticSnapshotAt: refreshedAt });
      setAgentRuntimeResult(`已保存网关绑定 ${next?.length || 0} 项`);
    } catch (e) {
      setAgentRuntimeResult(`保存网关绑定失败: ${e}`);
    } finally {
      setAgentRuntimeSaving(false);
    }
  }, [
    gatewayBindingsDraft,
    persistGatewayBindingsDraft,
    applyGatewayBindingsSnapshot,
    runtimeFreshness.gatewaySnapshotAt,
    updateRuntimeDirtyFlags,
    updateRuntimeFreshness,
  ]);
  const waitForGatewayReady = useCallback(
    async (gatewayId: string, timeoutMs = 30000, intervalMs = 1500) => {
      const gid = (gatewayId || "").trim();
      if (!gid) return false;
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        try {
          const list = await invoke<GatewayBinding[]>("list_gateway_instances", {
            customPath: cfgPath,
          });
          const row = (list || []).find((item) => item.gateway_id === gid) || null;
          if (row) {
            upsertGatewayBindingRow(row);
            if (row.health?.status === "ok") {
              return true;
            }
          }
        } catch {
          // Ignore transient polling failures and keep waiting for the next round.
        }
        await new Promise((resolve) => window.setTimeout(resolve, intervalMs));
      }
      return false;
    },
    [customConfigPath, upsertGatewayBindingRow]
  );
  useEffect(() => {
    const unlistenPromise = listen<GatewayBatchStartEvent>("gateway-batch-start-finished", (event) => {
      const payload = event.payload;
      if (!payload) return;
      setGatewayBatchLoading(null);
      setGatewayActionLoadingById((prev) =>
        Object.fromEntries(Object.keys(prev).map((key) => [key, false])) as Record<string, boolean>
      );
      setGatewayBatchProgress((prev) =>
        prev
          ? {
              ...prev,
              active: false,
              done: payload.succeeded !== undefined && payload.failed !== undefined ? payload.succeeded + payload.failed : prev.done,
              succeeded: payload.succeeded ?? prev.succeeded,
              failed: payload.failed ?? prev.failed,
              action: (payload.action === "restart" ? "restart" : prev.action),
            }
          : null
      );
      setAgentRuntimeResult(stripAnsi(payload.message || ""));
      if (payload.ok) {
        setStep(3);
      }
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  const runGatewayAction = useCallback(
    async (action: "start" | "stop" | "restart" | "health" | "logs", gatewayId: string) => {
      const gid = (gatewayId || "").trim();
      if (!gid) return;
      setGatewayActionLoadingById((prev) => ({ ...prev, [gid]: true }));
      if (action === "start" || action === "stop" || action === "restart" || action === "health") {
        updateRuntimeDirtyFlags({ gatewayHealthDirty: true });
      }
      if (action === "start" || action === "stop" || action === "restart") {
        const actionLabel = action === "start" ? "启动" : action === "stop" ? "停止" : "重启";
        setGatewayActionHintById((prev) => ({ ...prev, [gid]: `${actionLabel}请求已提交，等待后台回填...` }));
      }
      try {
        const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
        const installHint = (localInfo?.install_dir || customInstallPath || lastInstallDir || "").trim() || undefined;
        if (action === "start" || action === "stop" || action === "restart") {
          const msg = await invoke<string>("gateway_instance_action_background", {
            action,
            gatewayId: gid,
            customPath: cfgPath,
            installHint,
          });
          setAgentRuntimeResult(stripAnsi(msg));
          return;
        } else if (action === "health") {
          const row = await invoke<GatewayBinding>("health_gateway_instance", {
            gatewayId: gid,
            customPath: cfgPath,
          });
          upsertGatewayBindingRow(row);
          setGatewayActionHintById((prev) => ({
            ...prev,
            [gid]: `探活完成：${row.health?.status || "unknown"}${row.health?.detail ? ` · ${summarizeGatewayHealthDetail(row.health.detail)}` : ""}`,
          }));
          setAgentRuntimeResult(
            `网关 ${gid} 状态：${row.health?.status || "unknown"}${row.health?.detail ? `\n${row.health.detail}` : ""}`
          );
        } else {
          const logs = await invoke<string>("tail_gateway_logs", {
            gatewayId: gid,
            lines: 200,
            customPath: cfgPath,
          });
          setGatewayLogsById((prev) => ({ ...prev, [gid]: logs || "" }));
          setGatewayLogViewerId(gid);
        }
      } catch (e) {
        setAgentRuntimeResult(`网关操作失败(${action}/${gid}): ${e}`);
        setGatewayActionLoadingById((prev) => ({ ...prev, [gid]: false }));
      } finally {
        if (action === "health" || action === "logs") {
          setGatewayActionLoadingById((prev) => ({ ...prev, [gid]: false }));
        }
      }
    },
    [
      customConfigPath,
      localInfo?.install_dir,
      customInstallPath,
      lastInstallDir,
      summarizeGatewayHealthDetail,
      upsertGatewayBindingRow,
      updateRuntimeDirtyFlags,
    ]
  );

  const openGatewayLogWindow = useCallback(
    async (gatewayId: string) => {
      const gid = (gatewayId || "").trim();
      if (!gid) return;
      try {
        const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
        const msg = await invoke<string>("open_gateway_log_window", {
          gatewayId: gid,
          customPath: cfgPath,
        });
        setAgentRuntimeResult(msg);
      } catch (e) {
        setAgentRuntimeResult(`打开前台查看窗口失败: ${e}`);
      }
    },
    [customConfigPath]
  );

  const runStartAllEnabledGateways = useCallback(async () => {
    setGatewayBatchLoading("start");
    try {
      updateRuntimeDirtyFlags({ gatewayHealthDirty: true });
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      const latestBindings = await invoke<GatewayBinding[]>("list_gateway_instances", {
        customPath: cfgPath,
      });
      const latest = latestBindings || [];
      applyGatewayBindingsSnapshot(latest, { source: "live", refreshedAt: Date.now() });
      const enabled = latest.filter((g) => g.enabled);
      if (enabled.length === 0) {
        setGatewayBatchLoading(null);
        setGatewayBatchProgress(null);
        setAgentRuntimeResult("未找到启用中的网关。请先到调教中心确认已经生成网关，并且该网关没有被关闭。");
        return;
      }
      gatewayBatchSeenRef.current = {};
      setGatewayBatchProgress({
        action: "start",
        total: enabled.length,
        done: 0,
        succeeded: 0,
        failed: 0,
        active: true,
      });
      setGatewayActionLoadingById((prev) => ({
        ...prev,
        ...Object.fromEntries(enabled.map((g) => [g.gateway_id, true])),
      }));
      setGatewayActionHintById((prev) => ({
        ...prev,
        ...Object.fromEntries(enabled.map((g) => [g.gateway_id, "批量启动中，等待后台回填..."])),
      }));
      const telegramOwnerByInstance: Record<string, string[]> = {};
      for (const g of enabled) {
        const mapping = parseGatewayChannelInstances(g.channel_instances, g.channel, g.instance_id);
        const tg = (mapping.telegram || "").trim();
        if (!tg) continue;
        if (!telegramOwnerByInstance[tg]) telegramOwnerByInstance[tg] = [];
        telegramOwnerByInstance[tg].push(g.gateway_id);
      }
      const conflicts = Object.entries(telegramOwnerByInstance).filter(([, gids]) => gids.length > 1);
      if (conflicts.length > 0) {
        const detail = conflicts
          .map(([iid, gids]) => `Telegram 实例 ${iid} 被多个网关同时绑定: ${gids.join(", ")}`)
          .join("\n");
        setGatewayBatchLoading(null);
        setGatewayBatchProgress(null);
        setGatewayActionLoadingById((prev) => ({
          ...prev,
          ...Object.fromEntries(enabled.map((g) => [g.gateway_id, false])),
        }));
        setAgentRuntimeResult(`已拦截批量启动：检测到 Telegram 轮询冲突（会导致 409）。\n${detail}\n请先改为每个 Telegram 实例只被一个网关绑定。`);
        return;
      }
      const installHint = (localInfo?.install_dir || customInstallPath || lastInstallDir || "").trim() || undefined;
      const msg = await invoke<string>("start_all_enabled_gateways_background", {
        customPath: cfgPath,
        installHint,
      });
      setAgentRuntimeResult(`${msg}\n当前共提交 ${enabled.length} 个网关启动任务。`);
    } catch (e) {
      setGatewayBatchLoading(null);
      setGatewayBatchProgress(null);
      setAgentRuntimeResult(`批量启动失败: ${e}`);
    }
  }, [
    applyGatewayBindingsSnapshot,
    customConfigPath,
    localInfo?.install_dir,
    customInstallPath,
    lastInstallDir,
    parseGatewayChannelInstances,
    updateRuntimeDirtyFlags,
  ]);

  const runRestartAllEnabledGateways = useCallback(async () => {
    setGatewayBatchLoading("restart");
    try {
      updateRuntimeDirtyFlags({ gatewayHealthDirty: true });
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      const latestBindings = await invoke<GatewayBinding[]>("list_gateway_instances", {
        customPath: cfgPath,
      });
      const latest = latestBindings || [];
      applyGatewayBindingsSnapshot(latest, { source: "live", refreshedAt: Date.now() });
      const enabled = latest.filter((g) => g.enabled);
      if (enabled.length === 0) {
        setGatewayBatchLoading(null);
        setGatewayBatchProgress(null);
        setAgentRuntimeResult("未找到启用中的网关。请先到调教中心确认已经生成网关，并且该网关没有被关闭。");
        return;
      }
      gatewayBatchSeenRef.current = {};
      setGatewayBatchProgress({
        action: "restart",
        total: enabled.length,
        done: 0,
        succeeded: 0,
        failed: 0,
        active: true,
      });
      setGatewayActionLoadingById((prev) => ({
        ...prev,
        ...Object.fromEntries(enabled.map((g) => [g.gateway_id, true])),
      }));
      setGatewayActionHintById((prev) => ({
        ...prev,
        ...Object.fromEntries(enabled.map((g) => [g.gateway_id, "批量重启中，等待后台回填..."])),
      }));
      const telegramOwnerByInstance: Record<string, string[]> = {};
      for (const g of enabled) {
        const mapping = parseGatewayChannelInstances(g.channel_instances, g.channel, g.instance_id);
        const tg = (mapping.telegram || "").trim();
        if (!tg) continue;
        if (!telegramOwnerByInstance[tg]) telegramOwnerByInstance[tg] = [];
        telegramOwnerByInstance[tg].push(g.gateway_id);
      }
      const conflicts = Object.entries(telegramOwnerByInstance).filter(([, gids]) => gids.length > 1);
      if (conflicts.length > 0) {
        const detail = conflicts
          .map(([iid, gids]) => `Telegram 实例 ${iid} 被多个网关同时绑定: ${gids.join(", ")}`)
          .join("\n");
        setGatewayBatchLoading(null);
        setGatewayBatchProgress(null);
        setGatewayActionLoadingById((prev) => ({
          ...prev,
          ...Object.fromEntries(enabled.map((g) => [g.gateway_id, false])),
        }));
        setAgentRuntimeResult(`已拦截批量重启：检测到 Telegram 轮询冲突（会导致 409）。\n${detail}\n请先改为每个 Telegram 实例只被一个网关绑定。`);
        return;
      }
      const installHint = (localInfo?.install_dir || customInstallPath || lastInstallDir || "").trim() || undefined;
      const msg = await invoke<string>("restart_all_enabled_gateways_background", {
        customPath: cfgPath,
        installHint,
      });
      setAgentRuntimeResult(`${msg}\n当前共提交 ${enabled.length} 个网关重启任务。`);
    } catch (e) {
      setGatewayBatchLoading(null);
      setGatewayBatchProgress(null);
      setAgentRuntimeResult(`批量重启失败: ${e}`);
    }
  }, [
    applyGatewayBindingsSnapshot,
    customConfigPath,
    localInfo?.install_dir,
    customInstallPath,
    lastInstallDir,
    parseGatewayChannelInstances,
    updateRuntimeDirtyFlags,
  ]);

  const runHealthAllEnabledGateways = useCallback(async () => {
    setGatewayBatchLoading("health");
    try {
      updateRuntimeDirtyFlags({ gatewayHealthDirty: true });
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      const list = await invoke<GatewayBinding[]>("health_all_enabled_gateways", {
        customPath: cfgPath,
      });
      applyGatewayBindingsSnapshot(list || [], {
        source: "live",
        refreshedAt: Date.now(),
        clearDirty: {
          gatewayHealthDirty: true,
          channelLinkDirty: true,
        },
      });
      const ok = (list || []).filter((g) => g.health?.status === "ok").length;
      const portOnly = (list || []).filter((g) => isGatewayPortOnlyHealth(g.health)).length;
      setAgentRuntimeResult(
        `批量健康检查完成：ok ${ok} / total ${(list || []).length}${portOnly > 0 ? `；其中仅端口已监听 ${portOnly}` : ""}`
      );
    } catch (e) {
      setAgentRuntimeResult(`批量健康检查失败: ${e}`);
    } finally {
      setGatewayBatchLoading(null);
    }
  }, [applyGatewayBindingsSnapshot, customConfigPath, isGatewayPortOnlyHealth, updateRuntimeDirtyFlags]);

  const exportGatewayDiagnosticReport = useCallback(async () => {
    setGatewayBatchLoading("report");
    try {
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      const path = await invoke<string>("export_multi_gateway_diagnostic_report", {
        customPath: cfgPath,
      });
      setAgentRuntimeResult(`多网关诊断报告已导出：${path}`);
    } catch (e) {
      setAgentRuntimeResult(`导出多网关诊断报告失败: ${e}`);
    } finally {
      setGatewayBatchLoading(null);
    }
  }, [customConfigPath]);

  const persistTelegramInstancesDraft = useCallback(
    async (
      draft: TelegramBotInstance[],
      activeInstanceId: string,
      options?: { auto?: boolean; draftOnly?: boolean; suppressResult?: boolean }
    ) => {
      const isAutoSave = !!options?.auto;
      const forceDraftOnly = !!options?.draftOnly;
      const suppressResult = !!options?.suppressResult;
      if (isAutoSave) {
        setChannelInstanceAutosaveStateByChannel((prev) => ({ ...prev, telegram: "saving" }));
      } else {
        setAgentRuntimeSaving(true);
        setAgentRuntimeResult(null);
      }
      try {
        const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
        const cleaned = draft
          .map((it) => ({
            ...it,
            id: (it.id || "").trim(),
            name: (it.name || "").trim(),
            bot_token: (it.bot_token || "").trim(),
            chat_id: (it.chat_id || "").trim() || undefined,
          }))
          .filter((it) => it.id && it.bot_token);
        const resp = await invoke<AgentRuntimeSettingsPayload>("save_telegram_instances", {
          instances: cleaned,
          activeInstanceId: (activeInstanceId || "").trim() || undefined,
          draftOnly: isAutoSave || forceDraftOnly || undefined,
          customPath: cfgPath,
        });
        applyAgentRuntimePayload(resp, undefined, {
          gatewaySource: "snapshot",
          staticRefreshedAt: Date.now(),
          gatewayRefreshedAt: runtimeFreshness.gatewaySnapshotAt ?? Date.now(),
          clearDirty: {
            runtimeConfigDirty: true,
            channelLinkDirty: true,
          },
        });
        setChannelInstanceAutosaveStateByChannel((prev) => ({ ...prev, telegram: "saved" }));
        if (!suppressResult) {
          setAgentRuntimeResult(isAutoSave ? "Telegram 草稿已自动保存。点底部“保存配置”即可正式生效。" : "Telegram 配置已保存");
        }
        return resp;
      } catch (e) {
        setChannelInstanceAutosaveStateByChannel((prev) => ({ ...prev, telegram: "error" }));
        if (!suppressResult) {
          setAgentRuntimeResult(isAutoSave ? `自动保存 Telegram 草稿失败: ${e}` : `保存 Telegram 实例失败: ${e}`);
        }
        return null;
      } finally {
        if (!isAutoSave) setAgentRuntimeSaving(false);
      }
    },
    [applyAgentRuntimePayload, customConfigPath, runtimeFreshness.gatewaySnapshotAt]
  );

  const queueTelegramInstanceAutoSave = useCallback(
    (draft: TelegramBotInstance[], activeInstanceId: string) => {
      const timer = channelInstanceAutosaveTimerRef.current.telegram;
      if (timer) window.clearTimeout(timer);
      setChannelInstanceAutosaveStateByChannel((prev) => ({ ...prev, telegram: "saving" }));
      channelInstanceAutosaveTimerRef.current.telegram = window.setTimeout(() => {
        void persistTelegramInstancesDraft(draft, activeInstanceId, { auto: true });
      }, 800);
    },
    [persistTelegramInstancesDraft]
  );

  const buildTelegramPerAgentDraft = useCallback(() => {
    const agents = agentsList?.agents || [];
    if (agents.length === 0) {
      setAgentRuntimeResult("当前没有 Agent，无法生成按 Agent 的 Telegram 配置。");
      return;
    }
    const existingById = new Map(telegramInstancesDraft.map((x) => [x.id, x]));
    const nextInstances: TelegramBotInstance[] = agents.map((a) => {
      const iid = `tg-${a.id}`;
      const old = existingById.get(iid);
      return {
        id: iid,
        name: a.name || a.id,
        bot_token: old?.bot_token || "",
        chat_id: old?.chat_id || "",
        enabled: old?.enabled ?? true,
      };
    });

    const oldTelegramRoutes = channelRoutesDraft.filter((r) => r.channel === "telegram");
    const nonTelegramRoutes = channelRoutesDraft.filter((r) => r.channel !== "telegram");
    const nextTelegramRoutes: AgentChannelRoute[] = agents.map((a) => {
      const iid = `tg-${a.id}`;
      const old = oldTelegramRoutes.find((r) => (r.bot_instance || "") === iid && r.agent_id === a.id);
      return {
        id: old?.id || "",
        channel: "telegram",
        agent_id: a.id,
        bot_instance: iid,
        account: old?.account || "",
        peer: old?.peer || "",
        enabled: old?.enabled ?? true,
      };
    });

    const defaultAgent = agents.find((a) => a.default)?.id || agents[0].id;
    const defaultInstance = `tg-${defaultAgent}`;
    setTelegramInstancesDraft(nextInstances);
    setChannelRoutesDraft([...nonTelegramRoutes, ...nextTelegramRoutes]);
    setActiveTelegramInstanceId((prev) => prev || defaultInstance);
    setRouteTestChannel("telegram");
    setRouteTestBotInstance(defaultInstance);
    setAgentRuntimeResult("已按当前 Agent 自动生成 Telegram 配置项。请逐个填写 Token，确认后再点底部“保存配置”。");
  }, [agentsList, telegramInstancesDraft, channelRoutesDraft]);

  const runTelegramFirstSetupWizard = useCallback(async () => {
    if (telegramWizardRunning) return;
    const agents = agentsList?.agents || [];
    if (agents.length === 0) {
      setAgentRuntimeResult("向导失败：当前没有 Agent。");
      return;
    }
    setTelegramWizardRunning(true);
    setAgentRuntimeResult(null);
    try {
      // Step 1: 自动生成“每个 Agent 一个实例 + 对应路由”
      const existingById = new Map(telegramInstancesDraft.map((x) => [x.id, x]));
      const instances = agents.map((a) => {
        const iid = `tg-${a.id}`;
        const old = existingById.get(iid);
        return {
          id: iid,
          name: a.name || a.id,
          bot_token: (old?.bot_token || "").trim(),
          chat_id: (old?.chat_id || "").trim() || undefined,
          enabled: old?.enabled ?? true,
        };
      });
      const missing = instances.filter((x) => !x.bot_token).map((x) => x.id);
      if (missing.length > 0) {
        setTelegramInstancesDraft(instances.map((x) => ({ ...x, chat_id: x.chat_id || "" })));
        setAgentRuntimeResult(
          `向导第1步已生成实例，但这些实例缺少 Token：${missing.join(
            ", "
          )}\n请先填写后，再点“首次配置向导”。`
        );
        return;
      }
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      const defaultAgent = agents.find((a) => a.default)?.id || agents[0].id;
      const activeInstanceId = `tg-${defaultAgent}`;
      const saveResp = await invoke<AgentRuntimeSettingsPayload>("save_telegram_instances", {
        instances,
        activeInstanceId,
        customPath: cfgPath,
      });
      applyAgentRuntimePayload(saveResp, undefined, {
        gatewaySource: "snapshot",
        staticRefreshedAt: Date.now(),
        gatewayRefreshedAt: runtimeFreshness.gatewaySnapshotAt ?? Date.now(),
        clearDirty: {
          runtimeConfigDirty: true,
          channelLinkDirty: true,
        },
      });

      // Step 2: 应用实例到网关
      await invoke<string>("apply_telegram_instance", {
        instanceId: saveResp.active_telegram_instance || activeInstanceId,
        customPath: cfgPath,
      });

      // Step 3: 保存路由（每个 agent 对应一个 bot_instance）
      const routes: AgentChannelRoute[] = agents.map((a) => ({
        id: "",
        channel: "telegram",
        agent_id: a.id,
        bot_instance: `tg-${a.id}`,
        account: "",
        peer: "",
        enabled: true,
      }));
      const nonTelegram = channelRoutesDraft.filter((r) => r.channel !== "telegram");
      const merged = [...nonTelegram, ...routes];
      await invoke("save_agent_channel_routes", {
        routes: merged,
        customPath: cfgPath,
      });
      setChannelRoutesDraft(merged);

      // Step 4: 命中测试
      const testResp = await invoke<AgentRouteResolveResult>("resolve_agent_channel_route", {
        channel: "telegram",
        botInstance: `tg-${defaultAgent}`,
        fallbackAgent: defaultAgent,
        customPath: cfgPath,
      });
      setRouteTestChannel("telegram");
      setRouteTestBotInstance(`tg-${defaultAgent}`);
      setRouteTestResult(
        `命中 Agent: ${testResp.agent_id}${testResp.matched_route_id ? `（路由ID: ${testResp.matched_route_id}）` : ""}\n${
          testResp.detail
        }`
      );
      const telegramGatewayDraft = buildAutoGatewayBindingsDraft(saveResp.gateways || gatewayBindingsDraft);
      setAgentRuntimeResult(buildChannelPublishResult("telegram", telegramGatewayDraft));
    } catch (e) {
      setAgentRuntimeResult(`首次配置向导失败: ${e}`);
    } finally {
      setTelegramWizardRunning(false);
    }
  }, [applyAgentRuntimePayload, telegramWizardRunning, agentsList, telegramInstancesDraft, customConfigPath, channelRoutesDraft]);

  const testTelegramInstancesBatch = useCallback(async () => {
    setTelegramBatchTesting(true);
    try {
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      const result = await invoke<string>("test_telegram_instances_background", {
        customPath: cfgPath,
      });
      setAgentRuntimeResult(result || "已切到后台批量检查 Telegram 实例");
    } catch (e) {
      setAgentRuntimeResult(`批量 getMe 检查失败: ${e}`);
      setTelegramBatchTesting(false);
    }
  }, [customConfigPath]);

  const getChannelInstanceIdsByChannel = useCallback(
    (channel: string): string[] => {
      const ch = (channel || "").trim().toLowerCase();
      if (ch === "telegram") {
        return telegramInstancesDraft.map((it) => it.id).filter(Boolean);
      }
      return channelInstancesDraft
        .filter((it) => (it.channel || "").trim().toLowerCase() === ch)
        .map((it) => it.id)
        .filter(Boolean);
    },
    [telegramInstancesDraft, channelInstancesDraft]
  );

  const channelEditorCredential1Label = useMemo(() => {
    if (channelInstancesEditorChannel === "telegram") return "botToken";
    if (channelInstancesEditorChannel === "feishu") return "appId";
    if (channelInstancesEditorChannel === "dingtalk") return "appKey";
    if (channelInstancesEditorChannel === "qq") return "appId";
    return "token";
  }, [channelInstancesEditorChannel]);

  const channelEditorCredential2Label = useMemo(() => {
    if (channelInstancesEditorChannel === "feishu") return "appSecret";
    if (channelInstancesEditorChannel === "dingtalk") return "appSecret";
    if (channelInstancesEditorChannel === "qq") return "appSecret";
    return "";
  }, [channelInstancesEditorChannel]);

  const hasRequiredChannelCredentials = useCallback((channel: NonTelegramChannel, row: ChannelBotInstance): boolean => {
    return hasConfiguredChannelDraftInstance(channel, row);
  }, []);

  const buildChannelPerAgentDraft = useCallback(
    (channel: NonTelegramChannel) => {
      const agents = agentsList?.agents || [];
      if (agents.length === 0) {
        setAgentRuntimeResult("当前没有 Agent，无法生成渠道实例。");
        return;
      }
      const oldById = new Map(
        channelInstancesDraft
          .filter((x) => (x.channel || "").trim().toLowerCase() === channel)
          .map((x) => [x.id, x])
      );
      const nextInstances: ChannelBotInstance[] = agents.map((a) => {
        const iid = `${channel}-${a.id}`;
        const old = oldById.get(iid);
        return {
          id: iid,
          name: a.name || a.id,
          channel,
          credential1: old?.credential1 || "",
          credential2: old?.credential2 || "",
          chat_id: old?.chat_id || "",
          enabled: old?.enabled ?? true,
        };
      });
      setChannelInstancesDraft((prev) => [
        ...prev.filter((x) => (x.channel || "").trim().toLowerCase() !== channel),
        ...nextInstances,
      ]);

      const oldRoutes = channelRoutesDraft.filter((r) => (r.channel || "").trim().toLowerCase() === channel);
      const nonTargetRoutes = channelRoutesDraft.filter((r) => (r.channel || "").trim().toLowerCase() !== channel);
      const nextRoutes: AgentChannelRoute[] = agents.map((a) => {
        const iid = `${channel}-${a.id}`;
        const old = oldRoutes.find((r) => (r.bot_instance || "") === iid && r.agent_id === a.id);
        return {
          id: old?.id || "",
          channel,
          agent_id: a.id,
          bot_instance: iid,
          account: old?.account || "",
          peer: old?.peer || "",
          enabled: old?.enabled ?? true,
        };
      });
      setChannelRoutesDraft([...nonTargetRoutes, ...nextRoutes]);

      const defaultAgent = agents.find((a) => a.default)?.id || agents[0].id;
      const defaultInstanceId = `${channel}-${defaultAgent}`;
      setActiveChannelInstanceByChannel((prev) => ({
        ...prev,
        [channel]: prev[channel] || defaultInstanceId,
      }));
      setRouteTestChannel(channel);
      setRouteTestBotInstance(defaultInstanceId);
      setAgentRuntimeResult(`已按 Agent 自动生成 ${getChannelDisplayName(channel)} 配置项，请填写凭据后点“保存配置”。`);
    },
    [agentsList, channelInstancesDraft, channelRoutesDraft]
  );

  const persistChannelInstancesDraft = useCallback(
    async (
      channel: NonTelegramChannel,
      draft: ChannelBotInstance[],
      activeMap: Record<string, string>,
      options?: { auto?: boolean; draftOnly?: boolean; suppressResult?: boolean }
    ) => {
      const isAutoSave = !!options?.auto;
      const forceDraftOnly = !!options?.draftOnly;
      const suppressResult = !!options?.suppressResult;
      if (isAutoSave) {
        setChannelInstanceAutosaveStateByChannel((prev) => ({ ...prev, [channel]: "saving" }));
      } else {
        setAgentRuntimeSaving(true);
        setAgentRuntimeResult(null);
      }
      try {
        const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
        const cleaned = draft
          .filter((x) => (x.channel || "").trim().toLowerCase() === channel)
          .map((it) => ({
            ...it,
            id: (it.id || "").trim(),
            name: (it.name || "").trim(),
            channel,
            credential1: (it.credential1 || "").trim(),
            credential2: (it.credential2 || "").trim() || undefined,
            chat_id: (it.chat_id || "").trim() || undefined,
          }))
          .filter((it) => it.id);
        const resp = await invoke<AgentRuntimeSettingsPayload>("save_channel_instances", {
          channel,
          instances: cleaned,
          activeInstanceId: (activeMap[channel] || "").trim() || undefined,
          draftOnly: isAutoSave || forceDraftOnly || undefined,
          customPath: cfgPath,
        });
        applyAgentRuntimePayload(resp, undefined, {
          gatewaySource: "snapshot",
          staticRefreshedAt: Date.now(),
          gatewayRefreshedAt: runtimeFreshness.gatewaySnapshotAt ?? Date.now(),
          clearDirty: {
            runtimeConfigDirty: true,
            channelLinkDirty: true,
          },
        });
        setChannelInstanceAutosaveStateByChannel((prev) => ({ ...prev, [channel]: "saved" }));
        if (!suppressResult) {
          setAgentRuntimeResult(
            isAutoSave ? `${getChannelDisplayName(channel)} 草稿已自动保存。点底部“保存配置”即可正式生效。` : `${getChannelDisplayName(channel)} 配置已保存`
          );
        }
        return resp;
      } catch (e) {
        setChannelInstanceAutosaveStateByChannel((prev) => ({ ...prev, [channel]: "error" }));
        if (!suppressResult) {
          setAgentRuntimeResult(isAutoSave ? `自动保存 ${channel} 草稿失败: ${e}` : `保存 ${channel} 实例池失败: ${e}`);
        }
        return null;
      } finally {
        if (!isAutoSave) setAgentRuntimeSaving(false);
      }
    },
    [applyAgentRuntimePayload, customConfigPath, runtimeFreshness.gatewaySnapshotAt]
  );

  const queueChannelInstanceAutoSave = useCallback(
    (channel: NonTelegramChannel, draft: ChannelBotInstance[], activeMap: Record<string, string>) => {
      const timer = channelInstanceAutosaveTimerRef.current[channel];
      if (timer) window.clearTimeout(timer);
      setChannelInstanceAutosaveStateByChannel((prev) => ({ ...prev, [channel]: "saving" }));
      channelInstanceAutosaveTimerRef.current[channel] = window.setTimeout(() => {
        void persistChannelInstancesDraft(channel, draft, activeMap, { auto: true });
      }, 800);
    },
    [persistChannelInstancesDraft]
  );

  useEffect(
    () => () => {
      Object.values(channelInstanceAutosaveTimerRef.current).forEach((timer) => {
        if (timer) window.clearTimeout(timer);
      });
    },
    []
  );

  const updateAgentScopedChannelDraft = useCallback(
    (
      channel: NonTelegramChannel,
      instanceId: string,
      agentName: string,
      updater: (current: ChannelBotInstance) => ChannelBotInstance
    ) => {
      setChannelInstancesDraft((prev) => {
        const next = [...prev];
        const idx = next.findIndex((x) => x.channel === channel && x.id === instanceId);
        const current =
          idx >= 0
            ? next[idx]
            : ({
                id: instanceId,
                name: agentName,
                channel,
                credential1: "",
                credential2: "",
                chat_id: "",
                enabled: true,
              } as ChannelBotInstance);
        next[idx >= 0 ? idx : next.length] = updater(current);
        setChannelInstanceAutosaveStateByChannel((prev) =>
          prev[channel] === "idle" ? prev : { ...prev, [channel]: "idle" }
        );
        return next;
      });
    },
    []
  );

  const updateAgentScopedTelegramDraft = useCallback(
    (instanceId: string, agentName: string, updater: (current: TelegramBotInstance) => TelegramBotInstance) => {
      setTelegramInstancesDraft((prev) => {
        const next = [...prev];
        const idx = next.findIndex((x) => x.id === instanceId);
        const current =
          idx >= 0
            ? next[idx]
            : ({
                id: instanceId,
                name: agentName,
                bot_token: "",
                chat_id: "",
                enabled: true,
              } as TelegramBotInstance);
        next[idx >= 0 ? idx : next.length] = updater(current);
        setChannelInstanceAutosaveStateByChannel((prev) =>
          prev.telegram === "idle" ? prev : { ...prev, telegram: "idle" }
        );
        return next;
      });
    },
    []
  );

  const saveCurrentAgentGatewaySetup = useCallback(async () => {
    const focusedAgentId = getFocusedAgentIdForChannelPanel();
    if (!focusedAgentId) {
      setAgentRuntimeResult("请先选择一个 Agent，再保存配置。");
      return;
    }
    setAgentRuntimeSaving(true);
    setAgentRuntimeResult(null);
    setAgentsActionResult(null);
    try {
      updateRuntimeDirtyFlags({ runtimeConfigDirty: true, channelLinkDirty: true });
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      const cleanedTelegram = (telegramInstancesDraft || [])
        .map((it) => ({
          ...it,
          id: (it.id || "").trim(),
          name: (it.name || "").trim(),
          bot_token: (it.bot_token || "").trim(),
          chat_id: (it.chat_id || "").trim() || undefined,
        }))
        .filter((it) => it.id);
      await invoke<AgentRuntimeSettingsPayload>("save_telegram_instances", {
        instances: cleanedTelegram,
        draftOnly: true,
        customPath: cfgPath,
      });
      for (const channel of ["feishu", "dingtalk", "discord", "qq"] as NonTelegramChannel[]) {
        const cleanedInstances = (channelInstancesDraft || [])
          .filter((it) => (it.channel || "").trim().toLowerCase() === channel)
          .map((it) => ({
            ...it,
            id: (it.id || "").trim(),
            name: (it.name || "").trim(),
            channel,
            credential1: (it.credential1 || "").trim(),
            credential2: (it.credential2 || "").trim() || undefined,
            chat_id: (it.chat_id || "").trim() || undefined,
          }))
          .filter((it) => it.id);
        await invoke<AgentRuntimeSettingsPayload>("save_channel_instances", {
          channel,
          instances: cleanedInstances,
          draftOnly: true,
          customPath: cfgPath,
        });
      }

      const nextDraft = buildAutoGatewayBindingsDraft(gatewayBindingsDraft);
      applyGatewayBindingsSnapshot(nextDraft, { source: "snapshot" });
      const savedGateways = await persistGatewayBindingsDraft(nextDraft);
      const gatewayList = savedGateways || nextDraft;
      const refreshedAt = Date.now();
      applyGatewayBindingsSnapshot(gatewayList, {
        source: "snapshot",
        refreshedAt: runtimeFreshness.gatewaySnapshotAt ?? refreshedAt,
        clearDirty: {
          runtimeConfigDirty: true,
          channelLinkDirty: true,
        },
      });
      updateRuntimeFreshness({ staticSnapshotAt: refreshedAt });
      await refreshAgentsList();
      await refreshAgentRuntimeSettings(undefined, { probeLive: false });

      const savedCurrentGateway =
        gatewayList.find((g) => (g.agent_id || "").trim() === focusedAgentId && g.enabled !== false) ||
        gatewayList.find((g) => (g.agent_id || "").trim() === focusedAgentId) ||
        null;
      const channelMap = parseGatewayChannelInstances(
        savedCurrentGateway?.channel_instances,
        savedCurrentGateway?.channel,
        savedCurrentGateway?.instance_id
      );
      const externalChannels = Object.keys(channelMap).filter((ch) => ch !== "local");
      const gatewayStatus = savedCurrentGateway?.health?.status || "";
      const gatewayLooksRunning = gatewayStatus === "ok";
      const savedCount = new Set(gatewayList.map((g) => (g.agent_id || "").trim()).filter(Boolean)).size;
      setChannelInstanceAutosaveStateByChannel((prev) => ({
        ...prev,
        telegram: "saved",
        qq: "saved",
        feishu: "saved",
        discord: "saved",
        dingtalk: "saved",
      }));
      setAgentRuntimeResult(
        externalChannels.length > 0
          ? gatewayLooksRunning
            ? `已保存 ${savedCount} 个 Agent；当前 Agent 已接入 ${externalChannels.map((ch) => getChannelDisplayName(ch)).join(" / ")}。\n当前网关正在运行，请去重启当前 Agent 网关后生效。`
            : `已保存 ${savedCount} 个 Agent；当前 Agent 已接入 ${externalChannels.map((ch) => getChannelDisplayName(ch)).join(" / ")}。\n下一步：去启动当前 Agent 网关，启动后即可网页对话和客户端对话。`
          : gatewayLooksRunning
            ? `已保存 ${savedCount} 个 Agent；当前 Agent 已保留本地对话网关。\n当前网关正在运行；如果刚改完配置，可去重启当前 Agent 网关。`
            : `已保存 ${savedCount} 个 Agent；当前 Agent 已生成本地对话网关。\n下一步：去启动当前 Agent 网关，启动后即可网页对话和客户端对话。`
      );
    } catch (e) {
      setAgentRuntimeResult(`保存 Agent 配置失败: ${e}`);
    } finally {
      setAgentRuntimeSaving(false);
    }
  }, [
    getFocusedAgentIdForChannelPanel,
    customConfigPath,
    telegramInstancesDraft,
    channelInstancesDraft,
    buildAutoGatewayBindingsDraft,
    gatewayBindingsDraft,
    persistGatewayBindingsDraft,
    applyGatewayBindingsSnapshot,
    refreshAgentsList,
    refreshAgentRuntimeSettings,
    parseGatewayChannelInstances,
    summarizeGatewayHealthDetail,
    runtimeFreshness.gatewaySnapshotAt,
    updateRuntimeDirtyFlags,
    updateRuntimeFreshness,
  ]);

  const saveAndApplyTelegramSetup = useCallback(async () => {
    await saveCurrentAgentGatewaySetup();
  }, [saveCurrentAgentGatewaySetup]);

  const saveAndApplyChannelSetup = useCallback(async (channel: NonTelegramChannel) => {
    void channel;
    await saveCurrentAgentGatewaySetup();
  }, [saveCurrentAgentGatewaySetup]);

  const testChannelInstancesBatch = useCallback(
    async (channel: NonTelegramChannel) => {
      setChannelBatchTestingByChannel((prev) => ({ ...prev, [channel]: true }));
      try {
        const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
        const result = await invoke<string>("test_channel_instances_background", {
          channel,
          customPath: cfgPath,
        });
        setAgentRuntimeResult(result || `已切到后台批量检查 ${channel} 实例`);
      } catch (e) {
        setAgentRuntimeResult(`${channel} 批量检测失败: ${e}`);
        setChannelBatchTestingByChannel((prev) => ({ ...prev, [channel]: false }));
      }
    },
    [customConfigPath]
  );

  const testSingleChannelInstance = useCallback(
    async (channel: NonTelegramChannel, instanceId: string) => {
      if (!instanceId) return;
      setChannelSingleTestingByInstanceId((prev) => ({ ...prev, [`${channel}:${instanceId}`]: true }));
      try {
        const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
        const r = await invoke<ChannelInstanceHealth>("test_single_channel_instance", {
          channel,
          instanceId,
          customPath: cfgPath,
        });
        setAgentRuntimeResult(`${r.ok ? "✅" : "❌"} ${r.channel}/${r.id} - ${r.detail}`);
      } catch (e) {
        const err = String(e);
        const hint =
          err.includes("未找到")
            ? "\n💡 建议：请先点底部“保存配置”，让当前草稿真正写入配置后再检测。"
            : 
          err.includes("401") || err.includes("Unauthorized") || err.includes("invalid")
            ? "\n💡 建议：请检查 AppID / AppSecret 是否正确；QQ 会自动拼成 AppID:AppSecret。"
            : err.includes("network") || err.includes("timeout")
              ? "\n💡 建议：请检查网络连接。"
              : "\n💡 建议：请检查凭据是否完整、格式是否正确。";
        setAgentRuntimeResult(`❌ 单实例检测失败(${channel}/${instanceId}): ${err}${hint}`);
      } finally {
        setChannelSingleTestingByInstanceId((prev) => ({ ...prev, [`${channel}:${instanceId}`]: false }));
      }
    },
    [customConfigPath]
  );

  const runChannelFirstSetupWizard = useCallback(
    async (channel: NonTelegramChannel) => {
      if (channelWizardRunningByChannel[channel]) return;
      const agents = agentsList?.agents || [];
      if (agents.length === 0) {
        setAgentRuntimeResult("向导失败：当前没有 Agent。");
        return;
      }
      setChannelWizardRunningByChannel((prev) => ({ ...prev, [channel]: true }));
      setAgentRuntimeResult(null);
      try {
        const oldById = new Map(
          channelInstancesDraft
            .filter((x) => (x.channel || "").trim().toLowerCase() === channel)
            .map((x) => [x.id, x])
        );
        const instances: ChannelBotInstance[] = agents.map((a) => {
          const iid = `${channel}-${a.id}`;
          const old = oldById.get(iid);
          return {
            id: iid,
            name: a.name || a.id,
            channel,
            credential1: (old?.credential1 || "").trim(),
            credential2: (old?.credential2 || "").trim() || undefined,
            chat_id: (old?.chat_id || "").trim() || undefined,
            enabled: old?.enabled ?? true,
          };
        });
        const missing = instances.filter((x) => !hasRequiredChannelCredentials(channel, x)).map((x) => x.id);
        if (missing.length > 0) {
          setChannelInstancesDraft((prev) => [
            ...prev.filter((x) => (x.channel || "").trim().toLowerCase() !== channel),
            ...instances.map((x) => ({ ...x, credential2: x.credential2 || "", chat_id: x.chat_id || "" })),
          ]);
          setAgentRuntimeResult(
            `向导第1步已生成 ${channel} 实例，但这些实例缺少必填凭据：${missing.join(
              ", "
            )}\n请先填写后，再点“首次配置向导”。`
          );
          return;
        }
        const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
        const defaultAgent = agents.find((a) => a.default)?.id || agents[0].id;
        const activeInstanceId = `${channel}-${defaultAgent}`;
        const saveResp = await invoke<AgentRuntimeSettingsPayload>("save_channel_instances", {
          channel,
          instances,
          activeInstanceId,
          customPath: cfgPath,
        });
        setAgentRuntimeSettings(saveResp);
        setChannelInstancesDraft(saveResp.channel_instances || []);
        setActiveChannelInstanceByChannel(saveResp.active_channel_instances || {});
        setChannelRoutesDraft(saveResp.channel_routes || []);

        await invoke<string>("apply_channel_instance", {
          channel,
          instanceId: saveResp.active_channel_instances?.[channel] || activeInstanceId,
          customPath: cfgPath,
        });

        const routes: AgentChannelRoute[] = agents.map((a) => ({
          id: "",
          channel,
          agent_id: a.id,
          bot_instance: `${channel}-${a.id}`,
          account: "",
          peer: "",
          enabled: true,
        }));
        const nonTarget = channelRoutesDraft.filter((r) => (r.channel || "").trim().toLowerCase() !== channel);
        const merged = [...nonTarget, ...routes];
        await invoke("save_agent_channel_routes", {
          routes: merged,
          customPath: cfgPath,
        });
        setChannelRoutesDraft(merged);

        const testResp = await invoke<AgentRouteResolveResult>("resolve_agent_channel_route", {
          channel,
          botInstance: `${channel}-${defaultAgent}`,
          fallbackAgent: defaultAgent,
          customPath: cfgPath,
        });
        setRouteTestChannel(channel);
        setRouteTestBotInstance(`${channel}-${defaultAgent}`);
        setRouteTestResult(
          `命中 Agent: ${testResp.agent_id}${testResp.matched_route_id ? `（路由ID: ${testResp.matched_route_id}）` : ""}\n${
            testResp.detail
          }`
        );
        const channelGatewayDraft = buildAutoGatewayBindingsDraft(saveResp.gateways || gatewayBindingsDraft);
        setAgentRuntimeResult(buildChannelPublishResult(channel, channelGatewayDraft));
      } catch (e) {
        setAgentRuntimeResult(`${channel} 首次配置向导失败: ${e}`);
      } finally {
        setChannelWizardRunningByChannel((prev) => ({ ...prev, [channel]: false }));
      }
    },
    [
      channelWizardRunningByChannel,
      agentsList,
      channelInstancesDraft,
      hasRequiredChannelCredentials,
      customConfigPath,
      channelRoutesDraft,
    ]
  );

  const cleanupBrowserSessionsForTelegramBindings = useCallback(async () => {
    setTelegramSessionCleanupRunning(true);
    setAgentRuntimeResult(null);
    try {
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      const result = await invoke<string>("cleanup_browser_sessions_for_telegram_bindings", {
        customPath: cfgPath,
      });
      setAgentRuntimeResult(`${result}\n如浏览器对话页已打开，请刷新页面后查看会话列表。`);
    } catch (e) {
      setAgentRuntimeResult(`清理浏览器会话失败: ${e}`);
    } finally {
      setTelegramSessionCleanupRunning(false);
    }
  }, [customConfigPath]);

  const testSingleTelegramInstance = useCallback(
    async (instanceId: string) => {
      if (!instanceId) return;
      setTelegramSingleTestingByInstanceId((prev) => ({ ...prev, [instanceId]: true }));
      try {
        const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
        const r = await invoke<TelegramInstanceHealth>("test_single_telegram_instance", {
          instanceId,
          customPath: cfgPath,
        });
        const uname = (r.username || "").trim();
        if (uname) {
          setTelegramUsernameByInstanceId((prev) => ({ ...prev, [instanceId]: uname }));
        }
        setAgentRuntimeResult(
          `${r.ok ? "✅" : "❌"} ${r.id}${uname ? ` (@${uname})` : ""} - ${r.detail}`
        );
      } catch (e) {
        const err = String(e);
        const hint =
          err.includes("401") || err.includes("Unauthorized")
            ? "\n💡 建议：请检查 Token 是否正确，是否从 @BotFather 获取。"
            : err.includes("404") || err.includes("not found")
              ? "\n💡 建议：Token 格式可能错误，请确认复制完整。"
              : err.includes("network") || err.includes("timeout") || err.includes("fetch")
                ? "\n💡 建议：请检查网络连接，或配置代理后重试。"
                : "\n💡 建议：请检查 Token 是否正确、网络是否可达。";
        setAgentRuntimeResult(`❌ 单实例检测失败(${instanceId}): ${err}${hint}`);
      } finally {
        setTelegramSingleTestingByInstanceId((prev) => ({ ...prev, [instanceId]: false }));
      }
    },
    [customConfigPath]
  );

  const testChannelRoute = useCallback(async () => {
    setRouteTesting(true);
    setRouteTestResult(null);
    try {
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      const fallback = agentsList?.agents?.find((a) => a.default)?.id || agentsList?.agents?.[0]?.id || "main";
      const resp = await invoke<AgentRouteResolveResult>("resolve_agent_channel_route", {
        channel: routeTestChannel,
        gatewayId: gatewaySelectedIdForRouteTest.trim() || undefined,
        botInstance: routeTestBotInstance.trim() || undefined,
        account: routeTestAccount.trim() || undefined,
        peer: routeTestPeer.trim() || undefined,
        fallbackAgent: fallback,
        customPath: cfgPath,
      });
      setRouteTestResult(
        `命中 Agent: ${resp.agent_id}${resp.gateway_id ? ` · 网关:${resp.gateway_id}` : ""}${
          resp.matched_route_id ? `（路由ID: ${resp.matched_route_id}）` : "（默认回退）"
        }\n${resp.detail}`
      );
    } catch (e) {
      setRouteTestResult(`测试失败: ${e}`);
    } finally {
      setRouteTesting(false);
    }
  }, [customConfigPath, agentsList, gatewaySelectedIdForRouteTest, routeTestChannel, routeTestBotInstance, routeTestAccount, routeTestPeer]);

  const getAgentSpecialty = useCallback((agentId: string): "代码" | "表格" | "通用" => {
    const id = agentId.toLowerCase();
    if (id.includes("code") || id.includes("dev")) return "代码";
    if (id.includes("sheet") || id.includes("excel") || id.includes("table")) return "表格";
    return "通用";
  }, []);

  const handleRenameAgent = useCallback(
    async (agentId: string) => {
      const nextName = (agentNameDrafts[agentId] || "").trim();
      const currentName = (agentsList?.agents.find((a) => a.id === agentId)?.name || "").trim();
      if (!nextName) {
        setAgentsActionResult("Agent 名称不能为空。");
        return;
      }
      if (nextName === currentName) {
        setAgentsActionResult("名称未变化，无需保存。");
        return;
      }
      setRenamingAgentId(agentId);
      setAgentsActionResult(null);
      try {
        updateRuntimeDirtyFlags({ agentsDirty: true });
        await invoke("rename_agent", {
          id: agentId,
          name: nextName,
          customPath: normalizeConfigPath(customConfigPath) || undefined,
        });
        await refreshAgentsList();
        setAgentsActionResult(`已更新 ${agentId} 的名称`);
      } catch (e) {
        setAgentsActionResult(`保存名称失败: ${e}`);
      } finally {
        setRenamingAgentId((prev) => (prev === agentId ? null : prev));
      }
    },
    [agentNameDrafts, agentsList, customConfigPath, refreshAgentsList, updateRuntimeDirtyFlags]
  );

  const chatGatewayOptionsByAgent = useMemo(() => {
    if (!isChatPage) return {};
    const map: Record<string, GatewayBinding[]> = {};
    for (const g of gatewayBindingsDraft || []) {
      if (!g.enabled) continue;
      const aid = (g.agent_id || "").trim();
      if (!aid) continue;
      if (!map[aid]) map[aid] = [];
      map[aid].push(g);
    }
    return map;
  }, [gatewayBindingsDraft, isChatPage]);

  const enabledGatewaysByAgent = useMemo(() => {
    const map: Record<string, GatewayBinding[]> = {};
    for (const g of gatewayBindingsDraft || []) {
      if (!g.enabled) continue;
      const aid = (g.agent_id || "").trim();
      if (!aid) continue;
      const channelMap = parseGatewayChannelInstances(g.channel_instances, g.channel, g.instance_id);
      if (Object.keys(channelMap).length === 0) continue;
      if (!map[aid]) map[aid] = [];
      map[aid].push(g);
    }
    return map;
  }, [gatewayBindingsDraft, parseGatewayChannelInstances]);

  const getPreferredGatewayIdForAgent = useCallback(
    (agentId: string): string | undefined => {
      const sourceMap = isChatPage ? chatGatewayOptionsByAgent : enabledGatewaysByAgent;
      const list = sourceMap[agentId] || [];
      if (list.length === 0) return undefined;
      const preferred = (preferredGatewayByAgent[agentId] || "").trim();
      if (preferred && list.some((g) => g.gateway_id === preferred)) return preferred;
      return list[0]?.gateway_id;
    },
    [chatGatewayOptionsByAgent, enabledGatewaysByAgent, isChatPage, preferredGatewayByAgent]
  );

  const resolveTargetAgent = useCallback((draft: string): { targetId: string; normalizedText: string; hint: string | null } => {
    const text = draft.trim();
    if (!agentsList?.agents?.length) return { targetId: selectedAgentId, normalizedText: text, hint: null };

    const atMatch = text.match(/^@([a-zA-Z0-9_-]+)\s+(.*)$/s);
    if (atMatch) {
      const target = atMatch[1];
      const normalizedText = atMatch[2].trim();
      const found = agentsList.agents.find((a) => a.id === target);
      if (found) {
        return { targetId: found.id, normalizedText, hint: `手动路由 -> ${found.id}` };
      }
    }

    if (routeMode === "auto") {
      const lower = text.toLowerCase();
      const looksSheet =
        lower.includes("excel") ||
        lower.includes("表格") ||
        lower.includes("透视") ||
        lower.includes("公式") ||
        lower.includes("csv");
      if (looksSheet) {
        const sheet = agentsList.agents.find((a) => getAgentSpecialty(a.id) === "表格");
        if (sheet) {
          return { targetId: sheet.id, normalizedText: text, hint: `自动路由 -> ${sheet.id}` };
        }
      }
    }
    return { targetId: selectedAgentId, normalizedText: text, hint: null };
  }, [agentsList, selectedAgentId, routeMode, getAgentSpecialty]);

  const getOrCreateChatSessionName = useCallback((agentId: string) => {
    const existing = chatSessionNameByAgentRef.current[agentId];
    if (existing) return existing;
    const next = chatSessionModeRef.current === "synced" ? DEFAULT_SYNC_SESSION_NAME : DEFAULT_ISOLATED_SESSION_NAME;
    chatSessionNameByAgentRef.current[agentId] = next;
    return next;
  }, []);

  const loadAgentHistory = async (agentId: string, options?: { silent?: boolean; force?: boolean }) => {
    if (!agentId) return;
    const force = !!options?.force;
    if (!force && chatHistorySuppressedByAgent[agentId]) return;
    const silent = !!options?.silent;
    if (!silent) {
      setChatLoading(true);
      setChatError(null);
    }
    try {
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      const sessionName = getOrCreateChatSessionName(agentId);
      const gatewayId = getPreferredGatewayIdForAgent(agentId);
      const resp = await invoke<{ session_key: string; messages: ChatUiMessage[] }>("chat_list_history", {
        agentId,
        sessionName,
        gatewayId,
        customPath: cfgPath,
        preferGatewayDir: chatSessionModeRef.current === "synced",
      });
      const nextMessages = trimChatMessagesForUi((resp.messages || []).map((m) => ({ ...m, status: "sent" as const })));
      chatCursorByAgentRef.current[agentId] = nextMessages.length;
      startTransition(() => {
        markChatPreviewDirty(agentId);
        setMessagesByAgent((prev) => {
          const current = prev[agentId] || [];
          if (isSameChatMessageList(current, nextMessages)) return prev;
          return {
            ...prev,
            [agentId]: nextMessages,
          };
        });
      });
      setChatHistoryLoadedByAgent((prev) => (prev[agentId] ? prev : { ...prev, [agentId]: true }));
      setChatHistorySuppressedByAgent((prev) => (!prev[agentId] ? prev : { ...prev, [agentId]: false }));
      setUnreadByAgent((prev) => {
        if ((prev[agentId] || 0) === 0) return prev;
        return { ...prev, [agentId]: 0 };
      });
    } catch (e) {
      if (!silent) setChatError(String(e));
    } finally {
      if (!silent) setChatLoading(false);
    }
  };

  const loadAgentHistoryDelta = async (agentId: string, options?: { silent?: boolean; force?: boolean }) => {
    if (!agentId) return;
    const force = !!options?.force;
    if (!force && chatHistorySuppressedByAgent[agentId]) return;
    const silent = !!options?.silent;
    try {
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      const sessionName = getOrCreateChatSessionName(agentId);
      const gatewayId = getPreferredGatewayIdForAgent(agentId);
      const cursor = chatCursorByAgentRef.current[agentId] || 0;
      const resp = await measureAsync(
        "frontend.loadAgentHistoryDelta",
        async () =>
          invoke<{ session_key: string; cursor: number; messages: ChatUiMessage[] }>("chat_list_history_delta", {
            agentId,
            sessionName,
            cursor,
            gatewayId,
            customPath: cfgPath,
            preferGatewayDir: chatSessionModeRef.current === "synced",
            limit: 24,
          }),
        `${agentId}:${cursor}`
      );
      const delta = (resp.messages || []).map((m) => ({ ...m, status: "sent" as const }));
      chatCursorByAgentRef.current[agentId] = resp.cursor || cursor;
      if (delta.length === 0) return;
      startTransition(() => {
        markChatPreviewDirty(agentId);
        setMessagesByAgent((prev) => {
          const current = prev[agentId] || [];
          const merged = trimChatMessagesForUi(appendDeltaUniqueMessages(current, delta));
          if (isSameChatMessageList(current, merged)) return prev;
          return {
            ...prev,
            [agentId]: merged,
          };
        });
      });
    } catch (e) {
      if (!silent) setChatError(String(e));
    }
  };

  const ensureAgentSpecialtyIdentity = async (agentId: string) => {
    if (!agentId) return;
    const specialty = getAgentSpecialty(agentId);
    if (agentIdentitySyncedRef.current[agentId] === specialty) return;
    const identity =
      specialty === "代码"
        ? `# 代码专家（${agentId}）

- 角色：资深工程助手
- 擅长：代码实现、调试、重构、脚本自动化
- 风格：先给可执行方案，再解释原因
`
        : specialty === "表格"
        ? `# 表格专家（${agentId}）

- 角色：数据与表格分析助手
- 擅长：Excel/CSV 清洗、公式设计、透视分析、报表结论
- 风格：结构化步骤 + 可复用模板
`
        : `# 通用助手（${agentId}）

- 角色：通用工作助手
- 风格：清晰、简洁、结果导向
`;
    try {
      await invoke("write_workspace_file", {
        agentId,
        relativePath: "IDENTITY.md",
        content: identity,
        customPath: normalizeConfigPath(customConfigPath) || undefined,
      });
      agentIdentitySyncedRef.current[agentId] = specialty;
    } catch {
      // ignore identity write error, not blocking chat
    }
  };

  const handleSelectAgentForChat = useCallback(
    async (agentId: string) => {
      const nextStickBottom = chatStickBottomByAgentRef.current[agentId] ?? true;
      startTransition(() => {
        setSelectedAgentId((prev) => (prev === agentId ? prev : agentId));
        setSelectedChatStickBottom(nextStickBottom);
        setChatError(null);
      });
      setUnreadByAgent((prev) => {
        if ((prev[agentId] || 0) === 0) return prev;
        return { ...prev, [agentId]: 0 };
      });
      if (nextStickBottom) {
        scheduleIdleTask(() => {
          scrollChatViewportToBottom(18);
        }, 800);
      }
      // 切换 Agent 时只切本地聊天框，不再自动查远端历史。
    },
    [scrollChatViewportToBottom]
  );

  const handleLoadSelectedChatHistory = useCallback(async () => {
    if (!selectedAgentId) return;
    await loadAgentHistory(selectedAgentId, { force: true });
  }, [selectedAgentId, loadAgentHistory]);

  const startBackgroundReplyWait = useCallback(
    async (
      meta: PendingChatRequestMeta,
      args: {
        agentId: string;
        sessionName: string;
        gatewayId?: string;
        customPath?: string;
        preferGatewayDir: boolean;
        afterCursor: number;
      }
    ) => {
      pendingChatRequestsRef.current[meta.requestId] = meta;
      pendingChatRequestIdByAgentRef.current[meta.targetId] = meta.requestId;
      await invoke<string>("chat_wait_for_reply_background", {
        requestId: meta.requestId,
        agentId: args.agentId,
        sessionName: args.sessionName,
        gatewayId: args.gatewayId,
        customPath: args.customPath,
        preferGatewayDir: args.preferGatewayDir,
        afterCursor: args.afterCursor,
      });
    },
    []
  );

  const handleSendChat = useCallback(async (draftText: string): Promise<boolean> => {
    markChatInteracting(1500);
    const raw = draftText.trim();
    if (!raw) return false;
    const { targetId, normalizedText, hint } = resolveTargetAgent(raw);
    if (!targetId || !normalizedText) return false;
    if (chatSendingByAgent[targetId] || chatSendLockByAgentRef.current[targetId]) {
      setRouteHint(`${targetId} 正在等待上一条回复，请稍后再发。`);
      return false;
    }
    const dedupText = normalizeChatText(normalizedText);
    const lastSent = lastSentFingerprintRef.current[targetId];
    if (lastSent && lastSent.text === dedupText && Date.now() - lastSent.at < 8000) {
      setRouteHint("已拦截短时间重复发送（同 Agent 同内容）。");
      return false;
    }
    lastSentFingerprintRef.current[targetId] = { text: dedupText, at: Date.now() };
    chatSendLockByAgentRef.current[targetId] = true;
    startTransition(() => {
      setChatHistoryLoadedByAgent((prev) => (prev[targetId] ? prev : { ...prev, [targetId]: true }));
      setChatHistorySuppressedByAgent((prev) => {
        if (!prev[targetId]) return prev;
        return { ...prev, [targetId]: false };
      });
    });
    setAgentChatSendingState(targetId, true);
    setChatError(null);

    const userMsg: ChatUiMessage = {
      id: `local-user-${Date.now()}`,
      role: "user",
      text: normalizedText,
      status: "sending",
    };
    startTransition(() => {
      markChatPreviewDirty(targetId);
      setMessagesByAgent((prev) => ({
        ...prev,
        [targetId]: trimChatMessagesForUi([...(prev[targetId] || []), userMsg]),
      }));
    });
    await waitForNextPaint();

    const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
    const preferGatewayDir = chatSessionModeRef.current === "synced";
    const sessionName = getOrCreateChatSessionName(targetId);
    const targetGatewayId = getPreferredGatewayIdForAgent(targetId);
    const targetAfterCursor = chatCursorByAgentRef.current[targetId] || 0;
    const routeHintText = hint ? `${hint}${targetGatewayId ? ` · 网关 ${targetGatewayId}` : ""}` : (targetGatewayId ? `网关 ${targetGatewayId}` : null);
    startTransition(() => {
      setRouteHint(routeHintText);
    });
    let waitingInBackground = false;
    const requestId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      // 开发模式下跳过 IDENTITY 写入，避免 write_workspace_file 触发 Vite 监听导致整窗重载
      if (!import.meta.env.DEV) void ensureAgentSpecialtyIdentity(targetId);
      if (chatExecutionMode === "orchestrator") {
        const task = await invoke<CpOrchestratorTask>("orchestrator_submit_task", {
          title: `聊天流程 · ${targetId}`,
          input: normalizedText,
          customPath: cfgPath,
        });
        setCpTasks((prev) => [task, ...prev]);

        // 编排后继续真实执行：把任务转发给被分配的执行 Agent，拿到真实回答再回填。
        const executionAgent =
          task.steps.find((s) => s.name === "task_execution")?.assigned_agent ||
          task.steps.find((s) => s.assigned_agent !== "orchestrator" && s.assigned_agent !== "verifier")?.assigned_agent ||
          targetId;
        if (chatSessionModeRef.current === "synced" && executionAgent !== targetId) {
          await loadAgentHistoryDelta(executionAgent, { silent: true, force: true });
        }
        const executionSession = getOrCreateChatSessionName(executionAgent);
        const executionGatewayId = getPreferredGatewayIdForAgent(executionAgent);
        const executionAfterCursor = chatCursorByAgentRef.current[executionAgent] || 0;
        await invoke("chat_send_background", {
          requestId,
          agentId: executionAgent,
          sessionName: executionSession,
          text: normalizedText,
          gatewayId: executionGatewayId,
          customPath: cfgPath,
          preferGatewayDir,
        });
        const flowSummary = `【流程】编排:${targetId} -> 执行:${executionAgent}${executionGatewayId ? `@${executionGatewayId}` : ""} -> 验收:${
          task.verifier ? `${task.verifier.passed ? "通过" : "未通过"}(${task.verifier.score.toFixed(2)})` : "无"
        }${task.route_decision ? ` -> 意图:${task.route_decision.intent}` : ""}`;
        startTransition(() => {
          markChatPreviewDirty(targetId);
          setMessagesByAgent((prev) => ({
            ...prev,
            [targetId]: (prev[targetId] || []).map((m) =>
              m.id === userMsg.id ? { ...m, status: "sent" as const } : m
            ),
          }));
        });
        await startBackgroundReplyWait(
          {
            requestId,
            targetId,
            userMsgId: userMsg.id,
            mode: "orchestrator",
            flowSummary,
            afterCursor: executionAfterCursor,
          },
          {
            agentId: executionAgent,
            sessionName: executionSession,
            gatewayId: executionGatewayId,
            customPath: cfgPath,
            preferGatewayDir,
            afterCursor: executionAfterCursor,
          }
        );
        waitingInBackground = true;
        return true;
      }

      await invoke("chat_send_background", {
        requestId,
        agentId: targetId,
        sessionName,
        text: normalizedText,
        gatewayId: targetGatewayId,
        customPath: cfgPath,
        preferGatewayDir,
      });
      startTransition(() => {
        markChatPreviewDirty(targetId);
        setMessagesByAgent((prev) => ({
          ...prev,
          [targetId]: (prev[targetId] || []).map((m) =>
            m.id === userMsg.id ? { ...m, status: "sent" } : m
          ),
        }));
      });
      await startBackgroundReplyWait(
        {
          requestId,
          targetId,
          userMsgId: userMsg.id,
          mode: "direct",
          afterCursor: targetAfterCursor,
        },
        {
          agentId: targetId,
          sessionName,
          gatewayId: targetGatewayId,
          customPath: cfgPath,
          preferGatewayDir,
          afterCursor: targetAfterCursor,
        }
      );
      waitingInBackground = true;
      return true;
    } catch (e) {
      releasePendingChatRequest(targetId);
      setChatError(String(e));
      startTransition(() => {
        markChatPreviewDirty(targetId);
        setMessagesByAgent((prev) => ({
          ...prev,
          [targetId]: (prev[targetId] || []).map((m) => (m.id === userMsg.id ? { ...m, status: "failed" } : m)),
        }));
      });
      return false;
    } finally {
      if (!waitingInBackground) {
        releasePendingChatRequest(targetId);
      }
    }
  }, [resolveTargetAgent, chatSendingByAgent, chatExecutionMode, customConfigPath, getOrCreateChatSessionName, markChatInteracting, getPreferredGatewayIdForAgent, startBackgroundReplyWait, setAgentChatSendingState, releasePendingChatRequest, ensureAgentSpecialtyIdentity, loadAgentHistoryDelta, markChatPreviewDirty]);

  const handleAbortChat = useCallback(async () => {
    if (!selectedAgentId) return;
    try {
      const pendingId = pendingChatRequestIdByAgentRef.current[selectedAgentId];
      if (pendingId) {
        delete pendingChatRequestsRef.current[pendingId];
      }
      releasePendingChatRequest(selectedAgentId, pendingId);
      const sessionName = getOrCreateChatSessionName(selectedAgentId);
      await invoke("chat_abort", {
        agentId: selectedAgentId,
        sessionName,
        gatewayId: getPreferredGatewayIdForAgent(selectedAgentId),
        customPath: normalizeConfigPath(customConfigPath) || undefined,
        preferGatewayDir: chatSessionModeRef.current === "synced",
      });
      await loadAgentHistory(selectedAgentId);
    } catch (e) {
      setChatError(String(e));
    }
  }, [selectedAgentId, customConfigPath, getOrCreateChatSessionName, getPreferredGatewayIdForAgent, releasePendingChatRequest]);

  const handleNewSessionLocal = useCallback(() => {
    if (!selectedAgentId) return;
    if (chatSessionModeRef.current === "synced") {
      // 同步模式下保持 main，只清本地视图。
      chatSessionNameByAgentRef.current[selectedAgentId] = DEFAULT_SYNC_SESSION_NAME;
      chatCursorByAgentRef.current[selectedAgentId] = (messagesByAgentRef.current[selectedAgentId] || []).length;
      setRouteHint("已清空本地视图；当前为同步模式，与网页/Telegram 共用 main 会话。");
    } else {
      // 隔离模式下切换到新的本地会话桶，避免串到三端共享会话。
      chatSessionNameByAgentRef.current[selectedAgentId] = `${DEFAULT_ISOLATED_SESSION_NAME}-${Date.now().toString(36)}`;
      chatCursorByAgentRef.current[selectedAgentId] = 0;
      setRouteHint("已切换到新的隔离会话（仅客户端可见）。");
    }
    setChatHistorySuppressedByAgent((prev) => ({ ...prev, [selectedAgentId]: true }));
    setChatHistoryLoadedByAgent((prev) => ({ ...prev, [selectedAgentId]: false }));
    markChatPreviewDirty(selectedAgentId);
    setMessagesByAgent((prev) => ({ ...prev, [selectedAgentId]: [] }));
  }, [markChatPreviewDirty, selectedAgentId]);

  const handleChatViewportScroll = useCallback(
    (evt: UIEvent<HTMLDivElement>) => {
      if (!selectedAgentId) return;
      const viewport = evt.currentTarget;
      const distanceToBottom = viewport.scrollHeight - (viewport.scrollTop + viewport.clientHeight);
      const nextStickBottom = distanceToBottom <= 40;
      chatStickBottomByAgentRef.current[selectedAgentId] = nextStickBottom;
      setSelectedChatStickBottom((prev) => (prev === nextStickBottom ? prev : nextStickBottom));
      if (viewport.scrollTop > 100) return;
      const total = (messagesByAgentRef.current[selectedAgentId] || []).length;
      const currentLimit = chatRenderLimitByAgentRef.current[selectedAgentId] || CHAT_RENDER_BATCH;
      if (currentLimit >= total) return;
      const prevHeight = viewport.scrollHeight;
      const prevTop = viewport.scrollTop;
      const nextLimit = Math.min(total, currentLimit + CHAT_RENDER_BATCH);
      setChatRenderLimitByAgent((prev) => ({ ...prev, [selectedAgentId]: nextLimit }));
      window.requestAnimationFrame(() => {
        const el = chatViewportRef.current;
        if (!el) return;
        const nextHeight = el.scrollHeight;
        el.scrollTop = prevTop + (nextHeight - prevHeight);
      });
    },
    [selectedAgentId]
  );

  const refreshMemoryCenterStatus = async () => {
    setMemoryLoading(true);
    try {
      const status = await invoke<MemoryCenterStatus>("memory_center_status", {
        customPath: normalizeConfigPath(customConfigPath) || undefined,
      });
      setMemoryStatus(status);
    } catch (e) {
      setMemorySummary(`读取记忆状态失败: ${e}`);
    } finally {
      setMemoryLoading(false);
    }
  };
  refreshMemoryCenterStatusRef.current = refreshMemoryCenterStatus;

  const handleReadMemorySummary = async () => {
    setMemoryActionLoading("read");
    try {
      const text = await invoke<string>("memory_center_read", {
        customPath: normalizeConfigPath(customConfigPath) || undefined,
      });
      setMemorySummary(clampLogText(text || ""));
      await refreshMemoryCenterStatus();
    } catch (e) {
      setMemorySummary(`读取记忆摘要失败: ${e}`);
    } finally {
      setMemoryActionLoading(null);
    }
  };

  const handleClearMemory = async () => {
    setMemoryActionLoading("clear");
    try {
      const result = await invoke<string>("memory_center_clear", {
        customPath: normalizeConfigPath(customConfigPath) || undefined,
      });
      setMemorySummary(result);
      await refreshMemoryCenterStatus();
    } catch (e) {
      setMemorySummary(`清空记忆失败: ${e}`);
    } finally {
      setMemoryActionLoading(null);
    }
  };

  const handleExportMemory = async () => {
    setMemoryActionLoading("export");
    try {
      const result = await invoke<string>("memory_center_export", {
        customPath: normalizeConfigPath(customConfigPath) || undefined,
      });
      setMemorySummary(`记忆导出成功：${result}`);
    } catch (e) {
      setMemorySummary(`导出记忆失败: ${e}`);
    } finally {
      setMemoryActionLoading(null);
    }
  };

  const handleInitMemory = async () => {
    setMemoryActionLoading("init");
    try {
      const result = await invoke<string>("memory_center_bootstrap", {
        customPath: normalizeConfigPath(customConfigPath) || undefined,
      });
      setMemorySummary(result);
      await Promise.all([refreshMemoryCenterStatus(), handleReadMemorySummary()]);
    } catch (e) {
      setMemorySummary(`初始化记忆失败: ${e}`);
    } finally {
      setMemoryActionLoading(null);
    }
  };

  const handleTuningHealthCheck = async () => {
    if (tuningActionLoading) return;
    setTuningActionLoading("check");
    try {
      const installHint = (localInfo?.install_dir || customInstallPath || lastInstallDir || "").trim() || undefined;
      const result = await invoke<string>("run_self_check_background", {
        customPath: normalizeConfigPath(customConfigPath) || undefined,
        installHint,
      });
      setSelfCheckResult(result || "已切到后台执行体检");
    } catch (e) {
      setSelfCheckResult(`体检失败: ${e}`);
      setTuningActionLoading(null);
    } finally {
      // 后台事件完成后再清 loading
    }
  };

  const handleTuningSelfHeal = async () => {
    if (tuningActionLoading) return;
    setTuningActionLoading("heal");
    try {
      const installHint = (localInfo?.install_dir || customInstallPath || lastInstallDir || "").trim() || undefined;
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      const result = await invoke<string>("run_tuning_self_heal_background", {
        customPath: cfgPath,
        installHint,
      });
      setSelfCheckResult(result || "已切到后台执行一键修复");
    } catch (e) {
      setSelfCheckResult(`一键修复失败: ${e}`);
      setTuningActionLoading(null);
    } finally {
      // 后台事件完成后再清 loading
    }
  };

  const loadControlPlaneOverview = useCallback(async () => {
    setCpLoading(true);
    setCpResult(null);
    try {
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      const [tasks, graphs, tickets, memories, snapshotsList, prompts, capabilities, roles, audits, cost] = await Promise.all([
        invoke<CpOrchestratorTask[]>("orchestrator_list_tasks", { customPath: cfgPath }),
        invoke<CpSkillGraph[]>("skill_graph_list", { customPath: cfgPath }),
        invoke<CpTicket[]>("ticket_list", { customPath: cfgPath }),
        invoke<CpMemoryRecord[]>("memory_query_layered", { layer: undefined, query: undefined, customPath: cfgPath }),
        invoke<CpSnapshot[]>("replay_snapshot_list", { customPath: cfgPath }),
        invoke<CpPromptPolicyVersion[]>("promptops_list", { customPath: cfgPath }),
        invoke<CpAgentCapability[]>("capabilities_list", { customPath: cfgPath }),
        invoke<CpRoleBinding[]>("enterprise_list_roles", { customPath: cfgPath }),
        invoke<CpAuditEvent[]>("enterprise_list_audit", { category: undefined, customPath: cfgPath }),
        invoke<CpCostSummary>("enterprise_cost_summary", { customPath: cfgPath }),
      ]);
      setCpTasks(tasks || []);
      setCpGraphs(graphs || []);
      setCpTickets(tickets || []);
      setCpMemory(memories || []);
      setCpSnapshots(snapshotsList || []);
      setCpPrompts(prompts || []);
      setCpCapabilities(capabilities || []);
      setCpRoles(roles || []);
      setCpAudit(audits || []);
      setCpCost(cost || null);
      if (!cpSelectedGraphId && (graphs || []).length > 0) {
        setCpSelectedGraphId((graphs || [])[0].id);
      }
    } catch (e) {
      setCpResult(`读取控制平面失败: ${e}`);
    } finally {
      setCpLoading(false);
    }
  }, [customConfigPath, cpSelectedGraphId]);

  const parseJsonInput = <T,>(raw: string, fallback: T): T => {
    try {
      const parsed = JSON.parse(raw);
      return parsed as T;
    } catch {
      return fallback;
    }
  };

  const handleSeedControlPlane = async () => {
    setCpLoading(true);
    try {
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      const result = await invoke<string>("control_plane_seed_demo", { customPath: cfgPath });
      setCpResult(result);
      await loadControlPlaneOverview();
    } catch (e) {
      setCpResult(`初始化失败: ${e}`);
    } finally {
      setCpLoading(false);
    }
  };

  const handleOrchestratorSubmit = async () => {
    if (!cpTaskInput.trim()) return;
    setCpLoading(true);
    try {
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      const task = await invoke<CpOrchestratorTask>("orchestrator_submit_task", {
        title: cpTaskTitle.trim() || "综合任务",
        input: cpTaskInput.trim(),
        customPath: cfgPath,
      });
      setCpTasks((prev) => [task, ...prev]);
      setCpTaskInput("");
      setCpResult(`任务已提交: ${task.id}`);
      await loadControlPlaneOverview();
    } catch (e) {
      setCpResult(`提交任务失败: ${e}`);
    } finally {
      setCpLoading(false);
    }
  };

  const handleRetryTaskStep = async (taskId: string, stepId: string) => {
    setCpLoading(true);
    try {
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      const task = await invoke<CpOrchestratorTask>("orchestrator_retry_step", {
        taskId,
        stepId,
        customPath: cfgPath,
      });
      setCpTasks((prev) => prev.map((t) => (t.id === task.id ? task : t)));
      setCpResult(`步骤重试成功: ${stepId}`);
    } catch (e) {
      setCpResult(`步骤重试失败: ${e}`);
    } finally {
      setCpLoading(false);
    }
  };

  const handleVerifierCheck = async () => {
    setCpLoading(true);
    try {
      const constraints = cpVerifierConstraints
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      const report = await invoke<CpVerifierReport>("verifier_check_output", {
        output: cpVerifierOutput,
        constraints,
      });
      setCpVerifierReport(report);
      setCpResult(report.passed ? "验收通过" : "验收不通过，建议回炉");
    } catch (e) {
      setCpResult(`验收失败: ${e}`);
    } finally {
      setCpLoading(false);
    }
  };

  const handleSaveSkillGraph = async () => {
    setCpLoading(true);
    try {
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      const nodes = parseJsonInput<CpGraphNode[]>(cpGraphNodesJson, []);
      const edges = parseJsonInput<CpGraphEdge[]>(cpGraphEdgesJson, []);
      const graph = await invoke<CpSkillGraph>("skill_graph_save", {
        name: cpGraphName,
        nodes,
        edges,
        customPath: cfgPath,
      });
      setCpResult(`技能图已保存: ${graph.id}`);
      await loadControlPlaneOverview();
    } catch (e) {
      setCpResult(`保存技能图失败: ${e}`);
    } finally {
      setCpLoading(false);
    }
  };

  const handleExecuteSkillGraph = async () => {
    if (!cpSelectedGraphId) return;
    setCpLoading(true);
    try {
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      const task = await invoke<CpOrchestratorTask>("skill_graph_execute", {
        graphId: cpSelectedGraphId,
        input: cpTaskInput.trim() || "执行技能流水线",
        customPath: cfgPath,
      });
      setCpTasks((prev) => [task, ...prev]);
      setCpResult(`技能流水线执行完成: ${task.id}`);
      await loadControlPlaneOverview();
    } catch (e) {
      setCpResult(`执行技能图失败: ${e}`);
    } finally {
      setCpLoading(false);
    }
  };

  const handleCreateTicket = async () => {
    setCpLoading(true);
    try {
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      const payload = parseJsonInput<Record<string, unknown>>(cpTicketPayload, {});
      await invoke<CpTicket>("ticket_ingest", {
        channel: cpTicketChannel,
        externalRef: cpTicketExternalRef,
        title: cpTicketTitle,
        payload,
        customPath: cfgPath,
      });
      setCpResult("工单已入池");
      await loadControlPlaneOverview();
    } catch (e) {
      setCpResult(`入池失败: ${e}`);
    } finally {
      setCpLoading(false);
    }
  };

  const handleUpdateTicket = async (ticketId: string, status: string) => {
    setCpLoading(true);
    try {
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      await invoke<CpTicket>("ticket_update", {
        ticketId,
        status,
        assignee: selectedAgentId || undefined,
        customPath: cfgPath,
      });
      setCpResult(`工单已更新为 ${status}`);
      await loadControlPlaneOverview();
    } catch (e) {
      setCpResult(`更新工单失败: ${e}`);
    } finally {
      setCpLoading(false);
    }
  };

  const handleMemoryWriteLayered = async () => {
    if (!cpMemoryContent.trim()) return;
    setCpLoading(true);
    try {
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      await invoke<CpMemoryRecord>("memory_write_layered", {
        layer: cpMemoryLayer,
        scope: cpMemoryScope,
        content: cpMemoryContent,
        rationale: cpMemoryRationale,
        tags: cpMemoryTags.split(",").map((x) => x.trim()).filter(Boolean),
        customPath: cfgPath,
      });
      setCpMemoryContent("");
      setCpResult("分层记忆已写入");
      await loadControlPlaneOverview();
    } catch (e) {
      setCpResult(`写入分层记忆失败: ${e}`);
    } finally {
      setCpLoading(false);
    }
  };

  const handleSandboxPreview = async () => {
    setCpLoading(true);
    try {
      const preview = await invoke<CpSandboxPreview>("sandbox_preview_action", {
        actionType: cpSandboxActionType,
        resource: cpSandboxResource,
      });
      setCpSandboxPreview(preview);
      setCpResult("沙箱预览已生成");
    } catch (e) {
      setCpResult(`沙箱预览失败: ${e}`);
    } finally {
      setCpLoading(false);
    }
  };

  const handleSandboxExecute = async () => {
    setCpLoading(true);
    try {
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      const out = await invoke<string>("sandbox_execute_action", {
        actionType: cpSandboxActionType,
        resource: cpSandboxResource,
        approved: cpSandboxApproved,
        customPath: cfgPath,
      });
      setCpResult(out);
      await loadControlPlaneOverview();
    } catch (e) {
      setCpResult(`沙箱执行失败: ${e}`);
    } finally {
      setCpLoading(false);
    }
  };

  const handleDebateRun = async () => {
    setCpLoading(true);
    try {
      const res = await invoke<CpDebateResult>("debate_run", { task: cpDebateTask });
      setCpDebateResult(res);
      setCpResult("辩论完成");
    } catch (e) {
      setCpResult(`辩论失败: ${e}`);
    } finally {
      setCpLoading(false);
    }
  };

  const handleCreateSnapshot = async () => {
    setCpLoading(true);
    try {
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      const result = await invoke<CpSnapshot>("replay_snapshot_create", {
        taskId: cpSnapshotTaskId || cpTasks[0]?.id || "manual-task",
        input: cpSnapshotInput || cpTaskInput || "snapshot input",
        toolCalls: cpSnapshotTools.split(",").map((x) => x.trim()).filter(Boolean),
        config: parseJsonInput<Record<string, unknown>>(cpSnapshotConfig, {}),
        customPath: cfgPath,
      });
      setCpResult(`快照已创建: ${result.id}`);
      await loadControlPlaneOverview();
    } catch (e) {
      setCpResult(`创建快照失败: ${e}`);
    } finally {
      setCpLoading(false);
    }
  };

  const handleReplaySnapshot = async (snapshotId: string) => {
    setCpLoading(true);
    try {
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      const task = await invoke<CpOrchestratorTask>("replay_snapshot_replay", {
        snapshotId,
        customPath: cfgPath,
      });
      setCpTasks((prev) => [task, ...prev]);
      setCpResult(`快照回放完成: ${task.id}`);
      await loadControlPlaneOverview();
    } catch (e) {
      setCpResult(`回放失败: ${e}`);
    } finally {
      setCpLoading(false);
    }
  };

  const handleCreatePromptVersion = async () => {
    setCpLoading(true);
    try {
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      await invoke<CpPromptPolicyVersion>("promptops_create_version", {
        name: cpPromptName,
        rules: parseJsonInput<Record<string, string>>(cpPromptRules, {}),
        trafficPercent: cpPromptTraffic,
        customPath: cfgPath,
      });
      setCpResult("Prompt 策略版本已创建");
      await loadControlPlaneOverview();
    } catch (e) {
      setCpResult(`创建 Prompt 版本失败: ${e}`);
    } finally {
      setCpLoading(false);
    }
  };

  const handleActivatePromptVersion = async (versionId: string) => {
    setCpLoading(true);
    try {
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      const versions = await invoke<CpPromptPolicyVersion[]>("promptops_activate", {
        versionId,
        customPath: cfgPath,
      });
      setCpPrompts(versions || []);
      setCpResult(`策略已激活: ${versionId}`);
    } catch (e) {
      setCpResult(`激活失败: ${e}`);
    } finally {
      setCpLoading(false);
    }
  };

  const handleSetRoleBinding = async () => {
    setCpLoading(true);
    try {
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      await invoke<CpRoleBinding>("enterprise_set_role", {
        userId: cpRoleUserId,
        role: cpRoleName,
        customPath: cfgPath,
      });
      setCpResult("角色绑定已更新");
      await loadControlPlaneOverview();
    } catch (e) {
      setCpResult(`设置角色失败: ${e}`);
    } finally {
      setCpLoading(false);
    }
  };

  const handleUpsertCapability = async () => {
    if (!cpCapAgentId.trim()) return;
    setCpLoading(true);
    try {
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      await invoke<CpAgentCapability>("capabilities_upsert", {
        agentId: cpCapAgentId.trim(),
        specialty: cpCapSpecialty.trim() || "general",
        primaryModel: cpCapPrimaryModel.trim() || "general-balanced",
        fallbackModel: cpCapFallbackModel.trim() || undefined,
        tools: cpCapTools.split(",").map((x) => x.trim()).filter(Boolean),
        strengths: cpCapStrengths.split(",").map((x) => x.trim()).filter(Boolean),
        maxCostTier: cpCapCostTier.trim() || "medium",
        customPath: cfgPath,
      });
      setCpResult("能力画像已更新");
      await loadControlPlaneOverview();
    } catch (e) {
      setCpResult(`能力画像更新失败: ${e}`);
    } finally {
      setCpLoading(false);
    }
  };

  useEffect(() => {
    if (step !== 4) return;
    if (tuningSection !== "control") return;
    void loadControlPlaneOverview();
  }, [step, tuningSection, loadControlPlaneOverview]);

  const tuningPromptPreview = [
    `场景模板: ${scenarioPreset}`,
    `回答长度: ${tuneLength}`,
    `语气风格: ${tuneTone}`,
    `主动性: ${tuneProactivity}`,
    `执行权限: ${tunePermission}`,
    `记忆策略: ${memoryMode}`,
    "说明: 该模板用于小白引导，当前版本先用于配置记录与可视化，不直接改写 OpenClaw 内核提示词。",
  ].join("\n");

  const completeWizard = () => {
    applyScenarioPreset(wizardUseCase);
    setTuneTone(wizardTone);
    setMemoryMode(wizardMemory);
    if (wizardUseCase === "developer") {
      applyQuickModePreset("performance");
    } else {
      applyQuickModePreset("stable");
    }
    localStorage.setItem("openclaw_easy_onboarding_done", "1");
    setWizardOpen(false);
    handleStepChange(4);
    setSelfCheckResult("已完成首次向导：建议点击“一键体检”确认环境状态。");
  };

  const latestIssueText =
    (selfCheckResult || "") +
    "\n" +
    (startResult || "") +
    "\n" +
    (modelTestResult || "") +
    "\n" +
    (skillsResult || "");
  const chatAgents = agentsList?.agents ?? EMPTY_AGENTS;
  const selectedChatMessages = selectedAgentId ? messagesByAgent[selectedAgentId] || EMPTY_CHAT_MESSAGES : EMPTY_CHAT_MESSAGES;
  const selectedChatRenderLimit = selectedAgentId ? chatRenderLimitByAgent[selectedAgentId] || CHAT_RENDER_BATCH : CHAT_RENDER_BATCH;
  const lowerIssue = latestIssueText.toLowerCase();
  const suggestModelFix = lowerIssue.includes("model") || lowerIssue.includes("401") || lowerIssue.includes("api key");
  const suggestGatewayFix =
    lowerIssue.includes("token mismatch") ||
    lowerIssue.includes("gateway 启动失败") ||
    lowerIssue.includes("gateway start failed") ||
    lowerIssue.includes("端口占用") ||
    lowerIssue.includes("address already in use");
  const suggestSkillsFix = lowerIssue.includes("skills") || lowerIssue.includes("缺失依赖") || lowerIssue.includes("bins:");
  const parseFeedbackMessage = useCallback((text?: string | null, keepLast = 0) => {
    if (!text) return { headline: "", detail: "", lines: [] as string[] };
    const lines = String(text)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const visible = keepLast > 0 && lines.length > keepLast ? lines.slice(-keepLast) : lines;
    return {
      headline: visible[0] || "",
      detail: visible.slice(1).join("\n"),
      lines: visible,
    };
  }, []);
  const getFeedbackTone = useCallback((text?: string | null) => {
    const raw = String(text || "").trim().toLowerCase();
    if (!raw) return "info" as const;
    if (/(失败|错误|拦截|冲突|拒绝访问|not found|invalid|doctor|unknown channel|启动失败)/i.test(raw)) return "error" as const;
    if (/(正在|提交|启动中|重启中|检查中|导出中|保存中|处理中)/i.test(raw)) return "info" as const;
    if (/(请先|下一步|未生成|还没|先点|去启动|去重启|待补全|需要)/i.test(raw)) return "warning" as const;
    return "success" as const;
  }, []);
  const getFeedbackCardClass = useCallback(
    (text?: string | null) => {
      const tone = getFeedbackTone(text);
      if (tone === "error") return "border-rose-600/50 bg-rose-950/30 text-rose-200";
      if (tone === "warning") return "border-amber-600/50 bg-amber-950/30 text-amber-200";
      if (tone === "info") return "border-sky-600/50 bg-sky-950/30 text-sky-100";
      return "border-emerald-600/40 bg-emerald-950/20 text-emerald-200";
    },
    [getFeedbackTone]
  );
  const getFeedbackCardTitle = useCallback(
    (text: string | null | undefined, successTitle: string) => {
      const tone = getFeedbackTone(text);
      if (tone === "error") return "处理失败";
      if (tone === "warning") return "下一步";
      if (tone === "info") return "处理中";
      return successTitle;
    },
    [getFeedbackTone]
  );
  const buildFeedbackCardModel = useCallback(
    (text: string | null | undefined, successTitle: string, keepLast = 0, badge?: string) => {
      const parts = parseFeedbackMessage(text, keepLast);
      if (!parts.headline && !parts.detail) return null;
      return {
        toneClassName: getFeedbackCardClass(text),
        title: getFeedbackCardTitle(text, successTitle),
        headline: parts.headline,
        detail: parts.detail,
        badge,
      };
    },
    [getFeedbackCardClass, getFeedbackCardTitle, parseFeedbackMessage]
  );
  const serviceQueueSummary = useMemo(() => {
    const running = queueTasks.filter((t) => t.status === "running").length;
    const queued = queueTasks.filter((t) => t.status === "queued").length;
    const failed = queueTasks.filter((t) => t.status === "error").length;
    const cancelled = queueTasks.filter((t) => t.status === "cancelled").length;
    return { running, queued, failed, cancelled, total: queueTasks.length };
  }, [queueTasks]);
  const serviceRecentQueueTasks = useMemo(() => queueTasks.slice().reverse().slice(0, 5), [queueTasks]);
  const skillsLogText = useMemo(() => {
    const progressText = skillsRepairProgressLog.join("\n").trim();
    const resultText = (skillsResult || "").trim();
    if (progressText && resultText) return `${progressText}\n\n----- 结果日志 -----\n${resultText}`;
    if (progressText) return progressText;
    if (resultText) return resultText;
    return "暂无日志。点击“安装选中”或“修复缺失依赖（选中）”后，这里会实时显示执行输出。";
  }, [skillsRepairProgressLog, skillsResult]);

  const toggleSkillSelection = useCallback((name: string, checked: boolean) => {
    setSelectedSkills((prev) => {
      if (prev[name] === checked) return prev;
      return { ...prev, [name]: checked };
    });
  }, []);

  const handleCopyManualHint = useCallback(async (skill: SkillCatalogItem) => {
    const hint = buildManualFixHint(skill);
    try {
      await navigator.clipboard.writeText(hint);
      setSkillsResult(`已复制 ${skill.name} 的手动修复指引`);
    } catch {
      setSkillsResult(`复制失败，请手动复制：\n\n${hint}`);
    }
  }, []);

  const handleStepChange = useCallback((nextStep: number) => {
    startTransition(() => {
      setStep(nextStep);
    });
  }, []);

  const currentPrimaryNav = step === 3 ? "chat" : step === 4 ? (tuningSection === "health" ? "repair" : "tuning") : "home";
  // Keep the shell stable when only switching agent sub-tabs; the sub-page handles its own staged rendering.
  const currentHeavyPageKey = step === 4 ? `${step}:${tuningSection}` : `${step}`;
  const [deferredHeavyPageKey, setDeferredHeavyPageKey] = useState(currentHeavyPageKey);
  const heavyPageShellPending = deferredHeavyPageKey !== currentHeavyPageKey;
  const handlePrimaryNavChange = useCallback(
    (target: "home" | "chat" | "tuning" | "repair") => {
      setDeferredHeavyPageKey(PAGE_TRANSITION_PENDING_KEY);
      startTransition(() => {
        if (target === "home") {
          setStep(0);
          return;
        }
        if (target === "chat") {
          setStep(3);
          return;
        }
        setStep(4);
        setTuningSection(target === "repair" ? "health" : "agents");
        if (target === "tuning") setAgentCenterTab("overview");
      });
    },
    []
  );

  useEffect(() => {
    cancelIdleTask(deferredPageRenderTimerRef.current);
    if (currentHeavyPageKey === deferredHeavyPageKey) return;
    deferredPageRenderTimerRef.current = scheduleIdleTask(() => {
      setDeferredHeavyPageKey(currentHeavyPageKey);
      deferredPageRenderTimerRef.current = null;
    }, 80);
    return () => {
      cancelIdleTask(deferredPageRenderTimerRef.current);
      deferredPageRenderTimerRef.current = null;
    };
  }, [currentHeavyPageKey, deferredHeavyPageKey]);

  const heavyPanelStyle = useMemo(
    () =>
      ({
        contain: "layout paint style",
        contentVisibility: "auto",
        containIntrinsicSize: "520px",
      }) as CSSProperties,
    []
  );

  const envReady = nodeCheck?.ok && npmCheck?.ok;
  const canProceed = step === 0 ? envReady : true;
  const currentAiServiceLabel = getAiServiceLabel(provider);
  const visibleAiModels = provider === "kimi"
    ? [{ id: "moonshotai/Kimi-K2-Instruct-0905", label: "Kimi K2（长文本推荐）" }]
    : FIXED_SILICONFLOW_MODELS;
  const installReady = !!(localInfo?.installed || openclawCheck?.ok);
  const aiReady = !!(keySyncStatus?.env_key_prefix || runtimeModelInfo?.key_prefix || apiKey.trim());
  const chatReady = !!selectedAgentId;
  const homeStatusLabel = !installReady ? "未安装" : !aiReady ? "待配置 AI" : !chatReady ? "待创建 Agent" : "已可聊天";
  const configuredTelegramDraftIds = useMemo(
    () =>
      new Set(
        telegramInstancesDraft
          .filter((item) => item.enabled !== false && hasConfiguredTelegramDraftInstance(item))
          .map((item) => (item.id || "").trim())
          .filter(Boolean)
      ),
    [telegramInstancesDraft]
  );
  const configuredChannelDraftIdsByChannel = useMemo(() => {
    const next: Record<string, Set<string>> = {};
    for (const item of channelInstancesDraft || []) {
      const channel = (item.channel || "").trim().toLowerCase();
      const id = (item.id || "").trim();
      if (channel === "telegram" || !channel || !id || item.enabled === false || !hasConfiguredChannelDraftInstance(channel as NonTelegramChannel, item)) {
        continue;
      }
      if (!next[channel]) next[channel] = new Set<string>();
      next[channel].add(id);
    }
    return next;
  }, [channelInstancesDraft]);
  const linkedConfiguredChannels = useMemo(() => {
    const next = new Set<string>();
    for (const binding of gatewayBindingsDraft || []) {
      if (binding.enabled === false) continue;
      const channelMap = parseGatewayChannelInstances(binding.channel_instances, binding.channel, binding.instance_id);
      for (const [channelName, instanceValue] of Object.entries(channelMap || {})) {
        const channel = (channelName || "").trim().toLowerCase();
        const instanceId = String(instanceValue || "").trim();
        if (!channel || channel === "local" || !instanceId) continue;
        const linked =
          channel === "telegram"
            ? configuredTelegramDraftIds.has(instanceId)
            : configuredChannelDraftIdsByChannel[channel]?.has(instanceId);
        if (linked) next.add(channel);
      }
    }
    return next;
  }, [configuredChannelDraftIdsByChannel, configuredTelegramDraftIds, gatewayBindingsDraft, parseGatewayChannelInstances]);
  const channelTabStatusMap = useMemo(() => {
    const channels: ChannelEditorChannel[] = ["telegram", "feishu", "dingtalk", "discord", "qq"];
    const next = {} as Record<
      ChannelEditorChannel,
      { label: "待补全" | "已配置" | "已连通"; dotClass: string; textClass: string; title: string }
    >;
    for (const ch of channels) {
      const hasConfigured =
        ch === "telegram" ? configuredTelegramDraftIds.size > 0 : (configuredChannelDraftIdsByChannel[ch]?.size || 0) > 0;
      const linkedToGateway = linkedConfiguredChannels.has(ch);
      if (!hasConfigured) {
        next[ch] = {
          label: "待补全",
          dotClass: "bg-amber-400",
          textClass: "text-amber-200",
          title: `${ch} 还没填完凭据`,
        };
      } else if (linkedToGateway) {
        next[ch] = {
          label: "已连通",
          dotClass: "bg-emerald-400",
          textClass: "text-emerald-200",
          title: `${ch} 已进入当前 Agent 网关绑定`,
        };
      } else {
        next[ch] = {
          label: "已配置",
          dotClass: "bg-sky-400",
          textClass: "text-sky-200",
          title: `${ch} 已填写凭据，但还没进入网关绑定`,
        };
      }
    }
    return next;
  }, [configuredChannelDraftIdsByChannel, configuredTelegramDraftIds, linkedConfiguredChannels]);
  const stickyChannelActionFeedback = agentRuntimeResult || channelResult;
  const startFeedbackCard = isRepairPage
    ? buildFeedbackCardModel(
        startResult,
        "网关已就绪",
        6,
        parseFeedbackMessage(startResult, 6).detail ? "最近 6 行" : undefined
      )
    : null;
  const agentsActionFeedbackCard = isAgentOverviewPage ? buildFeedbackCardModel(agentsActionResult, "Agent 已更新") : null;
  const stickyChannelActionFeedbackCard = isAgentChannelsPage ? buildFeedbackCardModel(stickyChannelActionFeedback, "保存完成") : null;
  const agentRuntimeFeedbackCard = isAgentOverviewPage ? buildFeedbackCardModel(agentRuntimeResult, "配置已更新") : null;
  const telegramSelfHealFeedbackCard =
    isAgentOverviewPage || isAgentChannelsPage
      ? buildFeedbackCardModel(telegramSelfHealResult, "Telegram 自动自愈", 6)
      : null;
  const channelFeedbackCard = isAgentChannelsPage ? buildFeedbackCardModel(channelResult, "检查完成") : null;
  const pluginInstallFeedbackCard = buildFeedbackCardModel(pluginInstallResult, "插件处理完成", 6);
  const skillsFeedbackCard = buildFeedbackCardModel(skillsResult, "Skills 处理完成", 6);
  const marketFeedbackCard = buildFeedbackCardModel(marketResult, "Skill 处理完成", 6);
  const qqCommunityQrSrc = "/community/qq-group.png";
  const tuningPageTitle = tuningSection === "health" ? "修复中心" : "调教中心";
  const currentTuningNav =
    tuningSection === "agents"
      ? agentCenterTab === "channels"
        ? "channels"
        : "agents"
      : tuningSection === "skills"
        ? "skills"
        : tuningSection === "memory"
          ? "memory"
          : tuningSection === "scene"
            ? "templates"
            : "advanced";

  const tuningAgentsCtx = useMemo(() => ({
    heavyPanelStyle,
    agentCenterTab,
    setAgentCenterTab,
    agentsLoading,
    agentsError,
    agentsList,
    enabledGatewaysByAgent,
    agentRuntimeLoading,
    gatewayRuntimeLoading,
    runtimeDirtyFlags,
    runtimeFreshness,
    telegramInstancesDraft,
    channelInstancesDraft,
    channelInstancesEditorChannel,
    parseGatewayChannelInstances,
    agentNameDrafts,
    setAgentNameDrafts,
    agentsActionResult,
    setAgentsActionResult,
    renamingAgentId,
    handleRenameAgent,
    updateRuntimeDirtyFlags,
    refreshAgentsList,
    normalizeConfigPath,
    customConfigPath,
    agentsActionFeedbackCard,
    showAgentAdvancedSettings,
    setShowAgentAdvancedSettings,
    agentProfileDrafts,
    setAgentProfileDrafts,
    agentModelsByProvider,
    agentModelsLoadingByProvider,
    refreshModelsForProvider,
    saveAgentProfile,
    agentRuntimeSaving,
    agentRuntimeFeedbackCard,
    telegramSelfHealFeedbackCard,
    agentRuntimeSettings,
    setShowCreateAgent,
    simpleModeForAgent,
    setSimpleModeForAgent,
    hasRequiredChannelCredentials,
    routeTestResult,
    channelInstanceAutosaveStateByChannel,
    setChannelInstancesEditorChannel,
    handleListPairings,
    pairingLoading,
    pairingCodeByChannel,
    setPairingCodeByChannel,
    handleApprovePairing,
    pairingRequestsByChannel,
    channelFeedbackCard,
    handleAutoInstallPlugins,
    pluginInstallLoading,
    pluginSelection,
    setPluginSelection,
    setPluginSelectionTouched,
    pluginInstallProgress,
    pluginInstallProgressLog,
    pluginInstallFeedbackCard,
    buildChannelPerAgentDraft,
    runChannelFirstSetupWizard,
    channelWizardRunningByChannel,
    testChannelInstancesBatch,
    channelBatchTestingByChannel,
    updateAgentScopedChannelDraft,
    channelEditorCredential1Label,
    channelEditorCredential2Label,
    testSingleChannelInstance,
    channelSingleTestingByInstanceId,
    activeChannelInstanceByChannel,
    setActiveChannelInstanceByChannel,
    setChannelInstanceAutosaveStateByChannel,
    queueChannelInstanceAutoSave,
    buildTelegramPerAgentDraft,
    runTelegramFirstSetupWizard,
    telegramWizardRunning,
    testTelegramInstancesBatch,
    telegramBatchTesting,
    cleanupBrowserSessionsForTelegramBindings,
    telegramSessionCleanupRunning,
    updateAgentScopedTelegramDraft,
    telegramUsernameByInstanceId,
    testSingleTelegramInstance,
    telegramSingleTestingByInstanceId,
    activeTelegramInstanceId,
    setActiveTelegramInstanceId,
    queueTelegramInstanceAutoSave,
    gatewayBindingsDraft,
    setGatewayBindingsDraft,
    refreshGatewayInstances,
    showGatewayAdvancedActions,
    setShowGatewayAdvancedActions,
    buildChannelInstanceMapForAgent,
    saveGatewayBindings,
    generateGatewayBindingsByAgent,
    runStartAllEnabledGateways,
    runRestartAllEnabledGateways,
    runHealthAllEnabledGateways,
    exportGatewayDiagnosticReport,
    gatewayBatchLoading,
    gatewayBatchProgress,
    gatewayActionLoadingById,
    gatewayActionHintById,
    formatOrderedChannelBindings,
    stringifyGatewayChannelInstances,
    parseGatewayChannelInstancesText,
    runGatewayAction,
    isGatewayPortOnlyHealth,
    summarizeGatewayHealthDetail,
    showAdvancedRouteRules,
    setShowAdvancedRouteRules,
    channelRoutesDraft,
    setChannelRoutesDraft,
    saveChannelRoutes,
    getChannelInstanceIdsByChannel,
    gatewaySelectedIdForRouteTest,
    setGatewaySelectedIdForRouteTest,
    routeTestChannel,
    setRouteTestChannel,
    routeTestBotInstance,
    setRouteTestBotInstance,
    routeTestAccount,
    setRouteTestAccount,
    routeTestPeer,
    setRouteTestPeer,
    testChannelRoute,
    routeTesting,
    showRouteTestPanel,
    setShowRouteTestPanel,
    gatewayLogViewerId,
    setGatewayLogViewerId,
    gatewayLogsById,
    selectedAgentId,
    stickyChannelActionFeedbackCard,
    saveAndApplyTelegramSetup,
    saveAndApplyChannelSetup,
    showCreateAgent,
    createAgentId,
    setCreateAgentId,
    createAgentName,
    setCreateAgentName,
    createAgentWorkspace,
    setCreateAgentWorkspace,
    creatingAgent,
    setCreatingAgent,
    refreshAgentRuntimeSettings,
    ensureAgentSpecialtyIdentity,
    setAgentRuntimeResult,
    setSelectedAgentId,
    channelTabStatusMap,
    openGatewayLogWindow,
  }), [
    heavyPanelStyle,
    agentCenterTab,
    setAgentCenterTab,
    agentsLoading,
    agentsError,
    agentsList,
    enabledGatewaysByAgent,
    agentRuntimeLoading,
    gatewayRuntimeLoading,
    runtimeDirtyFlags,
    runtimeFreshness,
    telegramInstancesDraft,
    channelInstancesDraft,
    channelInstancesEditorChannel,
    parseGatewayChannelInstances,
    agentNameDrafts,
    setAgentNameDrafts,
    agentsActionResult,
    setAgentsActionResult,
    renamingAgentId,
    handleRenameAgent,
    updateRuntimeDirtyFlags,
    refreshAgentsList,
    normalizeConfigPath,
    customConfigPath,
    agentsActionFeedbackCard,
    showAgentAdvancedSettings,
    setShowAgentAdvancedSettings,
    agentProfileDrafts,
    setAgentProfileDrafts,
    agentModelsByProvider,
    agentModelsLoadingByProvider,
    refreshModelsForProvider,
    saveAgentProfile,
    agentRuntimeSaving,
    agentRuntimeFeedbackCard,
    telegramSelfHealFeedbackCard,
    agentRuntimeSettings,
    setShowCreateAgent,
    simpleModeForAgent,
    setSimpleModeForAgent,
    hasRequiredChannelCredentials,
    routeTestResult,
    channelInstanceAutosaveStateByChannel,
    setChannelInstancesEditorChannel,
    handleListPairings,
    pairingLoading,
    pairingCodeByChannel,
    setPairingCodeByChannel,
    handleApprovePairing,
    pairingRequestsByChannel,
    channelFeedbackCard,
    handleAutoInstallPlugins,
    pluginInstallLoading,
    pluginSelection,
    setPluginSelection,
    setPluginSelectionTouched,
    pluginInstallProgress,
    pluginInstallProgressLog,
    pluginInstallFeedbackCard,
    buildChannelPerAgentDraft,
    runChannelFirstSetupWizard,
    channelWizardRunningByChannel,
    testChannelInstancesBatch,
    channelBatchTestingByChannel,
    updateAgentScopedChannelDraft,
    channelEditorCredential1Label,
    channelEditorCredential2Label,
    testSingleChannelInstance,
    channelSingleTestingByInstanceId,
    activeChannelInstanceByChannel,
    setActiveChannelInstanceByChannel,
    setChannelInstanceAutosaveStateByChannel,
    queueChannelInstanceAutoSave,
    buildTelegramPerAgentDraft,
    runTelegramFirstSetupWizard,
    telegramWizardRunning,
    testTelegramInstancesBatch,
    telegramBatchTesting,
    cleanupBrowserSessionsForTelegramBindings,
    telegramSessionCleanupRunning,
    updateAgentScopedTelegramDraft,
    telegramUsernameByInstanceId,
    testSingleTelegramInstance,
    telegramSingleTestingByInstanceId,
    activeTelegramInstanceId,
    setActiveTelegramInstanceId,
    queueTelegramInstanceAutoSave,
    gatewayBindingsDraft,
    setGatewayBindingsDraft,
    refreshGatewayInstances,
    showGatewayAdvancedActions,
    setShowGatewayAdvancedActions,
    buildChannelInstanceMapForAgent,
    saveGatewayBindings,
    generateGatewayBindingsByAgent,
    runStartAllEnabledGateways,
    runRestartAllEnabledGateways,
    runHealthAllEnabledGateways,
    exportGatewayDiagnosticReport,
    gatewayBatchLoading,
    gatewayBatchProgress,
    gatewayActionLoadingById,
    gatewayActionHintById,
    formatOrderedChannelBindings,
    stringifyGatewayChannelInstances,
    parseGatewayChannelInstancesText,
    runGatewayAction,
    isGatewayPortOnlyHealth,
    summarizeGatewayHealthDetail,
    showAdvancedRouteRules,
    setShowAdvancedRouteRules,
    channelRoutesDraft,
    setChannelRoutesDraft,
    saveChannelRoutes,
    getChannelInstanceIdsByChannel,
    gatewaySelectedIdForRouteTest,
    setGatewaySelectedIdForRouteTest,
    routeTestChannel,
    setRouteTestChannel,
    routeTestBotInstance,
    setRouteTestBotInstance,
    routeTestAccount,
    setRouteTestAccount,
    routeTestPeer,
    setRouteTestPeer,
    testChannelRoute,
    routeTesting,
    showRouteTestPanel,
    setShowRouteTestPanel,
    gatewayLogViewerId,
    setGatewayLogViewerId,
    gatewayLogsById,
    selectedAgentId,
    stickyChannelActionFeedbackCard,
    saveAndApplyTelegramSetup,
    saveAndApplyChannelSetup,
    showCreateAgent,
    createAgentId,
    setCreateAgentId,
    createAgentName,
    setCreateAgentName,
    createAgentWorkspace,
    setCreateAgentWorkspace,
    creatingAgent,
    setCreatingAgent,
    refreshAgentRuntimeSettings,
    ensureAgentSpecialtyIdentity,
    setAgentRuntimeResult,
    setSelectedAgentId,
    channelTabStatusMap,
    openGatewayLogWindow,
  ]);
  const tuningHealthCtx = {
    runtimeProbeResult,
    skillsCatalog,
    selfCheckItems,
    memoryStatus,
    tuningActionLoading,
    handleTuningHealthCheck,
    handleTuningSelfHeal,
    heavyPanelStyle,
    setStep,
    startFeedbackCard,
    serviceQueueSummary,
    queueTasks,
    showServiceQueueDetails,
    setShowServiceQueueDetails,
    serviceRecentQueueTasks,
    cancelTask,
    retryTask,
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col">
      <header className="border-b border-slate-700 px-6 py-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-bold flex items-center gap-2">
              <span className="text-2xl">🦞</span>
              OpenClaw 控制台
            </h1>
            <p className="text-slate-400 text-sm mt-1">围绕 API、安装、对话与修复的一体化小白面板</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap text-xs text-slate-400">
            <span className="rounded-full border border-slate-700 bg-slate-800/80 px-3 py-1.5">首页状态：{homeStatusLabel}</span>
            <span className="rounded-full border border-slate-700 bg-slate-800/80 px-3 py-1.5">当前 AI：{currentAiServiceLabel}</span>
            <span className="rounded-full border border-slate-700 bg-slate-800/80 px-3 py-1.5">当前入口：{currentPrimaryNav === "repair" ? "修复中心" : currentPrimaryNav === "tuning" ? "调教中心" : currentPrimaryNav === "chat" ? "聊天" : "首页"}</span>
          </div>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        <aside className="w-60 shrink-0 border-r border-slate-700 bg-slate-950/70 p-4 flex flex-col gap-4">
          <div className="space-y-1">
            {PRIMARY_NAV_ITEMS.map((item) => (
              <button
                key={item.id}
                onClick={() => handlePrimaryNavChange(item.id)}
                className={`w-full flex items-center gap-3 rounded-xl px-3 py-3 text-sm transition ${
                  currentPrimaryNav === item.id
                    ? "bg-sky-800/80 text-sky-100 border border-sky-600/70"
                    : "bg-slate-800/70 text-slate-300 border border-slate-800 hover:border-slate-600 hover:bg-slate-800"
                }`}
              >
                <item.icon className="w-4 h-4" />
                <span>{item.label}</span>
              </button>
            ))}
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-3 space-y-3">
            <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-3 space-y-2 text-xs">
              <p className="text-slate-200 font-medium">首次跑通路径</p>
              <div className="space-y-1 text-slate-400">
                <button onClick={() => handleStepChange(0)} className="block hover:text-slate-200">1. 环境检测</button>
                <button onClick={() => handleStepChange(1)} className="block hover:text-slate-200">2. 安装 OpenClaw</button>
                <button onClick={() => handleStepChange(2)} className="block hover:text-slate-200">3. AI 服务配置</button>
                <button onClick={() => handlePrimaryNavChange("tuning")} className="block hover:text-slate-200">4. Agent 与渠道</button>
                <button onClick={() => handlePrimaryNavChange("chat")} className="block hover:text-slate-200">5. 进入聊天</button>
              </div>
            </div>

            <button
              onClick={() => {
                setCommunityActionResult(null);
                setCommunityHubView("links");
                setShowCommunityHub(true);
              }}
              className="w-full rounded-2xl border border-sky-700/60 bg-gradient-to-br from-sky-900/30 via-slate-900/90 to-indigo-950/50 px-4 py-4 text-left shadow-[0_0_0_1px_rgba(14,165,233,0.08),0_14px_28px_rgba(2,6,23,0.45)] hover:border-sky-500/70 hover:shadow-[0_0_0_1px_rgba(56,189,248,0.16),0_18px_32px_rgba(2,6,23,0.55)]"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sky-100 font-semibold text-sm">项目与社群</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-slate-300">
                    GitHub 项目、QQ群、Telegram 群统一放这里
                  </p>
                </div>
                <span className="rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[10px] text-sky-200">点击查看</span>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5 text-[10px]">
                <span className="rounded-full border border-slate-700 bg-slate-950/50 px-2 py-1 text-slate-300">GitHub</span>
                <span className="rounded-full border border-slate-700 bg-slate-950/50 px-2 py-1 text-slate-300">QQ群</span>
                <span className="rounded-full border border-slate-700 bg-slate-950/50 px-2 py-1 text-slate-300">Telegram</span>
              </div>
            </button>

            <button
              onClick={() => openUrl("https://clawd.bot/docs")}
              className="w-full flex items-center justify-between rounded-xl border border-slate-700 bg-slate-900/70 px-3 py-3 text-left text-slate-300 hover:border-slate-500 hover:text-slate-200"
            >
              <div>
                <p className="text-sm font-medium text-slate-100">官方文档</p>
                <p className="mt-1 text-[11px] text-slate-400">查看官方说明、基础概念和排错资料</p>
              </div>
              <ExternalLink className="w-4 h-4 shrink-0" />
            </button>
          </div>

          <div className="mt-auto space-y-2 text-xs text-slate-500">
            <div className="rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2">
              <p>当前页面：{currentPrimaryNav === "repair" ? "修复中心" : currentPrimaryNav === "tuning" ? "调教中心" : currentPrimaryNav === "chat" ? "聊天" : "首页"}</p>
            </div>
          </div>
        </aside>

        <div className="flex-1 min-w-0 flex flex-col">
          <main className="flex-1 p-6 overflow-auto flex flex-col">
        {(suggestModelFix || suggestGatewayFix || suggestSkillsFix) && (
          <div className="w-full max-w-[1200px] mx-auto mb-4 rounded-lg border border-amber-700 bg-amber-900/20 p-3 text-xs space-y-2">
            <p className="text-amber-200">检测到可能异常，建议下一步：</p>
            <div className="flex flex-wrap gap-2">
              {suggestModelFix && (
                <button
                  onClick={() => handleStepChange(2)}
                  className="px-2 py-1 bg-sky-700 hover:bg-sky-600 rounded"
                >
                  去模型配置
                </button>
              )}
              {suggestGatewayFix && (
                <button
                  onClick={handleResetGatewayAuth}
                  className="px-2 py-1 bg-emerald-700 hover:bg-emerald-600 rounded"
                >
                  一键修复网关
                </button>
              )}
              {suggestSkillsFix && (
                <button
                  onClick={() => handleStepChange(3)}
                  className="px-2 py-1 bg-amber-700 hover:bg-amber-600 rounded"
                >
                  去 Skills 修复
                </button>
              )}
            </div>
          </div>
        )}
        {/* Step 0: 环境检测 */}
        {step === 0 && (
          <div className="w-full max-w-[1200px] mx-auto space-y-6">
            <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-6">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="space-y-2">
                  <p className="text-xs uppercase tracking-[0.2em] text-sky-300">首页</p>
                  <h2 className="text-2xl font-semibold text-white">3 分钟跑通 OpenClaw</h2>
                  <p className="text-sm text-slate-300 max-w-2xl">
                    先检查环境，再安装 OpenClaw，接着配置 AI 服务和 Agent/渠道，最后回到聊天页发出第一条消息。
                  </p>
                </div>
                <div className="rounded-xl border border-slate-700 bg-slate-900/70 px-4 py-3 text-sm text-slate-300 min-w-[220px]">
                  <p className="text-slate-100 font-medium mb-1">当前总状态</p>
                  <p>{homeStatusLabel}</p>
                  <p className="text-xs text-slate-500 mt-2">
                    {aiReady ? `AI 已接通：${currentAiServiceLabel}` : "AI 服务尚未完成测试"}
                  </p>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-5 space-y-3">
                <div className="flex items-center gap-2 text-slate-100 font-medium">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  环境准备
                </div>
                <p className="text-sm text-slate-400">检查 Node、Git、OpenClaw 与插件状态，问题集中在这里一键修。</p>
                <div className="text-xs text-slate-500 space-y-1">
                  <p>Node：{nodeCheck?.ok ? "正常" : "待修复"}</p>
                  <p>Git：{gitCheck?.ok ? "正常" : "建议安装"}</p>
                  <p>OpenClaw：{openclawCheck?.ok ? "已安装" : "未安装"}</p>
                </div>
                <button
                  onClick={() => runEnvCheck()}
                  disabled={checking}
                  className="px-3 py-2 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 rounded-lg text-sm"
                >
                  {checking ? "检测中..." : "一键检查并修复"}
                </button>
              </div>

              <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-5 space-y-3">
                <div className="flex items-center gap-2 text-slate-100 font-medium">
                  <Key className="w-4 h-4 text-sky-400" />
                  AI 服务配置
                </div>
                <p className="text-sm text-slate-400">先选渠道，再选便宜模型，填 Key 就能用。</p>
                <div className="text-xs text-slate-500 space-y-1">
                  <p>当前服务：{currentAiServiceLabel}</p>
                  <p>当前模型：{selectedModel || "未选择"}</p>
                  <p>状态：{aiReady ? "已配置" : "未配置"}</p>
                </div>
                <button
                  onClick={() => handleStepChange(2)}
                  className="px-3 py-2 bg-sky-700 hover:bg-sky-600 rounded-lg text-sm"
                >
                  配置 AI 服务
                </button>
              </div>

              <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-5 space-y-3">
                <div className="flex items-center gap-2 text-slate-100 font-medium">
                  <Play className="w-4 h-4 text-amber-400" />
                  开始聊天
                </div>
                <p className="text-sm text-slate-400">创建默认 Agent、绑定一个渠道，然后直接去聊天页发送第一条消息。</p>
                <div className="text-xs text-slate-500 space-y-1">
                  <p>默认 Agent：{selectedAgentId || "未选择"}</p>
                  <p>渠道配置：{agentsList?.bindings?.length ? "已存在绑定" : "待配置"}</p>
                  <p>Gateway：{starting ? "启动中" : "待就绪"}</p>
                </div>
                <div className="flex gap-2 flex-wrap">
                  <button
                    onClick={() => handlePrimaryNavChange("tuning")}
                    className="px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm"
                  >
                    去 Agent 与渠道
                  </button>
                  <button
                    onClick={() => handlePrimaryNavChange("chat")}
                    className="px-3 py-2 bg-amber-700 hover:bg-amber-600 rounded-lg text-sm"
                  >
                    进入聊天
                  </button>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-700 bg-slate-800/40 p-4">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <p className="text-sm text-slate-200 font-medium">推荐模板与帮助入口</p>
                  <p className="text-xs text-slate-400 mt-1">先用模板跑通，再去调教中心做进阶配置。</p>
                </div>
                <div className="flex gap-2 flex-wrap">
                  {["本地直聊", "Telegram 单 Bot", "QQ Bot", "飞书 Bot"].map((name) => (
                    <button
                      key={name}
                      onClick={() => handlePrimaryNavChange(name === "本地直聊" ? "chat" : "tuning")}
                      className="px-3 py-1.5 rounded-lg border border-slate-600 bg-slate-800 hover:bg-slate-700 text-xs"
                    >
                      {name}
                    </button>
                  ))}
                  <button
                    onClick={() => handlePrimaryNavChange("repair")}
                    className="px-3 py-1.5 rounded-lg border border-amber-600 bg-amber-900/20 hover:bg-amber-900/30 text-xs text-amber-200"
                  >
                    出问题了？前往修复中心
                  </button>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <h3 className="text-lg font-semibold">环境准备</h3>
                <p className="text-sm text-slate-400 mt-1">下面保留完整环境检查与修复能力，给首次安装和排障使用。</p>
              </div>
              <div className="flex gap-2 flex-wrap">
                <button
                  onClick={() => handleStepChange(1)}
                  className="px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-sm"
                >
                  查看安装页
                </button>
                <button
                  onClick={() => handleStepChange(2)}
                  className="px-3 py-2 rounded-lg bg-sky-700 hover:bg-sky-600 text-sm"
                >
                  去 AI 服务配置
                </button>
              </div>
            </div>
            {checking ? (
              <div className="flex items-center gap-2 text-slate-400">
                <Loader2 className="w-5 h-5 animate-spin" />
                正在检测...
              </div>
            ) : (
              <div className="space-y-4">
                <EnvItem
                  result={nodeCheck!}
                  type="node"
                  onFix={handleFix}
                  fixing={fixing}
                />
                <EnvItem
                  result={npmCheck!}
                  type="npm"
                  onFix={handleFix}
                  fixing={fixing}
                />
                <EnvItem
                  result={gitCheck!}
                  type="git"
                  onFix={handleFix}
                  fixing={fixing}
                  warnOnly
                />
                <EnvItem
                  result={openclawCheck!}
                  type="openclaw"
                  onFix={handleFix}
                  fixing={fixing}
                />
              </div>
            )}
            {fixResult && (
              <div className="bg-slate-800 rounded-lg p-4 text-sm">
                <p className="text-slate-300">{fixResult}</p>
              </div>
            )}
            {!nodeCheck?.ok && (
              <div className="bg-amber-900/30 border border-amber-700 rounded-lg p-4">
                <p className="text-amber-200 text-sm">
                  请先安装 Node.js 22+，下载地址：
                  <button
                    onClick={() => openUrl("https://nodejs.org")}
                    className="ml-2 text-emerald-400 hover:underline flex items-center gap-1"
                  >
                    nodejs.org <ExternalLink className="w-3 h-3" />
                  </button>
                </p>
              </div>
            )}
            {openclawCheck?.ok && npmPathInPath === false && npmPath && (
              <div className="bg-amber-900/30 border border-amber-700 rounded-lg p-4 space-y-3">
                <p className="text-amber-200 text-sm">
                  <strong>PATH 未配置：</strong>
                  <code className="ml-1 text-amber-100">{npmPath}</code> 未加入系统 PATH，
                  在 CMD 中可能无法直接运行 <code>openclaw</code> 命令。
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={async () => {
                      setAddingPath(true);
                      setPathAddResult(null);
                      try {
                        const msg = await invoke<string>("add_npm_to_path");
                        setPathAddResult(msg);
                        setNpmPathInPath(true);
                      } catch (e) {
                        setPathAddResult(`添加失败: ${e}`);
                      } finally {
                        setAddingPath(false);
                      }
                    }}
                    disabled={addingPath}
                    className="flex items-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 rounded-lg text-sm font-medium"
                  >
                    {addingPath ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        添加中...
                      </>
                    ) : (
                      <>
                        <Key className="w-4 h-4" />
                        一键添加 PATH
                      </>
                    )}
                  </button>
                </div>
                {pathAddResult && (
                  <p className="text-emerald-200 text-sm">{pathAddResult}</p>
                )}
              </div>
            )}
            <button
              onClick={() => runEnvCheck()}
              disabled={checking}
              className="text-slate-400 hover:text-white text-sm"
            >
              重新检测
            </button>
          </div>
        )}

        {/* Step 1: 安装 OpenClaw */}
        {step === 1 && (
          <div className="w-full max-w-[1200px] mx-auto space-y-6">
            <h2 className="text-lg font-semibold">安装 OpenClaw</h2>
            <div className="bg-slate-800/50 rounded-lg p-4 text-sm text-slate-300 space-y-2">
              <p className="font-medium text-slate-200">本地 OpenClaw 管理</p>
              <p>状态：{localInfo?.installed ? "已安装" : "未安装"}</p>
              <p>路径：{localInfo?.install_dir || "未检测到"}</p>
              <p>版本：{localInfo?.version || "未知"}</p>
              <div className="flex gap-2">
                <button
                  onClick={() => refreshLocalInfo()}
                  disabled={installing || uninstalling}
                  className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded text-xs"
                >
                  刷新状态
                </button>
                <button
                  onClick={handleUpdateOpenclaw}
                  disabled={installing || uninstalling || !localInfo?.install_dir}
                  className="px-3 py-1.5 bg-indigo-700 hover:bg-indigo-600 disabled:opacity-50 rounded text-xs"
                >
                  {installing && openclawManageMode === "update" ? "更新中..." : "一键更新"}
                </button>
                <button
                  onClick={handleUninstall}
                  disabled={installing || uninstalling || !localInfo?.install_dir}
                  className="px-3 py-1.5 bg-red-700 hover:bg-red-600 disabled:opacity-50 rounded text-xs"
                >
                  {uninstalling ? "卸载中..." : "一键卸载"}
                </button>
              </div>
            </div>
            {uninstallLog.length > 0 && (
              <pre className="bg-slate-800 rounded-lg p-4 text-sm overflow-auto max-h-40 whitespace-pre-wrap">
                {uninstallLog.join("\n")}
              </pre>
            )}
            {installing && (
              <div className="space-y-2">
                <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
                  <div
                    className="h-full w-1/3 bg-emerald-500 rounded-full"
                    style={{ animation: "shimmer 1.5s ease-in-out infinite" }}
                  />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="bg-slate-800/60 rounded-lg p-3 border border-slate-700">
                    <p className="text-slate-300 text-sm font-medium mb-2">简洁模式（只看步骤）</p>
                    <div className="space-y-2">
                      {installSteps.map((s) => (
                        <div
                          key={s.key}
                          className={`rounded-lg px-3 py-2 text-sm border ${
                            s.status === "done"
                              ? "bg-emerald-900/20 border-emerald-700 text-emerald-300"
                              : s.status === "running"
                                ? "bg-sky-900/20 border-sky-700 text-sky-300"
                                : s.status === "error"
                                  ? "bg-red-900/20 border-red-700 text-red-300"
                                  : "bg-slate-800 border-slate-700 text-slate-400"
                          }`}
                        >
                          {s.status === "done"
                            ? "✓ "
                            : s.status === "running"
                              ? "⟳ "
                              : s.status === "error"
                                ? "✗ "
                                : "• "}
                          {s.label}
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="bg-slate-800/60 rounded-lg p-3 border border-slate-700">
                    <p className="text-slate-300 text-sm font-medium mb-2">高级模式（完整日志）</p>
                    <pre
                      className="text-sm overflow-auto max-h-48 font-mono text-slate-300"
                      ref={logEndRef}
                    >
                      {installLog.length > 0
                        ? installLog.join("\n")
                        : openclawManageMode === "update"
                          ? "正在准备更新..."
                          : "正在准备安装..."}
                    </pre>
                  </div>
                </div>
              </div>
            )}
            {openclawCheck?.ok ? (
              <div className="bg-emerald-900/30 border border-emerald-700 rounded-lg p-4">
                <p className="text-emerald-200">OpenClaw 已安装，可直接进入下一步配置。</p>
              </div>
            ) : (
              <>
                {!envReady && (
                  <div className="bg-amber-900/30 border border-amber-700 rounded-lg p-3 text-amber-200 text-sm">
                    请先在「环境检测」页面安装 Node.js 和 npm；若已安装，请从开始菜单重新打开本应用。
                  </div>
                )}
                <p className="text-slate-400">默认安装到：{recommendedInstallDir || "C:/Users/你的账号/openclaw"}</p>
                <button
                  onClick={handleInstallDefault}
                  disabled={installing || uninstalling || !envReady}
                  className="flex items-center justify-center gap-2 px-6 py-4 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg font-medium"
                >
                  {installing ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      {openclawManageMode === "update" ? "更新中..." : "安装中..."}
                    </>
                  ) : (
                    <>
                      <Download className="w-5 h-5" />
                      一键安装 OpenClaw（默认目录）
                    </>
                  )}
                </button>
              </>
            )}
            {installResult && !installing && (
              <pre className="bg-slate-800 rounded-lg p-4 text-sm overflow-auto max-h-40 whitespace-pre-wrap">
                {installResult}
              </pre>
            )}
          </div>
        )}

        {/* Step 2: 配置 AI 模型 */}
        {step === 2 && (
          <div className="w-full max-w-[1200px] mx-auto space-y-6">
            <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-6">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="space-y-2">
                  <p className="text-xs uppercase tracking-[0.2em] text-sky-300">AI 服务配置</p>
                  <h2 className="text-2xl font-semibold text-white">AI 服务中心</h2>
                  <p className="text-sm text-slate-300 max-w-2xl">
                    先选服务渠道，再选模型方案，填入密钥并验证通过。默认只保留小白真正需要的接入动作。
                  </p>
                </div>
                <div className="rounded-xl border border-slate-700 bg-slate-900/70 px-4 py-3 text-sm text-slate-300 min-w-[260px]">
                  <p className="text-slate-100 font-medium mb-1">接入状态</p>
                  <p>服务渠道：{currentAiServiceLabel}</p>
                  <p>当前模型：{selectedModel || "未选择"}</p>
                  <p className={aiReady ? "text-emerald-300 mt-2" : "text-amber-300 mt-2"}>
                    {aiReady ? "已接入，可直接开始聊天" : "尚未完成接入"}
                  </p>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-[1.5fr_0.9fr] gap-6">
              <div className="space-y-4">
                <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-5 space-y-4">
                  <div>
                    <p className="text-sm font-medium text-slate-100">服务渠道选择</p>
                    <p className="text-xs text-slate-400 mt-1">当前先固定硅基流动和 Kimi，后面可自然扩展到你的官方线路。</p>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    {AI_SERVICE_OPTIONS.map((option) => {
                      const selected =
                        (option.id === "kimi" && provider === "kimi") ||
                        (option.id === "openai" && provider !== "kimi");
                      const disabled = option.id === "official";
                      return (
                        <button
                          key={option.id}
                          disabled={disabled}
                          onClick={() => {
                            if (option.id === "official") return;
                            if (option.id === "kimi") {
                              setProvider("kimi");
                              setBaseUrl(DEFAULT_KIMI_BASE_URL);
                              setSelectedModel("moonshotai/Kimi-K2-Instruct-0905");
                            } else {
                              setProvider("openai");
                              setBaseUrl(DEFAULT_OPENAI_BASE_URL);
                              setSelectedModel(RECOMMENDED_MODEL_FALLBACK);
                            }
                          }}
                          className={`rounded-xl border p-4 text-left transition ${
                            disabled
                              ? "border-slate-800 bg-slate-900/60 text-slate-500 cursor-not-allowed"
                              : selected
                                ? "border-sky-500 bg-sky-900/30 text-sky-100"
                                : "border-slate-700 bg-slate-900/50 hover:border-slate-500 text-slate-200"
                          }`}
                        >
                          <p className="font-medium">{option.label}</p>
                          <p className="text-xs mt-2 opacity-80">{option.desc}</p>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-5 space-y-4">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div>
                      <p className="text-sm font-medium text-slate-100">模型方案选择</p>
                      <p className="text-xs text-slate-400 mt-1">默认展示固定低成本模型，先保证稳定、便宜、能跑通。</p>
                    </div>
                    <span className="text-xs text-slate-500">当前渠道：{currentAiServiceLabel}</span>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {visibleAiModels.map((model, index) => (
                      <button
                        key={model.id}
                        onClick={() => setSelectedModel(model.id)}
                        className={`rounded-xl border p-4 text-left transition ${
                          selectedModel === model.id
                            ? "border-emerald-500 bg-emerald-900/25 text-emerald-100"
                            : "border-slate-700 bg-slate-900/50 hover:border-slate-500 text-slate-200"
                        }`}
                      >
                        <p className="font-medium">{model.label}</p>
                        <p className="text-xs mt-2 text-slate-400">
                          {index === 0 ? "默认推荐，适合大多数用户" : provider === "kimi" ? "长文本问答更稳" : "便宜模型，适合高频使用"}
                        </p>
                      </button>
                    ))}
                  </div>
                  {selectedModel && (() => {
                    const inferred = inferModelContextWindow(selectedModel);
                    if (inferred !== null && inferred < 16000) {
                      return (
                        <p className="text-amber-300 text-xs">
                          当前模型推断窗口约 {inferred}，低于系统最低 16000，保存时会被拦截。
                        </p>
                      );
                    }
                    if (inferred !== null) {
                      return <p className="text-emerald-300 text-xs">当前模型推断窗口约 {inferred}。</p>;
                    }
                    return <p className="text-slate-500 text-xs">当前模型窗口未知，建议优先使用默认推荐模型。</p>;
                  })()}
                </div>

                <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-5 space-y-4">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div>
                      <p className="text-sm font-medium text-slate-100">接入密钥</p>
                      <p className="text-xs text-slate-400 mt-1">先选入口方式，再继续输入和验证。</p>
                    </div>
                    <div className="flex gap-2 flex-wrap text-xs">
                      <button
                        type="button"
                        onClick={() => setApiEntryMode("own")}
                        className={`px-3 py-1.5 rounded-lg border ${apiEntryMode === "own" ? "border-emerald-500 bg-emerald-700/25 text-emerald-100" : "border-slate-700 bg-slate-900/50 text-slate-300"}`}
                      >
                        我已经有 API Key
                      </button>
                      <button
                        type="button"
                        onClick={() => setApiEntryMode("relay")}
                        className={`px-3 py-1.5 rounded-lg border ${apiEntryMode === "relay" ? "border-sky-500 bg-sky-700/25 text-sky-100" : "border-slate-700 bg-slate-900/50 text-slate-300"}`}
                      >
                        去中转站获取 API Key
                      </button>
                    </div>
                  </div>

                  {apiEntryMode === "undecided" && (
                    <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-4 space-y-3">
                      <p className="text-sm text-slate-200">先选一个入口：</p>
                      <div className="flex gap-2 flex-wrap">
                        <button
                          type="button"
                          onClick={() => setApiEntryMode("own")}
                          className="px-3 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-sm"
                        >
                          我已经有 API Key
                        </button>
                        <button
                          type="button"
                          onClick={() => setApiEntryMode("relay")}
                          className="px-3 py-2 rounded-lg bg-sky-700 hover:bg-sky-600 text-sm"
                        >
                          去中转站获取 API Key
                        </button>
                      </div>
                    </div>
                  )}

                  {apiEntryMode === "relay" && (
                    <div className="rounded-xl border border-sky-700/60 bg-sky-950/20 p-4 space-y-3">
                      <div>
                        <p className="text-sm font-medium text-sky-100">中转站入口</p>
                        <p className="text-xs text-sky-200/80 mt-1">把你的中转站链接填在这里，按钮会直接打开它。</p>
                      </div>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={relayStationUrl}
                          onChange={(e) => setRelayStationUrl(e.target.value)}
                          placeholder={DEFAULT_RELAY_STATION_URL || "https://..."}
                          className="flex-1 bg-slate-900 border border-slate-600 rounded-lg px-4 py-3"
                        />
                        <button
                          type="button"
                          onClick={async () => {
                            const url = relayStationUrl.trim();
                            if (!url) return;
                            try {
                              await openUrl(url);
                            } catch (error) {
                              console.error("failed to open relay station", error);
                              setModelTestResult("中转站链接打开失败，请检查网址是否正确。");
                            }
                          }}
                          disabled={!relayStationUrl.trim()}
                          className="px-4 py-2 rounded-lg bg-sky-700 hover:bg-sky-600 disabled:opacity-50 text-sm"
                        >
                          打开
                        </button>
                      </div>
                      <p className="text-xs text-slate-400">拿到 Key 之后，再切回“我已经有 API Key”。</p>
                      <button
                        type="button"
                        onClick={() => setApiEntryMode("own")}
                        className="px-3 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-sm"
                      >
                        我已拿到 Key，去填写
                      </button>
                    </div>
                  )}

                  {apiEntryMode !== "relay" && (
                    <div className="space-y-3">
                      <div className="flex gap-2">
                        <input
                          type={showApiKey ? "text" : "password"}
                          value={apiKey}
                          onChange={(e) => setApiKey(e.target.value)}
                          placeholder={provider === "kimi" ? "输入你的 Kimi API Key" : "输入你的硅基流动 API Key"}
                          className="flex-1 bg-slate-900 border border-slate-600 rounded-lg px-4 py-3"
                        />
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              const text = await navigator.clipboard.readText();
                              if (text) setApiKey(text);
                            } catch {}
                          }}
                          className="px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-xs"
                        >
                          粘贴
                        </button>
                        <button
                          type="button"
                          onClick={() => setShowApiKey((prev) => !prev)}
                          className="px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-xs"
                        >
                          {showApiKey ? "隐藏" : "显示"}
                        </button>
                      </div>
                      <div className="flex gap-2 flex-wrap">
                        <button
                          onClick={handleTestModel}
                          disabled={modelTesting || cleaningLegacy}
                          className="flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded-lg text-sm font-medium"
                        >
                          {modelTesting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wrench className="w-4 h-4" />}
                          验证密钥
                        </button>
                        <button
                          onClick={handleSaveConfig}
                          disabled={saving || modelTesting || cleaningLegacy}
                          className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-sm font-medium"
                        >
                          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Key className="w-4 h-4" />}
                          保存并启用服务
                        </button>
                        <button
                          onClick={() => handlePrimaryNavChange("chat")}
                          className="px-4 py-2 bg-sky-700 hover:bg-sky-600 rounded-lg text-sm font-medium"
                        >
                          立即开始试聊
                        </button>
                      </div>
                    </div>
                  )}

                  {apiEntryMode === "own" && (
                    <p className="text-xs text-slate-400">如果你已经有自己的 Key，直接填入即可；不会强制去中转站。</p>
                  )}

                  {saveResult && (
                    <p className={`text-sm ${saveResult.startsWith("错误") ? "text-red-400" : "text-emerald-400"}`}>
                      {saveResult}
                    </p>
                  )}
                  {modelTestResult && (
                    <p className={`text-sm ${modelTestResult.includes("通过") ? "text-emerald-400" : "text-amber-300"}`}>
                      {modelTestResult}
                    </p>
                  )}
                  {savedAiHint && <p className="text-sky-300 text-sm">{savedAiHint}</p>}
                </div>

                <details
                  open={showAiAdvancedSettings}
                  onToggle={(e) => setShowAiAdvancedSettings((e.target as HTMLDetailsElement).open)}
                  className="rounded-2xl border border-slate-700 bg-slate-800/40 p-5"
                >
                  <summary className="cursor-pointer text-sm font-medium text-slate-200">高级选项</summary>
                  <div className="space-y-4 mt-4">
                    <div>
                      <label className="block text-sm font-medium mb-2">运行时 Provider</label>
                      <select
                        value={provider}
                        onChange={(e) => setProvider(e.target.value)}
                        className="w-full bg-slate-900 border border-slate-600 rounded-lg px-4 py-2"
                      >
                        <option value="openai">OpenAI 兼容</option>
                        <option value="kimi">Kimi</option>
                        <option value="deepseek">DeepSeek</option>
                        <option value="qwen">通义千问</option>
                        <option value="bailian">阿里云百炼</option>
                        <option value="anthropic">Anthropic Claude</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-2">自定义 API 地址</label>
                      <input
                        type="text"
                        value={baseUrl}
                        onChange={(e) => setBaseUrl(e.target.value)}
                        placeholder={DEFAULT_OPENAI_BASE_URL}
                        className="w-full bg-slate-900 border border-slate-600 rounded-lg px-4 py-2"
                      />
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-sm font-medium mb-2">网络代理 URL</label>
                        <input
                          type="text"
                          value={proxyUrl}
                          onChange={(e) => setProxyUrl(e.target.value)}
                          placeholder="http://127.0.0.1:7890"
                          className="w-full bg-slate-900 border border-slate-600 rounded-lg px-4 py-2"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium mb-2">NO_PROXY</label>
                        <input
                          type="text"
                          value={noProxy}
                          onChange={(e) => setNoProxy(e.target.value)}
                          placeholder="127.0.0.1,localhost,.local"
                          className="w-full bg-slate-900 border border-slate-600 rounded-lg px-4 py-2"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-2">自定义配置路径</label>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={customConfigPath}
                          onChange={(e) => setCustomConfigPath(e.target.value)}
                          placeholder="留空使用 ~/.openclaw"
                          className="flex-1 bg-slate-900 border border-slate-600 rounded-lg px-4 py-2"
                        />
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              const p = await invoke<string | null>("detect_openclaw_config_path");
                              if (p && isLikelyConfigPath(p)) setCustomConfigPath(p);
                            } catch {}
                          }}
                          className="px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm whitespace-nowrap"
                        >
                          自动检测
                        </button>
                      </div>
                    </div>
                    <button
                      onClick={handleCleanupLegacyCache}
                      disabled={cleaningLegacy || modelTesting || saving}
                      className="flex items-center gap-2 px-4 py-2 bg-amber-700 hover:bg-amber-600 disabled:opacity-50 rounded-lg text-sm font-medium"
                    >
                      {cleaningLegacy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wrench className="w-4 h-4" />}
                      一键清理历史 Provider 缓存
                    </button>
                  </div>
                </details>
              </div>

              <div className="space-y-4">
                <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-5 space-y-3" style={heavyPanelStyle}>
                  <p className="text-sm font-medium text-slate-100">当前选择摘要</p>
                  <div className="text-sm text-slate-300 space-y-2">
                    <p>服务渠道：{currentAiServiceLabel}</p>
                    <p>当前模型：{selectedModel || "未选择"}</p>
                    <p>推荐场景：{provider === "kimi" ? "长文本问答" : "高频聊天 / 代码 / 日常使用"}</p>
                    <p className={aiReady ? "text-emerald-300" : "text-amber-300"}>{aiReady ? "状态：已配置" : "状态：待测试"}</p>
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-5 space-y-3" style={heavyPanelStyle}>
                  <p className="text-sm font-medium text-slate-100">推荐组合</p>
                  <div className="space-y-2 text-xs text-slate-300">
                    <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-3">
                      <p className="font-medium text-slate-100">新手推荐</p>
                      <p className="mt-1 text-slate-400">硅基流动 + 默认推荐模型，先用最低决策成本跑通。</p>
                    </div>
                    <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-3">
                      <p className="font-medium text-slate-100">性价比推荐</p>
                      <p className="mt-1 text-slate-400">适合高频聊天，优先控制 API 成本。</p>
                    </div>
                    <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-3">
                      <p className="font-medium text-slate-100">代码推荐</p>
                      <p className="mt-1 text-slate-400">优先选你的主推代码模型，后续可平滑迁到官方线路。</p>
                    </div>
                  </div>
                </div>

                {(runtimeModelInfo || keySyncStatus || runtimeProbeResult) && (
                  <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-5 space-y-3" style={heavyPanelStyle}>
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-medium text-slate-100">运行时诊断</p>
                      <button
                        onClick={() => probeRuntimeModelConnection()}
                        disabled={runtimeProbeLoading}
                        className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-slate-200 text-xs"
                      >
                        {runtimeProbeLoading ? "探活中..." : "立即探活"}
                      </button>
                    </div>
                    {runtimeModelInfo && (
                      <div className="text-xs text-slate-300 space-y-1">
                        <p>当前生效模型：{runtimeModelInfo.model || "未知"}</p>
                        <p>当前生效接口：{runtimeModelInfo.provider_api || "未知"}</p>
                        <p>当前生效地址：{runtimeModelInfo.base_url || "未知"}</p>
                        <p>当前生效 Key 前缀：{runtimeModelInfo.key_prefix || "未读取到"}</p>
                      </div>
                    )}
                    {keySyncStatus && (
                      <div className="text-xs space-y-1">
                        <p className={keySyncStatus.synced ? "text-emerald-300" : "text-amber-300"}>
                          Key 同步状态：{keySyncStatus.synced ? "已同步" : "未同步"}
                        </p>
                        <p className="text-slate-300">openclaw.json：{keySyncStatus.openclaw_json_key_prefix || "未读取到"}</p>
                        <p className="text-slate-300">env：{keySyncStatus.env_key_prefix || "未读取到"}</p>
                        <p className="text-slate-300">auth-profiles：{keySyncStatus.auth_profile_key_prefix || "未读取到"}</p>
                        <p className="text-slate-500">{keySyncStatus.detail}</p>
                      </div>
                    )}
                    {runtimeProbeResult && (
                      <p className={`text-xs ${runtimeProbeResult.includes("通过") ? "text-emerald-400" : "text-amber-300"}`}>
                        {runtimeProbeResult}
                      </p>
                    )}
                  </div>
                )}

              </div>
            </div>
          </div>
        )}

        {step === 3 && !heavyPageShellPending && (
          <Suspense
            fallback={
              <div className="w-full max-w-[1200px] mx-auto order-1">
                <div className="rounded-2xl border border-slate-700 bg-slate-800/40 p-6 text-sm text-slate-400">
                  正在切换聊天页...
                </div>
              </div>
            }
          >
            <ChatPage
              starting={starting}
              startupMigrationResult={startupMigrationResult}
              deploySuccessDialog={DEPLOY_SUCCESS_DIALOG}
              agents={chatAgents}
              selectedAgentId={selectedAgentId}
              unreadByAgent={unreadByAgent}
              previewByAgent={chatPreviewByAgent}
              chatLoading={chatLoading}
              chatSending={selectedChatSending}
              chatError={chatError}
              routeHint={routeHint}
              messages={selectedChatMessages}
              renderLimit={selectedChatRenderLimit}
              historyLoaded={selectedChatHistoryLoaded}
              cacheHydrating={chatCacheHydrating}
              chatStickBottom={selectedChatStickBottom}
              pendingReply={selectedChatSending}
              chatViewportRef={chatViewportRef}
              gatewayOptionsByAgent={chatGatewayOptionsByAgent}
              preferredGatewayByAgent={preferredGatewayByAgent}
              onStart={handleStart}
              onOpenBrowserChat={handleOpenBrowserChat}
              onSelectAgent={handleSelectAgentForChat}
              onNewSession={handleNewSessionLocal}
              onClearSession={handleNewSessionLocal}
              onAbort={handleAbortChat}
              onLoadHistory={handleLoadSelectedChatHistory}
              onSend={handleSendChat}
              onTypingActivity={handleChatTypingActivity}
              onViewportScroll={handleChatViewportScroll}
              getAgentSpecialty={getAgentSpecialty}
              getChannelDisplayName={getChannelDisplayName}
              onPreferredGatewayChange={(agentId, gatewayId) =>
                setPreferredGatewayByAgent((prev) => ({ ...prev, [agentId]: gatewayId }))
              }
            />
          </Suspense>
        )}
        {step === 3 && heavyPageShellPending && (
          <div className="w-full max-w-[1200px] mx-auto order-1">
            <div className="rounded-2xl border border-slate-700 bg-slate-800/40 p-6 text-sm text-slate-400">
              正在切换聊天页...
            </div>
          </div>
        )}

        {step === 4 && !heavyPageShellPending && (
          <div className="w-full max-w-[1200px] mx-auto space-y-6" style={heavyPanelStyle}>
            <div className="rounded-2xl border border-slate-700 bg-slate-800/40 p-5">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="space-y-2">
                  <p className="text-xs uppercase tracking-[0.2em] text-sky-300">{currentPrimaryNav === "repair" ? "Repair" : "Tuning"}</p>
                  <h2 className="text-2xl font-semibold text-white">{tuningPageTitle}</h2>
                  <p className="text-sm text-slate-400 max-w-2xl">
                    {currentPrimaryNav === "repair"
                      ? "集中查看环境、Gateway、Skills 与渠道问题。这里负责体检、修复和导出诊断。"
                      : "这里负责 Agent、渠道、Skills 与记忆等持续配置，默认只保留对小白最重要的入口。"}
                  </p>
                </div>
                {currentPrimaryNav === "repair" ? (
                  <div className="flex gap-2 flex-wrap">
                    <button
                      onClick={() => void handleTuningHealthCheck()}
                      disabled={tuningActionLoading === "check"}
                      className="px-3 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-sm"
                    >
                      {tuningActionLoading === "check" ? "体检中..." : "一键体检"}
                    </button>
                    <button
                      onClick={() => void handleTuningSelfHeal()}
                      disabled={tuningActionLoading === "heal"}
                      className="px-3 py-2 rounded-lg bg-amber-700 hover:bg-amber-600 disabled:opacity-50 text-sm"
                    >
                      {tuningActionLoading === "heal" ? "修复中..." : "一键修复"}
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {TUNING_NAV_ITEMS.map((tab) => (
                      <button
                        key={tab.id}
                        onClick={() => {
                          setTuningSection(
                            tab.section as "quick" | "scene" | "personal" | "memory" | "health" | "skills" | "agents" | "control"
                          );
                          if (tab.section === "agents") {
                            setAgentCenterTab((tab.agentTab as "overview" | "channels") || "overview");
                          }
                        }}
                        className={`px-3 py-1.5 rounded text-xs border ${
                          currentTuningNav === tab.id
                            ? "bg-sky-800/60 border-sky-600 text-sky-100"
                            : "bg-slate-700/60 border-slate-600 hover:bg-slate-700"
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {tuningSection === "agents" && (
              <Suspense fallback={<div className="text-slate-400 p-4 text-sm">加载中...</div>}>
                <TuningAgentsSection ctx={tuningAgentsCtx} />
              </Suspense>
            )}

            {tuningSection === "control" && (
            <div className="space-y-4">
              <div className="bg-slate-800/50 rounded-lg p-4 space-y-3">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <p className="font-medium text-slate-200">桌面端网关行为</p>
                    <p className="text-xs text-slate-400 mt-1">
                      默认仍是静默后台启动；这里只管关闭软件时要不要顺手停掉全部网关。
                    </p>
                  </div>
                  <label className="flex items-center gap-2 text-xs text-slate-200">
                    <input
                      type="checkbox"
                      checked={autoStopGatewaysOnClose}
                      onChange={(e) => setAutoStopGatewaysOnClose(e.target.checked)}
                    />
                    关闭软件时自动停止所有网关
                  </label>
                </div>
                <p className="text-[11px] text-slate-500">
                  默认关闭。开启后，退出桌面端会先停止当前已配置网关，再关闭程序；如果只是想看网关输出，请到渠道页点“前台查看网关”。
                </p>
              </div>
              <div className="bg-slate-800/50 rounded-lg p-4 space-y-3">
                <p className="font-medium text-slate-200">高级设置入口</p>
                <p className="text-xs text-slate-400">
                  小白默认只用前面的 Agent、渠道、Skills 和记忆。这里收纳更偏进阶的模型策略、个性调教和控制平面。
                </p>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <button
                    onClick={() => setTuningSection("quick")}
                    className="rounded-lg border border-slate-700 bg-slate-900/40 p-3 text-left hover:border-slate-500"
                  >
                    <p className="text-sm text-slate-100 font-medium">模型策略</p>
                    <p className="text-[11px] text-slate-400 mt-1">稳定 / 均衡 / 高性能，适合先做全局推荐配置。</p>
                  </button>
                  <button
                    onClick={() => setTuningSection("personal")}
                    className="rounded-lg border border-slate-700 bg-slate-900/40 p-3 text-left hover:border-slate-500"
                  >
                    <p className="text-sm text-slate-100 font-medium">个性调教</p>
                    <p className="text-[11px] text-slate-400 mt-1">回答长度、语气风格、主动性、执行权限等细调。</p>
                  </button>
                  <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-3 text-left">
                    <p className="text-sm text-slate-100 font-medium">控制平面</p>
                    <p className="text-[11px] text-slate-400 mt-1">更偏专家模式，包含 Orchestrator、DAG、Ticket 等能力。</p>
                  </div>
                </div>
              </div>
              <div className="bg-slate-800/50 rounded-lg p-4 space-y-3">
                <p className="font-medium text-slate-200">控制平面（Orchestrator / DAG / Ticket / Memory / Sandbox / Verifier）</p>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={handleSeedControlPlane}
                    disabled={cpLoading}
                    className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 rounded text-xs"
                  >
                    初始化示例数据
                  </button>
                  <button
                    onClick={loadControlPlaneOverview}
                    disabled={cpLoading}
                    className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded text-xs"
                  >
                    刷新总览
                  </button>
                </div>
                {cpResult && <p className="text-xs text-emerald-300 whitespace-pre-wrap">{cpResult}</p>}
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="bg-slate-800/40 rounded-lg p-4 space-y-2">
                  <p className="text-sm font-medium text-slate-200">总控编排 + 验收器</p>
                  <input
                    value={cpTaskTitle}
                    onChange={(e) => setCpTaskTitle(e.target.value)}
                    placeholder="任务标题"
                    className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-xs"
                  />
                  <textarea
                    value={cpTaskInput}
                    onChange={(e) => setCpTaskInput(e.target.value)}
                    rows={3}
                    placeholder="输入任务，例如：抓取天气并生成日报后发送到钉钉"
                    className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-xs resize-none"
                  />
                  <div className="flex gap-2">
                    <button onClick={handleOrchestratorSubmit} disabled={cpLoading} className="px-3 py-1.5 bg-sky-700 hover:bg-sky-600 rounded text-xs disabled:opacity-50">提交任务</button>
                  </div>
                  <textarea
                    value={cpVerifierOutput}
                    onChange={(e) => setCpVerifierOutput(e.target.value)}
                    rows={3}
                    placeholder="Verifier 待检输出"
                    className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-xs resize-none"
                  />
                  <textarea
                    value={cpVerifierConstraints}
                    onChange={(e) => setCpVerifierConstraints(e.target.value)}
                    rows={2}
                    placeholder="每行一个约束"
                    className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-xs resize-none"
                  />
                  <button onClick={handleVerifierCheck} disabled={cpLoading} className="px-3 py-1.5 bg-indigo-700 hover:bg-indigo-600 rounded text-xs disabled:opacity-50">执行验收</button>
                  {cpVerifierReport && (
                    <p className={`text-xs ${cpVerifierReport.passed ? "text-emerald-300" : "text-amber-300"}`}>
                      结果：{cpVerifierReport.passed ? "通过" : "不通过"} / score={cpVerifierReport.score.toFixed(2)} / {cpVerifierReport.reasons.join("；")}
                    </p>
                  )}
                </div>

                <div className="bg-slate-800/40 rounded-lg p-4 space-y-2">
                  <p className="text-sm font-medium text-slate-200">技能流水线（Skill Graph DAG）</p>
                  <input value={cpGraphName} onChange={(e) => setCpGraphName(e.target.value)} className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-xs" />
                  <textarea value={cpGraphNodesJson} onChange={(e) => setCpGraphNodesJson(e.target.value)} rows={4} className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-xs font-mono resize-none" />
                  <textarea value={cpGraphEdgesJson} onChange={(e) => setCpGraphEdgesJson(e.target.value)} rows={3} className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-xs font-mono resize-none" />
                  <div className="flex gap-2">
                    <button onClick={handleSaveSkillGraph} disabled={cpLoading} className="px-3 py-1.5 bg-sky-700 hover:bg-sky-600 rounded text-xs disabled:opacity-50">保存DAG</button>
                    <select value={cpSelectedGraphId} onChange={(e) => setCpSelectedGraphId(e.target.value)} className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs">
                      <option value="">选择技能图</option>
                      {cpGraphs.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </select>
                    <button onClick={handleExecuteSkillGraph} disabled={cpLoading || !cpSelectedGraphId} className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 rounded text-xs disabled:opacity-50">执行DAG</button>
                  </div>
                </div>

                <div className="bg-slate-800/40 rounded-lg p-4 space-y-2">
                  <p className="text-sm font-medium text-slate-200">跨渠道工单 + 分层记忆</p>
                  <div className="grid grid-cols-2 gap-2">
                    <input value={cpTicketChannel} onChange={(e) => setCpTicketChannel(e.target.value)} placeholder="channel" className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs" />
                    <input value={cpTicketExternalRef} onChange={(e) => setCpTicketExternalRef(e.target.value)} placeholder="external_ref" className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs" />
                  </div>
                  <input value={cpTicketTitle} onChange={(e) => setCpTicketTitle(e.target.value)} placeholder="ticket title" className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs" />
                  <textarea value={cpTicketPayload} onChange={(e) => setCpTicketPayload(e.target.value)} rows={2} className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs font-mono resize-none" />
                  <button onClick={handleCreateTicket} disabled={cpLoading} className="px-3 py-1.5 bg-sky-700 hover:bg-sky-600 rounded text-xs disabled:opacity-50">创建工单</button>
                  <div className="grid grid-cols-3 gap-2">
                    <input value={cpMemoryLayer} onChange={(e) => setCpMemoryLayer(e.target.value)} placeholder="layer" className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs" />
                    <input value={cpMemoryScope} onChange={(e) => setCpMemoryScope(e.target.value)} placeholder="scope" className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs" />
                    <input value={cpMemoryTags} onChange={(e) => setCpMemoryTags(e.target.value)} placeholder="tags" className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs" />
                  </div>
                  <textarea value={cpMemoryContent} onChange={(e) => setCpMemoryContent(e.target.value)} rows={2} placeholder="记忆内容" className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs resize-none" />
                  <input value={cpMemoryRationale} onChange={(e) => setCpMemoryRationale(e.target.value)} placeholder="引用原因/解释" className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs" />
                  <button onClick={handleMemoryWriteLayered} disabled={cpLoading} className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 rounded text-xs disabled:opacity-50">写入记忆</button>
                </div>

                <div className="bg-slate-800/40 rounded-lg p-4 space-y-2">
                  <p className="text-sm font-medium text-slate-200">沙箱执行 + 辩论 + 快照 + PromptOps + 企业化</p>
                  <div className="grid grid-cols-2 gap-2">
                    <input value={cpSandboxActionType} onChange={(e) => setCpSandboxActionType(e.target.value)} placeholder="action_type" className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs" />
                    <input value={cpSandboxResource} onChange={(e) => setCpSandboxResource(e.target.value)} placeholder="resource" className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs" />
                  </div>
                  <div className="flex gap-2 items-center">
                    <button onClick={handleSandboxPreview} disabled={cpLoading} className="px-3 py-1.5 bg-sky-700 hover:bg-sky-600 rounded text-xs disabled:opacity-50">沙箱预览</button>
                    <label className="text-xs text-slate-300 flex items-center gap-1">
                      <input type="checkbox" checked={cpSandboxApproved} onChange={(e) => setCpSandboxApproved(e.target.checked)} />
                      已审批
                    </label>
                    <button onClick={handleSandboxExecute} disabled={cpLoading} className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 rounded text-xs disabled:opacity-50">执行沙箱</button>
                  </div>
                  {cpSandboxPreview && (
                    <p className="text-xs text-slate-300">风险: {cpSandboxPreview.risk_level} / 审批: {cpSandboxPreview.requires_approval ? "需要" : "无需"} / 计划: {cpSandboxPreview.plan.join(" -> ")}</p>
                  )}
                  <div className="flex gap-2">
                    <input value={cpDebateTask} onChange={(e) => setCpDebateTask(e.target.value)} className="flex-1 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs" />
                    <button onClick={handleDebateRun} disabled={cpLoading} className="px-3 py-1.5 bg-indigo-700 hover:bg-indigo-600 rounded text-xs disabled:opacity-50">辩论</button>
                  </div>
                  {cpDebateResult && (
                    <p className="text-xs text-slate-300">裁判: {cpDebateResult.judge_summary}</p>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    <input value={cpSnapshotTaskId} onChange={(e) => setCpSnapshotTaskId(e.target.value)} placeholder="snapshot task_id" className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs" />
                    <input value={cpSnapshotInput} onChange={(e) => setCpSnapshotInput(e.target.value)} placeholder="snapshot input" className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs" />
                  </div>
                  <input value={cpSnapshotTools} onChange={(e) => setCpSnapshotTools(e.target.value)} placeholder="tools csv" className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs" />
                  <input value={cpSnapshotConfig} onChange={(e) => setCpSnapshotConfig(e.target.value)} placeholder="snapshot config json" className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs font-mono" />
                  <button onClick={handleCreateSnapshot} disabled={cpLoading} className="px-3 py-1.5 bg-sky-700 hover:bg-sky-600 rounded text-xs disabled:opacity-50">创建快照</button>
                  <div className="grid grid-cols-3 gap-2">
                    <input value={cpPromptName} onChange={(e) => setCpPromptName(e.target.value)} placeholder="policy name" className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs" />
                    <input type="number" min={0} max={100} value={cpPromptTraffic} onChange={(e) => setCpPromptTraffic(Number(e.target.value))} className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs" />
                    <button onClick={handleCreatePromptVersion} disabled={cpLoading} className="px-3 py-1.5 bg-indigo-700 hover:bg-indigo-600 rounded text-xs disabled:opacity-50">建版本</button>
                  </div>
                  <input value={cpPromptRules} onChange={(e) => setCpPromptRules(e.target.value)} placeholder="rules json" className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs font-mono" />
                  <div className="grid grid-cols-3 gap-2">
                    <input value={cpRoleUserId} onChange={(e) => setCpRoleUserId(e.target.value)} placeholder="user_id" className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs" />
                    <input value={cpRoleName} onChange={(e) => setCpRoleName(e.target.value)} placeholder="role" className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs" />
                    <button onClick={handleSetRoleBinding} disabled={cpLoading} className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 rounded text-xs disabled:opacity-50">设角色</button>
                  </div>
                  <p className="text-xs text-slate-300 mt-2">能力注册表（模型 + 工具 + 专长）</p>
                  <div className="grid grid-cols-3 gap-2">
                    <input value={cpCapAgentId} onChange={(e) => setCpCapAgentId(e.target.value)} placeholder="agent_id" className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs" />
                    <input value={cpCapSpecialty} onChange={(e) => setCpCapSpecialty(e.target.value)} placeholder="specialty(code/sheet/...)" className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs" />
                    <input value={cpCapCostTier} onChange={(e) => setCpCapCostTier(e.target.value)} placeholder="cost_tier" className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs" />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <input value={cpCapPrimaryModel} onChange={(e) => setCpCapPrimaryModel(e.target.value)} placeholder="primary_model" className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs" />
                    <input value={cpCapFallbackModel} onChange={(e) => setCpCapFallbackModel(e.target.value)} placeholder="fallback_model" className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs" />
                  </div>
                  <input value={cpCapTools} onChange={(e) => setCpCapTools(e.target.value)} placeholder="tools csv" className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs" />
                  <input value={cpCapStrengths} onChange={(e) => setCpCapStrengths(e.target.value)} placeholder="strengths csv" className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs" />
                  <button onClick={handleUpsertCapability} disabled={cpLoading} className="px-3 py-1.5 bg-indigo-700 hover:bg-indigo-600 rounded text-xs disabled:opacity-50">更新能力画像</button>
                </div>
              </div>

              <div className="bg-slate-800/30 rounded-lg p-4 text-xs space-y-2">
                <p className="text-slate-200 font-medium">执行轨迹 / 数据总览</p>
                <p>任务: {cpTasks.length} · DAG: {cpGraphs.length} · 工单: {cpTickets.length} · 记忆: {cpMemory.length} · 快照: {cpSnapshots.length}</p>
                <p>Prompt版本: {cpPrompts.length} · 能力画像: {cpCapabilities.length} · 角色绑定: {cpRoles.length} · 审计: {cpAudit.length} · 成本统计: {cpCost ? `${cpCost.total_tokens} tokens` : "-"}</p>
                <div className="max-h-64 overflow-auto space-y-2">
                  {cpTasks.slice(0, 6).map((t) => (
                    <div key={t.id} className="border border-slate-700 rounded p-2">
                      <p className="text-slate-200">{t.title} · {t.status}</p>
                      <p className="text-slate-400 break-all">{t.id}</p>
                      {t.route_decision && (
                        <p className="text-sky-300">
                          路由：intent={t.route_decision.intent} {"->"} selected={t.route_decision.selected_agent} · {t.route_decision.explanation}
                        </p>
                      )}
                      <p className="text-slate-400">输出: {t.final_output || "-"}</p>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {(t.steps || []).map((s) => (
                          <button
                            key={s.id}
                            onClick={() => void handleRetryTaskStep(t.id, s.id)}
                            className="px-2 py-0.5 bg-slate-700 hover:bg-slate-600 rounded text-[11px]"
                          >
                            {s.name}:{s.status} (重试 {s.retry_count})
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="max-h-40 overflow-auto">
                  {cpTickets.slice(0, 8).map((tk) => (
                    <div key={tk.id} className="flex items-center justify-between border-b border-slate-700 py-1">
                      <span>{tk.channel} · {tk.title} · {tk.status}</span>
                      <div className="flex gap-1">
                        <button onClick={() => void handleUpdateTicket(tk.id, "in_progress")} className="px-2 py-0.5 bg-slate-700 rounded">受理</button>
                        <button onClick={() => void handleUpdateTicket(tk.id, "done")} className="px-2 py-0.5 bg-emerald-700 rounded">完成</button>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="max-h-36 overflow-auto">
                  {cpSnapshots.slice(0, 6).map((sp) => (
                    <div key={sp.id} className="flex items-center justify-between border-b border-slate-700 py-1">
                      <span className="truncate pr-2">{sp.id} · {sp.task_id}</span>
                      <button onClick={() => void handleReplaySnapshot(sp.id)} className="px-2 py-0.5 bg-indigo-700 rounded">回放</button>
                    </div>
                  ))}
                </div>
                <div className="max-h-36 overflow-auto">
                  {cpCapabilities.map((cap) => (
                    <div key={cap.agent_id} className="border-b border-slate-700 py-1">
                      <span>{cap.agent_id} · {cap.specialty} · {cap.primary_model} · tools:{cap.tools.join(",")}</span>
                    </div>
                  ))}
                </div>
                <div className="max-h-36 overflow-auto">
                  {cpPrompts.map((p) => (
                    <div key={p.id} className="flex items-center justify-between border-b border-slate-700 py-1">
                      <span>{p.name} · {p.traffic_percent}% · {p.active ? "active" : "inactive"}</span>
                      {!p.active && (
                        <button onClick={() => void handleActivatePromptVersion(p.id)} className="px-2 py-0.5 bg-sky-700 rounded">激活</button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
            )}

            {tuningSection === "quick" && (
            <div className="space-y-4">
              <div className="bg-slate-800/50 rounded-lg p-4 space-y-3">
                <p className="font-medium text-slate-200 flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-emerald-400" />
                  快速模式
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => applyQuickModePreset("stable")}
                    className={`px-3 py-1.5 rounded text-xs ${quickMode === "stable" ? "bg-emerald-700" : "bg-slate-700 hover:bg-slate-600"}`}
                  >
                    稳定模式（推荐）
                  </button>
                  <button
                    onClick={() => applyQuickModePreset("balanced")}
                    className={`px-3 py-1.5 rounded text-xs ${quickMode === "balanced" ? "bg-emerald-700" : "bg-slate-700 hover:bg-slate-600"}`}
                  >
                    均衡模式
                  </button>
                  <button
                    onClick={() => applyQuickModePreset("performance")}
                    className={`px-3 py-1.5 rounded text-xs ${quickMode === "performance" ? "bg-emerald-700" : "bg-slate-700 hover:bg-slate-600"}`}
                  >
                    高性能模式
                  </button>
                </div>
                <p className="text-xs text-slate-400">
                  当前快速模式会同步调整模型、记忆策略、执行权限。应用后请在第 2 步点击“保存配置”。
                </p>
              </div>

              <div className="bg-slate-800/50 rounded-lg p-4 space-y-3">
                <div>
                  <p className="font-medium text-slate-200">对话策略</p>
                  <p className="text-xs text-slate-400 mt-1">
                    聊天页已隐藏这些开关，避免小白在对话时反复切换。这里只保留给进阶用户统一设置。
                  </p>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <label className="text-xs space-y-1">
                    <span className="text-slate-400">默认路由方式</span>
                    <select value={routeMode} onChange={(e) => setRouteMode(e.target.value as "manual" | "auto")} className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1.5">
                      <option value="manual">固定当前 Agent</option>
                      <option value="auto">自动分配 Agent</option>
                    </select>
                  </label>
                  <label className="text-xs space-y-1">
                    <span className="text-slate-400">默认执行方式</span>
                    <select value={chatExecutionMode} onChange={(e) => setChatExecutionMode(e.target.value as "orchestrator" | "direct")} className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1.5">
                      <option value="direct">直连对话</option>
                      <option value="orchestrator">流程编排</option>
                    </select>
                  </label>
                </div>
                <p className="text-[11px] text-slate-500">
                  推荐默认保持“固定当前 Agent + 直连对话”。只有你明确要做多 Agent 自动分流时，再切到自动分配或流程编排。
                </p>
              </div>
            </div>
            )}

            {tuningSection === "scene" && (
            <div className="bg-slate-800/50 rounded-lg p-4 space-y-3">
              <p className="font-medium text-slate-200 flex items-center gap-2">
                <Brain className="w-4 h-4 text-sky-400" />
                场景模板
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-2">
                {[
                  { id: "customer_support" as ScenarioPreset, label: "客服回复" },
                  { id: "short_video" as ScenarioPreset, label: "短视频脚本" },
                  { id: "office" as ScenarioPreset, label: "办公文档" },
                  { id: "developer" as ScenarioPreset, label: "编程助手" },
                  { id: "none" as ScenarioPreset, label: "清空模板" },
                ].map((t) => (
                  <button
                    key={t.id}
                    onClick={() => applyScenarioPreset(t.id)}
                    className={`px-3 py-2 rounded text-xs border ${
                      scenarioPreset === t.id
                        ? "bg-sky-800/60 border-sky-600 text-sky-100"
                        : "bg-slate-700/60 border-slate-600 hover:bg-slate-700"
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
            )}

            {tuningSection === "personal" && (
            <div className="bg-slate-800/50 rounded-lg p-4 space-y-3">
              <p className="font-medium text-slate-200">个性调教</p>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                <label className="text-xs space-y-1">
                  <span className="text-slate-400">回答长度</span>
                  <select value={tuneLength} onChange={(e) => setTuneLength(e.target.value as TuneLength)} className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1.5">
                    <option value="short">短</option>
                    <option value="medium">中</option>
                    <option value="long">长</option>
                  </select>
                </label>
                <label className="text-xs space-y-1">
                  <span className="text-slate-400">语气风格</span>
                  <select value={tuneTone} onChange={(e) => setTuneTone(e.target.value as TuneTone)} className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1.5">
                    <option value="professional">专业</option>
                    <option value="friendly">亲切</option>
                    <option value="concise">简洁</option>
                  </select>
                </label>
                <label className="text-xs space-y-1">
                  <span className="text-slate-400">主动性</span>
                  <select value={tuneProactivity} onChange={(e) => setTuneProactivity(e.target.value as TuneProactivity)} className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1.5">
                    <option value="low">少追问</option>
                    <option value="balanced">平衡</option>
                    <option value="high">多建议</option>
                  </select>
                </label>
                <label className="text-xs space-y-1">
                  <span className="text-slate-400">执行权限</span>
                  <select value={tunePermission} onChange={(e) => setTunePermission(e.target.value as TunePermission)} className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1.5">
                    <option value="suggest">仅建议</option>
                    <option value="confirm">需确认后执行</option>
                    <option value="auto_low_risk">低风险自动执行</option>
                  </select>
                </label>
                <label className="text-xs space-y-1">
                  <span className="text-slate-400">记忆策略</span>
                  <select value={memoryMode} onChange={(e) => setMemoryMode(e.target.value as MemoryMode)} className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1.5">
                    <option value="off">关闭记忆</option>
                    <option value="session">仅会话记忆</option>
                    <option value="long">长期记忆</option>
                  </select>
                </label>
              </div>
              <pre className="text-xs text-slate-300 bg-slate-900/40 rounded p-3 whitespace-pre-wrap">{tuningPromptPreview}</pre>
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(tuningPromptPreview);
                    setSelfCheckResult("已复制调教模板摘要");
                  } catch {
                    setSelfCheckResult("复制失败，请手动复制调教模板摘要");
                  }
                }}
                className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-xs"
              >
                复制调教模板摘要
              </button>
            </div>
            )}

            {tuningSection === "memory" && (
            <div className="bg-slate-800/50 rounded-lg p-4 space-y-3">
              <p className="font-medium text-slate-200">记忆中心</p>
              <div className="flex flex-wrap gap-2">
                <button onClick={refreshMemoryCenterStatus} disabled={memoryLoading} className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded text-xs">
                  {memoryLoading ? "刷新中..." : "刷新记忆状态"}
                </button>
                <button onClick={handleInitMemory} disabled={memoryActionLoading !== null} className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 rounded text-xs">
                  {memoryActionLoading === "init" ? "初始化中..." : "一键初始化记忆"}
                </button>
                <button onClick={handleReadMemorySummary} disabled={memoryActionLoading !== null} className="px-3 py-1.5 bg-sky-700 hover:bg-sky-600 disabled:opacity-50 rounded text-xs">
                  {memoryActionLoading === "read" ? "读取中..." : "查看记忆摘要"}
                </button>
                <button onClick={handleClearMemory} disabled={memoryActionLoading !== null} className="px-3 py-1.5 bg-rose-700 hover:bg-rose-600 disabled:opacity-50 rounded text-xs">
                  {memoryActionLoading === "clear" ? "清空中..." : "清空记忆"}
                </button>
                <button onClick={handleExportMemory} disabled={memoryActionLoading !== null} className="px-3 py-1.5 bg-amber-700 hover:bg-amber-600 disabled:opacity-50 rounded text-xs">
                  {memoryActionLoading === "export" ? "导出中..." : "导出记忆"}
                </button>
              </div>
              {memoryStatus && (
                <div className="text-xs text-slate-300 bg-slate-900/40 rounded p-3 space-y-1">
                  <p>记忆启用：{memoryStatus.enabled ? "是" : "否"}</p>
                  <p>记忆文件：{memoryStatus.memory_file_count} 个</p>
                  <p>MEMORY.md：{memoryStatus.memory_file_exists ? "存在" : "不存在"}</p>
                  <p>memory 目录：{memoryStatus.memory_dir_exists ? "存在" : "不存在"}</p>
                  <p className="text-slate-400">{memoryStatus.note}</p>
                </div>
              )}
              {memorySummary && <pre className="text-xs text-slate-300 whitespace-pre-wrap bg-slate-900/40 rounded p-3 max-h-52 overflow-auto">{memorySummary}</pre>}
            </div>
            )}

            {tuningSection === "skills" && (
            <div className="bg-slate-800/50 rounded-lg p-4 text-sm text-slate-300 space-y-3">
              <p className="font-medium text-slate-200">Skills 管理面板</p>
              <div className="rounded-lg border border-slate-700 bg-slate-900/30 p-3 space-y-2 text-xs">
                <p className="text-slate-200">当前模式：{currentSkillsScope === "shared" ? "默认共享" : "Agent 覆盖"}</p>
                <p className="text-slate-400">
                  默认共享表示所有 Agent 继承同一套共享 Skills；切到 Agent 覆盖后，可以让个别 Agent 改成独立启用清单。
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => handleSaveSkillsScope("shared")}
                    disabled={skillsScopeSaving || currentSkillsScope === "shared"}
                    className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded text-xs"
                  >
                    切到共享
                  </button>
                  <button
                    onClick={() => handleSaveSkillsScope("agent_override")}
                    disabled={skillsScopeSaving || currentSkillsScope === "agent_override"}
                    className="px-3 py-1.5 bg-sky-700 hover:bg-sky-600 disabled:opacity-50 rounded text-xs"
                  >
                    切到 Agent 覆盖
                  </button>
                  <label className="text-slate-400">当前 Agent</label>
                  <select
                    value={effectiveSkillsAgentId}
                    onChange={(e) => setSkillsSelectedAgentId(e.target.value)}
                    className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-xs min-w-[140px]"
                  >
                    {skillsAgents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.id}
                      </option>
                    ))}
                  </select>
                  {currentSkillsScope === "agent_override" && (
                    <>
                      <button
                        onClick={handleMakeAgentSkillCustom}
                        disabled={skillsScopeSaving || !effectiveSkillsAgentId}
                        className="px-3 py-1.5 bg-violet-700 hover:bg-violet-600 disabled:opacity-50 rounded text-xs"
                      >
                        {currentAgentSkillBinding?.mode === "custom" ? "重建独立清单" : "为当前 Agent 建独立清单"}
                      </button>
                      <button
                        onClick={handleRestoreAgentSkillInheritance}
                        disabled={skillsScopeSaving || !effectiveSkillsAgentId}
                        className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded text-xs"
                      >
                        恢复继承
                      </button>
                    </>
                  )}
                </div>
                {effectiveSkillsAgentId && (
                  <p className="text-slate-400">
                    {effectiveSkillsAgentId}：
                    {currentSkillsScope === "shared"
                      ? `当前跟随共享层，可见 ${skillsCatalog.length} 项 Skills。`
                      : currentAgentSkillBinding?.mode === "custom"
                        ? `当前使用独立清单，已启用 ${effectiveAgentEnabledSkillCount}/${skillsCatalog.length} 项。`
                        : `当前仍继承共享层，可见 ${skillsCatalog.length} 项 Skills。`}
                  </p>
                )}
              </div>
              <div className="rounded-lg border border-slate-700 bg-slate-900/30 p-3 space-y-2 text-xs">
                <p className="text-slate-200">会话/记忆边界说明</p>
                <p className="text-slate-400">
                  当前不同渠道并不天然隔离记忆。是否共享，主要由 Agent、sessionName 和对应 gateway 的 state_dir 决定；同一 Agent 下的多渠道可能落到同一会话历史。
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button onClick={loadSkillsCatalog} disabled={skillsCatalogLoading} className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded text-xs">刷新列表</button>
                <button
                  onClick={() =>
                    setSelectedSkills(
                      Object.fromEntries(skillsCatalog.map((s) => [s.name, true]))
                    )
                  }
                  disabled={!skillsCatalog.length}
                  className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded text-xs"
                >
                  全选
                </button>
                <button
                  onClick={() =>
                    setSelectedSkills(
                      Object.fromEntries(skillsCatalog.map((s) => [s.name, !!s.eligible]))
                    )
                  }
                  disabled={!skillsCatalog.length}
                  className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded text-xs"
                >
                  选择可用项
                </button>
                <button
                  onClick={() =>
                    setSelectedSkills(
                      Object.fromEntries(skillsCatalog.map((s) => [s.name, isAutoFixableSkill(s)]))
                    )
                  }
                  disabled={!skillsCatalog.length}
                  className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded text-xs"
                >
                  仅选可自动修复
                </button>
                <button
                  onClick={handleInstallSelectedSkills}
                  disabled={skillsRepairLoading || !skillsCatalog.length}
                  className="px-3 py-1.5 bg-sky-700 hover:bg-sky-600 disabled:opacity-50 rounded text-xs"
                >
                  {skillsRepairLoading && skillsAction === "install" ? "安装中..." : "安装选中"}
                </button>
                <button
                  onClick={handleRepairSelectedSkills}
                  disabled={skillsRepairLoading}
                  className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 rounded text-xs"
                >
                  {skillsRepairLoading && skillsAction === "repair" ? "修复中..." : "修复缺失依赖（选中）"}
                </button>
                <button onClick={() => handleSkillsManage("update")} disabled={skillsLoading} className="px-3 py-1.5 bg-amber-700 hover:bg-amber-600 disabled:opacity-50 rounded text-xs">全量更新</button>
              </div>
              <p className="text-xs text-slate-400">
                自动修复白名单：目前主要覆盖 <code>bins</code>（如 jq/rg/ffmpeg/op）与部分 <code>anyBins</code>。
                <code>env/config/os</code> 属于手动项（需要你填写密钥、渠道配置或更换系统平台）。
              </p>
              {!!selectedSkillItems.length && (
                <div className="rounded-lg border border-slate-700 bg-slate-900/30 p-3 text-xs space-y-1">
                  <p className="text-slate-300">
                    已选 {selectedSkillItems.length} 项：可自动修复 {selectedAutoFixableItems.length} 项，需手动处理{" "}
                    {selectedManualSkillItems.length} 项。
                  </p>
                  {!!selectedManualSkillItems.length && (
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-amber-300">
                        需手动项通常是缺环境变量/渠道配置/平台限制，程序无法自动补全。
                      </p>
                      <button
                        onClick={async () => {
                          const text = selectedManualSkillItems.map((s) => buildManualFixHint(s)).join("\n\n-----\n\n");
                          try {
                            await navigator.clipboard.writeText(text);
                            setSkillsResult("已复制“需手动处理”清单到剪贴板");
                          } catch {
                            setSkillsResult(`复制失败，请手动复制：\n\n${text}`);
                          }
                        }}
                        className="px-2 py-1 bg-amber-700 hover:bg-amber-600 rounded"
                      >
                        复制手动修复清单
                      </button>
                    </div>
                  )}
                </div>
              )}
              {skillsFeedbackCard ? (
                <FeedbackCard {...skillsFeedbackCard} className="text-xs" detailAsPre detailClassName="max-h-32" />
              ) : null}
              <div className="rounded-lg border border-slate-700 bg-slate-900/30 p-3 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-300">Skills 执行日志</span>
                  {skillsRepairLoading ? (
                    <span className="text-sky-300">任务进行中...</span>
                  ) : (
                    <span className="text-slate-400">等待任务</span>
                  )}
                </div>
                <pre className="rounded bg-slate-900/60 p-3 text-xs whitespace-pre-wrap max-h-44 overflow-auto">
                  {skillsLogText}
                </pre>
              </div>
              <div className="overflow-auto border border-slate-700 rounded-lg">
                {skillsCatalog.length > serviceSkillsRenderLimit && (
                  <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 text-xs text-slate-400">
                    <span>
                      为保证服务页流畅度，当前渲染 {serviceSkillsRenderLimit}/{skillsCatalog.length} 条 Skills。
                    </span>
                    <button
                      onClick={() =>
                        setServiceSkillsRenderLimit((prev) => Math.min(skillsCatalog.length, prev + 40))
                      }
                      className="px-2 py-1 bg-slate-700 hover:bg-slate-600 rounded"
                    >
                      加载更多
                    </button>
                  </div>
                )}
                <table className="w-full min-w-[980px] text-xs">
                  <thead className="bg-slate-900/60 text-slate-300">
                    <tr>
                      <th className="text-left px-2 py-2">选择</th>
                      <th className="text-left px-2 py-2">Skill</th>
                      <th className="text-left px-2 py-2">来源</th>
                      <th className="text-left px-2 py-2">状态</th>
                      <th className="text-left px-2 py-2">当前Agent</th>
                      <th className="text-left px-2 py-2">缺失项摘要</th>
                      <th className="text-left px-2 py-2">操作建议</th>
                    </tr>
                  </thead>
                  <tbody>
                    {skillsCatalog.slice(0, serviceSkillsRenderLimit).map((s) => (
                      <SkillTableRow
                        key={s.name}
                        skill={s}
                        checked={!!selectedSkills[s.name]}
                        onToggle={toggleSkillSelection}
                        onCopyManualHint={handleCopyManualHint}
                        agentEnabled={effectiveAgentEnabledSkillSet.has(s.name)}
                        showAgentToggle={currentSkillsScope === "agent_override" && !!effectiveSkillsAgentId}
                        onToggleAgentSkill={handleToggleSkillForAgent}
                        repairState={skillRepairStateByName[s.name]}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="rounded-lg border border-slate-700 bg-slate-900/30 p-3 space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-slate-200">第三方 Skills 市场</p>
                  <input
                    value={marketQuery}
                    onChange={(e) => setMarketQuery(e.target.value)}
                    placeholder="搜索 ClawHub / GitHub Skills，例如 github、excel、crawler"
                    className="flex-1 min-w-[260px] bg-slate-800 border border-slate-600 rounded px-3 py-1.5 text-xs"
                  />
                  <button
                    onClick={handleSearchMarketSkills}
                    disabled={marketLoading}
                    className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded text-xs"
                  >
                    {marketLoading ? "搜索中..." : "搜索"}
                  </button>
                </div>
                <p className="text-slate-400 text-xs">
                  搜索结果会聚合 ClawHub 和 GitHub。若 ClawHub 被限流，会自动退化到 GitHub 结果。安装始终先落到共享 Skills 层；若你已切到 Agent 覆盖，还可以顺手加入当前 Agent 的独立清单。
                </p>
                {(marketInstallKey || localSkillInstalling || skillImportProgress) && (
                  <div className="rounded border border-sky-700/50 bg-sky-950/20 p-3 space-y-2">
                    <p className="text-xs text-sky-300">
                      {skillImportProgress?.kind === "local" ? "本地导入进度" : "第三方 Skill 安装进度"}：
                      {skillImportProgress?.current ?? 0}/{skillImportProgress?.total ?? 0}
                      {skillImportProgress?.label ? ` · ${skillImportProgress.label}` : ""}
                    </p>
                    <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-sky-500 rounded-full transition-all duration-300"
                        style={{
                          width: `${Math.max(
                            5,
                            Math.min(
                              100,
                              Math.round(
                                ((skillImportProgress?.current ?? 0) / Math.max(skillImportProgress?.total ?? 0, 1)) * 100
                              )
                            )
                          )}%`,
                        }}
                      />
                    </div>
                    {skillImportProgress ? (
                      <p className="text-[11px] text-slate-300">
                        {skillImportProgress.message} ({skillImportProgress.status})
                      </p>
                    ) : null}
                    {skillImportProgressLog.length > 0 && (
                      <pre className="bg-slate-900/40 rounded p-3 text-xs whitespace-pre-wrap max-h-28 overflow-auto">
                        {skillImportProgressLog.join("\n")}
                      </pre>
                    )}
                  </div>
                )}
                {marketFeedbackCard ? (
                  <FeedbackCard {...marketFeedbackCard} className="text-xs" detailAsPre detailClassName="max-h-40" />
                ) : null}
                {marketResults.length > 0 && (
                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-2">
                    {marketResults.map((skill) => {
                      const itemKey = `${skill.source_type || "remote"}:${skill.package_name || skill.name}`;
                      return (
                        <div key={itemKey} className="rounded-lg border border-slate-700 bg-slate-950/40 p-3 space-y-2">
                          <div className="flex items-start justify-between gap-3">
                            <div className="space-y-1">
                              <p className="text-slate-200 text-sm">{skill.name}</p>
                              <p className="text-slate-400 text-xs">{skill.description || "暂无描述"}</p>
                            </div>
                            <span className="px-2 py-0.5 rounded bg-slate-700 text-[11px] text-slate-200">
                              {skill.source_type === "clawhub" ? "ClawHub" : "GitHub"}
                            </span>
                          </div>
                          <div className="flex flex-wrap gap-3 text-[11px] text-slate-500">
                            {skill.author && <span>作者：{skill.author}</span>}
                            {skill.version && <span>版本：{skill.version}</span>}
                            {skill.package_name && <span>包名：{skill.package_name}</span>}
                          </div>
                          {skill.repo_url && (
                            <a href={skill.repo_url} target="_blank" rel="noreferrer" className="text-xs text-sky-300 hover:text-sky-200 underline">
                              {skill.repo_url}
                            </a>
                          )}
                          <div className="flex flex-wrap gap-2">
                            <button
                              onClick={() => handleInstallMarketSkill(skill, false)}
                              disabled={marketInstallKey === itemKey}
                              className="px-3 py-1.5 bg-sky-700 hover:bg-sky-600 disabled:opacity-50 rounded text-xs"
                            >
                              {marketInstallKey === itemKey ? "安装中..." : "安装到共享层"}
                            </button>
                            {currentSkillsScope === "agent_override" && !!effectiveSkillsAgentId && (
                              <button
                                onClick={() => handleInstallMarketSkill(skill, true)}
                                disabled={marketInstallKey === itemKey}
                                className="px-3 py-1.5 bg-violet-700 hover:bg-violet-600 disabled:opacity-50 rounded text-xs"
                              >
                                安装并加入当前 Agent
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                <div className="rounded-lg border border-slate-700 bg-slate-950/40 p-3 space-y-3">
                  <p className="text-slate-200 text-xs">本地 Skills 安装</p>
                  <p className="text-slate-400 text-xs">
                    如果你已经从网站下载了 Skill ZIP，或者手里有一个本地 Skill 文件夹，可以直接在这里导入。要求内容里至少包含 `SKILL.md`。
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <input
                      value={localSkillPath}
                      onChange={(e) => setLocalSkillPath(e.target.value)}
                      placeholder="粘贴本地 Skill 目录或 ZIP 路径"
                      className="flex-1 min-w-[320px] bg-slate-800 border border-slate-600 rounded px-3 py-1.5 text-xs"
                    />
                    <button
                      onClick={handlePickLocalSkillFolder}
                      className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-xs"
                    >
                      选目录
                    </button>
                    <button
                      onClick={handlePickLocalSkillZip}
                      className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-xs"
                    >
                      选ZIP
                    </button>
                    <button
                      onClick={handleInstallLocalSkill}
                      disabled={localSkillInstalling}
                      className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 rounded text-xs"
                    >
                      {localSkillInstalling ? "导入中..." : "安装到共享层"}
                    </button>
                  </div>
                </div>
              </div>
              {skillsRepairLoading && skillsRepairProgress && (
                <div className="space-y-2">
                  <p className="text-xs text-sky-300">
                    修复进度：{skillsRepairProgress?.current ?? 0}/{skillsRepairProgress?.total ?? 0}，
                    当前 `{skillsRepairProgress?.skill ?? "-"}` - {skillsRepairProgress?.message ?? "-"}
                  </p>
                  <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-emerald-500 rounded-full transition-all duration-300"
                      style={{
                        width: `${Math.max(
                          5,
                          Math.min(
                            100,
                            Math.round(
                              ((skillsRepairProgress?.current ?? 0) / Math.max(skillsRepairProgress?.total ?? 0, 1)) * 100
                            )
                          )
                        )}%`,
                      }}
                    />
                  </div>
                </div>
              )}
            </div>
            )}

            {tuningSection === "health" && (
              <Suspense fallback={<div className="text-slate-400 p-4 text-sm">加载中...</div>}>
                <TuningHealthSection ctx={tuningHealthCtx} />
              </Suspense>
            )}
          </div>
        )}
        {step === 4 && heavyPageShellPending && (
          <div className="w-full max-w-[1200px] mx-auto">
            <div className="rounded-2xl border border-slate-700 bg-slate-800/40 p-6 text-sm text-slate-400">
              正在切换页面...
            </div>
          </div>
        )}
      </main>
        </div>
      </div>

      {wizardOpen && (
        <div className="fixed inset-0 z-50 bg-black/55 flex items-center justify-center p-4">
          <div className="w-full max-w-2xl rounded-xl border border-slate-700 bg-slate-900 p-5 space-y-4">
            <h3 className="text-lg font-semibold">首次 30 秒向导</h3>
            <p className="text-sm text-slate-400">选完这 3 项，自动帮你落到推荐调教参数。</p>
            <div className="space-y-3">
              <div>
                <p className="text-xs text-slate-400 mb-1">你主要用来做什么？</p>
                <div className="flex flex-wrap gap-2 text-xs">
                  {[
                    { id: "customer_support", label: "客服" },
                    { id: "short_video", label: "短视频" },
                    { id: "office", label: "办公" },
                    { id: "developer", label: "开发" },
                  ].map((x) => (
                    <button
                      key={x.id}
                      onClick={() => setWizardUseCase(x.id as ScenarioPreset)}
                      className={`px-2 py-1 rounded border ${
                        wizardUseCase === x.id ? "border-emerald-500 bg-emerald-700/30" : "border-slate-700 bg-slate-800"
                      }`}
                    >
                      {x.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-xs text-slate-400 mb-1">回答风格</p>
                <div className="flex flex-wrap gap-2 text-xs">
                  {[
                    { id: "friendly", label: "亲切" },
                    { id: "professional", label: "专业" },
                    { id: "concise", label: "简洁" },
                  ].map((x) => (
                    <button
                      key={x.id}
                      onClick={() => setWizardTone(x.id as TuneTone)}
                      className={`px-2 py-1 rounded border ${
                        wizardTone === x.id ? "border-sky-500 bg-sky-700/30" : "border-slate-700 bg-slate-800"
                      }`}
                    >
                      {x.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-xs text-slate-400 mb-1">记忆模式</p>
                <div className="flex flex-wrap gap-2 text-xs">
                  {[
                    { id: "off", label: "关闭记忆" },
                    { id: "session", label: "本次会话" },
                    { id: "longterm", label: "长期记忆" },
                  ].map((x) => (
                    <button
                      key={x.id}
                      onClick={() => setWizardMemory(x.id as MemoryMode)}
                      className={`px-2 py-1 rounded border ${
                        wizardMemory === x.id ? "border-amber-500 bg-amber-700/30" : "border-slate-700 bg-slate-800"
                      }`}
                    >
                      {x.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  localStorage.setItem("openclaw_easy_onboarding_done", "1");
                  setWizardOpen(false);
                }}
                className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-xs"
              >
                跳过
              </button>
              <button
                onClick={completeWizard}
                className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 rounded text-xs"
              >
                一键应用并继续
              </button>
            </div>
          </div>
        </div>
      )}

      {showCommunityHub && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={() => setShowCommunityHub(false)}>
          <div className="w-full max-w-3xl rounded-2xl border border-slate-700 bg-slate-900 p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-slate-100">项目与社群入口</h3>
                <p className="mt-1 text-sm text-slate-400">
                  GitHub 和 Telegram 会直接尝试打开，QQ群会优先尝试唤起 QQ；如果没反应，可以复制群号手动加入。
                </p>
              </div>
              <button
                onClick={() => setShowCommunityHub(false)}
                className="rounded-lg border border-slate-700 bg-slate-800/70 px-3 py-1.5 text-xs text-slate-300 hover:border-slate-500"
              >
                关闭
              </button>
            </div>

            <div className="flex gap-2 flex-wrap">
              <button
                onClick={() => setCommunityHubView("links")}
                className={`rounded-lg px-3 py-1.5 text-xs border ${
                  communityHubView === "links"
                    ? "border-sky-500/70 bg-sky-900/40 text-sky-100"
                    : "border-slate-700 bg-slate-800/70 text-slate-300 hover:border-slate-500"
                }`}
              >
                快捷入口
              </button>
              <button
                onClick={() => setCommunityHubView("qq-qr")}
                className={`rounded-lg px-3 py-1.5 text-xs border ${
                  communityHubView === "qq-qr"
                    ? "border-sky-500/70 bg-sky-900/40 text-sky-100"
                    : "border-slate-700 bg-slate-800/70 text-slate-300 hover:border-slate-500"
                }`}
              >
                QQ 群二维码
              </button>
            </div>

            {communityHubView === "links" ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-4 space-y-3">
                <div>
                  <p className="text-sm font-medium text-slate-100">GitHub 项目</p>
                  <p className="mt-1 text-xs text-slate-400">查看项目主页、更新记录和发布版本。</p>
                </div>
                <button
                  onClick={() => void handleOpenCommunityLink("https://github.com/3445286649/openclaw-deploy.git", "已尝试打开 GitHub 项目")}
                  className="w-full flex items-center justify-between rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-xs text-slate-200 hover:border-slate-500"
                >
                  打开 GitHub 项目
                  <ExternalLink className="w-3 h-3" />
                </button>
              </div>

              <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-4 space-y-3">
                <div>
                  <p className="text-sm font-medium text-slate-100">QQ群</p>
                  <p className="mt-1 text-xs text-slate-400">群号：1085253453。适合加群咨询、领取测试额度和交流配置问题。</p>
                </div>
                <div className="rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-xs text-slate-300">
                  openclaw 一键部署群：1085253453
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() =>
                      void handleOpenCommunityLink(
                        "mqqapi://card/show_pslcard?src_type=internal&version=1&uin=1085253453&card_type=group&source=qrcode",
                        "已尝试唤起 QQ 加群"
                      )
                    }
                    className="flex-1 rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-xs text-slate-200 hover:border-slate-500"
                  >
                    尝试打开 QQ
                  </button>
                  <button
                    onClick={() => void handleCopyCommunityText("1085253453", "QQ群号")}
                    className="flex-1 rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-xs text-slate-200 hover:border-slate-500"
                  >
                    复制群号
                  </button>
                  <button
                    onClick={() => setCommunityHubView("qq-qr")}
                    className="flex-1 rounded-lg border border-sky-700/60 bg-sky-900/20 px-3 py-2 text-xs text-sky-100 hover:border-sky-500"
                  >
                    查看二维码
                  </button>
                </div>
              </div>

              <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-4 space-y-3">
                <div>
                  <p className="text-sm font-medium text-slate-100">Telegram 群</p>
                  <p className="mt-1 text-xs text-slate-400">如果电脑已安装 Telegram 客户端，点击后会直接尝试跳转。</p>
                </div>
                <div className="rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-xs text-slate-300 break-all">
                  tg://openmessage?chat_id=5292442705
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => void handleOpenTelegramCommunity()}
                    className="flex-1 rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-xs text-slate-200 hover:border-slate-500"
                  >
                    打开 Telegram 群
                  </button>
                  <button
                    onClick={() => void handleOpenCommunityLink("https://web.telegram.org/", "已打开 Telegram Web")}
                    className="flex-1 rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-xs text-slate-200 hover:border-slate-500"
                  >
                    打开 Telegram Web
                  </button>
                  <button
                    onClick={() => void handleCopyCommunityText("tg://openmessage?chat_id=5292442705", "Telegram 链接")}
                    className="flex-1 rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-xs text-slate-200 hover:border-slate-500"
                  >
                    复制链接
                  </button>
                </div>
              </div>
            </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-[320px_1fr] gap-4 items-start">
                <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-4">
                  <img
                    src={qqCommunityQrSrc}
                    alt="QQ群二维码"
                    className="w-full rounded-2xl border border-slate-700 bg-slate-950/40"
                    onError={() => setCommunityActionResult("QQ群二维码加载失败，请检查项目资源 public/community/qq-group.png。")}
                  />
                </div>
                <div className="rounded-2xl border border-slate-700 bg-slate-800/40 p-4 space-y-3">
                  <div>
                    <p className="text-base font-semibold text-slate-100">QQ群二维码</p>
                    <p className="mt-1 text-sm text-slate-400">
                      可以直接用手机 QQ 扫码加入。如果电脑上安装了 QQ，也可以直接尝试唤起 QQ 加群。
                    </p>
                  </div>
                  <div className="rounded-xl border border-slate-700 bg-slate-950/40 px-3 py-3 text-sm text-slate-200">
                    群名：openclaw 一键部署群
                    <div className="mt-1 text-slate-400">群号：1085253453</div>
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    <button
                      onClick={() =>
                        void handleOpenCommunityLink(
                          "mqqapi://card/show_pslcard?src_type=internal&version=1&uin=1085253453&card_type=group&source=qrcode",
                          "已尝试唤起 QQ 加群"
                        )
                      }
                      className="rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-xs text-slate-200 hover:border-slate-500"
                    >
                      尝试打开 QQ
                    </button>
                    <button
                      onClick={() => void handleCopyCommunityText("1085253453", "QQ群号")}
                      className="rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-xs text-slate-200 hover:border-slate-500"
                    >
                      复制群号
                    </button>
                    <button
                      onClick={() => setCommunityHubView("links")}
                      className="rounded-lg border border-sky-700/60 bg-sky-900/20 px-3 py-2 text-xs text-sky-100 hover:border-sky-500"
                    >
                      返回快捷入口
                    </button>
                  </div>
                </div>
              </div>
            )}

            {communityActionResult && (
              <div className="rounded-xl border border-slate-700 bg-slate-950/40 px-3 py-2 text-xs text-slate-300 whitespace-pre-wrap">
                {communityActionResult}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="border-t border-slate-700 px-6 py-3 flex justify-between items-center">
        <button
          onClick={() => openUrl("https://clawd.bot/docs")}
          className="text-slate-500 hover:text-slate-300 text-sm flex items-center gap-1"
        >
          官方文档 <ExternalLink className="w-3 h-3" />
        </button>
        {currentPrimaryNav === "home" && step < 3 && (
          <button
            onClick={() => handleStepChange(step + 1)}
            disabled={step === 0 && !canProceed}
            className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-sm font-medium"
          >
            下一步 <ChevronRight className="w-4 h-4" />
          </button>
        )}
      </footer>
    </div>
  );
}

function EnvItem({
  result,
  type,
  onFix,
  fixing,
  warnOnly,
}: {
  result: EnvCheckResult;
  type: "node" | "npm" | "git" | "openclaw";
  onFix: (type: "node" | "npm" | "git" | "openclaw") => void;
  fixing: "node" | "npm" | "git" | "openclaw" | null;
  warnOnly?: boolean;
}) {
  const fixLabel = type === "openclaw" ? "去安装页" : type === "git" ? "安装" : "修复";
  const isFixing = fixing === type;
  const isWarn = warnOnly && !result.ok;

  return (
    <div
      className={`flex items-start gap-3 p-4 rounded-lg border ${
        result.ok
          ? "bg-emerald-900/20 border-emerald-800"
          : isWarn
            ? "bg-amber-900/20 border-amber-800"
            : "bg-red-900/20 border-red-800"
      }`}
    >
      {result.ok ? (
        <CheckCircle2 className="w-6 h-6 text-emerald-500 flex-shrink-0 mt-0.5" />
      ) : (
        <XCircle className={`w-6 h-6 flex-shrink-0 mt-0.5 ${isWarn ? "text-amber-500" : "text-red-500"}`} />
      )}
      <div className="flex-1 min-w-0">
        <p className={result.ok ? "text-emerald-200" : isWarn ? "text-amber-200" : "text-red-200"}>{result.message}</p>
        {result.version && (
          <p className="text-slate-500 text-sm mt-1">版本: {result.version}</p>
        )}
      </div>
      {!result.ok && (
        <button
          onClick={() => onFix(type)}
          disabled={isFixing}
          className="flex items-center gap-2 px-3 py-1.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 rounded-lg text-sm font-medium flex-shrink-0"
        >
          {isFixing ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Wrench className="w-4 h-4" />
          )}
          {fixLabel}
        </button>
      )}
    </div>
  );
}

export default App;
