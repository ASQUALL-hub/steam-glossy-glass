// Steam Glass installer and updater, per user (no admin rights).
//
// Downloads the latest release from GitHub, installs the helper to
// %LOCALAPPDATA%\Programs\SteamGlass, copies the Glossy Glass theme into Steam's
// Millennium skins folder (steamui\skins\GlossyGlass), starts the helper at sign-in,
// adds a Start Menu shortcut and an entry under Settings > Apps, then starts the helper.
//
//     SteamGlassUpdater.exe               install, or update to the newest release
//     SteamGlassUpdater.exe --from-app    the same, started from the helper's tray menu
//     SteamGlassUpdater.exe --uninstall   remove Steam Glass for this user
//
// A small native .NET Framework program (built by build.py with the csc.exe that ships with
// Windows), so there's no bundled runtime unpacking itself into %TEMP% for antivirus to trip on.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.IO.Pipes;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

static class Setup
{
    public const string Repo = "ASQUALL-hub/steam-glossy-glass";
    public const string App = "SteamGlass";
    public const string Name = "Steam Glass";
    public const string AssetSuffix = "-win64.zip";
    public const string MillenniumUrl = "https://steambrew.app";
    public const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + App;
    public const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";

    public static readonly bool TestMode;   // tests: files only, no Steam/shortcut/registry
    public static readonly string InstallDir, Exe, UpdaterExe, VersionFile, Shortcut, OldStartupLink, SettingsDir, Pipe, Self;

    static Setup()
    {
        string over = Environment.GetEnvironmentVariable("STEAMGLASS_INSTALL_DIR");
        TestMode = !string.IsNullOrEmpty(over);
        InstallDir = Path.GetFullPath(TestMode ? over : Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", App)).TrimEnd('\\');
        Exe = Path.Combine(InstallDir, "SteamGlass.exe");
        UpdaterExe = Path.Combine(InstallDir, "SteamGlassUpdater.exe");
        VersionFile = Path.Combine(InstallDir, "version.txt");
        Shortcut = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), Name + ".lnk");
        // the source checkout's install.ps1 -Startup made this; the installed helper replaces it
        OldStartupLink = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), "Steam Glass helper.lnk");
        SettingsDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), App);
        Pipe = App + "-" + (Environment.GetEnvironmentVariable("USERNAME") ?? "user");   // the helper's quit channel
        Self = Path.GetFullPath(Assembly.GetExecutingAssembly().Location);
    }

    public static bool SamePath(string a, string b)
    {
        return string.Equals(Path.GetFullPath(a).TrimEnd('\\'), Path.GetFullPath(b).TrimEnd('\\'),
                             StringComparison.OrdinalIgnoreCase);
    }

    public static bool RunningFromInstall()
    {
        return Self.StartsWith(InstallDir + "\\", StringComparison.OrdinalIgnoreCase);
    }

    // ----------------------------------------------------------------------- Steam

    /// <summary>Steam's folder from the registry, or null if Steam isn't installed for this user.</summary>
    public static string SteamDir()
    {
        using (RegistryKey k = Registry.CurrentUser.OpenSubKey(@"Software\Valve\Steam"))
        {
            string path = k != null ? k.GetValue("SteamPath") as string : null;
            if (string.IsNullOrEmpty(path)) return null;
            path = Path.GetFullPath(path.Replace('/', '\\'));
            return Directory.Exists(path) ? path : null;
        }
    }

    public static string SkinDir()
    {
        string steam = TestMode ? Path.Combine(InstallDir, "steam-test") : SteamDir();
        return steam == null ? null : Path.Combine(steam, "steamui", "skins", "GlossyGlass");
    }

    /// <summary>Millennium is the Steam mod loader that loads themes from steamui\skins.</summary>
    public static bool HasMillennium()
    {
        string steam = SteamDir();
        return steam != null && File.Exists(Path.Combine(steam, "millennium.dll"));
    }

    /// <summary>Copy the theme (the zip's skin folder) into Steam. Returns where, or null without Steam.</summary>
    public static string InstallTheme()
    {
        string src = Path.Combine(InstallDir, "skin"), dest = SkinDir();
        if (dest == null || !Directory.Exists(src)) return null;
        Directory.CreateDirectory(dest);
        foreach (string old in Directory.GetFiles(dest)) File.Delete(old);   // drop files an older version had
        foreach (string f in Directory.GetFiles(src))
            File.Copy(f, Path.Combine(dest, Path.GetFileName(f)), true);
        return dest;
    }

    // ----------------------------------------------------------------------- GitHub

    public static int Compare(string a, string b)
    {
        string[] pa = a.Trim().TrimStart('v', 'V').Split('.'), pb = b.Trim().TrimStart('v', 'V').Split('.');
        for (int i = 0; i < Math.Max(pa.Length, pb.Length); i++)
        {
            int x = i < pa.Length ? Digits(pa[i]) : 0, y = i < pb.Length ? Digits(pb[i]) : 0;
            if (x != y) return x.CompareTo(y);
        }
        return 0;
    }

    static int Digits(string piece)
    {
        var sb = new StringBuilder();
        foreach (char ch in piece) if (char.IsDigit(ch)) sb.Append(ch);
        int n;
        return int.TryParse(sb.ToString(), out n) ? n : 0;
    }

    /// <summary>Version, download url and size in bytes of the newest release's zip.</summary>
    public static void LatestRelease(out string version, out string url, out long size)
    {
        var req = (HttpWebRequest)WebRequest.Create("https://api.github.com/repos/" + Repo + "/releases/latest");
        req.Accept = "application/vnd.github+json";
        req.UserAgent = App + "-updater";
        req.Timeout = 20000;
        string body;
        using (var r = req.GetResponse())
        using (var s = new StreamReader(r.GetResponseStream(), Encoding.UTF8))
            body = s.ReadToEnd();
        var json = new JavaScriptSerializer();
        json.MaxJsonLength = int.MaxValue;
        var data = (Dictionary<string, object>)json.DeserializeObject(body);
        object assets;
        if (data.TryGetValue("assets", out assets) && assets is object[])
        {
            foreach (object o in (object[])assets)
            {
                var a = (Dictionary<string, object>)o;
                if (((string)a["name"]).EndsWith(AssetSuffix, StringComparison.OrdinalIgnoreCase))
                {
                    version = ((string)data["tag_name"]).TrimStart('v', 'V');
                    url = (string)a["browser_download_url"];
                    size = a.ContainsKey("size") && a["size"] != null ? Convert.ToInt64(a["size"]) : 0;
                    return;
                }
            }
        }
        throw new Exception("The latest release has no Windows build attached.");
    }

    public static string InstalledVersion()
    {
        try { return File.Exists(Exe) ? File.ReadAllText(VersionFile, Encoding.UTF8).Trim() : null; }
        catch (IOException) { return null; }
        catch (UnauthorizedAccessException) { return null; }
    }

    public static void Download(string url, string dest, Action<long, long> progress)
    {
        var req = (HttpWebRequest)WebRequest.Create(url);
        req.UserAgent = App + "-updater";
        req.Timeout = 30000;
        req.ReadWriteTimeout = 30000;
        using (var r = req.GetResponse())
        using (var s = r.GetResponseStream())
        using (var f = File.Create(dest))
        {
            long total = r.ContentLength > 0 ? r.ContentLength : 0, done = 0;
            var buf = new byte[256 * 1024];
            int n;
            while ((n = s.Read(buf, 0, buf.Length)) > 0)
            {
                f.Write(buf, 0, n);
                done += n;
                progress(done, total);
            }
        }
    }

    // ----------------------------------------------------------------------- running copies

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "QueryFullProcessImageNameW", SetLastError = true)]
    static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder name, ref uint size);
    [DllImport("kernel32.dll")]
    static extern bool TerminateProcess(IntPtr h, uint code);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr h);
    const uint PROCESS_TERMINATE = 0x0001, PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

    /// <summary>Handles of processes whose exe lives in the install folder, except us.</summary>
    static List<IntPtr> InstalledProcesses()
    {
        var found = new List<IntPtr>();
        int me = Process.GetCurrentProcess().Id;
        string root = InstallDir + "\\";
        foreach (Process p in Process.GetProcesses())
        {
            int pid = p.Id;
            p.Dispose();
            if (pid == 0 || pid == me) continue;
            IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE, false, pid);
            if (h == IntPtr.Zero) continue;
            var buf = new StringBuilder(1024);
            uint size = 1024;
            if (QueryFullProcessImageName(h, 0, buf, ref size) &&
                buf.ToString().StartsWith(root, StringComparison.OrdinalIgnoreCase))
                found.Add(h);
            else
                CloseHandle(h);
        }
        return found;
    }

    /// <summary>
    /// Ask the helper to quit (it puts Steam's windows back to normal, and a source copy run with
    /// pythonw listens too), and only force an installed one if it won't.
    /// </summary>
    public static void CloseRunning()
    {
        try
        {
            using (var pipe = new NamedPipeClientStream(".", Pipe, PipeDirection.Out))
            {
                pipe.Connect(1000);
                byte[] msg = Encoding.ASCII.GetBytes("quit");
                pipe.Write(msg, 0, msg.Length);
            }
        }
        catch (Exception) { }   // not running
        var end = DateTime.UtcNow.AddSeconds(6);
        while (DateTime.UtcNow < end)
        {
            var procs = InstalledProcesses();
            foreach (IntPtr h in procs) CloseHandle(h);
            if (procs.Count == 0) break;
            Thread.Sleep(200);
        }
        foreach (IntPtr h in InstalledProcesses())
        {
            TerminateProcess(h, 0);
            CloseHandle(h);
        }
        Thread.Sleep(500);   // the helper's single-instance mutex goes with its process
    }

    // ----------------------------------------------------------------------- install / uninstall

    static void Remove(string path)
    {
        for (int attempt = 0; attempt < 25; attempt++)   // files can stay locked for a moment after a process exits
        {
            try
            {
                if (Directory.Exists(path)) Directory.Delete(path, true);
                else if (File.Exists(path)) File.Delete(path);
                return;
            }
            catch (IOException) { Thread.Sleep(200); }
            catch (UnauthorizedAccessException) { Thread.Sleep(200); }
        }
        throw new Exception("Couldn't replace " + Path.GetFileName(path) + " (is it open somewhere?)");
    }

    public static void InstallZip(string zip, string version)
    {
        Directory.CreateDirectory(InstallDir);
        string staging = Path.Combine(Path.GetDirectoryName(InstallDir), "steamglass-" + Path.GetRandomFileName());
        try
        {
            ZipFile.ExtractToDirectory(zip, staging);
            foreach (string child in Directory.GetFileSystemEntries(InstallDir))
            {
                if (SamePath(child, Self)) continue;   // can't delete the updater that is running; it's replaced below if needed
                Remove(child);
            }
            foreach (string child in Directory.GetFileSystemEntries(staging))
            {
                string dest = Path.Combine(InstallDir, Path.GetFileName(child));
                if (Directory.Exists(child)) Directory.Move(child, dest);
                else File.Move(child, dest);
            }
        }
        finally
        {
            try { Directory.Delete(staging, true); } catch (Exception) { }
        }
        if (!SamePath(Self, UpdaterExe))
            File.Copy(Self, UpdaterExe, true);   // keep a copy for "Check for updates…" and uninstall
        File.WriteAllText(VersionFile, version);
    }

    /// <summary>Start Menu shortcut, Settings > Apps entry, and the helper starting at sign-in.</summary>
    public static void Register(string version)
    {
        if (TestMode) return;
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(Shortcut));
            object shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
            dynamic lnk = ((dynamic)shell).CreateShortcut(Shortcut);
            lnk.TargetPath = Exe;
            lnk.WorkingDirectory = InstallDir;
            lnk.IconLocation = Exe + ",0";
            lnk.Description = Name + " (see-through glass for Steam)";
            lnk.Save();
            Marshal.FinalReleaseComObject(lnk);
            Marshal.FinalReleaseComObject(shell);
        }
        catch (Exception) { }   // no shortcut is no reason to fail the install
        long bytes = 0;
        foreach (string f in Directory.GetFiles(InstallDir, "*", SearchOption.AllDirectories))
            bytes += new FileInfo(f).Length;
        using (RegistryKey k = Registry.CurrentUser.CreateSubKey(UninstallKey))
        {
            k.SetValue("DisplayName", Name);
            k.SetValue("DisplayVersion", version);
            k.SetValue("Publisher", Repo.Split('/')[0]);
            k.SetValue("DisplayIcon", Exe);
            k.SetValue("InstallLocation", InstallDir);
            k.SetValue("UninstallString", "\"" + UpdaterExe + "\" --uninstall");
            k.SetValue("URLInfoAbout", "https://github.com/" + Repo);
            k.SetValue("EstimatedSize", (int)(bytes / 1024), RegistryValueKind.DWord);
            k.SetValue("NoModify", 1, RegistryValueKind.DWord);
            k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        }
        using (RegistryKey k = Registry.CurrentUser.CreateSubKey(RunKey))
            k.SetValue(App, "\"" + Exe + "\"");   // the glass needs the helper whenever Steam runs
        try { File.Delete(OldStartupLink); } catch (Exception) { }
    }

    public static void Launch()
    {
        Process.Start(new ProcessStartInfo(Exe) { WorkingDirectory = InstallDir, UseShellExecute = false }).Dispose();
    }

    public static void Uninstall(bool removeSettings)
    {
        CloseRunning();   // the helper puts Steam's windows back to normal as it quits
        if (!TestMode)
        {
            using (RegistryKey k = Registry.CurrentUser.OpenSubKey(RunKey, true))
                if (k != null) k.DeleteValue(App, false);
            Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false);
            try { File.Delete(Shortcut); } catch (Exception) { }
            if (removeSettings)
                try { Directory.Delete(SettingsDir, true); } catch (Exception) { }
        }
        string skin = SkinDir();
        if (skin != null && Directory.Exists(skin))
            Remove(skin);
        if (Directory.Exists(InstallDir))
            Remove(InstallDir);   // Main moved us out of this folder first, so nothing in it is running
    }

    /// <summary>
    /// Uninstalling from the installed copy: run a temporary copy instead, so the whole folder
    /// can be deleted once this process has exited.
    /// </summary>
    public static void RelaunchFromTemp(string[] args)
    {
        string copy = Path.Combine(Path.GetTempPath(), "SteamGlassUninstall-" + Path.GetRandomFileName() + ".exe");
        File.Copy(Self, copy);
        var cmd = new StringBuilder("--relaunched");
        foreach (string a in args) cmd.Append(" \"").Append(a).Append('"');
        Process.Start(new ProcessStartInfo(copy, cmd.ToString()) { UseShellExecute = false }).Dispose();
    }

    /// <summary>Leftover temporary uninstall copies from earlier runs.</summary>
    public static void CleanTemp()
    {
        try
        {
            foreach (string f in Directory.GetFiles(Path.GetTempPath(), "SteamGlassUninstall-*.exe"))
                if (!SamePath(f, Self))
                    try { File.Delete(f); } catch (Exception) { }
        }
        catch (Exception) { }
    }

    public static void OpenUrl(string url)
    {
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }).Dispose(); }
        catch (Exception) { }
    }
}

// --------------------------------------------------------------------------- window

class Window : Form
{
    readonly Label title, detail;
    readonly ProgressBar bar;
    readonly FlowLayoutPanel buttons;
    readonly List<string> argv;

    public Window(List<string> argv)
    {
        this.argv = argv;
        SuspendLayout();
        AutoScaleDimensions = new SizeF(96F, 96F);
        AutoScaleMode = AutoScaleMode.Dpi;
        Font = new Font("Segoe UI", 9F);
        Text = Setup.Name + " Updater";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(420, 170);
        try { Icon = Icon.ExtractAssociatedIcon(Setup.Self); } catch (Exception) { }
        title = new Label { Text = "Checking for updates…", Font = new Font("Segoe UI Semibold", 11F),
                            Location = new Point(16, 14), Size = new Size(388, 24), AutoEllipsis = true };
        detail = new Label { Text = "", ForeColor = Color.FromArgb(0x55, 0x55, 0x55),
                             Location = new Point(16, 40), Size = new Size(388, 40), AutoEllipsis = true };
        bar = new ProgressBar { Location = new Point(16, 86), Size = new Size(388, 18),
                                Style = ProgressBarStyle.Marquee, MarqueeAnimationSpeed = 30 };
        buttons = new FlowLayoutPanel { Location = new Point(16, 122), Size = new Size(388, 34),
                                        FlowDirection = FlowDirection.RightToLeft, WrapContents = false };
        Controls.AddRange(new Control[] { title, detail, bar, buttons });
        ResumeLayout(false);
        PerformLayout();
    }

    void Post(Action a)
    {
        if (IsDisposed) return;
        try { BeginInvoke(a); } catch (InvalidOperationException) { }   // window already closed
    }

    void SetButtons(params KeyValuePair<string, Action>[] specs)
    {
        buttons.Controls.Clear();
        for (int i = specs.Length - 1; i >= 0; i--)   // right to left, so the last one sits at the edge
        {
            Action cmd = specs[i].Value;
            var b = new Button { Text = specs[i].Key, AutoSize = true, MinimumSize = new Size(88, 28) };
            b.Click += delegate { cmd(); };
            buttons.Controls.Add(b);
        }
        if (specs.Length > 0) AcceptButton = (Button)buttons.Controls[buttons.Controls.Count - 1];
    }

    static KeyValuePair<string, Action> Btn(string text, Action cmd)
    {
        return new KeyValuePair<string, Action>(text, cmd);
    }

    void Progress(double percent)
    {
        bar.Style = ProgressBarStyle.Continuous;
        bar.Value = Math.Max(0, Math.Min(100, (int)percent));
    }

    void Busy()
    {
        bar.Style = ProgressBarStyle.Marquee;
    }

    void Done(bool ok)
    {
        bar.Style = ProgressBarStyle.Continuous;
        bar.Value = ok ? 100 : 0;
    }

    void CloseAfter(int ms)
    {
        var t = new System.Windows.Forms.Timer { Interval = ms };
        t.Tick += delegate { t.Stop(); Close(); };
        t.Start();
    }

    void Fail(string what, Exception exc)
    {
        string reason = exc.Message;
        if (exc is WebException) reason = "Couldn't reach GitHub. Check your internet connection.";
        if (reason.Length > 180) reason = reason.Substring(0, 180);
        Post(delegate
        {
            title.Text = what;
            detail.Text = reason;
            Done(false);
            SetButtons(Btn("Close", Close));
        });
    }

    public void RunUpdate()
    {
        Shown += delegate { new Thread(WorkUpdate) { IsBackground = true }.Start(); };
    }

    public void RunUninstall(bool removeSettings)
    {
        title.Text = "Removing " + Setup.Name + "…";
        Shown += delegate { new Thread(() => WorkUninstall(removeSettings)) { IsBackground = true }.Start(); };
    }

    void WorkUpdate()
    {
        try
        {
            string latest, url;
            long size;
            Setup.LatestRelease(out latest, out url, out size);
            string current = Setup.InstalledVersion();
            if (current != null && Setup.Compare(current, latest) >= 0)
            {
                Post(delegate
                {
                    title.Text = Setup.Name + " " + current + " is up to date.";
                    detail.Text = "You already have the newest version.";
                    Done(true);
                    SetButtons(Btn("Close", Close));
                });
                return;
            }
            string verb = current != null ? "Updating" : "Installing";
            Post(delegate { title.Text = verb + " " + Setup.Name + " " + latest + "…"; detail.Text = "Downloading…"; Progress(0); });
            string tmp = Path.Combine(Path.GetTempPath(), "SteamGlass-" + latest + Setup.AssetSuffix);
            long lastShown = -1;
            Setup.Download(url, tmp, (done, total) =>
            {
                total = total > 0 ? total : (size > 0 ? size : 1);
                long pct = done * 100 / total;
                if (pct == lastShown && done != total) return;   // don't flood the window
                lastShown = pct;
                Post(delegate
                {
                    Progress(pct);
                    detail.Text = string.Format("Downloading… {0:0.0} of {1:0.0} MB", done / 1e6, total / 1e6);
                });
            });
            Post(delegate { detail.Text = "Closing the Steam Glass helper…"; Busy(); });
            Setup.CloseRunning();
            Post(delegate { detail.Text = "Installing…"; });
            Setup.InstallZip(tmp, latest);
            string skin = Setup.InstallTheme();
            Setup.Register(latest);
            try { File.Delete(tmp); } catch (Exception) { }
            Post(delegate { detail.Text = "Starting the helper…"; });
            Setup.Launch();
            bool millennium = Setup.HasMillennium();
            Post(delegate
            {
                title.Text = Setup.Name + " " + latest + " is installed.";
                Done(true);
                if (skin == null)
                {
                    detail.Text = "Steam wasn't found, so the theme wasn't copied. Install Steam, then run this again.";
                    SetButtons(Btn("Close", Close));
                }
                else if (!millennium)
                {
                    detail.Text = "Steam needs Millennium to load the theme. Install it, then pick Glossy Glass "
                                  + "in Steam > Millennium > Themes.";
                    SetButtons(Btn("Get Millennium", delegate { Setup.OpenUrl(Setup.MillenniumUrl); Close(); }),
                               Btn("Close", Close));
                }
                else
                {
                    detail.Text = "Restart Steam to load the new theme. Pick the glass in the tray icon.";
                    SetButtons(Btn("Close", Close));
                    CloseAfter(6000);
                }
            });
        }
        catch (Exception exc)   // show any failure instead of vanishing
        {
            Fail("Update failed", exc);
        }
    }

    void WorkUninstall(bool removeSettings)
    {
        try
        {
            Setup.Uninstall(removeSettings);
            Post(delegate
            {
                title.Text = Setup.Name + " was removed.";
                detail.Text = "Restart Steam to drop the theme.";
                Done(true);
                SetButtons(Btn("Close", Close));
                CloseAfter(4000);
            });
        }
        catch (Exception exc)
        {
            Fail("Uninstall failed", exc);
        }
    }
}

static class Program
{
    [STAThread]
    static int Main(string[] args)
    {
        ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072;   // TLS 1.2, which GitHub requires
        var argv = new List<string>(args);
        bool relaunched = argv.Remove("--relaunched");
        if (!relaunched) Setup.CleanTemp();
        bool uninstalling = argv.Contains("--uninstall") || argv.Contains("--uninstall-silent");
        try
        {
            if (uninstalling && Setup.RunningFromInstall())
            {
                Setup.RelaunchFromTemp(argv.ToArray());
                return 0;
            }
            int i = argv.IndexOf("--zip");
            if (i >= 0)   // developer/test path: install a local build instead of downloading
            {
                Setup.CloseRunning();
                Setup.InstallZip(argv[i + 1], argv[i + 2]);
                Setup.InstallTheme();
                Setup.Register(argv[i + 2]);
                if (!argv.Contains("--no-launch")) Setup.Launch();
                return 0;
            }
            if (argv.Contains("--uninstall-silent"))
            {
                Setup.Uninstall(false);
                return 0;
            }
        }
        catch (Exception exc)
        {
            Console.Error.WriteLine(exc);
            return 1;
        }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        var window = new Window(argv);
        if (argv.Contains("--uninstall"))
        {
            string caption = "Uninstall " + Setup.Name;
            if (MessageBox.Show("Remove " + Setup.Name + " and the Glossy Glass theme from this PC (for your user)?",
                                caption, MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes)
                return 0;
            bool keep = MessageBox.Show("Keep your glass setting in case you install it again?",
                                        caption, MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes;
            window.RunUninstall(!keep);
        }
        else
        {
            window.RunUpdate();
        }
        Application.Run(window);
        return 0;
    }
}
