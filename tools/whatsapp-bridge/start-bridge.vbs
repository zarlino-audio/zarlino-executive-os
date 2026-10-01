' Zarlino WhatsApp Bridge launcher — runs in a hidden window and survives
' terminal closes and reboots (paired with a Startup-folder shortcut).
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = base
cmd = "cmd /c node """ & base & "\index.mjs"" >> """ & base & "\bridge.log"" 2>&1"
sh.Run cmd, 0, False
