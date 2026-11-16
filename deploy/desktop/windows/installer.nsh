; 升级与卸载不能让安装框架默认强制关闭活动产品进程，当前账户或其它会话中仍有任何角色时明确中止；数据目录在程序外并默认保留，用户需要回到界面完成真实停止及未知隔离恢复再重试。
!macro veriqRequireStopped
    nsProcess::_FindProcess "veriq.exe"
    Pop $R0
    ${If} $R0 != 603
        MessageBox MB_OK|MB_ICONSTOP "Stop VeriQ UI and Agent before installation or removal; process status must be confirmed."
        Abort
    ${EndIf}
    nsProcess::_FindProcess "veriq_agent.exe"
    Pop $R0
    ${If} $R0 != 603
        MessageBox MB_OK|MB_ICONSTOP "Stop VeriQ Agent before installation or removal."
        Abort
    ${EndIf}
    nsProcess::_FindProcess "veriq_runner.exe"
    Pop $R0
    ${If} $R0 != 603
        MessageBox MB_OK|MB_ICONSTOP "VeriQ execution is active or unconfirmed. Recover and stop it first."
        Abort
    ${EndIf}
    nsProcess::_FindProcess "veriq_cli.exe"
    Pop $R0
    ${If} $R0 != 603
        MessageBox MB_OK|MB_ICONSTOP "Stop VeriQ CLI before installation or removal."
        Abort
    ${EndIf}
    nsProcess::_Unload
!macroend

!macro customInit
    !insertmacro veriqRequireStopped
!macroend
!macro customUnInit
    !insertmacro veriqRequireStopped
!macroend
!macro customCheckAppRunning
    !insertmacro veriqRequireStopped
!macroend
