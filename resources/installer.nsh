; electron-builder 的 NSIS 钩子（electron-builder.yml 里 nsis.include 引入）。
;
; 自动更新拉起安装器时（带 --updated），assisted 安装器仍会停在「为谁安装」那一页等人点 ——
; 这一页只认命令行的 /allusers、/currentuser 才跳过，electron-updater 不传。
; 更新时沿用 initMultiUser 已经按注册表定好的安装方式（$installMode），这页就不出现；
; 装给所有用户的那份照常会弹 UAC。全新安装不受影响，仍然可以选。
!macro customInstallMode
  ${if} ${isUpdated}
    ${if} $installMode == "all"
      StrCpy $isForceMachineInstall "1"
    ${else}
      StrCpy $isForceCurrentInstall "1"
    ${endif}
  ${endif}
!macroend
