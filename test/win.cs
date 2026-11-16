// win.js — list / focus / screenshot helper for the Hermes desktop window
// usage: node win.js list | focus | shot=<out.png>
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
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
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

static class P {
  static void Main(string[] a) {
    var pids = new List<uint>();
    foreach (var p in System.Diagnostics.Process.GetProcessesByName("Hermes")) pids.Add((uint)p.Id);
    var all = WinHelp.List(pids.ToArray());
    if (a.Length == 0 || a[0] == "list") { foreach (var s in all) Console.WriteLine(s); return; }
    if (a[0].StartsWith("focus")) {
      long target = a.Length > 1 ? long.Parse(a[1]) : 0;
      long best = 0;
      foreach (var s in all) {
        var parts = s.Split('|');
        if (!parts[1].Contains("vis=True")) continue;
        if (!parts[4].Contains("Chrome_WidgetWin_1")) continue;
        best = long.Parse(parts[0]);
        if (target == 0 || best == target) break;
      }
      if (best == 0) { Console.WriteLine("no visible window"); return; }
      var h = new IntPtr(best);
      WinHelp.ShowWindow(h, 9); // SW_RESTORE
      WinHelp.SetForegroundWindow(h);
      System.Threading.Thread.Sleep(400);
      Console.WriteLine("focused hwnd=" + best + " foreground=" + WinHelp.GetForegroundWindow().ToInt64());
      return;
    }
  }
}
