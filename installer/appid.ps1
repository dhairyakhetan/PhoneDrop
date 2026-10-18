# Gives PhoneDrop's window its own place on the Windows taskbar.
#
# PhoneDrop's window is a Chrome or Edge "app" window, so on its own the taskbar shows the page's 16 px favicon
# blown up (blurry), and pinning it pins a browser shortcut to localhost that can't start PhoneDrop. Windows
# groups taskbar buttons by "AppUserModelID". Giving the window and PhoneDrop's shortcuts the same ID
# (PhoneDrop.App) makes the taskbar show PhoneDrop.exe's icon (icon.svg rendered at every size), and a pinned
# PhoneDrop starts PhoneDrop.exe.
#
#   -Shortcut <file.lnk>   the installer, for the Start Menu and desktop shortcuts it makes
#   -Exe <PhoneDrop.exe>   PhoneDrop, after it opens its window: waits for the window, then labels it
param([string]$Shortcut = '', [string]$Exe = '', [int]$Wait = 20)
$ErrorActionPreference = 'Stop'
$id = 'PhoneDrop.App'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

public static class PhoneDropAppId {
  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  public struct PropKey {
    public Guid fmt; public uint pid;
    public PropKey(uint p) { fmt = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"); pid = p; } // System.AppUserModel.*
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct PropVar { public ushort vt; public ushort r1, r2, r3; public IntPtr p; public IntPtr p2; }

  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPropertyStore {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int GetAt(uint i, out PropKey key);
    [PreserveSig] int GetValue(ref PropKey key, out PropVar value);
    [PreserveSig] int SetValue(ref PropKey key, ref PropVar value);
    [PreserveSig] int Commit();
  }
  [ComImport, Guid("00021401-0000-0000-C000-000000000046")] class ShellLink {}

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
  [DllImport("shell32.dll")]
  static extern int SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid iid, out IPropertyStore store);

  static void Set(IPropertyStore s, uint pid, string value) {
    PropKey k = new PropKey(pid);
    PropVar v = new PropVar(); v.vt = 31; v.p = Marshal.StringToCoTaskMemUni(value); // VT_LPWSTR (the store copies it)
    try { Marshal.ThrowExceptionForHR(s.SetValue(ref k, ref v)); } finally { Marshal.FreeCoTaskMem(v.p); }
  }
  // every top-level Chrome/Edge window titled `title` (the page's <title>); returns how many were labelled
  public static int Windows(string title, string id, string exe) {
    int n = 0; IntPtr h = IntPtr.Zero;
    Guid iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
    while ((h = FindWindowEx(IntPtr.Zero, h, "Chrome_WidgetWin_1", title)) != IntPtr.Zero) {
      IPropertyStore s;
      if (SHGetPropertyStoreForWindow(h, ref iid, out s) != 0 || s == null) continue;
      try {
        Set(s, 2, "\"" + exe + "\"");  // RelaunchCommand: a pinned PhoneDrop starts PhoneDrop.exe
        Set(s, 4, "PhoneDrop");        // RelaunchDisplayNameResource
        Set(s, 3, exe + ",0");         // RelaunchIconResource
        Set(s, 5, id);                 // and the ID itself, last
        n++;
      } finally { Marshal.ReleaseComObject(s); }
    }
    return n;
  }
  public static void Shortcut(string lnk, string id) {
    object link = new ShellLink();
    try {
      ((IPersistFile)link).Load(lnk, 2); // STGM_READWRITE
      IPropertyStore s = (IPropertyStore)link;
      Set(s, 5, id);
      Marshal.ThrowExceptionForHR(s.Commit());
      ((IPersistFile)link).Save(lnk, true);
    } finally { Marshal.ReleaseComObject(link); }
  }
}
'@

if ($Shortcut) { [PhoneDropAppId]::Shortcut($Shortcut, $id); exit 0 }
if (-not $Exe) { exit 1 }
# the window takes a moment to open (and its title is the address until the page has loaded): keep looking
$seen = 0
for ($i = 0; $i -lt $Wait * 2; $i++) {
  if ([PhoneDropAppId]::Windows('PhoneDrop', $id, $Exe) -gt 0) { $seen++; if ($seen -ge 3) { exit 0 } }
  Start-Sleep -Milliseconds 500
}
exit 2
