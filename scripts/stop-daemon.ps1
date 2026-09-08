# Stops the local agent daemon (matches node processes running local-daemon.ts).
# Run from executive-os/:  npm run agent:daemon:stop
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*local-daemon.ts*" }

if ($procs) {
  $procs | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force
    Write-Host "Stopped daemon pid $($_.ProcessId)"
  }
} else {
  Write-Host "No daemon process running."
}
