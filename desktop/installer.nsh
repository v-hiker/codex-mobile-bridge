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
    ${If} $CmbStopDoneFlag != "1"
      Call CmbCheckAndStopRunning
    ${EndIf}
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

    !ifndef PBS_MARQUEE
      !define PBS_MARQUEE 0x08
    !endif
    !ifndef PBM_SETMARQUEE
      !define PBM_SETMARQUEE 0x040A
    !endif
    !ifndef WM_NOTIFY_OUTER_NEXT
      !define WM_NOTIFY_OUTER_NEXT 0x0408
    !endif

    Var CmbStopPage
    Var CmbStopTitleLabel
    Var CmbStopStatusLabel
    Var CmbStopHintLabel
    Var CmbStopProgressBar
    Var CmbStopProcHandle
    Var CmbStopState
    Var CmbStopHolderLabel
    Var CmbStopDirs
    Var CmbStopCallerPid
    Var CmbStopTick
    Var CmbStopDoneFlag

    Function CmbCheckAndStopRunning
      !insertmacro CMB_CHECK_AND_STOP_RUNNING_BODY
    FunctionEnd

    Function CmbCloseAsyncProc
      ${If} $CmbStopProcHandle != ""
      ${AndIf} $CmbStopProcHandle != "0"
        System::Call 'kernel32::CloseHandle(p $CmbStopProcHandle)'
        StrCpy $CmbStopProcHandle "0"
      ${EndIf}
    FunctionEnd

    Function CmbStartAsyncPs
      Push $R1
      Push $R2
      Push $0
      Push $1
      Push $2
      Call CmbCloseAsyncProc
      System::Alloc 68
      Pop $R1
      System::Call "*$R1(i 68)"
      System::Alloc 16
      Pop $R2
      System::Call 'kernel32::CreateProcessW(p 0, w r10, p 0, p 0, i 0, i 0x08000000, p 0, p 0, p r11, p r12) i.r0'
      ${If} $0 != 0
        System::Call "*$R2(p.r1, p.r2)"
        System::Call 'kernel32::CloseHandle(p r2)'
        StrCpy $CmbStopProcHandle $1
      ${EndIf}
      System::Free $R1
      System::Free $R2
      Pop $2
      Pop $1
      Pop $0
      Pop $R2
      Pop $R1
    FunctionEnd

    Function CmbUpdateRunningText
      Push $R1
      Push $R2
      Push $R3
      Push $R4
      Push $R5

      IntOp $CmbStopTick $CmbStopTick + 1
      IntOp $R3 $CmbStopTick % 4
      ${If} $R3 == 0
        StrCpy $R5 ""
      ${ElseIf} $R3 == 1
        StrCpy $R5 "."
      ${ElseIf} $R3 == 2
        StrCpy $R5 ".."
      ${Else}
        StrCpy $R5 "..."
      ${EndIf}

      StrCpy $R2 ""
      ClearErrors
      FileOpen $R1 "$PLUGINSDIR\cmb-stop-phase.txt" r
      ${IfNot} ${Errors}
        FileRead $R1 $R2
        FileClose $R1
      ${EndIf}

      ${If} $R2 == "STOPPING_HOLDERS"
        StrCpy $R4 "正在优雅退出 $CmbStopHolderLabel 并释放旧版网关占用$R5"
      ${ElseIf} $R2 == "STOPPING_GATEWAY"
        StrCpy $R4 "正在停止后台网关服务并释放端口$R5"
      ${ElseIf} $R2 == "STOPPING_BRIDGE"
        StrCpy $R4 "正在关闭旧版 Codex Mobile Bridge 进程$R5"
      ${ElseIf} $R2 == "VERIFYING"
        StrCpy $R4 "正在确认安装目录文件锁已完全释放$R5"
      ${ElseIf} $CmbStopState == "inspecting"
        StrCpy $R4 "正在检测运行中的旧版实例$R5"
      ${Else}
        StrCpy $R4 "正在停止运行中的旧版实例$R5"
      ${EndIf}

      ${NSD_SetText} $CmbStopStatusLabel "$R4"

      Pop $R5
      Pop $R4
      Pop $R3
      Pop $R2
      Pop $R1
    FunctionEnd

    Function CmbStopPollTimer
      ${If} $CmbStopProcHandle == ""
      ${OrIf} $CmbStopProcHandle == "0"
        ${NSD_KillTimer} CmbStopPollTimer
        Return
      ${EndIf}

      System::Call 'kernel32::WaitForSingleObject(p $CmbStopProcHandle, i 0) i.r0'
      ${If} $0 == 258
        Call CmbUpdateRunningText
        Return
      ${EndIf}

      StrCpy $1 1
      System::Call 'kernel32::GetExitCodeProcess(p $CmbStopProcHandle, *i.r1)'
      Call CmbCloseAsyncProc
      ${NSD_KillTimer} CmbStopPollTimer

      ${If} $CmbStopState == "inspecting"
        ${If} $1 == 0
          StrCpy $CmbStopDoneFlag "1"
          SendMessage $CmbStopProgressBar ${PBM_SETMARQUEE} 0 0
          GetDlgItem $0 $HWNDPARENT 1
          EnableWindow $0 1
          SendMessage $HWNDPARENT ${WM_NOTIFY_OUTER_NEXT} 1 0
          Return
        ${ElseIf} $1 == 10
          StrCpy $CmbStopState "stopping"
          StrCpy $CmbStopTick 0
          Delete "$PLUGINSDIR\cmb-stop-phase.txt"
          ${NSD_SetText} $CmbStopTitleLabel "检测到旧版实例，正在自动停止..."
          ${NSD_SetText} $CmbStopStatusLabel "正在停止后台网关与 Codex Mobile Bridge..."
          StrCpy $R0 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\cmb-stop-instances.ps1" -Mode stop -DirsJoined "$CmbStopDirs" -CallerPid $CmbStopCallerPid -StatusFile "$PLUGINSDIR\cmb-stop-phase.txt"'
          Call CmbStartAsyncPs
          ${If} $CmbStopProcHandle == "0"
            StrCpy $CmbStopState "retry"
            SendMessage $CmbStopProgressBar ${PBM_SETMARQUEE} 0 0
            ShowWindow $CmbStopProgressBar ${SW_HIDE}
            ${NSD_SetText} $CmbStopTitleLabel "无法启动自动停止助手"
            ${NSD_SetText} $CmbStopStatusLabel "请手动关闭旧版 Codex Mobile Bridge 与网关进程，然后点击「重试」继续。"
            GetDlgItem $0 $HWNDPARENT 3
            EnableWindow $0 1
            GetDlgItem $0 $HWNDPARENT 1
            SendMessage $0 ${WM_SETTEXT} 0 "STR:重试(&R)"
            EnableWindow $0 1
            Return
          ${EndIf}
          ${NSD_CreateTimer} CmbStopPollTimer 120
          Return
        ${ElseIf} $1 == 20
        ${OrIf} $1 == 21
        ${OrIf} $1 == 22
          ${If} $1 == 22
            StrCpy $CmbStopHolderLabel "Codex Desktop 和 ZCode"
          ${ElseIf} $1 == 21
            StrCpy $CmbStopHolderLabel "ZCode"
          ${Else}
            StrCpy $CmbStopHolderLabel "Codex Desktop"
          ${EndIf}
          StrCpy $CmbStopState "confirm"
          SendMessage $CmbStopProgressBar ${PBM_SETMARQUEE} 0 0
          ShowWindow $CmbStopProgressBar ${SW_HIDE}
          ${NSD_SetText} $CmbStopTitleLabel "检测到 $CmbStopHolderLabel 正在占用旧版网关"
          ${NSD_SetText} $CmbStopStatusLabel "检测到 Codex Mobile Bridge 及关联的 $CmbStopHolderLabel 正在运行并占用旧版网关程序。$\r$\n$\r$\n点击下方「自动停止并继续」将按安全顺序自动停止上述实例并继续更新（请先确认其中没有正在执行的任务）。"
          ${NSD_SetText} $CmbStopHintLabel "若暂不更新，可点击「取消」退出安装程序。"
          GetDlgItem $0 $HWNDPARENT 3
          EnableWindow $0 1
          GetDlgItem $0 $HWNDPARENT 1
          SendMessage $0 ${WM_SETTEXT} 0 "STR:自动停止并继续(&N) >"
          EnableWindow $0 1
          Return
        ${Else}
          StrCpy $CmbStopState "retry"
          SendMessage $CmbStopProgressBar ${PBM_SETMARQUEE} 0 0
          ShowWindow $CmbStopProgressBar ${SW_HIDE}
          ${NSD_SetText} $CmbStopTitleLabel "检测运行中实例时发生异常"
          ${NSD_SetText} $CmbStopStatusLabel "未能确认旧版实例状态。请点击「重试」重新检测，或先手动关闭旧版程序后再继续。"
          ${NSD_SetText} $CmbStopHintLabel ""
          GetDlgItem $0 $HWNDPARENT 3
          EnableWindow $0 1
          GetDlgItem $0 $HWNDPARENT 1
          SendMessage $0 ${WM_SETTEXT} 0 "STR:重试(&R)"
          EnableWindow $0 1
          Return
        ${EndIf}
      ${EndIf}

      ${If} $1 == 0
        StrCpy $CmbStopDoneFlag "1"
        SendMessage $CmbStopProgressBar ${PBM_SETMARQUEE} 0 0
        ${NSD_SetText} $CmbStopTitleLabel "旧版实例已停止，正在进入安装..."
        ${NSD_SetText} $CmbStopStatusLabel "已完成清理，正在准备写入新版文件..."
        GetDlgItem $0 $HWNDPARENT 1
        EnableWindow $0 1
        SendMessage $HWNDPARENT ${WM_NOTIFY_OUTER_NEXT} 1 0
        Return
      ${EndIf}

      StrCpy $CmbStopState "retry"
      SendMessage $CmbStopProgressBar ${PBM_SETMARQUEE} 0 0
      ShowWindow $CmbStopProgressBar ${SW_HIDE}
      ${NSD_SetText} $CmbStopTitleLabel "部分运行中的实例未能自动停止"
      ${NSD_SetText} $CmbStopStatusLabel "请先手动关闭 Codex Mobile Bridge 及相关程序，然后点击下方「重试」继续更新。"
      ${NSD_SetText} $CmbStopHintLabel ""
      GetDlgItem $0 $HWNDPARENT 3
      EnableWindow $0 1
      GetDlgItem $0 $HWNDPARENT 1
      SendMessage $0 ${WM_SETTEXT} 0 "STR:重试(&R)"
      EnableWindow $0 1
    FunctionEnd

    Function CmbStopPageCreate
      ${If} ${Silent}
        Abort
      ${EndIf}

      InitPluginsDir
      File "/oname=$PLUGINSDIR\cmb-stop-instances.ps1" "${PROJECT_DIR}\desktop\nsis-stop-instances.ps1"
      Delete "$PLUGINSDIR\cmb-stop-phase.txt"

      StrCpy $CmbStopDirs "$INSTDIR"
      ReadRegStr $R1 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
      ${If} $R1 != ""
        StrCpy $CmbStopDirs "$CmbStopDirs;$R1"
      ${EndIf}
      ReadRegStr $R2 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
      ${If} $R2 != ""
        StrCpy $CmbStopDirs "$CmbStopDirs;$R2"
      ${EndIf}
      System::Call 'kernel32::GetCurrentProcessId() i.r0'
      StrCpy $CmbStopCallerPid "$0"
      StrCpy $CmbStopDoneFlag "0"
      StrCpy $CmbStopHolderLabel "关联程序"

      !insertmacro MUI_HEADER_TEXT "准备更新" "正在检查并停止运行中的旧版实例，请稍候..."
      nsDialogs::Create 1018
      Pop $CmbStopPage
      ${If} $CmbStopPage == error
        Call CmbCheckAndStopRunning
        StrCpy $CmbStopDoneFlag "1"
        Abort
      ${EndIf}

      ${NSD_CreateLabel} 0u 8u 100% 16u "正在检测运行中的旧版实例..."
      Pop $CmbStopTitleLabel

      nsDialogs::CreateControl "msctls_progress32" ${WS_CHILD}|${WS_VISIBLE}|${PBS_MARQUEE} 0 0u 30u 100% 14u ""
      Pop $CmbStopProgressBar
      SendMessage $CmbStopProgressBar ${PBM_SETMARQUEE} 1 30

      ${NSD_CreateLabel} 0u 54u 100% 52u "正在检查是否有旧版网关或关联程序正在运行，请稍候..."
      Pop $CmbStopStatusLabel

      ${NSD_CreateLabel} 0u 112u 100% 24u "停止完成后将自动继续安装，请勿强行关闭安装程序。"
      Pop $CmbStopHintLabel

      GetDlgItem $0 $HWNDPARENT 1
      SendMessage $0 ${BCM_SETSHIELD} 0 0
      EnableWindow $0 0
      GetDlgItem $0 $HWNDPARENT 3
      EnableWindow $0 0

      StrCpy $CmbStopState "inspecting"
      StrCpy $CmbStopTick 0
      StrCpy $R0 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\cmb-stop-instances.ps1" -Mode inspect -DirsJoined "$CmbStopDirs" -CallerPid $CmbStopCallerPid -StatusFile "$PLUGINSDIR\cmb-stop-phase.txt"'
      Call CmbStartAsyncPs
      ${If} $CmbStopProcHandle == "0"
        Call CmbCheckAndStopRunning
        StrCpy $CmbStopDoneFlag "1"
        GetDlgItem $0 $HWNDPARENT 1
        EnableWindow $0 1
        GetDlgItem $0 $HWNDPARENT 3
        EnableWindow $0 1
        Abort
      ${EndIf}

      ${NSD_CreateTimer} CmbStopPollTimer 120
      nsDialogs::Show
    FunctionEnd

    Function CmbStopPageLeave
      ${If} $CmbStopDoneFlag == "1"
        Return
      ${EndIf}

      ${If} $CmbStopState == "confirm"
        GetDlgItem $0 $HWNDPARENT 1
        EnableWindow $0 0
        GetDlgItem $0 $HWNDPARENT 3
        EnableWindow $0 0
        ShowWindow $CmbStopProgressBar ${SW_SHOW}
        SendMessage $CmbStopProgressBar ${PBM_SETMARQUEE} 1 30
        ${NSD_SetText} $CmbStopTitleLabel "正在自动停止 $CmbStopHolderLabel 与旧版网关..."
        ${NSD_SetText} $CmbStopStatusLabel "正在优雅退出 $CmbStopHolderLabel 并释放旧版网关占用..."
        ${NSD_SetText} $CmbStopHintLabel "停止完成后将自动继续安装，请稍候。"
        StrCpy $CmbStopState "stopping_holders"
        StrCpy $CmbStopTick 0
        Delete "$PLUGINSDIR\cmb-stop-phase.txt"
        StrCpy $R0 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\cmb-stop-instances.ps1" -Mode stop -IncludeHolders -DirsJoined "$CmbStopDirs" -CallerPid $CmbStopCallerPid -StatusFile "$PLUGINSDIR\cmb-stop-phase.txt"'
        Call CmbStartAsyncPs
        ${If} $CmbStopProcHandle != "0"
          ${NSD_CreateTimer} CmbStopPollTimer 120
          Abort
        ${EndIf}
        Call CmbCheckAndStopRunning
        StrCpy $CmbStopDoneFlag "1"
        Return
      ${EndIf}

      ${If} $CmbStopState == "retry"
        GetDlgItem $0 $HWNDPARENT 1
        EnableWindow $0 0
        GetDlgItem $0 $HWNDPARENT 3
        EnableWindow $0 0
        ShowWindow $CmbStopProgressBar ${SW_SHOW}
        SendMessage $CmbStopProgressBar ${PBM_SETMARQUEE} 1 30
        ${NSD_SetText} $CmbStopTitleLabel "正在重新检测运行中的旧版实例..."
        ${NSD_SetText} $CmbStopStatusLabel "正在检查是否还有残留进程占用安装目录..."
        ${NSD_SetText} $CmbStopHintLabel "停止完成后将自动继续安装，请稍候。"
        StrCpy $CmbStopState "inspecting"
        StrCpy $CmbStopTick 0
        Delete "$PLUGINSDIR\cmb-stop-phase.txt"
        StrCpy $R0 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\cmb-stop-instances.ps1" -Mode inspect -DirsJoined "$CmbStopDirs" -CallerPid $CmbStopCallerPid -StatusFile "$PLUGINSDIR\cmb-stop-phase.txt"'
        Call CmbStartAsyncPs
        ${If} $CmbStopProcHandle != "0"
          ${NSD_CreateTimer} CmbStopPollTimer 120
          Abort
        ${EndIf}
        Call CmbCheckAndStopRunning
        StrCpy $CmbStopDoneFlag "1"
        Return
      ${EndIf}

      Abort
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
        Abort
      ${EndIf}
      ${If} ${UAC_IsAdmin}
        GetDlgItem $0 $HWNDPARENT 1
        SendMessage $0 ${BCM_SETSHIELD} 0 0
        Abort
      ${EndIf}
      Call CmbIsInstDirWritable
      ${If} $CmbDirWritable == "1"
        GetDlgItem $0 $HWNDPARENT 1
        SendMessage $0 ${BCM_SETSHIELD} 0 0
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
    Page custom CmbStopPageCreate CmbStopPageLeave
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
