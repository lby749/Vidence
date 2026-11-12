using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

// Native Windows installer. No browser policy/profile changes or bundled runtime.
internal static class ExtensionFiles
{
    internal static string Destination(string appData)
    {
        return Path.GetFullPath(Path.Combine(appData, "VideoMemoryAssistant", "browser-extension"));
    }

    internal static string Install(string appData)
    {
        string destination = Destination(appData), owner = Path.GetDirectoryName(destination);
        Directory.CreateDirectory(owner);
        string stage = Path.Combine(owner, ".extension-stage-" + Guid.NewGuid().ToString("N"));
        string backup = Path.Combine(owner, ".extension-backup-" + Guid.NewGuid().ToString("N"));
        try
        {
            using (Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("Vidence.Extension.zip"))
            {
                if (payload == null) throw new InvalidDataException("Missing extension package.");
                using (SHA256 sha = SHA256.Create())
                {
                    string digest = BitConverter.ToString(sha.ComputeHash(payload)).Replace("-", "").ToLowerInvariant();
                    if (digest != BuildInfo.PayloadSha256) throw new InvalidDataException("Extension package checksum mismatch.");
                }
                payload.Position = 0;
                using (ZipArchive archive = new ZipArchive(payload, ZipArchiveMode.Read)) Extract(archive, stage);
            }
            var manifest = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(stage, "manifest.json")));
            if (Convert.ToInt32(manifest["manifest_version"]) != 3 || (string)manifest["name"] != "Vidence" || (string)manifest["version"] != BuildInfo.Version)
                throw new InvalidDataException("Unexpected extension manifest.");
            bool previous = Directory.Exists(destination);
            if (previous) Directory.Move(destination, backup);
            try { Directory.Move(stage, destination); }
            catch
            {
                if (previous && !Directory.Exists(destination)) Directory.Move(backup, destination);
                throw;
            }
            // Only our code directory is replaced. Browser learning storage stays untouched.
            if (Directory.Exists(backup)) DeleteOwned(backup, owner);
            return destination;
        }
        finally { if (Directory.Exists(stage)) DeleteOwned(stage, owner); }
    }

    internal static void Extract(ZipArchive archive, string stage)
    {
        string prefix = Path.GetFullPath(stage).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        Directory.CreateDirectory(stage);
        foreach (ZipArchiveEntry entry in archive.Entries)
        {
            string target = Path.GetFullPath(Path.Combine(stage, entry.FullName));
            if (!target.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) || ((entry.ExternalAttributes >> 16) & 0xf000) == 0xa000)
                throw new InvalidDataException("Invalid package path.");
            if (entry.Name.Length == 0) Directory.CreateDirectory(target);
            else
            {
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                using (Stream input = entry.Open())
                using (Stream output = File.Create(target)) input.CopyTo(output);
            }
        }
    }

    internal static void DeleteOwned(string directory, string owner)
    {
        string full = Path.GetFullPath(directory), prefix = Path.GetFullPath(owner).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) throw new IOException("Cleanup path outside installer directory.");
        Directory.Delete(full, true);
    }

    internal static string BrowserPath(bool chrome)
    {
        string executable = chrome ? "chrome.exe" : "msedge.exe";
        foreach (RegistryHive hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
        foreach (RegistryView view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
        {
            using (RegistryKey root = RegistryKey.OpenBaseKey(hive, view))
            using (RegistryKey key = root.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\App Paths\" + executable))
            {
                string value = key == null ? null : key.GetValue(null) as string;
                if (!String.IsNullOrEmpty(value) && File.Exists(value.Trim('"'))) return value.Trim('"');
            }
        }
        foreach (string folder in new[] { Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) })
        {
            string value = Path.Combine(folder, chrome ? @"Google\Chrome\Application\chrome.exe" : @"Microsoft\Edge\Application\msedge.exe");
            if (File.Exists(value)) return value;
        }
        return null;
    }
}

internal sealed class SetupWindow : Form
{
    readonly bool zh = System.Globalization.CultureInfo.CurrentUICulture.Name.StartsWith("zh", StringComparison.OrdinalIgnoreCase);
    readonly ComboBox browser = new ComboBox();
    readonly Button install = new Button();
    readonly TextBox folder = new TextBox();
    readonly Label status = new Label();
    string installed;
    string T(string chinese, string english) { return zh ? chinese : english; }

    internal SetupWindow()
    {
        Text = "Vidence " + BuildInfo.Version;
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        Font = new Font(zh ? "Microsoft YaHei UI" : "Segoe UI", 10);
        AutoScaleMode = AutoScaleMode.Dpi;
        ClientSize = new Size(600, 450);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(248, 249, 252);
        Controls.Add(new PictureBox { Image = Icon.ToBitmap(), Bounds = new Rectangle(28, 28, 48, 48), SizeMode = PictureBoxSizeMode.Zoom });
        Controls.Add(new Label { Text = T("把 Vidence 放到视频旁边。", "Learn with Vidence beside your video."), Font = new Font(Font.FontFamily, 19, FontStyle.Bold), Bounds = new Rectangle(90, 28, 490, 42) });
        Controls.Add(new Label { Text = T("边看边问，整理重点，找回学过的内容。", "Ask questions, save key ideas and revisit what you learned."), ForeColor = Color.DimGray, Bounds = new Rectangle(30, 91, 550, 34) });
        Controls.Add(new Label { Text = T("选择你使用的浏览器", "Choose your browser"), Bounds = new Rectangle(30, 139, 260, 25) });
        browser.SetBounds(30, 170, 235, 32);
        browser.DropDownStyle = ComboBoxStyle.DropDownList;
        browser.Items.AddRange(new object[] { "Microsoft Edge", "Google Chrome" });
        browser.SelectedIndex = ExtensionFiles.BrowserPath(false) == null && ExtensionFiles.BrowserPath(true) != null ? 1 : 0;
        Controls.Add(browser);
        install.Text = T("安装并打开浏览器", "Prepare and open browser");
        install.SetBounds(287, 168, 280, 42);
        install.BackColor = Color.FromArgb(0, 122, 255);
        install.ForeColor = Color.White;
        install.FlatStyle = FlatStyle.Flat;
        install.FlatAppearance.BorderSize = 0;
        install.Click += async delegate { await Prepare(); };
        Controls.Add(install);
        folder.SetBounds(30, 233, 537, 30);
        folder.ReadOnly = true;
        folder.Text = ExtensionFiles.Destination(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData));
        Controls.Add(folder);
        var copy = new LinkLabel { Text = T("复制插件文件夹路径", "Copy extension folder path"), Bounds = new Rectangle(30, 275, 360, 26) };
        copy.LinkClicked += delegate { CopyPath(); };
        Controls.Add(copy);
        status.SetBounds(30, 312, 537, 80);
        status.Text = T("准备完成后，在浏览器开启开发者模式 → 加载已解压的扩展 → 粘贴上方路径。\n已经安装？更新后点击“重新加载”，保留原来的学习资料。", "After preparing: enable Developer mode → Load unpacked → paste the folder above.\nAlready installed? Click Reload to update and keep your learning data.");
        Controls.Add(status);
        Controls.Add(new Label { Text = T("无需管理员权限。最后一步由你在浏览器确认加载。", "No administrator access needed. Confirm loading in your browser."), ForeColor = Color.DimGray, Bounds = new Rectangle(30, 408, 537, 26) });
    }

    void CopyPath()
    {
        try { Clipboard.SetText(folder.Text); }
        catch (System.Runtime.InteropServices.ExternalException) { folder.Focus(); folder.SelectAll(); }
    }

    async Task Prepare()
    {
        install.Enabled = browser.Enabled = false;
        try
        {
            if (installed == null)
            {
                status.Text = T("正在准备插件文件…", "Preparing extension files…");
                string appData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                installed = await Task.Run(() => ExtensionFiles.Install(appData));
                folder.Text = installed;
            }
            CopyPath();
            string page = browser.SelectedIndex == 1 ? "chrome://extensions/" : "edge://extensions/";
            string executable = ExtensionFiles.BrowserPath(browser.SelectedIndex == 1);
            if (executable != null) Process.Start(new ProcessStartInfo(executable, page) { UseShellExecute = true });
            status.Text = T("插件文件已就绪，路径已提供。\n在浏览器开启开发者模式 → 加载已解压的扩展 → 粘贴路径。\n更新已有插件时点击“重新加载”，无需卸载。", "Extension files are ready.\nEnable Developer mode → Load unpacked → paste the folder path.\nFor an existing extension, click Reload instead of removing it.");
            if (executable == null) status.Text += "\n" + T("请在浏览器地址栏打开：", "Open in your browser: ") + page;
            install.Text = T("再次打开安装页", "Open browser setup again");
        }
        catch (Exception error)
        {
            status.Text = T("暂时未能完成，请重试。\n", "Setup could not finish. Please retry.\n") + error.Message;
        }
        finally { install.Enabled = browser.Enabled = true; }
    }
}

internal static class Program
{
    [STAThread]
    static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        if (args.Length == 2 && args[0] == "--verify") return Verify(args[1]);
        bool first;
        using (var mutex = new System.Threading.Mutex(true, @"Local\VidenceBrowserExtensionSetup", out first))
        {
            if (!first) return 0;
            Application.Run(new SetupWindow());
        }
        return 0;
    }

    // Checks the shipped EXE using a temporary destination; never opens a browser.
    static int Verify(string report)
    {
        string root = Path.Combine(Path.GetTempPath(), "VidenceInstallerCheck-" + Guid.NewGuid().ToString("N"));
        try
        {
            string destination = ExtensionFiles.Install(root);
            string marker = Path.Combine(root, "VideoMemoryAssistant", "learning-data-preserved.txt");
            File.WriteAllText(marker, "preserve");
            File.WriteAllText(Path.Combine(destination, "obsolete-test-file.js"), "obsolete");
            ExtensionFiles.Install(root);
            if (!File.Exists(marker) || File.Exists(Path.Combine(destination, "obsolete-test-file.js"))) throw new IOException("Update preservation check failed.");
            foreach (string entry in new[] { "../outside.txt", "nested/../../outside.txt", "C:/outside.txt" })
            using (var memory = new MemoryStream())
            {
                using (var zip = new ZipArchive(memory, ZipArchiveMode.Create, true)) zip.CreateEntry(entry);
                memory.Position = 0;
                bool rejected = false;
                using (var zip = new ZipArchive(memory, ZipArchiveMode.Read))
                {
                    try { ExtensionFiles.Extract(zip, Path.Combine(root, "invalid")); }
                    catch (InvalidDataException) { rejected = true; }
                }
                if (!rejected) throw new IOException("Unsafe path accepted.");
            }
            using (var form = new SetupWindow())
            using (var bitmap = new Bitmap(form.Width, form.Height))
            {
                form.ShowInTaskbar = false;
                form.StartPosition = FormStartPosition.Manual;
                form.Location = new Point(-32000, -32000);
                form.Show();
                form.Update();
                form.DrawToBitmap(bitmap, new Rectangle(Point.Empty, form.Size));
                bitmap.Save(report + ".png");
            }
            File.WriteAllText(report, new JavaScriptSerializer().Serialize(new { passed = true, version = BuildInfo.Version, payloadSha256 = BuildInfo.PayloadSha256, install = true, update = true, adjacentLearningDataPreserved = true, staleAssetsRemoved = true, traversalRejected = true, browserOpened = false, uiEvidence = "offscreen-render" }));
            return 0;
        }
        catch (Exception error) { File.WriteAllText(report, new JavaScriptSerializer().Serialize(new { passed = false, error = error.ToString() })); return 1; }
        finally { if (Directory.Exists(root)) ExtensionFiles.DeleteOwned(root, Path.GetTempPath()); }
    }
}
