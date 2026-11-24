# drive.ps1 — 在 Hermes 桌面窗口里真实输入并提交一条消息
# 用法: pwsh -File drive.ps1 -Text "..." -Shot out.png [-WaitSec 120]
param(
  [Parameter(Mandatory = $true)][string]$Text,
  [string]$Shot = '',
  [int]$WaitSec = 150,
  [int]$ClickX = 0,
  [int]$ClickY = 0
)

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinDrive {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

  public static IntPtr FindMain(uint[] pids) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (Array.IndexOf(pids, pid) < 0) return true;
      var c = new StringBuilder(256); GetClassNameW(h, c, 256);
      if (c.ToString() == "Chrome_WidgetWin_1" && IsWindowVisible(h)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(120);
    mouse_event(0x0002, 0, 0, 0, IntPtr.Zero);
    System.Threading.Thread.Sleep(60);
    mouse_event(0x0004, 0, 0, 0, IntPtr.Zero);
  }
}
'@
Add-Type -AssemblyName System.Windows.Forms
[WinDrive]::SetProcessDPIAware() | Out-Null

$pids = @()
Get-Process Hermes -ErrorAction SilentlyContinue | ForEach-Object { $pids += [uint32]$_.Id }
$h = [WinDrive]::FindMain($pids)
if ($h -eq [IntPtr]::Zero) { Write-Output 'no main window'; exit 1 }

[WinDrive]::ShowWindow($h, 9) | Out-Null
[WinDrive]::BringWindowToTop($h) | Out-Null
[WinDrive]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 700

$r = New-Object WinDrive+RECT
[WinDrive]::GetWindowRect($h, [ref]$r) | Out-Null
$cx = [int](($r.L + $r.R) / 2)
$cy = [int]($r.B - 78)
if ($ClickX -gt 0) { $cx = $ClickX }
if ($ClickY -gt 0) { $cy = $ClickY }
"window=$($r.L),$($r.T),$($r.R),$($r.B) click=$cx,$cy"

[WinDrive]::Click($cx, $cy)
Start-Sleep -Milliseconds 500

function Set-Clip([string]$v) {
  for ($i = 0; $i -lt 20; $i++) {
    try {
      [System.Windows.Forms.Clipboard]::SetText($v)
      return $true
    } catch {
      Start-Sleep -Milliseconds 250
    }
  }
  return $false
}

if (-not (Set-Clip $Text)) { Write-Output 'clipboard set failed'; exit 1 }
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait('^a')
Start-Sleep -Milliseconds 150
[System.Windows.Forms.SendKeys]::SendWait('^v')
"pasted $($Text.Length) chars; foreground=$(([WinDrive]::GetForegroundWindow() -eq $h))"
Start-Sleep -Milliseconds 600

if ($Shot) {
  Add-Type -AssemblyName System.Drawing
  $bmp = New-Object System.Drawing.Bitmap(($r.R - $r.L), ($r.B - $r.T))
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.L, $r.T, 0, 0, (New-Object System.Drawing.Size(($r.R - $r.L), ($r.B - $r.T))))
  $g.Dispose()
  $bmp.Save([IO.Path]::GetFullPath($Shot), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  "shot $Shot"
}

[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
"sent ENTER; waiting ${WaitSec}s"
Start-Sleep -Seconds $WaitSec

if ($Shot) {
  $out2 = [IO.Path]::GetFileNameWithoutExtension($Shot) + '-after.png'
  $dir = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Shot))
  $full2 = Join-Path $dir $out2
  Add-Type -AssemblyName System.Drawing
  $bmp = New-Object System.Drawing.Bitmap(($r.R - $r.L), ($r.B - $r.T))
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.L, $r.T, 0, 0, (New-Object System.Drawing.Size(($r.R - $r.L), ($r.B - $r.T))))
  $g.Dispose()
  $bmp.Save($full2, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  "shot $full2"
}
