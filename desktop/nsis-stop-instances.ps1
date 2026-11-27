param(
  [ValidateSet('inspect', 'stop')]
  [string]$Mode = 'inspect',
  [string]$DirsJoined = '',
  [switch]$IncludeHolders,
  [int]$CallerPid = 0,
  [string]$StatusFile = ''
)

$ErrorActionPreference = 'Stop'

function Write-Phase {
  param([string]$Phase)
  if ([string]::IsNullOrWhiteSpace($StatusFile)) {
    return
  }
  try {
    [System.IO.File]::WriteAllText($StatusFile, $Phase, [System.Text.Encoding]::ASCII)
  } catch { }
}

function Resolve-TargetRoots {
  param([string]$Raw)
  $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
  $roots = New-Object 'System.Collections.Generic.List[string]'
  if ([string]::IsNullOrWhiteSpace($Raw)) {
    return $roots
  }
  foreach ($part in ($Raw -split ';')) {
    $trimmed = $part.Trim().Trim('"')
    while ($trimmed.Length -gt 3 -and $trimmed.EndsWith('\')) {
      $trimmed = $trimmed.Substring(0, $trimmed.Length - 1)
    }
    if ($trimmed.Length -lt 4) {
      continue
    }
    if ($trimmed.StartsWith('\\')) {
      continue
    }
    if ($trimmed -notmatch '^[A-Za-z]:\\') {
      continue
    }
    $candidates = New-Object 'System.Collections.Generic.List[string]'
    $candidates.Add($trimmed)
    $leaf = [System.IO.Path]::GetFileName($trimmed)
    if ($leaf -and -not $leaf.Equals('Codex Mobile Bridge', [System.StringComparison]::OrdinalIgnoreCase)) {
      $nested = Join-Path $trimmed 'Codex Mobile Bridge'
      if (Test-Path -LiteralPath $nested -PathType Container) {
        $candidates.Add($nested)
      }
    }
    foreach ($candidate in $candidates) {
      $normalized = $candidate.TrimEnd('\') + '\'
      if ($normalized.Length -lt 5) {
        continue
      }
      if ($seen.Add($normalized)) {
        $roots.Add($normalized)
      }
    }
  }
  return $roots
}

$script:TargetRoots = New-Object 'System.Collections.Generic.List[string]'
foreach ($item in @(Resolve-TargetRoots -Raw $DirsJoined)) {
  if ($item -is [string] -and $item.Length -ge 5 -and ($item -match '^[A-Za-z]:\\')) {
    $script:TargetRoots.Add($item)
  }
}
if ($script:TargetRoots.Count -eq 0) {
  exit 0
}

$script:SessionId = (Get-Process -Id $PID).SessionId

function Test-UnderTargetRoots {
  param([string]$ExecutablePath)
  if ([string]::IsNullOrWhiteSpace($ExecutablePath)) {
    return $false
  }
  foreach ($root in $script:TargetRoots) {
    if ([string]::IsNullOrWhiteSpace($root) -or $root.Length -lt 5) {
      continue
    }
    if ($ExecutablePath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
  }
  return $false
}

function Get-LockState {
  $all = @(Get-CimInstance -ClassName Win32_Process | Where-Object { [int]$_.SessionId -eq $script:SessionId })
  $byPid = @{}
  foreach ($proc in $all) {
    $byPid[[int]$proc.ProcessId] = $proc
  }

  $protected = New-Object 'System.Collections.Generic.HashSet[int]'
  foreach ($seed in @($PID, $CallerPid)) {
    $cur = [int]$seed
    $depth = 0
    while ($cur -gt 0 -and $depth -lt 32) {
      if (-not $protected.Add($cur)) {
        break
      }
      if (-not $byPid.ContainsKey($cur)) {
        break
      }
      $cur = [int]$byPid[$cur].ParentProcessId
      $depth++
    }
  }

  $direct = New-Object 'System.Collections.Generic.List[object]'
  foreach ($proc in $all) {
    $procId = [int]$proc.ProcessId
    if ($protected.Contains($procId)) {
      continue
    }
    $exe = [string]$proc.ExecutablePath
    if (-not (Test-UnderTargetRoots -ExecutablePath $exe)) {
      continue
    }
    $leaf = [System.IO.Path]::GetFileName($exe)
    if ($leaf -like 'Uninstall *.exe' -and $protected.Contains([int]$proc.ParentProcessId)) {
      continue
    }
    $direct.Add($proc)
  }

  $codexPaths = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
  $zcodePaths = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)

  foreach ($proc in $direct) {
    $leaf = [System.IO.Path]::GetFileName([string]$proc.ExecutablePath).ToLowerInvariant()
    if ($leaf -ne 'codex-mobile-gateway.exe' -and $leaf -ne 'codex-launcher.exe') {
      continue
    }
    $visited = New-Object 'System.Collections.Generic.HashSet[int]'
    $curPid = [int]$proc.ParentProcessId
    $hops = 0
    while ($curPid -gt 0 -and $hops -lt 12) {
      if (-not $visited.Add($curPid) -or -not $byPid.ContainsKey($curPid)) {
        break
      }
      $anc = $byPid[$curPid]
      $ancExe = [string]$anc.ExecutablePath
      if ([string]::IsNullOrWhiteSpace($ancExe)) {
        $curPid = [int]$anc.ParentProcessId
        $hops++
        continue
      }
      $ancLeaf = [System.IO.Path]::GetFileName($ancExe).ToLowerInvariant()
      if ((Test-UnderTargetRoots -ExecutablePath $ancExe) -or $ancLeaf -eq 'codex-launcher.exe') {
        $curPid = [int]$anc.ParentProcessId
        $hops++
        continue
      }
      if ($ancLeaf -eq 'chatgpt.exe' -or $ancLeaf -eq 'codex.exe') {
        $null = $codexPaths.Add($ancExe)
      } elseif ($ancLeaf -eq 'zcode.exe') {
        $null = $zcodePaths.Add($ancExe)
      }
      break
    }
  }

  $holderProcs = New-Object 'System.Collections.Generic.List[object]'
  if ($codexPaths.Count -gt 0 -or $zcodePaths.Count -gt 0) {
    foreach ($proc in $all) {
      $procId = [int]$proc.ProcessId
      if ($protected.Contains($procId)) {
        continue
      }
      $exe = [string]$proc.ExecutablePath
      if ([string]::IsNullOrWhiteSpace($exe)) {
        continue
      }
      if ($codexPaths.Contains($exe) -or $zcodePaths.Contains($exe)) {
        $holderProcs.Add($proc)
      }
    }
  }

  $hasCodex = $codexPaths.Count -gt 0
  $hasZCode = $zcodePaths.Count -gt 0
  $code = 0
  if ($direct.Count -gt 0 -or $hasCodex -or $hasZCode) {
    if ($hasCodex -and $hasZCode) {
      $code = 22
    } elseif ($hasCodex) {
      $code = 20
    } elseif ($hasZCode) {
      $code = 21
    } else {
      $code = 10
    }
  }

  return [pscustomobject]@{
    Direct      = $direct
    HasCodex    = $hasCodex
    HasZCode    = $hasZCode
    HolderProcs = $holderProcs
    Protected   = $protected
    Code        = $code
  }
}

function Extract-DataDir {
  param([string]$CommandLine)
  if ([string]::IsNullOrWhiteSpace($CommandLine)) {
    return $null
  }
  if ($CommandLine -notmatch '(?i)(?:^|\s)serve(?:\s|$)') {
    return $null
  }
  if ($CommandLine -match '--data-dir(?:=|\s+)"([^"]+)"') {
    return $Matches[1]
  }
  if ($CommandLine -match "--data-dir(?:=|\s+)([^\s""]+)") {
    return $Matches[1]
  }
  return $null
}

function Test-PidAlive {
  param([int]$ProcessId)
  $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  return $null -ne $proc
}

Write-Phase 'INSPECTING'
try {
  $state = Get-LockState
} catch {
  exit 2
}

if ($Mode -eq 'inspect') {
  exit $state.Code
}

if ($state.Code -eq 0) {
  Write-Phase 'DONE'
  exit 0
}

if (($state.HasCodex -or $state.HasZCode) -and -not $IncludeHolders) {
  exit $state.Code
}

# Stop external desktop holders (ChatGPT.exe / Codex.exe / ZCode.exe) BEFORE
# stopping gateway workers so they do not respawn codex-mobile-gateway.exe.
if ($IncludeHolders -and $state.HolderProcs.Count -gt 0) {
  Write-Phase 'STOPPING_HOLDERS'
  $holderImageSet = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
  $holderPids = New-Object 'System.Collections.Generic.List[int]'
  foreach ($hp in $state.HolderProcs) {
    $null = $holderImageSet.Add([string]$hp.ExecutablePath)
    $holderPids.Add([int]$hp.ProcessId)
  }

  foreach ($hpId in $holderPids) {
    try {
      $gp = Get-Process -Id $hpId -ErrorAction SilentlyContinue
      if ($gp -and $gp.MainWindowHandle -ne [IntPtr]::Zero) {
        $null = $gp.CloseMainWindow()
      }
    } catch { }
  }

  $deadline = (Get-Date).AddSeconds(4)
  while ((Get-Date) -lt $deadline) {
    $anyAlive = $false
    foreach ($hpId in $holderPids) {
      if (Test-PidAlive -ProcessId $hpId) {
        $anyAlive = $true
        break
      }
    }
    if (-not $anyAlive) {
      break
    }
    Start-Sleep -Milliseconds 250
  }

  $remainingHolders = @(Get-CimInstance -ClassName Win32_Process | Where-Object {
    [int]$_.SessionId -eq $script:SessionId -and
    $_.ExecutablePath -and
    $holderImageSet.Contains([string]$_.ExecutablePath) -and
    (-not $state.Protected.Contains([int]$_.ProcessId))
  })
  foreach ($hp in $remainingHolders) {
    try {
      Stop-Process -Id ([int]$hp.ProcessId) -Force -ErrorAction SilentlyContinue
    } catch { }
  }

  $waitDeadline = (Get-Date).AddSeconds(5)
  while ((Get-Date) -lt $waitDeadline) {
    $still = @(Get-CimInstance -ClassName Win32_Process | Where-Object {
      [int]$_.SessionId -eq $script:SessionId -and
      $_.ExecutablePath -and
      $holderImageSet.Contains([string]$_.ExecutablePath) -and
      (-not $state.Protected.Contains([int]$_.ProcessId))
    })
    if ($still.Count -eq 0) {
      break
    }
    Start-Sleep -Milliseconds 250
  }
}

# Refresh state before attempting graceful gateway stop.
Write-Phase 'STOPPING_GATEWAY'
try {
  $state = Get-LockState
} catch {
  exit 2
}

$servePids = New-Object 'System.Collections.Generic.List[int]'
foreach ($proc in $state.Direct) {
  $leaf = [System.IO.Path]::GetFileName([string]$proc.ExecutablePath)
  if ($leaf.Equals('codex-mobile-gateway.exe', [System.StringComparison]::OrdinalIgnoreCase)) {
    $dataDir = Extract-DataDir -CommandLine ([string]$proc.CommandLine)
    if (-not [string]::IsNullOrWhiteSpace($dataDir)) {
      $servePids.Add([int]$proc.ProcessId)
      try {
        $stopper = Start-Process -FilePath ([string]$proc.ExecutablePath) -ArgumentList @('stop', '--data-dir', $dataDir) -WindowStyle Hidden -PassThru -ErrorAction SilentlyContinue
        if ($stopper -and -not $stopper.WaitForExit(6000)) {
          try { $stopper.Kill() } catch { }
        }
      } catch { }
    }
  }
}

if ($servePids.Count -gt 0) {
  $serveDeadline = (Get-Date).AddSeconds(2)
  while ((Get-Date) -lt $serveDeadline) {
    $anyServe = $false
    foreach ($spId in $servePids) {
      if (Test-PidAlive -ProcessId $spId) {
        $anyServe = $true
        break
      }
    }
    if (-not $anyServe) {
      break
    }
    Start-Sleep -Milliseconds 200
  }
}

# Try graceful CloseMainWindow on remaining processes under target roots, then force stop.
Write-Phase 'STOPPING_BRIDGE'
try {
  $state = Get-LockState
} catch {
  exit 2
}

foreach ($proc in $state.Direct) {
  try {
    $gp = Get-Process -Id ([int]$proc.ProcessId) -ErrorAction SilentlyContinue
    if ($gp -and $gp.MainWindowHandle -ne [IntPtr]::Zero) {
      $null = $gp.CloseMainWindow()
    }
  } catch { }
}

if ($state.Direct.Count -gt 0) {
  Start-Sleep -Milliseconds 500
}

try {
  $state = Get-LockState
} catch {
  exit 2
}

foreach ($proc in $state.Direct) {
  if ($state.Protected.Contains([int]$proc.ProcessId)) {
    continue
  }
  if (-not (Test-UnderTargetRoots -ExecutablePath ([string]$proc.ExecutablePath))) {
    continue
  }
  try {
    Stop-Process -Id ([int]$proc.ProcessId) -Force -ErrorAction SilentlyContinue
  } catch { }
}

Write-Phase 'VERIFYING'
$verifyDeadline = (Get-Date).AddSeconds(8)
while ((Get-Date) -lt $verifyDeadline) {
  try {
    $state = Get-LockState
  } catch {
    exit 2
  }
  if ($state.Direct.Count -eq 0) {
    Write-Phase 'DONE'
    exit 0
  }
  Start-Sleep -Milliseconds 250
}

try {
  $state = Get-LockState
} catch {
  exit 2
}
if ($state.Direct.Count -eq 0) {
  Write-Phase 'DONE'
  exit 0
}
if ($state.Code -gt 0) {
  exit $state.Code
}
exit 1
