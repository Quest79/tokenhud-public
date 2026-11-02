# Registers the Windows Service "TokenHUD Server" (needs admin; Install TokenHUD Service.bat elevates). Run with -Remove to undo.
param([switch]$Remove)
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $a = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" + $(if ($Remove -or $args -contains 'remove') { ' -Remove' } else { '' })
  Start-Process powershell -Verb RunAs -ArgumentList $a; exit
}
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$nssm = Join-Path $root 'runtime\nssm.exe'
$exe = Join-Path $root 'runtime\tokenhud-server.exe'
$svc = 'TokenHUDServer'
Start-Transcript -Path (Join-Path $root 'runtime\install-service.log') -Force | Out-Null
try {
  if ($Remove) {
    & $nssm stop $svc | Out-Null; & $nssm remove $svc confirm | Out-Null
    'Service removed.'
  } else {
    # Make sure the labelled exe exists (service.ps1 builds it), then retire the per-user task so only one server runs.
    & (Join-Path $PSScriptRoot 'service.ps1') install | Out-Null
    Unregister-ScheduledTask -TaskName 'TokenHUD Server' -Confirm:$false -ErrorAction SilentlyContinue
    Get-Process tokenhud-server -ErrorAction SilentlyContinue | Stop-Process -Force
    if (Get-Service $svc -ErrorAction SilentlyContinue) { & $nssm stop $svc | Out-Null; & $nssm remove $svc confirm | Out-Null }
    & $nssm install $svc $exe 'server/server.mjs --log' | Out-Null
    & $nssm set $svc AppDirectory $root | Out-Null
    & $nssm set $svc DisplayName 'TokenHUD Server' | Out-Null
    & $nssm set $svc Description 'TokenHUD local data server (127.0.0.1:4317). Reads Claude Code transcripts and serves the dashboard. Starts with Windows and restarts itself if it stops.' | Out-Null
    & $nssm set $svc Start SERVICE_AUTO_START | Out-Null
    & $nssm set $svc AppExit Default Restart | Out-Null
    & $nssm set $svc AppRestartDelay 2000 | Out-Null
    # The service runs as SYSTEM, so point it at the installing user's folders.
    $u = $env:USERPROFILE
    & $nssm set $svc AppEnvironmentExtra "USERPROFILE=$u" "APPDATA=$u\AppData\Roaming" "LOCALAPPDATA=$u\AppData\Local" "HOMEDRIVE=$($env:HOMEDRIVE)" "HOMEPATH=$($env:HOMEPATH)" | Out-Null
    & $nssm start $svc | Out-Null
    Start-Sleep 5
    $h = try { Invoke-RestMethod http://127.0.0.1:4317/api/health -TimeoutSec 5 } catch { $null }
    if ($h) { "Service running, TokenHUD $($h.version) on 4317." } else { throw 'Service installed but the server did not answer on 4317.' }
  }
} catch { Write-Host "FAILED: $_" -ForegroundColor Red; Read-Host 'Press Enter to close'; exit 1 }
Stop-Transcript | Out-Null
Start-Sleep 2
