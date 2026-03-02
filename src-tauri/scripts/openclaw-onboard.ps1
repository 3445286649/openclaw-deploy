param(
  [string]$OpenclawStateDir = "",
  [string]$OpenclawExe = "openclaw",
  [string]$InstallHint = ""
)

$ErrorActionPreference = "Continue"
try { chcp 65001 | Out-Null } catch {}
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Zh([string]$unicodeEscaped) {
  return (ConvertFrom-Json ("`"$unicodeEscaped`""))
}

if ([string]::IsNullOrWhiteSpace($OpenclawStateDir)) {
  $OpenclawStateDir = Join-Path $HOME ".openclaw"
}
$env:OPENCLAW_STATE_DIR = $OpenclawStateDir
New-Item -Path $OpenclawStateDir -ItemType Directory -Force | Out-Null

$script:OpenclawJsonPath = Join-Path $OpenclawStateDir "openclaw.json"
$script:ChannelsPath = Join-Path $OpenclawStateDir "channels.json"
$script:AuthPath = Join-Path $OpenclawStateDir "agents\main\agent\auth-profiles.json"
$script:EnvPath = Join-Path $OpenclawStateDir "env"

$script:SelectedProvider = "kimi"
$script:SelectedBaseUrl = "https://api.moonshot.cn/v1"
$script:SelectedModel = "moonshot-v1-32k"
$script:SelectedApiMode = "openai-completions"
$script:SelectedAuthProvider = "openai"
$script:SelectedApiKey = ""
$script:LastNetworkProfile = "unknown"

function Pause-Step {
  [void](Read-Host (Zh '\u6309\u56de\u8f66\u7ee7\u7eed'))
}

function Write-Header {
  Clear-Host
  Write-Host "========================================"
  Write-Host ("   " + (Zh '\u004f\u0070\u0065\u006e\u0043\u006c\u0061\u0077\u0020\u5c0f\u767d\u4e00\u952e\u90e8\u7f72\u5de5\u5177'))
  Write-Host "========================================"
  Write-Host ((Zh '\u914d\u7f6e\u76ee\u5f55') + ": $OpenclawStateDir")
  Write-Host ((Zh '\u53ef\u6267\u884c\u6587\u4ef6') + ": $OpenclawExe")
  if (-not [string]::IsNullOrWhiteSpace($InstallHint)) {
    Write-Host ((Zh '\u5b89\u88c5\u63d0\u793a') + ": $InstallHint")
  }
  Write-Host ((Zh '\u5f53\u524d\u6a21\u578b') + ": $($script:SelectedProvider) / $($script:SelectedModel)")
  if ($script:LastNetworkProfile -ne "unknown") {
    Write-Host ((Zh '\u7f51\u7edc\u7ed3\u8bba') + ": $($script:LastNetworkProfile)")
  }
  Write-Host "----------------------------------------"
  Write-Host ("[1] " + (Zh '\u68c0\u6d4b\u73af\u5883\u5e76\u81ea\u52a8\u4fee\u590d'))
  Write-Host ("[2] " + (Zh '\u9009\u62e9\u0020\u0041\u0049\u0020\u6a21\u578b\uff08\u0043\u006c\u0061\u0075\u0064\u0065\u002f\u0047\u0050\u0054\u002f\u767e\u70bc\u002f\u0044\u0065\u0065\u0070\u0053\u0065\u0065\u006b\u002f\u004f\u006c\u006c\u0061\u006d\u0061\uff09'))
  Write-Host ("[3] " + (Zh '\u914d\u7f6e\u0020\u0041\u0050\u0049\u0020\u004b\u0065\u0079'))
  Write-Host ("[4] " + (Zh '\u914d\u7f6e\u6d88\u606f\u6e20\u9053\uff08\u0054\u0065\u006c\u0065\u0067\u0072\u0061\u006d\u002f\u98de\u4e66\u002f\u0044\u0069\u0073\u0063\u006f\u0072\u0064\uff09'))
  Write-Host ("[5] " + (Zh '\u4e00\u952e\u90e8\u7f72\u5e76\u542f\u52a8'))
  Write-Host ("[6] " + (Zh '\u67e5\u770b\u72b6\u6001\u0020\u002f\u0020\u91cd\u542f\u0020\u002f\u0020\u505c\u6b62'))
  Write-Host ("[0] " + (Zh '\u9000\u51fa'))
  Write-Host "========================================"
}

function Try-Run([string]$Title, [scriptblock]$Action) {
  Write-Host ""
  Write-Host ("[" + (Zh '\u6267\u884c') + "] $Title") -ForegroundColor Cyan
  try {
    & $Action
  } catch {
    Write-Host ((Zh '\u5931\u8d25') + ": $($_.Exception.Message)") -ForegroundColor Yellow
  }
}

function Read-JsonOrEmpty([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return @{} }
  try {
    $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($raw)) { return @{} }
    return ($raw | ConvertFrom-Json -Depth 64 -AsHashtable)
  } catch {
    return @{}
  }
}

function Save-Json([string]$Path, $Object) {
  $dir = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $dir)) {
    New-Item -Path $dir -ItemType Directory -Force | Out-Null
  }
  $json = $Object | ConvertTo-Json -Depth 64
  [System.IO.File]::WriteAllText($Path, $json, [System.Text.Encoding]::UTF8)
}

function Ensure-Map($map, [string]$key) {
  if (-not $map.ContainsKey($key) -or $null -eq $map[$key] -or ($map[$key] -isnot [hashtable])) {
    $map[$key] = @{}
  }
  return $map[$key]
}

function Ensure-GatewayToken($root) {
  $gateway = Ensure-Map $root "gateway"
  $auth = Ensure-Map $gateway "auth"
  if (-not $auth.ContainsKey("token") -or [string]::IsNullOrWhiteSpace([string]$auth["token"])) {
    $auth["token"] = ("gw_" + ([guid]::NewGuid().ToString("N").Substring(0, 24)))
  }
  $gateway["mode"] = "local"
}

function Test-UrlReachable([string]$url, [int]$timeoutSec = 6) {
  try {
    $resp = Invoke-WebRequest -UseBasicParsing -Method Get -Uri $url -TimeoutSec $timeoutSec
    return [bool]($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 500)
  } catch {
    $msg = "$($_.Exception.Message)".ToLower()
    if ($msg.Contains("401") -or $msg.Contains("403") -or $msg.Contains("404")) {
      return $true
    }
    return $false
  }
}

function Detect-NetworkProfile {
  Write-Host ""
  Write-Host ((Zh '\u7f51\u7edc\u68c0\u6d4b\u4e2d') + "...") -ForegroundColor Cyan
  $openaiOk = Test-UrlReachable "https://api.openai.com/v1/models"
  $anthropicOk = Test-UrlReachable "https://api.anthropic.com/v1/messages"
  $kimiOk = Test-UrlReachable "https://api.moonshot.cn/v1/models"
  $dashscopeOk = Test-UrlReachable "https://dashscope.aliyuncs.com/compatible-mode/v1/models"
  $deepseekOk = Test-UrlReachable "https://api.deepseek.com/v1/models"

  Write-Host ((Zh '\u56fd\u9645\u0020\u0041\u0050\u0049') + ": OpenAI=$openaiOk, Anthropic=$anthropicOk")
  Write-Host ((Zh '\u56fd\u5185\u0020\u0041\u0050\u0049') + ": Kimi=$kimiOk, DashScope=$dashscopeOk, DeepSeek=$deepseekOk")

  if ($openaiOk -or $anthropicOk) { return (Zh '\u56fd\u9645\u53ef\u76f4\u8fde') }
  if ($kimiOk -or $dashscopeOk -or $deepseekOk) { return (Zh '\u5efa\u8bae\u4f18\u5148\u56fd\u5185\u0020\u0041\u0050\u0049') }
  return (Zh '\u5efa\u8bae\u4f7f\u7528\u4ee3\u7406\u002f\u4e2d\u8f6c\u0020\u0041\u0050\u0049')
}

function Select-ModelProfile {
  Write-Host ""
  Write-Host ((Zh '\u9009\u62e9\u6a21\u578b\u63d0\u4f9b\u5546') + ":")
  Write-Host "  1) Claude"
  Write-Host "  2) GPT / OpenAI / Relay"
  Write-Host ("  3) " + (Zh '\u963f\u91cc\u4e91\u767e\u70bc'))
  Write-Host "  4) DeepSeek"
  Write-Host ("  5) Ollama (" + (Zh '\u672c\u5730') + ")")
  Write-Host "  6) Kimi"
  Write-Host ("  7) " + (Zh '\u901a\u4e49\u5343\u95ee'))
  $pick = Read-Host ((Zh '\u8f93\u5165\u7f16\u53f7') + " (default 6)")

  switch ($pick) {
    "1" {
      $script:SelectedProvider = "anthropic"
      $script:SelectedBaseUrl = "https://api.anthropic.com"
      $script:SelectedModel = "claude-3-5-haiku-latest"
      $script:SelectedApiMode = "anthropic"
      $script:SelectedAuthProvider = "anthropic"
    }
    "2" {
      $script:SelectedProvider = "openai"
      $script:SelectedBaseUrl = "https://api.openai.com/v1"
      $script:SelectedModel = "gpt-4o-mini"
      $script:SelectedApiMode = "openai-responses"
      $script:SelectedAuthProvider = "openai"
    }
    "3" {
      $script:SelectedProvider = "bailian"
      $script:SelectedBaseUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1"
      $script:SelectedModel = "qwen-plus"
      $script:SelectedApiMode = "openai-completions"
      $script:SelectedAuthProvider = "dashscope"
    }
    "4" {
      $script:SelectedProvider = "deepseek"
      $script:SelectedBaseUrl = "https://api.deepseek.com/v1"
      $script:SelectedModel = "deepseek-chat"
      $script:SelectedApiMode = "openai-completions"
      $script:SelectedAuthProvider = "deepseek"
    }
    "5" {
      $script:SelectedProvider = "ollama"
      $script:SelectedBaseUrl = "http://127.0.0.1:11434/v1"
      $script:SelectedModel = "llama3.1:8b"
      $script:SelectedApiMode = "openai-completions"
      $script:SelectedAuthProvider = "openai"
    }
    "7" {
      $script:SelectedProvider = "qwen"
      $script:SelectedBaseUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1"
      $script:SelectedModel = "qwen-plus"
      $script:SelectedApiMode = "openai-completions"
      $script:SelectedAuthProvider = "openai"
    }
    default {
      $script:SelectedProvider = "kimi"
      $script:SelectedBaseUrl = "https://api.moonshot.cn/v1"
      $script:SelectedModel = "moonshot-v1-32k"
      $script:SelectedApiMode = "openai-completions"
      $script:SelectedAuthProvider = "openai"
    }
  }

  $b = Read-Host ("Base URL (" + (Zh '\u9ed8\u8ba4') + ": $($script:SelectedBaseUrl))")
  if (-not [string]::IsNullOrWhiteSpace($b)) { $script:SelectedBaseUrl = $b.Trim() }
  $m = Read-Host ((Zh '\u6a21\u578b\u540d') + " (" + (Zh '\u9ed8\u8ba4') + ": $($script:SelectedModel))")
  if (-not [string]::IsNullOrWhiteSpace($m)) { $script:SelectedModel = $m.Trim() }
  Write-Host ((Zh '\u5df2\u9009\u62e9') + ": $($script:SelectedProvider) / $($script:SelectedModel)") -ForegroundColor Green
}

function Save-ModelConfig {
  if ([string]::IsNullOrWhiteSpace($script:SelectedApiKey) -and $script:SelectedProvider -ne "ollama") {
    Write-Host (Zh '\u8bf7\u5148\u5728\u0020\u005b\u0033\u005d\u0020\u914d\u7f6e\u0020\u0041\u0050\u0049\u0020\u004b\u0065\u0079') -ForegroundColor Yellow
    return
  }

  $root = Read-JsonOrEmpty $script:OpenclawJsonPath
  if ($root.Count -eq 0) { $root = @{} }

  $models = Ensure-Map $root "models"
  $providers = Ensure-Map $models "providers"
  $openai = Ensure-Map $providers "openai"
  $openai["baseUrl"] = $script:SelectedBaseUrl
  $openai["api"] = $script:SelectedApiMode
  $openai["models"] = @($script:SelectedModel)
  if (-not [string]::IsNullOrWhiteSpace($script:SelectedApiKey)) {
    $openai["apiKey"] = $script:SelectedApiKey
  }

  if ($script:SelectedProvider -eq "anthropic") {
    $anthropic = Ensure-Map $providers "anthropic"
    $anthropic["baseUrl"] = $script:SelectedBaseUrl
    $anthropic["models"] = @($script:SelectedModel)
    if (-not [string]::IsNullOrWhiteSpace($script:SelectedApiKey)) {
      $anthropic["apiKey"] = $script:SelectedApiKey
    }
  }

  $agents = Ensure-Map $root "agents"
  $defaults = Ensure-Map $agents "defaults"
  $modelMap = Ensure-Map $defaults "model"
  if ($script:SelectedProvider -eq "anthropic") {
    $modelMap["primary"] = "anthropic/$($script:SelectedModel)"
  } else {
    $modelMap["primary"] = "openai/$($script:SelectedModel)"
  }

  Ensure-GatewayToken $root
  Save-Json $script:OpenclawJsonPath $root

  $authRoot = Read-JsonOrEmpty $script:AuthPath
  if ($authRoot.Count -eq 0) { $authRoot = @{} }
  if (-not $authRoot.ContainsKey("version")) { $authRoot["version"] = 1 }
  $profiles = Ensure-Map $authRoot "profiles"
  if (-not [string]::IsNullOrWhiteSpace($script:SelectedApiKey)) {
    $profiles["$($script:SelectedAuthProvider):default"] = @{
      type = "api_key"
      provider = $script:SelectedAuthProvider
      key = $script:SelectedApiKey
    }
  }
  Save-Json $script:AuthPath $authRoot

  if ($script:SelectedProvider -eq "anthropic") {
    $envContent = @(
      "# OpenClaw environment"
      "export ANTHROPIC_BASE_URL=$($script:SelectedBaseUrl)"
      "export ANTHROPIC_API_KEY=$($script:SelectedApiKey)"
      ""
    ) -join "`n"
  } else {
    $envContent = @(
      "# OpenClaw environment"
      "export OPENAI_BASE_URL=$($script:SelectedBaseUrl)"
      "export OPENAI_API_KEY=$($script:SelectedApiKey)"
      ""
    ) -join "`n"
  }
  [System.IO.File]::WriteAllText($script:EnvPath, $envContent, [System.Text.Encoding]::UTF8)

  Write-Host ((Zh '\u5df2\u5199\u5165\u6a21\u578b\u914d\u7f6e') + ":") -ForegroundColor Green
  Write-Host "  $script:OpenclawJsonPath"
  Write-Host "  $script:AuthPath"
  Write-Host "  $script:EnvPath"
}

function Configure-Channels {
  $channelsRoot = Read-JsonOrEmpty $script:ChannelsPath
  if ($channelsRoot.Count -eq 0) { $channelsRoot = @{} }

  $tg = Read-Host ("Telegram Bot Token (" + (Zh '\u53ef\u7559\u7a7a') + ")")
  if (-not [string]::IsNullOrWhiteSpace($tg)) {
    $channelsRoot["telegram"] = @{
      enabled = $true
      dmPolicy = "open"
      allowFrom = @("*")
      botToken = $tg.Trim()
    }
    $root = Read-JsonOrEmpty $script:OpenclawJsonPath
    if ($root.Count -eq 0) { $root = @{} }
    $channels = Ensure-Map $root "channels"
    $channels["telegram"] = @{
      enabled = $true
      dmPolicy = "open"
      allowFrom = @("*")
      botToken = $tg.Trim()
    }
    Save-Json $script:OpenclawJsonPath $root
  }

  $fsAppId = Read-Host ((Zh '\u98de\u4e66') + " App ID (" + (Zh '\u53ef\u7559\u7a7a') + ")")
  $fsAppSecret = Read-Host ((Zh '\u98de\u4e66') + " App Secret (" + (Zh '\u53ef\u7559\u7a7a') + ")")
  if (-not [string]::IsNullOrWhiteSpace($fsAppId) -and -not [string]::IsNullOrWhiteSpace($fsAppSecret)) {
    $channelsRoot["feishu"] = @{
      appId = $fsAppId.Trim()
      appSecret = $fsAppSecret.Trim()
    }
  }

  $dcToken = Read-Host ("Discord Bot Token (" + (Zh '\u53ef\u7559\u7a7a') + ")")
  if (-not [string]::IsNullOrWhiteSpace($dcToken)) {
    $channelsRoot["discord"] = @{
      enabled = $true
      botToken = $dcToken.Trim()
    }
  }

  Save-Json $script:ChannelsPath $channelsRoot
  Write-Host ((Zh '\u5df2\u4fdd\u5b58\u6e20\u9053\u914d\u7f6e') + ": $script:ChannelsPath") -ForegroundColor Green
}

function Check-And-AutoFix {
  Write-Host ""
  Write-Host ((Zh '\u5f00\u59cb\u73af\u5883\u68c0\u6d4b\u4e0e\u4fee\u590d') + "...") -ForegroundColor Cyan

  Try-Run "node --version" { node --version }
  Try-Run "npm --version" { npm --version }

  $openclawOk = $true
  try {
    & $OpenclawExe --version | Out-Null
  } catch {
    $openclawOk = $false
  }

  if (-not $openclawOk) {
    Write-Host ((Zh '\u672a\u68c0\u6d4b\u5230\u0020\u006f\u0070\u0065\u006e\u0063\u006c\u0061\u0077\uff0c\u5c1d\u8bd5\u81ea\u52a8\u5b89\u88c5') + "...") -ForegroundColor Yellow
    if (-not [string]::IsNullOrWhiteSpace($InstallHint)) {
      Try-Run "npm install -g openclaw --prefix $InstallHint" { npm install -g openclaw --prefix $InstallHint }
    } else {
      Try-Run "npm install -g openclaw" { npm install -g openclaw }
    }
  } else {
    Try-Run "openclaw --version" { & $OpenclawExe --version }
  }

  $script:LastNetworkProfile = Detect-NetworkProfile
  Write-Host ((Zh '\u7f51\u7edc\u7ed3\u8bba') + ": $($script:LastNetworkProfile)") -ForegroundColor Green
}

function Deploy-And-Start {
  Save-ModelConfig
  Try-Run "openclaw gateway install" { & $OpenclawExe gateway install }
  Try-Run "openclaw gateway start" { & $OpenclawExe gateway start }
  Try-Run "openclaw gateway status" { & $OpenclawExe gateway status }
}

function Service-Menu {
  while ($true) {
    Write-Host ""
    Write-Host ((Zh '\u670d\u52a1\u7ba1\u7406') + ":") -ForegroundColor Cyan
    Write-Host ("  1) " + (Zh '\u72b6\u6001'))
    Write-Host ("  2) " + (Zh '\u91cd\u542f'))
    Write-Host ("  3) " + (Zh '\u505c\u6b62'))
    Write-Host ("  0) " + (Zh '\u8fd4\u56de'))
    $s = Read-Host (Zh '\u8bf7\u9009\u62e9')
    switch ($s) {
      "1" { Try-Run "openclaw gateway status" { & $OpenclawExe gateway status }; Pause-Step }
      "2" {
        Try-Run "openclaw gateway stop" { & $OpenclawExe gateway stop }
        Try-Run "openclaw gateway start" { & $OpenclawExe gateway start }
        Try-Run "openclaw gateway status" { & $OpenclawExe gateway status }
        Pause-Step
      }
      "3" { Try-Run "openclaw gateway stop" { & $OpenclawExe gateway stop }; Pause-Step }
      "0" { return }
      default { Write-Host (Zh '\u65e0\u6548\u8f93\u5165') -ForegroundColor Yellow }
    }
  }
}

while ($true) {
  Write-Header
  $choice = Read-Host (Zh '\u8bf7\u8f93\u5165\u83dc\u5355\u7f16\u53f7')
  switch ($choice) {
    "1" { Check-And-AutoFix; Pause-Step }
    "2" { Select-ModelProfile; Pause-Step }
    "3" {
      $k = Read-Host ((Zh '\u8bf7\u8f93\u5165\u0020\u0041\u0050\u0049\u0020\u004b\u0065\u0079') + " (Ollama " + (Zh '\u53ef\u7559\u7a7a') + ")")
      $script:SelectedApiKey = $k.Trim()
      Save-ModelConfig
      Pause-Step
    }
    "4" { Configure-Channels; Pause-Step }
    "5" { Deploy-And-Start; Pause-Step }
    "6" { Service-Menu }
    "0" {
      Write-Host ((Zh '\u5df2\u9000\u51fa') + ".")
      break
    }
    default {
      Write-Host ((Zh '\u65e0\u6548\u8f93\u5165\uff0c\u8bf7\u91cd\u8bd5') + ".") -ForegroundColor Yellow
      Start-Sleep -Milliseconds 800
    }
  }
}
