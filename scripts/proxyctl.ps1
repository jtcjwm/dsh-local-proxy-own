# proxyctl.ps1 - one-shot CLI for dsh-local-proxy-own + a FoxLink node.
#
#   .\proxyctl.ps1 start [-Node auto|node-xxx] [-Port 7899] [-SystemProxy]
#   .\proxyctl.ps1 stop
#   .\proxyctl.ps1 status
#
# start : snapshot HKCU proxy values -> run sing-box (node) -> run proxy.js with
#         that node as upstream -> optional system proxy -> self test
# stop  : kill both -> restore every registry value to its pre-start state
#         (a value that did not exist is deleted, not blanked) -> verify
#
param(
    [Parameter(Position = 0)][ValidateSet('start', 'stop', 'status')][string]$Action = 'status',
    [string]$Node = 'auto',
    [int]$Port = 7899,
    [switch]$SystemProxy,
    [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
$Root    = Split-Path -Parent $PSScriptRoot          # plugin root
$Runtime = Join-Path $Root '.runtime'
$Snap    = Join-Path $Runtime 'reg-snapshot.json'
$ProxyPid= Join-Path $Runtime 'proxy.pid'
$RegKey  = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$RegVals = @('ProxyEnable', 'ProxyServer', 'AutoConfigURL', 'AutoDetect')

function Get-NodePath {
    foreach ($c in @('D:\ccd\node.exe', (Join-Path $env:ProgramFiles 'nodejs\node.exe'), 'node')) {
        try {
            if ($c -eq 'node') { if (Get-Command node -ErrorAction SilentlyContinue) { return 'node' } }
            elseif (Test-Path $c) { return $c }
        } catch {}
    }
    throw 'node not found'
}

$NodeExe = Get-NodePath

function Pause-End($code) {
    if (-not $NoPause) { Write-Host ''; Write-Host 'Press Enter to close ...' -ForegroundColor DarkGray; [void](Read-Host) }
    exit $code
}

function Port-Open([int]$p) {
    try {
        $c = New-Object Net.Sockets.TcpClient
        $c.Connect('127.0.0.1', $p)
        $ok = $c.Connected
        $c.Close()
        return $ok
    } catch { return $false }
}

function Snapshot-Reg {
    New-Item -ItemType Directory -Force -Path $Runtime | Out-Null
    $state = @{}
    foreach ($n in $RegVals) {
        $p = (Get-ItemProperty -Path $RegKey -ErrorAction SilentlyContinue).PSObject.Properties[$n]
        if ($null -eq $p) { $state[$n] = @{ exists = $false } }
        else { $state[$n] = @{ exists = $true; value = $p.Value; type = $p.TypeNameOfValue } }
    }
    $state['ProxyOverride'] = @{ exists = $true; value = (Get-ItemProperty -Path $RegKey).ProxyOverride; untouched = $true }
    $state | ConvertTo-Json -Depth 4 | Set-Content -Path $Snap -Encoding utf8
}

function Restore-Reg {
    if (-not (Test-Path $Snap)) { return 'no snapshot (registry untouched)' }
    $state = Get-Content $Snap -Raw -Encoding utf8 | ConvertFrom-Json
    foreach ($n in $RegVals) {
        $e = $state.$n
        if ($null -eq $e) { continue }
        if ($e.exists -eq $true) {
            $t = if ($e.type -match 'DWord') { 'DWord' } else { 'String' }
            New-ItemProperty -Path $RegKey -Name $n -Value $e.value -PropertyType $t -Force | Out-Null
        } else {
            Remove-ItemProperty -Path $RegKey -Name $n -ErrorAction SilentlyContinue
        }
    }
    return 'registry restored'
}

function Set-SystemProxy([int]$p) {
    New-ItemProperty -Path $RegKey -Name 'ProxyEnable'   -Value 1 -PropertyType DWord  -Force | Out-Null
    New-ItemProperty -Path $RegKey -Name 'ProxyServer'   -Value ("127.0.0.1:" + $p) -PropertyType String -Force | Out-Null
    Remove-ItemProperty -Path $RegKey -Name 'AutoConfigURL' -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path $RegKey -Name 'AutoDetect'    -ErrorAction SilentlyContinue
}

function Stop-All {
    # proxy.js
    if (Test-Path $ProxyPid) {
        $pidText = (Get-Content $ProxyPid -Raw).Trim()
        if ($pidText) {
            try { Stop-Process -Id ([int]$pidText) -Force -ErrorAction SilentlyContinue } catch {}
        }
    }
    foreach ($p in @($Port)) {
        foreach ($owner in (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)) {
            try { Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue } catch {}
        }
    }
    # sing-box
    & $NodeExe (Join-Path $Root 'bin\singbox-node.js') stop 2>$null | Out-Null

    $merged = Restore-Reg
    # let ports settle, then verify
    $t0 = Get-Date
    while (((Get-Date) - $t0).TotalSeconds -lt 5) {
        if (-not (Port-Open $Port) -and -not (Port-Open 18999)) { break }
        Start-Sleep -Milliseconds 250
    }
    Remove-Item $ProxyPid -ErrorAction SilentlyContinue
    return $merged
}

switch ($Action) {
    'start' {
        Write-Host "[1/4] snapshot registry" -ForegroundColor Cyan
        Snapshot-Reg

        Write-Host "[2/4] starting node ($Node) ..." -ForegroundColor Cyan
        $out = & $NodeExe (Join-Path $Root 'bin\singbox-node.js') start $Node --port 18999 2>&1
        $info = $out | Select-Object -Last 1 | ConvertFrom-Json
        if (-not $info.ok) { Write-Host $out -ForegroundColor Red; Pause-End 3 }
        Write-Host ("      node " + $info.node + " -> " + $info.server + "  pid " + $info.pid) -ForegroundColor Green

        Write-Host "[3/4] starting proxy on 127.0.0.1:$Port ..." -ForegroundColor Cyan
        New-Item -ItemType Directory -Force -Path $Runtime | Out-Null
        $logDir = Join-Path $env:TEMP 'dsh-local-proxy-own'
        $pxArgs = @(
            (Join-Path $Root 'bin\proxy.js'),
            '--port', "$Port", '--host', '127.0.0.1',
            '--upstream', 'socks5://127.0.0.1:18999',
            '--log-dir', $logDir,
            '--pid-file', $ProxyPid
        )
        $px = Start-Process -FilePath $NodeExe -ArgumentList $pxArgs -PassThru -WindowStyle Hidden
        $t0 = Get-Date
        while (((Get-Date) - $t0).TotalSeconds -lt 10) {
            if (Port-Open $Port) { break }
            Start-Sleep -Milliseconds 250
        }
        if (-not (Port-Open $Port)) { Write-Host '[x] proxy did not open' -ForegroundColor Red; Pause-End 4 }

        if ($SystemProxy) {
            Set-SystemProxy $Port
            Write-Host "      system proxy -> 127.0.0.1:$Port" -ForegroundColor Green
        }

        Write-Host '[4/4] self test ...' -ForegroundColor Cyan
        $ip = & curl.exe -s -x ("http://127.0.0.1:" + $Port) --max-time 20 http://api.ipify.org 2>$null
        Write-Host ("      exit IP via proxy: " + $ip) -ForegroundColor Green
        Write-Host ''
        Write-Host ("READY  socks5+http on 127.0.0.1:$Port  (node " + $info.node + ")") -ForegroundColor Cyan
        Pause-End 0
    }
    'stop' {
        Write-Host '[1/3] stopping proxy + node ...' -ForegroundColor Cyan
        $r = Stop-All
        Write-Host ("      " + $r)
        Write-Host '[2/3] registry now:' -ForegroundColor Cyan
        $p = Get-ItemProperty -Path $RegKey
        Write-Host ("      ProxyEnable=" + $p.ProxyEnable + "  ProxyServer=" + $(if ($null -ne $p.PSObject.Properties['ProxyServer']) { $p.ProxyServer } else { '<absent>' }))
        Write-Host '[3/3] residue check' -ForegroundColor Cyan
        $listen = (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 7899, 18999 }).Count
        Write-Host ("      listening on 7899/18999: " + $listen)
        Write-Host ("      .runtime exists: " + (Test-Path $Runtime))
        if ($listen -eq 0) { Write-Host 'CLEAN' -ForegroundColor Green } else { Write-Host 'WARN: port still bound' -ForegroundColor Yellow }
        Pause-End 0
    }
    'status' {
        $p = Get-ItemProperty -Path $RegKey
        Write-Host ("proxy 7899 listening : " + (Port-Open $Port))
        Write-Host ("node 18999 listening : " + (Port-Open 18999))
        Write-Host ("ProxyEnable          : " + $p.ProxyEnable)
        Write-Host ("ProxyServer          : " + $(if ($null -ne $p.PSObject.Properties['ProxyServer']) { $p.ProxyServer } else { '<absent>' }))
        Write-Host ("snapshot present     : " + (Test-Path $Snap))
        Pause-End 0
    }
}
