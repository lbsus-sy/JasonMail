[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$script:ProjectRoot = Split-Path -Parent $PSScriptRoot
$script:ConfigPath = Join-Path $script:ProjectRoot 'wrangler.jsonc'
$script:NpmCommand = $null
$script:NpxCommand = $null

function Write-Heading {
    param([string]$Text)
    Write-Host ''
    Write-Host ('=' * 68) -ForegroundColor DarkCyan
    Write-Host $Text -ForegroundColor Cyan
    Write-Host ('=' * 68) -ForegroundColor DarkCyan
}

function Invoke-ExternalCommand {
    param(
        [Parameter(Mandatory = $true)][string]$FileName,
        [string[]]$Arguments = @(),
        [Parameter(Mandatory = $true)][string]$DisplayName,
        [switch]$AllowFailure,
        [switch]$SuppressOutput,
        [string]$InputText
    )

    Write-Host $DisplayName -ForegroundColor Gray
    if ($PSBoundParameters.ContainsKey('InputText')) {
        $lines = @($InputText | & $FileName @Arguments 2>&1)
    } else {
        $lines = @(& $FileName @Arguments 2>&1)
    }
    $exitCode = $LASTEXITCODE
    if ($null -eq $exitCode) {
        $exitCode = 0
    }
    $output = ($lines | ForEach-Object { [string]$_ }) -join [Environment]::NewLine

    if (-not $SuppressOutput) {
        foreach ($line in $lines) {
            Write-Host ([string]$line)
        }
    }
    if ($exitCode -ne 0 -and -not $AllowFailure) {
        throw "$DisplayName failed with exit code $exitCode."
    }

    return [pscustomobject]@{
        ExitCode = [int]$exitCode
        Output = $output
    }
}

function Invoke-Wrangler {
    param(
        [string[]]$Arguments,
        [switch]$AllowFailure,
        [switch]$SuppressOutput
    )
    $allArguments = @('wrangler') + $Arguments
    return Invoke-ExternalCommand -FileName $script:NpxCommand -Arguments $allArguments -DisplayName ('Cloudflare: ' + ($Arguments -join ' ')) -AllowFailure:$AllowFailure -SuppressOutput:$SuppressOutput
}

function Invoke-Npm {
    param([string[]]$Arguments, [string]$DisplayName)
    return Invoke-ExternalCommand -FileName $script:NpmCommand -Arguments $Arguments -DisplayName $DisplayName
}

function Update-ProcessPath {
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $combined = New-Object System.Collections.Generic.List[string]
    $seen = @{}
    foreach ($candidate in @($machinePath, $userPath, $env:Path)) {
        foreach ($part in ([string]$candidate -split ';')) {
            $trimmed = $part.Trim()
            if ($trimmed -and -not $seen.ContainsKey($trimmed.ToLowerInvariant())) {
                $seen[$trimmed.ToLowerInvariant()] = $true
                $combined.Add($trimmed)
            }
        }
    }
    $env:Path = $combined -join ';'
}

function Get-NodeVersion {
    $node = Get-Command 'node.exe' -ErrorAction SilentlyContinue
    if (-not $node) {
        return $null
    }
    $result = Invoke-ExternalCommand -FileName $node.Source -Arguments @('--version') -DisplayName 'Checking Node.js' -AllowFailure -SuppressOutput
    if ($result.ExitCode -ne 0) {
        return $null
    }
    $versionText = $result.Output.Trim() -replace '^v', ''
    try {
        return [version]$versionText
    } catch {
        return $null
    }
}

function Install-OrUpdateNode {
    $downloadUrl = 'https://nodejs.org/en/download'
    $node = Get-Command 'node.exe' -ErrorAction SilentlyContinue
    $winget = Get-Command 'winget.exe' -ErrorAction SilentlyContinue

    if ($winget) {
        if ($node) {
            $action = 'upgrade'
        } else {
            $action = 'install'
        }
        Write-Host 'Node.js 22 或更新版本是必要條件。接下來會使用 winget 安裝或更新 Node.js LTS。'
        $result = Invoke-ExternalCommand -FileName $winget.Source -Arguments @(
            $action, '--id', 'OpenJS.NodeJS.LTS', '--exact',
            '--accept-package-agreements', '--accept-source-agreements'
        ) -DisplayName 'Installing Node.js LTS' -AllowFailure
        if ($result.ExitCode -ne 0) {
            Write-Host 'winget 無法完成安裝。請在瀏覽器安裝 Node.js LTS，完成後按 Enter 繼續。'
            Start-Process $downloadUrl
            Read-Host '安裝完成後按 Enter'
        }
    } else {
        Write-Host '找不到 winget。將開啟 Node.js 官方下載頁；安裝 Node.js LTS 後按 Enter 繼續。'
        Start-Process $downloadUrl
        Read-Host '安裝完成後按 Enter'
    }

    Update-ProcessPath
    $version = Get-NodeVersion
    if (-not $version -or $version.Major -lt 22) {
        throw "需要 Node.js 22 或更新版本。請從 $downloadUrl 安裝，然後重新執行 install.cmd。"
    }
    Write-Host "Node.js $version 已就緒。" -ForegroundColor Green
}

function Ensure-Prerequisites {
    if ($env:OS -ne 'Windows_NT') {
        throw '此安裝器目前只支援 Windows。'
    }

    Install-OrUpdateNode

    $npm = Get-Command 'npm.cmd' -ErrorAction SilentlyContinue
    $npx = Get-Command 'npx.cmd' -ErrorAction SilentlyContinue
    if (-not $npm -or -not $npx) {
        throw '找不到 npm.cmd 或 npx.cmd。請重新安裝 Node.js LTS，然後重新執行 install.cmd。'
    }

    $script:NpmCommand = $npm.Source
    $script:NpxCommand = $npx.Source
    $null = Invoke-ExternalCommand -FileName $script:NpmCommand -Arguments @('--version') -DisplayName 'Checking npm'
}

function Read-SecretText {
    param([Parameter(Mandatory = $true)][string]$Prompt)

    $secureValue = Read-Host -Prompt $Prompt -AsSecureString
    if ($null -eq $secureValue -or $secureValue.Length -eq 0) {
        return ''
    }

    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        $secureValue.Dispose()
    }
}

function Get-PropertyValue {
    param($Object, [string]$Name)

    if ($null -eq $Object) {
        return $null
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($property) {
        return $property.Value
    }
    return $null
}

function Set-PropertyValue {
    param($Object, [string]$Name, $Value)

    $property = $Object.PSObject.Properties[$Name]
    if ($property) {
        $property.Value = $Value
    } else {
        $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
    }
}

function Read-WranglerConfig {
    if (-not (Test-Path -LiteralPath $script:ConfigPath)) {
        throw "找不到 wrangler.jsonc：$script:ConfigPath"
    }
    $raw = [IO.File]::ReadAllText($script:ConfigPath, [Text.Encoding]::UTF8)
    try {
        return ConvertFrom-Json -InputObject $raw -ErrorAction Stop
    } catch {
        throw 'wrangler.jsonc 不是有效 JSON。請先修復設定檔語法，再重新執行安裝器。'
    }
}

function Save-WranglerConfig {
    param($Config)
    $json = ConvertTo-Json -InputObject $Config -Depth 100
    [IO.File]::WriteAllText($script:ConfigPath, $json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
}

function Get-OrCreateBindingEntry {
    param(
        $Config,
        [string]$ArrayName,
        [string]$BindingName,
        [hashtable]$Defaults
    )

    $rawEntries = Get-PropertyValue $Config $ArrayName
    $entries = @()
    if ($null -ne $rawEntries) {
        $entries = @($rawEntries)
    }

    if ($entries.Count -eq 0) {
        $entry = [pscustomobject]$Defaults
        $entries = @($entry)
    } else {
        $matching = @($entries | Where-Object { (Get-PropertyValue $_ 'binding') -eq $BindingName })
        if ($matching.Count -gt 1) {
            throw "wrangler.jsonc 有多個 $BindingName 綁定，請先移除重複項目。"
        }
        if ($matching.Count -eq 1) {
            $entry = $matching[0]
        } elseif ($entries.Count -eq 1) {
            $entry = $entries[0]
        } else {
            throw "找不到唯一的 $BindingName 綁定。請先檢查 wrangler.jsonc。"
        }
    }

    Set-PropertyValue $entry 'binding' $BindingName
    Set-PropertyValue $Config $ArrayName ([object[]]$entries)
    return $entry
}

function Test-PlaceholderId {
    param([string]$Id)
    return [string]::IsNullOrWhiteSpace($Id) -or $Id -match '^(REPLACE_WITH_|YOUR_|<.*>|placeholder)'
}

function Get-JsonItems {
    param([string]$JsonText, [string]$Description)

    try {
        $parsed = @(ConvertFrom-Json -InputObject $JsonText -ErrorAction Stop)
    } catch {
        throw "無法讀取 Cloudflare $Description 清單的 JSON 輸出。請重新登入 Cloudflare 後重跑安裝器。"
    }

    if ($parsed.Count -eq 1) {
        foreach ($name in @('result', 'results', 'data', 'items')) {
            $nested = Get-PropertyValue $parsed[0] $name
            if ($null -ne $nested) {
                return @($nested)
            }
        }
    }
    return $parsed
}

function Find-RemoteD1Id {
    param([string]$DatabaseName)

    $result = Invoke-Wrangler -Arguments @('d1', 'list', '--json') -SuppressOutput
    $items = Get-JsonItems -JsonText $result.Output -Description 'D1'
    $matches = @()
    foreach ($item in $items) {
        $name = Get-PropertyValue $item 'name'
        if (-not $name) { $name = Get-PropertyValue $item 'database_name' }
        if ($name -eq $DatabaseName) {
            $id = Get-PropertyValue $item 'uuid'
            if (-not $id) { $id = Get-PropertyValue $item 'id' }
            if (-not $id) { $id = Get-PropertyValue $item 'database_id' }
            if ($id) {
                $matches += [string]$id
            }
        }
    }
    if ($matches.Count -gt 1) {
        throw "Cloudflare 帳戶有多個名稱為 $DatabaseName 的 D1 資料庫，請先確認 wrangler.jsonc。"
    }
    if ($matches.Count -eq 1) {
        return $matches[0]
    }
    return $null
}

function Find-RemoteKvId {
    param([string]$NamespaceTitle)

    $result = Invoke-Wrangler -Arguments @('kv', 'namespace', 'list') -SuppressOutput
    $items = Get-JsonItems -JsonText $result.Output -Description 'KV'
    $matches = @()
    foreach ($item in $items) {
        $title = Get-PropertyValue $item 'title'
        if ($title -eq $NamespaceTitle) {
            $id = Get-PropertyValue $item 'id'
            if ($id) {
                $matches += [string]$id
            }
        }
    }
    if ($matches.Count -gt 1) {
        throw "Cloudflare 帳戶有多個名稱為 $NamespaceTitle 的 KV 命名空間，請先確認設定。"
    }
    if ($matches.Count -eq 1) {
        return $matches[0]
    }
    return $null
}

function Ensure-CloudflareResources {
    Write-Heading 'Cloudflare 資料服務設定'

    $config = Read-WranglerConfig
    $d1 = Get-OrCreateBindingEntry -Config $config -ArrayName 'd1_databases' -BindingName 'DB' -Defaults @{
        binding = 'DB'
        database_name = 'jasonmail'
        database_id = 'REPLACE_WITH_D1_DATABASE_ID'
        migrations_dir = 'migrations'
    }
    $kv = Get-OrCreateBindingEntry -Config $config -ArrayName 'kv_namespaces' -BindingName 'FILES' -Defaults @{
        binding = 'FILES'
        id = 'REPLACE_WITH_KV_NAMESPACE_ID'
    }
    if (-not (Get-PropertyValue $d1 'database_name')) {
        Set-PropertyValue $d1 'database_name' 'jasonmail'
    }
    if (-not (Get-PropertyValue $d1 'migrations_dir')) {
        Set-PropertyValue $d1 'migrations_dir' 'migrations'
    }
    Save-WranglerConfig $config

    $databaseName = [string](Get-PropertyValue $d1 'database_name')
    $databaseId = [string](Get-PropertyValue $d1 'database_id')
    if (Test-PlaceholderId $databaseId) {
        Write-Host "正在尋找現有的 D1 資料庫：$databaseName"
        $existingId = Find-RemoteD1Id -DatabaseName $databaseName
        if ($existingId) {
            Set-PropertyValue $d1 'database_id' $existingId
            Save-WranglerConfig $config
            Write-Host '已將現有 D1 資料庫連到 Jason Mail。' -ForegroundColor Green
        } else {
            $null = Invoke-Wrangler -Arguments @(
                'd1', 'create', $databaseName, '--binding', 'DB', '--update-config'
            )
            $config = Read-WranglerConfig
            $d1 = Get-OrCreateBindingEntry -Config $config -ArrayName 'd1_databases' -BindingName 'DB' -Defaults @{}
            if (Test-PlaceholderId ([string](Get-PropertyValue $d1 'database_id'))) {
                throw 'D1 建立完成但 wrangler.jsonc 沒有取得資料庫 ID。請保留 Cloudflare 資源，檢查設定後重跑。'
            }
            Write-Host 'D1 資料庫已建立並寫入設定。' -ForegroundColor Green
        }
    }

    $config = Read-WranglerConfig
    $kv = Get-OrCreateBindingEntry -Config $config -ArrayName 'kv_namespaces' -BindingName 'FILES' -Defaults @{}
    $kvId = [string](Get-PropertyValue $kv 'id')
    if (Test-PlaceholderId $kvId) {
        Write-Host '正在尋找現有的 FILES KV 命名空間。'
        $existingId = Find-RemoteKvId -NamespaceTitle 'FILES'
        if ($existingId) {
            Set-PropertyValue $kv 'id' $existingId
            Save-WranglerConfig $config
            Write-Host '已將現有 KV 命名空間連到 Jason Mail。' -ForegroundColor Green
        } else {
            $null = Invoke-Wrangler -Arguments @(
                'kv', 'namespace', 'create', 'FILES', '--binding', 'FILES', '--update-config'
            )
            $config = Read-WranglerConfig
            $kv = Get-OrCreateBindingEntry -Config $config -ArrayName 'kv_namespaces' -BindingName 'FILES' -Defaults @{}
            if (Test-PlaceholderId ([string](Get-PropertyValue $kv 'id'))) {
                throw 'KV 建立完成但 wrangler.jsonc 沒有取得命名空間 ID。請保留 Cloudflare 資源，檢查設定後重跑。'
            }
            Write-Host 'KV 命名空間已建立並寫入設定。' -ForegroundColor Green
        }
    }

    $config = Read-WranglerConfig
    $d1 = Get-OrCreateBindingEntry -Config $config -ArrayName 'd1_databases' -BindingName 'DB' -Defaults @{}
    $kv = Get-OrCreateBindingEntry -Config $config -ArrayName 'kv_namespaces' -BindingName 'FILES' -Defaults @{}
    if (Test-PlaceholderId ([string](Get-PropertyValue $d1 'database_id'))) {
        throw 'D1 資料庫 ID 尚未設定。'
    }
    if (Test-PlaceholderId ([string](Get-PropertyValue $kv 'id'))) {
        throw 'KV 命名空間 ID 尚未設定。'
    }
    Save-WranglerConfig $config

    $workerName = [string](Get-PropertyValue $config 'name')
    if ([string]::IsNullOrWhiteSpace($workerName)) {
        $workerName = 'jasonmail'
    }
    return [pscustomobject]@{
        Config = $config
        DatabaseName = [string](Get-PropertyValue $d1 'database_name')
        WorkerName = $workerName
    }
}

function Ensure-CloudflareLogin {
    Write-Heading 'Cloudflare 登入'
    $result = Invoke-Wrangler -Arguments @('whoami') -AllowFailure -SuppressOutput
    if ($result.ExitCode -ne 0) {
        Write-Host '需要登入 Cloudflare。瀏覽器開啟後，請登入並授權 Wrangler。'
        $null = Invoke-Wrangler -Arguments @('login')
        $result = Invoke-Wrangler -Arguments @('whoami') -AllowFailure -SuppressOutput
        if ($result.ExitCode -ne 0) {
            throw 'Cloudflare 登入尚未完成。請確認瀏覽器授權後重新執行 install.cmd。'
        }
    }
    Write-Host 'Cloudflare 登入完成。' -ForegroundColor Green
}

function Deploy-Worker {
    param([string]$DatabaseName)

    Write-Heading '建立資料表並部署 Worker'
    $null = Invoke-Wrangler -Arguments @('d1', 'migrations', 'apply', $DatabaseName, '--remote')
    $null = Invoke-Npm -Arguments @('run', 'build') -DisplayName '檢查原始碼與 Wrangler dry-run build'
    $deployment = Invoke-Npm -Arguments @('run', 'deploy') -DisplayName '部署 Jason Mail Worker'
    return $deployment.Output
}

function Normalize-PublicUrl {
    param([string]$Value)

    $candidate = $Value.Trim()
    if (-not $candidate) {
        return $null
    }
    if ($candidate -notmatch '^https://') {
        $candidate = 'https://' + $candidate
    }
    $uri = $null
    if (-not [Uri]::TryCreate($candidate, [UriKind]::Absolute, [ref]$uri)) {
        throw '網址格式無效，請輸入完整的 HTTPS 網址。'
    }
    if ($uri.Scheme -ne 'https' -or $uri.UserInfo -or ($uri.AbsolutePath -ne '/' -and $uri.AbsolutePath -ne '')) {
        throw '請輸入網站根網址，例如 https://jasonmail.example.workers.dev。'
    }
    return $uri.GetLeftPart([UriPartial]::Authority).TrimEnd('/')
}

function Get-PublicUrl {
    param([string]$DeployOutput)

    $match = [regex]::Match($DeployOutput, 'https://[A-Za-z0-9][A-Za-z0-9.-]*\.workers\.dev')
    $workersDevUrl = $null
    if ($match.Success) {
        $workersDevUrl = $match.Value.TrimEnd('/')
    }

    if ($workersDevUrl) {
        Write-Host "部署網址：$workersDevUrl" -ForegroundColor Green
        while ($true) {
            $customUrl = Read-Host '如果你已在 Cloudflare 設定自訂網域 Route，輸入完整網址；直接按 Enter 使用上面的 workers.dev 網址'
            if ([string]::IsNullOrWhiteSpace($customUrl)) {
                return $workersDevUrl
            }
            try {
                return Normalize-PublicUrl $customUrl
            } catch {
                Write-Host $_.Exception.Message -ForegroundColor Yellow
            }
        }
    }

    Write-Host 'Wrangler 輸出中找不到 workers.dev 網址。若已設定 Worker Route，請輸入完整公開 HTTPS 網址。'
    do {
        $enteredUrl = Read-Host '公開網站網址'
        try {
            $normalized = Normalize-PublicUrl $enteredUrl
            if ($normalized) {
                return $normalized
            }
        } catch {
            Write-Host $_.Exception.Message -ForegroundColor Yellow
        }
    } while ($true)
}

function Get-ResendPayload {
    param($Response)
    $data = Get-PropertyValue $Response 'data'
    if ($null -ne $data) {
        return $data
    }
    return $Response
}

function Get-WebhookItems {
    param($Response)
    $payload = Get-ResendPayload $Response
    if ($payload -is [System.Array]) {
        return @($payload)
    }
    $items = Get-PropertyValue $payload 'data'
    if ($null -ne $items) {
        return @($items)
    }
    return @($payload)
}

function Get-ResendWebhookSecret {
    param([string]$ApiKey, [string]$Endpoint)

    $headers = @{ Authorization = 'Bearer ' + $ApiKey }
    $listResponse = Invoke-RestMethod -Method Get -Uri 'https://api.resend.com/webhooks' -Headers $headers -TimeoutSec 30
    $hooks = Get-WebhookItems $listResponse
    $matchingHooks = @()
    foreach ($hook in $hooks) {
        $hookEndpoint = [string](Get-PropertyValue $hook 'endpoint')
        $events = @(Get-PropertyValue $hook 'events')
        if ($hookEndpoint.TrimEnd('/') -eq $Endpoint.TrimEnd('/') -and $events -contains 'email.received') {
            $matchingHooks += $hook
        }
    }

    if ($matchingHooks.Count -gt 1) {
        Write-Host 'Resend 有多個相同 endpoint 的 webhook，會重用第一個；請稍後在 Dashboard 清理重複項目。' -ForegroundColor Yellow
    }

    if ($matchingHooks.Count -gt 0) {
        $webhookId = [string](Get-PropertyValue $matchingHooks[0] 'id')
        if (-not $webhookId) {
            throw 'Resend webhook 清單沒有提供 webhook ID。'
        }
        Write-Host '找到相同網址和 email.received 事件的 webhook，正在讀取 signing secret。'
        $detailResponse = Invoke-RestMethod -Method Get -Uri ('https://api.resend.com/webhooks/' + [Uri]::EscapeDataString($webhookId)) -Headers $headers -TimeoutSec 30
        $detail = Get-ResendPayload $detailResponse
    } else {
        Write-Host 'Resend 尚無相同 webhook，正在建立 email.received endpoint。'
        $body = @{ endpoint = $Endpoint; events = @('email.received') } | ConvertTo-Json -Compress
        $createResponse = Invoke-RestMethod -Method Post -Uri 'https://api.resend.com/webhooks' -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 30
        $detail = Get-ResendPayload $createResponse
    }

    $secret = [string](Get-PropertyValue $detail 'signing_secret')
    if (-not $secret -and (Get-PropertyValue $detail 'id')) {
        $webhookId = [string](Get-PropertyValue $detail 'id')
        $detailResponse = Invoke-RestMethod -Method Get -Uri ('https://api.resend.com/webhooks/' + [Uri]::EscapeDataString($webhookId)) -Headers $headers -TimeoutSec 30
        $detail = Get-ResendPayload $detailResponse
        $secret = [string](Get-PropertyValue $detail 'signing_secret')
    }
    if ($secret -notmatch '^whsec_[A-Za-z0-9+/_=-]{8,}$') {
        throw 'Resend API 沒有回傳有效的 signing secret。'
    }
    return $secret
}

function Get-HttpStatusCode {
    param($ErrorRecord)
    try {
        return [int]$ErrorRecord.Exception.Response.StatusCode
    } catch {
        return 0
    }
}

function Read-ManualWebhookSecret {
    param([string]$Endpoint)

    Write-Host ''
    Write-Host '請到 Resend Dashboard → Webhooks → Add Endpoint 完成以下設定：' -ForegroundColor Yellow
    Write-Host "  Endpoint URL: $Endpoint"
    Write-Host '  Event: email.received'
    Write-Host '建立後複製 webhook 詳細頁的 signing secret（以 whsec_ 開頭）。'
    Write-Host '這是 webhook 簽名密鑰；不要把它當成 API key、DNS 記錄，或貼到聊天/GitHub。'

    do {
        $secret = Read-SecretText -Prompt '貼上 Resend webhook signing secret（輸入內容會遮蔽）'
        if ($secret -match '^whsec_[A-Za-z0-9+/_=-]{8,}$') {
            return $secret
        }
        Write-Host '格式看起來不正確，請確認內容以 whsec_ 開頭。' -ForegroundColor Yellow
    } while ($true)
}

function New-SetupToken {
    $bytes = New-Object byte[] 32
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($bytes)
        return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    } finally {
        $generator.Dispose()
    }
}

function Test-AdminConfigured {
    param([string]$PublicUrl)

    try {
        $status = Invoke-RestMethod -Method Get -Uri ($PublicUrl + '/api/setup/status') -TimeoutSec 20
        if ($null -ne (Get-PropertyValue $status 'configured')) {
            return [bool](Get-PropertyValue $status 'configured')
        }
    } catch {
        Write-Host '無法自動確認網站是否已有管理員。' -ForegroundColor Yellow
    }

    $answer = Read-Host '這是第一次建立管理員嗎？輸入 Y 產生一次性 SETUP_TOKEN；已設定過請輸入 N'
    $normalizedAnswer = $answer.Trim().ToLowerInvariant()
    return $normalizedAnswer -eq 'y' -or $normalizedAnswer -eq 'yes'
}

function Set-WorkerSecrets {
    param([string]$WorkerName, [System.Collections.IDictionary]$Secrets)

    $json = ConvertTo-Json -InputObject $Secrets -Compress
    $arguments = @('wrangler', 'secret', 'bulk', '--name', $WorkerName)
    $null = Invoke-ExternalCommand -FileName $script:NpxCommand -Arguments $arguments -DisplayName '將 secrets 送到 Cloudflare Worker（透過 stdin，不建立本機 secret 檔案）' -InputText $json
}

function Show-Completion {
    param([string]$PublicUrl, [string]$SetupToken)

    Write-Heading '安裝完成'
    Write-Host "網站網址：$PublicUrl" -ForegroundColor Green
    if ($SetupToken) {
        Write-Host ''
        Write-Host '請現在複製並保存這個一次性 SETUP_TOKEN；此值只顯示這一次：' -ForegroundColor Yellow
        Write-Host $SetupToken -ForegroundColor White
        Write-Host '在網站首次設定頁建立使用者名稱和至少 12 字元的密碼。建立完成後，依 README 移除 Cloudflare 的 SETUP_TOKEN secret。'
    } else {
        Write-Host '偵測到管理員已建立；沒有重新產生 SETUP_TOKEN。'
    }
    Write-Host ''
    Write-Host '新增第一個郵件地址時，請輸入已在 Resend 驗證並啟用收件的郵件網域，例如 send.example.com。'
    Write-Host '寄收信所需的 MX、SPF、DKIM、DMARC 記錄請依 Resend Dashboard 設定；安裝器不會修改 DNS。'
    Write-Host '完整說明與手動修復步驟：https://github.com/lbsus-sy/JasonMail#從零開始部署'
}

function Start-JasonMailInstall {
    Set-Location $script:ProjectRoot
    Write-Heading 'Jason Mail Windows 安裝器'
    Write-Host '安裝器會建立或重用 Cloudflare D1/KV、部署 Worker，並設定 Resend webhook。'
    Write-Host '它不會修改 DNS、建立付費服務或刪除既有 Cloudflare 資源。'
    Write-Host 'RESEND_API_KEY 用來呼叫 Resend 和寄信；RESEND_WEBHOOK_SECRET 用來驗證入站 webhook 簽章。'

    Ensure-Prerequisites
    $null = Invoke-Npm -Arguments @('ci') -DisplayName '安裝 Jason Mail 依賴'
    Ensure-CloudflareLogin
    $cloudflare = Ensure-CloudflareResources
    $deployOutput = Deploy-Worker -DatabaseName $cloudflare.DatabaseName
    $publicUrl = Get-PublicUrl -DeployOutput $deployOutput
    $endpoint = $publicUrl + '/api/webhooks/resend'

    Write-Heading 'Resend 郵件服務設定'
    Write-Host '在 Resend Dashboard → API Keys 建立 API key。請勿把 key 貼到聊天或存進程式碼。'
    $apiKey = Read-SecretText -Prompt '輸入 Resend API key（輸入內容會遮蔽）'
    if ([string]::IsNullOrWhiteSpace($apiKey)) {
        throw 'Resend API key 不可為空白。'
    }

    $webhookSecret = $null
    try {
        $webhookSecret = Get-ResendWebhookSecret -ApiKey $apiKey -Endpoint $endpoint
        Write-Host 'Resend webhook 已就緒，signing secret 會直接存入 Worker secret。' -ForegroundColor Green
    } catch {
        $statusCode = Get-HttpStatusCode $_
        if ($statusCode -eq 401) {
            throw 'Resend 拒絕此 API key（HTTP 401）。請確認 API key 正確後重新執行安裝器。'
        }
        Write-Host "Resend API 自動設定未完成：$($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host '改用 Resend Dashboard 手動建立 webhook，安裝器會遮蔽提示 signing secret。'
        $webhookSecret = Read-ManualWebhookSecret -Endpoint $endpoint
    }

    $setupToken = ''
    if (-not (Test-AdminConfigured -PublicUrl $publicUrl)) {
        $setupToken = New-SetupToken
    }

    $secrets = [ordered]@{
        RESEND_API_KEY = $apiKey
        RESEND_WEBHOOK_SECRET = $webhookSecret
    }
    if ($setupToken) {
        $secrets['SETUP_TOKEN'] = $setupToken
    }
    Set-WorkerSecrets -WorkerName $cloudflare.WorkerName -Secrets $secrets

    Remove-Variable apiKey, webhookSecret, secrets -ErrorAction SilentlyContinue
    Show-Completion -PublicUrl $publicUrl -SetupToken $setupToken
}

try {
    Start-JasonMailInstall
} catch {
    Write-Host ''
    Write-Host "安裝器已停止：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host '安裝器不會刪除 Cloudflare 資源。修正指出的步驟後，可重新執行 install.cmd。' -ForegroundColor Yellow
    exit 1
}

