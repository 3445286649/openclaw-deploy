import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
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
  bundled: boolean;
  eligible: boolean;
  missing: SkillMissing;
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

const STEPS = [
  { id: 0, title: "环境检测", icon: CheckCircle2 },
  { id: 1, title: "安装 OpenClaw", icon: Download },
  { id: 2, title: "配置 AI 模型", icon: Key },
  { id: 3, title: "启动服务", icon: Play },
  { id: 4, title: "调教中心", icon: SlidersHorizontal },
];

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
const DEPLOY_SUCCESS_DIALOG =
  "恭喜部署完成！作者已为你配置稳定代理API（每天免费额度）。加QQ群1085253453领更多额度或29元无限包月。";

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
  const installLogBufferRef = useRef<string[]>([]);
  const installLogFlushTimerRef = useRef<number | null>(null);

  const [provider, setProvider] = useState("openai");
  const [apiKey, setApiKey] = useState("");
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
  const [selectedModel, setSelectedModel] = useState(RECOMMENDED_MODEL_FALLBACK);
  const [runtimeModelInfo, setRuntimeModelInfo] = useState<RuntimeModelInfo | null>(null);
  const [keySyncStatus, setKeySyncStatus] = useState<KeySyncStatus | null>(null);
  const [runtimeProbeResult, setRuntimeProbeResult] = useState<string | null>(null);
  const [runtimeProbeLoading, setRuntimeProbeLoading] = useState(false);

  const [starting, setStarting] = useState(false);
  const [startResult, setStartResult] = useState<string | null>(null);
  const [telegramConfig, setTelegramConfig] = useState<ChannelConfig>({});
  const [feishuConfig, setFeishuConfig] = useState<ChannelConfig>({});
  const [qqConfig, setQqConfig] = useState<ChannelConfig>({});
  const [discordConfig, setDiscordConfig] = useState<ChannelConfig>({});
  const [dingtalkConfig, setDingtalkConfig] = useState<ChannelConfig>({});
  const [channelSaving, setChannelSaving] = useState<string | null>(null);
  const [channelTesting, setChannelTesting] = useState<string | null>(null);
  const [pairingLoading, setPairingLoading] = useState<string | null>(null);
  const [telegramPairingCode, setTelegramPairingCode] = useState("");
  const [channelResult, setChannelResult] = useState<string | null>(null);
  const [telegramHealth, setTelegramHealth] = useState<{
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
  const [feishuHealth, setFeishuHealth] = useState<ChannelHealthInfo>({
    configured: "unknown",
    token: "unknown",
    gateway: "unknown",
    pairing: "ok",
    detail: "未检测",
  });
  const [qqHealth, setQqHealth] = useState<ChannelHealthInfo>({
    configured: "unknown",
    token: "unknown",
    gateway: "unknown",
    pairing: "ok",
    detail: "未检测",
  });
  const [discordHealth, setDiscordHealth] = useState<ChannelHealthInfo>({
    configured: "unknown",
    token: "unknown",
    gateway: "unknown",
    pairing: "ok",
    detail: "未检测",
  });
  const [dingtalkHealth, setDingtalkHealth] = useState<ChannelHealthInfo>({
    configured: "unknown",
    token: "unknown",
    gateway: "unknown",
    pairing: "ok",
    detail: "未检测",
  });
  const [autoRefreshHealth, setAutoRefreshHealth] = useState(false);
  const [savedAiHint, setSavedAiHint] = useState<string | null>(null);
  const [localInfo, setLocalInfo] = useState<LocalOpenclawInfo | null>(null);
  const [exeCheckInfo, setExeCheckInfo] = useState<ExecutableCheckInfo | null>(null);
  const [uninstalling, setUninstalling] = useState(false);
  const [onboardCliLoading, setOnboardCliLoading] = useState(false);
  const [selfCheckLoading, setSelfCheckLoading] = useState(false);
  const [selfCheckItems, setSelfCheckItems] = useState<SelfCheckItem[]>([]);
  const [selfCheckFixingKey, setSelfCheckFixingKey] = useState<string | null>(null);
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
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsResult, setSkillsResult] = useState<string | null>(null);
  const [skillsCatalogLoading, setSkillsCatalogLoading] = useState(false);
  const [skillsCatalog, setSkillsCatalog] = useState<SkillCatalogItem[]>([]);
  const [selectedSkills, setSelectedSkills] = useState<Record<string, boolean>>({});
  const [skillsRepairLoading, setSkillsRepairLoading] = useState(false);
  const [skillsAction, setSkillsAction] = useState<"install" | "repair" | null>(null);
  const [skillsRepairProgress, setSkillsRepairProgress] = useState<SkillsRepairProgressEvent | null>(null);
  const [skillsRepairProgressLog, setSkillsRepairProgressLog] = useState<string[]>([]);
  const [diagnosticLoading, setDiagnosticLoading] = useState(false);
  const [diagnosticResult, setDiagnosticResult] = useState<string | null>(null);
  const [snapshotsLoading, setSnapshotsLoading] = useState(false);
  const [snapshots, setSnapshots] = useState<string[]>([]);
  const [rollingBackSnapshot, setRollingBackSnapshot] = useState<string | null>(null);
  const [startupMigrationResult, setStartupMigrationResult] = useState<StartupMigrationResult | null>(null);
  const [queueTasks, setQueueTasks] = useState<QueueTaskItem[]>([]);
  const queueRunnersRef = useRef<Record<string, () => Promise<void>>>({});
  const cancelledRunningTasksRef = useRef<Set<string>>(new Set());
  const [ticketSummary, setTicketSummary] = useState<string | null>(null);

  const [fixing, setFixing] = useState<"node" | "npm" | "git" | "openclaw" | null>(null);
  const [fixResult, setFixResult] = useState<string | null>(null);
  const [quickMode, setQuickMode] = useState<QuickMode>("stable");
  const [scenarioPreset, setScenarioPreset] = useState<ScenarioPreset>("none");
  const [tuneLength, setTuneLength] = useState<TuneLength>("medium");
  const [tuneTone, setTuneTone] = useState<TuneTone>("professional");
  const [tuneProactivity, setTuneProactivity] = useState<TuneProactivity>("balanced");
  const [tunePermission, setTunePermission] = useState<TunePermission>("confirm");
  const [memoryMode, setMemoryMode] = useState<MemoryMode>("session");
  const [memoryStatus, setMemoryStatus] = useState<MemoryCenterStatus | null>(null);
  const [memorySummary, setMemorySummary] = useState<string | null>(null);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryActionLoading, setMemoryActionLoading] = useState<"read" | "clear" | "export" | "init" | null>(null);
  const [tuningActionLoading, setTuningActionLoading] = useState<"check" | "heal" | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardUseCase, setWizardUseCase] = useState<ScenarioPreset>("customer_support");
  const [wizardTone, setWizardTone] = useState<TuneTone>("friendly");
  const [wizardMemory, setWizardMemory] = useState<MemoryMode>("session");
  const consistencyGuardRanRef = useRef(false);
  const selectedSkillItems = skillsCatalog.filter((s) => !!selectedSkills[s.name]);
  const selectedManualSkillItems = selectedSkillItems.filter((s) => hasManualSkillGaps(s));
  const selectedAutoFixableItems = selectedSkillItems.filter((s) => isAutoFixableSkill(s));
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
    if (savedInstall) setCustomInstallPath(savedInstall);
    if (savedConfig) {
      if (!isLikelyConfigPath(savedConfig)) {
        localStorage.removeItem("openclaw_config_dir");
        if (looksLikeApiKey(savedConfig)) {
          setSaveResult("检测到你曾把 API Key 填到“自定义配置路径”，已自动清理该路径缓存，请在 API Key 输入框填写后保存。");
        }
      } else {
        setCustomConfigPath(savedConfig);
      }
    } else {
      // 无保存路径时自动检测并填充
      invoke<string | null>("detect_openclaw_config_path")
        .then((p) => {
          if (p && isLikelyConfigPath(p)) setCustomConfigPath(p);
        })
        .catch(() => {});
    }
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
    if (step < 3 || consistencyGuardRanRef.current) return;
    consistencyGuardRanRef.current = true;
    void runSelfCheck();
  }, [step]);

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
      if (step >= 3) {
        void loadSavedChannels(cfgPath);
      }
    }, 350);
    return () => {
      if (configReloadTimerRef.current !== null) {
        window.clearTimeout(configReloadTimerRef.current);
        configReloadTimerRef.current = null;
      }
    };
  }, [customConfigPath, step]);

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
    if (step >= 1 && !loadedStepDataRef.current.install) {
      loadedStepDataRef.current.install = true;
      void refreshLocalInfo(installHint, cfgPath);
    }
    if (step >= 2 && !loadedStepDataRef.current.model) {
      loadedStepDataRef.current.model = true;
      void Promise.all([
        loadSavedAiConfig(cfgPath),
        loadRuntimeModelInfo(cfgPath),
        loadKeySyncStatus(cfgPath),
      ]);
    }
    if (step >= 3 && !loadedStepDataRef.current.channel) {
      loadedStepDataRef.current.channel = true;
      void Promise.all([loadSavedChannels(cfgPath), loadSnapshots()]);
    }
    if (step >= 4) {
      void refreshMemoryCenterStatus();
    }
  }, [step]);

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

  const [channelConfigStatus, setChannelConfigStatus] = useState<
    Record<string, boolean>
  >({});
  const [channelClearing, setChannelClearing] = useState<string | null>(null);

  const loadChannelConfigStatus = async (cfgPath?: string) => {
    try {
      const customPath = normalizeConfigPath(cfgPath || customConfigPath) || undefined;
      const status = await invoke<Record<string, boolean>>("get_channel_config_status", {
        customPath,
      });
      setChannelConfigStatus(status || {});
    } catch {
      setChannelConfigStatus({});
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
      setFeishuConfig({
        appId: fs?.appId ?? "",
        appSecret: fs?.appSecret ?? "",
      });
      setQqConfig({
        appId: qq?.appId ?? "",
        token: qq?.token ?? "",
      });
      setDiscordConfig({
        token: dc?.token ?? dc?.botToken ?? "",
        botToken: dc?.botToken ?? dc?.token ?? "",
      });
      const dtAcc = (dt as { accounts?: { main?: ChannelConfig } })?.accounts?.main ?? dt;
      setDingtalkConfig({
        appKey: dtAcc?.appKey ?? "",
        appSecret: dtAcc?.appSecret ?? "",
      });
      await loadChannelConfigStatus(cfgPath || customConfigPath);
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

  const handleSaveChannel = async (
    channel: "telegram" | "feishu" | "qq" | "discord" | "dingtalk",
    config: ChannelConfig
  ) => {
    setChannelSaving(channel);
    setChannelResult(null);
    try {
      const result = await invoke<string>("save_channel_config", {
        channel,
        config,
        customPath: normalizeConfigPath(customConfigPath) || undefined,
      });
      setChannelResult(result);
      await loadSavedChannels();
    } catch (e) {
      setChannelResult(`保存失败: ${e}`);
    } finally {
      setChannelSaving(null);
      if (step === 3) {
        void refreshAllChannelHealth();
      }
    }
  };

  const handleTestChannel = async (
    channel: "telegram" | "feishu" | "qq" | "discord" | "dingtalk",
    config: ChannelConfig
  ) => {
    setChannelTesting(channel);
    setChannelResult(null);
    try {
      const result = await invoke<string>("test_channel_connection", {
        channel,
        config,
      });
      setChannelResult(result);
    } catch (e) {
      setChannelResult(`测试失败: ${e}`);
    } finally {
      setChannelTesting(null);
      if (step === 3) {
        void refreshAllChannelHealth();
      }
    }
  };

  const handleListPairings = async (channel: "telegram" | "feishu" | "qq") => {
    setPairingLoading(channel);
    setChannelResult(null);
    try {
      const result = await invoke<string>("list_pairings", {
        channel,
        customPath: normalizeConfigPath(customConfigPath) || undefined,
      });
      setChannelResult(result || "当前没有待审批配对请求。");
    } catch (e) {
      setChannelResult(`查询配对失败: ${e}`);
    } finally {
      setPairingLoading(null);
    }
  };

  const handleApprovePairing = async (channel: "telegram" | "feishu" | "qq") => {
    setPairingLoading(channel);
    setChannelResult(null);
    try {
      const result = await invoke<string>("approve_pairing", {
        channel,
        code: telegramPairingCode.trim(),
        customPath: normalizeConfigPath(customConfigPath) || undefined,
      });
      setChannelResult(result);
      setTelegramPairingCode("");
    } catch (e) {
      setChannelResult(`配对失败: ${e}`);
    } finally {
      setPairingLoading(null);
    }
  };

  const handleClearChannel = async (channel: "telegram" | "feishu" | "qq" | "discord" | "dingtalk") => {
    setChannelClearing(channel);
    setChannelResult(null);
    try {
      const result = await invoke<string>("remove_channel_config", {
        channel,
        customPath: normalizeConfigPath(customConfigPath) || undefined,
      });
      setChannelResult(result);
      await loadSavedChannels();
      if (channel === "telegram") setTelegramConfig({ botToken: "", chatId: "" });
      if (channel === "feishu") setFeishuConfig({ appId: "", appSecret: "" });
      if (channel === "qq") setQqConfig({ appId: "", token: "" });
      if (channel === "discord") setDiscordConfig({ token: "", botToken: "" });
      if (channel === "dingtalk") setDingtalkConfig({ appKey: "", appSecret: "" });
    } catch (e) {
      setChannelResult(`清除失败: ${e}`);
    } finally {
      setChannelClearing(null);
      if (step === 3) void refreshAllChannelHealth();
    }
  };

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

    setTelegramHealth({
      configured: hasToken ? "ok" : "error",
      token: tokenState,
      gateway: gatewayState,
      pairing: pairingState,
      detail,
    });
  };

  const refreshFeishuHealth = async (gatewayStateHint?: HealthState) => {
    const hasCred = !!feishuConfig.appId?.trim() && !!feishuConfig.appSecret?.trim();
    let tokenState: HealthState = hasCred ? "warn" : "error";
    let detail = "飞书通常不需要配对码，保存凭证后可直接对话。";
    if (hasCred) {
      try {
        await invoke<string>("test_channel_connection", {
          channel: "feishu",
          config: feishuConfig,
        });
        tokenState = "ok";
      } catch (e) {
        tokenState = "error";
        detail = `飞书检测：${String(e)}`;
      }
    }
    const gatewayState = gatewayStateHint ?? (await getGatewayHealthState());
    setFeishuHealth({
      configured: hasCred ? "ok" : "error",
      token: tokenState,
      gateway: gatewayState,
      pairing: "ok",
      detail,
    });
  };

  const refreshQqHealth = async (gatewayStateHint?: HealthState) => {
    const hasCred = !!qqConfig.appId?.trim() && !!qqConfig.token?.trim();
    let tokenState: HealthState = hasCred ? "warn" : "error";
    let detail = "QQ 通常不需要配对码，保存凭证后可直接对话。";
    if (hasCred) {
      try {
        await invoke<string>("test_channel_connection", {
          channel: "qq",
          config: qqConfig,
        });
        tokenState = "ok";
      } catch (e) {
        tokenState = "error";
        detail = `QQ 检测：${String(e)}`;
      }
    }
    const gatewayState = gatewayStateHint ?? (await getGatewayHealthState());
    setQqHealth({
      configured: hasCred ? "ok" : "error",
      token: tokenState,
      gateway: gatewayState,
      pairing: "ok",
      detail,
    });
  };

  const refreshDiscordHealth = async (gatewayStateHint?: HealthState) => {
    const hasCred = !!(discordConfig.token?.trim() || discordConfig.botToken?.trim());
    let tokenState: HealthState = hasCred ? "warn" : "error";
    let detail = "Discord 需 Bot Token，保存后需 Gateway 运行。";
    if (hasCred) {
      try {
        const cfg = { token: discordConfig.token || discordConfig.botToken, botToken: discordConfig.botToken || discordConfig.token };
        await invoke<string>("test_channel_connection", { channel: "discord", config: cfg });
        tokenState = "ok";
      } catch (e) {
        tokenState = "error";
        detail = `Discord 检测：${String(e)}`;
      }
    }
    const gatewayState = gatewayStateHint ?? (await getGatewayHealthState());
    setDiscordHealth({
      configured: hasCred ? "ok" : "error",
      token: tokenState,
      gateway: gatewayState,
      pairing: "ok",
      detail,
    });
  };

  const refreshDingtalkHealth = async (gatewayStateHint?: HealthState) => {
    const hasCred = !!dingtalkConfig.appKey?.trim() && !!dingtalkConfig.appSecret?.trim();
    let tokenState: HealthState = hasCred ? "warn" : "error";
    let detail = "钉钉需 AppKey + AppSecret，保存后需 Gateway 运行。";
    if (hasCred) {
      try {
        await invoke<string>("test_channel_connection", { channel: "dingtalk", config: dingtalkConfig });
        tokenState = "ok";
      } catch (e) {
        tokenState = "error";
        detail = `钉钉检测：${String(e)}`;
      }
    }
    const gatewayState = gatewayStateHint ?? (await getGatewayHealthState());
    setDingtalkHealth({
      configured: hasCred ? "ok" : "error",
      token: tokenState,
      gateway: gatewayState,
      pairing: "ok",
      detail,
    });
  };

  const refreshAllChannelHealth = async () => {
    if (starting) return;
    const gatewayState = await getGatewayHealthState();
    await Promise.all([
      refreshTelegramHealth(gatewayState),
      refreshFeishuHealth(gatewayState),
      refreshQqHealth(gatewayState),
      refreshDiscordHealth(gatewayState),
      refreshDingtalkHealth(gatewayState),
    ]);
  };

  useEffect(() => {
    if (step !== 3 || starting || !autoRefreshHealth) return;
    void refreshAllChannelHealth();
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void refreshAllChannelHealth();
    }, 60000);
    return () => window.clearInterval(timer);
  }, [step, customConfigPath, starting, autoRefreshHealth]);

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
    setStarting(true);
    setStartResult(null);
    const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
    const installHint = (localInfo?.install_dir || customInstallPath || lastInstallDir || "").trim() || undefined;
    try {
      const result = await invoke<string>("start_gateway", {
        customPath: cfgPath,
        installHint,
      });
      setStartResult(stripAnsi(result));
      try {
        const url = await invoke<string>("get_gateway_dashboard_url", { customPath: cfgPath });
        await invoke<string>("open_external_url", { url });
      } catch {
        // ignore browser open errors; keep startup success
      }
      window.alert(DEPLOY_SUCCESS_DIALOG);
    } catch (e) {
      setStartResult(stripAnsi(`启动失败: ${e}`));
    } finally {
      setStarting(false);
      if (step === 3) {
        void refreshAllChannelHealth();
      }
    }
  };

  const handleOpenDashboard = async () => {
    const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
    try {
      const url = await invoke<string>("get_gateway_dashboard_url", { customPath: cfgPath });
      await invoke<string>("open_external_url", { url });
    } catch (e) {
      setStartResult(`打开失败: ${e}`);
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
      try {
        const url = await invoke<string>("get_gateway_dashboard_url", { customPath: cfgPath });
        await invoke<string>("open_external_url", { url });
      } catch {
        // ignore open errors
      }
    } catch (e) {
      setStartResult(stripAnsi(`重置认证失败: ${e}`));
    } finally {
      setStarting(false);
    }
  };

  const handleStartForeground = async () => {
    const cfgPath = normalizeConfigPath(customConfigPath) || undefined;
    const installHint = (localInfo?.install_dir || customInstallPath || lastInstallDir || "").trim() || undefined;
    try {
      const result = await invoke<string>("start_gateway_foreground", {
        customPath: cfgPath,
        installHint,
      });
      setStartResult(stripAnsi(result));
      try {
        const url = await invoke<string>("get_gateway_dashboard_url", { customPath: cfgPath });
        await invoke<string>("open_external_url", { url });
      } catch {
        // ignore browser open errors; foreground window already started
      }
      window.alert(DEPLOY_SUCCESS_DIALOG);
    } catch (e) {
      setStartResult(stripAnsi(`前台启动失败: ${e}`));
    }
  };

  const handleOpenSkillsOnboard = async () => {
    if (onboardCliLoading) return;
    setOnboardCliLoading(true);
    setStartResult(null);
    const installHint = (localInfo?.install_dir || customInstallPath || lastInstallDir || "").trim() || undefined;
    try {
      const result = await invoke<string>("run_onboard_cli", {
        customPath: normalizeConfigPath(customConfigPath) || undefined,
        installHint,
      });
      setStartResult(stripAnsi(`${result}\n提示：在打开的终端里选择安装 Skills，即可一键补齐能力。`));
    } catch (e) {
      setStartResult(stripAnsi(`打开 Skills 安装向导失败: ${e}`));
    } finally {
      setOnboardCliLoading(false);
    }
  };

  const runSelfCheck = async () => {
    enqueueTask("自检总控", async () => {
      if (selfCheckLoading) return;
      setSelfCheckLoading(true);
      setSelfCheckResult(null);
      try {
        const installHint = (localInfo?.install_dir || customInstallPath || lastInstallDir || "").trim() || undefined;
        const items = await invoke<SelfCheckItem[]>("run_self_check", {
          customPath: normalizeConfigPath(customConfigPath) || undefined,
          installHint,
        });
        setSelfCheckItems(items || []);
        setSelfCheckResult("自检完成");
      } catch (e) {
        setSelfCheckResult(`自检失败: ${e}`);
        setTicketSummary(makeTicketSummary("自检总控", e, "run_self_check"));
        throw e;
      } finally {
        setSelfCheckLoading(false);
      }
    });
  };

  const handleFixSelfCheck = async (key: string) => {
    if (selfCheckFixingKey) return;
    setSelfCheckFixingKey(key);
    setSelfCheckResult(null);
    try {
      const installHint = (localInfo?.install_dir || customInstallPath || lastInstallDir || "").trim() || undefined;
      const result = await invoke<string>("fix_self_check_item", {
        key,
        customPath: normalizeConfigPath(customConfigPath) || undefined,
        installHint,
      });
      setSelfCheckResult(result);
      await runSelfCheck();
    } catch (e) {
      setSelfCheckResult(`修复失败: ${e}`);
    } finally {
      setSelfCheckFixingKey(null);
    }
  };

  const handleMinimalRepair = async () => {
    enqueueTask("一键最小修复", async () => {
      setSelfCheckResult(null);
      try {
        const installHint = (localInfo?.install_dir || customInstallPath || lastInstallDir || "").trim() || undefined;
        const result = await invoke<string>("run_minimal_repair", {
          customPath: normalizeConfigPath(customConfigPath) || undefined,
          installHint,
        });
        setSelfCheckResult(clampLogText(`最小修复完成\n${result}`));
        await runSelfCheck();
      } catch (e) {
        setSelfCheckResult(`最小修复失败: ${e}`);
        setTicketSummary(makeTicketSummary("一键最小修复", e, "run_minimal_repair"));
        throw e;
      }
    });
  };

  const handleAutoInstallPlugins = async () => {
    enqueueTask("渠道插件自动安装", async () => {
      if (pluginInstallLoading) return;
      setPluginInstallLoading(true);
      setPluginInstallResult(null);
      setPluginInstallProgress(null);
      setPluginInstallProgressLog([]);
      const unlisten = await listen<PluginInstallProgressEvent>("plugin-install-progress", (e) => {
        const payload = e.payload;
        if (!payload) return;
        setPluginInstallProgress(payload);
        setPluginInstallProgressLog((prev) => {
          const line = `[${payload.current}/${payload.total}] ${payload.channel}: ${payload.message}`;
          const next = [...prev, line];
          return next.length > 80 ? next.slice(-80) : next;
        });
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

  const loadSkillsCatalog = async () => {
    if (skillsCatalogLoading) return;
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
    } catch (e) {
      setSkillsResult(`加载 Skills 列表失败: ${e}`);
    } finally {
      setSkillsCatalogLoading(false);
    }
  };

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
      const unlisten = await listen<SkillsRepairProgressEvent>("skills-repair-progress", (e) => {
        const payload = e.payload;
        if (!payload) return;
        setSkillsRepairProgress(payload);
        setSkillsRepairProgressLog((prev) => {
          const line = `[${payload.current}/${payload.total}] ${payload.skill}: ${payload.message}`;
          const next = [...prev, line];
          return next.length > 120 ? next.slice(-120) : next;
        });
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
        await loadSkillsCatalog();
      } catch (e) {
        setSkillsResult(`安装失败: ${e}`);
        setTicketSummary(makeTicketSummary("安装选中Skills", e, "install_selected_skills"));
        throw e;
      } finally {
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
      const unlisten = await listen<SkillsRepairProgressEvent>("skills-repair-progress", (e) => {
        const payload = e.payload;
        if (!payload) return;
        setSkillsRepairProgress(payload);
        setSkillsRepairProgressLog((prev) => {
          const line = `[${payload.current}/${payload.total}] ${payload.skill}: ${payload.message}`;
          const next = [...prev, line];
          return next.length > 120 ? next.slice(-120) : next;
        });
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
        await loadSkillsCatalog();
      } catch (e) {
        setSkillsResult(`修复失败: ${e}`);
        setTicketSummary(makeTicketSummary("修复选中Skills", e, "repair_selected_skills"));
        throw e;
      } finally {
        unlisten();
        setSkillsRepairLoading(false);
        setSkillsAction(null);
      }
    });
  };

  const handleExportDiagnosticBundle = async () => {
    enqueueTask("导出诊断包", async () => {
      if (diagnosticLoading) return;
      setDiagnosticLoading(true);
      setDiagnosticResult(null);
      try {
        const installHint = (localInfo?.install_dir || customInstallPath || lastInstallDir || "").trim() || undefined;
        const result = await invoke<string>("export_diagnostic_bundle", {
          customPath: normalizeConfigPath(customConfigPath) || undefined,
          installHint,
        });
        setDiagnosticResult(`诊断包已导出: ${result}`);
      } catch (e) {
        setDiagnosticResult(`导出诊断包失败: ${e}`);
        setTicketSummary(makeTicketSummary("导出诊断包", e, "export_diagnostic_bundle"));
        throw e;
      } finally {
        setDiagnosticLoading(false);
      }
    });
  };

  const loadSnapshots = async () => {
    if (snapshotsLoading) return;
    setSnapshotsLoading(true);
    try {
      const list = await invoke<string[]>("list_config_snapshots", {
        customPath: normalizeConfigPath(customConfigPath) || undefined,
      });
      setSnapshots(list || []);
    } catch {
      setSnapshots([]);
    } finally {
      setSnapshotsLoading(false);
    }
  };

  const handleRollbackSnapshot = async (snapshotDir: string) => {
    if (rollingBackSnapshot) return;
    setRollingBackSnapshot(snapshotDir);
    setDiagnosticResult(null);
    try {
      const result = await invoke<string>("rollback_config_snapshot", {
        snapshotDir,
        customPath: normalizeConfigPath(customConfigPath) || undefined,
      });
      setDiagnosticResult(result);
      await Promise.all([loadSavedAiConfig(), loadSavedChannels(), loadSnapshots(), runSelfCheck()]);
    } catch (e) {
      setDiagnosticResult(`回滚失败: ${e}`);
    } finally {
      setRollingBackSnapshot(null);
    }
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
    setStep(4);
    setSelfCheckResult("已完成首次向导：建议点击“一键体检”确认环境状态。");
  };

  const globalGatewayState: HealthState = selfCheckItems.find((x) => x.key === "gateway")?.status === "ok"
    ? "ok"
    : selfCheckItems.find((x) => x.key === "gateway")
    ? "warn"
    : "unknown";
  const globalModelState: HealthState = runtimeProbeResult?.includes("失败")
    ? "error"
    : runtimeProbeResult
    ? "ok"
    : "unknown";
  const globalMemoryState: HealthState = memoryStatus?.enabled
    ? memoryStatus.memory_file_count > 0
      ? "ok"
      : "warn"
    : "warn";
  const globalSkillsState: HealthState = skillsCatalog.length
    ? skillsCatalog.some((s) => s.eligible)
      ? "ok"
      : "warn"
    : "unknown";
  const globalChannelState: HealthState = telegramHealth.gateway === "ok" || feishuHealth.gateway === "ok" || qqHealth.gateway === "ok" || discordHealth.gateway === "ok" || dingtalkHealth.gateway === "ok"
    ? "ok"
    : "warn";

  const latestIssueText =
    (selfCheckResult || "") +
    "\n" +
    (startResult || "") +
    "\n" +
    (modelTestResult || "") +
    "\n" +
    (skillsResult || "");
  const lowerIssue = latestIssueText.toLowerCase();
  const suggestModelFix = lowerIssue.includes("model") || lowerIssue.includes("401") || lowerIssue.includes("api key");
  const suggestGatewayFix = lowerIssue.includes("token mismatch") || lowerIssue.includes("gateway") || lowerIssue.includes("端口");
  const suggestSkillsFix = lowerIssue.includes("skills") || lowerIssue.includes("缺失依赖") || lowerIssue.includes("bins:");
  const configGuardItem = selfCheckItems.find((x) => x.key === "config" && x.status !== "ok");
  const versionGuardItem = selfCheckItems.find((x) => x.key === "version" && x.status !== "ok");

  const envReady = nodeCheck?.ok && npmCheck?.ok;
  const canProceed = step === 0 ? envReady : true;

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col">
      {/* Header */}
      <header className="border-b border-slate-700 px-6 py-4">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <span className="text-2xl">🦞</span>
          OpenClaw 一键部署
        </h1>
        <p className="text-slate-400 text-sm mt-1">小白零门槛，5 分钟拥有私人 AI 助手</p>
      </header>

      {/* Step indicator */}
      <div className="flex gap-2 px-6 py-4 border-b border-slate-700 overflow-x-auto">
        {STEPS.map((s, i) => (
          <button
            key={s.id}
            onClick={() => setStep(s.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
              step === s.id
                ? "bg-emerald-600 text-white"
                : i < step
                  ? "bg-slate-700 text-slate-300"
                  : "bg-slate-800 text-slate-500"
            }`}
          >
            <s.icon className="w-4 h-4" />
            {s.title}
            {i < STEPS.length - 1 && <ChevronRight className="w-4 h-4 opacity-50" />}
          </button>
        ))}
      </div>

      <div className="px-6 py-3 border-b border-slate-700 bg-slate-900/40 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-slate-400">当前可用性：</span>
        <MiniLamp label="模型" state={globalModelState} />
        <MiniLamp label="网关" state={globalGatewayState} />
        <MiniLamp label="记忆" state={globalMemoryState} />
        <MiniLamp label="Skills" state={globalSkillsState} />
        <MiniLamp label="渠道" state={globalChannelState} />
        <button
          onClick={handleTuningHealthCheck}
          className="ml-auto px-2 py-1 bg-slate-700 hover:bg-slate-600 rounded"
        >
          快速体检
        </button>
      </div>

      {/* Content */}
      <main className="flex-1 p-6 overflow-auto">
        {(suggestModelFix || suggestGatewayFix || suggestSkillsFix) && (
          <div className="w-full max-w-[1200px] mx-auto mb-4 rounded-lg border border-amber-700 bg-amber-900/20 p-3 text-xs space-y-2">
            <p className="text-amber-200">检测到可能异常，建议下一步：</p>
            <div className="flex flex-wrap gap-2">
              {suggestModelFix && (
                <button
                  onClick={() => setStep(2)}
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
                  onClick={() => setStep(3)}
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
            <h2 className="text-lg font-semibold">环境检测</h2>
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
            <h2 className="text-lg font-semibold">配置 AI 模型</h2>
            <p className="text-slate-400">
              选择 AI 提供商并填入 API Key。支持自定义 API 地址（如 OneAPI、NewAPI 等中转服务）。
            </p>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-2">AI 提供商</label>
                <select
                  value={provider}
                  onChange={(e) => {
                    const next = e.target.value;
                    if (next === provider) return;
                    if (apiKey.trim()) {
                      const confirmed = window.confirm(
                        "切换 AI 提供商将清空当前 API Key，避免不同平台 Key 串用。是否继续？"
                      );
                      if (!confirmed) return;
                      setApiKey("");
                    }
                    setProvider(next);
                    if (next === "kimi") {
                      setBaseUrl(DEFAULT_KIMI_BASE_URL);
                      setSelectedModel("moonshotai/Kimi-K2-Instruct-0905");
                    } else if (next === "openai" || next === "deepseek" || next === "qwen") {
                      if (!baseUrl.trim() || baseUrl.trim() === DEFAULT_KIMI_BASE_URL) {
                        setBaseUrl(DEFAULT_OPENAI_BASE_URL);
                      }
                      setSelectedModel(RECOMMENDED_MODEL_FALLBACK);
                    }
                  }}
                  className="w-full bg-slate-800 border border-slate-600 rounded-lg px-4 py-2"
                >
                  <option value="anthropic">Anthropic Claude</option>
                  <option value="openai">OpenAI GPT</option>
                  <option value="deepseek">DeepSeek</option>
                  <option value="kimi">Kimi (Moonshot)</option>
                  <option value="qwen">通义千问 (Qwen)</option>
                  <option value="bailian">阿里云百炼</option>
                </select>
                <p className="text-sky-300 text-xs mt-2">
                  保存后将写入运行时主模型：
                  {selectedModel
                    ? ` ${provider === "anthropic" ? "anthropic" : "openai"}/${selectedModel}`
                    : ` ${preferredPrimaryModelForProvider(provider)}`}
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">API Key *</label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="输入你的硅基流动 Key（没有？加作者QQ群1085253453领免费测试额度）"
                  className="w-full bg-slate-800 border border-slate-600 rounded-lg px-4 py-2"
                />
                <p className="text-emerald-300 text-xs mt-2">
                  作者推荐硅基流动API（免费额度多、速度快），或 Kimi（长上下文强）。加群领备用Key + 未来包月代理（29元无限）
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">
                  可用模型 <span className="text-slate-500">(硅基流动)</span>
                </label>
                <select
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-600 rounded-lg px-4 py-2"
                >
                  {FIXED_SILICONFLOW_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
                <p className="text-sky-300 text-xs mt-2">
                  想用更多高端模型？加群 1085253453 解锁！
                </p>
                {selectedModel && (() => {
                  const inferred = inferModelContextWindow(selectedModel);
                  if (inferred !== null && inferred < 16000) {
                    return (
                      <p className="text-amber-300 text-xs mt-2">
                        当前模型推断窗口约 {inferred}，低于系统最低 16000，保存将被拦截。
                      </p>
                    );
                  }
                  if (inferred !== null) {
                    return <p className="text-emerald-300 text-xs mt-2">当前模型推断窗口约 {inferred}。</p>;
                  }
                  return (
                    <p className="text-slate-400 text-xs mt-2">
                      当前模型窗口未知，建议优先选择带 16k/32k/128k 标识的模型。
                    </p>
                  );
                })()}
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">
                  自定义 API 地址 <span className="text-slate-500">(可选)</span>
                </label>
                <input
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={DEFAULT_OPENAI_BASE_URL}
                  className="w-full bg-slate-800 border border-slate-600 rounded-lg px-4 py-2"
                />
                <div className="flex gap-2 mt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setProvider("openai");
                      setBaseUrl(DEFAULT_OPENAI_BASE_URL);
                      setSelectedModel(RECOMMENDED_MODEL_FALLBACK);
                    }}
                    className="px-3 py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-xs"
                  >
                    使用硅基地址
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setProvider("kimi");
                      setBaseUrl(DEFAULT_KIMI_BASE_URL);
                    }}
                    className="px-3 py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-xs"
                  >
                    切换 Kimi 地址
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">
                  网络代理 URL <span className="text-slate-500">(可选，保存到 env)</span>
                </label>
                <input
                  type="text"
                  value={proxyUrl}
                  onChange={(e) => setProxyUrl(e.target.value)}
                  placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:1080"
                  className="w-full bg-slate-800 border border-slate-600 rounded-lg px-4 py-2"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">
                  NO_PROXY <span className="text-slate-500">(可选)</span>
                </label>
                <input
                  type="text"
                  value={noProxy}
                  onChange={(e) => setNoProxy(e.target.value)}
                  placeholder="127.0.0.1,localhost,.local"
                  className="w-full bg-slate-800 border border-slate-600 rounded-lg px-4 py-2"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">
                  自定义配置路径 <span className="text-slate-500">(可选)</span>
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={customConfigPath}
                    onChange={(e) => setCustomConfigPath(e.target.value)}
                    placeholder="留空使用 ~/.openclaw，如 D:\\openclaw-config"
                    className="flex-1 bg-slate-800 border border-slate-600 rounded-lg px-4 py-2"
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
                <p className="text-slate-500 text-xs mt-1">
                  配置、凭证、会话数据将存储在此目录。建议留空使用默认，避免 Gateway 与部署工具路径不一致导致 Telegram 无响应。
                </p>
                <details className="mt-2 text-xs text-slate-400">
                  <summary className="cursor-pointer hover:text-slate-300">安装在其他盘时如何填写？</summary>
                  <ul className="mt-1 ml-4 list-disc space-y-0.5 text-slate-500">
                    <li>填写<strong className="text-slate-400">配置目录</strong>的完整路径（内含 openclaw.json 的文件夹）</li>
                    <li>示例：<code className="bg-slate-800 px-1 rounded">D:\openclaw\.openclaw</code>、<code className="bg-slate-800 px-1 rounded">E:\my-config</code></li>
                    <li>可用 <code className="bg-slate-800 px-1 rounded">\</code> 或 <code className="bg-slate-800 px-1 rounded">/</code>，末尾不要加反斜杠</li>
                    <li>不确定时先点「自动检测」；若检测不到，在资源管理器中找到含 openclaw.json 的文件夹，复制其地址栏路径粘贴即可</li>
                  </ul>
                </details>
              </div>
              {runtimeModelInfo && (
                <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-3 text-xs text-slate-300 space-y-1">
                  <p>当前生效模型：{runtimeModelInfo.model || "未知"}</p>
                  <p>当前生效接口：{runtimeModelInfo.provider_api || "未知"}</p>
                  <p>当前生效地址：{runtimeModelInfo.base_url || "未知"}</p>
                  <p>当前生效 Key 前缀：{runtimeModelInfo.key_prefix || "未读取到"}</p>
                </div>
              )}
              {keySyncStatus && (
                <div className="bg-slate-800/40 border border-slate-700 rounded-lg p-3 text-xs space-y-1">
                  <p className={keySyncStatus.synced ? "text-emerald-300" : "text-amber-300"}>
                    Key 同步状态：{keySyncStatus.synced ? "已同步" : "未同步"}
                  </p>
                  <p className="text-slate-300">openclaw.json：{keySyncStatus.openclaw_json_key_prefix || "未读取到"}</p>
                  <p className="text-slate-300">env：{keySyncStatus.env_key_prefix || "未读取到"}</p>
                  <p className="text-slate-300">auth-profiles：{keySyncStatus.auth_profile_key_prefix || "未读取到"}</p>
                  <p className="text-slate-400">{keySyncStatus.detail}</p>
                </div>
              )}
              <div className="bg-slate-800/40 border border-slate-700 rounded-lg p-3 text-xs">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-slate-300">启动后自动探活（基于当前生效配置）</p>
                  <button
                    onClick={() => probeRuntimeModelConnection()}
                    disabled={runtimeProbeLoading}
                    className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-slate-200"
                  >
                    {runtimeProbeLoading ? "探活中..." : "立即探活"}
                  </button>
                </div>
                {runtimeProbeResult && (
                  <p
                    className={`mt-2 ${
                      runtimeProbeResult.includes("通过") ? "text-emerald-400" : "text-amber-300"
                    }`}
                  >
                    {runtimeProbeResult}
                  </p>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleSaveConfig}
                  disabled={saving || modelTesting || cleaningLegacy}
                  className="flex items-center gap-2 px-6 py-3 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg font-medium"
                >
                  {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Key className="w-5 h-5" />}
                  保存配置
                </button>
                <button
                  onClick={handleTestModel}
                  disabled={modelTesting || cleaningLegacy}
                  className="flex items-center gap-2 px-6 py-3 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded-lg font-medium"
                >
                  {modelTesting ? <Loader2 className="w-5 h-5 animate-spin" /> : <Wrench className="w-5 h-5" />}
                  模型连通性检测
                </button>
                <button
                  onClick={handleCleanupLegacyCache}
                  disabled={cleaningLegacy || modelTesting || saving}
                  className="flex items-center gap-2 px-6 py-3 bg-amber-700 hover:bg-amber-600 disabled:opacity-50 rounded-lg font-medium"
                >
                  {cleaningLegacy ? <Loader2 className="w-5 h-5 animate-spin" /> : <Wrench className="w-5 h-5" />}
                  一键清理历史 Provider 缓存
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
              {savedAiHint && (
                <p className="text-sky-300 text-sm">{savedAiHint}</p>
              )}
            </div>
            <div className="bg-slate-800/50 rounded-lg p-4 text-sm text-slate-400">
              <p className="font-medium text-slate-300 mb-2">获取 API Key：</p>
              <ul className="space-y-1">
                <li>• Claude: console.anthropic.com</li>
                <li>• OpenAI: platform.openai.com</li>
                <li>• DeepSeek: platform.deepseek.com</li>
                <li>• Kimi: platform.moonshot.cn</li>
                <li>• 通义千问: dashscope.console.aliyun.com</li>
                <li>• 阿里云百炼: bailian.console.aliyun.com</li>
              </ul>
            </div>
          </div>
        )}

        {/* Step 3: 启动服务 */}
        {step === 3 && (
          <div className="w-full max-w-[1200px] mx-auto space-y-6">
            <h2 className="text-lg font-semibold">启动服务</h2>
            {customConfigPath && (
              <div className="bg-slate-800/50 rounded-lg p-3 text-sm text-slate-400">
                配置路径: {normalizeConfigPath(customConfigPath)}
              </div>
            )}
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
            {exeCheckInfo && (
              <div className="bg-indigo-900/20 border border-indigo-700 rounded-lg p-3 text-xs space-y-1">
                <p className="text-indigo-200 font-medium">路径锁定提示（自动）</p>
                <p className={exeCheckInfo.exists ? "text-emerald-300" : "text-amber-300"}>
                  可执行：{exeCheckInfo.executable || "未解析到 openclaw.cmd"}
                </p>
                <p className="text-slate-300">
                  配置目录：{normalizeConfigPath(customConfigPath) || "默认 (~/.openclaw)"}
                </p>
                <p className="text-slate-400">
                  启动时会自动清理 18789 端口占用并固定使用上述路径，避免旧版本冲突。
                </p>
              </div>
            )}
            <p className="text-slate-400">
              启动 OpenClaw Gateway，AI 助手将在后台运行。渠道配置已支持图形化，不再依赖黑色终端窗口。
            </p>
            <button
              onClick={handleStart}
              disabled={starting}
              className="flex items-center gap-2 px-6 py-3 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg font-medium"
            >
              {starting ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  启动中...
                </>
              ) : (
                <>
                  <Play className="w-5 h-5" />
                  启动 Gateway 并自动打开对话网页
                </>
              )}
            </button>
            <button
              onClick={handleOpenDashboard}
              className="flex items-center gap-2 px-6 py-3 bg-sky-700 hover:bg-sky-600 rounded-lg font-medium text-sm"
            >
              <ExternalLink className="w-5 h-5" />
              打开对话界面（带 token）
            </button>
            <details className="bg-slate-900/40 border border-slate-700 rounded-lg p-3">
              <summary className="cursor-pointer text-slate-300 text-sm">高级启动/修复选项（一般不用）</summary>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  onClick={handleResetGatewayAuth}
                  disabled={starting}
                  className="flex items-center gap-2 px-4 py-2 bg-amber-700 hover:bg-amber-600 disabled:opacity-50 rounded text-xs"
                >
                  <Wrench className="w-4 h-4" />
                  强制重置认证/修复UI并重启
                </button>
                <button
                  onClick={handleStartForeground}
                  className="flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded text-xs"
                >
                  <Wrench className="w-4 h-4" />
                  前台启动 Gateway
                </button>
                <button
                  onClick={handleOpenSkillsOnboard}
                  disabled={onboardCliLoading}
                  className="flex items-center gap-2 px-4 py-2 bg-indigo-700 hover:bg-indigo-600 disabled:opacity-50 rounded text-xs"
                >
                  {onboardCliLoading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      打开中...
                    </>
                  ) : (
                    <>
                      <Wrench className="w-4 h-4" />
                      安装/更新官方 Skills
                    </>
                  )}
                </button>
              </div>
            </details>
            {startResult && (
              <pre className="bg-slate-800 rounded-lg p-4 text-sm overflow-auto max-h-40">
                {startResult}
              </pre>
            )}
            <div className="bg-slate-800/50 rounded-lg p-4 text-sm text-slate-300 space-y-3">
              <p className="font-medium text-slate-200">任务队列中心（防卡死）</p>
              {queueTasks.length === 0 ? (
                <p className="text-xs text-slate-500">暂无任务。重操作会进入队列并串行执行。</p>
              ) : (
                <div className="space-y-2 max-h-44 overflow-auto">
                  {queueTasks
                    .slice()
                    .reverse()
                    .map((t) => (
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
              )}
            </div>
            <div className="bg-slate-800/50 rounded-lg p-4 text-sm text-slate-300 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium text-slate-200">安装后自检总控页</p>
                <div className="flex gap-2">
                  <button
                    onClick={runSelfCheck}
                    disabled={selfCheckLoading}
                    className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded text-xs"
                  >
                    {selfCheckLoading ? "检测中..." : "一键自检"}
                  </button>
                  <button
                    onClick={handleMinimalRepair}
                    className="px-3 py-1.5 bg-amber-700 hover:bg-amber-600 rounded text-xs"
                  >
                    一键最小修复
                  </button>
                </div>
              </div>
              {(configGuardItem || versionGuardItem) && (
                <div className="rounded border border-amber-700 bg-amber-900/20 p-3 text-xs space-y-2">
                  <p className="text-amber-200">检测到版本/配置一致性异常，建议先处理再继续调教。</p>
                  {configGuardItem && <p className="text-slate-300">配置异常：{configGuardItem.detail}</p>}
                  {versionGuardItem && <p className="text-slate-300">版本提示：{versionGuardItem.detail}</p>}
                  <div className="flex flex-wrap gap-2">
                    {configGuardItem && (
                      <button
                        onClick={() => handleFixSelfCheck("config")}
                        disabled={selfCheckFixingKey === "config"}
                        className="px-2 py-1 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 rounded"
                      >
                        {selfCheckFixingKey === "config" ? "修复中..." : "修复配置一致性"}
                      </button>
                    )}
                    {versionGuardItem && (
                      <button
                        onClick={() => handleFixSelfCheck("version")}
                        disabled={selfCheckFixingKey === "version"}
                        className="px-2 py-1 bg-sky-700 hover:bg-sky-600 disabled:opacity-50 rounded"
                      >
                        {selfCheckFixingKey === "version" ? "处理中..." : "执行版本守护"}
                      </button>
                    )}
                  </div>
                </div>
              )}
              {!!selfCheckItems.length && (
                <div className="space-y-2">
                  {selfCheckItems.map((item) => (
                    <div key={item.key} className="rounded border border-slate-700 bg-slate-900/40 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-slate-200 text-sm">
                          {item.label}
                          <span className={`ml-2 text-xs ${
                            item.status === "ok"
                              ? "text-emerald-400"
                              : item.status === "warn"
                                ? "text-amber-300"
                                : "text-red-400"
                          }`}>
                            {item.status}
                          </span>
                        </p>
                        {item.status !== "ok" && (
                          <button
                            onClick={() => handleFixSelfCheck(item.key)}
                            disabled={selfCheckFixingKey === item.key}
                            className="px-2 py-1 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 rounded text-xs"
                          >
                            {selfCheckFixingKey === item.key ? "修复中..." : "立即修复"}
                          </button>
                        )}
                      </div>
                      <pre className="mt-2 text-xs text-slate-400 whitespace-pre-wrap">{item.detail}</pre>
                    </div>
                  ))}
                </div>
              )}
              {selfCheckResult && <p className="text-xs text-sky-300">{selfCheckResult}</p>}
            </div>
            <div className="bg-slate-800/50 rounded-lg p-4 text-sm text-slate-300 space-y-3">
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
                    当前进度：{pluginInstallProgress.current}/{pluginInstallProgress.total}，
                    正在处理 `{pluginInstallProgress.channel}`（{pluginInstallProgress.status}）
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
                              (pluginInstallProgress.current / Math.max(pluginInstallProgress.total, 1)) * 100
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
            <div className="bg-slate-800/50 rounded-lg p-4 text-sm text-slate-300 space-y-3">
              <p className="font-medium text-slate-200">Skills 管理面板</p>
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
                  {(() => {
                    const progressText = skillsRepairProgressLog.join("\n").trim();
                    const resultText = (skillsResult || "").trim();
                    if (progressText && resultText) return `${progressText}\n\n----- 结果日志 -----\n${resultText}`;
                    if (progressText) return progressText;
                    if (resultText) return resultText;
                    return "暂无日志。点击“安装选中”或“修复缺失依赖（选中）”后，这里会实时显示执行输出。";
                  })()}
                </pre>
              </div>
              <div className="overflow-auto border border-slate-700 rounded-lg">
                <table className="w-full min-w-[900px] text-xs">
                  <thead className="bg-slate-900/60 text-slate-300">
                    <tr>
                      <th className="text-left px-2 py-2">选择</th>
                      <th className="text-left px-2 py-2">Skill</th>
                      <th className="text-left px-2 py-2">来源</th>
                      <th className="text-left px-2 py-2">状态</th>
                      <th className="text-left px-2 py-2">缺失项摘要</th>
                      <th className="text-left px-2 py-2">操作建议</th>
                    </tr>
                  </thead>
                  <tbody>
                    {skillsCatalog.map((s) => {
                      const missingParts = [
                        s.missing.bins.length ? `bins:${s.missing.bins.join(",")}` : "",
                        s.missing.any_bins.length ? `any:${s.missing.any_bins.join(",")}` : "",
                        s.missing.env.length ? `env:${s.missing.env.join(",")}` : "",
                        s.missing.config.length ? `cfg:${s.missing.config.slice(0, 2).join(",")}` : "",
                        s.missing.os.length ? `os:${s.missing.os.join(",")}` : "",
                      ].filter(Boolean);
                      return (
                        <tr key={s.name} className="border-t border-slate-800">
                          <td className="px-2 py-2">
                            <input
                              type="checkbox"
                              checked={!!selectedSkills[s.name]}
                              onChange={(e) =>
                                setSelectedSkills((prev) => ({ ...prev, [s.name]: e.target.checked }))
                              }
                            />
                          </td>
                          <td className="px-2 py-2 text-slate-200">{s.name}</td>
                          <td className="px-2 py-2">{s.source || (s.bundled ? "bundled" : "unknown")}</td>
                          <td
                            className={`px-2 py-2 ${
                              s.eligible
                                ? "text-emerald-400"
                                : hasManualSkillGaps(s)
                                ? "text-rose-300"
                                : "text-amber-300"
                            }`}
                          >
                            {s.eligible ? "可用" : hasManualSkillGaps(s) ? "需手动处理" : "可自动修复"}
                          </td>
                          <td className="px-2 py-2 text-slate-400">{missingParts.join(" | ") || "-"}</td>
                          <td className="px-2 py-2">
                            {hasManualSkillGaps(s) ? (
                              <button
                                onClick={async () => {
                                  const hint = buildManualFixHint(s);
                                  try {
                                    await navigator.clipboard.writeText(hint);
                                    setSkillsResult(`已复制 ${s.name} 的手动修复指引`);
                                  } catch {
                                    setSkillsResult(`复制失败，请手动复制：\n\n${hint}`);
                                  }
                                }}
                                className="px-2 py-1 bg-amber-700 hover:bg-amber-600 rounded text-xs"
                              >
                                复制手动指引
                              </button>
                            ) : isAutoFixableSkill(s) ? (
                              <span className="text-emerald-300 text-xs">可点“修复缺失依赖（选中）”</span>
                            ) : (
                              <span className="text-slate-500 text-xs">-</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {skillsRepairLoading && skillsRepairProgress && (
                <div className="space-y-2">
                  <p className="text-xs text-sky-300">
                    修复进度：{skillsRepairProgress.current}/{skillsRepairProgress.total}，
                    当前 `{skillsRepairProgress.skill}` - {skillsRepairProgress.message}
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
                              (skillsRepairProgress.current / Math.max(skillsRepairProgress.total, 1)) * 100
                            )
                          )
                        )}%`,
                      }}
                    />
                  </div>
                </div>
              )}
            </div>
            <div className="bg-slate-800/50 rounded-lg p-4 text-sm text-slate-300 space-y-3">
              <p className="font-medium text-slate-200">诊断与回滚</p>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={handleExportDiagnosticBundle}
                  disabled={diagnosticLoading}
                  className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded text-xs"
                >
                  {diagnosticLoading ? "导出中..." : "一键导出诊断包"}
                </button>
                <button
                  onClick={loadSnapshots}
                  disabled={snapshotsLoading}
                  className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded text-xs"
                >
                  {snapshotsLoading ? "加载中..." : "刷新配置快照"}
                </button>
              </div>
              {snapshots.length > 0 && (
                <div className="space-y-2 max-h-40 overflow-auto">
                  {snapshots.slice(0, 10).map((s) => (
                    <div key={s} className="flex items-center justify-between gap-2 bg-slate-900/40 rounded p-2">
                      <span className="text-xs text-slate-400 truncate">{s}</span>
                      <button
                        onClick={() => handleRollbackSnapshot(s)}
                        disabled={rollingBackSnapshot === s}
                        className="px-2 py-1 bg-amber-700 hover:bg-amber-600 disabled:opacity-50 rounded text-xs"
                      >
                        {rollingBackSnapshot === s ? "回滚中..." : "回滚"}
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {diagnosticResult && <pre className="text-xs text-sky-300 whitespace-pre-wrap">{diagnosticResult}</pre>}
              {ticketSummary && (
                <div className="space-y-2">
                  <p className="text-xs text-amber-300">可复制工单摘要（发给维护者）</p>
                  <pre className="text-xs text-slate-300 whitespace-pre-wrap bg-slate-900/40 rounded p-2 max-h-28 overflow-auto">
                    {ticketSummary}
                  </pre>
                  <button
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(ticketSummary);
                        setDiagnosticResult("已复制工单摘要到剪贴板");
                      } catch {
                        setDiagnosticResult("复制失败，请手动复制");
                      }
                    }}
                    className="px-3 py-1.5 bg-indigo-700 hover:bg-indigo-600 rounded text-xs"
                  >
                    复制工单摘要
                  </button>
                </div>
              )}
            </div>
            <div className="bg-gradient-to-r from-emerald-900/40 to-indigo-900/40 border border-emerald-700/40 rounded-lg p-4 text-sm text-slate-200 space-y-2">
              <p className="font-medium">权益中心（免费额度 / 群支持 / 包月代理）</p>
              <p className="text-xs text-slate-300">
                每日免费额度、问题优先答疑、代理服务申请入口。推荐先加群获取试用额度。
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => openUrl("https://qm.qq.com/q/yEwM0TR6F4")}
                  className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 rounded text-xs"
                >
                  一键加群（1085253453）
                </button>
                <button
                  onClick={() => openUrl("https://github.com/3445286649/openclaw-deploy/issues/new")}
                  className="px-3 py-1.5 bg-indigo-700 hover:bg-indigo-600 rounded text-xs"
                >
                  提交申请/问题单
                </button>
              </div>
            </div>
            <div className="bg-slate-800/50 rounded-lg p-4 text-sm text-slate-300 space-y-3">
              <p className="font-medium text-slate-200">Telegram 快速配对</p>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="在这里填写机器人返回的配对码"
                  value={telegramPairingCode}
                  onChange={(e) => setTelegramPairingCode(e.target.value)}
                  className="flex-1 bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm"
                />
                <button
                  onClick={() => handleApprovePairing("telegram")}
                  disabled={pairingLoading === "telegram" || !telegramPairingCode.trim()}
                  className="px-3 py-2 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 rounded-lg text-xs"
                >
                  批准配对码
                </button>
                <button
                  onClick={() => handleListPairings("telegram")}
                  disabled={pairingLoading === "telegram"}
                  className="px-3 py-2 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded-lg text-xs"
                >
                  查询待审批配对
                </button>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={refreshAllChannelHealth}
                  className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-xs"
                >
                  立即刷新全部状态灯
                </button>
                <label className="flex items-center gap-1 text-xs text-slate-400">
                  <input
                    type="checkbox"
                    checked={autoRefreshHealth}
                    onChange={(e) => setAutoRefreshHealth(e.target.checked)}
                  />
                  自动刷新（极简模式默认关闭）
                </label>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                <HealthLamp label="已配置" state={telegramHealth.configured} />
                <HealthLamp label="Token连通" state={telegramHealth.token} />
                <HealthLamp label="Gateway" state={telegramHealth.gateway} />
                <HealthLamp label="配对状态" state={telegramHealth.pairing} />
              </div>
              <span className="text-xs text-slate-400">{telegramHealth.detail}</span>
            </div>
            <div className="space-y-4">
              <p className="text-slate-300 font-medium">渠道配置（图形化）</p>
              <div className="bg-slate-800/50 rounded-lg p-4 text-sm text-slate-300 space-y-2">
              <p className="font-medium text-slate-200">ID / Token 获取指引（可展开教程）</p>
              <details className="bg-slate-900/40 rounded p-3">
                <summary className="cursor-pointer text-slate-200">Telegram（第 1/2/3 步）</summary>
                <div className="mt-2 text-slate-300 space-y-1">
                  <p>1) 在 Telegram 搜索并打开 <code className="mx-1 px-1 bg-slate-700 rounded">@BotFather</code></p>
                  <p>2) 发送 <code className="mx-1 px-1 bg-slate-700 rounded">/newbot</code>，按提示设置机器人名</p>
                  <p>3) 复制返回的 Bot Token，粘贴到本页 Telegram 卡片</p>
                  <p className="text-amber-300">常见错误：Token 前后带空格、机器人未开始对话。</p>
                  <p className="text-slate-500">截图位：BotFather 返回 Token 的界面</p>
                </div>
              </details>
              <details className="bg-slate-900/40 rounded p-3">
                <summary className="cursor-pointer text-slate-200">飞书（第 1/2/3 步）</summary>
                <div className="mt-2 text-slate-300 space-y-1">
                  <p>1) 打开飞书开放平台，创建企业自建应用</p>
                  <p>2) 在「凭证与基础信息」获取 App ID / App Secret</p>
                  <p>3) 在本页飞书卡片填写并先点“连通性测试”</p>
                  <p className="text-amber-300">常见错误：应用未发布、权限范围没勾选。</p>
                  <p className="text-slate-500">截图位：App ID / App Secret 页面</p>
                </div>
              </details>
              <details className="bg-slate-900/40 rounded p-3">
                <summary className="cursor-pointer text-slate-200">QQ（第 1/2/3 步）</summary>
                <div className="mt-2 text-slate-300 space-y-1">
                  <p>1) 打开 QQ 开放平台创建机器人应用</p>
                  <p>2) 获取 App ID 和 Token</p>
                  <p>3) 在本页 QQ 卡片填写后测试并保存</p>
                  <p className="text-amber-300">常见错误：机器人未通过审核、回调配置未生效。</p>
                  <p className="text-slate-500">截图位：QQ 开放平台凭证页</p>
                </div>
              </details>
              <details className="bg-slate-900/40 rounded p-3">
                <summary className="cursor-pointer text-slate-200">Discord（第 1/2/3 步）</summary>
                <div className="mt-2 text-slate-300 space-y-1">
                  <p>1) 打开 Discord 开发者门户创建应用</p>
                  <p>2) 在 Bot 页面创建 Bot 并复制 Token</p>
                  <p>3) 在本页 Discord 卡片填写 Token 并保存</p>
                  <p className="text-slate-500">需安装 @openclaw/discord 插件（非内置）</p>
                </div>
              </details>
              <details className="bg-slate-900/40 rounded p-3">
                <summary className="cursor-pointer text-slate-200">钉钉（第 1/2/3 步）</summary>
                <div className="mt-2 text-slate-300 space-y-1">
                  <p>1) 打开钉钉开放平台创建应用</p>
                  <p>2) 获取 AppKey 和 AppSecret</p>
                  <p>3) 在本页钉钉卡片填写并保存</p>
                  <p className="text-slate-500">需安装 @adongguo/openclaw-dingtalk 插件</p>
                </div>
              </details>
                <div className="flex flex-wrap gap-2 pt-1">
                  <button
                    onClick={() => openUrl("https://core.telegram.org/bots#6-botfather")}
                    className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-xs"
                  >
                    打开 Telegram BotFather 文档
                  </button>
                  <button
                    onClick={() => openUrl("https://open.feishu.cn/")}
                    className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-xs"
                  >
                    打开飞书开放平台
                  </button>
                  <button
                    onClick={() => openUrl("https://q.qq.com/")}
                    className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-xs"
                  >
                    打开 QQ 开放平台
                  </button>
                  <button
                    onClick={() => openUrl("https://discord.com/developers/applications")}
                    className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-xs"
                  >
                    打开 Discord 开发者门户
                  </button>
                  <button
                    onClick={() => openUrl("https://open.dingtalk.com/")}
                    className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-xs"
                  >
                    打开钉钉开放平台
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                <ChannelCard
                  title="Telegram"
                  channelId="telegram"
                  configured={channelConfigStatus.telegram}
                  onClear={() => handleClearChannel("telegram")}
                  clearing={channelClearing === "telegram"}
                >
                    <>
                      <input
                        type="text"
                        placeholder="Bot Token"
                        value={telegramConfig.botToken ?? ""}
                        onChange={(e) =>
                          setTelegramConfig((p) => ({ ...p, botToken: e.target.value }))
                        }
                        className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm"
                      />
                      <input
                        type="text"
                        placeholder="Chat ID（可选）"
                        value={telegramConfig.chatId ?? ""}
                        onChange={(e) =>
                          setTelegramConfig((p) => ({ ...p, chatId: e.target.value }))
                        }
                        className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm mt-2"
                      />
                      <div className="flex gap-2 mt-2">
                        <button
                          onClick={() => handleSaveChannel("telegram", telegramConfig)}
                          disabled={channelSaving === "telegram"}
                          className="px-3 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-xs"
                        >
                          保存
                        </button>
                        <button
                          onClick={() => handleTestChannel("telegram", telegramConfig)}
                          disabled={channelTesting === "telegram"}
                          className="px-3 py-2 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded-lg text-xs"
                        >
                          连通性测试
                        </button>
                      </div>
                      <div className="mt-3 p-2 rounded border border-slate-700 bg-slate-900/40">
                        <p className="text-xs text-slate-400 mb-2">
                          如果机器人返回了配对码，在这里输入后点“批准配对码”。
                        </p>
                        <input
                          type="text"
                          placeholder="输入 Telegram 配对码"
                          value={telegramPairingCode}
                          onChange={(e) => setTelegramPairingCode(e.target.value)}
                          className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm"
                        />
                        <div className="flex gap-2 mt-2">
                          <button
                            onClick={() => handleApprovePairing("telegram")}
                            disabled={pairingLoading === "telegram" || !telegramPairingCode.trim()}
                            className="px-3 py-2 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 rounded-lg text-xs"
                          >
                            批准配对码
                          </button>
                          <button
                            onClick={() => handleListPairings("telegram")}
                            disabled={pairingLoading === "telegram"}
                            className="px-3 py-2 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded-lg text-xs"
                          >
                            查询待审批配对
                          </button>
                        </div>
                      </div>
                    </>
                </ChannelCard>
                <ChannelCard
                  title="飞书"
                  channelId="feishu"
                  configured={channelConfigStatus.feishu}
                  onClear={() => handleClearChannel("feishu")}
                  clearing={channelClearing === "feishu"}
                >
                  <>
                      <input
                        type="text"
                        placeholder="App ID"
                        value={feishuConfig.appId ?? ""}
                        onChange={(e) =>
                          setFeishuConfig((p) => ({ ...p, appId: e.target.value }))
                        }
                        className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm"
                      />
                      <input
                        type="password"
                        placeholder="App Secret"
                        value={feishuConfig.appSecret ?? ""}
                        onChange={(e) =>
                          setFeishuConfig((p) => ({ ...p, appSecret: e.target.value }))
                        }
                        className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm mt-2"
                      />
                      <div className="flex gap-2 mt-2">
                        <button
                          onClick={() => handleSaveChannel("feishu", feishuConfig)}
                          disabled={channelSaving === "feishu"}
                          className="px-3 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-xs"
                        >
                          保存
                        </button>
                        <button
                          onClick={() => handleTestChannel("feishu", feishuConfig)}
                          disabled={channelTesting === "feishu"}
                          className="px-3 py-2 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded-lg text-xs"
                        >
                          连通性测试
                        </button>
                      </div>
                      <p className="text-xs text-slate-400 mt-2">飞书无需填写配对码。</p>
                      <div className="grid grid-cols-2 gap-2 mt-2">
                        <HealthLamp label="已配置" state={feishuHealth.configured} />
                        <HealthLamp label="凭证连通" state={feishuHealth.token} />
                        <HealthLamp label="Gateway" state={feishuHealth.gateway} />
                        <HealthLamp label="配对状态" state={feishuHealth.pairing} />
                      </div>
                      <p className="text-xs text-slate-500 mt-1">{feishuHealth.detail}</p>
                    </>
                </ChannelCard>
                <ChannelCard
                  title="QQ"
                  channelId="qq"
                  configured={channelConfigStatus.qq}
                  onClear={() => handleClearChannel("qq")}
                  clearing={channelClearing === "qq"}
                >
                  <>
                      <input
                        type="text"
                        placeholder="App ID"
                        value={qqConfig.appId ?? ""}
                        onChange={(e) => setQqConfig((p) => ({ ...p, appId: e.target.value }))}
                        className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm"
                      />
                      <input
                        type="password"
                        placeholder="Token"
                        value={qqConfig.token ?? ""}
                        onChange={(e) => setQqConfig((p) => ({ ...p, token: e.target.value }))}
                        className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm mt-2"
                      />
                      <div className="flex gap-2 mt-2">
                        <button
                          onClick={() => handleSaveChannel("qq", qqConfig)}
                          disabled={channelSaving === "qq"}
                          className="px-3 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-xs"
                        >
                          保存
                        </button>
                        <button
                          onClick={() => handleTestChannel("qq", qqConfig)}
                          disabled={channelTesting === "qq"}
                          className="px-3 py-2 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded-lg text-xs"
                        >
                          连通性测试
                        </button>
                      </div>
                      <p className="text-xs text-slate-400 mt-2">QQ 无需填写配对码。</p>
                      <div className="grid grid-cols-2 gap-2 mt-2">
                        <HealthLamp label="已配置" state={qqHealth.configured} />
                        <HealthLamp label="凭证连通" state={qqHealth.token} />
                        <HealthLamp label="Gateway" state={qqHealth.gateway} />
                        <HealthLamp label="配对状态" state={qqHealth.pairing} />
                      </div>
                      <p className="text-xs text-slate-500 mt-1">{qqHealth.detail}</p>
                    </>
                </ChannelCard>
                <ChannelCard
                  title="Discord"
                  channelId="discord"
                  configured={channelConfigStatus.discord}
                  onClear={() => handleClearChannel("discord")}
                  clearing={channelClearing === "discord"}
                >
                  <>
                    <input
                      type="password"
                      placeholder="Bot Token"
                      value={discordConfig.token ?? discordConfig.botToken ?? ""}
                      onChange={(e) => {
                        const v = e.target.value;
                        setDiscordConfig((p) => ({ ...p, token: v, botToken: v }));
                      }}
                      className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm"
                    />
                    <div className="flex gap-2 mt-2">
                      <button
                        onClick={() => handleSaveChannel("discord", { token: discordConfig.token || discordConfig.botToken, botToken: discordConfig.botToken || discordConfig.token })}
                        disabled={channelSaving === "discord"}
                        className="px-3 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-xs"
                      >
                        保存
                      </button>
                      <button
                        onClick={() => handleTestChannel("discord", { token: discordConfig.token || discordConfig.botToken, botToken: discordConfig.botToken || discordConfig.token })}
                        disabled={channelTesting === "discord"}
                        className="px-3 py-2 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded-lg text-xs"
                      >
                        连通性测试
                      </button>
                    </div>
                    <div className="grid grid-cols-2 gap-2 mt-2">
                      <HealthLamp label="已配置" state={discordHealth.configured} />
                      <HealthLamp label="凭证连通" state={discordHealth.token} />
                      <HealthLamp label="Gateway" state={discordHealth.gateway} />
                    </div>
                    <p className="text-xs text-slate-500 mt-1">{discordHealth.detail}</p>
                  </>
                </ChannelCard>
                <ChannelCard
                  title="钉钉"
                  channelId="dingtalk"
                  configured={channelConfigStatus.dingtalk}
                  onClear={() => handleClearChannel("dingtalk")}
                  clearing={channelClearing === "dingtalk"}
                >
                  <>
                    <input
                      type="text"
                      placeholder="AppKey"
                      value={dingtalkConfig.appKey ?? ""}
                      onChange={(e) => setDingtalkConfig((p) => ({ ...p, appKey: e.target.value }))}
                      className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm"
                    />
                    <input
                      type="password"
                      placeholder="AppSecret"
                      value={dingtalkConfig.appSecret ?? ""}
                      onChange={(e) => setDingtalkConfig((p) => ({ ...p, appSecret: e.target.value }))}
                      className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm mt-2"
                    />
                    <div className="flex gap-2 mt-2">
                      <button
                        onClick={() => handleSaveChannel("dingtalk", dingtalkConfig)}
                        disabled={channelSaving === "dingtalk"}
                        className="px-3 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-xs"
                      >
                        保存
                      </button>
                      <button
                        onClick={() => handleTestChannel("dingtalk", dingtalkConfig)}
                        disabled={channelTesting === "dingtalk"}
                        className="px-3 py-2 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded-lg text-xs"
                      >
                        连通性测试
                      </button>
                    </div>
                    <div className="grid grid-cols-2 gap-2 mt-2">
                      <HealthLamp label="已配置" state={dingtalkHealth.configured} />
                      <HealthLamp label="凭证连通" state={dingtalkHealth.token} />
                      <HealthLamp label="Gateway" state={dingtalkHealth.gateway} />
                    </div>
                    <p className="text-xs text-slate-500 mt-1">{dingtalkHealth.detail}</p>
                  </>
                </ChannelCard>
              </div>
              {channelResult && (
                <pre className="bg-slate-800 rounded-lg p-3 text-sm overflow-auto max-h-32">
                  {channelResult}
                </pre>
              )}
            </div>
            <div className="bg-slate-800/50 rounded-lg p-4 text-sm text-slate-300 space-y-2">
              <p className="font-medium text-slate-200">后续如何交互（推荐顺序）</p>
              <p>1) 先点「启动 Gateway 并自动打开对话网页」，若提示服务缺失会自动安装并重试，启动后浏览器会自动打开对话界面。</p>
              <p>2) 直接在图形化卡片配置 Telegram / 飞书 / QQ / Discord / 钉钉，并先做连通性测试。</p>
              <p>3) 配好后，在对应聊天应用里给机器人发消息即可对话。</p>
              <p className="text-slate-400">
                说明：敏感信息不会在页面回显，避免泄露；请妥善保存凭证。
              </p>
            </div>
            <div className="bg-slate-800/50 rounded-lg p-4 text-sm text-slate-400">
              <p className="font-medium text-slate-300 mb-2">常用命令：</p>
              <code className="block text-emerald-400">openclaw gateway start</code>
              <code className="block text-emerald-400 mt-1">openclaw gateway install</code>
              <code className="block text-emerald-400 mt-1">openclaw gateway stop</code>
              <code className="block text-emerald-400 mt-1">openclaw onboard</code>
            </div>
            <div className="bg-slate-800/50 rounded-lg p-4 text-sm text-slate-400">
              <p className="font-medium text-slate-300 mb-2">开发者快捷（代码方式）</p>
              <code className="block text-emerald-400">$env:OPENCLAW_STATE_DIR="C:/Users/Administrator/.openclaw"</code>
              <code className="block text-emerald-400 mt-1">& "D:\openclow\openclaw.cmd" gateway status</code>
              <code className="block text-emerald-400 mt-1">& "D:\openclow\openclaw.cmd" pairing list telegram</code>
              <code className="block text-emerald-400 mt-1">& "D:\openclow\openclaw.cmd" pairing approve telegram &lt;CODE&gt;</code>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="w-full max-w-[1200px] mx-auto space-y-6">
            <h2 className="text-lg font-semibold">调教中心（小白模式）</h2>

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
                <button
                  onClick={handleExportDiagnosticBundle}
                  disabled={diagnosticLoading}
                  className="px-3 py-1.5 bg-amber-700 hover:bg-amber-600 disabled:opacity-50 rounded text-xs"
                >
                  {diagnosticLoading ? "导出中..." : "一键反馈包"}
                </button>
              </div>
              {selfCheckResult && <pre className="text-xs text-sky-300 whitespace-pre-wrap bg-slate-900/40 rounded p-3 max-h-56 overflow-auto">{selfCheckResult}</pre>}
            </div>
          </div>
        )}
      </main>

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
        {step < STEPS.length - 1 && (
          <button
            onClick={() => setStep(step + 1)}
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

function ChannelCard({
  title,
  channelId,
  configured,
  onClear,
  clearing,
  children,
}: {
  title: string;
  channelId?: "telegram" | "feishu" | "qq" | "discord" | "dingtalk";
  configured?: boolean;
  onClear?: () => void;
  clearing?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-slate-800/60 rounded-lg p-3 border border-slate-700">
      <div className="flex items-center justify-between mb-2">
        <p className="text-slate-200 font-medium">{title}</p>
        {configured && (
          <span className="text-xs text-emerald-400 font-medium">已配置</span>
        )}
      </div>
      {children}
      {configured && channelId && onClear && (
        <button
          onClick={onClear}
          disabled={clearing}
          className="mt-2 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded text-xs text-slate-300"
        >
          {clearing ? "清除中…" : "清除配置"}
        </button>
      )}
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

function MiniLamp({ label, state }: { label: string; state: HealthState }) {
  const color =
    state === "ok"
      ? "bg-emerald-500"
      : state === "warn"
        ? "bg-amber-500"
        : state === "error"
          ? "bg-red-500"
          : "bg-slate-500";
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded border border-slate-700 bg-slate-800 text-slate-300">
      <span className={`inline-block w-2 h-2 rounded-full ${color}`} />
      {label}
    </span>
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
