# win.ps1 — Hermes 桌面窗口操作：list / focus / rect / shot
# 用法: pwsh -File win.ps1 list|focus|rect|shot -Out x.png
param(
  [Parameter(Position = 0)][string]$Action = 'list',
  [string]$Out = ''
)

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinHelp {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowDC(IntPtr h);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

  public static List<string> List(uint[] pids) {
    var res = new List<string>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (Array.IndexOf(pids, pid) >= 0) {
        var t = new StringBuilder(512); GetWindowTextW(h, t, 512);
        var c = new StringBuilder(256); GetClassNameW(h, c, 256);
        RECT r; GetWindowRect(h, out r);
        res.Add(h.ToInt64() + "|pid=" + pid + "|vis=" + IsWindowVisible(h) + "|min=" + IsIconic(h)
          + "|cls=" + c + "|title=" + t + "|rect=" + r.L + "," + r.T + "," + r.R + "," + r.B);
      }
      return true;
    }, IntPtr.Zero);
    return res;
  }
}
'@

$pids = @()
Get-Process Hermes -ErrorAction SilentlyContinue | ForEach-Object { $pids += [uint32]$_.Id }
if ($pids.Count -eq 0) { Write-Output 'no Hermes process'; exit 1 }

$wins = [WinHelp]::List($pids)
$main = $wins | Where-Object { $_ -match 'cls=Chrome_WidgetWin_1' } | Select-Object -First 1
if (-not $main) { Write-Output 'no main window'; $wins; exit 1 }

$hwnd = [IntPtr][int64]($main.Split('|')[0])
$rect = $main.Split('|')[-1]

switch ($Action) {
  'list' { $wins }
  'focus' {
    [WinHelp]::ShowWindow($hwnd, 9) | Out-Null
    [WinHelp]::BringWindowToTop($hwnd) | Out-Null
    [WinHelp]::SetForegroundWindow($hwnd) | Out-Null
    Start-Sleep -Milliseconds 500
    "hwnd=$($hwnd.ToInt64()) foreground=$([WinHelp]::GetForegroundWindow().ToInt64()) match=$([WinHelp]::GetForegroundWindow() -eq $hwnd)"
  }
  'rect' { "hwnd=$($hwnd.ToInt64()) $rect" }
  'shot' {
    if (-not $Out) { $Out = 'shot.png' }
    [WinHelp]::ShowWindow($hwnd, 9) | Out-Null
    [WinHelp]::SetForegroundWindow($hwnd) | Out-Null
    Start-Sleep -Milliseconds 700
    $r = New-Object WinHelp+RECT
    [WinHelp]::GetWindowRect($hwnd, [ref]$r) | Out-Null
    $w = $r.R - $r.L; $h = $r.B - $r.T
    Add-Type -AssemblyName System.Drawing
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($r.L, $r.T, 0, 0, (New-Object System.Drawing.Size($w, $h)))
    $g.Dispose()
    $full = [IO.Path]::GetFullPath($Out)
    $bmp.Save($full, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    "saved $full ($w x $h)"
  }
}
