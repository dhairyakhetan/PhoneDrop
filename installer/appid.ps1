# Gives PhoneDrop's window its own place, and its own sharp icon, on the Windows taskbar.
#
# PhoneDrop's window is a Chrome or Edge "app" window. On its own, Chrome gives such a window the page's 16 px
# favicon as its icon, which the taskbar blows up (blurry: it looks like a small picture, not the crisp icon), and
# pinning it pins a browser shortcut to localhost that can't start PhoneDrop. So:
# - the window and PhoneDrop's shortcuts get the same "AppUserModelID" (PhoneDrop.App): the taskbar groups them,
#   and a pin starts PhoneDrop.exe and shows its icon;
# - the window's own icons (WM_SETICON, what its taskbar button shows) are PhoneDrop.exe's icon (icon.svg rendered
#   at every size) in the sizes this screen needs (16/32 px at 100 %, 24/48 at 150 %...). Chrome puts its favicon
#   back whenever the page loads, and an icon only lives as long as the program that loaded it, so this keeps
#   running while the window is open, puts PhoneDrop's icon back when needed (checks once a second) and quits
#   -Wait seconds after the last PhoneDrop window closed. Only one runs at a time (a restarted PhoneDrop finds the
#   one that's still watching its window).
#
#   -Shortcut <file.lnk>   the installer, for the Start Menu, desktop and startup shortcuts it makes
#   -Exe <PhoneDrop.exe>   PhoneDrop, after it opens its window: waits for the window, then looks after it
param([string]$Shortcut = '', [string]$Exe = '', [int]$Wait = 20)
$ErrorActionPreference = 'Stop'
$id = 'PhoneDrop.App'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Threading;

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
  [DllImport("user32.dll")]
  static extern IntPtr SendMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")]
  static extern uint GetDpiForWindow(IntPtr hwnd); // Windows 10 1607 and later
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern uint PrivateExtractIcons(string file, int index, int cx, int cy, IntPtr[] icons, uint[] ids, uint n, uint flags);
  const uint WM_GETICON = 0x7F, WM_SETICON = 0x80;

  static void Set(IPropertyStore s, uint pid, string value) {
    PropKey k = new PropKey(pid);
    PropVar v = new PropVar(); v.vt = 31; v.p = Marshal.StringToCoTaskMemUni(value); // VT_LPWSTR (the store copies it)
    try { Marshal.ThrowExceptionForHR(s.SetValue(ref k, ref v)); } finally { Marshal.FreeCoTaskMem(v.p); }
  }
  static void Label(IntPtr h, string id, string exe) {
    Guid iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
    IPropertyStore s;
    if (SHGetPropertyStoreForWindow(h, ref iid, out s) != 0 || s == null) return;
    try {
      Set(s, 2, "\"" + exe + "\"");  // RelaunchCommand: a pinned PhoneDrop starts PhoneDrop.exe
      Set(s, 4, "PhoneDrop");        // RelaunchDisplayNameResource
      Set(s, 3, exe + ",0");         // RelaunchIconResource
      Set(s, 5, id);                 // and the ID itself, last
    } finally { Marshal.ReleaseComObject(s); }
  }
  // PhoneDrop.exe's icon at size x size (Windows picks the nearest size in the .ico and scales it if it must)
  static IntPtr Icon(string exe, int size) {
    IntPtr[] h = new IntPtr[1]; uint[] ids = new uint[1];
    return PrivateExtractIcons(exe, 0, size, size, h, ids, 1, 0) == 1 ? h[0] : IntPtr.Zero;
  }
  // Looks after every top-level Chrome/Edge window titled `title` (the page's <title>): the ID once per window,
  // PhoneDrop's icons whenever Chrome has put its own back. Returns `idle` seconds after the last one closed (or
  // if none showed up in that time).
  public static void Keep(string title, string id, string exe, int idle) {
    var labelled = new HashSet<IntPtr>();
    var icons = new Dictionary<uint, IntPtr[]>(); // per screen DPI: { small, big }, loaded once and kept
    DateTime seen = DateTime.Now;
    while ((DateTime.Now - seen).TotalSeconds < idle) {
      IntPtr h = IntPtr.Zero;
      while ((h = FindWindowEx(IntPtr.Zero, h, "Chrome_WidgetWin_1", title)) != IntPtr.Zero) {
        seen = DateTime.Now;
        if (labelled.Add(h)) { try { Label(h, id, exe); } catch (Exception) { labelled.Remove(h); } }
        uint dpi = 96;
        try { dpi = GetDpiForWindow(h); } catch (Exception) {}
        if (dpi < 96) dpi = 96;
        IntPtr[] ic;
        if (!icons.TryGetValue(dpi, out ic)) {
          ic = new IntPtr[] { Icon(exe, (int)(16 * dpi / 96)), Icon(exe, (int)(32 * dpi / 96)) };
          icons[dpi] = ic;
        }
        if (ic[1] != IntPtr.Zero && SendMessage(h, WM_GETICON, (IntPtr)1, IntPtr.Zero) != ic[1]) {
          SendMessage(h, WM_SETICON, (IntPtr)1, ic[1]); // ICON_BIG: the taskbar and Alt+Tab
          if (ic[0] != IntPtr.Zero) SendMessage(h, WM_SETICON, (IntPtr)0, ic[0]); // ICON_SMALL: the title bar
        }
      }
      Thread.Sleep(1000);
    }
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
# one at a time: if another one is already looking after PhoneDrop's window, it carries on and this one stops
$first = $false
$one = New-Object System.Threading.Mutex($true, 'Local\PhoneDrop.WindowIcon', [ref]$first)
if (-not $first) { exit 0 }
# the window takes a moment to open (its title is the address until the page has loaded): Keep waits for it
[PhoneDropAppId]::Keep('PhoneDrop', $id, $Exe, $Wait)
$one.ReleaseMutex()
exit 0
