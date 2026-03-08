import { useState, useEffect, useRef, useMemo, useCallback, memo, startTransition, useDeferredValue, type CSSProperties, type RefObject, type UIEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open } from "@tauri-apps/plugin-dialog";
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
  Users,
  Zap,
  House,
  MessageSquareText,
} from "lucide-react";

interface EnvCheckResult {
  ok: boolean;
  version?: string;
  message: string;
}

interface InstallResult {
  config_dir: string;
  install_dir: string;
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

interface ExecutableCheckInfo {
  executable?: string;
  exists: boolean;
  source: string;
  detail: string;
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
}

interface PendingChatRequestMeta {
  requestId: string;
  targetId: string;
  userMsgId: string;
  mode: "direct" | "orchestrator";
  flowSummary?: string;
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

interface ChatPreviewMeta {
  text: string;
  time: string;
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

const CHAT_RENDER_BATCH = 80;
const CHAT_VIEWPORT_WINDOW = 48;
const CHAT_CACHE_MAX_MESSAGES = 120;
const CHAT_CACHE_DB_NAME = "openclaw-chat-cache";
const CHAT_CACHE_STORE_NAME = "snapshots";
const DEFAULT_SYNC_SESSION_NAME = "main";
const DEFAULT_ISOLATED_SESSION_NAME = "desktop";
const EMPTY_AGENTS: AgentListItem[] = [];
const EMPTY_CHAT_MESSAGES: ChatUiMessage[] = [];
type ChatSessionMode = "isolated" | "synced";

const ChatMessageBubble = memo(
  function ChatMessageBubble({
    message,
    onRetry,
  }: {
    message: ChatUiMessage;
    onRetry: (text: string) => void;
  }) {
    const isUser = message.role === "user";
    return (
      <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
        <div
          className={`max-w-[78%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
            isUser ? "bg-sky-700 text-white" : "bg-slate-800 text-slate-100"
          }`}
        >
          <div>{message.text}</div>
          <div className={`text-[10px] mt-1 ${isUser ? "text-sky-100/70" : "text-slate-400"}`}>
            {message.status === "sending" && "发送中..."}
            {message.status === "failed" && "发送失败，可重试"}
            {(message.status === "sent" || !message.status) && (message.timestamp || message.role)}
          </div>
          {message.status === "failed" && (
            <button
              onClick={() => onRetry(message.text)}
              className="mt-1 text-[10px] text-amber-300 hover:text-amber-200 underline"
            >
              回填重试
            </button>
          )}
        </div>
      </div>
    );
  },
  (prev, next) =>
    prev.onRetry === next.onRetry &&
    isSameChatMessage(prev.message, next.message)
);

function isSameChatMessage(a: ChatUiMessage, b: ChatUiMessage): boolean {
  return (
    a.id === b.id &&
    a.role === b.role &&
    (a.text || "") === (b.text || "") &&
    (a.timestamp || "") === (b.timestamp || "") &&
    (a.status || "sent") === (b.status || "sent")
  );
}

function isSameChatMessageList(a: ChatUiMessage[], b: ChatUiMessage[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!isSameChatMessage(a[i], b[i])) return false;
  }
  return true;
}

function normalizeChatText(text: string): string {
  return (text || "").trim().replace(/\s+/g, " ");
}

function makeChatMessageFingerprint(message: Pick<ChatUiMessage, "role" | "text" | "timestamp">): string {
  return [message.role || "assistant", message.timestamp || "", normalizeChatText(message.text || "")]
    .join("|")
    .trim();
}

function sanitizeChatMessageForCache(message: ChatUiMessage): ChatUiMessage {
  return {
    id: String(message.id || ""),
    role: String(message.role || "assistant"),
    text: String(message.text || ""),
    timestamp: message.timestamp ? String(message.timestamp) : undefined,
    status: message.status === "failed" ? "failed" : "sent",
  };
}

function buildChatCacheKey(configPath: string, sessionMode: ChatSessionMode): string {
  const scope = normalizeConfigPath(configPath) || "default";
  return `openclaw_chat_cache_v1::${scope}::${sessionMode}`;
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

function formatChatPreviewTime(timestamp?: string): string {
  const raw = String(timestamp || "").trim();
  if (!raw) return "";
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function appendDeltaUniqueMessages(
  current: ChatUiMessage[],
  delta: ChatUiMessage[],
  options?: { removeMessageId?: string }
): ChatUiMessage[] {
  const base = options?.removeMessageId ? current.filter((m) => m.id !== options.removeMessageId) : current.slice();
  const seenIds = new Set(base.map((m) => m.id));
  const seenUserTexts = new Set(base.filter((m) => m.role === "user").map((m) => normalizeChatText(m.text)));
  const appended: ChatUiMessage[] = [];
  for (const msg of delta) {
    if (seenIds.has(msg.id)) continue;
    if (msg.role === "user") {
      const normalized = normalizeChatText(msg.text);
      if (normalized && seenUserTexts.has(normalized)) continue;
      if (normalized) seenUserTexts.add(normalized);
    }
    seenIds.add(msg.id);
    appended.push(msg);
  }
  if (appended.length === 0) return base;
  return [...base, ...appended];
}

function trimChatMessagesForUi(messages: ChatUiMessage[], max = 320): ChatUiMessage[] {
  if (messages.length <= max) return messages;
  return messages.slice(messages.length - max);
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

interface ChatWorkbenchProps {
  agents: AgentListItem[];
  selectedAgentId: string;
  unreadByAgent: Record<string, number>;
  previewByAgent: Record<string, ChatPreviewMeta>;
  routeMode: "manual" | "auto";
  chatExecutionMode: "orchestrator" | "direct";
  chatSessionMode: ChatSessionMode;
  chatLoading: boolean;
  chatSending: boolean;
  chatError: string | null;
  routeHint: string | null;
  messages: ChatUiMessage[];
  renderLimit: number;
  historyLoaded: boolean;
  cacheHydrating: boolean;
  chatStickBottom: boolean;
  pendingReply: boolean;
  chatViewportRef: RefObject<HTMLDivElement | null>;
  onRouteModeChange: (next: "manual" | "auto") => void;
  onExecutionModeChange: (next: "orchestrator" | "direct") => void;
  onSessionModeChange: (next: ChatSessionMode) => void;
  onSelectAgent: (agentId: string) => void;
  onNewSession: () => void;
  onClearSession: () => void;
  onAbort: () => void;
  onLoadHistory: () => void;
  onSend: (text: string) => Promise<boolean>;
  onTypingActivity: () => void;
  onViewportScroll: (evt: UIEvent<HTMLDivElement>) => void;
  getAgentSpecialty: (agentId: string) => "代码" | "表格" | "通用";
  gatewayOptionsByAgent: Record<string, GatewayBinding[]>;
  preferredGatewayByAgent: Record<string, string>;
  onPreferredGatewayChange: (agentId: string, gatewayId: string) => void;
}

const ChatAgentSidebar = memo(function ChatAgentSidebar({
  agents,
  selectedAgentId,
  unreadByAgent,
  previewByAgent,
  onSelectAgent,
  getAgentSpecialty,
}: {
  agents: AgentListItem[];
  selectedAgentId: string;
  unreadByAgent: Record<string, number>;
  previewByAgent: Record<string, ChatPreviewMeta>;
  onSelectAgent: (agentId: string) => void;
  getAgentSpecialty: (agentId: string) => "代码" | "表格" | "通用";
}) {
  return (
    <div className="w-52 shrink-0 flex flex-col gap-1 bg-slate-800/40 rounded-xl border border-slate-700/60 p-2 overflow-y-auto">
      {agents.length > 0 ? (
        agents.map((a) => {
          const selected = selectedAgentId === a.id;
          const specialty = getAgentSpecialty(a.id);
          const unread = unreadByAgent[a.id] || 0;
          const preview = previewByAgent[a.id];
          return (
            <button
              key={a.id}
              onClick={() => onSelectAgent(a.id)}
              className={`text-left px-2.5 py-2.5 rounded-lg text-xs ${
                selected
                  ? "bg-sky-700/90 text-sky-100 shadow-[0_0_0_1px_rgba(125,211,252,0.25)]"
                  : "bg-slate-700/50 hover:bg-slate-600 text-slate-200"
              }`}
              title={a.workspace || a.id}
            >
              <div className="flex items-center justify-between">
                <span className="truncate">{a.name || a.id}</span>
                {unread > 0 && (
                  <span className="bg-rose-600 text-white rounded-full px-1.5 text-[10px]">{unread}</span>
                )}
              </div>
              <div className="text-[10px] text-slate-300/80 mt-0.5">
                {a.id} · {specialty}
              </div>
              {preview?.text ? (
                <div className="mt-1 space-y-0.5">
                  <div className="text-[11px] text-slate-300/85 truncate">{preview.text}</div>
                  {preview.time ? <div className="text-[10px] text-slate-500">{preview.time}</div> : null}
                </div>
              ) : (
                <div className="mt-1 text-[10px] text-slate-500 truncate">暂无聊天记录</div>
              )}
            </button>
          );
        })
      ) : (
        <p className="text-xs text-slate-500 px-2">暂无 Agent</p>
      )}
    </div>
  );
});

const ChatMessagesViewport = memo(function ChatMessagesViewport({
  chatViewportRef,
  onViewportScroll,
  chatLoading,
  messages,
  totalMessages,
  renderLimit,
  historyLoaded,
  cacheHydrating,
  chatStickBottom,
  pendingReply,
  onLoadHistory,
  onRetry,
}: {
  chatViewportRef: RefObject<HTMLDivElement | null>;
  onViewportScroll: (evt: UIEvent<HTMLDivElement>) => void;
  chatLoading: boolean;
  messages: ChatUiMessage[];
  totalMessages: number;
  renderLimit: number;
  historyLoaded: boolean;
  cacheHydrating: boolean;
  chatStickBottom: boolean;
  pendingReply: boolean;
  onLoadHistory: () => void;
  onRetry: (text: string) => void;
}) {
  const collapsedByLimit = Math.max(0, totalMessages - renderLimit);
  const cachedCount = Math.min(renderLimit, totalMessages);
  const collapsedByViewport = Math.max(0, cachedCount - messages.length);

  return (
    <div
      ref={chatViewportRef}
      onScroll={onViewportScroll}
      className="flex-1 overflow-y-auto p-3 space-y-2 min-h-[320px]"
      style={{ contentVisibility: "auto", containIntrinsicSize: "720px", overscrollBehavior: "contain" }}
    >
      {cacheHydrating && totalMessages === 0 && (
        <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-3 text-xs text-slate-400">
          正在恢复本地聊天...
        </div>
      )}
      {!cacheHydrating && !historyLoaded && !chatLoading && totalMessages === 0 && (
        <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-3 text-xs text-slate-300 space-y-2">
          <p>已暂停进入页面自动拉历史，避免一进聊天页就卡顿。</p>
          <button
            onClick={onLoadHistory}
            className="px-3 py-1.5 bg-sky-700 hover:bg-sky-600 rounded text-xs"
          >
            加载最近消息
          </button>
        </div>
      )}
      {chatLoading && <p className="text-xs text-slate-500">正在加载历史...</p>}
      {!chatLoading && historyLoaded && totalMessages === 0 && <p className="text-xs text-slate-500">暂无消息，开始对话吧。</p>}
      {collapsedByLimit > 0 && (
        <p className="text-[11px] text-slate-500">
          为提升流畅度当前缓存最近 {cachedCount}/{totalMessages} 条，向上滚动可继续加载更早消息。
        </p>
      )}
      {collapsedByViewport > 0 && chatStickBottom && (
        <p className="text-[11px] text-slate-500">
          底部模式已临时折叠更早的 {collapsedByViewport} 条消息，向上查看历史时会自动展开，减少等待回复时的滚动卡顿。
        </p>
      )}
      {messages.map((m) => (
        <ChatMessageBubble key={m.id} message={m} onRetry={onRetry} />
      ))}
      {pendingReply && (
        <div className="flex justify-start">
          <div className="max-w-[78%] rounded-lg px-3 py-2 text-sm bg-slate-800/80 text-slate-100 border border-slate-700">
            <div>等待回复中...</div>
            <div className="text-[10px] mt-1 text-slate-400">已改为独立等待提示，减少消息列表重排。</div>
          </div>
        </div>
      )}
    </div>
  );
});

const ChatWorkbench = memo(function ChatWorkbench({
  agents,
  selectedAgentId,
  unreadByAgent,
  previewByAgent,
  routeMode,
  chatExecutionMode,
  chatSessionMode,
  chatLoading,
  chatSending,
  chatError,
  routeHint,
  messages,
  renderLimit,
  historyLoaded,
  cacheHydrating,
  chatStickBottom,
  pendingReply,
  chatViewportRef,
  onRouteModeChange,
  onExecutionModeChange,
  onSessionModeChange,
  onSelectAgent,
  onNewSession,
  onClearSession,
  onAbort,
  onLoadHistory,
  onSend,
  onTypingActivity,
  onViewportScroll,
  getAgentSpecialty,
  gatewayOptionsByAgent,
  preferredGatewayByAgent,
  onPreferredGatewayChange,
}: ChatWorkbenchProps) {
  const [draftByAgent, setDraftByAgent] = useState<Record<string, string>>({});
  const draft = selectedAgentId ? draftByAgent[selectedAgentId] || "" : "";
  const deferredMessages = useDeferredValue(messages);
  const visibleMessages = useMemo(
    () => (deferredMessages.length > renderLimit ? deferredMessages.slice(-renderLimit) : deferredMessages),
    [deferredMessages, renderLimit]
  );
  const windowedMessages = useMemo(
    () =>
      chatStickBottom && visibleMessages.length > CHAT_VIEWPORT_WINDOW
        ? visibleMessages.slice(-CHAT_VIEWPORT_WINDOW)
        : visibleMessages,
    [chatStickBottom, visibleMessages]
  );
  const selectedGatewayOptions = selectedAgentId ? (gatewayOptionsByAgent[selectedAgentId] || []) : [];
  const selectedGatewayValue = selectedAgentId ? (preferredGatewayByAgent[selectedAgentId] || selectedGatewayOptions[0]?.gateway_id || "") : "";

  const setDraftForSelected = useCallback(
    (text: string) => {
      if (!selectedAgentId) return;
      setDraftByAgent((prev) => {
        if ((prev[selectedAgentId] || "") === text) return prev;
        return { ...prev, [selectedAgentId]: text };
      });
    },
    [selectedAgentId]
  );

  const handleSend = useCallback(async () => {
    const ok = await onSend(draft);
    if (ok) setDraftForSelected("");
  }, [onSend, draft, setDraftForSelected]);

  return (
    <div className="flex flex-col gap-3" style={{ minHeight: 560, height: "min(72vh, 760px)" }}>
      <div className="flex items-center justify-between rounded-xl border border-slate-700/70 bg-slate-900/40 px-3 py-2">
        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-xs text-slate-400">路由模式</label>
          <select
            value={routeMode}
            onChange={(e) => onRouteModeChange(e.target.value as "manual" | "auto")}
            className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-xs"
          >
            <option value="manual">手动</option>
            <option value="auto">自动</option>
          </select>
          <label className="text-xs text-slate-400 ml-2">执行方式</label>
          <select
            value={chatExecutionMode}
            onChange={(e) => onExecutionModeChange(e.target.value as "orchestrator" | "direct")}
            className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-xs"
          >
            <option value="orchestrator">流程编排（推荐）</option>
            <option value="direct">直连对话</option>
          </select>
          <label className="text-xs text-slate-400 ml-2">会话模式</label>
          <select
            value={chatSessionMode}
            onChange={(e) => onSessionModeChange(e.target.value as ChatSessionMode)}
            className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-xs"
          >
            <option value="isolated">隔离（仅客户端）</option>
            <option value="synced">同步（三端共享）</option>
          </select>
          {selectedAgentId && selectedGatewayOptions.length > 0 && (
            <>
              <label className="text-xs text-slate-400 ml-2">网关</label>
              <select
                value={selectedGatewayValue}
                onChange={(e) => onPreferredGatewayChange(selectedAgentId, e.target.value)}
                className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-xs max-w-[240px]"
              >
                {selectedGatewayOptions.map((g) => (
                  <option key={g.gateway_id} value={g.gateway_id}>
                    {g.gateway_id} · {g.channel}/{g.instance_id}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>
      </div>

      <div className="flex gap-3 flex-1 min-h-0">
        <ChatAgentSidebar
          agents={agents}
          selectedAgentId={selectedAgentId}
          unreadByAgent={unreadByAgent}
          previewByAgent={previewByAgent}
          onSelectAgent={onSelectAgent}
          getAgentSpecialty={getAgentSpecialty}
        />

        <div className="flex-1 min-w-0 h-full bg-slate-900/50 rounded-xl overflow-hidden border border-slate-700/60 flex flex-col min-h-0">
          <div className="px-3 py-2 border-b border-slate-700/60 flex items-center justify-between bg-slate-900/70">
            <div className="text-sm text-slate-200">
              当前会话：<span className="font-medium">{selectedAgentId || "(未选择)"}</span>
              {selectedAgentId && (
                <span className="text-xs text-slate-400 ml-2">
                  专长：{getAgentSpecialty(selectedAgentId)}
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <button onClick={onNewSession} className="px-2 py-1 bg-slate-700 hover:bg-slate-600 rounded text-xs">
                新会话
              </button>
              <button onClick={onClearSession} className="px-2 py-1 bg-slate-700 hover:bg-slate-600 rounded text-xs">
                清空
              </button>
              <button onClick={onAbort} className="px-2 py-1 bg-rose-700 hover:bg-rose-600 rounded text-xs">
                停止
              </button>
            </div>
          </div>
          <ChatMessagesViewport
            chatViewportRef={chatViewportRef}
            onViewportScroll={onViewportScroll}
            chatLoading={chatLoading}
            messages={windowedMessages}
            totalMessages={messages.length}
            renderLimit={renderLimit}
            historyLoaded={historyLoaded}
            cacheHydrating={cacheHydrating}
            chatStickBottom={chatStickBottom}
            pendingReply={pendingReply}
            onLoadHistory={onLoadHistory}
            onRetry={setDraftForSelected}
          />

          <div className="border-t border-slate-700/60 p-3 space-y-2">
            {routeHint && <p className="text-xs text-emerald-300">{routeHint}</p>}
            {chatError && <p className="text-xs text-rose-400">{chatError}</p>}
            <div className="flex gap-2">
              <textarea
                value={draft}
                onChange={(e) => {
                  onTypingActivity();
                  setDraftForSelected(e.target.value);
                }}
                placeholder="输入消息，手动路由可用 @code 你的问题"
                rows={2}
                className="flex-1 bg-slate-800 border border-slate-600 rounded px-3 py-2 text-sm resize-none"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
              />
              <button
                onClick={() => void handleSend()}
                disabled={chatSending || !selectedAgentId}
                className="px-4 py-2 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 rounded text-sm"
              >
                {chatSending ? "发送中..." : "发送"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
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

function looksLikeApiKey(input: string): boolean {
  const v = input.trim();
  return /(^|\s)sk-[A-Za-z0-9._-]{12,}($|\s)/.test(v);
}

function isLikelyConfigPath(input: string): boolean {
  const v = normalizeConfigPath(input);
  if (!v) return false;
  if (looksLikeApiKey(v)) return false;
  return (
    v.startsWith("~/") ||
    /^[A-Za-z]:\//.test(v) ||
    v.startsWith("/") ||
    v.includes("/")
  );
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
  { id: "official", label: "官方线路", desc: "后续上线，承接你的 API 中转站方案" },
] as const;

const DEFAULT_OPENAI_BASE_URL = "https://api.siliconflow.cn/v1";
const DEFAULT_KIMI_BASE_URL = "https://api.moonshot.cn/v1";
const RECOMMENDED_MODEL_FALLBACK = "deepseek-ai/DeepSeek-V3";

/** 固定硅基流动模型列表（引流用，后续接入自建中转支持更多） */
const FIXED_SILICONFLOW_MODELS: { id: string; label: string }[] = [
  { id: "deepseek-ai/DeepSeek-V3", label: "DeepSeek V3（推荐）" },
  { id: "Qwen/Qwen2.5-72B-Instruct", label: "Qwen2.5 72B" },
  { id: "GLM-4-9B-Chat", label: "GLM-4-9B / GLM-5" },
  { id: "moonshotai/Kimi-K2-Instruct-0905", label: "Kimi K2（可对话）" },
  { id: "deepseek-ai/DeepSeek-R1", label: "DeepSeek R1（备选）" },
];
const AGENT_PROVIDER_OPTIONS = ["openai", "deepseek", "kimi", "qwen", "bailian", "anthropic"] as const;
const DEPLOY_SUCCESS_DIALOG =
  "恭喜部署完成！作者已为你配置稳定代理API（每天免费额度）。加QQ群1085253453领更多额度或29元无限包月。";

function defaultBaseUrlForProvider(provider: string): string {
  if (provider === "kimi") return DEFAULT_KIMI_BASE_URL;
  if (provider === "qwen" || provider === "bailian") return "https://dashscope.aliyuncs.com/compatible-mode/v1";
  if (provider === "deepseek") return "https://api.deepseek.com/v1";
  if (provider === "anthropic") return "https://api.anthropic.com/v1";
  return DEFAULT_OPENAI_BASE_URL;
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
  const [installResult, setInstallResult] = useState<string | null>(null);
  const [installLog, setInstallLog] = useState<string[]>([]);
  const [installSteps, setInstallSteps] = useState<InstallStepItem[]>(INSTALL_STEPS);
  const logEndRef = useRef<HTMLPreElement>(null);
  const chatViewportRef = useRef<HTMLDivElement | null>(null);
  const chatStickBottomByAgentRef = useRef<Record<string, boolean>>({});
  const chatCursorByAgentRef = useRef<Record<string, number>>({});
  const chatSessionNameByAgentRef = useRef<Record<string, string>>({});
  const chatSessionModeRef = useRef<ChatSessionMode>("isolated");
  const chatSendLockRef = useRef(false);
  const pendingChatRequestsRef = useRef<Record<string, PendingChatRequestMeta>>({});
  const currentPendingChatRequestIdRef = useRef<string | null>(null);
  const lastSentFingerprintRef = useRef<Record<string, { text: string; at: number }>>({});
  const chatCacheHydratedKeyRef = useRef<string | null>(null);
  const chatCachePersistTimerRef = useRef<number | null>(null);
  const stepRef = useRef(0);
  const selectedAgentIdRef = useRef("");
  const installLogBufferRef = useRef<string[]>([]);
  const installLogFlushTimerRef = useRef<number | null>(null);

  const [provider, setProvider] = useState("openai");
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
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
  const [, setExeCheckInfo] = useState<ExecutableCheckInfo | null>(null);
  const [uninstalling, setUninstalling] = useState(false);
  const [selfCheckItems, setSelfCheckItems] = useState<SelfCheckItem[]>([]);
  const [selfCheckResult, setSelfCheckResult] = useState<string | null>(null);
  const [pluginSelection, setPluginSelection] = useState<Record<string, boolean>>({
    telegram: true,
    qq: true,
    feishu: true,
    discord: true,
    dingtalk: true,
  });
  const [pluginInstallLoading, setPluginInstallLoading] = useState(false);
  const [pluginInstallResult, setPluginInstallResult] = useState<string | null>(null);
  const [pluginInstallProgress, setPluginInstallProgress] = useState<PluginInstallProgressEvent | null>(null);
  const [pluginInstallProgressLog, setPluginInstallProgressLog] = useState<string[]>([]);
  const pluginLogBufferRef = useRef<string[]>([]);
  const pluginLogFlushTimerRef = useRef<number | null>(null);
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
  const [skillsRepairProgressLog, setSkillsRepairProgressLog] = useState<string[]>([]);
  const [serviceSkillsRenderLimit, setServiceSkillsRenderLimit] = useState(80);
  const [marketQuery, setMarketQuery] = useState("");
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketResults, setMarketResults] = useState<SkillCatalogItem[]>([]);
  const [marketInstallKey, setMarketInstallKey] = useState<string | null>(null);
  const [marketResult, setMarketResult] = useState<string | null>(null);
  const [localSkillPath, setLocalSkillPath] = useState("");
  const [localSkillInstalling, setLocalSkillInstalling] = useState(false);
  const [skillRepairStateByName, setSkillRepairStateByName] = useState<Record<string, "fixed" | "still_missing" | "manual">>({});
  const skillsLogBufferRef = useRef<string[]>([]);
  const skillsLogFlushTimerRef = useRef<number | null>(null);
  const [startupMigrationResult, setStartupMigrationResult] = useState<StartupMigrationResult | null>(null);
  const [queueTasks, setQueueTasks] = useState<QueueTaskItem[]>([]);
  const queueRunnersRef = useRef<Record<string, () => Promise<void>>>({});
  const cancelledRunningTasksRef = useRef<Set<string>>(new Set());
  const [, setTicketSummary] = useState<string | null>(null);

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
    "quick" | "scene" | "personal" | "memory" | "health" | "skills" | "agents" | "chat" | "control"
  >("quick");
  const [memoryStatus, setMemoryStatus] = useState<MemoryCenterStatus | null>(null);
  const [memorySummary, setMemorySummary] = useState<string | null>(null);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryActionLoading, setMemoryActionLoading] = useState<"read" | "clear" | "export" | "init" | null>(null);
  const [tuningActionLoading, setTuningActionLoading] = useState<"check" | "heal" | null>(null);
  const [agentCenterTab, setAgentCenterTab] = useState<"overview" | "channels">("overview");
  const [wizardOpen, setWizardOpen] = useState(false);
  const [agentsList, setAgentsList] = useState<AgentsListPayload | null>(null);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [agentRuntimeSettings, setAgentRuntimeSettings] = useState<AgentRuntimeSettingsPayload | null>(null);
  const [agentProfileDrafts, setAgentProfileDrafts] = useState<Record<string, { provider: string; model: string }>>({});
  const [agentModelsByProvider, setAgentModelsByProvider] = useState<Record<string, string[]>>({});
  const [agentModelsLoadingByProvider, setAgentModelsLoadingByProvider] = useState<Record<string, boolean>>({});
  const [agentRuntimeSaving, setAgentRuntimeSaving] = useState(false);
  const [agentRuntimeResult, setAgentRuntimeResult] = useState<string | null>(null);
  const [channelRoutesDraft, setChannelRoutesDraft] = useState<AgentChannelRoute[]>([]);
  const [gatewayBindingsDraft, setGatewayBindingsDraft] = useState<GatewayBinding[]>([]);
  const [gatewaySelectedIdForRouteTest, setGatewaySelectedIdForRouteTest] = useState("");
  const [gatewayActionLoadingById, setGatewayActionLoadingById] = useState<Record<string, boolean>>({});
  const [gatewayLogsById, setGatewayLogsById] = useState<Record<string, string>>({});
  const [gatewayLogViewerId, setGatewayLogViewerId] = useState<string | null>(null);
  const [gatewayBatchLoading, setGatewayBatchLoading] = useState<"start" | "health" | "report" | null>(null);
  const [telegramInstancesDraft, setTelegramInstancesDraft] = useState<TelegramBotInstance[]>([]);
  const [channelInstancesDraft, setChannelInstancesDraft] = useState<ChannelBotInstance[]>([]);
  const [activeChannelInstanceByChannel, setActiveChannelInstanceByChannel] = useState<Record<string, string>>({});
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
  const [chatHistoryLoadedByAgent, setChatHistoryLoadedByAgent] = useState<Record<string, boolean>>({});
  const [chatHistorySuppressedByAgent, setChatHistorySuppressedByAgent] = useState<Record<string, boolean>>({});
  const [chatCacheHydrating, setChatCacheHydrating] = useState(true);
  const [chatRenderLimitByAgent, setChatRenderLimitByAgent] = useState<Record<string, number>>({});
  const [chatDraft, setChatDraft] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [chatSending, setChatSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [routeMode, setRouteMode] = useState<"manual" | "auto">("manual");
  const [simpleModeForAgent, setSimpleModeForAgent] = useState(true);
  const [setupWizardStepMode, setSetupWizardStepMode] = useState(false);
  const [setupWizardCurrentStep, setSetupWizardCurrentStep] = useState(1);
  const [showAdvancedRouteRules, setShowAdvancedRouteRules] = useState(false);
  const [showAgentAdvancedSettings, setShowAgentAdvancedSettings] = useState(false);
  const [showGatewayAdvancedActions, setShowGatewayAdvancedActions] = useState(false);
  const [chatExecutionMode, setChatExecutionMode] = useState<"orchestrator" | "direct">("direct");
  const [chatSessionMode, setChatSessionMode] = useState<ChatSessionMode>("isolated");
  const [routeHint, setRouteHint] = useState<string | null>(null);
  const [unreadByAgent, setUnreadByAgent] = useState<Record<string, number>>({});
  const [preferredGatewayByAgent, setPreferredGatewayByAgent] = useState<Record<string, string>>({});
  const [pendingReplyAgentId, setPendingReplyAgentId] = useState<string | null>(null);
  const [selectedChatStickBottom, setSelectedChatStickBottom] = useState(true);
  const messagesByAgentRef = useRef<Record<string, ChatUiMessage[]>>({});
  const chatRenderLimitByAgentRef = useRef<Record<string, number>>({});
  const chatHistorySuppressedRef = useRef<Record<string, boolean>>({});
  const lastTypingAtRef = useRef(0);
  const chatInteractTimerRef = useRef<number | null>(null);
  const [chatInteracting, setChatInteracting] = useState(false);
  const [showServiceQueueDetails, setShowServiceQueueDetails] = useState(false);
  const [showRouteTestPanel, setShowRouteTestPanel] = useState(false);
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
  const selectedSkillItems = useMemo(
    () => skillsCatalog.filter((s) => !!selectedSkills[s.name]),
    [skillsCatalog, selectedSkills]
  );
  const selectedManualSkillItems = useMemo(
    () => selectedSkillItems.filter((s) => hasManualSkillGaps(s)),
    [selectedSkillItems]
  );
  const selectedAutoFixableItems = useMemo(
    () => selectedSkillItems.filter((s) => isAutoFixableSkill(s)),
    [selectedSkillItems]
  );
  const currentSkillsScope = agentRuntimeSettings?.skills_scope === "agent_override" ? "agent_override" : "shared";
  const skillsAgents = agentsList?.agents || [];
  const effectiveSkillsAgentId = skillsSelectedAgentId || selectedAgentId || skillsAgents[0]?.id || "";
  const currentAgentSkillBinding = useMemo(
    () =>
      (agentRuntimeSettings?.agent_skill_bindings || []).find((binding) => binding.agent_id === effectiveSkillsAgentId) || null,
    [agentRuntimeSettings?.agent_skill_bindings, effectiveSkillsAgentId]
  );
  const effectiveAgentEnabledSkillSet = useMemo(() => {
    const allNames = new Set(skillsCatalog.map((skill) => skill.name));
    if (currentSkillsScope !== "agent_override") return allNames;
    if (!currentAgentSkillBinding || currentAgentSkillBinding.mode !== "custom") return allNames;
    return new Set(currentAgentSkillBinding.enabled_skills || []);
  }, [skillsCatalog, currentSkillsScope, currentAgentSkillBinding]);
  const effectiveAgentEnabledSkillCount = useMemo(
    () => skillsCatalog.filter((skill) => effectiveAgentEnabledSkillSet.has(skill.name)).length,
    [skillsCatalog, effectiveAgentEnabledSkillSet]
  );
  const loadedStepDataRef = useRef<{ install: boolean; model: boolean; channel: boolean }>({
    install: false,
    model: false,
    channel: false,
  });
  const configReloadTimerRef = useRef<number | null>(null);

  useEffect(() => {
    invoke<StartupMigrationResult>("run_startup_migrations", {
      customPath: normalizeConfigPath(localStorage.getItem("openclaw_config_dir") || "") || undefined,
    })
      .then((res) => {
        if (res && res.fixed_count > 0) {
          setStartupMigrationResult(res);
        }
      })
      .catch(() => {});
    const savedInstall = localStorage.getItem("openclaw_install_dir") ?? "";
    const savedConfig = localStorage.getItem("openclaw_config_dir") ?? "";
    const savedChatSessionMode = localStorage.getItem("openclaw_chat_session_mode");
    if (savedInstall) setCustomInstallPath(savedInstall);
    if (savedChatSessionMode === "isolated" || savedChatSessionMode === "synced") {
      setChatSessionMode(savedChatSessionMode);
      chatSessionModeRef.current = savedChatSessionMode;
    }
    if (savedConfig) {
      if (!isLikelyConfigPath(savedConfig)) {
        localStorage.removeItem("openclaw_config_dir");
        if (looksLikeApiKey(savedConfig)) {
          setSaveResult("检测到你曾把 API Key 填到“自定义配置路径”，已自动清理该路径缓存，请在 API Key 输入框填写后保存。");
        }
      } else {
        setCustomConfigPath(savedConfig);
      }
    }
    // 无论是否有缓存路径，都主动对齐 Gateway 实际路径；是否三端共用会话由“会话模式”决定。
    invoke<string | null>("detect_openclaw_config_path")
      .then((p) => {
        if (!p || !isLikelyConfigPath(p)) return;
        const detected = normalizeConfigPath(p);
        const cached = normalizeConfigPath(savedConfig);
        if (detected && detected !== cached) {
          setCustomConfigPath(detected);
          localStorage.setItem("openclaw_config_dir", detected);
          setSaveResult("已自动对齐到 Gateway 配置目录。");
        } else if (!savedConfig) {
          setCustomConfigPath(detected);
          localStorage.setItem("openclaw_config_dir", detected);
        }
      })
      .catch(() => {});
    runEnvCheck(savedInstall || undefined);
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
      const target = Math.min(80, skillsCatalog.length || 80);
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
    if (step === 4 && tuningSection === "chat") {
      setTuningSection("agents");
      return;
    }
    if (step === 4 && tuningSection === "agents") {
      void refreshAgentsList();
      return;
    }
    if (step === 3) {
      void refreshAgentsList();
    }
  }, [step, tuningSection, customConfigPath]);

  useEffect(() => {
    if (step !== 4) return;
    if (tuningSection !== "memory") return;
    if (memoryStatus || memoryLoading) return;
    void refreshMemoryCenterStatus();
  }, [step, tuningSection, memoryStatus, memoryLoading, customConfigPath]);

  const selectedChatHistoryLoaded = selectedAgentId ? !!chatHistoryLoadedByAgent[selectedAgentId] : false;
  const selectedChatHistorySuppressed = selectedAgentId ? !!chatHistorySuppressedByAgent[selectedAgentId] : false;
  const chatCacheKey = useMemo(
    () => buildChatCacheKey(customConfigPath, chatSessionMode),
    [customConfigPath, chatSessionMode]
  );

  useEffect(() => {
    stepRef.current = step;
  }, [step]);

  useEffect(() => {
    selectedAgentIdRef.current = selectedAgentId;
  }, [selectedAgentId]);

  useEffect(() => {
    if (chatCacheHydratedKeyRef.current === chatCacheKey) return;
    setChatCacheHydrating(true);
    void (async () => {
      try {
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
      } catch {
        try {
          localStorage.removeItem(chatCacheKey);
        } catch {
          // ignore storage error
        }
      } finally {
        chatCacheHydratedKeyRef.current = chatCacheKey;
        setChatCacheHydrating(false);
      }
    })();
  }, [chatCacheKey]);

  useEffect(() => {
    if (chatCacheHydratedKeyRef.current !== chatCacheKey) return;
    if (chatCachePersistTimerRef.current !== null) {
      window.clearTimeout(chatCachePersistTimerRef.current);
      chatCachePersistTimerRef.current = null;
    }
    chatCachePersistTimerRef.current = window.setTimeout(() => {
      void (async () => {
        try {
          const payload: ChatCachePayload = {
            version: 1,
            selectedAgentId,
            messagesByAgent: Object.fromEntries(
              Object.entries(messagesByAgent).map(([agentId, list]) => [
                agentId,
                trimChatMessagesForUi(
                  (list || []).map(sanitizeChatMessageForCache).filter((item) => item.text.trim()),
                  CHAT_CACHE_MAX_MESSAGES
                ),
              ])
            ) as Record<string, ChatUiMessage[]>,
            chatHistoryLoadedByAgent,
            sessionNamesByAgent: { ...chatSessionNameByAgentRef.current },
          };
          await writeChatCacheSnapshot(chatCacheKey, payload);
        } finally {
          chatCachePersistTimerRef.current = null;
        }
      })();
    }, 180);
    return () => {
      if (chatCachePersistTimerRef.current !== null) {
        window.clearTimeout(chatCachePersistTimerRef.current);
        chatCachePersistTimerRef.current = null;
      }
    };
  }, [chatCacheKey, selectedAgentId, messagesByAgent, chatHistoryLoadedByAgent]);

  useEffect(() => {
    messagesByAgentRef.current = messagesByAgent;
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
    const timer = window.requestAnimationFrame(() => {
      const el = chatViewportRef.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
    });
    return () => window.cancelAnimationFrame(timer);
  }, [step, selectedAgentId]);

  useEffect(() => {
    if (step !== 3 || !selectedAgentId) return;
    if (!chatStickBottomByAgentRef.current[selectedAgentId]) return;
    const timer = window.requestAnimationFrame(() => {
      const el = chatViewportRef.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
    });
    return () => window.cancelAnimationFrame(timer);
  }, [step, selectedAgentId, messagesByAgent[selectedAgentId]?.length, chatRenderLimitByAgent[selectedAgentId]]);

  useEffect(() => {
    if (step !== 3) return;
    if (!selectedAgentId) return;
    if (!selectedChatHistoryLoaded) return;
    if (selectedChatHistorySuppressed) return;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      if (chatSending) return;
      if (Date.now() - lastTypingAtRef.current < 1200) return;
      // 用户正在上滑查看历史时，暂停轮询，避免滚动卡顿和视图抖动
      if (!chatStickBottomByAgentRef.current[selectedAgentId]) return;
      const run = () => {
        void loadAgentHistoryDelta(selectedAgentId, { silent: true });
      };
      const maybeWindow = window as Window & {
        requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      };
      if (typeof maybeWindow.requestIdleCallback === "function") {
        maybeWindow.requestIdleCallback(run, { timeout: 1200 });
      } else {
        window.setTimeout(run, 80);
      }
    }, 7000);
    return () => window.clearInterval(timer);
  }, [step, selectedAgentId, customConfigPath, chatSending, selectedChatHistoryLoaded, selectedChatHistorySuppressed]);

  const markChatInteracting = useCallback((cooldownMs = 900) => {
    setChatInteracting(true);
    if (chatInteractTimerRef.current) {
      window.clearTimeout(chatInteractTimerRef.current);
    }
    chatInteractTimerRef.current = window.setTimeout(() => {
      setChatInteracting(false);
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
    chatSessionModeRef.current = chatSessionMode;
    localStorage.setItem("openclaw_chat_session_mode", chatSessionMode);
  }, [chatSessionMode]);

  useEffect(() => {
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
      if (step === 4 && tuningSection === "health") {
        void loadSavedChannels(cfgPath);
      }
    }, 350);
    return () => {
      if (configReloadTimerRef.current !== null) {
        window.clearTimeout(configReloadTimerRef.current);
        configReloadTimerRef.current = null;
      }
    };
  }, [customConfigPath, step, tuningSection]);

  // 窗口重新获得焦点时刷新安装状态（例如脚本删除后切回应用）
  useEffect(() => {
    const onFocus = () => {
      if (step === 1) {
        const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
        void refreshLocalInfo(customInstallPath.trim() || undefined, cfgPath);
      }
    };
    const handler = () => document.visibilityState === "visible" && onFocus();
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [step, customConfigPath, customInstallPath]);

  useEffect(() => {
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
      void loadSavedChannels(cfgPath);
    }
    if (step === 4 && tuningSection === "memory") {
      void refreshMemoryCenterStatus();
    }
  }, [step, tuningSection, customConfigPath, customInstallPath]);

  useEffect(() => {
    if (!installing) return;
    logEndRef.current?.scrollIntoView({ behavior: "auto" });
  }, [installLog]);

  const flushInstallLogs = () => {
    if (installLogFlushTimerRef.current !== null) {
      window.clearTimeout(installLogFlushTimerRef.current);
      installLogFlushTimerRef.current = null;
    }
    if (!installLogBufferRef.current.length) return;
    const chunk = installLogBufferRef.current.splice(0, installLogBufferRef.current.length);
    setInstallLog((prev) => {
      const merged = [...prev, ...chunk];
      return merged.length > 600 ? merged.slice(-600) : merged;
    });
  };

  const appendInstallLog = (line: string) => {
    installLogBufferRef.current.push(line);
    if (installLogFlushTimerRef.current !== null) return;
    installLogFlushTimerRef.current = window.setTimeout(() => {
      flushInstallLogs();
    }, 120);
  };

  const flushPluginLogs = () => {
    if (pluginLogFlushTimerRef.current !== null) {
      window.clearTimeout(pluginLogFlushTimerRef.current);
      pluginLogFlushTimerRef.current = null;
    }
    if (!pluginLogBufferRef.current.length) return;
    const chunk = pluginLogBufferRef.current.splice(0, pluginLogBufferRef.current.length);
    setPluginInstallProgressLog((prev) => {
      const merged = [...prev, ...chunk];
      return merged.length > 100 ? merged.slice(-100) : merged;
    });
  };

  const appendPluginLog = (line: string) => {
    pluginLogBufferRef.current.push(line);
    if (pluginLogFlushTimerRef.current !== null) return;
    pluginLogFlushTimerRef.current = window.setTimeout(() => {
      flushPluginLogs();
    }, 120);
  };

  const flushSkillsLogs = () => {
    if (skillsLogFlushTimerRef.current !== null) {
      window.clearTimeout(skillsLogFlushTimerRef.current);
      skillsLogFlushTimerRef.current = null;
    }
    if (!skillsLogBufferRef.current.length) return;
    const chunk = skillsLogBufferRef.current.splice(0, skillsLogBufferRef.current.length);
    setSkillsRepairProgressLog((prev) => {
      const merged = [...prev, ...chunk];
      return merged.length > 140 ? merged.slice(-140) : merged;
    });
  };

  const appendSkillsLog = (line: string) => {
    skillsLogBufferRef.current.push(line);
    if (skillsLogFlushTimerRef.current !== null) return;
    skillsLogFlushTimerRef.current = window.setTimeout(() => {
      flushSkillsLogs();
    }, 120);
  };

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
      if (installLogFlushTimerRef.current !== null) {
        window.clearTimeout(installLogFlushTimerRef.current);
      }
      if (pluginLogFlushTimerRef.current !== null) {
        window.clearTimeout(pluginLogFlushTimerRef.current);
      }
      if (skillsLogFlushTimerRef.current !== null) {
        window.clearTimeout(skillsLogFlushTimerRef.current);
      }
      if (configReloadTimerRef.current !== null) {
        window.clearTimeout(configReloadTimerRef.current);
      }
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
      const checkPromise = Promise.all([
        invoke<EnvCheckResult>("check_node"),
        invoke<EnvCheckResult>("check_npm"),
        invoke<EnvCheckResult>("check_git"),
        invoke<EnvCheckResult>("check_openclaw", { installHint: openclawHint }),
        invoke<{ in_path: boolean; path: string }>("check_npm_path_in_user_env"),
      ]);
      const [node, npm, git, openclaw, pathCheck] = await Promise.race([checkPromise, timeoutPromise]);
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

  const refreshLocalInfo = async (installHint?: string, cfgPath?: string) => {
    try {
      const data = await invoke<LocalOpenclawInfo>("get_local_openclaw", {
        installHint: installHint || customInstallPath || undefined,
        customPath: normalizeConfigPath(cfgPath || customConfigPath) || undefined,
      });
      setLocalInfo(data);
    } catch {
      setLocalInfo(null);
    }
    try {
      const exeData = await invoke<ExecutableCheckInfo>("check_openclaw_executable", {
        installHint: installHint || customInstallPath || undefined,
        customPath: normalizeConfigPath(cfgPath || customConfigPath) || undefined,
      });
      setExeCheckInfo(exeData);
    } catch {
      setExeCheckInfo(null);
    }
  };

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
    setInstalling(true);
    setInstallResult(null);
    setInstallLog([]);
    installLogBufferRef.current = [];
    if (installLogFlushTimerRef.current !== null) {
      window.clearTimeout(installLogFlushTimerRef.current);
      installLogFlushTimerRef.current = null;
    }
    setInstallSteps(INSTALL_STEPS.map((s) => ({ ...s, status: "pending" })));
    const unlisten = await listen<string>("install-output", (e) => {
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
    try {
      const result = await invoke<InstallResult>("install_openclaw_full", {
        installDir,
      });
      setCustomConfigPath(normalizeConfigPath(result.config_dir));
      setLastInstallDir(result.install_dir);
      setCustomInstallPath(result.install_dir);
      setInstallResult(
        `安装成功！\n安装目录: ${result.install_dir}\n配置目录: ${result.config_dir}\n已自动添加到系统 PATH，新开终端即可使用 openclaw 命令。`
      );
      await runEnvCheck(result.install_dir);
      await refreshLocalInfo(result.install_dir, result.config_dir);
    } catch (e) {
      setInstallResult(`错误: ${e}`);
    } finally {
      flushInstallLogs();
      setInstalling(false);
      unlisten();
    }
  };

  const handleSaveConfig = async () => {
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
    const ok = window.confirm(`确认卸载 OpenClaw 吗？\n安装目录：${dir}`);
    if (!ok) return;
    setUninstalling(true);
    try {
      const result = await invoke<string>("uninstall_openclaw", { installDir: dir });
      setInstallResult(result);
      setOpenclawCheck({ ok: false, message: "OpenClaw 已卸载", version: undefined });
      await runEnvCheck();
      await refreshLocalInfo();
    } catch (e) {
      setInstallResult(`卸载失败: ${e}`);
    } finally {
      setUninstalling(false);
    }
  };

  const fetchPairingRequests = useCallback(
    async (channel: PairingChannel): Promise<PairingRequestItem[]> => {
      const jsonResp = await invoke<PairingListResponse>("list_pairings_json", {
        channel,
        customPath: normalizeConfigPath(customConfigPath) || undefined,
      });
      const requests = Array.isArray(jsonResp?.requests) ? jsonResp.requests : [];
      setPairingRequestsByChannel((prev) => ({ ...prev, [channel]: requests }));
      return requests;
    },
    [customConfigPath],
  );

  const refreshAllPairingRequests = useCallback(
    async (channels?: PairingChannel[]) => {
      const targets = channels ?? (["telegram", "feishu", "qq"] as PairingChannel[]);
      await Promise.all(
        targets.map(async (channel) => {
          try {
            await fetchPairingRequests(channel);
          } catch {
            // 静默轮询，不打断用户当前操作
          }
        }),
      );
    },
    [fetchPairingRequests],
  );

  const handleListPairings = async (channel: "telegram" | "feishu" | "qq") => {
    setPairingLoading(channel);
    setChannelResult(null);
    try {
      const requests = await fetchPairingRequests(channel);
      const result = await invoke<string>("list_pairings", {
        channel,
        customPath: normalizeConfigPath(customConfigPath) || undefined,
      });
      setChannelResult(result || (requests.length === 0 ? "当前没有待审批配对请求。" : `已找到 ${requests.length} 条待审批配对请求。`));
    } catch (e) {
      setPairingRequestsByChannel((prev) => ({ ...prev, [channel]: [] }));
      setChannelResult(`查询配对失败: ${e}`);
    } finally {
      setPairingLoading(null);
    }
  };

  const handleApprovePairing = useCallback(
    async (channel: "telegram" | "feishu" | "qq", codeOverride?: string) => {
      setPairingLoading(channel);
      setChannelResult(null);
      try {
        const code = (codeOverride ?? pairingCodeByChannel[channel]).trim();
        const result = await invoke<string>("approve_pairing", {
          channel,
          code,
          customPath: normalizeConfigPath(customConfigPath) || undefined,
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
    [customConfigPath, fetchPairingRequests, pairingCodeByChannel],
  );

  const getGatewayHealthState = async (): Promise<HealthState> => {
    const installHint = (localInfo?.install_dir || customInstallPath || lastInstallDir || "").trim() || undefined;
    try {
      const gs = await invoke<string>("gateway_status", {
        customPath: normalizeConfigPath(customConfigPath) || undefined,
        installHint,
      });
      return gs.includes("Service: Scheduled Task (registered)") ? "ok" : "warn";
    } catch {
      return "error";
    }
  };

  const refreshTelegramHealth = async (gatewayStateHint?: HealthState) => {
    const hasToken = !!telegramConfig.botToken?.trim();
    let tokenState: HealthState = hasToken ? "warn" : "error";
    let gatewayState: HealthState = "unknown";
    let pairingState: HealthState = "unknown";
    let detail = "未检测";

    try {
      if (hasToken) {
        await invoke<string>("test_channel_connection", {
          channel: "telegram",
          config: telegramConfig,
        });
        tokenState = "ok";
      }
    } catch {
      tokenState = "error";
    }

    gatewayState = gatewayStateHint ?? (await getGatewayHealthState());

    try {
      const list = await invoke<string>("list_pairings", {
        channel: "telegram",
        customPath: normalizeConfigPath(customConfigPath) || undefined,
      });
      const txt = (list || "").trim().toLowerCase();
      const noPending =
        !txt ||
        txt.includes("no pending") ||
        txt.includes("none") ||
        txt.includes("empty") ||
        txt.includes("无待审批");
      pairingState = noPending ? "ok" : "warn";
      detail = noPending ? "无待配对请求" : "有待审批配对码";
    } catch {
      pairingState = "unknown";
      detail = "无法获取配对状态";
    }

    const next: ChannelHealthInfo = {
      configured: hasToken ? "ok" : "error",
      token: tokenState,
      gateway: gatewayState,
      pairing: pairingState,
      detail,
    };
    setTelegramHealth((prev) => (isSameChannelHealthInfo(prev, next) ? prev : next));
  };

  const runtimeHealthPanelVisible = step === 4 && tuningSection === "health";

  const refreshAllChannelHealth = async (force = false) => {
    if (starting || chatSending || chatInteracting) return;
    if (!force && !runtimeHealthPanelVisible) return;
    const gatewayState = await getGatewayHealthState();
    await Promise.all([
      refreshTelegramHealth(gatewayState),
    ]);
  };

  useEffect(() => {
    if (!runtimeHealthPanelVisible || starting || chatInteracting || !autoRefreshHealth) return;
    void refreshAllChannelHealth();
    void refreshAllPairingRequests();
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void refreshAllChannelHealth();
      void refreshAllPairingRequests();
    }, 60000);
    return () => window.clearInterval(timer);
  }, [runtimeHealthPanelVisible, customConfigPath, starting, autoRefreshHealth, chatSending, chatInteracting, refreshAllPairingRequests]);

  useEffect(() => {
    if (!runtimeHealthPanelVisible) return;
    void refreshAllChannelHealth(true);
    void refreshAllPairingRequests();
  }, [runtimeHealthPanelVisible, refreshAllPairingRequests]);

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

  useEffect(() => {
    const unlistenPromise = listen<ChatReplyFinishedEvent>("chat-reply-finished", (event) => {
      const payload = event.payload;
      if (!payload?.requestId) return;
      const meta = pendingChatRequestsRef.current[payload.requestId];
      if (!meta) return;
      delete pendingChatRequestsRef.current[payload.requestId];
      if (currentPendingChatRequestIdRef.current === payload.requestId) {
        currentPendingChatRequestIdRef.current = null;
        chatSendLockRef.current = false;
        setChatSending(false);
        setPendingReplyAgentId((prev) => (prev === meta.targetId ? null : prev));
      }
      if (!payload.ok) {
        setChatError(payload.error || "等待回复失败");
        setMessagesByAgent((prev) => ({
          ...prev,
          [meta.targetId]: (prev[meta.targetId] || []).map((m) =>
            m.id === meta.userMsgId ? { ...m, status: "failed" as const } : m
          ),
        }));
        return;
      }
      const replyText = String(payload.text || "").trim();
      const finalText = meta.mode === "orchestrator"
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
      };
      startTransition(() => {
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
      }
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

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
    setStartResult("后台启动已提交，正在准备 Gateway...");
    const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
    const installHint = (localInfo?.install_dir || customInstallPath || lastInstallDir || "").trim() || undefined;
    try {
      const result = await invoke<string>("start_gateway_background", {
        customPath: cfgPath,
        installHint,
      });
      setStartResult(stripAnsi(result));
      setStep(3);
    } catch (e) {
      setStarting(false);
      setStartResult(stripAnsi(`启动失败: ${e}`));
    }
  };

  const handleOpenBrowserChat = async () => {
    try {
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      const gatewayId = selectedAgentId ? getPreferredGatewayIdForAgent(selectedAgentId) : undefined;
      const url = await invoke<string>("get_gateway_dashboard_url", { customPath: cfgPath, gatewayId });
      await invoke<string>("open_external_url", { url });
    } catch (e) {
      setStartResult(`打开浏览器对话失败: ${e}`);
    }
  };

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
      setPluginInstallProgressLog([]);
      pluginLogBufferRef.current = [];
      if (pluginLogFlushTimerRef.current !== null) {
        window.clearTimeout(pluginLogFlushTimerRef.current);
        pluginLogFlushTimerRef.current = null;
      }
      const unlisten = await listen<PluginInstallProgressEvent>("plugin-install-progress", (e) => {
        const payload = e.payload;
        if (!payload) return;
        setPluginInstallProgress(payload);
        appendPluginLog(`[${payload.current}/${payload.total}] ${payload.channel}: ${payload.message}`);
      });
      try {
        const installHint = (localInfo?.install_dir || customInstallPath || lastInstallDir || "").trim() || undefined;
        const selectedChannels = Object.keys(pluginSelection).filter((k) => pluginSelection[k]);
        const result = await invoke<string>("auto_install_channel_plugins", {
          channels: selectedChannels,
          customPath: normalizeConfigPath(customConfigPath) || undefined,
          installHint,
        });
        setPluginInstallResult(clampLogText(result));
      } catch (e) {
        setPluginInstallResult(`自动安装插件失败: ${e}`);
        setTicketSummary(makeTicketSummary("渠道插件自动安装", e, "auto_install_channel_plugins"));
        throw e;
      } finally {
        flushPluginLogs();
        unlisten();
        setPluginInstallLoading(false);
      }
    });
  };

  const handleSkillsManage = async (action: "list" | "install" | "update" | "reinstall") => {
    if (skillsLoading) return;
    setSkillsLoading(true);
    setSkillsResult(null);
    try {
      const installHint = (localInfo?.install_dir || customInstallPath || lastInstallDir || "").trim() || undefined;
      const result = await invoke<string>("skills_manage", {
        action,
        customPath: normalizeConfigPath(customConfigPath) || undefined,
        installHint,
      });
      setSkillsResult(clampLogText(result));
    } catch (e) {
      setSkillsResult(`Skills 操作失败: ${e}`);
    } finally {
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
      setMarketResult(`正在安装 ${skill.name} 到共享 Skills 层...`);
      try {
        const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
        const result = await invoke<string>("install_market_skill", {
          sourceType: skill.source_type || "github",
          packageName: skill.package_name || skill.name,
          repoUrl: skill.repo_url || undefined,
          version: skill.version || undefined,
          customPath: cfgPath,
        });
        await loadSkillsCatalog();
        if (enableForCurrentAgent && effectiveSkillsAgentId) {
          const baseSet =
            currentAgentSkillBinding?.mode === "custom"
              ? new Set(currentAgentSkillBinding.enabled_skills || [])
              : new Set(skillsCatalog.map((item) => item.name));
          baseSet.add(skill.package_name || skill.name);
          await persistAgentSkillBinding(
            effectiveSkillsAgentId,
            "custom",
            Array.from(baseSet),
            `${result}\n\n并已加入 ${effectiveSkillsAgentId} 的独立 Skills 清单`
          );
          setMarketResult(`${result}\n\n并已加入 ${effectiveSkillsAgentId} 的独立 Skills 清单`);
        } else {
          setMarketResult(result);
        }
      } catch (e) {
        setMarketResult(`安装第三方 Skill 失败: ${e}`);
      } finally {
        setMarketInstallKey(null);
      }
    },
    [customConfigPath, currentAgentSkillBinding, effectiveSkillsAgentId, loadSkillsCatalog, marketInstallKey, persistAgentSkillBinding, skillsCatalog]
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
    setMarketResult("正在导入本地 Skill 到共享层...");
    try {
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      const result = await invoke<string>("install_local_skill", {
        localPath: path,
        customPath: cfgPath,
      });
      await loadSkillsCatalog();
      setMarketResult(result);
    } catch (e) {
      setMarketResult(`导入本地 Skill 失败: ${e}`);
    } finally {
      setLocalSkillInstalling(false);
    }
  }, [customConfigPath, loadSkillsCatalog, localSkillInstalling, localSkillPath]);

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
      setSkillsRepairProgressLog([]);
      skillsLogBufferRef.current = [];
      if (skillsLogFlushTimerRef.current !== null) {
        window.clearTimeout(skillsLogFlushTimerRef.current);
        skillsLogFlushTimerRef.current = null;
      }
      const unlisten = await listen<SkillsRepairProgressEvent>("skills-repair-progress", (e) => {
        const payload = e.payload;
        if (!payload) return;
        setSkillsRepairProgress(payload);
        appendSkillsLog(`[${payload.current}/${payload.total}] ${payload.skill}: ${payload.message}`);
      });
      try {
        const installHint = (localInfo?.install_dir || customInstallPath || lastInstallDir || "").trim() || undefined;
        const result = await invoke<string>("install_selected_skills", {
          skillNames: selected,
          customPath: normalizeConfigPath(customConfigPath) || undefined,
          installHint,
        });
        const text = clampLogText(result || "").trim();
        setSkillsResult(text || "安装任务已完成（无详细日志返回）");
        const refreshed = await loadSkillsCatalog();
        setSkillRepairStateByName((prev) => {
          const next = { ...prev };
          for (const name of selected) {
            const hit = refreshed.find((item) => item.name === name);
            if (!hit) continue;
            next[name] = hit.eligible ? "fixed" : hasManualSkillGaps(hit) ? "manual" : "still_missing";
          }
          return next;
        });
      } catch (e) {
        setSkillsResult(`安装失败: ${e}`);
        setTicketSummary(makeTicketSummary("安装选中Skills", e, "install_selected_skills"));
        throw e;
      } finally {
        flushSkillsLogs();
        unlisten();
        setSkillsRepairLoading(false);
        setSkillsAction(null);
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
      setSkillsRepairProgressLog([]);
      skillsLogBufferRef.current = [];
      if (skillsLogFlushTimerRef.current !== null) {
        window.clearTimeout(skillsLogFlushTimerRef.current);
        skillsLogFlushTimerRef.current = null;
      }
      const unlisten = await listen<SkillsRepairProgressEvent>("skills-repair-progress", (e) => {
        const payload = e.payload;
        if (!payload) return;
        setSkillsRepairProgress(payload);
        appendSkillsLog(`[${payload.current}/${payload.total}] ${payload.skill}: ${payload.message}`);
      });
      try {
        const installHint = (localInfo?.install_dir || customInstallPath || lastInstallDir || "").trim() || undefined;
        const result = await invoke<string>("repair_selected_skills", {
          skillNames: selected,
          customPath: normalizeConfigPath(customConfigPath) || undefined,
          installHint,
        });
        const text = clampLogText(result || "").trim();
        setSkillsResult(text || "修复任务已完成（无详细日志返回）");
        const refreshed = await loadSkillsCatalog();
        setSkillRepairStateByName((prev) => {
          const next = { ...prev };
          for (const name of selected) {
            const hit = refreshed.find((item) => item.name === name);
            if (!hit) continue;
            next[name] = hit.eligible ? "fixed" : hasManualSkillGaps(hit) ? "manual" : "still_missing";
          }
          return next;
        });
      } catch (e) {
        setSkillsResult(`修复失败: ${e}`);
        setTicketSummary(makeTicketSummary("修复选中Skills", e, "repair_selected_skills"));
        throw e;
      } finally {
        flushSkillsLogs();
        unlisten();
        setSkillsRepairLoading(false);
        setSkillsAction(null);
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

  const refreshAgentsList = async () => {
    setAgentsLoading(true);
    setAgentsError(null);
    try {
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      const resp = await invoke<AgentsListPayload>("read_agents_list", {
        customPath: cfgPath,
      });
      setAgentsList(resp);
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
      setAgentsError(String(e));
      setAgentsList(null);
    } finally {
      setAgentsLoading(false);
    }
  };

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
    if (raw.includes("Service: Scheduled Task")) return "运行中";
    if (raw.includes("running") || raw.includes("listening on")) return "运行中";
    if (raw.includes("loopback-only")) return "仅本机可访问";
    return raw.length > 72 ? `${raw.slice(0, 72)}...` : raw;
  }, []);

  const formatOrderedChannelBindings = useCallback((binding?: Record<string, string>, fallback?: { channel?: string; instance_id?: string }) => {
    const order = ["telegram", "qq", "feishu", "discord", "dingtalk"];
    const entries = Object.entries(binding || {}).filter(([, iid]) => String(iid || "").trim());
    if (entries.length === 0) {
      const ch = String(fallback?.channel || "").trim();
      const iid = String(fallback?.instance_id || "").trim();
      return ch && iid ? `${ch}: ${iid}` : "-";
    }
    return entries
      .sort((a, b) => {
        const ai = order.indexOf(a[0]);
        const bi = order.indexOf(b[0]);
        const av = ai >= 0 ? ai : 999;
        const bv = bi >= 0 ? bi : 999;
        return av - bv || a[0].localeCompare(b[0]);
      })
      .map(([ch, iid]) => `${ch}: ${iid}`)
      .join(" | ");
  }, []);

  const refreshAgentRuntimeSettings = useCallback(async (agentsForFallback?: AgentListItem[]) => {
    try {
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      const resp = await invoke<AgentRuntimeSettingsPayload>("read_agent_runtime_settings", {
        customPath: cfgPath,
      });
      setAgentRuntimeSettings(resp);
      setChannelRoutesDraft(resp.channel_routes || []);
      setGatewayBindingsDraft(resp.gateways || []);
      setTelegramInstancesDraft(resp.telegram_instances || []);
      setChannelInstancesDraft(resp.channel_instances || []);
      setActiveChannelInstanceByChannel(resp.active_channel_instances || {});
      setTelegramUsernameByInstanceId((prev) => {
        const next: Record<string, string> = {};
        for (const it of resp.telegram_instances || []) {
          if (prev[it.id]) next[it.id] = prev[it.id];
        }
        return next;
      });
      setActiveTelegramInstanceId(resp.active_telegram_instance || resp.telegram_instances?.[0]?.id || "");
      setGatewaySelectedIdForRouteTest((prev) => {
        if (prev && (resp.gateways || []).some((g) => g.gateway_id === prev)) return prev;
        return (resp.gateways || [])[0]?.gateway_id || "";
      });
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
      setAgentProfileDrafts(drafts);
    } catch (e) {
      setAgentRuntimeResult(`读取 Agent 运行时配置失败: ${e}`);
    }
  }, [customConfigPath, agentsList?.agents, parseProviderAndModelFromPrimary]);

  useEffect(() => {
    if (step !== 4 || !["agents", "skills"].includes(tuningSection)) return;
    const list = agentsList?.agents || [];
    if (list.length === 0) return;
    void refreshAgentRuntimeSettings(list);
  }, [step, tuningSection, agentsList, refreshAgentRuntimeSettings]);

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
        const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
        await invoke("upsert_agent_runtime_profile", {
          agentId,
          provider: draft.provider,
          model: draft.model,
          customPath: cfgPath,
        });
        await Promise.all([refreshAgentsList(), refreshAgentRuntimeSettings()]);
        setAgentRuntimeResult(`已保存 ${agentId} 的模型配置`);
      } catch (e) {
        setAgentRuntimeResult(`保存失败: ${e}`);
      } finally {
        setAgentRuntimeSaving(false);
      }
    },
    [agentProfileDrafts, customConfigPath, refreshAgentsList, refreshAgentRuntimeSettings]
  );

  const saveChannelRoutes = useCallback(async () => {
    setAgentRuntimeSaving(true);
    setAgentRuntimeResult(null);
    try {
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
      await refreshAgentRuntimeSettings();
      setAgentRuntimeResult("渠道调阅路由已保存");
    } catch (e) {
      setAgentRuntimeResult(`保存渠道路由失败: ${e}`);
    } finally {
      setAgentRuntimeSaving(false);
    }
  }, [channelRoutesDraft, customConfigPath, refreshAgentRuntimeSettings]);

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
    if (fallbackCh && fallbackIid && !out[fallbackCh]) {
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

  const buildCurrentActiveChannelInstanceMap = useCallback((): Record<string, string> => {
    const out: Record<string, string> = {};
    const tg = (activeTelegramInstanceId || "").trim();
    if (tg) out.telegram = tg;
    for (const [ch, iid] of Object.entries(activeChannelInstanceByChannel || {})) {
      const chNorm = (ch || "").trim().toLowerCase();
      const iidNorm = (iid || "").trim();
      if (!chNorm || !iidNorm) continue;
      out[chNorm] = iidNorm;
    }
    return out;
  }, [activeTelegramInstanceId, activeChannelInstanceByChannel]);

  const buildChannelInstanceMapForAgent = useCallback(
    (agentId: string): Record<string, string> => {
      const base = buildCurrentActiveChannelInstanceMap();
      const aid = (agentId || "").trim();
      if (!aid) return base;

      // 优先使用“路由里该 Agent 的 bot_instance”，避免多个网关抢同一个 Telegram token。
      for (const r of channelRoutesDraft || []) {
        if (!r.enabled) continue;
        if ((r.agent_id || "").trim() !== aid) continue;
        const ch = (r.channel || "").trim().toLowerCase();
        const iid = (r.bot_instance || "").trim();
        if (!ch || !iid) continue;
        base[ch] = iid;
      }

      // Telegram 兜底：常见命名 tg-<agentId>
      if (!base.telegram) {
        const fallbackTgId = `tg-${aid}`;
        if ((telegramInstancesDraft || []).some((x) => (x.id || "").trim() === fallbackTgId)) {
          base.telegram = fallbackTgId;
        }
      }
      return base;
    },
    [buildCurrentActiveChannelInstanceMap, channelRoutesDraft, telegramInstancesDraft]
  );

  const buildAutoGatewayBindingsDraft = useCallback((existingDraft?: GatewayBinding[]) => {
    const agents = agentsList?.agents || [];
    const globalActiveMap = buildCurrentActiveChannelInstanceMap();
    if (agents.length === 0 || Object.keys(globalActiveMap).length === 0) return [];

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
      const fallbackChannel = old?.channel || (Object.keys(channelMap)[0] || "telegram");
      const fallbackInstance =
        old?.instance_id || channelMap[fallbackChannel] || channelMap.telegram || Object.values(channelMap)[0] || "";
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
  }, [agentsList?.agents, buildCurrentActiveChannelInstanceMap, buildChannelInstanceMapForAgent, gatewayBindingsDraft]);

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
      setAgentRuntimeResult("当前没有可自动生成的 Agent 网关。请先保存实例池并选择激活实例。");
      return;
    }
    setGatewayBindingsDraft(next);
    setAgentRuntimeResult(
      `已按 Agent 自动生成 ${next.length} 条网关：每个 Agent 一条，并自动挂上该 Agent 的多渠道配置。`
    );
  }, [buildAutoGatewayBindingsDraft]);

  const saveGatewayBindings = useCallback(async () => {
    setAgentRuntimeSaving(true);
    setAgentRuntimeResult(null);
    try {
      const next = await persistGatewayBindingsDraft(gatewayBindingsDraft || []);
      setGatewayBindingsDraft(next || []);
      setAgentRuntimeResult(`已保存网关绑定 ${next?.length || 0} 项`);
    } catch (e) {
      setAgentRuntimeResult(`保存网关绑定失败: ${e}`);
    } finally {
      setAgentRuntimeSaving(false);
    }
  }, [gatewayBindingsDraft, persistGatewayBindingsDraft]);

  const refreshGatewayInstances = useCallback(async () => {
    try {
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      const list = await invoke<GatewayBinding[]>("list_gateway_instances", {
        customPath: cfgPath,
      });
      setGatewayBindingsDraft(list || []);
    } catch (e) {
      setAgentRuntimeResult(`刷新网关实例失败: ${e}`);
    }
  }, [customConfigPath]);

  const runGatewayAction = useCallback(
    async (action: "start" | "stop" | "restart" | "health" | "logs", gatewayId: string) => {
      const gid = (gatewayId || "").trim();
      if (!gid) return;
      setGatewayActionLoadingById((prev) => ({ ...prev, [gid]: true }));
      try {
        const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
        const installHint = (localInfo?.install_dir || customInstallPath || lastInstallDir || "").trim() || undefined;
        if (action === "start") {
          const msg = await invoke<string>("start_gateway_instance", {
            gatewayId: gid,
            customPath: cfgPath,
            installHint,
          });
          setAgentRuntimeResult(msg);
        } else if (action === "stop") {
          const msg = await invoke<string>("stop_gateway_instance", {
            gatewayId: gid,
            customPath: cfgPath,
            installHint,
          });
          setAgentRuntimeResult(msg);
        } else if (action === "restart") {
          const msg = await invoke<string>("restart_gateway_instance", {
            gatewayId: gid,
            customPath: cfgPath,
            installHint,
          });
          setAgentRuntimeResult(msg);
        } else if (action === "health") {
          const row = await invoke<GatewayBinding>("health_gateway_instance", {
            gatewayId: gid,
            customPath: cfgPath,
          });
          setGatewayBindingsDraft((prev) => prev.map((g) => (g.gateway_id === gid ? row : g)));
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
        if (action !== "logs") {
          await refreshGatewayInstances();
        }
      } catch (e) {
        setAgentRuntimeResult(`网关操作失败(${action}/${gid}): ${e}`);
      } finally {
        setGatewayActionLoadingById((prev) => ({ ...prev, [gid]: false }));
      }
    },
    [customConfigPath, localInfo?.install_dir, customInstallPath, lastInstallDir, refreshGatewayInstances]
  );

  const runStartAllEnabledGateways = useCallback(async () => {
    setGatewayBatchLoading("start");
    try {
      const enabled = (gatewayBindingsDraft || []).filter((g) => g.enabled);
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
        setAgentRuntimeResult(`已拦截批量启动：检测到 Telegram 轮询冲突（会导致 409）。\n${detail}\n请先改为每个 Telegram 实例只被一个网关绑定。`);
        return;
      }
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      const installHint = (localInfo?.install_dir || customInstallPath || lastInstallDir || "").trim() || undefined;
      const msg = await invoke<string>("start_all_enabled_gateways", {
        customPath: cfgPath,
        installHint,
      });
      setAgentRuntimeResult(msg);
      await refreshGatewayInstances();
    } catch (e) {
      setAgentRuntimeResult(`批量启动失败: ${e}`);
    } finally {
      setGatewayBatchLoading(null);
    }
  }, [
    customConfigPath,
    localInfo?.install_dir,
    customInstallPath,
    lastInstallDir,
    refreshGatewayInstances,
    gatewayBindingsDraft,
    parseGatewayChannelInstances,
  ]);

  const runHealthAllEnabledGateways = useCallback(async () => {
    setGatewayBatchLoading("health");
    try {
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      const list = await invoke<GatewayBinding[]>("health_all_enabled_gateways", {
        customPath: cfgPath,
      });
      setGatewayBindingsDraft(list || []);
      const ok = (list || []).filter((g) => g.health?.status === "ok").length;
      setAgentRuntimeResult(`批量健康检查完成：ok ${ok} / total ${(list || []).length}`);
    } catch (e) {
      setAgentRuntimeResult(`批量健康检查失败: ${e}`);
    } finally {
      setGatewayBatchLoading(null);
    }
  }, [customConfigPath]);

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

  const saveTelegramInstances = useCallback(async () => {
    setAgentRuntimeSaving(true);
    setAgentRuntimeResult(null);
    try {
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      const cleaned = telegramInstancesDraft
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
        activeInstanceId: (activeTelegramInstanceId || "").trim() || undefined,
        customPath: cfgPath,
      });
      setAgentRuntimeSettings(resp);
      setGatewayBindingsDraft(resp.gateways || []);
      setChannelRoutesDraft(resp.channel_routes || []);
      setTelegramInstancesDraft(resp.telegram_instances || []);
      setTelegramUsernameByInstanceId((prev) => {
        const next: Record<string, string> = {};
        for (const it of resp.telegram_instances || []) {
          if (prev[it.id]) next[it.id] = prev[it.id];
        }
        return next;
      });
      setActiveTelegramInstanceId(resp.active_telegram_instance || resp.telegram_instances?.[0]?.id || "");
      setAgentRuntimeResult("Telegram 机器人实例已保存");
      return resp;
    } catch (e) {
      setAgentRuntimeResult(`保存 Telegram 实例失败: ${e}`);
      return null;
    } finally {
      setAgentRuntimeSaving(false);
    }
  }, [telegramInstancesDraft, activeTelegramInstanceId, customConfigPath]);

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
    setAgentRuntimeResult("已按当前 Agent 自动生成 Telegram 实例与路由。请逐个填写 Token 后保存。");
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
      setAgentRuntimeSettings(saveResp);
      setTelegramInstancesDraft(
        (saveResp.telegram_instances || []).map((x) => ({ ...x, chat_id: x.chat_id || "" }))
      );
      setActiveTelegramInstanceId(saveResp.active_telegram_instance || activeInstanceId);

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
      setAgentRuntimeResult(
        `首次配置向导完成：\n1) 实例池已保存\n2) 已应用实例 ${saveResp.active_telegram_instance || activeInstanceId}\n3) 路由已保存\n4) 测试已执行`
      );
    } catch (e) {
      setAgentRuntimeResult(`首次配置向导失败: ${e}`);
    } finally {
      setTelegramWizardRunning(false);
    }
  }, [telegramWizardRunning, agentsList, telegramInstancesDraft, customConfigPath, channelRoutesDraft]);

  const applyTelegramInstance = useCallback(
    async (instanceId: string) => {
      if (!instanceId) return;
      setAgentRuntimeSaving(true);
      setAgentRuntimeResult(null);
      try {
        const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
        const result = await invoke<string>("apply_telegram_instance", {
          instanceId,
          customPath: cfgPath,
        });
        setActiveTelegramInstanceId(instanceId);
        const tg = await invoke<ChannelConfig>("read_channel_config", { channel: "telegram", customPath: cfgPath });
        setTelegramConfig({
          botToken: tg?.botToken ?? "",
          chatId: tg?.chatId ?? "",
        });
        await refreshAgentRuntimeSettings();
        setAgentRuntimeResult(result || `已应用实例 ${instanceId}`);
        return result || `已应用实例 ${instanceId}`;
      } catch (e) {
        setAgentRuntimeResult(`应用 Telegram 实例失败: ${e}`);
        return null;
      } finally {
        setAgentRuntimeSaving(false);
      }
    },
    [customConfigPath, refreshAgentRuntimeSettings]
  );

  const testTelegramInstancesBatch = useCallback(async () => {
    setTelegramBatchTesting(true);
    try {
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      const result = await invoke<TelegramInstanceHealth[]>("test_telegram_instances", {
        customPath: cfgPath,
      });
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
    } catch (e) {
      setAgentRuntimeResult(`批量 getMe 检查失败: ${e}`);
    } finally {
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
    const c1 = (row.credential1 || "").trim();
    const c2 = (row.credential2 || "").trim();
    if (channel === "discord") return !!c1;
    return !!c1 && !!c2;
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
      setAgentRuntimeResult(`已按 Agent 自动生成 ${channel} 实例与路由，请填写凭据后保存并应用。`);
    },
    [agentsList, channelInstancesDraft, channelRoutesDraft]
  );

  const saveChannelInstances = useCallback(
    async (channel: NonTelegramChannel) => {
      setAgentRuntimeSaving(true);
      setAgentRuntimeResult(null);
      try {
        const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
        const cleaned = channelInstancesDraft
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
          activeInstanceId: (activeChannelInstanceByChannel[channel] || "").trim() || undefined,
          customPath: cfgPath,
        });
        setAgentRuntimeSettings(resp);
        setGatewayBindingsDraft(resp.gateways || []);
        setChannelRoutesDraft(resp.channel_routes || []);
        setTelegramInstancesDraft(resp.telegram_instances || []);
        setChannelInstancesDraft(resp.channel_instances || []);
        setActiveTelegramInstanceId(resp.active_telegram_instance || resp.telegram_instances?.[0]?.id || "");
        setActiveChannelInstanceByChannel(resp.active_channel_instances || {});
        setAgentRuntimeResult(`${channel} 实例池已保存`);
        return resp;
      } catch (e) {
        setAgentRuntimeResult(`保存 ${channel} 实例池失败: ${e}`);
        return null;
      } finally {
        setAgentRuntimeSaving(false);
      }
    },
    [customConfigPath, channelInstancesDraft, activeChannelInstanceByChannel]
  );

  const applyChannelInstance = useCallback(
    async (channel: NonTelegramChannel, instanceId: string) => {
      if (!instanceId) return;
      setAgentRuntimeSaving(true);
      setAgentRuntimeResult(null);
      try {
        const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
        const result = await invoke<string>("apply_channel_instance", {
          channel,
          instanceId,
          customPath: cfgPath,
        });
        setActiveChannelInstanceByChannel((prev) => ({ ...prev, [channel]: instanceId }));
        await refreshAgentRuntimeSettings();
        setAgentRuntimeResult(result || `已应用 ${channel} 实例 ${instanceId}`);
        return result || `已应用 ${channel} 实例 ${instanceId}`;
      } catch (e) {
        setAgentRuntimeResult(`应用 ${channel} 实例失败: ${e}`);
        return null;
      } finally {
        setAgentRuntimeSaving(false);
      }
    },
    [customConfigPath, refreshAgentRuntimeSettings]
  );

  const saveAndApplyTelegramSetup = useCallback(async () => {
    if (!activeTelegramInstanceId) {
      setAgentRuntimeResult("请先选择一个 Telegram 激活实例");
      return;
    }
    const saved = await saveTelegramInstances();
    if (!saved) return;
    const applied = await applyTelegramInstance(activeTelegramInstanceId);
    if (!applied) return;
    try {
      const nextDraft = buildAutoGatewayBindingsDraft(saved.gateways || gatewayBindingsDraft);
      if (nextDraft.length > 0) {
        setGatewayBindingsDraft(nextDraft);
        const savedGateways = await persistGatewayBindingsDraft(nextDraft);
        setGatewayBindingsDraft(savedGateways || []);
      }
      setAgentRuntimeResult(`已保存 Telegram 实例、应用到网关，并同步更新 Agent 网关。`);
    } catch (e) {
      setAgentRuntimeResult(`Telegram 网关同步失败: ${e}`);
    }
  }, [
    activeTelegramInstanceId,
    saveTelegramInstances,
    applyTelegramInstance,
    buildAutoGatewayBindingsDraft,
    gatewayBindingsDraft,
    persistGatewayBindingsDraft,
  ]);

  const saveAndApplyChannelSetup = useCallback(async (channel: NonTelegramChannel) => {
    const activeId = (activeChannelInstanceByChannel[channel] || "").trim();
    if (!activeId) {
      setAgentRuntimeResult(`请先选择 ${channel} 的激活实例`);
      return;
    }
    const saved = await saveChannelInstances(channel);
    if (!saved) return;
    const applied = await applyChannelInstance(channel, activeId);
    if (!applied) return;
    try {
      const nextDraft = buildAutoGatewayBindingsDraft(saved.gateways || gatewayBindingsDraft);
      if (nextDraft.length > 0) {
        setGatewayBindingsDraft(nextDraft);
        const savedGateways = await persistGatewayBindingsDraft(nextDraft);
        setGatewayBindingsDraft(savedGateways || []);
      }
      setAgentRuntimeResult(`已保存 ${channel} 实例、应用到网关，并同步更新 Agent 网关。`);
    } catch (e) {
      setAgentRuntimeResult(`${channel} 网关同步失败: ${e}`);
    }
  }, [
    activeChannelInstanceByChannel,
    saveChannelInstances,
    applyChannelInstance,
    buildAutoGatewayBindingsDraft,
    gatewayBindingsDraft,
    persistGatewayBindingsDraft,
  ]);

  const testChannelInstancesBatch = useCallback(
    async (channel: NonTelegramChannel) => {
      setChannelBatchTestingByChannel((prev) => ({ ...prev, [channel]: true }));
      try {
        const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
        const result = await invoke<ChannelInstanceHealth[]>("test_channel_instances", {
          channel,
          customPath: cfgPath,
        });
        if (!result.length) {
          setAgentRuntimeResult(`${channel} 批量检测完成：没有可检查的实例。`);
          return;
        }
        const okCount = result.filter((r) => r.ok).length;
        const lines = result.map((r) => `${r.ok ? "✅" : "❌"} ${r.id} - ${r.detail}`);
        setAgentRuntimeResult(`${channel} 批量检测完成：${okCount}/${result.length} 通过\n${lines.join("\n")}`);
      } catch (e) {
        setAgentRuntimeResult(`${channel} 批量检测失败: ${e}`);
      } finally {
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
            ? "\n💡 建议：请先点“保存实例池”，再检测这一行。"
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
        setAgentRuntimeResult(
          `${channel} 首次配置向导完成：\n1) 实例池已保存\n2) 已应用实例 ${
            saveResp.active_channel_instances?.[channel] || activeInstanceId
          }\n3) 路由已保存\n4) 测试已执行`
        );
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
    [agentNameDrafts, agentsList, customConfigPath]
  );

  const enabledGatewaysByAgent = useMemo(() => {
    const map: Record<string, GatewayBinding[]> = {};
    for (const g of gatewayBindingsDraft || []) {
      if (!g.enabled) continue;
      const aid = (g.agent_id || "").trim();
      if (!aid) continue;
      if (!map[aid]) map[aid] = [];
      map[aid].push(g);
    }
    return map;
  }, [gatewayBindingsDraft]);

  const getPreferredGatewayIdForAgent = useCallback(
    (agentId: string): string | undefined => {
      const list = enabledGatewaysByAgent[agentId] || [];
      if (list.length === 0) return undefined;
      const preferred = (preferredGatewayByAgent[agentId] || "").trim();
      if (preferred && list.some((g) => g.gateway_id === preferred)) return preferred;
      return list[0]?.gateway_id;
    },
    [enabledGatewaysByAgent, preferredGatewayByAgent]
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
      const localMessages = messagesByAgentRef.current[agentId] || [];
      const knownFingerprints = localMessages
        .slice(-24)
        .map((m) => makeChatMessageFingerprint(m))
        .filter(Boolean);
      const resp = await invoke<{ session_key: string; cursor: number; messages: ChatUiMessage[] }>(
        "chat_list_history_delta",
        {
          agentId,
          sessionName,
          cursor: 0,
          gatewayId,
          customPath: cfgPath,
          preferGatewayDir: chatSessionModeRef.current === "synced",
          knownFingerprints,
          limit: 24,
        }
      );
      const delta = (resp.messages || []).map((m) => ({ ...m, status: "sent" as const }));
      if (delta.length === 0) return;
      startTransition(() => {
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

  const setAgentSpecialtyIdentity = async (agentId: string) => {
    if (!agentId) return;
    const specialty = getAgentSpecialty(agentId);
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
    } catch {
      // ignore identity write error, not blocking chat
    }
  };

  const handleSelectAgentForChat = useCallback(
    async (agentId: string) => {
      setSelectedAgentId(agentId);
      setSelectedChatStickBottom(chatStickBottomByAgentRef.current[agentId] ?? true);
      setUnreadByAgent((prev) => ({ ...prev, [agentId]: 0 }));
      setChatError(null);
      void setAgentSpecialtyIdentity(agentId);
      // 切换 Agent 时只切本地聊天框，不再自动查远端历史。
    },
    [setAgentSpecialtyIdentity]
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
        knownFingerprints: string[];
      }
    ) => {
      pendingChatRequestsRef.current[meta.requestId] = meta;
      currentPendingChatRequestIdRef.current = meta.requestId;
      await invoke<string>("chat_wait_for_reply_background", {
        requestId: meta.requestId,
        agentId: args.agentId,
        sessionName: args.sessionName,
        gatewayId: args.gatewayId,
        customPath: args.customPath,
        preferGatewayDir: args.preferGatewayDir,
        knownFingerprints: args.knownFingerprints,
      });
    },
    []
  );

  const handleSendChat = useCallback(async (draftText?: string): Promise<boolean> => {
    if (chatSending || chatSendLockRef.current) return false;
    markChatInteracting(1500);
    const raw = (draftText ?? chatDraft).trim();
    if (!raw) return false;
    const { targetId, normalizedText, hint } = resolveTargetAgent(raw);
    if (!targetId || !normalizedText) return false;
    const dedupText = normalizeChatText(normalizedText);
    const lastSent = lastSentFingerprintRef.current[targetId];
    if (lastSent && lastSent.text === dedupText && Date.now() - lastSent.at < 8000) {
      setRouteHint("已拦截短时间重复发送（同 Agent 同内容）。");
      return false;
    }
    lastSentFingerprintRef.current[targetId] = { text: dedupText, at: Date.now() };
    chatSendLockRef.current = true;
    setPendingReplyAgentId(targetId);
    setChatHistoryLoadedByAgent((prev) => (prev[targetId] ? prev : { ...prev, [targetId]: true }));
    setChatHistorySuppressedByAgent((prev) => {
      if (!prev[targetId]) return prev;
      return { ...prev, [targetId]: false };
    });
    if (draftText === undefined) setChatDraft("");
    setChatSending(true);
    setChatError(null);

    const userMsg: ChatUiMessage = {
      id: `local-user-${Date.now()}`,
      role: "user",
      text: normalizedText,
      status: "sending",
    };
    startTransition(() => {
      setMessagesByAgent((prev) => ({
        ...prev,
        [targetId]: trimChatMessagesForUi([...(prev[targetId] || []), userMsg]),
      }));
    });

    const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
    const preferGatewayDir = chatSessionModeRef.current === "synced";
    const sessionName = getOrCreateChatSessionName(targetId);
    const targetGatewayId = getPreferredGatewayIdForAgent(targetId);
    const routeHintText = hint ? `${hint}${targetGatewayId ? ` · 网关 ${targetGatewayId}` : ""}` : (targetGatewayId ? `网关 ${targetGatewayId}` : null);
    setRouteHint(routeHintText);
    let waitingInBackground = false;
    try {
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
        const executionSession = getOrCreateChatSessionName(executionAgent);
        const executionGatewayId = getPreferredGatewayIdForAgent(executionAgent);
        await invoke("chat_send", {
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
        setMessagesByAgent((prev) => ({
          ...prev,
          [targetId]: (prev[targetId] || []).map((m) =>
            m.id === userMsg.id ? { ...m, status: "sent" as const } : m
          ),
        }));
        const executionKnownFingerprints = (messagesByAgentRef.current[executionAgent] || [])
          .concat([{ ...userMsg, status: "sent" as const }])
          .slice(-24)
          .map((m) => makeChatMessageFingerprint(m))
          .filter(Boolean);
        await startBackgroundReplyWait(
          {
            requestId: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            targetId,
            userMsgId: userMsg.id,
            mode: "orchestrator",
            flowSummary,
          },
          {
            agentId: executionAgent,
            sessionName: executionSession,
            gatewayId: executionGatewayId,
            customPath: cfgPath,
            preferGatewayDir,
            knownFingerprints: executionKnownFingerprints,
          }
        );
        waitingInBackground = true;
        return true;
      }

      await invoke("chat_send", {
        agentId: targetId,
        sessionName,
        text: normalizedText,
        gatewayId: targetGatewayId,
        customPath: cfgPath,
        preferGatewayDir,
      });
      setMessagesByAgent((prev) => ({
        ...prev,
        [targetId]: (prev[targetId] || []).map((m) =>
          m.id === userMsg.id ? { ...m, status: "sent" } : m
        ),
      }));
      const knownFingerprints = (messagesByAgentRef.current[targetId] || [])
        .concat([{ ...userMsg, status: "sent" as const }])
        .slice(-24)
        .map((m) => makeChatMessageFingerprint(m))
        .filter(Boolean);
      await startBackgroundReplyWait(
        {
          requestId: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          targetId,
          userMsgId: userMsg.id,
          mode: "direct",
        },
        {
          agentId: targetId,
          sessionName,
          gatewayId: targetGatewayId,
          customPath: cfgPath,
          preferGatewayDir,
          knownFingerprints,
        }
      );
      waitingInBackground = true;
      return true;
    } catch (e) {
      currentPendingChatRequestIdRef.current = null;
      setChatError(String(e));
      setMessagesByAgent((prev) => ({
        ...prev,
        [targetId]: (prev[targetId] || []).map((m) => (m.id === userMsg.id ? { ...m, status: "failed" } : m)),
      }));
      return false;
    } finally {
      if (!waitingInBackground) {
        setChatSending(false);
        setPendingReplyAgentId((prev) => (prev === targetId ? null : prev));
        chatSendLockRef.current = false;
      }
    }
  }, [chatSending, chatDraft, resolveTargetAgent, selectedAgentId, chatExecutionMode, customConfigPath, getOrCreateChatSessionName, markChatInteracting, getPreferredGatewayIdForAgent, startBackgroundReplyWait]);

  const handleAbortChat = useCallback(async () => {
    if (!selectedAgentId) return;
    try {
      const pendingId = currentPendingChatRequestIdRef.current;
      if (pendingId) {
        delete pendingChatRequestsRef.current[pendingId];
        currentPendingChatRequestIdRef.current = null;
      }
      chatSendLockRef.current = false;
      setChatSending(false);
      setPendingReplyAgentId((prev) => (prev === selectedAgentId ? null : prev));
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
  }, [selectedAgentId, customConfigPath, getOrCreateChatSessionName, getPreferredGatewayIdForAgent]);

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
    setMessagesByAgent((prev) => ({ ...prev, [selectedAgentId]: [] }));
  }, [selectedAgentId]);

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
      const items = await invoke<SelfCheckItem[]>("run_self_check", {
        customPath: normalizeConfigPath(customConfigPath) || undefined,
        installHint,
      });
      setSelfCheckItems(items || []);
      await Promise.all([
        loadSkillsCatalog(),
        refreshAllChannelHealth(),
      ]);
      await probeRuntimeModelConnection();
      setSelfCheckResult("调教中心体检完成");
    } catch (e) {
      setSelfCheckResult(`体检失败: ${e}`);
    } finally {
      setTuningActionLoading(null);
    }
  };

  const handleTuningSelfHeal = async () => {
    if (tuningActionLoading) return;
    setTuningActionLoading("heal");
    try {
      const installHint = (localInfo?.install_dir || customInstallPath || lastInstallDir || "").trim() || undefined;
      const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
      const minimal = await invoke<string>("run_minimal_repair", {
        customPath: cfgPath,
        installHint,
      });
      let resetMsg = "";
      try {
        resetMsg = await invoke<string>("reset_gateway_auth_and_restart", {
          customPath: cfgPath,
          installHint,
        });
      } catch (e) {
        resetMsg = `网关重置跳过/失败: ${e}`;
      }
      setSelfCheckResult(clampLogText(`一键修复完成\n\n[最小修复]\n${minimal}\n\n[网关修复]\n${resetMsg}`));
      await Promise.all([loadSkillsCatalog(), refreshAllChannelHealth(), refreshMemoryCenterStatus()]);
      await probeRuntimeModelConnection();
    } catch (e) {
      setSelfCheckResult(`一键修复失败: ${e}`);
    } finally {
      setTuningActionLoading(null);
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
  const chatPreviewByAgent = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(messagesByAgent).map(([agentId, list]) => {
          const last = [...(list || [])].reverse().find((item) => normalizeChatText(item.text).length > 0);
          const text = last ? normalizeChatText(last.text).slice(0, 42) : "";
          return [
            agentId,
            {
              text,
              time: last ? formatChatPreviewTime(last.timestamp) : "",
            } satisfies ChatPreviewMeta,
          ];
        })
      ) as Record<string, ChatPreviewMeta>,
    [messagesByAgent]
  );
  const lowerIssue = latestIssueText.toLowerCase();
  const suggestModelFix = lowerIssue.includes("model") || lowerIssue.includes("401") || lowerIssue.includes("api key");
  const suggestGatewayFix =
    lowerIssue.includes("token mismatch") ||
    lowerIssue.includes("gateway 启动失败") ||
    lowerIssue.includes("gateway start failed") ||
    lowerIssue.includes("端口占用") ||
    lowerIssue.includes("address already in use");
  const suggestSkillsFix = lowerIssue.includes("skills") || lowerIssue.includes("缺失依赖") || lowerIssue.includes("bins:");
  const serviceStartSummary = useMemo(() => {
    if (!startResult) return "";
    const lines = startResult
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length <= 6) return lines.join("\n");
    return ["...", ...lines.slice(-6)].join("\n");
  }, [startResult]);
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
  const handlePrimaryNavChange = useCallback(
    (target: "home" | "chat" | "tuning" | "repair") => {
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

  const heavyPanelStyle = useMemo(
    () =>
      ({
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
  const channelTabStatusMap = useMemo(() => {
    const channels: ChannelEditorChannel[] = ["telegram", "feishu", "dingtalk", "discord", "qq"];
    const next = {} as Record<
      ChannelEditorChannel,
      { label: "待补全" | "已配置" | "已连通"; dotClass: string; textClass: string; title: string }
    >;
    for (const ch of channels) {
      const hasConfigured =
        ch === "telegram"
          ? telegramInstancesDraft.some((item) => !!item.bot_token?.trim())
          : channelInstancesDraft.some((item) => item.channel === ch && hasRequiredChannelCredentials(ch, item));
      const linkedToGateway = (gatewayBindingsDraft || []).some((binding) => {
        if (binding.enabled === false) return false;
        const channelMap = parseGatewayChannelInstances(binding.channel_instances, binding.channel, binding.instance_id);
        return !!channelMap[ch];
      });
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
  }, [telegramInstancesDraft, channelInstancesDraft, gatewayBindingsDraft, parseGatewayChannelInstances, hasRequiredChannelCredentials]);
  const stickyChannelActionFeedback = agentRuntimeResult || channelResult;
  const stickyChannelActionFeedbackClass = stickyChannelActionFeedback
    ? /失败|错误|拦截|冲突/.test(stickyChannelActionFeedback)
      ? "border-rose-600/50 bg-rose-950/30 text-rose-200"
      : /请先|未选择|待补全|暂无/.test(stickyChannelActionFeedback)
        ? "border-amber-600/50 bg-amber-950/30 text-amber-200"
        : "border-emerald-600/40 bg-emerald-950/20 text-emerald-200"
    : "";
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

          <div className="mt-auto space-y-2 text-xs text-slate-500">
            <button
              onClick={() => openUrl("https://clawd.bot/docs")}
              className="w-full flex items-center justify-between rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2 hover:text-slate-300"
            >
              官方文档 <ExternalLink className="w-3 h-3" />
            </button>
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
                <p className="text-sm text-slate-400">围绕你的 API 商业模式，先选渠道，再选便宜模型，填 Key 就能用。</p>
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
                  className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-xs"
                >
                  刷新状态
                </button>
                <button
                  onClick={handleUninstall}
                  disabled={uninstalling || !localInfo?.install_dir}
                  className="px-3 py-1.5 bg-red-700 hover:bg-red-600 disabled:opacity-50 rounded text-xs"
                >
                  {uninstalling ? "卸载中..." : "一键卸载"}
                </button>
              </div>
            </div>
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
                  disabled={installing || !envReady}
                  className="flex items-center justify-center gap-2 px-6 py-4 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg font-medium"
                >
                  {installing ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      安装中...
                    </>
                  ) : (
                    <>
                      <Download className="w-5 h-5" />
                      一键安装 OpenClaw（默认目录）
                    </>
                  )}
                </button>
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
                            : "正在准备安装..."}
                        </pre>
                      </div>
                    </div>
                  </div>
                )}
                {installResult && !installing && (
                  <pre className="bg-slate-800 rounded-lg p-4 text-sm overflow-auto max-h-40">
                    {installResult}
                  </pre>
                )}
              </>
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
                  <div>
                    <p className="text-sm font-medium text-slate-100">接入密钥</p>
                    <p className="text-xs text-slate-400 mt-1">填入当前服务渠道的密钥，验证通过后即可启用。</p>
                  </div>
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
                    <p className="text-xs text-emerald-300">
                      这里就是后续商业化的核心入口：获取 Key、测试额度、备用 Key、包月代理、官方线路。
                    </p>
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

                <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-5 space-y-3" style={heavyPanelStyle}>
                  <p className="text-sm font-medium text-slate-100">获取密钥 / 商业入口</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                    <button onClick={() => openUrl("https://api.siliconflow.cn")} className="rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-left hover:border-slate-500">
                      获取硅基流动 Key
                    </button>
                    <button onClick={() => openUrl("https://platform.moonshot.cn")} className="rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-left hover:border-slate-500">
                      获取 Kimi Key
                    </button>
                    <button className="rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-left text-slate-500 cursor-not-allowed">
                      官方线路（即将上线）
                    </button>
                    <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-left text-slate-300">
                      QQ 群 / 套餐咨询：1085253453
                    </div>
                  </div>
                  <p className="text-xs text-slate-500">
                    这里后续就是你的 API 中转站和套餐转化位，不需要再做第二层复杂参数页。
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="w-full max-w-[1200px] mx-auto space-y-4 order-1">
            {startupMigrationResult && startupMigrationResult.fixed_count > 0 && (
              <div className="bg-emerald-900/20 border border-emerald-700 rounded-lg p-3 text-xs text-emerald-300 space-y-1">
                <p>
                  已自动修复插件兼容清单：{startupMigrationResult.fixed_count} 项
                </p>
                <p className="text-emerald-200">
                  修复目录：{startupMigrationResult.fixed_dirs.join(", ")}
                </p>
              </div>
            )}
            <div className="flex items-center justify-end gap-2 flex-wrap">
              <button
                onClick={handleStart}
                disabled={starting}
                className="flex items-center gap-2 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded text-xs font-medium"
              >
                {starting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    启动中...
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4" />
                    启动 Gateway
                  </>
                )}
              </button>
              <button
                onClick={() => void runStartAllEnabledGateways()}
                disabled={gatewayBatchLoading === "start"}
                className="flex items-center gap-2 px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 rounded text-xs font-medium"
              >
                {gatewayBatchLoading === "start" ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    启动中...
                  </>
                ) : (
                  <>
                    <Zap className="w-4 h-4" />
                    一键启动所有 Gateway
                  </>
                )}
              </button>
              <button
                onClick={handleOpenBrowserChat}
                className="flex items-center gap-2 px-3 py-1.5 bg-sky-700 hover:bg-sky-600 rounded text-xs font-medium"
              >
                <ExternalLink className="w-4 h-4" />
                打开浏览器对话框
              </button>
            </div>
            <ChatWorkbench
              agents={chatAgents}
              selectedAgentId={selectedAgentId}
              unreadByAgent={unreadByAgent}
              previewByAgent={chatPreviewByAgent}
              routeMode={routeMode}
              chatExecutionMode={chatExecutionMode}
              chatSessionMode={chatSessionMode}
              chatLoading={chatLoading}
              chatSending={chatSending}
              chatError={chatError}
              routeHint={routeHint}
              messages={selectedChatMessages}
              renderLimit={selectedChatRenderLimit}
              historyLoaded={selectedChatHistoryLoaded}
              cacheHydrating={chatCacheHydrating}
              chatStickBottom={selectedChatStickBottom}
              pendingReply={pendingReplyAgentId === selectedAgentId && chatSending}
              chatViewportRef={chatViewportRef}
              onRouteModeChange={setRouteMode}
              onExecutionModeChange={setChatExecutionMode}
              onSessionModeChange={setChatSessionMode}
              onSelectAgent={handleSelectAgentForChat}
              onNewSession={handleNewSessionLocal}
              onClearSession={handleNewSessionLocal}
              onAbort={handleAbortChat}
              onLoadHistory={handleLoadSelectedChatHistory}
              onSend={handleSendChat}
              onTypingActivity={handleChatTypingActivity}
              onViewportScroll={handleChatViewportScroll}
              getAgentSpecialty={getAgentSpecialty}
              gatewayOptionsByAgent={enabledGatewaysByAgent}
              preferredGatewayByAgent={preferredGatewayByAgent}
              onPreferredGatewayChange={(agentId, gatewayId) =>
                setPreferredGatewayByAgent((prev) => ({ ...prev, [agentId]: gatewayId }))
              }
            />
            <div className="rounded-xl border border-emerald-700/40 bg-emerald-950/20 p-4 text-sm text-emerald-100 space-y-2">
              <p className="font-medium text-emerald-200">权益与 QQ 群入口</p>
              <p>{DEPLOY_SUCCESS_DIALOG}</p>
              <p className="text-emerald-200/90">
                需要更多额度、备用 Key 或 29 元无限包月代理，也可以直接进群处理。
              </p>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="w-full max-w-[1200px] mx-auto space-y-6">
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
                            tab.section as "quick" | "scene" | "personal" | "memory" | "health" | "skills" | "agents" | "chat" | "control"
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
            <div className="bg-slate-800/50 rounded-lg p-4 space-y-3">
              <p className="font-medium text-slate-200 flex items-center gap-2">
                <Users className="w-4 h-4 text-sky-400" />
                {agentCenterTab === "channels" ? "渠道配置" : "Agent 管理"}
              </p>
              {agentsLoading ? (
                <p className="text-xs text-slate-400">加载中...</p>
              ) : agentsError ? (
                <p className="text-xs text-rose-400">{agentsError}</p>
              ) : agentsList ? (
                <div className="space-y-3">
                  <div className={`grid grid-cols-1 gap-3 ${agentCenterTab === "channels" ? "md:grid-cols-3" : "md:grid-cols-2"}`}>
                    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-3">
                      <p className="text-[11px] text-slate-400">当前 Agent 数量</p>
                      <p className="text-lg font-semibold text-slate-100 mt-1">{agentsList.agents.length}</p>
                    </div>
                    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-3">
                      <p className="text-[11px] text-slate-400">默认 Agent</p>
                      <p className="text-lg font-semibold text-slate-100 mt-1">
                        {agentsList.agents.find((a) => a.default)?.name || agentsList.agents.find((a) => a.default)?.id || "未设置"}
                      </p>
                    </div>
                    {agentCenterTab === "channels" && (
                      <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-3">
                        <p className="text-[11px] text-slate-400">已绑定渠道</p>
                        <p className="text-lg font-semibold text-slate-100 mt-1">{agentsList.bindings?.length || 0}</p>
                      </div>
                    )}
                  </div>
                  <div className="rounded-lg border border-slate-700 bg-slate-900/30 p-2 flex gap-2 flex-wrap">
                    <button
                      onClick={() => setAgentCenterTab("overview")}
                      className={`px-3 py-1.5 rounded text-xs ${
                        agentCenterTab === "overview" ? "bg-sky-700 text-white" : "bg-slate-700 hover:bg-slate-600 text-slate-200"
                      }`}
                    >
                      Agent 管理
                    </button>
                    <button
                      onClick={() => setAgentCenterTab("channels")}
                      className={`px-3 py-1.5 rounded text-xs ${
                        agentCenterTab === "channels" ? "bg-sky-700 text-white" : "bg-slate-700 hover:bg-slate-600 text-slate-200"
                      }`}
                    >
                      渠道配置
                    </button>
                  </div>
                  <div className={agentCenterTab === "overview" ? "space-y-3" : "hidden"}>
                  <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div>
                        <p className="text-sm text-slate-200 font-medium">极简模式</p>
                        <p className="text-[11px] text-slate-400">
                          默认只保留 Agent 列表、改名、设默认、新建、删除。模型策略和维护项都收进高级设置。
                        </p>
                      </div>
                      <button
                        onClick={() => setShowAgentAdvancedSettings((prev) => !prev)}
                        className="px-3 py-1.5 rounded border border-slate-600 text-xs text-slate-200 hover:border-slate-500 hover:bg-slate-800/70"
                      >
                        {showAgentAdvancedSettings ? "收起高级设置" : "展开高级设置"}
                      </button>
                    </div>
                  </div>
                  {agentsActionResult ? <p className="text-xs text-slate-300">{agentsActionResult}</p> : null}
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs border-collapse">
                      <thead>
                        <tr className="border-b border-slate-600">
                          <th className="text-left py-1.5 px-2">ID</th>
                          <th className="text-left py-1.5 px-2">名称</th>
                          <th className="text-left py-1.5 px-2">默认</th>
                          <th className="text-left py-1.5 px-2">Workspace</th>
                          <th className="text-left py-1.5 px-2">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {agentsList.agents.map((a) => (
                          <tr key={a.id} className="border-b border-slate-700/50">
                            <td className="py-1.5 px-2 font-mono">{a.id}</td>
                            <td className="py-1.5 px-2">
                              <input
                                value={agentNameDrafts[a.id] ?? a.name ?? ""}
                                onChange={(e) => {
                                  const next = e.target.value;
                                  setAgentNameDrafts((prev) => ({ ...prev, [a.id]: next }));
                                  if (agentsActionResult) setAgentsActionResult(null);
                                }}
                                placeholder="输入 Agent 名称"
                                className="w-full min-w-[140px] bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-100"
                              />
                            </td>
                            <td className="py-1.5 px-2">{a.default ? "✓" : ""}</td>
                            <td className="py-1.5 px-2 font-mono text-slate-400 truncate max-w-[120px]">{a.workspace || "-"}</td>
                            <td className="py-1.5 px-2 flex gap-1 flex-wrap">
                              <button
                                onClick={() => void handleRenameAgent(a.id)}
                                disabled={
                                  renamingAgentId === a.id ||
                                  !(agentNameDrafts[a.id] || "").trim() ||
                                  (agentNameDrafts[a.id] || "").trim() === (a.name || "").trim()
                                }
                                className="text-sky-400 hover:text-sky-300 disabled:text-slate-500 text-xs"
                              >
                                {renamingAgentId === a.id ? "保存中..." : "保存名称"}
                              </button>
                              {!a.default && (
                                <button
                                  onClick={async () => {
                                    try {
                                      setAgentsActionResult(null);
                                      await invoke("set_default_agent", {
                                        id: a.id,
                                        customPath: normalizeConfigPath(customConfigPath) || undefined,
                                      });
                                      await refreshAgentsList();
                                    } catch (e) {
                                      alert(String(e));
                                    }
                                  }}
                                  className="text-emerald-400 hover:text-emerald-300 text-xs"
                                >
                                  设为默认
                                </button>
                              )}
                              {a.id !== "main" && (
                                <button
                                  onClick={async () => {
                                    if (!confirm(`确定删除 Agent "${a.id}"？`)) return;
                                    try {
                                      setAgentsActionResult(null);
                                      await invoke("delete_agent", {
                                        id: a.id,
                                        force: true,
                                        customPath: normalizeConfigPath(customConfigPath) || undefined,
                                      });
                                      await refreshAgentsList();
                                    } catch (e) {
                                      alert(String(e));
                                    }
                                  }}
                                  className="text-rose-400 hover:text-rose-300 text-xs"
                                >
                                  删除
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => setShowCreateAgent(true)}
                      className="px-3 py-1.5 bg-sky-700 hover:bg-sky-600 rounded text-xs"
                    >
                      新建 Agent
                    </button>
                  </div>
                  {showAgentAdvancedSettings && (
                    <div className="space-y-3">
                      <details className="rounded-lg border border-slate-700 bg-slate-900/30 p-3">
                        <summary className="cursor-pointer text-sm font-medium text-slate-200">维护工具</summary>
                        <div className="mt-3 space-y-2">
                          <p className="text-[11px] text-slate-400">这里放维护型操作，不打扰默认使用流程。</p>
                          <div className="flex flex-wrap gap-2">
                            <button
                              onClick={refreshAgentsList}
                              className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-xs"
                            >
                              刷新 Agent 列表
                            </button>
                          </div>
                          <p className="text-[11px] text-slate-500">配置: {agentsList.config_path}</p>
                          <p className="text-[11px] text-slate-500">点击「设为默认」切换用于对话的 Agent，新对话将使用默认 Agent。</p>
                        </div>
                      </details>

                      <details className="rounded-lg border border-slate-700 bg-slate-900/40 p-3">
                        <summary className="cursor-pointer text-sm font-medium text-slate-200">模型策略</summary>
                        <div className="mt-3 space-y-3">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-sm text-slate-200 font-medium">Agent 模型分配（按 Agent 独立）</p>
                            <button
                              onClick={() => {
                                const providers = new Set<string>();
                                for (const a of agentsList.agents) {
                                  const p = agentProfileDrafts[a.id]?.provider;
                                  if (p) providers.add(p);
                                }
                                providers.forEach((p) => {
                                  void refreshModelsForProvider(p);
                                });
                              }}
                              className="px-2 py-1 bg-slate-700 hover:bg-slate-600 rounded text-[11px]"
                            >
                              刷新已选 Provider 模型列表
                            </button>
                          </div>
                          <p className="text-[11px] text-slate-400">
                            模型来源于你当前 Provider 的“刷新模型”结果；保存后将同步写入对应 Agent 的主模型。
                          </p>
                          {agentRuntimeSettings && (
                            <p className="text-[11px] text-slate-500">运行时配置文件：{agentRuntimeSettings.settings_path}</p>
                          )}
                          <div className="space-y-2">
                            {agentsList.agents.map((a) => {
                              const draft = agentProfileDrafts[a.id] || { provider: "openai", model: RECOMMENDED_MODEL_FALLBACK };
                              const models = agentModelsByProvider[draft.provider] || [];
                              const providerLoading = !!agentModelsLoadingByProvider[draft.provider];
                              return (
                                <div key={`runtime-${a.id}`} className="border border-slate-700 rounded p-2 space-y-2">
                                  <div className="text-xs text-slate-300">
                                    <span className="font-mono">{a.id}</span>
                                    <span className="text-slate-500 ml-2">{a.name || "-"}</span>
                                  </div>
                                  <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
                                    <select
                                      value={draft.provider}
                                      onChange={(e) => {
                                        const nextProvider = e.target.value;
                                        setAgentProfileDrafts((prev) => ({
                                          ...prev,
                                          [a.id]: {
                                            provider: nextProvider,
                                            model: prev[a.id]?.model || RECOMMENDED_MODEL_FALLBACK,
                                          },
                                        }));
                                      }}
                                      className="bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-xs"
                                    >
                                      {AGENT_PROVIDER_OPTIONS.map((p) => (
                                        <option key={p} value={p}>
                                          {p}
                                        </option>
                                      ))}
                                    </select>
                                    <select
                                      value={draft.model}
                                      onChange={(e) =>
                                        setAgentProfileDrafts((prev) => ({
                                          ...prev,
                                          [a.id]: { ...(prev[a.id] || { provider: draft.provider, model: "" }), model: e.target.value },
                                        }))
                                      }
                                      className="bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-xs md:col-span-2"
                                    >
                                      {models.length === 0 ? (
                                        <option value={draft.model}>{draft.model || "请先刷新模型列表"}</option>
                                      ) : (
                                        <>
                                          {!models.includes(draft.model) && <option value={draft.model}>{draft.model}</option>}
                                          {models.map((m) => (
                                            <option key={m} value={m}>
                                              {m}
                                            </option>
                                          ))}
                                        </>
                                      )}
                                    </select>
                                    <div className="flex gap-2">
                                      <button
                                        onClick={() => void refreshModelsForProvider(draft.provider)}
                                        className="px-2 py-1 bg-slate-700 hover:bg-slate-600 rounded text-[11px]"
                                        disabled={providerLoading}
                                      >
                                        {providerLoading ? "刷新中..." : "刷新模型"}
                                      </button>
                                      <button
                                        onClick={() => void saveAgentProfile(a.id)}
                                        className="px-2 py-1 bg-emerald-700 hover:bg-emerald-600 rounded text-[11px]"
                                        disabled={agentRuntimeSaving}
                                      >
                                        保存
                                      </button>
                                    </div>
                                  </div>
                                  <input
                                    value={draft.model}
                                    onChange={(e) =>
                                      setAgentProfileDrafts((prev) => ({
                                        ...prev,
                                        [a.id]: { ...(prev[a.id] || { provider: draft.provider, model: "" }), model: e.target.value },
                                      }))
                                    }
                                    placeholder="也可手动输入模型ID"
                                    className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs"
                                  />
                                </div>
                              );
                            })}
                          </div>
                          {agentRuntimeResult && (
                            <div
                              className={`rounded-lg p-3 text-xs whitespace-pre-wrap ${
                                agentRuntimeResult.includes("向导完成") || agentRuntimeResult.includes("配置完成")
                                  ? "bg-emerald-900/40 border border-emerald-600/50 text-emerald-200"
                                  : "text-emerald-300"
                              }`}
                            >
                              {(agentRuntimeResult.includes("向导完成") || agentRuntimeResult.includes("配置完成")) && (
                                <p className="font-medium text-emerald-100 mb-1">✓ 配置完成</p>
                              )}
                              {agentRuntimeResult}
                            </div>
                          )}
                        </div>
                      </details>
                    </div>
                  )}
                  </div>

                  <div className={agentCenterTab === "channels" ? "space-y-3" : "hidden"}>
                  <div className="rounded-lg border border-slate-700 bg-slate-900/30 p-3">
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <div>
                        <p className="text-sm text-slate-200 font-medium">渠道绑定摘要</p>
                        <p className="text-[11px] text-slate-400 mt-1">这里的统计严格跟随下方 Agent 网关控制台，不再和 Agent 管理混放。</p>
                      </div>
                      <div className="rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-right">
                        <p className="text-[11px] text-slate-400">已绑定渠道</p>
                        <p className="text-lg font-semibold text-slate-100 mt-1">{agentsList.bindings?.length || 0}</p>
                      </div>
                    </div>
                  </div>
                  <div className="bg-indigo-950/30 border border-indigo-700/50 rounded-lg p-4 space-y-3">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <p className="text-sm text-indigo-200 font-medium flex items-center gap-2">
                        <Sparkles className="w-4 h-4 text-indigo-400" />
                        新手引导：四步完成渠道配置
                      </p>
                      <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer hover:text-slate-300">
                        <input
                          type="checkbox"
                          checked={!simpleModeForAgent}
                          onChange={(e) => setSimpleModeForAgent(!e.target.checked)}
                        />
                        显示高级选项
                      </label>
                    </div>
                    {/* 可视化步骤条：实例池 → 网关 → 路由 → 测试 */}
                    {(() => {
                      const steps = [
                        {
                          step: 1,
                          label: "实例池",
                          done:
                            channelInstancesEditorChannel === "telegram"
                              ? telegramInstancesDraft.some((x) => x.bot_token?.trim())
                              : channelInstancesDraft.some((x) => x.channel === channelInstancesEditorChannel && x.credential1?.trim()),
                        },
                        { step: 2, label: "应用网关", done: (gatewayBindingsDraft?.length ?? 0) > 0 },
                        { step: 3, label: "路由", done: channelRoutesDraft.some((r) => r.enabled) },
                        {
                          step: 4,
                          label: "测试命中",
                          done: !!(routeTestResult && routeTestResult.includes("命中 Agent")),
                        },
                      ];
                      const currentStep = steps.findIndex((s) => !s.done) + 1 || 4;
                      return (
                        <div className="flex items-center gap-0">
                          {steps.map((s, i) => {
                            const isCurrent = s.step === currentStep;
                            const isDone = s.done;
                            return (
                              <div key={s.step} className="flex items-center">
                                <div
                                  className={`flex flex-col items-center cursor-default ${
                                    isDone ? "text-emerald-400" : isCurrent ? "text-indigo-300" : "text-slate-500"
                                  }`}
                                  title={isDone ? `已完成：${s.label}` : isCurrent ? `当前：${s.label}` : `待完成：${s.label}`}
                                >
                                  <span
                                    className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold border-2 ${
                                      isDone
                                        ? "bg-emerald-900/50 border-emerald-500 text-emerald-300"
                                        : isCurrent
                                          ? "bg-indigo-700/80 border-indigo-400 text-indigo-100 ring-2 ring-indigo-400/50"
                                          : "bg-slate-800/50 border-slate-600 text-slate-400"
                                    }`}
                                  >
                                    {isDone ? "✓" : s.step}
                                  </span>
                                  <span className="text-[10px] mt-1">{s.label}</span>
                                </div>
                                {i < 3 && (
                                  <div
                                    className={`w-8 h-0.5 mx-0.5 ${isDone ? "bg-emerald-600/50" : "bg-slate-600"}`}
                                    aria-hidden
                                  />
                                )}
                              </div>
                            );
                          })}
                        </div>
                      );
                    })()}
                    <div className="rounded-md bg-indigo-900/30 border border-indigo-600/40 p-2.5 space-y-2">
                      <p className="text-xs text-indigo-200 font-medium">快速开始（推荐）</p>
                      <p className="text-[11px] text-indigo-100/90 leading-relaxed">
                        ① 点「按 Agent 自动生成」→ ② 为每个 Agent 填 Token → ③ 点「首次配置向导」一键完成保存、应用、路由与测试。
                      </p>
                      <p className="text-[10px] text-indigo-200/70">
                        概念：<strong>实例池</strong>存 Token；<strong>网关</strong>把实例接到 Agent；<strong>路由</strong>决定消息走哪个 Agent。
                      </p>
                      <div className="flex gap-2 flex-wrap">
                        <button
                          onClick={() => void (channelInstancesEditorChannel === "telegram" ? runTelegramFirstSetupWizard() : runChannelFirstSetupWizard(channelInstancesEditorChannel as NonTelegramChannel))}
                          disabled={
                            (channelInstancesEditorChannel === "telegram" ? telegramWizardRunning : !!channelWizardRunningByChannel[channelInstancesEditorChannel]) ||
                            !agentsList?.agents?.length
                          }
                          className="px-2 py-1 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded text-[11px] font-medium"
                        >
                          首次使用？点这里一键向导
                        </button>
                        {setupWizardStepMode ? (
                          <button
                            onClick={() => setSetupWizardStepMode(false)}
                            className="px-2 py-1 bg-slate-600 hover:bg-slate-500 rounded text-[11px]"
                          >
                            收起分步向导
                          </button>
                        ) : (
                          <button
                            onClick={() => {
                              setSetupWizardStepMode(true);
                              setSetupWizardCurrentStep(1);
                            }}
                            className="px-2 py-1 bg-slate-600/80 hover:bg-slate-500 rounded text-[11px]"
                          >
                            分步向导（每步有说明）
                          </button>
                        )}
                      </div>
                    </div>

                    {/* 分步向导：每步有说明和下一步 */}
                    {setupWizardStepMode && (
                      <div className="rounded-lg border border-indigo-600/60 bg-indigo-950/40 p-4 space-y-3">
                        <p className="text-sm font-medium text-indigo-200">分步向导 · 第 {setupWizardCurrentStep} 步</p>
                        {setupWizardCurrentStep === 1 && (
                          <>
                            <p className="text-xs text-indigo-100/90">
                              <strong>步骤 1：实例池</strong> — 为每个 Agent 配置渠道凭据（如 Telegram Token）。点「按 Agent 自动生成」后填写 Token，再点「保存实例池」。
                            </p>
                            <button
                              onClick={() => setSetupWizardCurrentStep(2)}
                              className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 rounded text-xs"
                            >
                              下一步：应用网关 →
                            </button>
                          </>
                        )}
                        {setupWizardCurrentStep === 2 && (
                          <>
                            <p className="text-xs text-indigo-100/90">
                              <strong>步骤 2：应用网关</strong> — 将实例池中的激活实例应用到网关。点「应用到网关」后，点「按 Agent 自动生成网关」生成网关绑定。
                            </p>
                            <button
                              onClick={() => setSetupWizardCurrentStep(3)}
                              className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 rounded text-xs"
                            >
                              下一步：保存路由 →
                            </button>
                          </>
                        )}
                        {setupWizardCurrentStep === 3 && (
                          <>
                            <p className="text-xs text-indigo-100/90">
                              <strong>步骤 3：路由</strong> — 保存渠道路由，让消息能正确命中对应 Agent。首次配置向导会自动完成；或手动点「保存路由」。
                            </p>
                            <button
                              onClick={() => setSetupWizardCurrentStep(4)}
                              className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 rounded text-xs"
                            >
                              下一步：测试命中 →
                            </button>
                          </>
                        )}
                        {setupWizardCurrentStep === 4 && (
                          <>
                            <p className="text-xs text-indigo-100/90">
                              <strong>步骤 4：测试命中</strong> — 验证配置是否正确。在下方「渠道调阅路由」区域选择实例后点「测试命中」，或直接点「首次配置向导」一键跑完并测试。
                            </p>
                            <div className="flex gap-2">
                              <button
                                onClick={() => {
                                  void (channelInstancesEditorChannel === "telegram"
                                    ? runTelegramFirstSetupWizard()
                                    : runChannelFirstSetupWizard(channelInstancesEditorChannel as NonTelegramChannel));
                                  setSetupWizardStepMode(false);
                                }}
                                disabled={
                                  (channelInstancesEditorChannel === "telegram" ? telegramWizardRunning : !!channelWizardRunningByChannel[channelInstancesEditorChannel]) ||
                                  !agentsList?.agents?.length
                                }
                                className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded text-xs"
                              >
                                一键完成全部
                              </button>
                              <button
                                onClick={() => setSetupWizardStepMode(false)}
                                className="px-3 py-1.5 bg-slate-600 hover:bg-slate-500 rounded text-xs"
                              >
                                配置完成，收起向导
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="bg-slate-900/40 border border-slate-700 rounded-lg overflow-hidden flex flex-col md:flex-row min-h-[320px]">
                    <div className="w-full md:w-36 shrink-0 flex md:flex-col gap-1 p-2 border-b md:border-b-0 md:border-r border-slate-700 bg-slate-800/50">
                      <p className="text-xs text-slate-400 px-2 py-1 md:mb-1 hidden md:block">渠道</p>
                      {(["telegram", "feishu", "dingtalk", "discord", "qq"] as ChannelEditorChannel[]).map((ch) => {
                        const label = { telegram: "Telegram", feishu: "飞书", dingtalk: "钉钉", discord: "Discord", qq: "QQ" }[ch];
                        const statusMeta = channelTabStatusMap[ch];
                        return (
                          <button
                            key={ch}
                            onClick={() => setChannelInstancesEditorChannel(ch)}
                            title={statusMeta.title}
                            className={`text-left px-2 py-2 rounded text-xs font-medium transition-colors ${
                              channelInstancesEditorChannel === ch
                                ? "bg-indigo-700 text-indigo-100"
                                : "bg-slate-700/60 hover:bg-slate-600 text-slate-300"
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span>{label}</span>
                              <span className={`inline-flex h-2 w-2 rounded-full ${statusMeta.dotClass}`} aria-hidden />
                            </div>
                            <div className={`mt-1 text-[10px] ${channelInstancesEditorChannel === ch ? "text-indigo-100/80" : statusMeta.textClass}`}>
                              {statusMeta.label}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                    <div className="flex-1 min-w-0 p-3 space-y-3 overflow-auto">
                    {agentsList?.agents?.length &&
                      ((channelInstancesEditorChannel === "telegram" && !telegramInstancesDraft.some((x) => x.bot_token?.trim())) ||
                        (channelInstancesEditorChannel !== "telegram" &&
                          !channelInstancesDraft.some((x) => x.channel === channelInstancesEditorChannel && x.credential1?.trim()))) && (
                      <div className="rounded border border-amber-600/60 bg-amber-900/20 px-3 py-2 text-xs text-amber-200">
                        <span className="font-medium">首次使用？</span> 先点「按 Agent 自动生成」生成配置项，填写 Token 后点「首次配置向导」一键完成。
                      </div>
                    )}
                    {(["telegram", "feishu", "qq"] as ChannelEditorChannel[]).includes(channelInstancesEditorChannel) && (() => {
                      const pairingChannel = channelInstancesEditorChannel as PairingChannel;
                      const pairingLabelMap: Record<PairingChannel, string> = {
                        telegram: "Telegram",
                        feishu: "飞书",
                        qq: "QQ",
                      };
                      const pairingPlaceholderMap: Record<PairingChannel, string> = {
                        telegram: "粘贴 Telegram 返回的配对码",
                        feishu: "粘贴飞书返回的配对码",
                        qq: "粘贴 QQ 返回的配对码",
                      };
                      return (
                        <div className="rounded-lg border border-slate-700 bg-slate-950/30 p-3 space-y-3">
                          <div className="flex items-start justify-between gap-2 flex-wrap">
                            <div>
                              <p className="text-sm text-slate-200 font-medium">首次配对审批</p>
                              <p className="text-[11px] text-amber-200/90">
                                {pairingLabelMap[pairingChannel]} 首次私聊时如果返回配对码，直接在这里审批，后面就能正常对话。
                              </p>
                            </div>
                            <button
                              onClick={() => void handleListPairings(pairingChannel)}
                              disabled={pairingLoading === pairingChannel}
                              className="px-2 py-1 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded text-[11px]"
                            >
                              {pairingLoading === pairingChannel ? "查询中..." : "查询待审批"}
                            </button>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <input
                              type="text"
                              placeholder={pairingPlaceholderMap[pairingChannel]}
                              value={pairingCodeByChannel[pairingChannel]}
                              onChange={(e) =>
                                setPairingCodeByChannel((prev) => ({
                                  ...prev,
                                  [pairingChannel]: e.target.value,
                                }))
                              }
                              className="flex-1 min-w-[220px] bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm"
                            />
                            <button
                              onClick={() => handleApprovePairing(pairingChannel)}
                              disabled={pairingLoading === pairingChannel || !pairingCodeByChannel[pairingChannel].trim()}
                              className="px-3 py-2 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 rounded-lg text-xs"
                            >
                              批准配对码
                            </button>
                          </div>
                          {pairingRequestsByChannel[pairingChannel].length > 0 && (
                            <div className="space-y-2">
                              {pairingRequestsByChannel[pairingChannel].map((req, index) => {
                                const code = typeof req.code === "string" ? req.code : "";
                                const title =
                                  (typeof req.displayName === "string" && req.displayName) ||
                                  (typeof req.senderLabel === "string" && req.senderLabel) ||
                                  (typeof req.senderId === "string" && req.senderId) ||
                                  (typeof req.from === "string" && req.from) ||
                                  `请求 ${index + 1}`;
                                const metaText = Object.entries(req)
                                  .filter(([key, value]) => key !== "code" && typeof value === "string" && value)
                                  .slice(0, 3)
                                  .map(([key, value]) => `${key}: ${value}`)
                                  .join(" · ");
                                return (
                                  <div key={`${pairingChannel}-${code || index}`} className="flex flex-wrap items-center gap-2 rounded border border-slate-700 bg-slate-900/60 px-3 py-2">
                                    <div className="min-w-[160px] flex-1">
                                      <div className="text-xs text-slate-200">{title}</div>
                                      <div className="text-[11px] text-slate-500">{metaText || "等待批准首次访问"}</div>
                                    </div>
                                    <code className="rounded bg-slate-950 px-2 py-1 text-xs text-emerald-300">{code || "无 code"}</code>
                                    {code && (
                                      <button
                                        onClick={() => handleApprovePairing(pairingChannel, code)}
                                        disabled={pairingLoading === pairingChannel}
                                        className="px-2 py-1 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 rounded text-xs"
                                      >
                                        直接批准
                                      </button>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                          {channelResult && (
                            <pre className="text-xs text-sky-300 whitespace-pre-wrap bg-slate-900/40 rounded p-2">{channelResult}</pre>
                          )}
                        </div>
                      );
                    })()}
                    {channelInstancesEditorChannel !== "telegram" && (
                    <>
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <p className="text-sm text-slate-200 font-medium">{channelInstancesEditorChannel} 实例池</p>
                      <div className="flex gap-2 items-center flex-wrap">
                        <button
                          onClick={() => buildChannelPerAgentDraft(channelInstancesEditorChannel)}
                          className="px-2 py-1 bg-emerald-700 hover:bg-emerald-600 rounded text-[11px]"
                          title="① 先点这里：生成每个 Agent 的配置项"
                        >
                          按 Agent 自动生成 <span className="text-emerald-200/80 text-[10px]">① 先点</span>
                        </button>
                        {showAgentAdvancedSettings && (
                          <>
                            <button
                              onClick={() => void runChannelFirstSetupWizard(channelInstancesEditorChannel)}
                              disabled={!!channelWizardRunningByChannel[channelInstancesEditorChannel]}
                              className="px-2 py-1 bg-indigo-700 hover:bg-indigo-600 disabled:opacity-50 rounded text-[11px]"
                              title="③ 填完 Token 后点这里：一键完成保存、应用、路由与测试"
                            >
                              {channelWizardRunningByChannel[channelInstancesEditorChannel] ? "向导执行中..." : "首次配置向导"}
                              <span className="text-indigo-200/80 text-[10px] ml-0.5">③ 填完点</span>
                            </button>
                            <button
                              onClick={() => void testChannelInstancesBatch(channelInstancesEditorChannel)}
                              disabled={!!channelBatchTestingByChannel[channelInstancesEditorChannel]}
                              className="px-2 py-1 bg-amber-700 hover:bg-amber-600 disabled:opacity-50 rounded text-[11px]"
                            >
                              {channelBatchTestingByChannel[channelInstancesEditorChannel] ? "检测中..." : "批量检测"}
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    <p className="text-[11px] text-slate-400">
                      当前渠道：{channelInstancesEditorChannel}。可点“首次配置向导”一键跑完：实例池到应用网关，再到路由与命中测试。
                    </p>
                    {channelInstancesEditorChannel === "qq" && (
                      <div className="rounded-lg border border-cyan-700/50 bg-cyan-950/20 p-3 space-y-2">
                        <p className="text-sm text-cyan-200 font-medium">QQ 新接入方式</p>
                        <p className="text-[11px] text-cyan-100/90 leading-relaxed">
                          这里直接填写 <strong>AppID</strong> 和 <strong>AppSecret</strong>。
                          后台会自动拼成 OpenClaw 需要的 <code>AppID:AppSecret</code> token，并写入当前 Agent 的 QQ 渠道配置。
                        </p>
                        <p className="text-[10px] text-cyan-200/75">
                          不需要你自己手动拼命令，也不需要手动执行 `channels add`。
                        </p>
                      </div>
                    )}
                    {!!agentsList.agents.length && (
                      <div className="border border-slate-700 rounded p-2 space-y-2">
                        <p className="text-xs text-slate-300">按 Agent 配置 {channelInstancesEditorChannel} 凭据（简化）</p>
                        {agentsList.agents.map((a) => {
                          const ch = channelInstancesEditorChannel;
                          const iid = `${ch}-${a.id}`;
                          const item =
                            channelInstancesDraft.find((x) => x.channel === ch && x.id === iid) ||
                            ({
                              id: iid,
                              name: a.name || a.id,
                              channel: ch,
                              credential1: "",
                              credential2: "",
                              chat_id: "",
                              enabled: true,
                            } as ChannelBotInstance);
                          const singleKey = `${ch}:${iid}`;
                          const singleTesting = !!channelSingleTestingByInstanceId[singleKey];
                          return (
                            <div key={`agent-${ch}-${a.id}`} className="space-y-1">
                              <div className="grid grid-cols-1 md:grid-cols-6 gap-2">
                                <div className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-300">
                                  {a.id}
                                </div>
                                <input
                                  type="password"
                                  value={item.credential1}
                                  onChange={(e) =>
                                    setChannelInstancesDraft((prev) => {
                                      const next = [...prev];
                                      const idx = next.findIndex((x) => x.channel === ch && x.id === iid);
                                      const row: ChannelBotInstance = {
                                        id: iid,
                                        name: a.name || a.id,
                                        channel: ch,
                                        credential1: e.target.value,
                                        credential2: item.credential2 || "",
                                        chat_id: item.chat_id || "",
                                        enabled: item.enabled,
                                      };
                                      if (idx >= 0) next[idx] = row;
                                      else next.push(row);
                                      return next;
                                    })
                                  }
                                  placeholder={
                                    ch === "qq"
                                      ? `${a.id} 的 AppID`
                                      : `${a.id} 的 ${channelEditorCredential1Label}`
                                  }
                                  className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs"
                                />
                                {channelEditorCredential2Label ? (
                                  <input
                                    type="password"
                                    value={item.credential2 || ""}
                                    onChange={(e) =>
                                      setChannelInstancesDraft((prev) => {
                                        const next = [...prev];
                                        const idx = next.findIndex((x) => x.channel === ch && x.id === iid);
                                        const row: ChannelBotInstance = {
                                          id: iid,
                                          name: a.name || a.id,
                                          channel: ch,
                                          credential1: item.credential1 || "",
                                          credential2: e.target.value,
                                          chat_id: item.chat_id || "",
                                          enabled: item.enabled,
                                        };
                                        if (idx >= 0) next[idx] = row;
                                        else next.push(row);
                                        return next;
                                      })
                                    }
                                    placeholder={
                                      ch === "qq"
                                        ? "AppSecret（后台会自动拼成 AppID:AppSecret）"
                                        : `${channelEditorCredential2Label}(可选)`
                                    }
                                    className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs"
                                  />
                                ) : (
                                  <div className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-500 flex items-center">
                                    无第二凭据
                                  </div>
                                )}
                                <input
                                  value={item.chat_id || ""}
                                  onChange={(e) =>
                                    setChannelInstancesDraft((prev) => {
                                      const next = [...prev];
                                      const idx = next.findIndex((x) => x.channel === ch && x.id === iid);
                                      const row: ChannelBotInstance = {
                                        id: iid,
                                        name: a.name || a.id,
                                        channel: ch,
                                        credential1: item.credential1 || "",
                                        credential2: item.credential2 || "",
                                        chat_id: e.target.value,
                                        enabled: item.enabled,
                                      };
                                      if (idx >= 0) next[idx] = row;
                                      else next.push(row);
                                      return next;
                                    })
                                  }
                                  placeholder="chatId(可选)"
                                  className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs"
                                />
                                <label className="flex items-center gap-1 text-xs text-slate-300">
                                  <input
                                    type="checkbox"
                                    checked={item.enabled}
                                    onChange={(e) =>
                                      setChannelInstancesDraft((prev) => {
                                        const next = [...prev];
                                        const idx = next.findIndex((x) => x.channel === ch && x.id === iid);
                                        const row: ChannelBotInstance = {
                                          id: iid,
                                          name: a.name || a.id,
                                          channel: ch,
                                          credential1: item.credential1 || "",
                                          credential2: item.credential2 || "",
                                          chat_id: item.chat_id || "",
                                          enabled: e.target.checked,
                                        };
                                        if (idx >= 0) next[idx] = row;
                                        else next.push(row);
                                        return next;
                                      })
                                    }
                                  />
                                  启用
                                </label>
                                <button
                                  onClick={() => void testSingleChannelInstance(ch, iid)}
                                  disabled={singleTesting || !hasRequiredChannelCredentials(ch, item)}
                                  className="px-2 py-1 bg-sky-700 hover:bg-sky-600 disabled:opacity-50 rounded text-[11px]"
                                  title={ch === "qq" ? "检测 AppID / AppSecret 配置是否完整，失败时会给出修复建议" : "检测凭据连通性，失败时会给出修复建议"}
                                >
                                  {singleTesting ? "检测中..." : "检测本行"}
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2 items-center">
                      <label className="text-xs text-slate-300">当前激活实例</label>
                      <select
                        value={activeChannelInstanceByChannel[channelInstancesEditorChannel] || ""}
                        onChange={(e) =>
                          setActiveChannelInstanceByChannel((prev) => ({
                            ...prev,
                            [channelInstancesEditorChannel]: e.target.value,
                          }))
                        }
                        className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs"
                      >
                        <option value="">(未选择)</option>
                        {channelInstancesDraft
                          .filter((it) => it.channel === channelInstancesEditorChannel)
                          .map((it) => (
                            <option key={it.id} value={it.id}>
                              {it.id} {it.name ? `· ${it.name}` : ""}
                            </option>
                          ))}
                      </select>
                      <p className="text-[11px] text-slate-500">保存并应用、测试连通、启动网关已统一放到底部固定操作条。</p>
                    </div>
                    </>
                  )}

                  {channelInstancesEditorChannel === "telegram" && (
                    <>
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <p className="text-sm text-slate-200 font-medium">telegram 实例池</p>
                      <div className="flex gap-2 flex-wrap">
                        <button
                          onClick={buildTelegramPerAgentDraft}
                          className="px-2 py-1 bg-emerald-700 hover:bg-emerald-600 rounded text-[11px]"
                          title="① 先点这里：生成每个 Agent 的配置项"
                        >
                          按 Agent 自动生成 <span className="text-emerald-200/80 text-[10px]">① 先点</span>
                        </button>
                        {showAgentAdvancedSettings && (
                          <>
                            <button
                              onClick={() => void runTelegramFirstSetupWizard()}
                              disabled={telegramWizardRunning}
                              className="px-2 py-1 bg-indigo-700 hover:bg-indigo-600 disabled:opacity-50 rounded text-[11px]"
                              title="③ 填完 Token 后点这里：一键完成保存、应用、路由与测试"
                            >
                              {telegramWizardRunning ? "向导执行中..." : "首次配置向导"}
                              <span className="text-indigo-200/80 text-[10px] ml-0.5">③ 填完点</span>
                            </button>
                            <button
                              onClick={() => void testTelegramInstancesBatch()}
                              disabled={telegramBatchTesting}
                              className="px-2 py-1 bg-amber-700 hover:bg-amber-600 disabled:opacity-50 rounded text-[11px]"
                            >
                              {telegramBatchTesting ? "批量检测中..." : "批量 getMe 检查"}
                            </button>
                            <button
                              onClick={() => void cleanupBrowserSessionsForTelegramBindings()}
                              disabled={telegramSessionCleanupRunning}
                              className="px-2 py-1 bg-fuchsia-700 hover:bg-fuchsia-600 disabled:opacity-50 rounded text-[11px]"
                              title="仅保留当前 Telegram 路由绑定到 Agent 的会话（会重写 sessions.json）"
                            >
                              {telegramSessionCleanupRunning ? "清理中..." : "清理浏览器会话"}
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    <p className="text-[11px] text-slate-400">
                      可先点“按 Agent 自动生成”，界面会出现所有 Agent，你只需为每个 Agent 填 Token；点“首次配置向导”可一键完成保存、应用、路由和测试。
                    </p>
                    {!!agentsList.agents.length && (
                      <div className="border border-slate-700 rounded p-2 space-y-2">
                        <p className="text-xs text-slate-300">按 Agent 配置 Token（简化）</p>
                        {agentsList.agents.map((a) => {
                          const iid = `tg-${a.id}`;
                          const item =
                            telegramInstancesDraft.find((x) => x.id === iid) ||
                            ({ id: iid, name: a.name || a.id, bot_token: "", chat_id: "", enabled: true } as TelegramBotInstance);
                          const actualUsername = telegramUsernameByInstanceId[iid];
                          const singleTesting = !!telegramSingleTestingByInstanceId[iid];
                          return (
                            <div key={`agent-tg-${a.id}`} className="space-y-1">
                              <div className="grid grid-cols-1 md:grid-cols-6 gap-2">
                                <div className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-300">
                                  {a.id}
                                </div>
                                <input
                                  type="password"
                                  value={item.bot_token}
                                  onChange={(e) =>
                                    setTelegramInstancesDraft((prev) => {
                                      const next = [...prev];
                                      const idx = next.findIndex((x) => x.id === iid);
                                      const row = {
                                        id: iid,
                                        name: a.name || a.id,
                                        bot_token: e.target.value,
                                        chat_id: item.chat_id || "",
                                        enabled: item.enabled,
                                      };
                                      if (idx >= 0) next[idx] = row;
                                      else next.push(row);
                                      return next;
                                    })
                                  }
                                  placeholder={`${a.id} 的 Bot Token`}
                                  className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs md:col-span-3"
                                />
                                <input
                                  value={item.chat_id || ""}
                                  onChange={(e) =>
                                    setTelegramInstancesDraft((prev) => {
                                      const next = [...prev];
                                      const idx = next.findIndex((x) => x.id === iid);
                                      const row = {
                                        id: iid,
                                        name: a.name || a.id,
                                        bot_token: item.bot_token,
                                        chat_id: e.target.value,
                                        enabled: item.enabled,
                                      };
                                      if (idx >= 0) next[idx] = row;
                                      else next.push(row);
                                      return next;
                                    })
                                  }
                                  placeholder="chatId(可选)"
                                  className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs"
                                />
                                <label className="flex items-center gap-1 text-xs text-slate-300">
                                  <input
                                    type="checkbox"
                                    checked={item.enabled}
                                    onChange={(e) =>
                                      setTelegramInstancesDraft((prev) => {
                                        const next = [...prev];
                                        const idx = next.findIndex((x) => x.id === iid);
                                        const row = {
                                          id: iid,
                                          name: a.name || a.id,
                                          bot_token: item.bot_token,
                                          chat_id: item.chat_id || "",
                                          enabled: e.target.checked,
                                        };
                                        if (idx >= 0) next[idx] = row;
                                        else next.push(row);
                                        return next;
                                      })
                                    }
                                  />
                                  启用
                                </label>
                              </div>
                              <div className="flex items-center justify-between gap-2">
                                <p className="text-[11px] text-slate-400">
                                  token 实际对应的 bot username：{actualUsername ? `@${actualUsername}` : "未识别（可点本行检测）"}
                                </p>
                                <button
                                  onClick={() => void testSingleTelegramInstance(iid)}
                                  disabled={singleTesting || !item.bot_token?.trim()}
                                  className="px-2 py-1 bg-sky-700 hover:bg-sky-600 disabled:opacity-50 rounded text-[11px]"
                                  title="检测 Token 连通性，失败时会给出修复建议"
                                >
                                  {singleTesting ? "检测中..." : "检测用户名"}
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2 items-center">
                      <label className="text-xs text-slate-300">当前激活实例</label>
                      <select
                        value={activeTelegramInstanceId}
                        onChange={(e) => setActiveTelegramInstanceId(e.target.value)}
                        className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs"
                      >
                        <option value="">(未选择)</option>
                        {telegramInstancesDraft.map((it) => (
                          <option key={it.id} value={it.id}>
                            {it.id} {it.name ? `· ${it.name}` : ""}
                            {telegramUsernameByInstanceId[it.id] ? ` · @${telegramUsernameByInstanceId[it.id]}` : ""}
                          </option>
                        ))}
                      </select>
                      <p className="text-[11px] text-slate-500">保存并应用、测试连通、启动网关已统一放到底部固定操作条。</p>
                    </div>
                    </>
                  )}
                    </div>
                  </div>

                  <div className="bg-slate-900/40 border border-slate-700 rounded-lg p-3 space-y-3">
                    <div className="flex items-start justify-between gap-2 flex-wrap">
                      <div>
                        <p className="text-sm text-slate-200 font-medium">Agent 网关控制台（每个 Agent 一个）</p>
                        <p className="text-[11px] text-slate-400 mt-0.5">
                          {simpleModeForAgent
                            ? "系统会自动把同一 Agent 的 Telegram / QQ / 飞书等渠道合并到同一个网关里。这里展示的已接入渠道，就是最终绑定结果。"
                            : "高级模式下仍可检查网关字段，但运行时会自动收敛为每个 Agent 一个网关。这里展示的已接入渠道，就是最终绑定结果。"}
                        </p>
                      </div>
                      {(gatewayBindingsDraft?.length ?? 0) === 0 && (
                        <div className="rounded border border-amber-600/60 bg-amber-900/20 px-2 py-1.5 text-[11px] text-amber-200">
                          提示：先点「按 Agent 自动生成网关」或完成上方实例池配置
                        </div>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => void refreshGatewayInstances()}
                        className="px-3 py-1.5 bg-indigo-700 hover:bg-indigo-600 rounded text-xs"
                      >
                        刷新网关状态
                      </button>
                      <button
                        onClick={() => setShowGatewayAdvancedActions((prev) => !prev)}
                        className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-xs"
                      >
                        {showGatewayAdvancedActions ? "收起网关高级操作" : "展开网关高级操作"}
                      </button>
                      {showGatewayAdvancedActions && (
                        <>
                          {!simpleModeForAgent && (
                            <button
                              onClick={() =>
                                setGatewayBindingsDraft((prev) => [
                                  ...prev,
                                  (() => {
                                    const aid = agentsList.agents[0]?.id || "main";
                                    const channelMap = buildChannelInstanceMapForAgent(aid);
                                    const fallbackChannel = channelInstancesEditorChannel;
                                    const fallbackInstance =
                                      channelMap[fallbackChannel] ||
                                      channelMap.telegram ||
                                      Object.values(channelMap)[0] ||
                                      "";
                                    return {
                                      gateway_id: `gw-${fallbackChannel}-${Date.now().toString(36)}`,
                                      agent_id: aid,
                                      channel: fallbackChannel,
                                      instance_id: fallbackInstance,
                                      channel_instances: channelMap,
                                      enabled: true,
                                      auto_restart: true,
                                    } as GatewayBinding;
                                  })(),
                                ])
                              }
                              className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-xs"
                            >
                              新增网关绑定
                            </button>
                          )}
                          <button
                            onClick={() => void saveGatewayBindings()}
                            disabled={agentRuntimeSaving}
                            className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 rounded text-xs"
                          >
                            保存 Agent 网关
                          </button>
                          <button
                            onClick={generateGatewayBindingsByAgent}
                            className="px-3 py-1.5 bg-violet-700 hover:bg-violet-600 rounded text-xs"
                            title="为每个 Agent 自动生成一个网关，并绑定当前激活的多渠道实例"
                          >
                            按 Agent 自动生成网关
                          </button>
                          <button
                            onClick={() => void runStartAllEnabledGateways()}
                            disabled={gatewayBatchLoading === "start"}
                            className="px-3 py-1.5 bg-emerald-800 hover:bg-emerald-700 disabled:opacity-50 rounded text-xs"
                          >
                            {gatewayBatchLoading === "start" ? "批量启动中..." : "批量启动全部启用网关"}
                          </button>
                          <button
                            onClick={() => void runHealthAllEnabledGateways()}
                            disabled={gatewayBatchLoading === "health"}
                            className="px-3 py-1.5 bg-amber-700 hover:bg-amber-600 disabled:opacity-50 rounded text-xs"
                          >
                            {gatewayBatchLoading === "health" ? "批量检查中..." : "批量健康检查"}
                          </button>
                          <button
                            onClick={() => void exportGatewayDiagnosticReport()}
                            disabled={gatewayBatchLoading === "report"}
                            className="px-3 py-1.5 bg-sky-700 hover:bg-sky-600 disabled:opacity-50 rounded text-xs"
                          >
                            {gatewayBatchLoading === "report" ? "导出中..." : "导出多网关诊断报告"}
                          </button>
                        </>
                      )}
                    </div>
                    <div className="space-y-2" style={heavyPanelStyle}>
                      {(gatewayBindingsDraft || []).length === 0 ? (
                        <p className="text-xs text-slate-500">暂无网关绑定。保存并应用任一渠道实例后会自动生成。</p>
                      ) : (
                        gatewayBindingsDraft.map((g, idx) => {
                          const loading = !!gatewayActionLoadingById[g.gateway_id];
                          return (
                            <div
                              key={`gw-row-${g.gateway_id}-${idx}`}
                              className="border border-slate-700 rounded p-2 grid grid-cols-1 md:grid-cols-12 gap-2"
                              style={heavyPanelStyle}
                            >
                              {simpleModeForAgent ? (
                                <>
                                  <div className="bg-slate-900 border border-slate-700 rounded px-3 py-2 text-xs md:col-span-4">
                                    <p className="text-slate-200 font-medium">{g.agent_id}</p>
                                    <p className="text-slate-400 mt-1">
                                      网关 ID：{g.gateway_id}
                                      {g.listen_port ? ` · 端口 ${g.listen_port}` : ""}
                                    </p>
                                  </div>
                                  <div className="bg-slate-900 border border-slate-700 rounded px-3 py-2 text-xs md:col-span-5">
                                    <p className="text-slate-300">已接入渠道</p>
                                    <p className="text-slate-400 mt-1 break-all">
                                      {formatOrderedChannelBindings(g.channel_instances, { channel: g.channel, instance_id: g.instance_id })}
                                    </p>
                                  </div>
                                </>
                              ) : (
                                <>
                                  <input
                                    value={g.gateway_id}
                                    onChange={(e) =>
                                      setGatewayBindingsDraft((prev) =>
                                        prev.map((x, i) => (i === idx ? { ...x, gateway_id: e.target.value } : x))
                                      )
                                    }
                                    placeholder="gateway_id"
                                    className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs md:col-span-2"
                                  />
                                  <select
                                    value={g.agent_id}
                                    onChange={(e) =>
                                      setGatewayBindingsDraft((prev) =>
                                        prev.map((x, i) => (i === idx ? { ...x, agent_id: e.target.value } : x))
                                      )
                                    }
                                    className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs md:col-span-2"
                                  >
                                    {agentsList.agents.map((a) => (
                                      <option key={`gw-a-${g.gateway_id}-${a.id}`} value={a.id}>
                                        {a.id}
                                      </option>
                                    ))}
                                  </select>
                                  <select
                                    value={g.channel}
                                    onChange={(e) =>
                                      setGatewayBindingsDraft((prev) =>
                                        prev.map((x, i) => (i === idx ? { ...x, channel: e.target.value } : x))
                                      )
                                    }
                                    className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs"
                                  >
                                    {["telegram", "feishu", "dingtalk", "discord", "qq"].map((ch) => (
                                      <option key={`gw-ch-${g.gateway_id}-${ch}`} value={ch}>
                                        {ch}
                                      </option>
                                    ))}
                                  </select>
                                  <input
                                    value={g.instance_id}
                                    onChange={(e) =>
                                      setGatewayBindingsDraft((prev) =>
                                        prev.map((x, i) => (i === idx ? { ...x, instance_id: e.target.value } : x))
                                      )
                                    }
                                    placeholder="instance_id"
                                    className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs"
                                  />
                                </>
                              )}
                              {!simpleModeForAgent && (
                                <>
                                  <input
                                    value={stringifyGatewayChannelInstances(g.channel_instances, g.channel, g.instance_id)}
                                    onChange={(e) =>
                                      setGatewayBindingsDraft((prev) =>
                                        prev.map((x, i) =>
                                          i === idx
                                            ? {
                                                ...x,
                                                channel_instances: parseGatewayChannelInstancesText(
                                                  e.target.value,
                                                  x.channel,
                                                  x.instance_id
                                                ),
                                              }
                                            : x
                                        )
                                      )
                                    }
                                    placeholder="多渠道映射: telegram:tg-main,feishu:feishu-main"
                                    className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs md:col-span-3"
                                  />
                                  <button
                                    onClick={() =>
                                      setGatewayBindingsDraft((prev) =>
                                        prev.map((x, i) =>
                                          i === idx ? { ...x, channel_instances: buildChannelInstanceMapForAgent(x.agent_id) } : x
                                        )
                                      )
                                    }
                                    className="px-2 py-1 bg-slate-700 hover:bg-slate-600 rounded text-[11px]"
                                    title="优先按该 Agent 的路由实例填充映射，其次回退到当前激活实例"
                                  >
                                    按 Agent 路由填充
                                  </button>
                                </>
                              )}
                              {!simpleModeForAgent && (
                                <input
                                  value={g.listen_port ?? ""}
                                  onChange={(e) =>
                                    setGatewayBindingsDraft((prev) =>
                                      prev.map((x, i) => ({
                                        ...x,
                                        listen_port: i === idx ? (e.target.value ? Number(e.target.value) : undefined) : x.listen_port,
                                      }))
                                    )
                                  }
                                  placeholder="port"
                                  className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs"
                                />
                              )}
                              <label className="flex items-center gap-1 text-xs text-slate-300">
                                <input
                                  type="checkbox"
                                  checked={!!g.enabled}
                                  onChange={(e) =>
                                    setGatewayBindingsDraft((prev) =>
                                      prev.map((x, i) => (i === idx ? { ...x, enabled: e.target.checked } : x))
                                    )
                                  }
                                />
                                启用
                              </label>
                              {showGatewayAdvancedActions && (
                                <div className="flex flex-wrap gap-1 md:col-span-3">
                                  <button
                                    onClick={() => void runGatewayAction("start", g.gateway_id)}
                                    disabled={loading}
                                    className="px-2 py-1 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 rounded text-[11px]"
                                  >
                                    启动
                                  </button>
                                  <button
                                    onClick={() => void runGatewayAction("stop", g.gateway_id)}
                                    disabled={loading}
                                    className="px-2 py-1 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded text-[11px]"
                                  >
                                    停止
                                  </button>
                                  <button
                                    onClick={() => void runGatewayAction("restart", g.gateway_id)}
                                    disabled={loading}
                                    className="px-2 py-1 bg-indigo-700 hover:bg-indigo-600 disabled:opacity-50 rounded text-[11px]"
                                  >
                                    重启
                                  </button>
                                  <button
                                    onClick={() => void runGatewayAction("health", g.gateway_id)}
                                    disabled={loading}
                                    className="px-2 py-1 bg-amber-700 hover:bg-amber-600 disabled:opacity-50 rounded text-[11px]"
                                  >
                                    探活
                                  </button>
                                  <button
                                    onClick={() => void runGatewayAction("logs", g.gateway_id)}
                                    disabled={loading}
                                    className="px-2 py-1 bg-sky-700 hover:bg-sky-600 disabled:opacity-50 rounded text-[11px]"
                                  >
                                    日志
                                  </button>
                                </div>
                              )}
                              <div
                                className="text-[11px] text-slate-400 md:col-span-12"
                                title={g.health?.detail || ""}
                              >
                                状态: {g.health?.status || "unknown"} · {summarizeGatewayHealthDetail(g.health?.detail)}
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>

                  <div className="bg-slate-900/40 border border-slate-700 rounded-lg p-3 space-y-3" style={heavyPanelStyle}>
                    <div className="flex items-start justify-between gap-2 flex-wrap">
                      <div>
                        <p className="text-sm text-slate-200 font-medium">手动路由覆盖</p>
                        <p className="text-xs text-slate-400 mt-1">
                          默认不用改。只有需要强制指定网关、实例，或按 account / peer / chatId 做特殊分流时，才需要改这里。
                        </p>
                      </div>
                      {showAgentAdvancedSettings && (
                        <button
                          onClick={() => setShowAdvancedRouteRules((prev) => !prev)}
                          className="px-3 py-1.5 rounded border border-slate-600 text-xs text-slate-200 hover:border-slate-500 hover:bg-slate-800/70"
                        >
                          {showAdvancedRouteRules ? "收起手动路由覆盖" : "展开手动路由覆盖"}
                        </button>
                      )}
                    </div>
                    {!showAgentAdvancedSettings && (
                      <p className="text-[11px] text-slate-500">
                        如需做特殊分流，请先展开高级设置，再打开这里。
                      </p>
                    )}
                    {showAgentAdvancedSettings && showAdvancedRouteRules && (
                      <div className="space-y-3 rounded border border-slate-700 bg-slate-950/30 p-3">
                        {telegramInstancesDraft.length === 0 && (
                          <div className="rounded border border-amber-700 bg-amber-900/20 p-2 text-xs text-amber-200">
                            你还没有配置 Telegram 实例。请先在上方点“按 Agent 自动生成”，填写 Token 后保存并应用到网关。
                          </div>
                        )}
                        <div className="space-y-2">
                          {channelRoutesDraft.map((r, idx) => (
                            <div key={r.id || `route-${idx}`} className="border border-slate-700 rounded p-2 grid grid-cols-1 md:grid-cols-9 gap-2">
                              <label className="flex items-center gap-1 text-xs text-slate-300">
                                <input
                                  type="checkbox"
                                  checked={r.enabled}
                                  onChange={(e) =>
                                    setChannelRoutesDraft((prev) =>
                                      prev.map((x, i) => (i === idx ? { ...x, enabled: e.target.checked } : x))
                                    )
                                  }
                                />
                                启用
                              </label>
                              <select
                                value={r.channel}
                                onChange={(e) =>
                                  setChannelRoutesDraft((prev) =>
                                    prev.map((x, i) => (i === idx ? { ...x, channel: e.target.value } : x))
                                  )
                                }
                                className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs"
                              >
                                {["telegram", "feishu", "dingtalk", "discord", "qq"].map((ch) => (
                                  <option key={ch} value={ch}>
                                    {ch}
                                  </option>
                                ))}
                              </select>
                              <select
                                value={r.agent_id}
                                onChange={(e) =>
                                  setChannelRoutesDraft((prev) =>
                                    prev.map((x, i) => (i === idx ? { ...x, agent_id: e.target.value } : x))
                                  )
                                }
                                className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs"
                              >
                                {agentsList.agents.map((a) => (
                                  <option key={a.id} value={a.id}>
                                    {a.id}
                                  </option>
                                ))}
                              </select>
                              <select
                                value={r.gateway_id || ""}
                                onChange={(e) =>
                                  setChannelRoutesDraft((prev) =>
                                    prev.map((x, i) =>
                                      i === idx ? { ...x, gateway_id: e.target.value || undefined } : x
                                    )
                                  )
                                }
                                className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs"
                                title="可指定网关实例（优先于bot_instance）"
                              >
                                <option value="">网关(任意)</option>
                                {gatewayBindingsDraft.map((g) => (
                                  <option key={`gw-opt-${g.gateway_id}`} value={g.gateway_id}>
                                    {g.gateway_id}
                                  </option>
                                ))}
                              </select>
                              <select
                                value={r.bot_instance || ""}
                                onChange={(e) =>
                                  setChannelRoutesDraft((prev) =>
                                    prev.map((x, i) => (i === idx ? { ...x, bot_instance: e.target.value || undefined } : x))
                                  )
                                }
                                className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs"
                                title="可指定渠道实例"
                              >
                                <option value="">实例(任意)</option>
                                {getChannelInstanceIdsByChannel(r.channel).map((iid) => (
                                  <option key={iid} value={iid}>
                                    {iid}
                                  </option>
                                ))}
                              </select>
                              <input
                                value={r.account || ""}
                                onChange={(e) =>
                                  setChannelRoutesDraft((prev) =>
                                    prev.map((x, i) => (i === idx ? { ...x, account: e.target.value } : x))
                                  )
                                }
                                placeholder="account(可选)"
                                className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs"
                              />
                              <input
                                value={r.peer || ""}
                                onChange={(e) =>
                                  setChannelRoutesDraft((prev) =>
                                    prev.map((x, i) => (i === idx ? { ...x, peer: e.target.value } : x))
                                  )
                                }
                                placeholder="peer/chatId(可选)"
                                className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs"
                              />
                              <button
                                onClick={() => setChannelRoutesDraft((prev) => prev.filter((_, i) => i !== idx))}
                                className="px-2 py-1 bg-rose-700 hover:bg-rose-600 rounded text-[11px]"
                              >
                                删除
                              </button>
                            </div>
                          ))}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button
                            onClick={() =>
                              setChannelRoutesDraft((prev) => [
                                ...prev,
                                {
                                  id: "",
                                  channel: "telegram",
                                  agent_id: agentsList.agents[0]?.id || "main",
                                  bot_instance: "",
                                  account: "",
                                  peer: "",
                                  enabled: true,
                                },
                              ])
                            }
                            className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-xs"
                          >
                            新增覆盖规则
                          </button>
                          <button
                            onClick={() => void saveChannelRoutes()}
                            disabled={agentRuntimeSaving}
                            className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 rounded text-xs"
                          >
                            {agentRuntimeSaving ? "保存中..." : "保存手动覆盖"}
                          </button>
                        </div>
                        <div className="border border-slate-700 rounded p-2 space-y-2">
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <p className="text-xs text-slate-300">路由命中测试</p>
                            <button
                              onClick={() => setShowRouteTestPanel((prev) => !prev)}
                              className="px-2 py-1 bg-slate-700 hover:bg-slate-600 rounded text-[11px]"
                            >
                              {showRouteTestPanel ? "收起测试面板" : "展开测试面板"}
                            </button>
                          </div>
                          {showRouteTestPanel && (
                            <>
                              <div className="grid grid-cols-1 md:grid-cols-6 gap-2">
                                <select
                                  value={gatewaySelectedIdForRouteTest}
                                  onChange={(e) => setGatewaySelectedIdForRouteTest(e.target.value)}
                                  className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs"
                                >
                                  <option value="">网关(任意)</option>
                                  {gatewayBindingsDraft.map((g) => (
                                    <option key={`route-gw-${g.gateway_id}`} value={g.gateway_id}>
                                      {g.gateway_id}
                                    </option>
                                  ))}
                                </select>
                                <select
                                  value={routeTestChannel}
                                  onChange={(e) => setRouteTestChannel(e.target.value)}
                                  className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs"
                                >
                                  {["telegram", "feishu", "dingtalk", "discord", "qq"].map((ch) => (
                                    <option key={ch} value={ch}>
                                      {ch}
                                    </option>
                                  ))}
                                </select>
                                <select
                                  value={routeTestBotInstance}
                                  onChange={(e) => setRouteTestBotInstance(e.target.value)}
                                  className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs"
                                >
                                  <option value="">实例(任意)</option>
                                  {getChannelInstanceIdsByChannel(routeTestChannel).map((iid) => (
                                    <option key={iid} value={iid}>
                                      {iid}
                                    </option>
                                  ))}
                                </select>
                                <input
                                  value={routeTestAccount}
                                  onChange={(e) => setRouteTestAccount(e.target.value)}
                                  placeholder="account(可选)"
                                  className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs"
                                />
                                <input
                                  value={routeTestPeer}
                                  onChange={(e) => setRouteTestPeer(e.target.value)}
                                  placeholder="peer/chatId(可选)"
                                  className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs"
                                />
                                <button
                                  onClick={() => void testChannelRoute()}
                                  disabled={routeTesting}
                                  className="px-3 py-1 bg-indigo-700 hover:bg-indigo-600 disabled:opacity-50 rounded text-xs"
                                >
                                  {routeTesting ? "测试中..." : "测试命中"}
                                </button>
                              </div>
                              {routeTestResult && <p className="text-xs text-sky-300 whitespace-pre-wrap">{routeTestResult}</p>}
                            </>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                  {gatewayLogViewerId && (
                    <div
                      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center"
                      onClick={() => setGatewayLogViewerId(null)}
                    >
                      <div
                        className="w-[92vw] max-w-4xl bg-slate-900 border border-slate-700 rounded-lg p-3 space-y-2"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="flex items-center justify-between">
                          <p className="text-sm text-slate-200">网关日志：{gatewayLogViewerId}</p>
                          <button
                            onClick={() => setGatewayLogViewerId(null)}
                            className="px-2 py-1 bg-slate-700 hover:bg-slate-600 rounded text-xs"
                          >
                            关闭
                          </button>
                        </div>
                        <pre className="max-h-[60vh] overflow-auto bg-slate-950/70 border border-slate-800 rounded p-2 text-[11px] text-slate-300 whitespace-pre-wrap">
                          {gatewayLogsById[gatewayLogViewerId] || "(暂无日志)"}
                        </pre>
                      </div>
                    </div>
                  )}
                  {(() => {
                    const focusedAgentId =
                      selectedAgentId ||
                      agentsList.agents.find((a) => a.default)?.id ||
                      agentsList.agents[0]?.id ||
                      "";
                    const currentGatewayBinding =
                      gatewayBindingsDraft.find((g) => (g.agent_id || "").trim() === focusedAgentId && g.enabled !== false) ||
                      gatewayBindingsDraft.find((g) => (g.agent_id || "").trim() === focusedAgentId) ||
                      null;
                    const currentGatewayId = currentGatewayBinding?.gateway_id || "";
                    const gatewayLoading = currentGatewayId ? !!gatewayActionLoadingById[currentGatewayId] : false;
                    const testingCurrentChannel =
                      channelInstancesEditorChannel === "telegram"
                        ? telegramBatchTesting
                        : !!channelBatchTestingByChannel[channelInstancesEditorChannel];
                    return (
                      <div className="sticky bottom-0 z-20 rounded-lg border border-slate-700 bg-slate-950/90 backdrop-blur px-4 py-3 shadow-[0_-8px_24px_rgba(0,0,0,0.28)]">
                        <div className="flex items-center justify-between gap-3 flex-wrap">
                          <div className="text-xs text-slate-300">
                            <p>
                              当前 Agent：<span className="text-slate-100 font-medium">{focusedAgentId || "未选择"}</span>
                              {" · "}
                              当前渠道：<span className="text-slate-100 font-medium">{channelInstancesEditorChannel}</span>
                            </p>
                            <p className="text-slate-500 mt-1">
                              当前网关：{currentGatewayId || "未生成，先点保存并应用"}{currentGatewayBinding?.listen_port ? ` · 端口 ${currentGatewayBinding.listen_port}` : ""}
                            </p>
                          </div>
                          <div className="flex gap-2 flex-wrap">
                            <button
                              onClick={() =>
                                void (channelInstancesEditorChannel === "telegram"
                                  ? saveAndApplyTelegramSetup()
                                  : saveAndApplyChannelSetup(channelInstancesEditorChannel as NonTelegramChannel))
                              }
                              disabled={agentRuntimeSaving}
                              className="px-3 py-2 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 rounded-lg text-xs font-medium"
                            >
                              {agentRuntimeSaving ? "保存中..." : "保存并应用"}
                            </button>
                            <button
                              onClick={() =>
                                void (channelInstancesEditorChannel === "telegram"
                                  ? testTelegramInstancesBatch()
                                  : testChannelInstancesBatch(channelInstancesEditorChannel as NonTelegramChannel))
                              }
                              disabled={testingCurrentChannel}
                              className="px-3 py-2 bg-amber-700 hover:bg-amber-600 disabled:opacity-50 rounded-lg text-xs font-medium"
                            >
                              {testingCurrentChannel ? "测试中..." : "测试连通"}
                            </button>
                            <button
                              onClick={() => void runGatewayAction("start", currentGatewayId)}
                              disabled={!currentGatewayId || gatewayLoading}
                              className="px-3 py-2 bg-sky-700 hover:bg-sky-600 disabled:opacity-50 rounded-lg text-xs font-medium"
                            >
                              {gatewayLoading ? "启动中..." : "启动当前 Agent 网关"}
                            </button>
                          </div>
                        </div>
                        {stickyChannelActionFeedback && (
                          <div className={`mt-3 rounded-lg border px-3 py-2 text-xs whitespace-pre-wrap ${stickyChannelActionFeedbackClass}`}>
                            <p className="font-medium mb-1">最近一次操作结果</p>
                            <p>{stickyChannelActionFeedback}</p>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                  </div>
                  {showCreateAgent && (
                    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setShowCreateAgent(false)}>
                      <div className="bg-slate-800 rounded-lg p-4 max-w-md w-full mx-2 space-y-2" onClick={(e) => e.stopPropagation()}>
                        <h3 className="font-medium text-slate-200">新建 Agent</h3>
                        <label className="block text-xs text-slate-400">ID (必填)</label>
                        <input
                          value={createAgentId}
                          onChange={(e) => setCreateAgentId(e.target.value)}
                          placeholder="work-agent"
                          className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-sm"
                        />
                        <label className="block text-xs text-slate-400">名称 (选填)</label>
                        <input
                          value={createAgentName}
                          onChange={(e) => setCreateAgentName(e.target.value)}
                          placeholder="显示名称"
                          className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-sm"
                        />
                        <label className="block text-xs text-slate-400">Workspace (选填)</label>
                        <input
                          value={createAgentWorkspace}
                          onChange={(e) => setCreateAgentWorkspace(e.target.value)}
                          placeholder="留空使用默认"
                          className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-sm"
                        />
                        <div className="flex gap-2 pt-2">
                          <button
                            onClick={() => setShowCreateAgent(false)}
                            className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-xs"
                          >
                            取消
                          </button>
                          <button
                            onClick={async () => {
                              if (!createAgentId.trim()) {
                                alert("请输入 Agent ID");
                                return;
                              }
                              const newAgentId = createAgentId.trim();
                              setCreatingAgent(true);
                              try {
                                await invoke("create_agent", {
                                  id: newAgentId,
                                  name: createAgentName.trim() || undefined,
                                  workspace: createAgentWorkspace.trim() || undefined,
                                  customPath: normalizeConfigPath(customConfigPath) || undefined,
                                });
                                setShowCreateAgent(false);
                                setCreateAgentId("");
                                setCreateAgentName("");
                                setCreateAgentWorkspace("");
                                await refreshAgentsList();
                                await setAgentSpecialtyIdentity(newAgentId);
                              } catch (e) {
                                alert(String(e));
                              } finally {
                                setCreatingAgent(false);
                              }
                            }}
                            disabled={creatingAgent}
                            className="px-3 py-1.5 bg-sky-700 hover:bg-sky-600 disabled:opacity-50 rounded text-xs"
                          >
                            {creatingAgent ? "创建中..." : "创建"}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-xs text-slate-400">暂无 Agent 数据</p>
              )}
            </div>
            )}

            {false && tuningSection === "chat" && (
            <div className="flex flex-col gap-2" style={{ minHeight: 520 }}>
              <div className="flex items-center justify-between">
                <p className="text-xs text-slate-400">
                  聊天对话：左侧选择 Agent，右侧是会话内容。支持手动 @agent 与自动路由。
                </p>
                <div className="flex items-center gap-2">
                  <label className="text-xs text-slate-400">路由模式</label>
                  <select
                    value={routeMode}
                    onChange={(e) => setRouteMode(e.target.value as "manual" | "auto")}
                    className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-xs"
                  >
                    <option value="manual">手动</option>
                    <option value="auto">自动</option>
                  </select>
                </div>
              </div>

              <div className="flex gap-2 flex-1 min-h-0">
                <div className="w-52 shrink-0 flex flex-col gap-1 bg-slate-800/50 rounded-lg p-2 overflow-y-auto">
                  {(agentsList?.agents || []).length > 0 ? (
                    (agentsList?.agents || []).map((a) => {
                      const selected = selectedAgentId === a.id;
                      const specialty = getAgentSpecialty(a.id);
                      const unread = unreadByAgent[a.id] || 0;
                      return (
                        <button
                          key={a.id}
                          onClick={() => {
                            void handleSelectAgentForChat(a.id);
                            invoke("set_default_agent", {
                              id: a.id,
                              customPath: normalizeConfigPath(customConfigPath) || undefined,
                            })
                              .then(() => refreshAgentsList())
                              .catch((e) => {
                                setChatError(String(e));
                              });
                          }}
                          className={`text-left px-2 py-2 rounded text-xs ${
                            selected ? "bg-sky-700 text-sky-100" : "bg-slate-700/60 hover:bg-slate-600 text-slate-200"
                          }`}
                          title={a.workspace || a.id}
                        >
                          <div className="flex items-center justify-between">
                            <span className="truncate">{a.name || a.id}</span>
                            {unread > 0 && (
                              <span className="bg-rose-600 text-white rounded-full px-1.5 text-[10px]">{unread}</span>
                            )}
                          </div>
                          <div className="text-[10px] text-slate-300/80 mt-0.5">
                            {a.id} · {specialty}
                          </div>
                        </button>
                      );
                    })
                  ) : (
                    <p className="text-xs text-slate-500 px-2">暂无 Agent</p>
                  )}
                </div>

                <div className="flex-1 min-w-0 bg-slate-900/50 rounded-lg overflow-hidden border border-slate-700/60 flex flex-col">
                  <div className="px-3 py-2 border-b border-slate-700/60 flex items-center justify-between">
                    <div className="text-sm text-slate-200">
                      当前会话：<span className="font-medium">{selectedAgentId || "(未选择)"}</span>
                      {selectedAgentId && (
                        <span className="text-xs text-slate-400 ml-2">
                          专长：{getAgentSpecialty(selectedAgentId)}
                        </span>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={handleNewSessionLocal}
                        className="px-2 py-1 bg-slate-700 hover:bg-slate-600 rounded text-xs"
                      >
                        新会话
                      </button>
                      <button
                        onClick={() =>
                          setMessagesByAgent((prev) => ({ ...prev, [selectedAgentId]: [] }))
                        }
                        className="px-2 py-1 bg-slate-700 hover:bg-slate-600 rounded text-xs"
                      >
                        清空
                      </button>
                      <button
                        onClick={handleAbortChat}
                        className="px-2 py-1 bg-rose-700 hover:bg-rose-600 rounded text-xs"
                      >
                        停止
                      </button>
                    </div>
                  </div>

                  <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-[320px]">
                    {chatLoading && (
                      <p className="text-xs text-slate-500">正在加载历史...</p>
                    )}
                    {!chatLoading && (messagesByAgent[selectedAgentId] || []).length === 0 && (
                      <p className="text-xs text-slate-500">暂无消息，开始对话吧。</p>
                    )}
                    {(messagesByAgent[selectedAgentId] || []).map((m) => {
                      const isUser = m.role === "user";
                      return (
                        <div key={m.id} className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
                          <div
                            className={`max-w-[78%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
                              isUser ? "bg-sky-700 text-white" : "bg-slate-800 text-slate-100"
                            }`}
                          >
                            <div>{m.text}</div>
                            <div className={`text-[10px] mt-1 ${isUser ? "text-sky-100/70" : "text-slate-400"}`}>
                              {m.status === "sending" && "发送中..."}
                              {m.status === "failed" && "发送失败，可重试"}
                              {(m.status === "sent" || !m.status) && (m.timestamp || m.role)}
                            </div>
                            {m.status === "failed" && (
                              <button
                                onClick={() => setChatDraft(m.text)}
                                className="mt-1 text-[10px] text-amber-300 hover:text-amber-200 underline"
                              >
                                回填重试
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div className="border-t border-slate-700/60 p-3 space-y-2">
                    {routeHint && (
                      <p className="text-xs text-emerald-300">{routeHint}</p>
                    )}
                    {chatError && (
                      <p className="text-xs text-rose-400">{chatError}</p>
                    )}
                    <div className="flex gap-2">
                      <textarea
                        value={chatDraft}
                        onChange={(e) => setChatDraft(e.target.value)}
                        placeholder="输入消息，手动路由可用 @code 你的问题"
                        rows={2}
                        className="flex-1 bg-slate-800 border border-slate-600 rounded px-3 py-2 text-sm resize-none"
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            void handleSendChat();
                          }
                        }}
                      />
                      <button
                        onClick={() => void handleSendChat()}
                        disabled={chatSending || !selectedAgentId}
                        className="px-4 py-2 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 rounded text-sm"
                      >
                        {chatSending ? "发送中..." : "发送"}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            )}

            {tuningSection === "control" && (
            <div className="space-y-4">
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
                        setServiceSkillsRenderLimit((prev) => Math.min(skillsCatalog.length, prev + 80))
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
                {marketResult && (
                  <div className="rounded border border-slate-700 bg-slate-950/40 p-3 text-xs text-slate-300 whitespace-pre-wrap">
                    {marketResult}
                  </div>
                )}
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
            <div className="bg-slate-800/50 rounded-lg p-4 space-y-3">
              <p className="font-medium text-slate-200 flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                健康检查与自愈
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-2">
                <HealthLamp label="模型探活" state={runtimeProbeResult?.includes("失败") ? "error" : runtimeProbeResult ? "ok" : "unknown"} />
                <HealthLamp label="Skills可用率" state={skillsCatalog.length ? (skillsCatalog.some((s) => s.eligible) ? "ok" : "warn") : "unknown"} />
                <HealthLamp label="自检状态" state={selfCheckItems.some((x) => x.status === "error") ? "error" : selfCheckItems.some((x) => x.status === "warn") ? "warn" : selfCheckItems.length ? "ok" : "unknown"} />
                <HealthLamp label="记忆状态" state={memoryStatus?.enabled ? "ok" : "warn"} />
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={handleTuningHealthCheck}
                  disabled={tuningActionLoading !== null}
                  className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded text-xs"
                >
                  {tuningActionLoading === "check" ? "体检中..." : "一键体检"}
                </button>
                <button
                  onClick={handleTuningSelfHeal}
                  disabled={tuningActionLoading !== null}
                  className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 rounded text-xs"
                >
                  {tuningActionLoading === "heal" ? "修复中..." : "一键修复"}
                </button>
              </div>
              <div className="bg-slate-900/40 border border-slate-700 rounded-lg p-3 text-sm text-slate-300 space-y-3" style={heavyPanelStyle}>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div>
                    <p className="font-medium text-slate-200">运行状态与任务队列</p>
                    <p className="text-xs text-slate-500 mt-1">
                      这部分已从聊天页迁入这里，减少聊天滚动时的布局和重绘压力。
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      setStep(3);
                    }}
                    className="px-2 py-1 bg-slate-700 hover:bg-slate-600 rounded text-[11px]"
                  >
                    返回聊天页
                  </button>
                </div>
                {startResult ? (
                  <div className="bg-slate-800 rounded-lg p-3 text-sm text-slate-300 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-medium text-slate-200">最近输出</p>
                      <span className="text-[11px] text-slate-500">仅显示最近几行</span>
                    </div>
                    <pre className="overflow-auto max-h-28 whitespace-pre-wrap text-xs text-slate-300">
                      {serviceStartSummary}
                    </pre>
                  </div>
                ) : (
                  <p className="text-xs text-slate-500">最近没有新的启动输出。</p>
                )}
                <div className="bg-slate-800/50 rounded-lg p-4 text-sm text-slate-300 space-y-3" style={heavyPanelStyle}>
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div>
                      <p className="font-medium text-slate-200">任务队列中心</p>
                      <p className="text-xs text-slate-500 mt-1">
                        共 {serviceQueueSummary.total} 个任务
                        {serviceQueueSummary.running ? ` · 运行中 ${serviceQueueSummary.running}` : ""}
                        {serviceQueueSummary.queued ? ` · 排队 ${serviceQueueSummary.queued}` : ""}
                        {serviceQueueSummary.failed ? ` · 失败 ${serviceQueueSummary.failed}` : ""}
                        {serviceQueueSummary.cancelled ? ` · 已取消 ${serviceQueueSummary.cancelled}` : ""}
                      </p>
                    </div>
                    {queueTasks.length > 0 && (
                      <button
                        onClick={() => setShowServiceQueueDetails((prev) => !prev)}
                        className="px-2 py-1 bg-slate-700 hover:bg-slate-600 rounded text-[11px]"
                      >
                        {showServiceQueueDetails ? "收起任务详情" : "展开任务详情"}
                      </button>
                    )}
                  </div>
                  {queueTasks.length === 0 ? (
                    <p className="text-xs text-slate-500">暂无任务。重操作会进入队列并串行执行。</p>
                  ) : showServiceQueueDetails ? (
                    <div className="space-y-2 max-h-44 overflow-auto">
                      {serviceRecentQueueTasks.map((t) => (
                        <div key={t.id} className="bg-slate-900/40 border border-slate-700 rounded p-2">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-xs text-slate-200">
                              {t.name}
                              <span className="ml-2 text-slate-400">[{t.status}]</span>
                            </p>
                            <div className="flex gap-1">
                              {(t.status === "queued" || t.status === "running") && (
                                <button
                                  onClick={() => cancelTask(t.id)}
                                  className="px-2 py-1 bg-slate-700 hover:bg-slate-600 rounded text-[11px]"
                                >
                                  取消
                                </button>
                              )}
                              {(t.status === "error" || t.status === "cancelled") &&
                                t.retryCount < t.maxRetries && (
                                  <button
                                    onClick={() => retryTask(t.id)}
                                    className="px-2 py-1 bg-amber-700 hover:bg-amber-600 rounded text-[11px]"
                                  >
                                    重试
                                  </button>
                                )}
                            </div>
                          </div>
                          {t.error && <p className="text-[11px] text-rose-300 mt-1">{t.error}</p>}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-slate-500">默认仅显示摘要，点击“展开任务详情”查看最近 5 条任务。</p>
                  )}
                </div>
              </div>
              <div className="bg-slate-900/40 border border-slate-700 rounded-lg p-3 text-sm text-slate-300 space-y-3">
                <p className="font-medium text-slate-200">渠道驱动的插件自动安装</p>
                <div className="flex flex-wrap gap-3">
                  {["telegram", "qq", "feishu", "discord", "dingtalk"].map((id) => (
                    <label key={id} className="flex items-center gap-1 text-xs text-slate-300">
                      <input
                        type="checkbox"
                        checked={!!pluginSelection[id]}
                        onChange={(e) =>
                          setPluginSelection((prev) => ({ ...prev, [id]: e.target.checked }))
                        }
                      />
                      {id}
                    </label>
                  ))}
                </div>
                <button
                  onClick={handleAutoInstallPlugins}
                  disabled={pluginInstallLoading}
                  className="px-3 py-2 bg-indigo-700 hover:bg-indigo-600 disabled:opacity-50 rounded text-xs"
                >
                  {pluginInstallLoading ? "安装中..." : "按勾选渠道自动安装/校验插件"}
                </button>
                {pluginInstallLoading && pluginInstallProgress && (
                  <div className="space-y-2">
                    <p className="text-xs text-sky-300">
                      当前进度：{pluginInstallProgress?.current ?? 0}/{pluginInstallProgress?.total ?? 0}，
                      正在处理 `{pluginInstallProgress?.channel ?? "-"}`（{pluginInstallProgress?.status ?? "-"}）
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
                                ((pluginInstallProgress?.current ?? 0) / Math.max(pluginInstallProgress?.total ?? 0, 1)) * 100
                              )
                            )
                          )}%`,
                        }}
                      />
                    </div>
                    <pre className="bg-slate-900/40 rounded p-3 text-xs whitespace-pre-wrap max-h-28 overflow-auto">
                      {pluginInstallProgressLog.join("\n")}
                    </pre>
                  </div>
                )}
                {pluginInstallResult && (
                  <pre className="bg-slate-900/40 rounded p-3 text-xs whitespace-pre-wrap max-h-40 overflow-auto">
                    {pluginInstallResult}
                  </pre>
                )}
              </div>
            </div>
            )}
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

function HealthLamp({ label, state }: { label: string; state: HealthState }) {
  const color =
    state === "ok"
      ? "bg-emerald-500"
      : state === "warn"
        ? "bg-amber-500"
        : state === "error"
          ? "bg-red-500"
          : "bg-slate-500";
  const text =
    state === "ok" ? "正常" : state === "warn" ? "关注" : state === "error" ? "异常" : "未知";
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 flex items-center gap-2">
      <span className={`inline-block w-2.5 h-2.5 rounded-full ${color}`} />
      <span className="text-xs text-slate-300">{label}</span>
      <span className="ml-auto text-xs text-slate-500">{text}</span>
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
