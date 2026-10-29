# PhoneDrop's one admin step, and the check for whether it's still needed.
#
# PhoneDrop installs for the signed-in user only (%LOCALAPPDATA%\Programs\PhoneDrop), so installing and updating
# never need admin. Two things do, once:
#   - letting phones reach PhoneDrop through Windows Firewall: an inbound "allow" rule for PhoneDrop.exe on every
#     network type, and no "block" rules for it (Windows makes those when someone clicks Cancel on its firewall
#     prompt, and a block rule beats an allow rule);
#   - PhoneDrop 1.x was installed for all users in Program Files: that copy, its all-users shortcuts, its
#     registry entries (HKLM) and its firewall rule go.
#
#   -Mode check   not elevated: prints {"firewall":"ok|off|missing|partial|blocked|unknown","old":"<folder or empty>"}
#   -Mode finish  elevated (the installer, and PhoneDrop's "Finish setup" button, run it with one Windows prompt)
#   -Mode remove  elevated (the uninstaller): removes the firewall rules for -Exe
#   -Result <file>  also writes the exit code there (0 = done): the installer can only tell whether it started
#
# Whoever clicks Yes runs it, and that can be another (admin) account than this user's: it only uses -Exe and
# HKLM, never this user's HKCU or AppData. It deletes only PhoneDrop's own files, from the folder PhoneDrop 1.x
# wrote into HKLM, and only touches firewall rules for those exact programs (other users' PhoneDrop keeps its own).
param([string]$Exe = '', [string]$Mode = 'check', [string]$Result = '')
$ErrorActionPreference = 'Stop'
function Done([int]$code) {
  if ($Result) { try { Set-Content -LiteralPath $Result -Value $code } catch {} }
  exit $code
}

# inbound rules for a program (Windows may store its path with %variables% and in any letter case)
function RulesFor([string]$program) {
  $want = [IO.Path]::GetFullPath($program)
  Get-NetFirewallApplicationFilter -PolicyStore PersistentStore | Where-Object {
    $_.Program -and $_.Program -ne 'Any' -and ([Environment]::ExpandEnvironmentVariables($_.Program) -ieq $want)
  } | Get-NetFirewallRule | Where-Object { [string]$_.Direction -eq 'Inbound' }
}
# PhoneDrop 1.x, installed for all users: its folder (from HKLM), unless that's this very copy
function OldCopy {
  try {
    $k = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', 'Registry64').OpenSubKey('Software\PhoneDrop')
    if (-not $k) { return '' }
    $d = [string]$k.GetValue('InstallDir'); $k.Close()
    if ($d -and ((Join-Path $d 'PhoneDrop.exe') -ine $Exe)) { return $d }
  } catch {}
  return ''
}

if ($Mode -eq 'check') {
  $fw = 'unknown'
  try {
    if (-not (Get-NetFirewallProfile -PolicyStore ActiveStore | Where-Object { [string]$_.Enabled -eq 'True' })) { $fw = 'off' }
    else {
      $rules = @(RulesFor $Exe | Where-Object { [string]$_.Enabled -eq 'True' })
      if ($rules | Where-Object { [string]$_.Action -eq 'Block' }) { $fw = 'blocked' }
      else {
        # which network types an allow rule covers: Any (0), or Domain 1 + Private 2 + Public 4
        $p = 0
        foreach ($r in ($rules | Where-Object { [string]$_.Action -eq 'Allow' })) { $v = [int]$r.Profile; if ($v -eq 0) { $p = 7 } else { $p = $p -bor $v } }
        $fw = if (($p -band 7) -eq 7) { 'ok' } elseif ($p) { 'partial' } else { 'missing' }
      }
    }
  } catch {}
  @{ firewall = $fw; old = (OldCopy) } | ConvertTo-Json -Compress
  exit 0
}

if (-not $Exe -or [IO.Path]::GetFileName($Exe) -ine 'PhoneDrop.exe') { Done 3 }

if ($Mode -eq 'remove') {
  try { RulesFor $Exe | Remove-NetFirewallRule } catch { Done 2 }
  Done 0
}

if ($Mode -eq 'finish') {
  $ok = $true
  # 1. phones may reach this PhoneDrop on every network type; earlier rules for it go (block rules included)
  try {
    RulesFor $Exe | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName 'PhoneDrop' -Description 'Lets phones on the Wi-Fi reach PhoneDrop' -Direction Inbound `
      -Action Allow -Program $Exe -Profile Any -Enabled True | Out-Null
  } catch { $ok = $false }
  # 2. PhoneDrop 1.x in Program Files
  $old = OldCopy
  if ($old) {
    $oldExe = Join-Path $old 'PhoneDrop.exe'
    try { RulesFor $oldExe | Remove-NetFirewallRule } catch {}
    try { Get-Process -Name PhoneDrop -ErrorAction SilentlyContinue | Where-Object { $_.Path -ieq $oldExe } | Stop-Process -Force; Start-Sleep -Milliseconds 500 } catch {}
    foreach ($f in 'PhoneDrop.exe', 'PhoneDrop.old', 'installed.txt', 'Uninstall PhoneDrop.exe') {
      Remove-Item -LiteralPath (Join-Path $old $f) -Force -ErrorAction SilentlyContinue
    }
    try { [IO.Directory]::Delete($old) } catch {} # only if it's empty now
    foreach ($l in (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\PhoneDrop.lnk'), (Join-Path $env:PUBLIC 'Desktop\PhoneDrop.lnk')) {
      Remove-Item -LiteralPath $l -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $oldExe) { $ok = $false } # still running somewhere: keep the registry entries so it's found next time
    else {
      try {
        $hk = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', 'Registry64')
        $hk.DeleteSubKeyTree('Software\Microsoft\Windows\CurrentVersion\Uninstall\PhoneDrop', $false)
        $hk.DeleteSubKeyTree('Software\PhoneDrop', $false)
      } catch { $ok = $false }
    }
  }
  if ($ok) { Done 0 } else { Done 2 }
}
Done 3
