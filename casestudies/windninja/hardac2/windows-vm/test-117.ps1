<#
WindNinja #117: are solver processes left running when WindNinja stops in the middle of a
momentum-solver run? This script tests the command-line program: it starts a run, waits until
a solver process appears, then stops WindNinja_cli and checks which solver processes are still
running 30 seconds and 5 minutes later. The GUI Cancel button is a separate manual check
(see README.md), because the GUI cancels differently from a stopped process.

Run in the Windows VM:
  powershell -ExecutionPolicy Bypass -File test-117.ps1
Options: -CliPath <WindNinja_cli.exe> -DemPath <dem.tif> -Tries 3 -Results <folder>
#>
param(
  [string]$CliPath = "",
  [string]$DemPath = "",
  [int]$Tries = 3,
  [string]$Results = "$env:USERPROFILE\wn-results\117",
  [int]$WaitForSolverSec = 1200
)
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
New-Item -ItemType Directory -Force -Path $Results | Out-Null
Start-Transcript -Path (Join-Path $Results "transcript.txt") -Append | Out-Null

# Programs WindNinja's momentum solver starts (from src/ninja/ninjafoam.cpp), plus the MPI helper.
$SolverNames = @('simpleFoam','moveDynamicMesh','blockMesh','snappyHexMesh','applyInit','decomposePar',
                 'reconstructPar','refineMesh','renumberMesh','topoSet','sample','mpiexec','smpd')

function Get-Solvers { Get-Process -ErrorAction SilentlyContinue | Where-Object { $SolverNames -contains $_.ProcessName } }

function Find-Cli {
  if ($CliPath) { return (Resolve-Path $CliPath).Path }
  foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if (-not $root -or -not (Test-Path $root)) { continue }
    $hit = Get-ChildItem -Path $root -Filter 'WindNinja_cli.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  return $null
}

$cli = Find-Cli
if (-not $cli) {
  Write-Host "WindNinja is not installed. Looking up the latest release on GitHub..."
  $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/firelab/windninja/releases/latest'
  $asset = $rel.assets | Where-Object { $_.name -like '*.exe' } | Select-Object -First 1
  if (-not $asset) { throw "No .exe installer in release $($rel.tag_name). Download one from https://github.com/firelab/windninja/releases and rerun." }
  $setup = Join-Path $Results $asset.name
  Write-Host "Downloading $($asset.name) from release $($rel.tag_name)..."
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $setup
  Write-Host "Starting the installer. Finish it, then this script continues."
  Start-Process -FilePath $setup -Wait
  $cli = Find-Cli
  if (-not $cli) { throw "WindNinja_cli.exe still not found. Pass -CliPath." }
}
$installRoot = Split-Path (Split-Path $cli)
& $cli --version 2>&1 | Out-File (Join-Path $Results 'version.txt')
Write-Host "Using $cli"
Get-Content (Join-Path $Results 'version.txt') | Write-Host

if (-not $DemPath) {
  $dem = Get-ChildItem -Path $installRoot -Recurse -Include 'big_butte_small.tif','big_butte.tif' -ErrorAction SilentlyContinue | Sort-Object Length | Select-Object -First 1
  if (-not $dem) { throw "No example DEM found under $installRoot. Pass -DemPath." }
  $DemPath = $dem.FullName
}
Write-Host "Using DEM $DemPath"

$before = @(Get-Solvers | ForEach-Object { $_.Id })
$summary = @()

for ($i = 1; $i -le $Tries; $i++) {
  # Try 1 stops WindNinja at the first solver process, try 2 once simpleFoam runs, try 3 60 s into simpleFoam.
  $dir = Join-Path $Results "try$i"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Copy-Item $DemPath $dir   # NinjaFOAM writes its case folder next to the DEM
  $demCopy = Join-Path $dir (Split-Path $DemPath -Leaf)
  $cfg = Join-Path $dir 'run.cfg'
  @"
num_threads              = 1
elevation_file           = $demCopy
initialization_method    = domainAverageInitialization
input_speed              = 10.0
input_speed_units        = mph
input_direction          = 270.0
input_wind_height        = 20.0
units_input_wind_height  = ft
output_wind_height       = 20.0
units_output_wind_height = ft
vegetation               = grass
momentum_flag            = true
mesh_choice              = coarse
write_ascii_output       = true
output_path              = $dir
"@ | Set-Content -Path $cfg -Encoding ASCII

  $p = Start-Process -FilePath $cli -ArgumentList "`"$cfg`"" -WorkingDirectory $dir -PassThru `
       -RedirectStandardOutput (Join-Path $dir 'stdout.log') -RedirectStandardError (Join-Path $dir 'stderr.log')
  $t0 = Get-Date; $seen = $null; $simpleSince = $null
  while (((Get-Date) - $t0).TotalSeconds -lt $WaitForSolverSec -and -not $p.HasExited) {
    $now = @(Get-Solvers | Where-Object { $before -notcontains $_.Id })
    $simple = $now | Where-Object { $_.ProcessName -eq 'simpleFoam' }
    if ($simple -and -not $simpleSince) { $simpleSince = Get-Date }
    if ($i -eq 1 -and $now.Count -gt 0) { $seen = $now; break }
    if ($i -eq 2 -and $simple) { $seen = $now; break }
    if ($i -eq 3 -and $simpleSince -and ((Get-Date) - $simpleSince).TotalSeconds -ge 60) { $seen = $now; break }
    Start-Sleep -Seconds 2
  }
  if (-not $seen) {
    $why = if ($p.HasExited) { "WindNinja_cli exited (code $($p.ExitCode)) before the stop point" } else { "no solver process within $WaitForSolverSec s" }
    Write-Host "try${i}: not tested, $why"
    if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force }
    $summary += [pscustomobject]@{ try=$i; stopped_at=''; left_after_30s=''; left_after_300s=''; result="not tested: $why" }
    continue
  }
  $tree = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine
  $tree | Export-Csv (Join-Path $dir 'processes_before_stop.csv') -NoTypeInformation
  $stoppedAt = ($seen | ForEach-Object { $_.ProcessName } | Sort-Object -Unique) -join '+'
  Write-Host "try${i}: stopping WindNinja_cli (pid $($p.Id)) while running: $stoppedAt"
  Stop-Process -Id $p.Id -Force

  Start-Sleep -Seconds 30
  $left30 = @(Get-Solvers | Where-Object { $before -notcontains $_.Id })
  $left30 | Select-Object Id,ProcessName,StartTime | Export-Csv (Join-Path $dir 'left_after_30s.csv') -NoTypeInformation
  Start-Sleep -Seconds 270
  $left300 = @(Get-Solvers | Where-Object { $before -notcontains $_.Id })
  $left300 | Select-Object Id,ProcessName,StartTime | Export-Csv (Join-Path $dir 'left_after_300s.csv') -NoTypeInformation

  $names30 = ($left30 | ForEach-Object { $_.ProcessName } | Sort-Object -Unique) -join '+'
  $names300 = ($left300 | ForEach-Object { $_.ProcessName } | Sort-Object -Unique) -join '+'
  $result = if ($left300.Count -gt 0) { 'Reproduces' } else { 'Does not reproduce' }
  Write-Host "try${i}: after 30 s: [$names30]  after 5 min: [$names300]  => $result"
  $summary += [pscustomobject]@{ try=$i; stopped_at=$stoppedAt; left_after_30s=$names30; left_after_300s=$names300; result=$result }
  # Clean up so the next try starts clean.
  $left300 | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
}

$summary | Export-Csv (Join-Path $Results 'summary.csv') -NoTypeInformation
$summary | Format-Table -AutoSize | Out-String | Write-Host
Write-Host "Results in $Results"
Stop-Transcript | Out-Null
