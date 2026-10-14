# stop-pet.ps1 - stop the packaged desktop pet (dsh-pet.exe).
#
# The packaged app has no window close button and no "quit" item in its context menu,
# so it exits via POST /shutdown to the embedded host.
# Ports start at 3080 and the service scans forward when occupied, so try each one
# until some port answers 200.
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 as ANSI unless the
# file carries a UTF-8 BOM, so non-ASCII comments would be mangled into a parse error.
$ports = 3080..3104
foreach ($p in $ports) {
  try {
    $r = Invoke-WebRequest -Method POST -Uri "http://127.0.0.1:$p/shutdown" -TimeoutSec 2 -UseBasicParsing
    if ($r.StatusCode -eq 200) {
      Write-Host "[dsh-pet] shutdown request sent to port $p"
      exit 0
    }
  } catch {
    # nothing listening on this port - try the next one
  }
}
Write-Host "[dsh-pet] no running dsh-pet found on ports 3080-3104"
exit 1
