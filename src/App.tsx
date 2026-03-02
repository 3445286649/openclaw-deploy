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
];

function App() {
  const [step, setStep] = useState(0);
  const [nodeCheck, setNodeCheck] = useState<EnvCheckResult | null>(null);
  const [npmCheck, setNpmCheck] = useState<EnvCheckResult | null>(null);
  const [openclawCheck, setOpenclawCheck] = useState<EnvCheckResult | null>(null);
  const [checking, setChecking] = useState(true);

  const [installing, setInstalling] = useState(false);
  const [installResult, setInstallResult] = useState<string | null>(null);
  const [installLog, setInstallLog] = useState<string[]>([]);
  const [installSteps, setInstallSteps] = useState<InstallStepItem[]>(INSTALL_STEPS);
  const logEndRef = useRef<HTMLPreElement>(null);
  const installLogBufferRef = useRef<string[]>([]);
  const installLogFlushTimerRef = useRef<number | null>(null);

  const [provider, setProvider] = useState("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [proxyUrl, setProxyUrl] = useState("");
  const [noProxy, setNoProxy] = useState("");
  const [customConfigPath, setCustomConfigPath] = useState("");
  const [customInstallPath, setCustomInstallPath] = useState("");
  const [recommendedInstallDir, setRecommendedInstallDir] = useState("");
  const [lastInstallDir, setLastInstallDir] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<string | null>(null);
  const [modelTesting, setModelTesting] = useState(false);
  const [modelTestResult, setModelTestResult] = useState<string | null>(null);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [modelsLoading, setModelsLoading] = useState(false);
  const [runtimeModelInfo, setRuntimeModelInfo] = useState<RuntimeModelInfo | null>(null);
  const [keySyncStatus, setKeySyncStatus] = useState<KeySyncStatus | null>(null);
  const [runtimeProbeResult, setRuntimeProbeResult] = useState<string | null>(null);
  const [runtimeProbeLoading, setRuntimeProbeLoading] = useState(false);

  const [starting, setStarting] = useState(false);
  const [startResult, setStartResult] = useState<string | null>(null);
  const [dashboardOpening, setDashboardOpening] = useState(false);
  const [telegramConfig, setTelegramConfig] = useState<ChannelConfig>({});
  const [feishuConfig, setFeishuConfig] = useState<ChannelConfig>({});
  const [qqConfig, setQqConfig] = useState<ChannelConfig>({});
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
  const [autoRefreshHealth, setAutoRefreshHealth] = useState(false);
  const [savedAiHint, setSavedAiHint] = useState<string | null>(null);
  const [localInfo, setLocalInfo] = useState<LocalOpenclawInfo | null>(null);
  const [exeCheckInfo, setExeCheckInfo] = useState<ExecutableCheckInfo | null>(null);
  const [uninstalling, setUninstalling] = useState(false);

  const [fixing, setFixing] = useState<"node" | "npm" | "openclaw" | null>(null);
  const [fixResult, setFixResult] = useState<string | null>(null);
  const loadedStepDataRef = useRef<{ install: boolean; model: boolean; channel: boolean }>({
    install: false,
    model: false,
    channel: false,
  });
  const configReloadTimerRef = useRef<number | null>(null);

  useEffect(() => {
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
    }
    runEnvCheck(savedInstall || undefined);
  }, []);

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
      void loadSavedChannels(cfgPath);
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
    setAvailableModels([]);
    setSelectedModel("");
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

  const runEnvCheck = async (installHint?: string) => {
    setChecking(true);
    try {
      const openclawHint =
        installHint?.trim() ||
        lastInstallDir.trim() ||
        customInstallPath.trim() ||
        undefined;
      const [node, npm, openclaw] = await Promise.all([
        invoke<EnvCheckResult>("check_node"),
        invoke<EnvCheckResult>("check_npm"),
        invoke<EnvCheckResult>("check_openclaw", { installHint: openclawHint }),
      ]);
      setNodeCheck(node);
      setNpmCheck(npm);
      setOpenclawCheck(openclaw);
    } catch (e) {
      setNodeCheck({ ok: false, message: `检测失败: ${e}` });
      setNpmCheck({ ok: false, message: "检测失败" });
      setOpenclawCheck({ ok: false, message: "检测失败" });
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
      if (raw) setSelectedModel(raw);
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

  const fetchAvailableModels = async (cfgPath?: string) => {
    setModelsLoading(true);
    try {
      const models = await invoke<string[]>("discover_available_models", {
        provider,
        baseUrl: baseUrl.trim() || undefined,
        apiKey: apiKey.trim() || undefined,
        customPath: normalizeConfigPath(cfgPath || customConfigPath) || undefined,
      });
      setAvailableModels(models);
      setSelectedModel((prev) => (prev && models.includes(prev) ? prev : models[0] || ""));
      return models;
    } finally {
      setModelsLoading(false);
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
      const [tg, fs, qq] = await Promise.all([
        invoke<ChannelConfig>("read_channel_config", { channel: "telegram", customPath }),
        invoke<ChannelConfig>("read_channel_config", { channel: "feishu", customPath }),
        invoke<ChannelConfig>("read_channel_config", { channel: "qq", customPath }),
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
      await invoke<string>("test_model_connection", {
        provider,
        baseUrl: baseUrl.trim() || undefined,
        apiKey: apiKey.trim(),
        customPath: normalizeConfigPath(customConfigPath) || undefined,
      });
      const result = await invoke<string>("write_env_config", {
        apiKey: apiKey.trim() || undefined,
        provider,
        baseUrl: baseUrl.trim() || undefined,
        selectedModel: selectedModel.trim() || undefined,
        resetSessions: shouldResetSessions,
        proxyUrl: proxyUrl.trim() || undefined,
        noProxy: noProxy.trim() || undefined,
        customPath: normalizeConfigPath(customConfigPath) || undefined,
      });
      setSaveResult(result);
      setModelTestResult("保存前检测通过");
      await loadSavedAiConfig();
      await loadRuntimeModelInfo();
      await loadKeySyncStatus();
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
      let nextMsg = result;
      try {
        const models = await fetchAvailableModels();
        if (models.length > 0) {
          nextMsg = `${result}；已自动筛选到 ${models.length} 个可用模型，请选择后保存`;
        }
      } catch (e) {
        nextMsg = `${result}；模型列表拉取失败：${e}`;
      }
      setModelTestResult(nextMsg);
      await loadRuntimeModelInfo();
    } catch (e) {
      setModelTestResult(`检测失败: ${e}`);
    } finally {
      setModelTesting(false);
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
    channel: "telegram" | "feishu" | "qq",
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
    channel: "telegram" | "feishu" | "qq",
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

  const refreshAllChannelHealth = async () => {
    if (starting) return;
    const gatewayState = await getGatewayHealthState();
    await Promise.all([
      refreshTelegramHealth(gatewayState),
      refreshFeishuHealth(gatewayState),
      refreshQqHealth(gatewayState),
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

  const handleFix = async (type: "node" | "npm" | "openclaw") => {
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
    const installHint = (localInfo?.install_dir || customInstallPath || lastInstallDir || "").trim() || undefined;
    try {
      const result = await invoke<string>("start_gateway", {
        customPath: normalizeConfigPath(customConfigPath) || undefined,
        installHint,
      });
      setStartResult(stripAnsi(result));
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
    setDashboardOpening(true);
    try {
      const customPath = normalizeConfigPath(customConfigPath) || undefined;
      const installHint = (localInfo?.install_dir || customInstallPath || lastInstallDir || "").trim() || undefined;
      await invoke<string>("start_gateway", { customPath, installHint });
      const token = await invoke<string>("get_gateway_auth_token", { customPath });
      const url = `http://127.0.0.1:18789/?token=${encodeURIComponent(token)}`;
      try {
        await navigator.clipboard.writeText(token);
      } catch {
        // ignore clipboard failures; URL already contains token
      }
      try {
        await invoke<string>("open_external_url", { url });
        setStartResult("已打开对话界面并附带网关 token；若页面仍提示未授权，请在 Control UI 设置里粘贴刚复制的 token。");
      } catch (openErr) {
        setStartResult(`已启动 Gateway，但自动打开浏览器失败。\n请手动访问：${url}\n错误：${openErr}`);
      }
    } catch (e) {
      setStartResult(`打开对话界面失败: ${e}`);
    } finally {
      setDashboardOpening(false);
    }
  };

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

      {/* Content */}
      <main className="flex-1 p-6 overflow-auto">
        {/* Step 0: 环境检测 */}
        {step === 0 && (
          <div className="max-w-2xl space-y-6">
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
          <div className="max-w-2xl space-y-6">
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
          <div className="max-w-2xl space-y-6">
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
                    setProvider(next);
                    if (!baseUrl.trim()) {
                      if (next === "kimi") setBaseUrl("https://api.moonshot.cn/v1");
                      if (next === "qwen") setBaseUrl("https://dashscope.aliyuncs.com/compatible-mode/v1");
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
                  placeholder="sk-xxx 或 你的 API Key"
                  className="w-full bg-slate-800 border border-slate-600 rounded-lg px-4 py-2"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">
                  可用模型 <span className="text-slate-500">(检测后自动拉取)</span>
                </label>
                <div className="flex gap-2">
                  <select
                    value={selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-600 rounded-lg px-4 py-2"
                    disabled={modelsLoading || availableModels.length === 0}
                  >
                    {availableModels.length === 0 ? (
                      <option value="">请先点击“模型连通性检测”拉取模型</option>
                    ) : (
                      availableModels.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))
                    )}
                  </select>
                  <button
                    onClick={() => fetchAvailableModels()}
                    disabled={modelsLoading}
                    className="px-3 py-2 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-sm whitespace-nowrap"
                  >
                    {modelsLoading ? "拉取中..." : "刷新模型"}
                  </button>
                </div>
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
                  placeholder="https://your-api-proxy.com/v1"
                  className="w-full bg-slate-800 border border-slate-600 rounded-lg px-4 py-2"
                />
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
                <input
                  type="text"
                  value={customConfigPath}
                  onChange={(e) => setCustomConfigPath(e.target.value)}
                  placeholder="留空使用 ~/.openclaw，如 D:\\openclaw-config"
                  className="w-full bg-slate-800 border border-slate-600 rounded-lg px-4 py-2"
                />
                <p className="text-slate-500 text-xs mt-1">
                  配置、凭证、会话数据将存储在此目录
                </p>
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
                  disabled={saving || modelTesting}
                  className="flex items-center gap-2 px-6 py-3 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg font-medium"
                >
                  {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Key className="w-5 h-5" />}
                  保存配置
                </button>
                <button
                  onClick={handleTestModel}
                  disabled={modelTesting}
                  className="flex items-center gap-2 px-6 py-3 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded-lg font-medium"
                >
                  {modelTesting ? <Loader2 className="w-5 h-5 animate-spin" /> : <Wrench className="w-5 h-5" />}
                  模型连通性检测
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
          <div className="max-w-2xl space-y-6">
            <h2 className="text-lg font-semibold">启动服务</h2>
            {customConfigPath && (
              <div className="bg-slate-800/50 rounded-lg p-3 text-sm text-slate-400">
                配置路径: {normalizeConfigPath(customConfigPath)}
              </div>
            )}
            {exeCheckInfo && (
              <div className="bg-slate-800/50 rounded-lg p-3 text-xs space-y-1">
                <p className={exeCheckInfo.exists ? "text-emerald-300" : "text-amber-300"}>
                  可执行路径检测：{exeCheckInfo.exists ? "已找到" : "未找到"}
                </p>
                <p className="text-slate-300">当前路径：{exeCheckInfo.executable || "未解析到 openclaw.cmd"}</p>
                <p className="text-slate-400">来源：{exeCheckInfo.source}</p>
                <p className="text-slate-400">{exeCheckInfo.detail}</p>
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
                  启动 Gateway
                </>
              )}
            </button>
            <button
              onClick={handleOpenDashboard}
              disabled={dashboardOpening}
              className="flex items-center gap-2 px-6 py-3 bg-sky-700 hover:bg-sky-600 disabled:opacity-50 rounded-lg font-medium"
            >
              {dashboardOpening ? <Loader2 className="w-5 h-5 animate-spin" /> : <ExternalLink className="w-5 h-5" />}
              {dashboardOpening ? "打开中..." : "一键打开 OpenClaw 对话界面"}
            </button>
            {startResult && (
              <pre className="bg-slate-800 rounded-lg p-4 text-sm overflow-auto max-h-40">
                {startResult}
              </pre>
            )}
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
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <ChannelCard
                  title="Telegram"
                  children={
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
                  }
                />
                <ChannelCard
                  title="飞书"
                  children={
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
                  }
                />
                <ChannelCard
                  title="QQ"
                  children={
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
                  }
                />
              </div>
              {channelResult && (
                <pre className="bg-slate-800 rounded-lg p-3 text-sm overflow-auto max-h-32">
                  {channelResult}
                </pre>
              )}
            </div>
            <div className="bg-slate-800/50 rounded-lg p-4 text-sm text-slate-300 space-y-2">
              <p className="font-medium text-slate-200">后续如何交互（推荐顺序）</p>
              <p>1) 先点「启动 Gateway」，若提示服务缺失会自动安装并重试。</p>
              <p>2) 直接在图形化卡片配置 Telegram / 飞书 / QQ，并先做连通性测试。</p>
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
      </main>

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

function ChannelCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-slate-800/60 rounded-lg p-3 border border-slate-700">
      <p className="text-slate-200 font-medium mb-2">{title}</p>
      {children}
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
}: {
  result: EnvCheckResult;
  type: "node" | "npm" | "openclaw";
  onFix: (type: "node" | "npm" | "openclaw") => void;
  fixing: "node" | "npm" | "openclaw" | null;
}) {
  const fixLabel = type === "openclaw" ? "去安装页" : "修复";
  const isFixing = fixing === type;

  return (
    <div
      className={`flex items-start gap-3 p-4 rounded-lg border ${
        result.ok ? "bg-emerald-900/20 border-emerald-800" : "bg-red-900/20 border-red-800"
      }`}
    >
      {result.ok ? (
        <CheckCircle2 className="w-6 h-6 text-emerald-500 flex-shrink-0 mt-0.5" />
      ) : (
        <XCircle className="w-6 h-6 text-red-500 flex-shrink-0 mt-0.5" />
      )}
      <div className="flex-1 min-w-0">
        <p className={result.ok ? "text-emerald-200" : "text-red-200"}>{result.message}</p>
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
