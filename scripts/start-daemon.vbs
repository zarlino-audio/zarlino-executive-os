' Zarlino Executive OS — Local Agent daemon auto-start launcher.
'
' Launches the daemon HIDDEN at login (window style 0) and writes its output
' to executive-os\local-daemon.log (overwritten each launch, so it stays
' bounded). Safe to double-click or to run via a Startup-folder shortcut:
'   wscript.exe "executive-os\scripts\start-daemon.vbs"
'
' Registered automatically by:  npm run agent:daemon:install
Option Explicit

Dim fso, execOs, logPath, cmd, sh

Set fso = CreateObject("Scripting.FileSystemObject")
' This script lives at <executive-os>\scripts\start-daemon.vbs
execOs = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
logPath = execOs & "\local-daemon.log"

cmd = "cmd /c cd /d """ & execOs & """ && npm run agent:daemon:loop > """ & logPath & """ 2>&1"

Set sh = CreateObject("WScript.Shell")
sh.Run cmd, 0, False
