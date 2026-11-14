# dsh-win-notify - open or focus the DeepSeek Harness desktop window.
# Registered as the handler for the dsh-desktop:// protocol; the system runs
# this script when the user clicks a notification toast whose launch URI is
# dsh-desktop://open.
#
# Target: the official desktop app (Electron, process name "DeepSeek Harness").
# It is NOT a browser window - the old community build launched an msedge --app
# window, and the self-compiled copies lived under D:\DeepSeekHarness, so
# neither of those is assumed here.
#
# 1) Focus an already running desktop window.
# 2) Otherwise launch via the Start Menu shortcut (the installer's, so it
#    always points at the installation in use - never a stale copy).
# 3) Otherwise the per-user install path, then the historical self-compiled
#    path under D:\DeepSeekHarness.
# 4) Otherwise any launcher shortcut in the install root (its name may be
#    non-ASCII, so it is discovered instead of hard-coded: a non-ASCII literal
#    would be mis-decoded by Windows PowerShell's ANSI script reader).
$ErrorActionPreference = 'Stop'

$appName = 'DeepSeek Harness'
$installRoot = 'D:\DeepSeekHarness'
$exeCandidates = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'),
  (Join-Path $installRoot 'DeepSeek Harness\DeepSeek Harness.exe')
)

# 1) Focus an existing desktop window (the Electron main window).
$proc = Get-Process -Name $appName -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } |
  Select-Object -First 1
if ($proc) {
  $ws = New-Object -ComObject WScript.Shell
  [void]$ws.AppActivate($proc.Id)
  exit 0
}

# 2) Launch through the installer's Start Menu shortcut.
$startMenuLnk = Join-Path ([Environment]::GetFolderPath('Programs')) 'DeepSeek Harness.lnk'
if (Test-Path -LiteralPath $startMenuLnk) {
  Start-Process -FilePath $startMenuLnk
  exit 0
}

# 3) Launch the executable from a known install path.
foreach ($exe in $exeCandidates) {
  if (Test-Path -LiteralPath $exe) {
    Start-Process -FilePath $exe
    exit 0
  }
}

# 4) Last resort: any launcher shortcut in the install root.
$lnk = Get-ChildItem -LiteralPath $installRoot -Filter '*.lnk' -File -ErrorAction SilentlyContinue |
  Select-Object -First 1
if ($lnk) {
  Start-Process -FilePath $lnk.FullName
  exit 0
}

exit 1
