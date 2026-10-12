using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO.Enumeration;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Win32;

internal static class Program
{
    private const string Scheme = "pi-desktop-agent";
    private static readonly string Root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Pi Desktop Agent");
    private static readonly ConcurrentDictionary<string, CancellationTokenSource> Jobs = new();
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private static HttpClient? http;
    private static Uri? origin;
    private static string? connection;

    [STAThread]
    private static async Task Main(string[] args)
    {
        NativeWindows.EnableDpi();
        AgentDiagnostics.Write("process.start", args.Length == 3 && args[0] == "--elevated-operation" ? "mode=elevated-worker" : args.Length == 0 ? "mode=installer" : "mode=connection");
        try
        {
            if (args.Length == 3 && args[0] == "--elevated-operation") { await ElevatedWorker(args[1], args[2]); return; }
            if (args.Length == 0) { Install(); return; }
            if (args.Length != 1 || !Uri.TryCreate(args[0], UriKind.Absolute, out var launch) || launch.Scheme != Scheme || launch.Host != "connect") throw new Exception("Неверная команда запуска помощника");
            var query = launch.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries).Select(part => part.Split('=', 2)).ToDictionary(part => Uri.UnescapeDataString(part[0]), part => part.Length == 2 ? Uri.UnescapeDataString(part[1]) : "");
            origin = new Uri(query["server"]);
            if (origin.Scheme != "https" || origin.UserInfo.Length != 0 || origin.AbsolutePath != "/" || origin.Query.Length != 0 || origin.Fragment.Length != 0) throw new Exception("Помощник подключается только к HTTPS-адресу Pi Desktop");
            var fingerprint = query["fingerprint"].Replace(":", "").ToUpperInvariant();
            if (!Regex.IsMatch(fingerprint, "^[A-F0-9]{64}$") || !Regex.IsMatch(query["token"], "^[a-f0-9]{64}$")) throw new Exception("Неверное приглашение");
            Directory.CreateDirectory(Root);
            var identityFile = Path.Combine(Root, Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(origin.GetLeftPart(UriPartial.Authority)))) + ".device");
            JsonObject identity;
            using (var mutex = new Mutex(false, @"Local\PiDesktopAgentIdentity-" + Path.GetFileNameWithoutExtension(identityFile)))
            {
                bool acquired;
                try { acquired = mutex.WaitOne(TimeSpan.FromSeconds(10)); }
                catch (AbandonedMutexException) { acquired = true; }
                if (!acquired) throw new Exception("Другая копия помощника занята");
                try
                {
                    identity = File.Exists(identityFile) ? JsonNode.Parse(NativeWindows.Unprotect(File.ReadAllBytes(identityFile)))!.AsObject() : new JsonObject { ["id"] = Guid.NewGuid().ToString(), ["secret"] = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant() };
                    if (identity["fingerprint"]?.GetValue<string>() != fingerprint)
                    {
                        if (!NativeWindows.Confirm($"Подключить управление этого ПК к {origin}?\n\nСервер сможет читать и изменять файлы, выполнять команды и управлять рабочим столом от имени вашей учётной записи.\n\nСверьте отпечаток в настройках Pi Desktop:\n{query["fingerprint"]}\n\nБез вашего подтверждения Windows UAC административных прав не будет.")) return;
                        identity["fingerprint"] = fingerprint;
                    }
                    var temporaryIdentity = identityFile + "." + Guid.NewGuid().ToString("N") + ".tmp";
                    try { File.WriteAllBytes(temporaryIdentity, NativeWindows.Protect(Encoding.UTF8.GetBytes(identity.ToJsonString()))); File.Move(temporaryIdentity, identityFile, true); }
                    finally { if (File.Exists(temporaryIdentity)) File.Delete(temporaryIdentity); }
                }
                finally { mutex.ReleaseMutex(); }
            }
            AgentDiagnostics.Write("connection.target", origin.GetLeftPart(UriPartial.Authority));
            var handler = new HttpClientHandler { AllowAutoRedirect = false, ServerCertificateCustomValidationCallback = (_, certificate, _, errors) =>
            {
                var actual = certificate == null ? "missing" : Convert.ToHexString(SHA256.HashData(certificate.RawData));
                var now = DateTime.UtcNow;
                var accepted = certificate != null && actual == fingerprint && now >= certificate.NotBefore.ToUniversalTime() && now <= certificate.NotAfter.ToUniversalTime();
                AgentDiagnostics.Write("tls.certificate", $"accepted={accepted} policyErrors={errors} expected={fingerprint} actual={actual} notBefore={certificate?.NotBefore.ToUniversalTime():O} notAfter={certificate?.NotAfter.ToUniversalTime():O}");
                return accepted;
            } };
            http = new HttpClient(handler) { BaseAddress = origin, Timeout = TimeSpan.FromSeconds(35) };
            var linked = await Post("/api/agent/connect", new JsonObject { ["token"] = query["token"], ["deviceId"] = identity["id"]!.DeepClone(), ["secret"] = identity["secret"]!.DeepClone(), ["name"] = Environment.MachineName, ["cwd"] = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ["drives"] = Strings(Directory.GetLogicalDrives()), ["os"] = "windows" });
            connection = linked["token"]!.GetValue<string>();
            http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", connection);
            AgentDiagnostics.Write("connection.linked");
            using var stop = new CancellationTokenSource();
            using var tray = new NativeTray(() => stop.Cancel(), $"Pi Desktop: {origin.Host}");
            var running = new ConcurrentDictionary<string, Task>();
            var executed = new HashSet<string>();
            using var slots = new SemaphoreSlim(4);
            try
            {
                while (!stop.IsCancellationRequested)
                {
                    var poll = await Post("/api/agent/poll", new JsonObject(), stop.Token);
                    if (poll["stop"]?.GetValue<bool>() == true) { AgentDiagnostics.Write("connection.server-stop"); break; }
                    if (poll["command"] is not JsonObject command) continue;
                    var id = command["id"]!.GetValue<string>();
                    if (command["operation"]!.GetValue<string>() == "cancel") { if (Jobs.TryGetValue(command["args"]!["id"]!.GetValue<string>(), out var job)) job.Cancel(); continue; }
                    if (!executed.Add(id)) continue; // Includes already completed commands: never replay writes.
                    if (executed.Count > 100000) throw new Exception("Подключите помощник заново: достигнут предел команд одного подключения");
                    var task = ExecuteCommand(id, command, slots, stop.Token);
                    running[id] = task;
                    _ = task.ContinueWith(_ => running.TryRemove(id, out var removed), TaskScheduler.Default);
                }
            }
            finally
            {
                AgentDiagnostics.Write("connection.shutdown", $"activeJobs={Jobs.Count} canceled={stop.IsCancellationRequested}");
                stop.Cancel(); foreach (var job in Jobs.Values) job.Cancel();
                try { await Task.WhenAll(running.Values).WaitAsync(TimeSpan.FromSeconds(10)); } catch { }
            }
        }
        catch (OperationCanceledException) { AgentDiagnostics.Write("process.canceled"); }
        catch (Exception error)
        {
            AgentDiagnostics.Write("process.failure", $"type={error.GetType().Name} hresult=0x{error.HResult:X8}");
            NativeWindows.Message("Pi Desktop Agent", error.Message + "\n\nДиагностика: " + AgentDiagnostics.FilePath);
        }
        finally { AgentDiagnostics.Write("process.exit"); }
    }

    private static void Install()
    {
        if (!NativeWindows.Confirm("Установить минимальный помощник Pi Desktop для этой учётной записи?\n\nОн будет запускаться кнопкой на сайте и появляться в области уведомлений только во время подключения. Автозапуска Windows нет. Права администратора для установки не нужны.")) return;
        Directory.CreateDirectory(Root);
        var executable = Path.Combine(Root, "Pi Desktop Agent.exe");
        if (!string.Equals(Environment.ProcessPath, executable, StringComparison.OrdinalIgnoreCase)) File.Copy(Environment.ProcessPath!, executable, true);
        using var key = Registry.CurrentUser.CreateSubKey(@"Software\Classes\" + Scheme);
        key.SetValue("", "URL:Pi Desktop Agent"); key.SetValue("URL Protocol", "");
        using var command = key.CreateSubKey(@"shell\open\command"); command.SetValue("", $"\"{executable}\" \"%1\"");
        NativeWindows.Message("Pi Desktop Agent", "Готово. Вернитесь на сайт и нажмите «Подключить управление этого ПК».");
    }

    private static async Task<JsonObject> Post(string path, JsonObject body, CancellationToken token = default)
    {
        using var content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
        AgentDiagnostics.Write("http.start", path);
        HttpResponseMessage received;
        try { received = await http!.PostAsync(path, content, token); }
        catch (Exception error)
        {
            AgentDiagnostics.Write("http.failure", $"path={path} callerCanceled={token.IsCancellationRequested} {AgentDiagnostics.TransportError(error)}");
            throw;
        }
        using var response = received;
        AgentDiagnostics.Write("http.response", $"path={path} status={(int)response.StatusCode}");
        var text = await response.Content.ReadAsStringAsync(token);
        if (!response.IsSuccessStatusCode)
        {
            string? reason = null;
            try { reason = JsonNode.Parse(text)?["error"]?.GetValue<string>(); } catch { }
            if (reason?.Length > 300) reason = reason[..300];
            throw new Exception($"Pi Desktop: HTTP {(int)response.StatusCode} ({path}).\n{reason ?? "Сервер отклонил запрос."}\nОткройте сайт и подключите помощник заново.");
        }
        return JsonNode.Parse(text)!.AsObject();
    }

    private static async Task ExecuteCommand(string id, JsonObject command, SemaphoreSlim slots, CancellationToken stopping)
    {
        using var cancel = CancellationTokenSource.CreateLinkedTokenSource(stopping);
        Jobs[id] = cancel;
        JsonNode? result = null; string? error = null;
        try { await slots.WaitAsync(cancel.Token); try { result = await Dispatch(command["operation"]!.GetValue<string>(), command["args"]!.AsObject(), cancel.Token); } finally { slots.Release(); } }
        catch (Exception failure) { error = failure is OperationCanceledException ? "Команда отменена; её частичные изменения не откатываются автоматически." : failure.Message; }
        finally { Jobs.TryRemove(id, out var removed); }
        if (stopping.IsCancellationRequested) return;
        // A failed delivery NEVER reruns the command, particularly a write/exec.
        try { await Post("/api/agent/result", new JsonObject { ["id"] = id, ["result"] = result, ["error"] = error }, stopping); }
        catch { AgentDiagnostics.Write("command.result-undelivered", $"id={id}; command not replayed"); }
    }

    private static string Text(JsonObject args, string key, string fallback = "") => args[key]?.GetValue<string>() ?? fallback;
    private static int Number(JsonObject args, string key, int fallback) => args[key]?.GetValue<int>() ?? fallback;
    private static string SafePath(string input)
    {
        if (!Path.IsPathFullyQualified(input) || input.StartsWith(@"\\?\") || input.StartsWith(@"\\.\")) throw new Exception("Нужен обычный абсолютный путь клиентского ПК");
        var full = Path.GetFullPath(input);
        foreach (var part in full.Split(new[] { '\\', '/' })) if (Regex.IsMatch(part, @"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)", RegexOptions.IgnoreCase)) throw new Exception("Имена устройств Windows не являются файлами");
        return full;
    }
    private static JsonObject Snapshot(byte[]? bytes)
    {
        if (bytes is null) return new JsonObject { ["kind"] = "missing" };
        if (bytes.Length > 1024 * 1024 || Array.IndexOf(bytes, (byte)0) >= 0) return new JsonObject { ["kind"] = "unsupported", ["size"] = bytes.Length };
        try { return new JsonObject { ["kind"] = "text", ["text"] = Utf8.GetString(bytes) }; } catch { return new JsonObject { ["kind"] = "unsupported", ["size"] = bytes.Length }; }
    }

    private static async Task<JsonNode> Dispatch(string operation, JsonObject args, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        switch (operation)
        {
            case "stat":
                var inspected = SafePath(Text(args, "path")); var inspectedFile = new FileInfo(inspected);
                return new JsonObject { ["exists"] = inspectedFile.Exists || Directory.Exists(inspected), ["directory"] = Directory.Exists(inspected), ["size"] = inspectedFile.Exists ? inspectedFile.Length : 0, ["stamp"] = inspectedFile.Exists ? inspectedFile.LastWriteTimeUtc.Ticks.ToString() : "" };
            case "readChunk":
                var chunkFile = SafePath(Text(args, "path"));
                using (var input = new FileStream(chunkFile, FileMode.Open, FileAccess.Read, FileShare.Read))
                {
                    if (input.Length > 512 * 1024 * 1024 || input.Length != Number(args, "size", -1) || File.GetLastWriteTimeUtc(chunkFile).Ticks.ToString() != Text(args, "stamp")) throw new Exception("Исходник изменился или превышает 512 МБ; выберите его заново");
                    var offset = Number(args, "offset", 0); if (offset < 0 || offset > input.Length) throw new Exception("Неверное смещение");
                    input.Position = offset; var block = new byte[(int)Math.Min(256 * 1024, input.Length - offset)]; await input.ReadExactlyAsync(block, token);
                    return new JsonObject { ["data"] = Convert.ToBase64String(block) };
                }
            case "read":
                var source = SafePath(Text(args, "path"));
                if (!File.Exists(source)) return new JsonObject { ["exists"] = false };
                if (new FileInfo(source).Length > 8 * 1024 * 1024) return new JsonObject { ["exists"] = true, ["unsupported"] = true };
                var bytes = await File.ReadAllBytesAsync(source, token);
                return new JsonObject { ["exists"] = true, ["data"] = Convert.ToBase64String(bytes) };
            case "mkdir": Directory.CreateDirectory(SafePath(Text(args, "path"))); return new JsonObject();
            case "write":
                var destination = SafePath(Text(args, "path")); var content = Utf8.GetBytes(Text(args, "content"));
                if (content.Length > 8 * 1024 * 1024) throw new Exception("Запись больше 8 МБ");
                var expected = Text(args, "expectedHash");
                var existed = true;
                FileStream opened;
                try { opened = new FileStream(destination, FileMode.Open, FileAccess.ReadWrite, FileShare.Read); }
                catch (FileNotFoundException) when (expected.Length == 0)
                {
                    try { opened = new FileStream(destination, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.Read); existed = false; }
                    catch (IOException) when (File.Exists(destination)) { opened = new FileStream(destination, FileMode.Open, FileAccess.ReadWrite, FileShare.Read); }
                }
                using (var file = opened)
                {
                    var previousLength = file.Length;
                    byte[]? before = null;
                    if (existed && file.Length <= 8 * 1024 * 1024) { before = new byte[(int)file.Length]; await file.ReadExactlyAsync(before, token); }
                    if (expected.Length > 0 && (before is null || !string.Equals(Convert.ToHexString(SHA256.HashData(before)), expected, StringComparison.OrdinalIgnoreCase))) throw new Exception("Файл изменился после чтения; повторно прочитайте его перед редактированием");
                    token.ThrowIfCancellationRequested(); file.Position = 0; await file.WriteAsync(content, token); file.SetLength(content.Length); await file.FlushAsync(token);
                    var snapshot = existed && before is null ? new JsonObject { ["kind"] = "unsupported", ["size"] = previousLength } : Snapshot(before);
                    return new JsonObject { ["mutation"] = new JsonObject { ["path"] = destination, ["before"] = snapshot, ["after"] = Snapshot(content) } };
                }
            case "ls": return new JsonObject { ["names"] = Strings(Directory.EnumerateFileSystemEntries(SafePath(Text(args, "path"))).Take(10000).Select(item => Path.GetFileName(item))) };
            case "find":
                var root = SafePath(Text(args, "cwd")); var glob = Text(args, "pattern", "*");
                return new JsonObject { ["files"] = Strings(Walk(root, token).Where(file => GlobMatches(glob, Path.GetRelativePath(root, file))).Take(Math.Clamp(Number(args, "limit", 1000), 1, 10000))) };
            case "grep": return Grep(args, token);
            case "exec": return await Exec(Text(args, "command"), SafePath(Text(args, "cwd")), Math.Clamp(Number(args, "timeout", 600), 1, 3600), token);
            case "execElevated": return await Elevate(args, token);
            case "elevate": return await Elevate(new JsonObject { ["command"] = "whoami /groups", ["cwd"] = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile) }, token);
            case "computer": return NativeWindows.Computer(args);
            case "saveAttachment":
                var attachment = Convert.FromBase64String(Text(args, "data"));
                if (attachment.Length == 0 || attachment.Length > 8 * 1024 * 1024) throw new Exception("Вложение должно быть до 8 МБ");
                var extension = Text(args, "extension", ".bin");
                if (!Regex.IsMatch(extension, @"^\.[a-zA-Z0-9]{1,10}$")) throw new Exception("Неверное расширение вложения");
                var cache = Path.Combine(Root, "chat-attachments"); Directory.CreateDirectory(cache);
                var copied = Path.Combine(cache, Convert.ToHexString(SHA256.HashData(attachment)) + extension);
                if (!File.Exists(copied)) { await using var saved = new FileStream(copied, FileMode.CreateNew, FileAccess.Write, FileShare.None); await saved.WriteAsync(attachment, token); }
                else if (!(await File.ReadAllBytesAsync(copied, token)).AsSpan().SequenceEqual(attachment)) throw new Exception("Сохранённая копия вложения повреждена");
                return new JsonObject { ["path"] = copied };
            case "chooseFolders": return Strings(await NativeWindows.ChooseFolders());
            case "chooseFiles": return Strings(await NativeWindows.ChooseFiles());
            case "showFile":
                Process.Start(new ProcessStartInfo("explorer.exe") { Arguments = $"/select,\"{SafePath(Text(args, "path"))}\"", UseShellExecute = true }); return new JsonObject();
            case "download":
                var relative = Text(args, "url");
                if (!relative.StartsWith("/api/agent/media/", StringComparison.Ordinal) || relative.Contains("..")) throw new Exception("Можно скачать только результат генерации этого устройства");
                var name = Path.GetFileName(Text(args, "filename")); if (name.Length == 0) throw new Exception("Нужно имя файла");
                var downloads = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads", "Pi Desktop"); Directory.CreateDirectory(downloads);
                var output = SafePath(Path.Combine(downloads, Guid.NewGuid().ToString("N") + "-" + name));
                using (var response = await http!.GetAsync(relative, HttpCompletionOption.ResponseHeadersRead, token))
                {
                    response.EnsureSuccessStatusCode();
                    if (response.Content.Headers.ContentLength is > 512 * 1024 * 1024) throw new Exception("Файл больше 512 МБ");
                    await using var input = await response.Content.ReadAsStreamAsync(token); await using var file = new FileStream(output, FileMode.CreateNew, FileAccess.Write, FileShare.None);
                    var block = new byte[65536]; long total = 0; int count;
                    while ((count = await input.ReadAsync(block, token)) > 0) { total += count; if (total > 512 * 1024 * 1024) throw new Exception("Файл больше 512 МБ"); await file.WriteAsync(block.AsMemory(0, count), token); }
                }
                Process.Start(new ProcessStartInfo("explorer.exe") { Arguments = $"/select,\"{output}\"", UseShellExecute = true }); return new JsonObject { ["path"] = output };
            default: throw new Exception("Неизвестная операция помощника");
        }
    }

    private static JsonArray Strings(IEnumerable<string> strings) { var result = new JsonArray(); foreach (var text in strings) result.Add(JsonValue.Create(text)); return result; }
    private static bool GlobMatches(string pattern, string file) => FileSystemName.MatchesSimpleExpression(pattern.Replace("**/", "*").Replace('/', '\\'), file.Replace('/', '\\'), true) || FileSystemName.MatchesSimpleExpression(pattern, Path.GetFileName(file), true);
    private static IEnumerable<string> Walk(string root, CancellationToken token)
    {
        var pending = new Stack<(string path, int depth)>(); pending.Push((root, 0)); int scanned = 0;
        while (pending.Count > 0 && scanned < 100000)
        {
            var (folder, depth) = pending.Pop();
            IEnumerable<string> entries;
            try { entries = Directory.GetFileSystemEntries(folder); } catch (UnauthorizedAccessException) { continue; }
            foreach (var entry in entries)
            {
                token.ThrowIfCancellationRequested(); if (++scanned > 100000) yield break;
                var attributes = File.GetAttributes(entry);
                if ((attributes & FileAttributes.ReparsePoint) != 0) continue;
                if ((attributes & FileAttributes.Directory) == 0) yield return entry;
                else if (depth < 32 && !new[] { ".git", "node_modules", "bin", "obj", "dist", "build" }.Contains(Path.GetFileName(entry), StringComparer.OrdinalIgnoreCase)) pending.Push((entry, depth + 1));
            }
        }
    }
    private static JsonObject Grep(JsonObject args, CancellationToken token)
    {
        var source = SafePath(Text(args, "path")); var pattern = Text(args, "pattern");
        if (args["literal"]?.GetValue<bool>() == true) pattern = Regex.Escape(pattern);
        var regex = new Regex(pattern, RegexOptions.CultureInvariant | (args["ignoreCase"]?.GetValue<bool>() == true ? RegexOptions.IgnoreCase : RegexOptions.None), TimeSpan.FromSeconds(1));
        var limit = Math.Clamp(Number(args, "limit", 100), 1, 10000); var context = Math.Clamp(Number(args, "context", 0), 0, 20); var matches = 0;
        var output = new StringBuilder();
        foreach (var file in Directory.Exists(source) ? Walk(source, token) : new[] { source })
        {
            token.ThrowIfCancellationRequested(); if (!GlobMatches(Text(args, "glob", "*"), Path.GetFileName(file)) || new FileInfo(file).Length > 8 * 1024 * 1024) continue;
            string[] lines; try { lines = File.ReadAllLines(file, Utf8); } catch (Exception e) when (e is DecoderFallbackException or UnauthorizedAccessException or IOException) { continue; }
            for (var index = 0; index < lines.Length; index++) if (regex.IsMatch(lines[index]))
            {
                for (var line = Math.Max(0, index - context); line <= Math.Min(lines.Length - 1, index + context); line++) output.AppendLine($"{file}:{line + 1}:{lines[line][..Math.Min(lines[line].Length, 1000)]}");
                if (++matches >= limit || output.Length > 1000000) return new JsonObject { ["output"] = output.ToString(), ["truncated"] = true };
            }
        }
        return new JsonObject { ["output"] = output.ToString(), ["truncated"] = false };
    }
    private static async Task<string> Drain(StreamReader reader)
    {
        var output = new StringBuilder(); var block = new char[4096]; int size;
        while ((size = await reader.ReadAsync(block)) > 0) if (output.Length < 1000000) output.Append(block, 0, Math.Min(size, 1000000 - output.Length));
        return output.ToString();
    }
    private static async Task<JsonObject> Exec(string command, string cwd, int seconds, CancellationToken token)
    {
        if (command.Length > 200000) throw new Exception("Команда слишком большая");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token); timeout.CancelAfter(TimeSpan.FromSeconds(seconds));
        var script = "$ErrorActionPreference='Stop';$OutputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);\n" + command;
        using var process = new Process { StartInfo = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), @"System32\WindowsPowerShell\v1.0\powershell.exe")) {
            WorkingDirectory = cwd, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
        }};
        foreach (var arg in new[] { "-NoProfile", "-NonInteractive", "-EncodedCommand", Convert.ToBase64String(Encoding.Unicode.GetBytes(script)) }) process.StartInfo.ArgumentList.Add(arg);
        process.Start(); using var cancellation = timeout.Token.Register(() => { try { process.Kill(true); } catch { } });
        var stdout = Drain(process.StandardOutput); var stderr = Drain(process.StandardError); await process.WaitForExitAsync(timeout.Token);
        return new JsonObject { ["output"] = await stdout + "\n" + await stderr, ["exitCode"] = process.ExitCode };
    }
    private static async Task<JsonNode> Elevate(JsonObject args, CancellationToken token)
    {
        var command = Text(args, "command");
        if (command.Length == 0 || command.Length > 8000) throw new Exception("Повышенная команда должна быть от 1 до 8000 символов");
        _ = SafePath(Text(args, "cwd"));
        AgentDiagnostics.Write("elevation.request", "main process stays connected; starting a separate worker via Windows UAC");
        var folder = Path.Combine(Root, "requests"); Directory.CreateDirectory(folder);
        var file = Path.Combine(folder, Guid.NewGuid().ToString("N") + ".json"); var result = file + ".result";
        var bytes = Encoding.UTF8.GetBytes(args.ToJsonString()); var hash = Convert.ToHexString(SHA256.HashData(bytes));
        await File.WriteAllBytesAsync(file, bytes, token);
        try
        {
            using var elevated = Process.Start(new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = true, Verb = "runas", WindowStyle = ProcessWindowStyle.Hidden, Arguments = $"--elevated-operation \"{file}\" {hash}" }) ?? throw new Exception("Windows не запустила повышенную операцию");
            AgentDiagnostics.Write("elevation.worker-started", $"workerPid={elevated.Id}");
            try { await elevated.WaitForExitAsync(token); }
            catch (OperationCanceledException)
            {
                AgentDiagnostics.Write("elevation.cancel-requested", $"workerPid={elevated.Id}");
                // The normal-user process cannot kill an elevated tree. Ask that worker to cancel its own command.
                await File.WriteAllTextAsync(file + ".cancel", "cancel");
                try { await elevated.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5)); } catch { }
                throw;
            }
            AgentDiagnostics.Write("elevation.worker-exit", $"workerPid={elevated.Id} exitCode={elevated.ExitCode} resultExists={File.Exists(result)}");
            if (!File.Exists(result)) throw new Exception("Повышение прав отменено или заблокировано политикой Windows");
            var response = JsonNode.Parse(await File.ReadAllTextAsync(result, token))!.AsObject();
            if (response["error"] is JsonNode error) throw new Exception(error.GetValue<string>());
            return response["result"]!.DeepClone();
        }
        finally { try { File.Delete(file); File.Delete(result); File.Delete(file + ".cancel"); } catch { } }
    }
    private static async Task ElevatedWorker(string file, string expected)
    {
        AgentDiagnostics.Write("elevated-worker.start", "no network connection in this process");
        var bytes = await File.ReadAllBytesAsync(file);
        if (Convert.ToHexString(SHA256.HashData(bytes)) != expected) throw new Exception("Запрос изменился; повышенная команда отклонена");
        var args = JsonNode.Parse(bytes)!.AsObject();
        using var canceled = new CancellationTokenSource();
        using var finished = new CancellationTokenSource();
        var watcher = WatchCancellation(file + ".cancel", canceled, finished.Token);
        JsonObject response;
        try { response = new JsonObject { ["result"] = await Exec(Text(args, "command"), SafePath(Text(args, "cwd")), 3600, canceled.Token) }; }
        catch (Exception error) { response = new JsonObject { ["error"] = error.Message }; }
        finally { finished.Cancel(); await watcher; }
        await File.WriteAllTextAsync(file + ".result", response.ToJsonString(), Encoding.UTF8);
        AgentDiagnostics.Write("elevated-worker.result", $"success={response["error"] == null}");
    }
    private static async Task WatchCancellation(string file, CancellationTokenSource command, CancellationToken finished)
    {
        try { while (!finished.IsCancellationRequested) { if (File.Exists(file)) { command.Cancel(); return; } await Task.Delay(250, finished); } }
        catch (OperationCanceledException) { }
    }
}
