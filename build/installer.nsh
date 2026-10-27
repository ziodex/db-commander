; Replacing the default electron-builder hook avoids force-closing database
; sessions during an upgrade or uninstall. Return 2 for unattended callers.
; nsProcess returns 603 only when no matching process is running. Errors also
; block the operation. Checking all visible Db Commander processes is deliberate.
!macro customCheckAppRunning
  nsProcess::_FindProcess "${APP_EXECUTABLE_FILENAME}"
  Pop $R0
  ${If} $R0 != 603
    MessageBox MB_OK|MB_ICONEXCLAMATION "Close Db Commander and finish any active transactions before installing or uninstalling. If Db Commander is already closed, restart Windows and try again." /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

; Normal uninstall must not report success while a scanner or recently exited
; native process still holds the executable. Refuse before removing other files
; or registration if the lock persists. Upgrades keep builder's atomic rename
; and restore path unchanged.
!macro customUnInstall
  ${IfNot} ${isUpdated}
    StrCpy $R0 40
    dbcommander_remove_executable:
      IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 dbcommander_removed_executable
      ClearErrors
      Delete "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      IfErrors 0 dbcommander_removed_executable
      IntOp $R0 $R0 - 1
      ${If} $R0 > 0
        Sleep 250
        Goto dbcommander_remove_executable
      ${EndIf}
      MessageBox MB_OK|MB_ICONEXCLAMATION "Db Commander files are still in use. Close applications using the installation folder and retry uninstalling. The installation and user data were kept." /SD IDOK
      SetErrorLevel 3
      Quit
    dbcommander_removed_executable:
  ${EndIf}
!macroend
