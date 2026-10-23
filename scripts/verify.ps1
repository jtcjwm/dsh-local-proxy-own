# dsh-local-proxy-own / verify.ps1
#
# Zero-residue acceptance for the local proxy plugin: eight faces plus the
# extra assertions from the host baseline report, each printed as PASS/FAIL.
#
# Baseline values come from
#   D:\DSH\dsh-网络\flywheel-re\host-baseline\00-report.md  (2026-10-19)
#   hosts effective lines 5, default route 1 -> 192.168.1.1, persistent 0,
#   ProxyEnable=0 with ProxyServer/AutoConfigURL/AutoDetect ABSENT,
#   ProxyOverride=<local>, WinHTTP direct, 0 MITM root certs, 0 proxy procs.
#
# Run it AFTER stopping the proxy:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify.ps1
#   powershell ... -File scripts\verify.ps1 -Port 7899 -LogDir "D:\DSH\...\plugin-logs"
#
# Exit code: 0 when every face passes, 1 otherwise.

[CmdletBinding()]
param(
    [int]$Port = 7899,
    [string]$LogDir = 'D:\DSH\dsh-网络\flywheel-re\plugin-logs',
    [string]$PluginDir = 'D:\DSH\plugins\dsh-local-proxy-own',
    [string]$RegistryKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
)

$ErrorActionPreference = 'Continue'
$script:Pass = 0
$script:Fail = 0
$script:Lines = New-Object System.Collections.ArrayList

function Add-Check {
    param([string]$Face, [string]$Name, [bool]$Ok, [string]$Detail)
    $tag = if ($Ok) { 'PASS' } else { 'FAIL' }
    if ($Ok) { $script:Pass++ } else { $script:Fail++ }
    $line = '[{0}] {1} | {2} | {3}' -f $tag, $Face, $Name, $Detail
    [void]$script:Lines.Add($line)
    Write-Host $line
}

function Get-InternetSetting {
    param([string]$Name)
    try {
        return (Get-ItemProperty -Path $RegistryKey -Name $Name -ErrorAction Stop).$Name
    } catch {
        return $null
    }
}

function Test-NameExists {
    param([string]$Name)
    try {
        $null = Get-ItemProperty -Path $RegistryKey -Name $Name -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

Write-Host '=== dsh-local-proxy-own zero-residue verification ==='
Write-Host ("plugin : {0}" -f $PluginDir)
Write-Host ("port   : {0}" -f $Port)
Write-Host ("hosts  : baseline 5 effective lines / route 1 -> 192.168.1.1")
Write-Host ''

# --- face 1: processes -------------------------------------------------------
$proxyProcs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -and $_.CommandLine -match 'dsh-local-proxy-own[\\/]bin[\\/]proxy\.js'
})
Add-Check 'face1-process' 'proxy process count' ($proxyProcs.Count -eq 0) ("count={0} pids={1}" -f $proxyProcs.Count, (($proxyProcs | ForEach-Object { $_.ProcessId }) -join ','))

$legacyNames = '^(mihomo|clash|clash-meta|clash-verge|v2ray|xray|sing-box|singbox|nekoray|wireguard|openvpn|trojan|shadowsocks|hysteria|gost|cloudflared|proxifier|tun2socks)(\.exe)?$'
$legacy = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -match $legacyNames })
Add-Check 'face1-process' 'legacy proxy process count' ($legacy.Count -eq 0) ("count={0}" -f $legacy.Count)

$legacySvc = @(Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'clash|mihomo|v2ray|xray|wireguard|openvpn|tailscale|zerotier|local-?proxy' })
Add-Check 'face1-process' 'proxy-ish service count' ($legacySvc.Count -eq 0) ("count={0} [{1}]" -f $legacySvc.Count, (($legacySvc | ForEach-Object { $_.Name }) -join ','))

# --- face 2: files -----------------------------------------------------------
$runtimeDir = Join-Path $PluginDir '.runtime'
Add-Check 'face2-files' 'runtime state dir removed' (-not (Test-Path $runtimeDir)) ("exists={0} ({1})" -f (Test-Path $runtimeDir), $runtimeDir)

$pidFiles = @()
if (Test-Path $PluginDir) {
    $pidFiles = @(Get-ChildItem -Path $PluginDir -Filter '*.pid' -Recurse -ErrorAction SilentlyContinue)
}
Add-Check 'face2-files' 'no stale pid files' ($pidFiles.Count -eq 0) ("count={0}" -f $pidFiles.Count)

$certHits = @()
try {
    $certHits = @(Get-ChildItem -Path Cert:\CurrentUser\Root, Cert:\LocalMachine\Root -ErrorAction SilentlyContinue |
        Where-Object { $_.Subject -match 'dsh-local-proxy-own|local proxy|mitm|proxy|charles|fiddler|burp|proxyman' })
} catch {
    $certHits = @()
}
Add-Check 'face2-files' 'no proxy/MITM root certificate' ($certHits.Count -eq 0) ("count={0}" -f $certHits.Count)

$shortcutHits = @()
$shortcutDirs = @(
    [Environment]::GetFolderPath('Desktop'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs')
)
foreach ($dir in $shortcutDirs) {
    if ($dir -and (Test-Path $dir)) {
        $shortcutHits += @(Get-ChildItem -Path $dir -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match 'proxy|dsh-local' })
    }
}
Add-Check 'face2-files' 'no proxy shortcut in desktop/start menu' ($shortcutHits.Count -eq 0) ("count={0} [{1}]" -f $shortcutHits.Count, (($shortcutHits | ForEach-Object { $_.Name }) -join ','))

$overSized = @()
$logFiles = @()
if (Test-Path $LogDir) {
    $logFiles = @(Get-ChildItem -Path $LogDir -Filter 'local-proxy-*.log*' -ErrorAction SilentlyContinue)
    $overSized = @($logFiles | Where-Object { $_.Length -gt (2 * 1024 * 1024 + 65536) })
}
Add-Check 'face2-files' 'logs within 2MB rotation cap' ($overSized.Count -eq 0) ("files={0} oversized={1}" -f $logFiles.Count, $overSized.Count)

# --- face 3: registry --------------------------------------------------------
$proxyEnable = Get-InternetSetting 'ProxyEnable'
$proxyEnableOk = ($null -ne $proxyEnable) -and ([int]$proxyEnable -eq 0)
Add-Check 'face3-registry' 'ProxyEnable == 0' $proxyEnableOk ("value={0}" -f ($(if ($null -eq $proxyEnable) { '(absent)' } else { $proxyEnable })))

foreach ($name in @('ProxyServer', 'AutoConfigURL', 'AutoDetect')) {
    $exists = Test-NameExists $name
    $value = Get-InternetSetting $name
    Add-Check 'face3-registry' ("{0} absent (not blank)" -f $name) (-not $exists) ("exists={0} value={1}" -f $exists, $value)
}

$override = Get-InternetSetting 'ProxyOverride'
Add-Check 'face3-registry' 'ProxyOverride preserved' ($override -eq '<local>') ("value={0}" -f $override)

$portproxy = (netsh interface portproxy show all 2>$null | Out-String).Trim()
Add-Check 'face3-registry' 'portproxy empty' ($portproxy -eq '' -or $portproxy -match '^\s*$') ("len={0}" -f $portproxy.Length)

$appInit = ''
try {
    $appInit = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Windows' -ErrorAction Stop).AppInit_DLLs
} catch { $appInit = '' }
Add-Check 'face3-registry' 'AppInit_DLLs empty' ([string]::IsNullOrEmpty($appInit)) ("value='{0}'" -f $appInit)

# --- face 4: network adapters -----------------------------------------------
$adapters = @()
try {
    $adapters = @(Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue |
        Where-Object { $_.InterfaceDescription -match 'TAP|TUN|WireGuard|wintun|mihomo|Meta|Clash|Radmin|vEthernet' })
} catch { $adapters = @() }
Add-Check 'face4-nic' 'virtual proxy adapter count' ($adapters.Count -eq 0) ("count={0} [{1}]" -f $adapters.Count, (($adapters | ForEach-Object { $_.InterfaceDescription }) -join ','))

# --- face 5: routes ----------------------------------------------------------
$defaultRoutes = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue)
Add-Check 'face5-route' 'default route count == 1' ($defaultRoutes.Count -eq 1) ("count={0}" -f $defaultRoutes.Count)

$nextHops = ($defaultRoutes | ForEach-Object { $_.NextHop }) -join ','
Add-Check 'face5-route' 'default route next hop 192.168.1.1' ($nextHops -eq '192.168.1.1') ("nexthop={0}" -f $nextHops)

$persistent = @(Get-NetRoute -AddressFamily IPv4 -PolicyStore PersistentStore -ErrorAction SilentlyContinue)
Add-Check 'face5-route' 'persistent routes == 0' ($persistent.Count -eq 0) ("count={0}" -f $persistent.Count)

# --- face 6: autostart -------------------------------------------------------
$runKeys = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run'
)
$runHits = @()
foreach ($key in $runKeys) {
    try {
        $props = (Get-ItemProperty $key -ErrorAction Stop).PSObject.Properties
        $runHits += @($props | Where-Object { $_.Name -match 'local-?proxy|dsh-local' })
    } catch { }
}
Add-Check 'face6-autostart' 'Run key entries == 0' ($runHits.Count -eq 0) ("count={0}" -f $runHits.Count)

$userStartup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$allStartup = 'C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Startup'
$userItems = @()
if (Test-Path $userStartup) { $userItems = @(Get-ChildItem -Force $userStartup -ErrorAction SilentlyContinue) }
$userProxy = @($userItems | Where-Object { $_.Name -match 'local-?proxy|dsh-local|sing-?box|gfvpn|greatfire|foxlink' })
Add-Check 'face6-autostart' 'user startup folder has no proxy item' ($userProxy.Count -eq 0) ("count={0} proxyHits={1} items=[{2}]" -f $userItems.Count, $userProxy.Count, (($userItems | ForEach-Object { $_.Name }) -join ','))

$allItems = @()
if (Test-Path $allStartup) { $allItems = @(Get-ChildItem -Force $allStartup -ErrorAction SilentlyContinue) }
$allProxy = @($allItems | Where-Object { $_.Name -match 'local-?proxy|dsh-local' })
Add-Check 'face6-autostart' 'common startup folder has no proxy item' ($allProxy.Count -eq 0) ("count={0} proxyHits={1}" -f $allItems.Count, $allProxy.Count)

# --- face 7: scheduled tasks -------------------------------------------------
$tasks = @()
try {
    $tasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {
        (($_.TaskName + ' ' + ($_.Actions.Execute -join ' ')) -match 'local-?proxy|dsh-local') -and
        ($_.TaskPath -ne '\Microsoft\Windows\Autochk\')
    })
} catch { $tasks = @() }
Add-Check 'face7-tasks' 'proxy scheduled tasks == 0' ($tasks.Count -eq 0) ("count={0}" -f $tasks.Count)

# --- face 8: hosts -----------------------------------------------------------
$hostsPath = 'C:\Windows\System32\drivers\etc\hosts'
$effective = @()
if (Test-Path $hostsPath) {
    $effective = @(Get-Content $hostsPath -ErrorAction SilentlyContinue |
        Where-Object { $_.Trim() -ne '' -and -not $_.Trim().StartsWith('#') })
}
Add-Check 'face8-hosts' 'hosts effective lines == 5' ($effective.Count -eq 5) ("count={0}" -f $effective.Count)

$hostsProxy = @($effective | Where-Object { $_ -match 'local-proxy|127\.0\.0\.1\s+.*proxy' })
Add-Check 'face8-hosts' 'no proxy entry in hosts' ($hostsProxy.Count -eq 0) ("count={0}" -f $hostsProxy.Count)

# --- extras ------------------------------------------------------------------
$listeners = @(netstat -ano -p TCP 2>$null | Select-String -Pattern ("[:.]" + $Port + "\s") | Select-String -Pattern 'LISTENING')
Add-Check 'extra-port' 'port not listening' ($listeners.Count -eq 0) ("count={0}" -f $listeners.Count)

$timeWait = @(netstat -ano -p TCP 2>$null | Select-String -Pattern ("[:.]" + $Port + "\s"))
Write-Host ("[INFO] extra-port | sockets mentioning port {0} (incl. TIME_WAIT): {1}" -f $Port, $timeWait.Count)

$envHits = @()
foreach ($scope in @('Process', 'User', 'Machine')) {
    foreach ($name in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY')) {
        foreach ($variant in @($name, $name.ToLowerInvariant())) {
            $value = [Environment]::GetEnvironmentVariable($variant, $scope)
            if (-not [string]::IsNullOrEmpty($value)) { $envHits += ("{0}/{1}={2}" -f $scope, $variant, $value) }
        }
    }
}
Add-Check 'extra-env' 'proxy environment variables empty' ($envHits.Count -eq 0) ("count={0}" -f $envHits.Count)

# WinHTTP must stay direct. netsh output is localized (English on one boot,
# Chinese on another), so the assertion looks for a configured server address
# instead of matching a translated sentence.
$winhttp = ''
for ($attempt = 0; $attempt -lt 3; $attempt++) {
    $winhttp = (netsh winhttp show proxy 2>$null | Out-String)
    if ($winhttp.Trim().Length -gt 0) { break }
    Start-Sleep -Milliseconds 400
}
$winhttpHasServer = ($winhttp -match '(\d{1,3}\.){3}\d{1,3}:\d+') -or ($winhttp -match 'https?://')
$winhttpDirect = ($winhttp.Trim().Length -gt 0) -and (-not $winhttpHasServer)
$winhttpAscii = ($winhttp -replace '[^\x20-\x7E]', '?') -replace '\s+', ' '
Add-Check 'extra-winhttp' 'WinHTTP has no proxy server' $winhttpDirect ("direct={0} raw='{1}'" -f $winhttpDirect, $winhttpAscii.Trim())

Write-Host ''
Write-Host ("=== result: {0} PASS / {1} FAIL ===" -f $script:Pass, $script:Fail)
if ($script:Fail -gt 0) { exit 1 } else { exit 0 }
