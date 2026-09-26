param([Parameter(Mandatory=$true)][ValidateSet('install','uninstall','start','stop','status')][string]$Action)
$ErrorActionPreference = 'Stop'
$Name = 'EcoPrintSigSense'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$SourceEngine = Join-Path $RepoRoot 'sigsense/engine/v3engine'
$ProgramDir = Join-Path $env:ProgramFiles 'EcoPrint'
$DataDir = Join-Path $env:ProgramData 'EcoPrint/Data'
$ConfigDir = Join-Path $env:ProgramData 'EcoPrint/Config'
$Database = Join-Path $DataDir 'ecoprint_telemetry.db'
$Config = Join-Path $ConfigDir 'ecoprint.conf'
$Pipe = '\\.\pipe\ecoprint-transparency'

function Require-Administrator {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run service install/uninstall from an elevated PowerShell window.'
    }
}

switch ($Action) {
    'install' {
        Require-Administrator
        if (-not (Test-Path $SourceEngine)) { throw 'Build sigsense/engine/v3engine first.' }
        New-Item -ItemType Directory -Force -Path $ProgramDir,$DataDir,$ConfigDir | Out-Null
        Copy-Item -Force $SourceEngine (Join-Path $ProgramDir 'v3engine.exe')
        if (-not (Test-Path $Config)) { New-Item -ItemType File -Path $Config | Out-Null }
        & icacls.exe $DataDir /inheritance:r /grant 'NT AUTHORITY\LOCAL SERVICE:(OI)(CI)M' 'BUILTIN\Users:(OI)(CI)RX' 'SYSTEM:(OI)(CI)F' | Out-Null
        & icacls.exe $ConfigDir /inheritance:r /grant 'NT AUTHORITY\LOCAL SERVICE:(OI)(CI)RX' 'BUILTIN\Administrators:(OI)(CI)F' 'SYSTEM:(OI)(CI)F' | Out-Null
        $binary = Join-Path $ProgramDir 'v3engine.exe'
        $binPath = '"{0}" --service --db "{1}" --config "{2}" --socket "{3}"' -f $binary,$Database,$Config,$Pipe
        & sc.exe create $Name binPath= $binPath start= auto obj= 'NT AUTHORITY\LocalService' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "SCM service creation failed ($LASTEXITCODE)." }
        & sc.exe description $Name 'EcoPrint local hardware telemetry service' | Out-Null
        & sc.exe start $Name | Out-Null
        Write-Output "Installed. Telemetry database: $Database"
    }
    'uninstall' {
        Require-Administrator
        & sc.exe stop $Name 2>$null | Out-Null
        & sc.exe delete $Name | Out-Null
        Remove-Item -Force (Join-Path $ProgramDir 'v3engine.exe') -ErrorAction SilentlyContinue
        Write-Output 'Service removed; telemetry database and configuration were retained.'
    }
    'start' { & sc.exe start $Name | Out-Null; if ($LASTEXITCODE -ne 0) { throw "SCM start failed ($LASTEXITCODE)." } }
    'stop' { & sc.exe stop $Name | Out-Null; if ($LASTEXITCODE -ne 0) { throw "SCM stop failed ($LASTEXITCODE)." } }
    'status' { & sc.exe query $Name; if ($LASTEXITCODE -ne 0) { throw "SCM query failed ($LASTEXITCODE)." } }
}
