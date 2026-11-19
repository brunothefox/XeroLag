!include LogicLib.nsh
!include FileFunc.nsh
!ifndef BUILD_UNINSTALLER
  Var XeroDesktop
!endif
!macro customInit
  StrCpy $XeroDesktop 1
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/no-desktop-shortcut" $1
  ${IfNot} ${Errors}
    StrCpy $XeroDesktop 0
  ${EndIf}
!macroend
!macro customInstall
  ${If} $XeroDesktop == 1
    ClearErrors
    CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ${IfNot} ${Errors}
      WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
    ${Else}
      DetailPrint "Desktop shortcut unavailable. Use the Start menu to open XeroLag."
    ${EndIf}
  ${EndIf}
!macroend
!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Remove XeroLag"
  !define MUI_WELCOMEPAGE_TEXT "Setup will remove XeroLag. Saved settings and recovery backups will be kept.$\r$\n$\r$\nUninstalling does not revert Windows tweaks. Use Recovery inside XeroLag first to restore saved settings."
  !insertmacro MUI_UNPAGE_WELCOME
!macroend
