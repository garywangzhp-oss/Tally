param([string]$HandlesFile, [int]$ParentPid = 0)

# Tally desktop-panel keeper (z-order guard).
# Ported from TackIt (D:\workbuddy Project\Ticknote\electron\desktop-keep.ps1);
# the algorithm and every hard-won note below are kept, the TackIt-only parts
# (sticky notes, rounded-corner region clamping, multi-widget bookkeeping) are
# dropped because Tally has exactly one window.
#
# WHY THIS EXISTS
#   The panel must behave like a DESKTOP GADGET: it lives in the band directly
#   ABOVE the desktop (wallpaper + icons) and BELOW every normal application
#   window. Electron alone cannot express that. A plain BrowserWindow with
#   alwaysOnTop=false is z-ordered by "who was activated last", so the moment
#   the user clicks or drags the panel it jumps on top of every other window and
#   STAYS there -- the "还是遮挡其他页面" report. Lowering alwaysOnTop to false
#   was necessary but not sufficient: passivity is the bug. This daemon actively
#   re-anchors the panel below the application stack the moment it finds itself
#   covering a visible app.
#
# SEMANTICS
#   w:<hwnd>   "stick to desktop" mode (default). Never enters the TOPMOST band
#              while the desktop is in its normal state. If pushed below the
#              desktop layer -> re-anchor just ABOVE the bottom-most desktop
#              window: visible over the wallpaper, below every normal app.
#   wt:<hwnd>  "always on top" mode (user opted in). Stays in the TOPMOST band;
#              only re-raised when something demoted it.
#   "show desktop" (Win+D) is the one exception for w: -- the shell raises a
#   desktop surface to the TOP of the normal band, so the gadget slot ceases to
#   exist and a band re-place cannot win (its anchor is then a topmost window and
#   SetWindowPos fails). There the panel gets a TRANSIENT TOPMOST raise -- the
#   only band above the raised desktop -- and is demoted back into the gadget
#   band as soon as the desktop is lowered.
#
# VISIBILITY CONTRACT (Tally-only, not in TackIt)
#   The main process writes ONLY the windows that are supposed to be visible. A
#   panel hidden to the tray is absent from the handles file, so the keeper never
#   touches it. This matters because every SetWindowPos below carries
#   SWP_SHOWWINDOW -- without the contract the keeper would un-hide a tray-hidden
#   panel, i.e. exactly the old "clicked x, window flashed back" bug.
#
# 2026-09-11 (TackIt) - the "Win+D rescue failed again" recurrence. Two bugs:
#   1. every z-order SetWindowPos lacked SWP_NOOWNERZORDER, which makes the
#      kernel silently DROP the request ~60% of the time on this Chromium
#      window (returns 1, WS_EX_TOPMOST never lands). See the P/Invoke note.
#   2. IsDesktopClass() accepted INVISIBLE orphan WorkerW windows, so both
#      DesktopAnchor() and BelowDesktop() read the wrong layer.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File desktop-keep.ps1
#          -HandlesFile <path> [-ParentPid <pid>]

$log = Join-Path $env:TEMP 'tally-keep.log'
function Log($m) { try { Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) } catch { } }
Log "keeper started, handles=$HandlesFile parent=$ParentPid"

$ErrorActionPreference = 'Continue'

$cs = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PanelKeep {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string win);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int idx);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, ref RECT r);

  const uint SWP_NOSIZE = 0x0001;
  const uint SWP_NOMOVE = 0x0002;
  const uint SWP_NOZORDER = 0x0004;
  const uint SWP_NOACTIVATE = 0x0010;
  const uint SWP_SHOWWINDOW = 0x0040;
  // *** THE 2026-09-11 FIX ***
  // Every cross-process z-order change on a Chromium (Electron) window must
  // carry SWP_NOOWNERZORDER. Without it SetWindowPos silently DOES NOTHING
  // about 60% of the time - it still returns 1, but WS_EX_TOPMOST never lands
  // (measured on the live widget window: 3/12 and 6/14 landed, and 8 of the
  // 14 never landed even after 12 back-to-back attempts). With it: 14/14
  // landed on the FIRST attempt, and the raise ALSO works while the desktop is
  // already lifted - i.e. no race is needed. The kernel otherwise drags the
  // owner window's z-order along as part of the request, and THAT side effect
  // is what gets refused.
  const uint SWP_NOOWNERZORDER = 0x0200;
  static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  static readonly IntPtr HWND_TOP = IntPtr.Zero;

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }

  // TRUE desktop surface only: a Progman/WorkerW window that actually hosts the
  // shell view (SHELLDLL_DefView child), or the window GetShellWindow() reports.
  // Win+D cycles leave orphan, invisible WorkerW windows HIGH in the z-order
  // (above real app windows). Treating any WorkerW as "the desktop" made
  // DesktopAnchor() insert the panel mid-app-stack and made CoversVisibleApp()
  // stop early ("desktop reached") while the panel was in fact parked on top of
  // every app window below that orphan.
  // FIXED 2026-09-11: an INVISIBLE WorkerW that happens to host a SHELLDLL_
  // DefView child is NOT "the desktop you are looking at". Win+D cycles (and
  // every Chromium/Electron app on this box) leave dozens of orphan WorkerW
  // windows high in the z-order - measured on the live desktop: ~25 hidden
  // WorkerW windows, the first one at idx 88 while the real desktop stack sat
  // at idx 567.
  public static bool IsDesktopClass(IntPtr h) {
    if (h == IntPtr.Zero) return false;
    if (!IsWindowVisible(h)) return false;
    StringBuilder sb = new StringBuilder(128);
    if (GetClassName(h, sb, 128) == 0) return false;
    string c = sb.ToString();
    if (c != "Progman" && c != "WorkerW") return false;
    if (h == GetShellWindow()) return true;
    return FindWindowEx(h, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero;
  }

  // true when window w sits BELOW a desktop-layer top-level window in z-order
  // (EnumWindows returns top-level windows from top to bottom).
  public static bool BelowDesktop(IntPtr w) {
    bool sawWidget = false;
    bool below = false;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (h == w) { sawWidget = true; return false; }
      if (IsDesktopClass(h)) { below = true; return false; }
      return true;
    }, IntPtr.Zero);
    return below || !sawWidget;
  }

  public static bool IsTopMost(IntPtr w) {
    long ex = GetWindowLongPtr(w, -20).ToInt64();
    return (ex & 0x8L) != 0;
  }

  public static bool Layered(IntPtr w) {
    long ex = GetWindowLongPtr(w, -20).ToInt64();
    return (ex & 0x80000L) != 0;
  }

  // Win+D pre-emption. Measured 2026-09-10: once the panel is buried under the
  // raised desktop surface, SetWindowPos(HWND_TOPMOST) is INTERMITTENTLY refused
  // by the OS - RaiseVerified() reported FAILED and the panel stayed behind the
  // wallpaper for the whole show-desktop period, while other instances of the
  // very same build raised fine. An ALREADY-topmost window is never buried by
  // Win+D (measured: topmost set before the keystroke survived 8s of
  // show-desktop), so the only reliable fix is to win the race: raise the panel
  // the moment the keystroke is observed, BEFORE the shell raises the desktop.
  // Polled at ~30ms because a 300ms tick loses that race more often than not.
  // A false positive is harmless: if the desktop never rises, the normal
  // "sunk-from-topmost" branch demotes the panel again within one tick.
  public static bool WinDDown() {
    const int VK_LWIN = 0x5B;
    const int VK_RWIN = 0x5C;
    const int VK_D = 0x44;
    bool win = (GetAsyncKeyState(VK_LWIN) & 0x8000) != 0 ||
               (GetAsyncKeyState(VK_RWIN) & 0x8000) != 0;
    if (!win) return false;
    return (GetAsyncKeyState(VK_D) & 0x8000) != 0;
  }

  // pid of the window's owner process (0 when unknown)
  public static uint PidOf(IntPtr h) {
    if (h == IntPtr.Zero) return 0;
    uint p;
    GetWindowThreadProcessId(h, out p);
    return p;
  }

  // Loose desktop-surface test, used ONLY to answer "is the shell showing the
  // desktop". The strict IsDesktopClass() additionally demands the surface host
  // SHELLDLL_DefView / be GetShellWindow(); that is right for anchoring and
  // cover decisions, but during show-desktop the surface at the band top does
  // NOT reliably satisfy it, which made DesktopRaised() flap between true/false
  // every tick. That flapping was the real cause of "panel gone after Win+D":
  // each false tick demoted the panel through Place(), and Place (and Nudge)
  // carry no SWP_NOZORDER, so they STRIPPED the WS_EX_TOPMOST the rescue had
  // just applied - a ~300ms raise/strip cycle the user perceives as "never
  // appears".
  static bool IsDesktopSurfaceLoose(IntPtr h) {
    if (h == IntPtr.Zero) return false;
    StringBuilder sb = new StringBuilder(32);
    if (GetClassName(h, sb, 32) == 0) return false;
    string c = sb.ToString();
    return c == "Progman" || c == "WorkerW";
  }

  // Shell / IME infrastructure that must never decide "is the desktop raised".
  // The taskbar and its helpers are always present, and Sogou / IME tooltips
  // lose their TOPMOST flag for a tick or two; voting on them made the predicate
  // flap in the middle of show-desktop.
  static bool IsBandNoise(IntPtr h) {
    StringBuilder sb = new StringBuilder(64);
    if (GetClassName(h, sb, 64) == 0) return false;
    string c = sb.ToString();
    if (c == "Shell_TrayWnd" || c == "Shell_SecondaryTrayWnd") return true;
    if (c == "TaskListThumbnailWnd" || c == "ForegroundStaging") return true;
    if (c == "NotifyIconOverflowWindow" || c == "tooltips_class32") return true;
    if (c == "IME" || c == "MSCTFIME UI") return true;
    if (c.StartsWith("SoPY_")) return true;
    return false;
  }

  // true when a desktop surface sits at the TOP of the non-topmost band, i.e.
  // the shell is in the "show desktop" state (Win+D / taskbar corner button).
  // That state does NOT minimize normal windows: the shell raises a WorkerW
  // hosting the shell view above every normal window, so the whole gadget band
  // ("just above the desktop, below every app") ceases to exist and anything
  // sitting in it - our panel - is hidden behind the wallpaper.
  // EnumWindows walks top->bottom, topmost band first, so the first window
  // WITHOUT WS_EX_TOPMOST is the top of the normal band.
  // Two filters keep this honest (2026-09-10):
  //   - hidden windows do not vote (orphan WorkerW windows sit high in the band)
  //   - our OWN windows do not vote. Once the panel is parked above the raised
  //     desktop it becomes the topmost non-topmost window, so a naive scan
  //     reports "desktop not raised" and instantly demotes it back under the
  //     wallpaper - the rescue/sink flapping.
  //   - MINIMIZED windows (IsIconic) do not vote. Win+D minimizes every
  //     minimizable window, but a minimized window still reports
  //     IsWindowVisible()==true, so as soon as the raised desktop surface blinks
  //     invisible for one tick the scan landed on a minimized app and answered
  //     "desktop not raised" - which demoted the panel straight back behind the
  //     wallpaper. That single missing filter produced "panel gone after Win+D".
  //   - shell/IME infrastructure does not vote (IsBandNoise above).
  // Default when NOTHING is visible in the band is "raised": no visible
  // non-minimized window means the desktop is what the user is looking at, and
  // keeping the panel topmost is then both harmless and required.
  public static bool DesktopRaised(IntPtr self) {
    uint selfPid = PidOf(self);
    bool raised = false;
    int candidates = 0;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      long ex = GetWindowLongPtr(h, -20).ToInt64();
      if ((ex & 0x8L) != 0) return true;    // topmost band: not our band
      if (!IsWindowVisible(h)) return true; // hidden helpers are not band-top
      if (IsIconic(h)) return true;         // minimized: not the band top
      if (selfPid != 0 && PidOf(h) == selfPid) return true; // our own windows
      if (IsBandNoise(h)) return true;      // taskbar / IME / tooltips
      candidates += 1;
      raised = IsDesktopSurfaceLoose(h);    // first real band window decides
      return false;
    }, IntPtr.Zero);
    return candidates == 0 ? true : raised;
  }

  // dev-only: last SetWindowPos results (1 ok / 0 refused / -1 not called yet).
  // Kept because "the keeper logged a rescue but the window never became
  // topmost" cannot be told apart from "the keeper never tried" without them.
  public static int LastRaiseOk = -1;
  public static int LastPlaceOk = -1;

  public static bool Raise(IntPtr w) {
    bool ok = SetWindowPos(w, HWND_TOPMOST, 0, 0, 0, 0,
      SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_NOOWNERZORDER);
    LastRaiseOk = ok ? 1 : 0;
    return ok;
  }

  // Raise + verify. SetWindowPos(HWND_TOPMOST) on another process's LAYERED
  // window can report success while the topmost bit never lands (the target
  // thread applies cross-process z-order changes, and during a Win+D transition
  // the first attempt is occasionally dropped - measured 2026-09-10: raiseOk=1
  // for 10s straight while IsTopMost stayed false). One nudge + retry makes the
  // rescue reliable; the returned string goes into the log so "persistently
  // refused" is distinguishable from "never tried".
  public static string RaiseVerified(IntPtr w) {
    if (Raise(w) && IsTopMost(w)) return "ok";
    Nudge(w);
    if (Raise(w) && IsTopMost(w)) return "retry-ok";
    return "FAILED";
  }

  static string Cls(IntPtr h) {
    if (h == IntPtr.Zero) return "(null)";
    StringBuilder sb = new StringBuilder(128);
    GetClassName(h, sb, 128);
    return sb.ToString();
  }

  // Dev-only: one-line snapshot of EVERY decision input for this tick.
  // Enabled by launching the app with TALLY_KEEP_DEBUG=1; without it the keeper
  // never calls this (zero cost in normal runs).
  public static string DebugLine(IntPtr w) {
    IntPtr fg = GetForegroundWindow();
    IntPtr a = DesktopAnchor();
    return string.Format(
      "top={0} below={1} covers={2} raised={3} raiseOk={4} placeOk={5} anchor={6}({7}) fg={8}({9})",
      IsTopMost(w), BelowDesktop(w), CoversVisibleApp(w), DesktopRaised(w),
      LastRaiseOk, LastPlaceOk, a.ToInt64(), Cls(a), fg.ToInt64(), Cls(fg));
  }

  // Insertion point for the gadget band = the window directly ABOVE the desktop
  // stack: EnumWindows walks top->bottom; stop at the FIRST desktop-class window
  // and return the last non-desktop window seen before it.
  // SetWindowPos(hwnd, insertAfter) puts hwnd BEHIND insertAfter, so inserting
  // after this anchor lands the panel IN FRONT of the whole desktop stack
  // (wallpaper/icons/WorkerW) and BEHIND every app window.
  // (Anchoring to a desktop-class window itself puts the panel behind the
  // desktop rendering -> invisible + infinite re-place loop = flicker, both
  // 2026-09-08 bugs.)
  //
  // Tally addition: an INVISIBLE top-level window must not become the anchor.
  // Chromium apps (including Electron ones) keep hidden helper windows whose
  // z-order slot is arbitrary - anchoring to one parks the panel mid-app-stack,
  // i.e. still covering windows, and the predicate stays self-consistent so it
  // never self-corrects. WS_EX_TOOLWINDOW is deliberately NOT filtered here:
  // Electron's skipTaskbar=true gives the panel that bit too, so filtering it
  // would make the panel unable to recognise itself as the anchor and re-place
  // forever.
  public static IntPtr DesktopAnchor() {
    IntPtr prev = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (IsDesktopClass(h)) return false; // stop: prev is the insertion point
      if (!IsWindowVisible(h)) return true; // hidden helpers cannot be the anchor
      prev = h;
      return true;
    }, IntPtr.Zero);
    return prev;
  }

  // anchor w immediately ABOVE the desktop layer: visible over the wallpaper,
  // below every normal app window. This is the only place a desktop-gadget panel
  // should ever live - it must never enter the TOPMOST band.
  public static bool Place(IntPtr w) {
    IntPtr a = DesktopAnchor();
    if (a == w) return true; // already the window directly above the desktop
    IntPtr after = (a == IntPtr.Zero) ? HWND_TOP : a;
    bool ok = SetWindowPos(w, after, 0, 0, 0, 0,
      SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_NOOWNERZORDER);
    LastPlaceOk = ok ? 1 : 0;
    return ok;
  }

  // gadget "sink": NOTOPMOST would land the window at the TOP of the normal band
  // (above all apps - the 2026-09-08 "panel covers apps" bug), so the correct
  // sink target is the same above-desktop anchor.
  public static void Sink(IntPtr w) {
    Place(w);
  }

  // true when w COVERS a visible normal app window, i.e. a real app window sits
  // BELOW w in z-order. Direction matters: a raised panel sits at the TOP of the
  // normal band, so "any app above w" is never true at exactly the moment it is
  // covering everything. Scan DOWNWARD from w instead:
  //   - a visible, non-minimized, non-tool app window below w -> w covers it
  //   - reaching the desktop stack below w -> w is in the gadget band, done
  // Tally has exactly one window, so the TackIt "skip fellow widgets by title
  // prefix" filter is unnecessary here.
  public static bool CoversVisibleApp(IntPtr w) {
    IntPtr fg = GetForegroundWindow();
    if (fg == IntPtr.Zero || fg == w) return false; // w itself active (user interacting): don't fight it
    bool sawW = false;
    bool covers = false;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (h == w) { sawW = true; return true; } // from here on: windows BELOW w
      if (!sawW) return true;                   // windows above w are irrelevant
      if (IsDesktopClass(h)) return false;      // desktop stack reached: w covers nothing
      if (!IsWindowVisible(h)) return true;
      if (IsIconic(h)) return true;             // minimized apps are not covered
      long ex = GetWindowLongPtr(h, -20).ToInt64();
      if ((ex & 0x8L) != 0) return true;        // topmost (defensive; not below w normally)
      if ((ex & 0x80L) != 0) return true;       // WS_EX_TOOLWINDOW helpers
      covers = true;                            // a real app window lies under w
      return false;
    }, IntPtr.Zero);
    return covers;
  }

  // Is w itself the foreground window? While it is, the keeper must not touch
  // its z-order: the user may be dragging or typing in the panel, and a
  // SetWindowPos (even with SWP_NOACTIVATE) during a drag makes it stutter.
  public static bool ForegroundIs(IntPtr w) {
    return GetForegroundWindow() == w;
  }

  // true ONLY when the foreground window is a real normal app window.
  // NULL foreground (transient state right after Win+D) must NOT count as
  // "app foreground" - sinking the panel then re-buries it mid-Win+D.
  // The taskbar also must not count: during show-desktop the focus alternates
  // between the desktop and Shell_TrayWnd, and counting the taskbar as "an app
  // took focus" sank sticky notes behind the wallpaper (same bug class as the
  // panel flap, 2026-09-10).
  public static bool ForegroundIsApp() {
    IntPtr fg = GetForegroundWindow();
    if (fg == IntPtr.Zero) return false;
    if (fg == GetShellWindow()) return false;
    if (IsDesktopClass(fg)) return false;
    if (IsBandNoise(fg)) return false;
    return true;
  }

  // 2px width toggle and back: kicks DWM into recompositing the window's
  // surface. Cheap insurance for the transient state where a transparent window
  // raised out of a Win+D burial renders nothing until its next paint.
  // FIXED 2026-09-10: the 5th/6th arguments are cx/cy and cy was passed as 0 -
  // so the "2px width toggle" actually RESIZED the window to (wd+2, 0) and then
  // (wd, 0). A transparent window with zero height never renders, i.e. a nudge
  // running while the panel was visible made it vanish.
  // ALWAYS z-order neutral: no insert-after argument, SWP_NOZORDER on both
  // calls. SetWindowPos with an insert-after silently STRIPS WS_EX_TOPMOST.
  // Measured 2026-09-10 (keeper on vs off): keeper running -> ex 0x00080008
  // (LAYERED|TOPMOST) at +100ms, back to 0x00080000 at +300ms = the nudge ate
  // the raise. That ~300ms raise/strip cycle is what the user sees as "panel
  // never appears after Win+D". The nudge only exists to poke DWM into
  // recompositing a transparent window, which needs the 2px size toggle, NOT a
  // z-order move.
  public static void Nudge(IntPtr w) {
    RECT r = new RECT();
    GetWindowRect(w, ref r);
    int wd = r.Right - r.Left;
    int ht = r.Bottom - r.Top;
    if (wd <= 0 || ht <= 0) return;
    SetWindowPos(w, IntPtr.Zero, 0, 0, wd + 2, ht, SWP_NOMOVE | SWP_NOACTIVATE | SWP_NOZORDER);
    SetWindowPos(w, IntPtr.Zero, 0, 0, wd, ht, SWP_NOMOVE | SWP_NOACTIVATE | SWP_NOZORDER);
  }
}
'@

try {
  Add-Type -TypeDefinition $cs -ErrorAction Stop
  Log "Add-Type ok"
} catch {
  Log ("Add-Type FAILED: " + $_.Exception.Message)
  exit 2
}

# physical-pixel coordinates for GetWindowRect on high-DPI desktops
try { [PanelKeep]::SetProcessDPIAware() | Out-Null } catch { }

if (-not $HandlesFile) { exit 1 }

$script:handles = @()
$script:last = [datetime]::MinValue
$script:acted = @{}
$script:idleTicks = 0
$script:nudge = @{}
$script:seen = @()

function Update-Handles {
  try {
    if (Test-Path $HandlesFile) {
      $t = (Get-Item $HandlesFile).LastWriteTimeUtc
      if ($t -ne $script:last) {
        $script:last = $t
        # lines look like "w:123" (stick to desktop) / "wt:123" (always on top)
        $script:handles = @(Get-Content $HandlesFile | Where-Object { $_ -match '^(w|wt):\d+$' })
      }
    } else {
      # The main process deletes the file while no visible panel exists (tray).
      if ($script:handles.Count -gt 0) { $script:handles = @() }
    }
  } catch { }
}

# Win+D pre-emption (see PanelKeep.WinDDown): raise the panel to TOPMOST the
# instant the keystroke is seen, i.e. BEFORE the shell lifts the desktop surface
# - after that lift the raise is intermittently refused by the OS and the panel
# stays behind the wallpaper until the user restores a window. Runs from the
# 30ms key poll, so it fires ~10x more often than the main tick.
function Invoke-WinDPreempt {
  foreach ($entry in $script:handles) {
    $c = $entry.IndexOf(':')
    $k = $entry.Substring(0, $c)
    if ($k -ne "w") { continue }   # only the gadget-mode panel needs the rescue
    $w = [IntPtr]::new([long]$entry.Substring($c + 1))
    if (-not [PanelKeep]::IsWindow($w)) { continue }
    # same first-composition grace period as the main loop: touching a freshly
    # created transparent window too early aborts its first composition
    if ($script:seen.ContainsKey($entry) -and ((([datetime]::Now) - $script:seen[$entry]).TotalMilliseconds -lt 1000)) { continue }
    if ([PanelKeep]::IsTopMost($w)) { continue }
    $r = "err"
    try { $r = [PanelKeep]::RaiseVerified($w) } catch { $r = "err:" + $_.Exception.Message }
    $s = "preempt-win-d(" + $r + ")"
    if ($script:acted[$entry] -ne $s) { $script:acted[$entry] = $s; Log "hwnd=$entry $s" }
    $script:nudge[$entry] = $true
  }
}

while ($true) {
  # Parent liveness: the keeper is a child of the Electron main process and must
  # not outlive it (the panel would keep getting re-anchored after Tally exits).
  # TackIt used a "no valid window for 30s" idle timeout instead, but that is
  # wrong here: Tally's panel can legitimately sit in the tray for hours with no
  # window in the handles file.
  # ⚠️ PID alone is NOT enough - Windows reuses PIDs, and a single reuse turns
  # the keeper into a permanent orphan that keeps re-anchoring a dead window.
  # Measured 2026-09-21: two keepers survived their parents exactly that way.
  # So also require the process name to still be Tally / electron.
  if ($ParentPid -gt 0) {
    $alive = $false
    try {
      $pp = [System.Diagnostics.Process]::GetProcessById($ParentPid)
      $nm = $pp.ProcessName
      if ($nm -eq 'Tally' -or $nm -eq 'electron') { $alive = $true }
      else { Log "parent pid $ParentPid recycled by '$nm', keeper exits" }
    } catch { }
    if (-not $alive) { Log "parent $ParentPid gone, keeper exits"; exit 0 }
  }

  Update-Handles
  $valid = 0
  if ($script:handles.Count -gt 0) {
    $fgApp = [PanelKeep]::ForegroundIsApp()
    foreach ($entry in $script:handles) {
      $colon = $entry.IndexOf(':')
      $kind = $entry.Substring(0, $colon)
      $w = [IntPtr]::new([long]$entry.Substring($colon + 1))
      if (-not [PanelKeep]::IsWindow($w)) { continue }
      # grace period: touching (raise/nudge) a transparent window too soon after
      # creation aborts its first composition and it never renders. The main
      # process only registers the handle after 'ready-to-show' (first frame
      # already painted), so 1s of slack is enough - TackIt needed 5s because it
      # handed the handle over right after creation.
      if (-not $script:seen.ContainsKey($entry)) { $script:seen[$entry] = [datetime]::Now }
      if ((([datetime]::Now) - $script:seen[$entry]).TotalMilliseconds -lt 1000) { $valid += 1; continue }
      $valid += 1
      $st = ""
      try {
        # pending composition-kick from a previous raise
        if ($script:nudge[$entry]) {
          $script:nudge.Remove($entry)
          [PanelKeep]::Nudge($w)
        }
        # Is the shell in "show desktop" state? Decided ONCE per tick, before any
        # action, and used as a hard mode switch below: while the desktop is
        # raised the gadget slot does not exist, so nothing may demote the panel.
        $raised = [PanelKeep]::DesktopRaised($w)
        $fgSelf = [PanelKeep]::ForegroundIs($w)
        # dev-only decision trace (TALLY_KEEP_DEBUG=1) - see DebugLine()
        if ($env:TALLY_KEEP_DEBUG -eq '1') {
          Log ("dbg " + $entry + " " + [PanelKeep]::DebugLine($w) + " fgApp=$fgApp raised=$raised")
        }
        if ($kind -eq "wt") {
          # "always on top" mode (user opted in): stays in the TOPMOST band at all
          # times (immune to Win+D burial); only re-raise if something demoted it
          if (-not [PanelKeep]::IsTopMost($w)) {
            $null = [PanelKeep]::Raise($w)
            $st = "raised-topmost-restore"
            $script:nudge[$entry] = $true
          }
        } elseif ($raised) {
          # "show desktop": the shell parked a desktop surface on TOP of the normal
          # band, so the gadget slot (above the desktop, below every app) is gone
          # and TOPMOST is the only band where the panel is visible. While this
          # state lasts NOTHING may demote it - neither a real app that is still
          # foreground (Win+D does not always hand focus to the desktop) nor the
          # panel's own parked position.
          if (-not [PanelKeep]::IsTopMost($w)) {
            # keep the SetWindowPos result IN the status string: it is logged on
            # every change, so "retried for seconds, always refused" and "always
            # reported success but never applied" are distinguishable
            $st = "show-desktop-raised(" + [PanelKeep]::RaiseVerified($w) + ")"
            $script:nudge[$entry] = $true
          }
        } elseif ([PanelKeep]::BelowDesktop($w)) {
          # Win+D / "show desktop" raised a desktop surface to the TOP of the
          # normal band: the gadget slot above the desktop no longer exists, so the
          # plain Place() rescue could not win (its anchor is then a topmost window
          # and SetWindowPos fails outright) and the panel stayed hidden behind the
          # wallpaper for seconds. The only band above the raised desktop is
          # TOPMOST, so escape with a TRANSIENT topmost raise; it is demoted back
          # into the gadget band below as soon as the desktop is lowered again - so
          # it never parks over app windows (the "panel covers apps" bug).
          $st = "rescued-topmost(" + [PanelKeep]::RaiseVerified($w) + ")"
          $script:nudge[$entry] = $true
        } elseif ([PanelKeep]::IsTopMost($w)) {
          # reached only when the desktop is back in its normal (bottom) position -
          # the $raised branch above owns the show-desktop case - so the gadget
          # band exists again and the raise must be undone. No $fgApp test here any
          # more: it was the thing that let a still-foreground app demote the panel
          # mid-show-desktop.
          $null = [PanelKeep]::Place($w)
          # Safety net: if the band does not actually exist (the predicate read
          # "not raised" while the desktop was still up), Place() lands the panel
          # BEHIND the wallpaper. Re-check and undo instead of leaving it
          # invisible; the status string makes the event visible in the log.
          Start-Sleep -Milliseconds 40
          if ([PanelKeep]::BelowDesktop($w)) {
            $null = [PanelKeep]::Raise($w)
            $script:nudge[$entry] = $true
            $st = "sunk-from-topmost-reverted"
          } else {
            $st = "sunk-from-topmost"
          }
        } elseif (-not $fgSelf) {
          # *** THIS IS THE "还是遮挡其他页面" FIX ***
          # Unconditional sink. The panel is NOT the foreground window (so the
          # user is not interacting with it) and the desktop is not raised, hence
          # the gadget band exists and the panel belongs at its bottom: directly
          # above the desktop, below every normal app.
          #
          # Why unconditional instead of TackIt's "CoversVisibleApp" gate: a plain
          # alwaysOnTop=false BrowserWindow is z-ordered by "who was activated
          # last", so the moment the user clicks or drags the panel Windows parks
          # it at the TOP of the normal band and it stays there. The gate only
          # fired when a visible app happened to sit below the panel, which left
          # long stretches where the panel really was covering windows. Sinking
          # whenever we are not the foreground window closes that hole, and it is
          # stable: when the panel already sits at the band bottom, Place() finds
          # DesktopAnchor() == w and does nothing at all (no flicker, no churn).
          # fg is NULL (transient, e.g. right after Win+D) also lands here, which
          # is correct - the $raised branch above owns the real show-desktop case.
          $null = [PanelKeep]::Place($w)
          # Safety net: if the band does not actually exist (the predicate read
          # "not raised" while the desktop was still up), Place() lands the panel
          # BEHIND the wallpaper. Re-check and undo instead of leaving it
          # invisible; the status string makes the event visible in the log.
          Start-Sleep -Milliseconds 40
          if ([PanelKeep]::BelowDesktop($w)) {
            $null = [PanelKeep]::Raise($w)
            $script:nudge[$entry] = $true
            $st = "sunk-to-desktop-band-reverted"
          } else {
            $st = "sunk-to-desktop-band"
          }
        }
      } catch { $st = "err:" + $_.Exception.Message }
      if ($st -ne "" -and $script:acted[$entry] -ne $st) {
        $script:acted[$entry] = $st
        Log "hwnd=$entry $st"
      }
    }
  }

  # Tick = ~300ms of z-order work, but the Win+D keystroke is polled every 30ms
  # so the pre-emptive raise happens BEFORE the shell lifts the desktop. Two
  # GetAsyncKeyState calls per 30ms are free; the expensive part (EnumWindows +
  # per-window checks) stays at the 300ms cadence.
  for ($i = 0; $i -lt 10; $i++) {
    try { if ([PanelKeep]::WinDDown()) { Invoke-WinDPreempt } } catch { }
    Start-Sleep -Milliseconds 30
  }
}
