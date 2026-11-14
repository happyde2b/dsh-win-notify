# dsh-win-notify - show a Windows system Toast notification (bottom-right
# corner, Windows notification center).
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File toast.ps1 -XmlPath <toast.xml> [-ClickUrl <url>] [-DesktopAumid <aumid>]
#
# Windows 10/11 requires an AppUserModelID (AUMID) for toast notifications from
# unpackaged apps. Candidate order: the DeepSeek Harness desktop app's AUMID
# (so the toast is attributed to it), our own "DSH.Notify" shortcut, the
# built-in Windows PowerShell AUMID, then the empty app id. Whichever works is
# used; the notification itself is identical.
#
# Clicking the toast activates the dsh-desktop:// protocol (registered under
# HKCU, handler = open-desktop.ps1), which focuses the running DeepSeek Harness
# desktop window or launches the app. If the protocol cannot be registered,
# the toast falls back to a protocol launch of ClickUrl.
#
# NOTE on the shortcut target: the .lnk is only a registration stub - Windows
# never actually launches it. It therefore points at explorer.exe with no
# arguments. Pointing it at powershell.exe with "-NoProfile -WindowStyle
# Hidden" (an earlier version) matched the classic malware pattern
# "LNK -> hidden PowerShell", so Windows Defender's heuristic
# (HEUR:Trojan/LNK.Agent.b) flagged and deleted it. Do not change it back.
#
# NOTE: this file must stay pure ASCII. Windows PowerShell 5.1 reads .ps1 files
# in the system ANSI codepage (GBK on this machine); UTF-8 non-ASCII comment
# bytes get misread and can swallow the following newline, breaking the parse.
param(
  [Parameter(Mandatory = $true)][string]$XmlPath,
  [string]$ClickUrl = '',
  [string]$DesktopAumid = 'com.deepseek.harness'
)

$ErrorActionPreference = 'Stop'

$Aumid = 'DSH.Notify'
$ShortcutName = 'DSH Notifications.lnk'
$PowerShellAumid = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'

# C# interop used only to create the AUMID shortcut (first run only):
# IShellLinkW + IPropertyStore are vtable-only COM interfaces, which is why
# the whole helper lives in compiled C# instead of PowerShell late binding
# (PowerShell cannot cast __ComObject to a custom ComImport interface).
$AumidShortcutSource = @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

public static class DshAumidShortcut {
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    private class ShellLink { }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
    private interface IShellLinkW {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszFile, int cch, IntPtr pfd, uint fFlags);
        void GetIDList(out IntPtr ppidl);
        void SetIDList(IntPtr pidl);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszName, int cch);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszDir, int cch);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszArgs, int cch);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
        void GetHotkey(out ushort pwHotkey);
        void SetHotkey(ushort wHotkey);
        void GetShowCmd(out int piShowCmd);
        void SetShowCmd(int iShowCmd);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszIconPath, int cch, out int piIcon);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, uint dwReserved);
        void Resolve(IntPtr hwnd, uint fFlags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
    private interface IPropertyStore {
        int GetCount(out uint cProps);
        int GetAt(uint iProp, out PropertyKey pkey);
        int GetValue(ref PropertyKey key, out PropVariant pv);
        int SetValue(ref PropertyKey key, ref PropVariant pv);
        int Commit();
    }

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    private struct PropertyKey {
        public Guid fmtid;
        public uint pid;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct PropVariant {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public IntPtr pointerValue;
    }

    public static void Create(string shortcutPath, string targetPath, string targetArgs, string aumid) {
        object raw = new ShellLink();
        var link = (IShellLinkW)raw;
        link.SetPath(targetPath);
        link.SetArguments(targetArgs);
        link.SetDescription("DSH notifications");
        ((IPersistFile)raw).Save(shortcutPath, true);
        var store = (IPropertyStore)raw;
        var key = new PropertyKey {
            fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"),
            pid = 5 // PKEY_AppUserModel_ID
        };
        var value = new PropVariant {
            vt = 31, // VT_LPWSTR
            pointerValue = Marshal.StringToCoTaskMemUni(aumid)
        };
        try {
            store.SetValue(ref key, ref value);
            store.Commit();
        } finally {
            Marshal.FreeCoTaskMem(value.pointerValue);
        }
    }
}
'@

# Ensure the Start Menu shortcut with our AUMID exists; returns its path.
# Benign target (explorer.exe, no arguments) on purpose - see the note above.
function Ensure-AumidShortcut([string]$Aumid) {
  $startMenu = [Environment]::GetFolderPath('Programs')
  $shortcutPath = Join-Path $startMenu $ShortcutName
  $explorer = Join-Path $env:SystemRoot 'explorer.exe'
  if (Test-Path -LiteralPath $shortcutPath) {
    # Rebuild stale (old powershell.exe target) or corrupt shortcuts.
    try {
      $existing = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcutPath)
      if ($existing.TargetPath -ieq $explorer) { return $shortcutPath }
    } catch { }
    Remove-Item -LiteralPath $shortcutPath -Force -ErrorAction SilentlyContinue
  }
  Add-Type -TypeDefinition $AumidShortcutSource
  [DshAumidShortcut]::Create($shortcutPath, $explorer, '', $Aumid)
  return $shortcutPath
}

# Register the dsh-desktop:// URL protocol (HKCU) pointing at open-desktop.ps1,
# so clicking a toast can open/focus the desktop window. The URL Protocol
# marker is required for Windows to recognize the scheme. Returns $true when
# the protocol is ready; failure (e.g. restricted environment) falls back to
# the browser ClickUrl.
function Ensure-DesktopProtocol {
  try {
    $script = Join-Path $PSScriptRoot 'open-desktop.ps1'
    if (-not (Test-Path -LiteralPath $script)) { return $false }
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $command = '"' + $powershell + '" -NoProfile -ExecutionPolicy Bypass -File "' + $script + '"'
    $protoKey = 'HKCU:\Software\Classes\dsh-desktop'
    $commandKey = $protoKey + '\shell\open\command'
    $existing = Get-ItemProperty -Path $commandKey -ErrorAction SilentlyContinue
    if ($existing -and [string]$existing.'(default)' -eq $command) {
      $proto = Get-ItemProperty -Path $protoKey -ErrorAction SilentlyContinue
      if ($proto -and $proto.'URL Protocol' -ne $null) { return $true }
    }
    New-Item -Path $commandKey -Force | Out-Null
    Set-ItemProperty -Path $commandKey -Name '(default)' -Value $command
    Set-ItemProperty -Path $protoKey -Name 'URL Protocol' -Value ''
    Set-ItemProperty -Path $protoKey -Name '(default)' -Value 'URL:dsh-desktop Protocol'
    return $true
  } catch {
    return $false
  }
}

# Show the toast, trying candidate AUMIDs in order until one works.
# Click behavior uses protocol activation (reliable for unpackaged apps,
# unlike foreground AUMID activation, which silently does nothing when the
# AUMID has no registered activator): when the dsh-desktop:// protocol is
# registered the toast launches it; otherwise it falls back to ClickUrl.
function Show-Toast([string]$XmlText) {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
  $useProtocol = Ensure-DesktopProtocol
  $candidates = @()
  if ($DesktopAumid) { $candidates += $DesktopAumid }
  $candidates += @($Aumid, $PowerShellAumid, '')
  foreach ($appId in $candidates) {
    try {
      $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
      $doc.LoadXml($XmlText)
      if ($useProtocol) {
        $doc.DocumentElement.SetAttribute('launch', 'dsh-desktop://open')
        $doc.DocumentElement.SetAttribute('activationType', 'protocol')
      } elseif ($ClickUrl) {
        $doc.DocumentElement.SetAttribute('launch', $ClickUrl)
        $doc.DocumentElement.SetAttribute('activationType', 'protocol')
      }
      $toast = [Windows.UI.Notifications.ToastNotification]::new($doc)
      $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
      $notifier.Show($toast)
      return
    } catch { }
  }
  throw 'no toast-capable AUMID available'
}

function Show-Fallback([string]$XmlText) {
  $texts = @()
  try {
    $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
    $doc.LoadXml($XmlText)
    foreach ($node in $doc.GetElementsByTagName('text')) { $texts += $node.InnerText }
  } catch { }
  $body = if ($texts.Count -gt 0) { $texts -join ' - ' } else { 'DSH notification' }
  try {
    $user = [Environment]::UserName
    & msg.exe $user /TIME:60 $body 2>$null
    if ($LASTEXITCODE -eq 0) { return }
  } catch { }
  [Console]::Beep(1000, 300) | Out-Null
  throw "toast failed: $_"
}

try {
  $xmlText = [System.IO.File]::ReadAllText($XmlPath, [System.Text.Encoding]::UTF8)
  try {
    Ensure-AumidShortcut -Aumid $Aumid | Out-Null
    Show-Toast $xmlText
  } catch {
    # A stale or missing shortcut can break the primary AUMID; rebuild once and retry.
    $startMenu = [Environment]::GetFolderPath('Programs')
    $shortcutPath = Join-Path $startMenu $ShortcutName
    if (Test-Path -LiteralPath $shortcutPath) { Remove-Item -LiteralPath $shortcutPath -Force }
    try { Ensure-AumidShortcut -Aumid $Aumid | Out-Null } catch { }
    Show-Toast $xmlText
  }
} catch {
  try { Show-Fallback $xmlText } catch { }
  exit 1
}
exit 0
