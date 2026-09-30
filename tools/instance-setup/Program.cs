// Zarlino Instance Setup — the downloadable one-click EXE.
//
// Small, dependency-free bootstrapper: it fetches the CURRENT provisioner
// script from the public site (so the EXE never goes stale) and runs it in
// this console window. All interactive prompts (secrets, clone choice) stay
// with the script; nothing is embedded here and nothing is printed back.
//
// Build (on any Windows with .NET Framework):
//   csc /nologo /target:exe /out:ZarlinoInstanceSetup.exe Program.cs
//
// Publish: copy the EXE + scripts/remote-provision.ps1 (renamed
// zarlino-instance-setup.ps1) into zarlino-website/public/instance/ so both
// are downloadable from https://zarlinoaudio.com/instance/.
using System;
using System.Diagnostics;
using System.IO;
using System.Net;

class Program
{
    const string ScriptUrl = "https://zarlinoaudio.com/instance/zarlino-instance-setup.ps1";

    static int Main(string[] args)
    {
        ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; // TLS 1.2 for older frameworks
        Console.Title = "Zarlino Instance Setup";
        Console.WriteLine("Zarlino Instance Setup");
        Console.WriteLine("Turns this Windows machine into a Zarlino runtime instance.");
        Console.WriteLine("(Fetches the current provisioner from " + ScriptUrl + ")");
        Console.WriteLine();

        string tmp = Path.Combine(Path.GetTempPath(), "zarlino-instance-setup.ps1");
        try
        {
            using (var wc = new WebClient())
            {
                wc.Headers.Add("User-Agent", "ZarlinoInstanceSetup/1.0");
                wc.DownloadFile(ScriptUrl, tmp);
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine("Could not download the provisioner: " + ex.Message);
            Console.WriteLine("Fetch it manually: " + ScriptUrl);
            Console.WriteLine("Then run:  powershell -ExecutionPolicy Bypass -File zarlino-instance-setup.ps1");
            Pause();
            return 2;
        }

        string scriptArgs = "";
        foreach (var a in args) scriptArgs += " " + a; // e.g. -CheckOnly, -AgentId remote_daemon_01
        var psi = new ProcessStartInfo(
            "powershell.exe",
            "-NoProfile -ExecutionPolicy Bypass -File \"" + tmp + "\"" + scriptArgs)
        {
            UseShellExecute = false,
        };

        int code;
        try
        {
            var p = Process.Start(psi);
            p.WaitForExit();
            code = p.ExitCode;
        }
        catch (Exception ex)
        {
            Console.WriteLine("Failed to run the provisioner: " + ex.Message);
            Pause();
            return 3;
        }

        Console.WriteLine();
        Console.WriteLine(code == 0 ? "Setup completed." : "Setup exited with code " + code + ".");
        Console.WriteLine("Executive console: https://os.zarlinoaudio.com");
        Pause();
        return code;
    }

    static void Pause()
    {
        Console.Write("Press Enter to close...");
        Console.ReadLine();
    }
}
