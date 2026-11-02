# TokenHUD data server as a labelled, self-restarting background job (no admin needed).
#   service.ps1 ensure   install or repair when missing or stale (cheap; start.ps1 calls it), then exit
#   service.ps1 install  same, forced
#   service.ps1 remove   delete the task and the renamed program
# What it sets up:
#   * <project>/runtime/tokenhud-server.exe: a copy of node.exe, labelled "TokenHUD data server" (Task Manager name and
#     description) and built as a windowless program, so there is no console window and no anonymous "Node.js" process.
#   * Scheduled task "TokenHUD Server": starts at logon and every 5 minutes if it is not running, never times out.
param([ValidateSet('ensure', 'install', 'remove')][string]$Action = 'ensure')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
# Not under AppData: the task scheduler refuses to launch a renamed node.exe from there (error 0x80070002).
$dir = Join-Path $root 'runtime'
$exe = Join-Path $dir 'tokenhud-server.exe'
$stamp = Join-Path $dir 'server-exe.txt'
$task = 'TokenHUD Server'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$nodeVer = (& $node --version).Trim()

function Stop-Server {
  Get-Process -Name 'tokenhud-server' -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Milliseconds 400
}

if ($Action -eq 'remove') {
  Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
  Stop-Server
  Remove-Item $exe, $stamp -Force -ErrorAction SilentlyContinue
  'Removed.'; return
}

# A real Windows Service (install-service.ps1) replaces this task; leave everything alone once it exists.
if ($Action -eq 'ensure' -and (Get-Service 'TokenHUDServer' -ErrorAction SilentlyContinue)) { return }
$haveTask = [bool](Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue)
$current = (Test-Path $exe) -and (Test-Path $stamp) -and ((Get-Content $stamp -Raw).Trim() -eq "$nodeVer|$root")
if ($Action -eq 'ensure' -and $current -and $haveTask) { return }

New-Item -ItemType Directory -Force $dir | Out-Null
if (-not $current) {
  Stop-Server
  Copy-Item $node $exe -Force
  # Windowless build: flip the PE subsystem from console (3) to GUI (2). Node then runs without a console window.
  $b = [IO.File]::ReadAllBytes($exe)
  $pe = [BitConverter]::ToInt32($b, 0x3C)
  $b[$pe + 24 + 68] = 2; $b[$pe + 24 + 69] = 0
  [IO.File]::WriteAllBytes($exe, $b)
  # Task Manager label. rcedit is fetched into a temp folder and not added to the project.
  $tmp = Join-Path $env:TEMP 'tokenhud-rcedit'
  try {
    New-Item -ItemType Directory -Force $tmp | Out-Null
    if (-not (Test-Path (Join-Path $tmp 'node_modules\rcedit'))) { Push-Location $tmp; npm init -y | Out-Null; npm i rcedit --no-audit --no-fund --silent; Pop-Location }
    $js = "let r=require('rcedit');r=r.rcedit||r.default||r;r(process.argv[1],{'version-string':{FileDescription:'TokenHUD data server',ProductName:'TokenHUD',InternalName:'tokenhud-server',OriginalFilename:'tokenhud-server.exe',CompanyName:'TokenHUD',LegalCopyright:''}}).catch(e=>{console.error(e);process.exit(1)})"
    Push-Location $tmp; & $node -e $js $exe; $ok = $LASTEXITCODE; Pop-Location
    if ($ok -ne 0) { Write-Warning 'Could not set the program description; it will show as Node.js in Task Manager.' }
  } catch { Write-Warning "Could not set the program description: $_" }
  finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
  "$nodeVer|$root" | Set-Content $stamp -Encoding ascii
}

$act = New-ScheduledTaskAction -Execute $exe -Argument 'server/server.mjs --log' -WorkingDirectory $root
$t1 = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$t2 = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 5)
$set = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
$pr = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $task -Action $act -Trigger @($t1, $t2) -Settings $set -Principal $pr -Force `
  -Description 'TokenHUD local data server (127.0.0.1:4317). Reads Claude Code transcripts and serves the dashboard. Starts at logon and restarts itself if it stops.' | Out-Null
'Installed.'
