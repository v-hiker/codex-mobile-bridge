!macro CMB_CHECK_AND_STOP_RUNNING_BODY
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $0
  Push $1
  Push $2

  InitPluginsDir
  File "/oname=$PLUGINSDIR\cmb-stop-instances.ps1" "${PROJECT_DIR}\desktop\nsis-stop-instances.ps1"

  StrCpy $R0 "$INSTDIR"
  ReadRegStr $R1 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $R1 != ""
    StrCpy $R0 "$R0;$R1"
  ${EndIf}
  ReadRegStr $R2 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $R2 != ""
    StrCpy $R0 "$R0;$R2"
  ${EndIf}

  System::Call 'kernel32::GetCurrentProcessId() i.r13'

cmb_stop_inspect_loop:
  nsExec::Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\cmb-stop-instances.ps1" -Mode inspect -DirsJoined "$R0" -CallerPid $R3'
  Pop $0

  ${If} $0 == 0
    Goto cmb_stop_done
  ${ElseIf} $0 == 10
    DetailPrint "正在自动停止运行中的 Codex Mobile Bridge 与网关实例..."
    nsExec::Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\cmb-stop-instances.ps1" -Mode stop -DirsJoined "$R0" -CallerPid $R3'
    Pop $1
    ${If} $1 == 0
      Goto cmb_stop_done
    ${EndIf}
  ${ElseIf} $0 == 20
  ${OrIf} $0 == 21
  ${OrIf} $0 == 22
    ${If} $0 == 22
      StrCpy $R4 "Codex Desktop 和 ZCode"
    ${ElseIf} $0 == 21
      StrCpy $R4 "ZCode"
    ${Else}
      StrCpy $R4 "Codex Desktop"
    ${EndIf}
    ${If} ${Silent}
      nsExec::Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\cmb-stop-instances.ps1" -Mode stop -IncludeHolders -DirsJoined "$R0" -CallerPid $R3'
      Pop $1
      ${If} $1 == 0
        Goto cmb_stop_done
      ${EndIf}
      SetErrorLevel 2
      Quit
    ${EndIf}
    MessageBox MB_YESNO|MB_ICONQUESTION "检测到 Codex Mobile Bridge 及关联的 $R4 正在运行并占用旧版网关程序。$\r$\n$\r$\n点击「是(Y)」自动停止上述实例并继续更新（请先确认其中没有正在执行的任务）；$\r$\n点击「否(N)」取消本次更新。" IDYES cmb_stop_with_holders
    Quit
cmb_stop_with_holders:
    DetailPrint "正在自动停止 $R4、Codex Mobile Bridge 与网关实例..."
    nsExec::Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\cmb-stop-instances.ps1" -Mode stop -IncludeHolders -DirsJoined "$R0" -CallerPid $R3'
    Pop $1
    ${If} $1 == 0
      Goto cmb_stop_done
    ${EndIf}
  ${Else}
    nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM "${APP_EXECUTABLE_FILENAME}"'
    Pop $1
    nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM "codex-mobile-gateway.exe"'
    Pop $2
    Sleep 500
    Goto cmb_stop_done
  ${EndIf}

  ${If} ${Silent}
    SetErrorLevel 2
    Quit
  ${EndIf}
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "部分运行中的实例未能自动停止，请先手动关闭 Codex Mobile Bridge 与相关程序，然后点击「重试」继续更新。" IDRETRY cmb_stop_inspect_loop
  Quit

cmb_stop_done:
  Pop $2
  Pop $1
  Pop $0
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend

!macro customCheckAppRunning
  !ifdef BUILD_UNINSTALLER
    !insertmacro CMB_CHECK_AND_STOP_RUNNING_BODY
  !else
    Call CmbCheckAndStopRunning
  !endif
!macroend

!ifndef BUILD_UNINSTALLER
  !macro customInit
    ${If} ${UAC_IsInnerInstance}
    ${AndIf} ${UAC_IsAdmin}
      !insertmacro UAC_AsUser_GetGlobalVar $CustomElevatedDir
      StrCpy $RestoredElevatedDir "0"
      ${If} $CustomElevatedDir != ""
        StrCpy $INSTDIR $CustomElevatedDir
      ${EndIf}
    ${EndIf}
  !macroend

  !macro customHeader
    Function .onVerifyInstDir
      ${If} ${UAC_IsInnerInstance}
      ${AndIf} ${UAC_IsAdmin}
      ${AndIf} $CustomElevatedDir != ""
      ${AndIf} $RestoredElevatedDir != "1"
        StrCpy $RestoredElevatedDir "1"
        StrCpy $INSTDIR $CustomElevatedDir
        Push $R0
        Push $R1
        FindWindow $R0 "#32770" "" $HWNDPARENT
        ${If} $R0 != 0
          GetDlgItem $R1 $R0 1019
          ${If} $R1 != 0
            SendMessage $R1 ${WM_SETTEXT} 0 "STR:$CustomElevatedDir"
          ${EndIf}
        ${EndIf}
        Pop $R1
        Pop $R0
      ${EndIf}
    FunctionEnd
  !macroend

  !macro customPageAfterChangeDir
    Var CustomElevatedDir
    Var RestoredElevatedDir
    Var CmbDirWritable
    Var CmbDirElevationPage

    Function CmbIsInstDirWritable
      Push $R0
      Push $R1
      Push $R2
      Push $R3
      Push $R4
      Push $0
      Push $1
      Push $2

      StrCpy $R0 $INSTDIR
      ${Do}
        StrLen $R1 $R0
        ${If} $R1 <= 0
          ${Break}
        ${EndIf}
        ${If} $R1 > 3
          StrCpy $R2 $R0 1 -1
          ${If} $R2 == "\"
            StrCpy $R0 $R0 -1
            ${Continue}
          ${EndIf}
        ${EndIf}
        System::Call 'kernel32::GetFileAttributesW(w "$R0") i.r1'
        ${If} $1 != -1
          IntOp $2 $1 & 0x10
          ${If} $2 != 0
            ${Break}
          ${EndIf}
        ${EndIf}
        ${If} $R1 <= 3
          StrCpy $R0 ""
          ${Break}
        ${EndIf}
        StrCpy $R3 $R1
        StrCpy $R4 0
        ${Do}
          IntOp $R3 $R3 - 1
          ${If} $R3 < 0
            ${Break}
          ${EndIf}
          StrCpy $R2 $R0 1 $R3
          ${If} $R2 == "\"
            ${If} $R3 == 2
              StrCpy $R2 $R0 1 1
              ${If} $R2 == ":"
                IntOp $R3 $R3 + 1
                StrCpy $R0 $R0 $R3
                StrCpy $R4 1
                ${Break}
              ${EndIf}
            ${EndIf}
            ${If} $R3 > 0
              StrCpy $R0 $R0 $R3
              StrCpy $R4 1
            ${EndIf}
            ${Break}
          ${EndIf}
        ${Loop}
        ${If} $R4 == 0
          StrCpy $R0 ""
          ${Break}
        ${EndIf}
      ${Loop}

      StrCpy $CmbDirWritable "0"
      ${If} $R0 != ""
        System::Call 'kernel32::CreateFileW(w "$R0", i 0x6, i 7, p 0, i 3, i 0x02000000, p 0) p.r1'
        ${If} $1 <> -1
          System::Call 'kernel32::CloseHandle(p r1)'
          StrCpy $CmbDirWritable "1"
        ${EndIf}
      ${EndIf}

      Pop $2
      Pop $1
      Pop $0
      Pop $R4
      Pop $R3
      Pop $R2
      Pop $R1
      Pop $R0
    FunctionEnd

    Function CmbRequestDirElevation
      StrCpy $CustomElevatedDir $INSTDIR
      ShowWindow $HWNDPARENT ${SW_HIDE}
      !insertmacro UAC_RunElevated
      ${Switch} $0
        ${Case} 0
          ${If} $1 = 1
            Quit
          ${EndIf}
          ${If} $1 = 3
          ${OrIf} $2 = 0x666666
            MessageBox mb_IconStop|mb_TopMost|mb_SetForeground "$(loginWithAdminAccount)"
          ${EndIf}
          ${Break}
        ${Case} 1223
          ${Break}
        ${Case} 1062
          MessageBox mb_IconStop|mb_TopMost|mb_SetForeground "Logon service not running, aborting!"
          ${Break}
        ${Default}
          MessageBox mb_IconStop|mb_TopMost|mb_SetForeground "Unable to elevate, error $0"
          ${Break}
      ${EndSwitch}
      StrCpy $CustomElevatedDir ""
      ShowWindow $HWNDPARENT ${SW_SHOW}
      BringToFront
    FunctionEnd

    Function CmbCheckAndStopRunning
      !insertmacro CMB_CHECK_AND_STOP_RUNNING_BODY
    FunctionEnd

    Function CheckDirectoryElevationPre
      ${If} ${UAC_IsInnerInstance}
      ${AndIf} ${UAC_IsAdmin}
        ${If} $CustomElevatedDir != ""
        ${AndIf} $RestoredElevatedDir != "1"
          StrCpy $RestoredElevatedDir "1"
          StrCpy $INSTDIR $CustomElevatedDir
        ${EndIf}
        GetDlgItem $0 $HWNDPARENT 1
        SendMessage $0 ${BCM_SETSHIELD} 0 0
        Call CmbCheckAndStopRunning
        Abort
      ${EndIf}
      ${If} ${UAC_IsAdmin}
        GetDlgItem $0 $HWNDPARENT 1
        SendMessage $0 ${BCM_SETSHIELD} 0 0
        Call CmbCheckAndStopRunning
        Abort
      ${EndIf}
      Call CmbIsInstDirWritable
      ${If} $CmbDirWritable == "1"
        GetDlgItem $0 $HWNDPARENT 1
        SendMessage $0 ${BCM_SETSHIELD} 0 0
        Call CmbCheckAndStopRunning
        Abort
      ${EndIf}

      Call CmbRequestDirElevation

      !insertmacro MUI_HEADER_TEXT "需要管理员权限" "所选安装目录需要管理员权限才能写入。"
      nsDialogs::Create 1018
      Pop $CmbDirElevationPage
      ${If} $CmbDirElevationPage == error
        Abort
      ${EndIf}
      ${NSD_CreateLabel} 0u 0u 300u 70u "目录 $INSTDIR 需要管理员权限才能创建或写入文件。$\r$\n$\r$\n点击「下一步」重新发起 UAC 管理员提权，或点击「上一步」更换为当前用户可写的安装目录。"
      Pop $0
      GetDlgItem $0 $HWNDPARENT 1
      SendMessage $0 ${BCM_SETSHIELD} 0 1
      nsDialogs::Show
    FunctionEnd

    Function CheckDirectoryElevationLeave
      ${IfNot} ${UAC_IsAdmin}
        Call CmbRequestDirElevation
        ${IfNot} ${UAC_IsAdmin}
          Abort
        ${EndIf}
      ${EndIf}
    FunctionEnd

    Page custom CheckDirectoryElevationPre CheckDirectoryElevationLeave
  !macroend
!endif

!macro customUnInstallSection
  Var CmbDataCleanupSafe

  Function un.CmbCheckDataDirectory
    Exch $R0
    Push $R1
    Push $R2
    Push $R3
    System::Call 'kernel32::GetFileAttributesW(w "$R0") i.s'
    Pop $R3
    ${if} $R3 == -1
      StrCpy $CmbDataCleanupSafe 0
    ${else}
      IntOp $R1 $R3 & 0x400
      ${if} $R1 != 0
        StrCpy $CmbDataCleanupSafe 0
      ${else}
        IntOp $R3 $R3 & 0x10
        ${if} $R3 != 0
          ClearErrors
          FindFirst $R1 $R2 "$R0\*.*"
          ${if} ${Errors}
            StrCpy $CmbDataCleanupSafe 0
          ${else}
            ${do}
              ${if} $R2 != "."
              ${andIf} $R2 != ".."
                ${if} $R2 == "claude-accounts"
                  StrCpy $CmbDataCleanupSafe 0
                ${else}
                  Push "$R0\$R2"
                  Call un.CmbCheckDataDirectory
                ${endif}
              ${endif}
              ${if} $CmbDataCleanupSafe == 0
                ${exitDo}
              ${endif}
              FindNext $R1 $R2
            ${loopUntil} ${Errors}
            FindClose $R1
          ${endif}
        ${endif}
      ${endif}
    ${endif}
    Pop $R3
    Pop $R2
    Pop $R1
    Pop $R0
  FunctionEnd

  Section /o "un.清理网关设置与缓存" SEC_REMOVE_CMB_DATA
    ${ifNot} ${isUpdated}
      StrCpy $0 "$APPDATA\codex-mobile-bridge-desktop"
      ${if} ${FileExists} "$0\gateway\gateway-control.json"
        MessageBox MB_OK|MB_ICONEXCLAMATION "网关尚有运行控制记录。为保护当前连接与资料，已保留设置目录；请先停止网关后再清理。"
        Goto un_skip_cmb_data
      ${endif}
      ${if} $APPDATA != ""
        ${if} $0 != "$APPDATA"
          System::Call 'kernel32::GetFileAttributesW(w "$0") i.r1'
          ${if} $1 != -1
            IntOp $2 $1 & 0x10
            ${if} $2 != 0
              IntOp $2 $1 & 0x400
              ${if} $2 == 0
                StrCpy $CmbDataCleanupSafe 1
                Push "$0"
                Call un.CmbCheckDataDirectory
                ${if} $CmbDataCleanupSafe == 1
                  MessageBox MB_YESNO|MB_ICONEXCLAMATION "仅删除 Codex Mobile Bridge 自己的本机设置与缓存：$\r$\n$0$\r$\nCodex 和其他 Agent 的账号、会话及配置不会删除。确认继续？" IDNO un_skip_cmb_data
                  RMDir /r "$0"
                ${else}
                  MessageBox MB_OK|MB_ICONEXCLAMATION "网关目录含有客户端账号资料、目录链接或无法核验的项目。为保护 Agent 数据，已保留该目录，请仅手动清理确认属于网关的文件。"
                ${endif}
              ${else}
                MessageBox MB_OK|MB_ICONEXCLAMATION "网关数据目录是重解析路径。为保护其他应用数据，未删除该目录。"
              ${endif}
            ${endif}
          ${endif}
        ${endif}
      ${endif}
    ${endIf}
un_skip_cmb_data:
  SectionEnd
!macroend
