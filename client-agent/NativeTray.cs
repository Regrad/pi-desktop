using System.Runtime.InteropServices;

/** One native notification icon; no Electron, WinForms or hidden background service. */
internal sealed class NativeTray : IDisposable
{
    private readonly Thread thread;
    private readonly Action stop;
    private readonly string caption;
    private readonly ManualResetEventSlim ready = new();
    private nint window;
    private readonly WindowProcedure procedure;
    private delegate nint WindowProcedure(nint window, uint message, nuint wParam, nint lParam);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct WindowClass { public uint Style; public WindowProcedure Procedure; public int ClassExtra, WindowExtra; public nint Instance, Icon, Cursor, Background; public string? Menu; public string ClassName; }
    [StructLayout(LayoutKind.Sequential)] private struct Msg { public nint Window; public uint Message; public nuint WParam; public nint LParam; public uint Time; public int X, Y; public uint Private; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct IconData { public uint Size; public nint Window; public uint Id, Flags, Callback; public nint Icon; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Tip; public uint State, StateMask; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string Info; public uint Version; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string Title; public uint InfoFlags; public Guid Guid; public nint BalloonIcon; }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern ushort RegisterClassW(ref WindowClass value);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool UnregisterClassW(string name, nint instance);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern nint CreateWindowExW(uint ex, string cls, string title, uint style, int x, int y, int w, int h, nint parent, nint menu, nint instance, nint parameter);
    [DllImport("user32.dll")] private static extern nint DefWindowProcW(nint window, uint message, nuint wParam, nint lParam);
    [DllImport("user32.dll")] private static extern int GetMessageW(out Msg message, nint window, uint min, uint max);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref Msg message);
    [DllImport("user32.dll")] private static extern nint DispatchMessageW(ref Msg message);
    [DllImport("user32.dll")] private static extern bool DestroyWindow(nint window);
    [DllImport("user32.dll")] private static extern void PostQuitMessage(int code);
    [DllImport("user32.dll")] private static extern bool PostMessageW(nint window, uint message, nuint wParam, nint lParam);
    [DllImport("user32.dll")] private static extern nint LoadIconW(nint instance, nint name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern nint GetModuleHandleW(string? name);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] private static extern bool Shell_NotifyIconW(uint message, ref IconData data);
    internal NativeTray(Action disconnect, string title)
    {
        stop = disconnect; caption = title; procedure = Handle;
        thread = new Thread(Run) { IsBackground = true }; thread.Start(); ready.Wait();
        if (window == 0) throw new Exception("Не удалось показать значок помощника; управление не включено");
    }
    private nint Handle(nint hwnd, uint message, nuint wParam, nint lParam)
    {
        if (message == 0x8010 && ((uint)lParam == 0x205 || (uint)lParam == 0x203))
        {
            if (NativeWindows.Confirm("Отключить управление этого ПК? Текущие операции будут отменены, уже сделанные изменения останутся.")) { stop(); PostMessageW(hwnd, 0x10, 0, 0); }
            return 0;
        }
        if (message == 0x10) { DestroyWindow(hwnd); return 0; }
        if (message == 2) { PostQuitMessage(0); return 0; }
        return DefWindowProcW(hwnd, message, wParam, lParam);
    }
    private void Run()
    {
        var name = "PiDesktopAgentTray-" + Guid.NewGuid().ToString("N"); var data = new IconData();
        var instance = GetModuleHandleW(null);
        try
        {
            var cls = new WindowClass { Procedure = procedure, ClassName = name, Instance = instance };
            if (RegisterClassW(ref cls) == 0) return;
            window = CreateWindowExW(0, name, caption, 0, 0, 0, 0, 0, 0, 0, instance, 0);
            if (window == 0) return;
            data = new IconData { Size = (uint)Marshal.SizeOf<IconData>(), Window = window, Id = 1, Flags = 1 | 2 | 4, Callback = 0x8010, Icon = LoadIconW(0, 32512), Tip = caption[..Math.Min(caption.Length, 100)] + " — правый клик: отключить", Info = "", Title = "" };
            if (!Shell_NotifyIconW(0, ref data)) { DestroyWindow(window); window = 0; return; }
            ready.Set();
            while (GetMessageW(out var msg, 0, 0, 0) > 0) { TranslateMessage(ref msg); DispatchMessageW(ref msg); }
        }
        finally { if (data.Window != 0) Shell_NotifyIconW(2, ref data); UnregisterClassW(name, instance); ready.Set(); }
    }
    public void Dispose() { if (window != 0) PostMessageW(window, 0x10, 0, 0); thread.Join(TimeSpan.FromSeconds(3)); }
}
