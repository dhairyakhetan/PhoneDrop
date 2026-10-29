; PhoneDrop installer (NSIS 3, Modern UI 2)
; Built by scripts/build.mjs -> dist\PhoneDrop-Setup.exe
;
; Installs for the signed-in user only (%LOCALAPPDATA%\Programs\PhoneDrop, like VS Code's or Ferry's user
; installers), so installing and updating never need admin: no Windows prompt, no shield. The data folder stays
; %LOCALAPPDATA%\PhoneDrop. The one thing that needs admin is done once, by finish-setup.ps1 with a single Windows
; prompt at the end of the first install: let phones through Windows Firewall, and remove PhoneDrop 1.x from Program
; Files (it was installed for all users). Answered No: PhoneDrop installs anyway and offers "Finish setup" later.

Unicode true
ManifestDPIAware true

!define APP      "PhoneDrop"
!ifndef VERSION
  !define VERSION "1.0.0"
!endif
!define UNINST   "Software\Microsoft\Windows\CurrentVersion\Uninstall\PhoneDrop"

Name "${APP}"
OutFile "..\dist\PhoneDrop-Setup.exe"
InstallDir "$LOCALAPPDATA\Programs\${APP}"
InstallDirRegKey HKCU "Software\${APP}" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 64
BrandingText "${APP} ${VERSION}"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName"     "${APP}"
VIAddVersionKey "CompanyName"     "${APP}"
VIAddVersionKey "FileDescription" "${APP} Setup"
VIAddVersionKey "FileVersion"     "${VERSION}"
VIAddVersionKey "ProductVersion"  "${VERSION}"
VIAddVersionKey "LegalCopyright"  "Built on Node.js (MIT license)"

!include "MUI2.nsh"
!include "x64.nsh"
!include "FileFunc.nsh"

; ---------- look ----------
!define MUI_ICON   "..\assets\PhoneDrop.ico"
!define MUI_UNICON "..\assets\PhoneDrop.ico"
!define MUI_WELCOMEFINISHPAGE_BITMAP   "wizard.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "wizard.bmp"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_RIGHT
!define MUI_HEADERIMAGE_BITMAP "header.bmp"
!define MUI_HEADERIMAGE_UNBITMAP "header.bmp"
!define MUI_ABORTWARNING
!define MUI_ABORTWARNING_TEXT "Stop installing PhoneDrop?"
!define MUI_COMPONENTSPAGE_NODESC

; ---------- pages ----------
!define MUI_WELCOMEPAGE_TITLE "Welcome to PhoneDrop"
!define MUI_WELCOMEPAGE_TEXT "PhoneDrop sends photos, videos and files from this PC to your phone over Wi-Fi.$\r$\n$\r$\nNo cables, no cloud, no accounts. Everything arrives in full quality, with dates and locations kept.$\r$\n$\r$\nClick Next to continue."
!insertmacro MUI_PAGE_WELCOME

!define MUI_PAGE_HEADER_TEXT "Choose what to add"
!define MUI_PAGE_HEADER_SUBTEXT "PhoneDrop is always added to the Start Menu."
!define MUI_COMPONENTSPAGE_TEXT_TOP "Tick anything else you'd like, then click Next."
!insertmacro MUI_PAGE_COMPONENTS

!insertmacro MUI_PAGE_DIRECTORY

!define MUI_PAGE_HEADER_TEXT "Installing PhoneDrop"
!define MUI_PAGE_HEADER_SUBTEXT "This only takes a few seconds."
!insertmacro MUI_PAGE_INSTFILES

!define MUI_FINISHPAGE_TITLE "PhoneDrop is ready"
!define MUI_FINISHPAGE_TEXT "Open PhoneDrop, drop in photos or videos, and scan the QR code with your phone.$\r$\n$\r$\nYou'll find PhoneDrop in the Start Menu any time."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Open PhoneDrop now"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchApp
!define MUI_FINISHPAGE_NOREBOOTSUPPORT
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; ---------- helpers ----------
Var OldDir    ; PhoneDrop 1.x, installed for all users in Program Files (empty if there's none)
Var FirstHere ; 1 = PhoneDrop wasn't installed for this user yet

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "PhoneDrop needs 64-bit Windows 10 or 11."
    Abort
  ${EndIf}
  SetShellVarContext current
  SetRegView 64
  ; update the copy that's already installed for this user, wherever it is
  ReadRegStr $0 HKCU "Software\${APP}" "InstallDir"
  ${If} $0 != ""
    StrCpy $INSTDIR $0
  ${Else}
    StrCpy $FirstHere 1
  ${EndIf}
  ReadRegStr $OldDir HKLM "Software\${APP}" "InstallDir"
FunctionEnd

Function un.onInit
  SetShellVarContext current
  SetRegView 64
FunctionEnd

; This installer isn't elevated, so PhoneDrop starts as the normal user (dragging files into its window works).
Function LaunchApp
  Exec '"$INSTDIR\PhoneDrop.exe"'
FunctionEnd

; The one admin step (installer\finish-setup.ps1): one Windows prompt. Firewall rule for this PhoneDrop.exe, no
; block rules for it, and PhoneDrop 1.x out of Program Files. 64-bit PowerShell (Sysnative: this installer is 32-bit).
; ExecShellWait only says whether it started (No on the Windows prompt = it didn't), so the script writes its exit
; code to setup-result.txt: 0 = done. Not done: PhoneDrop is installed anyway and shows "Finish setup" until it is.
Function FinishSetup
  DetailPrint "Letting phones reach PhoneDrop through Windows Firewall (Windows asks once)..."
  InitPluginsDir
  File "/oname=$PLUGINSDIR\finish-setup.ps1" "finish-setup.ps1"
  Delete "$PLUGINSDIR\setup-result.txt"
  ExecShellWait "runas" "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$PLUGINSDIR\finish-setup.ps1" -Mode finish -Exe "$INSTDIR\PhoneDrop.exe" -Result "$PLUGINSDIR\setup-result.txt"' SW_HIDE
  StrCpy $0 ""
  ClearErrors
  FileOpen $1 "$PLUGINSDIR\setup-result.txt" r
  ${IfNot} ${Errors}
    FileRead $1 $0 1
    FileClose $1
  ${EndIf}
  ${If} $0 == "0"
    WriteRegStr HKCU "Software\${APP}" "SetupDone" "$INSTDIR\PhoneDrop.exe"
    DetailPrint "Done: phones can reach PhoneDrop."
  ${Else}
    DetailPrint "Not now: PhoneDrop offers to finish this later."
  ${EndIf}
FunctionEnd

; $R0 = 1 if PhoneDrop.exe is running, else 0 (find exits 0 when it's in the process list; this installer's own
; name, PhoneDrop-Setup-….exe, doesn't contain "PhoneDrop.exe")
Function IsAppRunning
  nsExec::Exec '"$SYSDIR\cmd.exe" /c tasklist /NH | find "PhoneDrop.exe"'
  Pop $R0
  ${If} $R0 == 0
    StrCpy $R0 1
  ${Else}
    StrCpy $R0 0
  ${EndIf}
FunctionEnd

; close PhoneDrop and wait until it's really gone (Windows keeps a running program's file locked), at most 10 s
Function CloseApp
  StrCpy $R1 0
  ${Do}
    nsExec::Exec 'taskkill /F /IM PhoneDrop.exe'
    Call IsAppRunning
    ${If} $R0 == 0
    ${OrIf} $R1 >= 20
      ${ExitDo}
    ${EndIf}
    Sleep 500
    IntOp $R1 $R1 + 1
  ${Loop}
FunctionEnd

; PhoneDrop's in-app updater runs "PhoneDrop-Setup.exe /S" (silent, no pages): open PhoneDrop again afterwards,
; and if it still isn't running 15 s later (something on that PC got in the way), start it once more, so an update
; never leaves you without PhoneDrop.
Function .onInstSuccess
  ${If} ${Silent}
    Call LaunchApp
    StrCpy $R1 0
    ${Do}
      Sleep 500
      Call IsAppRunning
      ${If} $R0 == 1
        ${ExitDo}
      ${EndIf}
      IntOp $R1 $R1 + 1
      ${If} $R1 >= 30
        Exec '"$INSTDIR\PhoneDrop.exe"'
        ${ExitDo}
      ${EndIf}
    ${Loop}
  ${EndIf}
FunctionEnd

; ---------- install ----------
; PhoneDrop's window gets its own taskbar button with PhoneDrop's icon, and a pin starts PhoneDrop.exe: the
; shortcuts carry the same Windows "AppUserModelID" PhoneDrop gives its window (installer\appid.ps1 explains)
!macro LabelShortcut LNK
  nsExec::Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\appid.ps1" -Shortcut "${LNK}"'
  Pop $0
!macroend

Section "PhoneDrop" SecApp
  SectionIn RO
  SetShellVarContext current

  ; close a running copy so it can be updated
  Call CloseApp

  SetOutPath "$INSTDIR"
  ; a file that's still locked can be renamed but not overwritten: move the old one aside first, so writing the new
  ; one can't fail (during a silent update nobody would see the error box, and the update would just hang)
  Delete "$INSTDIR\PhoneDrop.old"
  Rename "$INSTDIR\PhoneDrop.exe" "$INSTDIR\PhoneDrop.old"
  File "..\dist\PhoneDrop.exe"
  Delete /REBOOTOK "$INSTDIR\PhoneDrop.old"
  FileOpen $0 "$INSTDIR\installed.txt" w
  FileWrite $0 "Installed by PhoneDrop Setup ${VERSION}"
  FileClose $0
  WriteUninstaller "$INSTDIR\Uninstall PhoneDrop.exe"

  CreateShortcut "$SMPROGRAMS\PhoneDrop.lnk" "$INSTDIR\PhoneDrop.exe" "" "$INSTDIR\PhoneDrop.exe" 0 SW_SHOWNORMAL "" "Send photos and files between this PC and your phone"
  InitPluginsDir
  File "/oname=$PLUGINSDIR\appid.ps1" "appid.ps1"
  !insertmacro LabelShortcut "$SMPROGRAMS\PhoneDrop.lnk"
  ; "Start PhoneDrop when I sign in" from before (PhoneDrop 1.x pointed it at Program Files): point it here
  ${If} ${FileExists} "$SMSTARTUP\PhoneDrop.lnk"
    CreateShortcut "$SMSTARTUP\PhoneDrop.lnk" "$INSTDIR\PhoneDrop.exe"
    !insertmacro LabelShortcut "$SMSTARTUP\PhoneDrop.lnk"
  ${EndIf}

  ; show up in Settings > Apps > Installed apps (for this user)
  WriteRegStr HKCU "Software\${APP}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINST}" "DisplayName" "${APP}"
  WriteRegStr HKCU "${UNINST}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST}" "Publisher" "${APP}"
  WriteRegStr HKCU "${UNINST}" "DisplayIcon" "$INSTDIR\PhoneDrop.exe"
  WriteRegStr HKCU "${UNINST}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST}" "UninstallString" '"$INSTDIR\Uninstall PhoneDrop.exe"'
  WriteRegStr HKCU "${UNINST}" "QuietUninstallString" '"$INSTDIR\Uninstall PhoneDrop.exe" /S'
  WriteRegDWORD HKCU "${UNINST}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINST}" "EstimatedSize" "$0"

  ; the one admin step, asked for once:
  ; - the update from 1.x (silent: the old updater runs it), which moves PhoneDrop here from Program Files. Its
  ;   banner already says "Click Yes if Windows asks".
  ; - installing by hand, while it isn't done for this PhoneDrop.exe yet
  ; Updates after that never ask, even if it was answered No: PhoneDrop itself offers "Finish setup" then.
  ReadRegStr $0 HKCU "Software\${APP}" "SetupDone"
  ${If} $FirstHere == 1
  ${AndIf} $OldDir != ""
    Call FinishSetup
  ${ElseIfNot} ${Silent}
  ${AndIf} $0 != "$INSTDIR\PhoneDrop.exe"
    Call FinishSetup
  ${EndIf}
SectionEnd

Section "Desktop shortcut" SecDesktop
  ; PhoneDrop 1.x put its shortcut on every user's desktop; it goes with the old copy, so this user gets their own
  StrCpy $1 0
  ${If} $OldDir != ""
    SetShellVarContext all
    ${If} ${FileExists} "$DESKTOP\PhoneDrop.lnk"
      StrCpy $1 1
    ${EndIf}
  ${EndIf}
  SetShellVarContext current
  ; a silent update only refreshes the shortcut, so one you deleted doesn't come back
  ${IfNot} ${Silent}
  ${OrIf} ${FileExists} "$DESKTOP\PhoneDrop.lnk"
  ${OrIf} $1 == 1
    CreateShortcut "$DESKTOP\PhoneDrop.lnk" "$INSTDIR\PhoneDrop.exe" "" "$INSTDIR\PhoneDrop.exe" 0 SW_SHOWNORMAL "" "Send photos and files between this PC and your phone"
    !insertmacro LabelShortcut "$DESKTOP\PhoneDrop.lnk"
  ${EndIf}
SectionEnd

Section /o "Start PhoneDrop when I sign in" SecStartup
  SetShellVarContext current
  CreateShortcut "$SMSTARTUP\PhoneDrop.lnk" "$INSTDIR\PhoneDrop.exe"
  !insertmacro LabelShortcut "$SMSTARTUP\PhoneDrop.lnk"
SectionEnd

; ---------- uninstall ----------
Section "Uninstall"
  SetShellVarContext current
  nsExec::Exec 'taskkill /F /IM PhoneDrop.exe'
  Sleep 1000

  Delete "$SMPROGRAMS\PhoneDrop.lnk"
  Delete "$DESKTOP\PhoneDrop.lnk"
  Delete "$SMSTARTUP\PhoneDrop.lnk"

  ; the firewall rule needs admin to remove: ask once (not in a silent uninstall); answered No, it just stays
  ReadRegStr $0 HKCU "Software\${APP}" "SetupDone"
  ${If} $0 != ""
  ${AndIfNot} ${Silent}
    InitPluginsDir
    File "/oname=$PLUGINSDIR\finish-setup.ps1" "finish-setup.ps1"
    ExecShellWait "runas" "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$PLUGINSDIR\finish-setup.ps1" -Mode remove -Exe "$INSTDIR\PhoneDrop.exe"' SW_HIDE
  ${EndIf}

  Delete "$INSTDIR\PhoneDrop.exe"
  Delete "$INSTDIR\PhoneDrop.old"
  Delete "$INSTDIR\installed.txt"
  Delete "$INSTDIR\Uninstall PhoneDrop.exe"
  RMDir "$INSTDIR"

  ; PhoneDrop's shared files, thumbnails, paired phones and certificate for this user
  RMDir /r "$LOCALAPPDATA\PhoneDrop"

  DeleteRegKey HKCU "${UNINST}"
  DeleteRegKey HKCU "Software\${APP}"
SectionEnd
