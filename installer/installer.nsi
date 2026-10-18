; PhoneDrop installer (NSIS 3, Modern UI 2)
; Built by scripts/build.mjs -> dist\PhoneDrop-Setup.exe

Unicode true
ManifestDPIAware true

!define APP      "PhoneDrop"
!ifndef VERSION
  !define VERSION "1.0.0"
!endif
!define UNINST   "Software\Microsoft\Windows\CurrentVersion\Uninstall\PhoneDrop"

Name "${APP}"
OutFile "..\dist\PhoneDrop-Setup.exe"
InstallDir "$PROGRAMFILES64\${APP}"
InstallDirRegKey HKLM "Software\${APP}" "InstallDir"
RequestExecutionLevel admin
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
Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "PhoneDrop needs 64-bit Windows 10 or 11."
    Abort
  ${EndIf}
  SetRegView 64
FunctionEnd

Function un.onInit
  SetRegView 64
FunctionEnd

; Start the app as the normal (non-admin) user, so dragging files into its window works.
Function LaunchApp
  Exec '"$WINDIR\explorer.exe" "$INSTDIR\PhoneDrop.exe"'
FunctionEnd

; ---------- install ----------
Section "PhoneDrop" SecApp
  SectionIn RO

  ; close a running copy so it can be updated
  nsExec::Exec 'taskkill /F /IM PhoneDrop.exe'
  Sleep 600

  SetOutPath "$INSTDIR"
  File "..\dist\PhoneDrop.exe"
  FileOpen $0 "$INSTDIR\installed.txt" w
  FileWrite $0 "Installed by PhoneDrop Setup ${VERSION}"
  FileClose $0
  WriteUninstaller "$INSTDIR\Uninstall PhoneDrop.exe"

  ; tidy up shortcuts from older, unpacked versions of PhoneDrop
  SetShellVarContext current
  Delete "$SMPROGRAMS\PhoneDrop.lnk"
  Delete "$DESKTOP\PhoneDrop.lnk"

  SetShellVarContext all
  CreateShortcut "$SMPROGRAMS\PhoneDrop.lnk" "$INSTDIR\PhoneDrop.exe" "" "$INSTDIR\PhoneDrop.exe" 0 SW_SHOWNORMAL "" "Send photos and files from this PC to your phone"

  ; let phones on the Wi-Fi reach PhoneDrop (no firewall pop-up later)
  DetailPrint "Allowing PhoneDrop through Windows Firewall..."
  nsExec::Exec 'netsh advfirewall firewall delete rule name="PhoneDrop"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="PhoneDrop" dir=in action=allow program="$INSTDIR\PhoneDrop.exe" enable=yes profile=any'

  ; show up in Settings > Apps > Installed apps
  WriteRegStr HKLM "Software\${APP}" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "${UNINST}" "DisplayName" "${APP}"
  WriteRegStr HKLM "${UNINST}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINST}" "Publisher" "${APP}"
  WriteRegStr HKLM "${UNINST}" "DisplayIcon" "$INSTDIR\PhoneDrop.exe"
  WriteRegStr HKLM "${UNINST}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINST}" "UninstallString" '"$INSTDIR\Uninstall PhoneDrop.exe"'
  WriteRegStr HKLM "${UNINST}" "QuietUninstallString" '"$INSTDIR\Uninstall PhoneDrop.exe" /S'
  WriteRegDWORD HKLM "${UNINST}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINST}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKLM "${UNINST}" "EstimatedSize" "$0"
SectionEnd

Section "Desktop shortcut" SecDesktop
  SetShellVarContext all
  CreateShortcut "$DESKTOP\PhoneDrop.lnk" "$INSTDIR\PhoneDrop.exe" "" "$INSTDIR\PhoneDrop.exe" 0 SW_SHOWNORMAL "" "Send photos and files from this PC to your phone"
SectionEnd

Section /o "Start PhoneDrop when I sign in" SecStartup
  SetShellVarContext current
  CreateShortcut "$SMSTARTUP\PhoneDrop.lnk" "$INSTDIR\PhoneDrop.exe"
SectionEnd

; ---------- uninstall ----------
Section "Uninstall"
  nsExec::Exec 'taskkill /F /IM PhoneDrop.exe'
  Sleep 600

  SetShellVarContext all
  Delete "$SMPROGRAMS\PhoneDrop.lnk"
  Delete "$DESKTOP\PhoneDrop.lnk"
  SetShellVarContext current
  Delete "$SMPROGRAMS\PhoneDrop.lnk"
  Delete "$DESKTOP\PhoneDrop.lnk"
  Delete "$SMSTARTUP\PhoneDrop.lnk"

  nsExec::Exec 'netsh advfirewall firewall delete rule name="PhoneDrop"'

  Delete "$INSTDIR\PhoneDrop.exe"
  Delete "$INSTDIR\installed.txt"
  Delete "$INSTDIR\Uninstall PhoneDrop.exe"
  RMDir "$INSTDIR"

  ; PhoneDrop's shared files, thumbnails and certificate for this user
  RMDir /r "$LOCALAPPDATA\PhoneDrop"

  DeleteRegKey HKLM "${UNINST}"
  DeleteRegKey HKLM "Software\${APP}"
SectionEnd
