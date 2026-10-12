using System.ComponentModel;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;

internal static class NativeWindows
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int MessageBoxW(nint window, string text, string title, uint flags);
    internal static bool Confirm(string text) => MessageBoxW(0, text, "Pi Desktop Agent", 0x24 | 0x10000) == 6;
    internal static void Message(string title, string text) => MessageBoxW(0, text, title, 0x40 | 0x10000);

    [StructLayout(LayoutKind.Sequential)] private struct Blob { public int Length; public nint Data; }
    [DllImport("crypt32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CryptProtectData(ref Blob input, string description, nint entropy, nint reserved, nint prompt, uint flags, out Blob output);
    [DllImport("crypt32.dll", SetLastError = true)] private static extern bool CryptUnprotectData(ref Blob input, nint description, nint entropy, nint reserved, nint prompt, uint flags, out Blob output);
    [DllImport("kernel32.dll")] private static extern nint LocalFree(nint memory);
    internal static byte[] Protect(byte[] data) => Crypt(data, true);
    internal static byte[] Unprotect(byte[] data) => Crypt(data, false);
    private static byte[] Crypt(byte[] data, bool protect)
    {
        var memory = Marshal.AllocHGlobal(data.Length);
        try
        {
            Marshal.Copy(data, 0, memory, data.Length); var input = new Blob { Length = data.Length, Data = memory };
            Blob output;
            var ok = protect ? CryptProtectData(ref input, "Pi Desktop device identity", 0, 0, 0, 1, out output) : CryptUnprotectData(ref input, 0, 0, 0, 0, 1, out output);
            if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error());
            try { var result = new byte[output.Length]; Marshal.Copy(output.Data, result, 0, result.Length); return result; }
            finally { LocalFree(output.Data); }
        }
        finally { Marshal.FreeHGlobal(memory); }
    }

    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
    internal static void EnableDpi() => SetProcessDPIAware();
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int metric);
    [DllImport("user32.dll")] private static extern nint GetDC(nint window);
    [DllImport("user32.dll")] private static extern int ReleaseDC(nint window, nint dc);
    [DllImport("gdi32.dll")] private static extern nint CreateCompatibleDC(nint dc);
    [DllImport("gdi32.dll")] private static extern nint CreateCompatibleBitmap(nint dc, int width, int height);
    [DllImport("gdi32.dll")] private static extern nint SelectObject(nint dc, nint value);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(nint value);
    [DllImport("gdi32.dll")] private static extern bool DeleteDC(nint dc);
    [DllImport("gdi32.dll")] private static extern bool BitBlt(nint target, int x, int y, int width, int height, nint source, int sx, int sy, uint operation);
    [StructLayout(LayoutKind.Sequential)] private struct BitmapInfo { public uint Size; public int Width, Height; public ushort Planes, Bits; public uint Compression, ImageSize; public int X, Y; public uint Used, Important; }
    [DllImport("gdi32.dll")] private static extern int GetDIBits(nint dc, nint bitmap, uint start, uint lines, [Out] byte[] bytes, ref BitmapInfo info, uint usage);
    [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] private static extern void mouse_event(uint flags, uint x, uint y, uint data, nuint extra);
    [DllImport("user32.dll")] private static extern void keybd_event(byte key, byte scan, uint flags, nuint extra);
    [StructLayout(LayoutKind.Explicit, Size = 40)] private struct Input { [FieldOffset(0)] public uint Type; [FieldOffset(8)] public ushort Key; [FieldOffset(10)] public ushort Scan; [FieldOffset(12)] public uint Flags; }
    [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, [In] Input[] inputs, int size);
    internal static JsonObject Computer(JsonObject args)
    {
        SetProcessDPIAware();
        string Get(string name) => args[name]?.GetValue<string>() ?? "";
        int Number(string name, int fallback = 0) => args[name] is JsonNode value ? checked((int)Math.Round(value.GetValue<double>())) : fallback;
        switch (Get("action"))
        {
            case "screenshot": return Screenshot();
            case "move": case "click":
                if (args["x"] is null || args["y"] is null) throw new Exception("Нужны координаты x и y клиентского рабочего стола");
                if (!SetCursorPos(Number("x"), Number("y"))) throw new Win32Exception();
                if (Get("action") == "click") { var right = Get("button") == "right"; mouse_event(right ? 8u : 2u, 0, 0, 0, 0); mouse_event(right ? 16u : 4u, 0, 0, 0, 0); }
                break;
            case "scroll": mouse_event(0x800, 0, 0, unchecked((uint)Math.Clamp(Number("delta"), -12000, 12000)), 0); break;
            case "text":
                var text = Get("text"); if (text.Length > 10000) throw new Exception("Слишком длинный ввод");
                foreach (var character in text)
                {
                    var inputs = new[] { new Input { Type = 1, Scan = character, Flags = 4 }, new Input { Type = 1, Scan = character, Flags = 6 } };
                    if (SendInput(2, inputs, 40) != 2) throw new Exception("Windows отклонила ввод; возможно, целевое окно имеет повышенные права");
                }
                break;
            case "key":
                var keys = Get("key").Split('+').Select(Key).ToArray();
                foreach (var key in keys) keybd_event(key, 0, 0, 0);
                foreach (var key in keys.Reverse()) keybd_event(key, 0, 2, 0);
                break;
            default: throw new Exception("Неизвестное действие рабочего стола");
        }
        return new JsonObject();
    }
    private static byte Key(string value) => value.ToUpperInvariant() switch
    {
        "CTRL" or "CONTROL" => 0x11, "ALT" => 0x12, "SHIFT" => 0x10, "WIN" => 0x5B,
        "ENTER" => 0x0D, "ESC" or "ESCAPE" => 0x1B, "TAB" => 9, "SPACE" => 0x20,
        "BACKSPACE" => 8, "DELETE" => 0x2E, "LEFT" => 0x25, "UP" => 0x26, "RIGHT" => 0x27, "DOWN" => 0x28,
        "HOME" => 0x24, "END" => 0x23, "PAGEUP" => 0x21, "PAGEDOWN" => 0x22,
        _ when value.Length == 1 && char.IsAsciiLetterOrDigit(value[0]) => (byte)char.ToUpperInvariant(value[0]),
        _ when value.Length >= 2 && (value[0] is 'F' or 'f') && int.TryParse(value[1..], out var function) && function is >= 1 and <= 24 => (byte)(0x6F + function),
        _ => throw new Exception("Неизвестная клавиша: " + value),
    };
    private static JsonObject Screenshot()
    {
        var x = GetSystemMetrics(76); var y = GetSystemMetrics(77); var width = GetSystemMetrics(78); var height = GetSystemMetrics(79);
        if (width <= 0 || height <= 0 || (long)width * height > 40000000) throw new Exception("Недоступный или слишком большой рабочий стол");
        var screen = GetDC(0); var dc = CreateCompatibleDC(screen); var bitmap = CreateCompatibleBitmap(screen, width, height);
        if (screen == 0 || dc == 0 || bitmap == 0) { if (bitmap != 0) DeleteObject(bitmap); if (dc != 0) DeleteDC(dc); if (screen != 0) ReleaseDC(0, screen); throw new Exception("Не удалось получить рабочий стол"); }
        var previous = SelectObject(dc, bitmap);
        try
        {
            if (!BitBlt(dc, 0, 0, width, height, screen, x, y, 0x40CC0020)) throw new Exception("Захват экрана отклонён");
            SelectObject(dc, previous);
            var bytes = new byte[checked(width * height * 4)];
            var info = new BitmapInfo { Size = 40, Width = width, Height = -height, Planes = 1, Bits = 32 };
            if (GetDIBits(dc, bitmap, 0, (uint)height, bytes, ref info, 0) != height) throw new Exception("Не удалось прочитать снимок");
            using var png = new MemoryStream(); png.Write(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 });
            var header = new byte[13]; Put(header, 0, (uint)width); Put(header, 4, (uint)height); header[8] = 8; header[9] = 2; Chunk(png, "IHDR", header);
            using var compressed = new MemoryStream();
            using (var zlib = new ZLibStream(compressed, CompressionLevel.Fastest, true))
            {
                var row = new byte[checked(width * 3 + 1)];
                for (var line = 0; line < height; line++) { for (var column = 0; column < width; column++) { var offset = (line * width + column) * 4; row[1 + column * 3] = bytes[offset + 2]; row[2 + column * 3] = bytes[offset + 1]; row[3 + column * 3] = bytes[offset]; } zlib.Write(row); }
            }
            Chunk(png, "IDAT", compressed.ToArray()); Chunk(png, "IEND", Array.Empty<byte>());
            if (png.Length > 8 * 1024 * 1024) throw new Exception("Снимок превышает предел передачи 8 МБ");
            return new JsonObject { ["data"] = Convert.ToBase64String(png.ToArray()), ["mimeType"] = "image/png", ["width"] = width, ["height"] = height, ["x"] = x, ["y"] = y };
        }
        finally { SelectObject(dc, previous); DeleteObject(bitmap); DeleteDC(dc); ReleaseDC(0, screen); }
    }
    private static void Put(byte[] target, int offset, uint value) { target[offset] = (byte)(value >> 24); target[offset + 1] = (byte)(value >> 16); target[offset + 2] = (byte)(value >> 8); target[offset + 3] = (byte)value; }
    private static void Chunk(Stream stream, string type, byte[] data)
    {
        var count = new byte[4]; Put(count, 0, (uint)data.Length); stream.Write(count); var tag = Encoding.ASCII.GetBytes(type); stream.Write(tag); stream.Write(data);
        uint crc = 0xffffffff;
        foreach (var value in tag.Concat(data)) { crc ^= value; for (var bit = 0; bit < 8; bit++) crc = (crc >> 1) ^ ((crc & 1) == 0 ? 0 : 0xedb88320); }
        Put(count, 0, crc ^ 0xffffffff); stream.Write(count);
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct OpenFile
    {
        public int Size; public nint Owner, Instance; public string? Filter, CustomFilter; public int MaxCustomFilter, FilterIndex; public nint File; public int MaxFile; public nint FileTitle; public int MaxFileTitle; public string? InitialDirectory, Title; public uint Flags; public ushort FileOffset, FileExtension; public string? DefaultExtension; public nint CustomData, Hook; public string? Template; public nint Reserved; public uint Reserved2, FlagsEx;
    }
    [DllImport("comdlg32.dll", CharSet = CharSet.Unicode)] private static extern bool GetOpenFileNameW(ref OpenFile info);
    [DllImport("comdlg32.dll")] private static extern uint CommDlgExtendedError();
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct BrowseInfo { public nint Owner, Root, DisplayName; public string Title; public uint Flags; public nint Callback, Parameter; public int Image; }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] private static extern nint SHBrowseForFolderW(ref BrowseInfo info);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] private static extern bool SHGetPathFromIDListW(nint item, StringBuilder path);
    [DllImport("ole32.dll")] private static extern void CoTaskMemFree(nint memory);
    [DllImport("ole32.dll")] private static extern int CoInitializeEx(nint reserved, uint flags);
    [DllImport("ole32.dll")] private static extern void CoUninitialize();
    private static Task<string[]> Dialog(Func<string[]> action)
    {
        var completion = new TaskCompletionSource<string[]>(TaskCreationOptions.RunContinuationsAsynchronously);
        var thread = new Thread(() => { var initialized = CoInitializeEx(0, 2) >= 0; try { completion.SetResult(action()); } catch (Exception error) { completion.SetException(error); } finally { if (initialized) CoUninitialize(); } });
        thread.SetApartmentState(ApartmentState.STA); thread.IsBackground = true; thread.Start(); return completion.Task;
    }
    internal static Task<string[]> ChooseFiles() => Dialog(() =>
    {
        var buffer = Marshal.AllocHGlobal(65536); try
        {
            Marshal.WriteInt16(buffer, 0); var info = new OpenFile { Size = Marshal.SizeOf<OpenFile>(), File = buffer, MaxFile = 32768, Title = "Pi Desktop — файлы клиентского ПК", Flags = 0x80000 | 0x1000 | 0x200 | 8 };
            if (!GetOpenFileNameW(ref info)) { if (CommDlgExtendedError() != 0) throw new Exception("Не удалось открыть выбор файлов"); return Array.Empty<string>(); }
            var parts = new List<string>(); var offset = 0;
            while (offset < 32768) { var value = Marshal.PtrToStringUni(buffer + offset * 2)!; if (value.Length == 0) break; parts.Add(value); offset += value.Length + 1; }
            return parts.Count <= 1 ? parts.ToArray() : parts.Skip(1).Select(name => Path.Combine(parts[0], name)).ToArray();
        }
        finally { Marshal.FreeHGlobal(buffer); }
    });
    internal static Task<string[]> ChooseFolders() => Dialog(() =>
    {
        var display = Marshal.AllocHGlobal(520);
        try { var info = new BrowseInfo { DisplayName = display, Title = "Pi Desktop — папка клиентского ПК", Flags = 1 | 0x40 }; var item = SHBrowseForFolderW(ref info); if (item == 0) return Array.Empty<string>(); try { var buffer = new StringBuilder(260); if (!SHGetPathFromIDListW(item, buffer)) throw new Exception("Нужна файловая папка"); return new[] { buffer.ToString() }; } finally { CoTaskMemFree(item); } }
        finally { Marshal.FreeHGlobal(display); }
    });
}
