# Starts TokenHUD: builds the UI when the sources changed, (re)starts the background server, opens the
# dashboard window. This console shows each step with a progress bar and the latest output, and closes
# once the TokenHUD window is up. On a failure it stays open with the error and offers the log.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$data = Join-Path $env:APPDATA 'TokenHUD'
$log = Join-Path $data 'start.log'
$serverLog = Join-Path $data 'server.log'
$port = 4317
$base = "http://127.0.0.1:$port"
New-Item -ItemType Directory -Force $data | Out-Null
"TokenHUD start, $(Get-Date)" | Out-File $log -Encoding utf8
function Log($m) { "[{0:HH:mm:ss}] {1}" -f (Get-Date), $m | Out-File $log -Append -Encoding utf8 }

if ($env:WT_SESSION) { $G = @{ full = [char]0x2501; empty = [char]0x2501; done = [char]0x2713; fail = [char]0x2717; now = [char]0x25B6; todo = [char]0x00B7 } }
else { $G = @{ full = [char]0x2588; empty = [char]0x2591; done = [char]0x221A; fail = 'x'; now = [char]0x25BA; todo = [char]0x00B7 } }
$clock = [Diagnostics.Stopwatch]::StartNew()
$stepClock = [Diagnostics.Stopwatch]::StartNew()
$steps = New-Object System.Collections.ArrayList
$cur = $null; $frac = 0.0; $shown = 0.0; $detail = ''
$recent = New-Object System.Collections.Generic.Queue[string]

function Add-Step($todo, $doing, $done, $skip, $expected) {
  $s = [pscustomobject]@{ Todo = $todo; Doing = $doing; Done = $done; Skip = $skip; Expected = $expected; State = 'todo'; Secs = 0.0 }
  [void]$steps.Add($s); $s
}
function Clock($s) { if ($s -lt 60) { '{0:0.0} s' -f $s } else { '{0}:{1:00}' -f [math]::Floor($s / 60), [math]::Floor($s % 60) } }
function Ease($elapsed, $expected) {
  $t = $elapsed / [Math]::Max(0.5, $expected)
  if ($t -lt 0.9) { $t } else { 0.9 + 0.09 * (1 - [Math]::Exp(-($t - 0.9) * 3)) }
}
function Overall {
  $total = 0.0; $got = 0.0
  foreach ($s in $steps) {
    if ($s.State -eq 'skip') { continue }
    $total += $s.Expected
    if ($s.State -eq 'done') { $got += $s.Expected } elseif ($s.State -eq 'now') { $got += $s.Expected * $script:frac }
  }
  if ($total -gt 0) { $script:shown = [Math]::Max($script:shown, [Math]::Min(1.0, $got / $total)) }
  $script:shown
}
function Out-Line {
  $left = $script:width
  for ($i = 0; $i -lt $args.Count; $i += 2) {
    $t = [string]$args[$i]
    if ($t.Length -gt $left) { $t = $t.Substring(0, $left) }
    if ($t) { Write-Host $t -NoNewline -ForegroundColor $args[$i + 1] }
    $left -= $t.Length
  }
  Write-Host (' ' * $left)
}
function Draw([string]$end) {
  $w = 80
  try { $w = [Console]::WindowWidth } catch {}
  $script:width = [Math]::Max(40, [Math]::Min($w, 100)) - 1
  try { [Console]::SetCursorPosition(0, 0) } catch {}
  $n = [Math]::Max(10, [Math]::Min(50, $script:width - 12))
  $all = if ($end -eq 'ok') { 1.0 } else { Overall }
  $total = Clock $clock.Elapsed.TotalSeconds
  if ($end -eq 'ok') { $head = 'TokenHUD is open'; $hc = 'Green'; $bc = 'Green' }
  elseif ($end -eq 'fail') { $head = "Couldn't start TokenHUD"; $hc = 'Red'; $bc = 'Red' }
  else { $head = $script:cur.Doing; $hc = 'White'; $bc = 'Cyan' }
  $filled = [int][Math]::Floor($all * $n)
  Out-Line
  Out-Line '  TOKENHUD' Cyan '   starting' DarkGray
  Out-Line
  Out-Line "  $head" $hc (' ' * [Math]::Max(2, $n + 7 - $head.Length - $total.Length)) Gray $total DarkGray
  Out-Line '  ' Gray (([string]$G.full) * $filled) $bc (([string]$G.empty) * ($n - $filled)) DarkGray ('  {0,3}%' -f [int][Math]::Floor($all * 100)) White
  Out-Line "  $($script:detail)" DarkGray
  Out-Line
  foreach ($s in $steps) {
    switch ($s.State) {
      'done' { Out-Line "  $($G.done) " Green $s.Done.PadRight(34) Gray (Clock $s.Secs) DarkGray }
      'skip' { Out-Line "  $($G.done) " DarkGray $s.Skip DarkGray }
      'now'  { Out-Line "  $($G.now) " Cyan $s.Doing.PadRight(34) White (Clock $script:stepClock.Elapsed.TotalSeconds) Cyan }
      'fail' { Out-Line "  $($G.fail) " Red $s.Doing Red }
      default { Out-Line "  $($G.todo) " DarkGray $s.Todo DarkGray }
    }
  }
  Out-Line
}
function Tick { $script:frac = Ease $script:stepClock.Elapsed.TotalSeconds $script:cur.Expected; Draw }
function Start-Step($s, $what) { $script:cur = $s; $s.State = 'now'; $script:frac = 0.0; $script:detail = $what; $script:stepClock = [Diagnostics.Stopwatch]::StartNew(); Draw }
function Complete-Step($s) { $s.Secs = $script:stepClock.Elapsed.TotalSeconds; $s.State = 'done'; $script:frac = 0.0; Draw }

function Take-Line($l, $onLine) {
  $l = ($l -replace '\x1b\[[0-9;?]*[A-Za-z]', '').TrimEnd()
  if (-not $l.Trim()) { return }
  $script:recent.Enqueue($l)
  while ($script:recent.Count -gt 12) { [void]$script:recent.Dequeue() }
  & $onLine $l.Trim()
}
# Runs a tool with output redirected to files that are read while it runs, so the window can show it.
function Run($exePath, $argList, $dir, [scriptblock]$onLine) {
  $out = "$log.out"; $err = "$log.err"
  $p = Start-Process -FilePath $exePath -ArgumentList $argList -WorkingDirectory $dir -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
  $null = $p.Handle
  $tails = foreach ($f in $out, $err) { [pscustomobject]@{ Reader = New-Object IO.StreamReader([IO.File]::Open($f, 'Open', 'Read', 'ReadWrite, Delete')); Rest = '' } }
  $script:recent.Clear()
  $exited = $false
  while (-not $exited) {
    $exited = $p.HasExited
    foreach ($t in $tails) {
      $chunk = $t.Reader.ReadToEnd()
      if (-not $chunk) { continue }
      $parts = ($t.Rest + $chunk) -split "`r?`n"
      $t.Rest = $parts[-1]
      for ($i = 0; $i -lt $parts.Count - 1; $i++) { Take-Line $parts[$i] $onLine }
    }
    if (-not $exited) { Tick; Start-Sleep -Milliseconds 150 }
  }
  foreach ($t in $tails) { if ($t.Rest) { Take-Line $t.Rest $onLine }; $t.Reader.Dispose() }
  $p.WaitForExit()
  Get-Content $out, $err -Tail 60 -ErrorAction SilentlyContinue | Out-File $log -Append -Encoding utf8
  Remove-Item $out, $err -ErrorAction SilentlyContinue
  if ($p.ExitCode -ne 0) { throw "$([IO.Path]::GetFileName($exePath)) $($argList -join ' ') failed (exit $($p.ExitCode))." }
}

function Newest($paths) {
  $items = foreach ($p in $paths) { if (Test-Path $p) { Get-ChildItem $p -Recurse -File -ErrorAction SilentlyContinue } }
  ($items | Where-Object { $_.FullName -notmatch '\\(node_modules|dist)\\' } | Measure-Object LastWriteTime -Maximum).Maximum
}
function Get-Health {
  try { Invoke-RestMethod "$base/api/health" -TimeoutSec 2 } catch { $null }
}
function Find-Window {
  Get-Process tokenhud-tray, msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle -eq 'TokenHUD' } | Select-Object -First 1
}

try {
  # Already open? Bring it to the front instead of starting a second copy.
  # (Not when the code changed since the server started: then fall through and rebuild/restart it.)
  $win = Find-Window
  $h0 = if ($win) { Get-Health }
  $fresh = $false
  if ($h0) {
    $started0 = (Get-Date).AddMilliseconds(-[double]$h0.uptimeMs)
    $fresh = (Newest @((Join-Path $root 'server'), (Join-Path $root 'src'), (Join-Path $root 'index.html'), (Join-Path $root 'package.json'))) -le $started0
  }
  if ($win -and $h0 -and $fresh) {
    Log "Already open ($($win.Id))"
    Write-Host ''
    Write-Host '  TokenHUD is already open; bringing it to the front.' -ForegroundColor Cyan
    (New-Object -ComObject WScript.Shell).AppActivate($win.Id) | Out-Null
    Start-Sleep -Milliseconds 1000
    exit 0
  }
  $Host.UI.RawUI.WindowTitle = 'Starting TokenHUD'
  Clear-Host
  try { [Console]::CursorVisible = $false } catch {}

  if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { throw 'Node.js is not installed (https://nodejs.org).' }
  $edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $edge -and -not (Get-Command cargo.exe -ErrorAction SilentlyContinue) -and -not (Test-Path (Join-Path $root 'tray\target\release\tokenhud-tray.exe'))) { throw 'Neither Rust (for the tray app) nor Microsoft Edge was found.' }

  $dist = Join-Path $root 'dist\index.html'
  $srcNewest = Newest @((Join-Path $root 'src'), (Join-Path $root 'index.html'), (Join-Path $root 'package.json'), (Join-Path $root 'vite.config.ts'), (Join-Path $root 'tsconfig.json'))
  $needInstall = -not (Test-Path (Join-Path $root 'node_modules\vite'))
  $needUi = $needInstall -or -not (Test-Path $dist) -or $srcNewest -gt (Get-Item $dist).LastWriteTime

  if ($needInstall) { $sInstall = Add-Step 'Install packages' 'Installing packages' 'Installed packages' '' 60 }
  $sUi = Add-Step 'Build the interface' 'Building the interface' 'Built the interface' 'Interface is up to date' 8
  $trayExe = Join-Path $root 'tray\target\release\tokenhud-tray.exe'
  $cargo = Get-Command cargo.exe -ErrorAction SilentlyContinue
  $traySrc = Newest @((Join-Path $root 'tray\src'), (Join-Path $root 'tray\Cargo.toml'), (Join-Path $root 'tray\tauri.conf.json'), (Join-Path $root 'tray\build.rs'), (Join-Path $root 'tray\capabilities'))
  $needTray = $cargo -and ((-not (Test-Path $trayExe)) -or $traySrc -gt (Get-Item $trayExe).LastWriteTime)
  $useTray = (Test-Path $trayExe) -or $needTray
  if ($needTray) { $sTray = Add-Step 'Build the tray app' 'Building the tray app' 'Built the tray app' '' $(if (Test-Path $trayExe) { 25 } else { 130 }) }
  $sSrv = Add-Step 'Start the data server' 'Starting the data server' 'Data server is running' '' 3
  $sWin = Add-Step 'Open TokenHUD' 'Opening the TokenHUD window' 'Opened TokenHUD' '' 4
  if (-not $needUi) { $sUi.State = 'skip' }

  if ($needInstall) {
    Start-Step $sInstall 'Downloading packages (first run only)'
    Log 'npm install'
    Run 'npm.cmd' @('install', '--no-audit', '--no-fund') $root { param($l) $script:detail = $l }
    Complete-Step $sInstall
  }
  if ($needTray) {
    Start-Step $sTray 'Compiling the tray app (Rust)'
    Log 'cargo build'
    Get-Process tokenhud-tray -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Milliseconds 300
    Run 'cargo.exe' @('build', '--release', '--features', 'custom-protocol', '--color', 'never') (Join-Path $root 'tray') {
      param($l)
      if ($l -match '^\s*(Compiling|Building)\s+(\S+)') { $script:detail = "Compiling $($matches[2])" }
      elseif ($l -match 'error') { $script:detail = $l }
    }
    Complete-Step $sTray
  }
  if ($needUi) {
    Start-Step $sUi 'Checking the code (TypeScript)'
    Log 'npm run build'
    Run 'npm.cmd' @('run', 'build') $root {
      param($l)
      if ($l -match 'error TS') { $script:detail = $l }
      elseif ($l -match '^vite v') { $script:detail = 'Bundling (Vite)' }
      elseif ($l -match '(\d+) modules transformed') { $script:detail = "Bundled $($matches[1]) modules" }
      elseif ($l -match 'rendering chunks') { $script:detail = 'Writing the bundle' }
    }
    Complete-Step $sUi
  }

  # Server: reuse it only if it started after the last server/UI change; otherwise restart it.
  Start-Step $sSrv 'Checking for a running server'
  $h = Get-Health
  $stale = $false
  if ($h) {
    $startedAt = (Get-Date).AddMilliseconds(-[double]$h.uptimeMs)
    $newest = Newest @((Join-Path $root 'server'), (Join-Path $root 'dist'), (Join-Path $root 'package.json'))
    $stale = $newest -gt $startedAt
  }
  if ($h -and $stale) {
    $script:detail = 'Restarting the server with the new code'
    $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (Get-Service 'TokenHUDServer' -ErrorAction SilentlyContinue) { try { Invoke-RestMethod -Method Post "$base/api/quit" -Body '{}' -ContentType 'application/json' | Out-Null } catch {}; Start-Sleep -Milliseconds 3000 }  # service restarts itself
    elseif ($c) { $pr = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue; if ($pr -and $pr.ProcessName -in @('node', 'tokenhud-server')) { Stop-Process -Id $pr.Id -Force; Start-Sleep -Milliseconds 400 } }
    $h = $null
  }
  if (-not $h) {
    # Preferred: the labelled, self-restarting "TokenHUD Server" task (scripts/service.ps1). Fallback: a bare hidden node.
    $script:detail = 'Starting the TokenHUD Server task'
    Log 'Starting server'
    $viaTask = $false
    try {
      & (Join-Path $PSScriptRoot 'service.ps1') ensure | Out-Null
      if (Get-Service 'TokenHUDServer' -ErrorAction SilentlyContinue) { try { Start-Service 'TokenHUDServer' -ErrorAction Stop } catch {} } else { Start-ScheduledTask -TaskName 'TokenHUD Server' }
      $viaTask = $true
    } catch { Log "Service unavailable, starting node directly: $_" }
    if (-not $viaTask) { Start-Process -FilePath 'node.exe' -ArgumentList 'server/server.mjs' -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $serverLog -RedirectStandardError "$serverLog.err" }
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    while ($true) {
      $h = Get-Health
      if ($h) { if ($h.ready) { break }; $script:detail = "Reading transcripts: $($h.done) of $($h.total) files" } else { $script:detail = 'Waiting for the server' }
      if ($deadline.Elapsed.TotalSeconds -gt 60) { throw "The server did not become ready in 60 s.`r`n$(Get-Content "$serverLog.err" -Raw -ErrorAction SilentlyContinue)" }
      Tick; Start-Sleep -Milliseconds 200
    }
  }
  $script:detail = "$($h.messages) messages loaded"
  Complete-Step $sSrv

  # Window: its own Edge profile so it is a separate chromeless app window.
  if ($useTray) {
    Start-Step $sWin 'Starting the tray app'
    Log "Opening tray app $trayExe"
    Start-Process -FilePath $trayExe -ArgumentList '--open' -WorkingDirectory $root | Out-Null
  } else {
    Start-Step $sWin 'Starting Edge in app mode'
    $profile = Join-Path $data 'edge-profile'
    Log "Opening window $edge"
    Start-Process -FilePath $edge -ArgumentList "--app=$base/", "--user-data-dir=`"$profile`"", '--window-size=1500,960', '--no-first-run', '--disable-features=msEdgeSidebarV2' | Out-Null
  }
  $script:detail = 'Waiting for the window'
  while ($true) {
    if (Find-Window) { break }
    if ($stepClock.Elapsed.TotalSeconds -gt 30) { Log 'No window after 30 s'; throw 'The TokenHUD window did not open within 30 s.' }
    Tick; Start-Sleep -Milliseconds 150
  }
  Complete-Step $sWin
  $script:detail = ''
  Draw 'ok'
  Log 'Done'
  Start-Sleep -Milliseconds 900
  exit 0
}
catch {
  $msg = $_.Exception.Message
  Log "FAILED: $msg"
  if ($cur) { $cur.State = 'fail' }
  if ($steps.Count) { Draw 'fail' } else { Write-Host '' }
  try { [Console]::CursorVisible = $true } catch {}
  foreach ($line in ($msg -split "`r?`n")) { Write-Host "  $line" -ForegroundColor Red }
  if ($recent.Count) {
    Write-Host ''; Write-Host '  Last output:' -ForegroundColor Gray
    foreach ($line in $recent) { Write-Host "    $line" -ForegroundColor DarkGray }
  }
  Write-Host ''
  Write-Host "  Full log: $log" -ForegroundColor Gray
  Write-Host '  Press L to open it in Notepad, or any other key to close.' -ForegroundColor Gray
  try { if ([Console]::ReadKey($true).Key -eq 'L') { Start-Process notepad.exe $log } } catch { Start-Process notepad.exe $log }
  exit 1
}
