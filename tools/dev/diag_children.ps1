# diag_children.ps1 - list taskbar child windows + search panel everywhere. ASCII only.
$ErrorActionPreference = 'Continue'
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DC {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr FindWindow(string cls, string win);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
$lines = @()
$hTray = [DC]::FindWindow('Shell_TrayWnd', $null)
$lines += ("Shell_TrayWnd=" + $hTray)

# taskbar direct children
$cbChild = [DC+EnumProc]{
  param($h, $l)
  $sb = New-Object System.Text.StringBuilder 256
  [void][DC]::GetWindowText($h, $sb, 256)
  $cn = New-Object System.Text.StringBuilder 256
  [void][DC]::GetClassName($h, $cn, 256)
  $script:lines += ("  child hwnd={0} class={1} title='{2}' visible={3}" -f $h, $cn, $sb, [DC]::IsWindowVisible($h))
  return $true
}
$script:lines = $lines
[void][DC]::EnumChildWindows($hTray, $cbChild, [IntPtr]::Zero)
$lines = $script:lines

# search ALL top-level windows for the panel
$cbTop = [DC+EnumProc]{
  param($h, $l)
  $sb = New-Object System.Text.StringBuilder 256
  [void][DC]::GetWindowText($h, $sb, 256)
  if ($sb.ToString() -eq 'CuktechPowerPanel') {
    $pid2 = 0
    [void][DC]::GetWindowThreadProcessId($h, [ref]$pid2)
    $par = [DC]::GetParent($h)
    $script:lines += ("TOP-LEVEL panel hwnd={0} pid={1} parent={2} visible={3}" -f $h, $pid2, $par, [DC]::IsWindowVisible($h))
  }
  return $true
}
[void][DC]::EnumWindows($cbTop, [IntPtr]::Zero)

$lines | Set-Content -Encoding UTF8 "$env:TEMP\_children.txt"
Write-Output done
