using System.Text;

/** Bounded local diagnostics. Never pass command bodies, credentials or launch URLs here. */
internal static class AgentDiagnostics
{
    private static readonly object Gate = new();
    internal static readonly string FilePath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Pi Desktop Agent", "diagnostics.log");

    internal static void Write(string stage, string details = "")
    {
        try
        {
            lock (Gate)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
                if (File.Exists(FilePath) && new FileInfo(FilePath).Length > 512 * 1024) File.WriteAllText(FilePath, "", new UTF8Encoding(false));
                var clean = details.Replace('\r', ' ').Replace('\n', ' ');
                if (clean.Length > 2048) clean = clean[..2048];
                var line = $"{DateTimeOffset.UtcNow:O} pid={Environment.ProcessId} {stage} {clean}\n";
                using var output = new FileStream(FilePath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
                output.Write(Encoding.UTF8.GetBytes(line));
            }
        }
        catch { /* Diagnostics must not interrupt commands or connection shutdown. */ }
    }

    // Used only for transport failures; operation exceptions may contain private command output.
    internal static string TransportError(Exception error)
    {
        var parts = new List<string>();
        for (Exception? item = error; item != null && parts.Count < 8; item = item.InnerException)
            parts.Add($"{item.GetType().Name} hresult=0x{item.HResult:X8}: {item.Message}");
        return string.Join(" -> ", parts);
    }
}
