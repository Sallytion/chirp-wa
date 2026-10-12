param(
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [Parameter(Mandatory = $true)][string]$CliPath,
  [int]$IntervalMs = 500,
  [int]$MaximumSeconds = 240
)

$ErrorActionPreference = 'Stop'
$taskDeadline = [DateTime]::UtcNow.AddSeconds($MaximumSeconds)
$taskPid = $null
$taskFirstSeen = $null
$taskLastReport = [DateTime]::MinValue
$taskMissing = 0
$taskSamples = 0
$taskPeakWorkingSet = 0L
$taskPeakPrivate = 0L
$taskCliNormalized = $CliPath.Replace('\', '/').ToLowerInvariant()
$taskWriter = [System.IO.StreamWriter]::new([System.IO.Path]::GetFullPath($OutputPath), $false, [System.Text.UTF8Encoding]::new($false))
$taskWriter.AutoFlush = $true
$taskWriter.WriteLine('timestamp_utc,elapsed_seconds,pid,working_set_bytes,private_bytes,peak_working_set_bytes,cpu_milliseconds')

try {
  Write-Output ('{"event":"sampler-ready","interval_ms":' + $IntervalMs + '}')
  while ([DateTime]::UtcNow -lt $taskDeadline) {
    if ($null -eq $taskPid) {
      $taskCandidate = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine.Replace('\', '/').ToLowerInvariant().Contains($taskCliNormalized) -and $_.CommandLine -notmatch '(?:compare-live|run-live)\.mjs' } |
        Sort-Object CreationDate -Descending | Select-Object -First 1
      if ($null -ne $taskCandidate) {
        $taskPid = [int]$taskCandidate.ProcessId
        $taskFirstSeen = [DateTime]::UtcNow
        Write-Output ([pscustomobject]@{event='chirp-found';pid=$taskPid;timestamp_utc=$taskFirstSeen.ToString('o')} | ConvertTo-Json -Compress)
      }
    }
    if ($null -ne $taskPid) {
      $taskProcess = Get-Process -Id $taskPid -ErrorAction SilentlyContinue
      if ($null -eq $taskProcess -or $taskProcess.HasExited) {
        $taskMissing++
        if ($taskMissing -ge 3) { break }
      } else {
        $taskMissing = 0
        $taskNow = [DateTime]::UtcNow
        $taskWorkingSet = [long]$taskProcess.WorkingSet64
        $taskPrivate = [long]$taskProcess.PrivateMemorySize64
        $taskLifetimePeak = [long]$taskProcess.PeakWorkingSet64
        $taskPeakWorkingSet = [Math]::Max($taskPeakWorkingSet, $taskLifetimePeak)
        $taskPeakPrivate = [Math]::Max($taskPeakPrivate, $taskPrivate)
        $taskElapsed = ($taskNow - $taskFirstSeen).TotalSeconds
        $taskCpu = $taskProcess.TotalProcessorTime.TotalMilliseconds
        $taskWriter.WriteLine(('{0},{1:F3},{2},{3},{4},{5},{6:F3}' -f $taskNow.ToString('o'), $taskElapsed, $taskPid, $taskWorkingSet, $taskPrivate, $taskLifetimePeak, $taskCpu))
        $taskSamples++
        if (($taskNow - $taskLastReport).TotalSeconds -ge 5) {
          Write-Output ([pscustomobject]@{event='memory';timestamp_utc=$taskNow.ToString('o');elapsed_seconds=[Math]::Round($taskElapsed,1);pid=$taskPid;working_set_mib=[Math]::Round($taskWorkingSet/1MB,2);private_mib=[Math]::Round($taskPrivate/1MB,2);peak_working_set_mib=[Math]::Round($taskLifetimePeak/1MB,2)} | ConvertTo-Json -Compress)
          $taskLastReport = $taskNow
        }
      }
    }
    Start-Sleep -Milliseconds $IntervalMs
  }
  Write-Output ([pscustomobject]@{event='sampler-finished';pid=$taskPid;samples=$taskSamples;timestamp_utc=[DateTime]::UtcNow.ToString('o');peak_working_set_mib=[Math]::Round($taskPeakWorkingSet/1MB,2);peak_private_mib=[Math]::Round($taskPeakPrivate/1MB,2)} | ConvertTo-Json -Compress)
} finally { $taskWriter.Dispose() }
