// glimpse-audio.exe - WASAPI audio capture helper for Glimpse instant replay.
//
// Build:  npm run build:audio   (csc.exe from .NET Framework 4, C# 5, x64)
//
// All audio is emitted as 48000 Hz, 2 channel, 32-bit float little-endian interleaved
// (ffmpeg input options: -f f32le -ar 48000 -ac 2 -i \\.\pipe\<name>).
//
// CLI
//   glimpse-audio.exe --list
//       Prints one JSON object and exits:
//       {"render":[{"id","name","default"}],"capture":[...],"sessions":[{"pid","exe","title","name"}]}
//
//   glimpse-audio.exe --outputs
//       Prints one JSON line and exits: DXGI outputs of the default adapter, indexed exactly like
//       ffmpeg ddagrab's output_idx, plus all adapters:
//       {"adapter":"...","outputs":[{"index","device","x","y","w","h","attached"}],"adapters":[{"index","name"}]}
//       (x/y/w/h = DesktopCoordinates in physical pixels)
//
//   glimpse-audio.exe [--levels] --source <spec> --pipe <name> [--ptt <vk>] [--source ... --pipe ...]
//       Capture mode. One named pipe server \\.\pipe\<name> per source (output only).
//       Prints {"ready":true} once every pipe exists; ffmpeg can then open the pipes as inputs.
//       Each pipe's timeline starts when its client connects and is clocked to wall time:
//       silence is padded whenever the source has no data. Exits with code 0 once every pipe
//       client has disconnected.
//
//   glimpse-audio.exe --meter --source <spec> [--ptt <vk>] [--source ...]
//       No pipes; prints level lines only (for settings UI meters).
//
//   Source specs:
//     system               loopback of the default render device (follows default changes)
//     system:<deviceId>    loopback of a specific render device
//     app:<exe>[,<exe>]    process-tree loopback of the named apps (summed); silence while not running
//     except:<exe>         everything except that app's process tree (plain system loopback while
//                          the app is not running)
//     mic                  default capture device (follows default changes)
//     mic:<deviceId>       specific capture device
//   --ptt <vk>   push-to-talk for the preceding source: decimal Win32 virtual-key code.
//   --levels     also print {"levels":[dB0,dB1,...]} (peak dBFS per source, -100 = silence) ~every 50 ms.
//
//   stdin commands (one per line): quit | mute <sourceIndex> 1|0
//   The process exits when stdin closes, so the parent must keep stdin as an open pipe.
//   stdout carries JSON lines only; diagnostics go to stderr.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace GlimpseAudio
{
    // ------------------------------------------------------------------ COM interop

    [StructLayout(LayoutKind.Sequential)]
    public struct PROPERTYKEY
    {
        public Guid fmtid;
        public int pid;
        public PROPERTYKEY(Guid g, int p) { fmtid = g; pid = p; }
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    public class MMDeviceEnumeratorCom { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDeviceCollection
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int Item(uint index, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        [PreserveSig] int OpenPropertyStore(int access, out IPropertyStore store);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out int state);
    }

    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPropertyStore
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetAt(int index, out PROPERTYKEY key);
        [PreserveSig] int GetValue(ref PROPERTYKEY key, IntPtr pv);
        [PreserveSig] int SetValue(ref PROPERTYKEY key, IntPtr pv);
        [PreserveSig] int Commit();
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
        [PreserveSig] int GetBufferSize(out uint frames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint padding);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr handle);
        [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
        [PreserveSig] int ReleaseBuffer(uint frames);
        [PreserveSig] int GetNextPacketSize(out uint frames);
    }

    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioSessionManager2
    {
        [PreserveSig] int GetAudioSessionControl(IntPtr sessionGuid, int flags, out IntPtr control);
        [PreserveSig] int GetSimpleAudioVolume(IntPtr sessionGuid, int flags, out IntPtr volume);
        [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessionEnum);
    }

    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioSessionEnumerator
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetSession(int index, [MarshalAs(UnmanagedType.IUnknown)] out object session);
    }

    [ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioSessionControl2
    {
        // IAudioSessionControl
        [PreserveSig] int GetState(out int state);
        [PreserveSig] int GetDisplayName(out IntPtr name);
        [PreserveSig] int SetDisplayName(IntPtr name, IntPtr eventContext);
        [PreserveSig] int GetIconPath(out IntPtr path);
        [PreserveSig] int SetIconPath(IntPtr path, IntPtr eventContext);
        [PreserveSig] int GetGroupingParam(out Guid groupingParam);
        [PreserveSig] int SetGroupingParam(IntPtr groupingParam, IntPtr eventContext);
        [PreserveSig] int RegisterAudioSessionNotification(IntPtr client);
        [PreserveSig] int UnregisterAudioSessionNotification(IntPtr client);
        // IAudioSessionControl2
        [PreserveSig] int GetSessionIdentifier(out IntPtr id);
        [PreserveSig] int GetSessionInstanceIdentifier(out IntPtr id);
        [PreserveSig] int GetProcessId(out uint pid);
        [PreserveSig] int IsSystemSoundsSession();
    }

    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IActivateAudioInterfaceAsyncOperation
    {
        [PreserveSig] int GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
    }

    [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IActivateAudioInterfaceCompletionHandler
    {
        [PreserveSig] int ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation);
    }

    [ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAgileObject { }

    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    public class ActivationHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject
    {
        public readonly ManualResetEvent Done = new ManualResetEvent(false);
        public volatile int Hr = unchecked((int)0x80004005);
        public object Result;

        public int ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation)
        {
            try
            {
                int activateHr;
                object iface;
                int hr = operation.GetActivateResult(out activateHr, out iface);
                Result = iface;
                Hr = hr < 0 ? hr : activateHr;
            }
            catch (Exception e)
            {
                Hr = Marshal.GetHRForException(e);
            }
            Done.Set();
            return 0;
        }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct PROCESSENTRY32W
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }

    // ------------------------------------------------------------------ DXGI (for --outputs)

    [ComImport, Guid("770aae78-f26f-4dba-a829-253c83d1b387"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IDXGIFactory1
    {
        // IDXGIObject
        [PreserveSig] int SetPrivateData(IntPtr guid, uint size, IntPtr data);
        [PreserveSig] int SetPrivateDataInterface(IntPtr guid, IntPtr unknown);
        [PreserveSig] int GetPrivateData(IntPtr guid, IntPtr size, IntPtr data);
        [PreserveSig] int GetParent(IntPtr riid, IntPtr parent);
        // IDXGIFactory
        [PreserveSig] int EnumAdapters(uint index, out IntPtr adapter);
        [PreserveSig] int MakeWindowAssociation(IntPtr hwnd, uint flags);
        [PreserveSig] int GetWindowAssociation(out IntPtr hwnd);
        [PreserveSig] int CreateSwapChain(IntPtr device, IntPtr desc, out IntPtr swapChain);
        [PreserveSig] int CreateSoftwareAdapter(IntPtr module, out IntPtr adapter);
        // IDXGIFactory1
        [PreserveSig] int EnumAdapters1(uint index, out IDXGIAdapter1 adapter);
        [PreserveSig] int IsCurrent();
    }

    [ComImport, Guid("29038f61-3839-4626-91fd-086879011a05"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IDXGIAdapter1
    {
        // IDXGIObject
        [PreserveSig] int SetPrivateData(IntPtr guid, uint size, IntPtr data);
        [PreserveSig] int SetPrivateDataInterface(IntPtr guid, IntPtr unknown);
        [PreserveSig] int GetPrivateData(IntPtr guid, IntPtr size, IntPtr data);
        [PreserveSig] int GetParent(IntPtr riid, IntPtr parent);
        // IDXGIAdapter
        [PreserveSig] int EnumOutputs(uint index, out IDXGIOutput output);
        [PreserveSig] int GetDesc(IntPtr desc);
        [PreserveSig] int CheckInterfaceSupport(IntPtr guid, out long umdVersion);
        // IDXGIAdapter1
        [PreserveSig] int GetDesc1(IntPtr desc);
    }

    [ComImport, Guid("ae02eedb-c735-4690-8d52-5a8dc20213aa"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IDXGIOutput
    {
        // IDXGIObject
        [PreserveSig] int SetPrivateData(IntPtr guid, uint size, IntPtr data);
        [PreserveSig] int SetPrivateDataInterface(IntPtr guid, IntPtr unknown);
        [PreserveSig] int GetPrivateData(IntPtr guid, IntPtr size, IntPtr data);
        [PreserveSig] int GetParent(IntPtr riid, IntPtr parent);
        // IDXGIOutput
        [PreserveSig] int GetDesc(IntPtr desc);
    }

    public static class Dxgi
    {
        const int DXGI_ERROR_NOT_FOUND = unchecked((int)0x887A0002);

        [DllImport("dxgi.dll", PreserveSig = true)]
        static extern int CreateDXGIFactory1([MarshalAs(UnmanagedType.LPStruct)] Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object factory);

        // Lists outputs of adapter 0 in the same order ffmpeg's ddagrab output_idx uses
        // (D3D11CreateDevice(NULL adapter) picks adapter 0, then IDXGIAdapter::EnumOutputs(output_idx)).
        public static int PrintOutputs()
        {
            object fo;
            Wasapi.Check(CreateDXGIFactory1(new Guid("770aae78-f26f-4dba-a829-253c83d1b387"), out fo), "CreateDXGIFactory1");
            IDXGIFactory1 factory = (IDXGIFactory1)fo;
            IntPtr desc = Marshal.AllocHGlobal(512);
            try
            {
                StringBuilder adapters = new StringBuilder();
                StringBuilder outputs = new StringBuilder();
                string adapter0 = "";
                for (uint a = 0; ; a++)
                {
                    IDXGIAdapter1 adapter;
                    int hr = factory.EnumAdapters1(a, out adapter);
                    if (hr == DXGI_ERROR_NOT_FOUND || adapter == null) break;
                    Wasapi.Check(hr, "EnumAdapters1");
                    // DXGI_ADAPTER_DESC1: WCHAR Description[128] at offset 0
                    string name = "";
                    if (adapter.GetDesc1(desc) >= 0) name = Marshal.PtrToStringUni(desc, 128).TrimEnd('\0');
                    if (adapters.Length > 0) adapters.Append(',');
                    adapters.Append("{\"index\":").Append(a.ToString(CultureInfo.InvariantCulture))
                            .Append(",\"name\":").Append(Program.Json(name)).Append('}');
                    if (a == 0)
                    {
                        adapter0 = name;
                        for (uint o = 0; ; o++)
                        {
                            IDXGIOutput output;
                            int ohr = adapter.EnumOutputs(o, out output);
                            if (ohr == DXGI_ERROR_NOT_FOUND || output == null) break;
                            Wasapi.Check(ohr, "EnumOutputs");
                            // DXGI_OUTPUT_DESC: WCHAR DeviceName[32]; RECT DesktopCoordinates @64; BOOL AttachedToDesktop @80
                            Wasapi.Check(output.GetDesc(desc), "IDXGIOutput.GetDesc");
                            string dev = Marshal.PtrToStringUni(desc, 32).TrimEnd('\0');
                            int left = Marshal.ReadInt32(desc, 64), top = Marshal.ReadInt32(desc, 68);
                            int right = Marshal.ReadInt32(desc, 72), bottom = Marshal.ReadInt32(desc, 76);
                            bool attached = Marshal.ReadInt32(desc, 80) != 0;
                            if (outputs.Length > 0) outputs.Append(',');
                            outputs.Append("{\"index\":").Append(o.ToString(CultureInfo.InvariantCulture))
                                   .Append(",\"device\":").Append(Program.Json(dev))
                                   .Append(",\"x\":").Append(left.ToString(CultureInfo.InvariantCulture))
                                   .Append(",\"y\":").Append(top.ToString(CultureInfo.InvariantCulture))
                                   .Append(",\"w\":").Append((right - left).ToString(CultureInfo.InvariantCulture))
                                   .Append(",\"h\":").Append((bottom - top).ToString(CultureInfo.InvariantCulture))
                                   .Append(",\"attached\":").Append(attached ? "true" : "false").Append('}');
                            Marshal.ReleaseComObject(output);
                        }
                    }
                    Marshal.ReleaseComObject(adapter);
                }
                Program.Emit("{\"adapter\":" + Program.Json(adapter0) + ",\"outputs\":[" + outputs + "],\"adapters\":[" + adapters + "]}");
                return 0;
            }
            finally
            {
                Marshal.FreeHGlobal(desc);
                Marshal.ReleaseComObject(factory);
            }
        }
    }

    public static class Native
    {
        [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = true)]
        public static extern int ActivateAudioInterfaceAsync(
            [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
            [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
            IntPtr activationParams,
            IActivateAudioInterfaceCompletionHandler completionHandler,
            out IActivateAudioInterfaceAsyncOperation activationOperation);

        [DllImport("ole32.dll")] public static extern int PropVariantClear(IntPtr pvar);
        [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
        [DllImport("winmm.dll")] public static extern uint timeBeginPeriod(uint period);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "Process32FirstW", SetLastError = true)]
        public static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32W entry);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "Process32NextW", SetLastError = true)]
        public static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32W entry);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(int access, bool inherit, int pid);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "QueryFullProcessImageNameW", SetLastError = true)]
        public static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder name, ref int size);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr handle);
    }

    // ------------------------------------------------------------------ WASAPI helpers

    public static class Wasapi
    {
        public const int eRender = 0, eCapture = 1, eConsole = 0;
        public const int DEVICE_STATE_ACTIVE = 1;
        public const int CLSCTX_ALL = 23;
        public const uint STREAMFLAGS_LOOPBACK = 0x00020000;
        public const uint STREAMFLAGS_EVENTCALLBACK = 0x00040000;
        public const uint STREAMFLAGS_AUTOCONVERTPCM = 0x80000000;
        public const uint STREAMFLAGS_SRC_DEFAULT_QUALITY = 0x08000000;
        public const uint BUFFERFLAGS_DATA_DISCONTINUITY = 0x1;
        public const uint BUFFERFLAGS_SILENT = 0x2;
        public const int S_BUFFER_EMPTY = 0x08890001;
        public const int E_DEVICE_INVALIDATED = unchecked((int)0x88890004);
        public static Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
        public static Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
        public static Guid IID_IAudioSessionManager2 = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
        public static PROPERTYKEY PKEY_Device_FriendlyName = new PROPERTYKEY(new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), 14);

        public static void Check(int hr, string what)
        {
            if (hr < 0) throw new COMException(what + " failed: 0x" + hr.ToString("X8") + (hr == E_DEVICE_INVALIDATED ? " (device invalidated)" : ""), hr);
        }

        public static IMMDeviceEnumerator NewEnumerator()
        {
            return (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
        }

        public static string DefaultId(IMMDeviceEnumerator en, int flow)
        {
            IMMDevice dev;
            if (en.GetDefaultAudioEndpoint(flow, eConsole, out dev) < 0 || dev == null) return null;
            string id;
            int hr = dev.GetId(out id);
            Marshal.ReleaseComObject(dev);
            return hr < 0 ? null : id;
        }

        public static string FriendlyName(IMMDevice dev)
        {
            IPropertyStore store;
            if (dev.OpenPropertyStore(0, out store) < 0 || store == null) return "";
            IntPtr pv = Marshal.AllocHGlobal(24);
            try
            {
                for (int i = 0; i < 24; i += 8) Marshal.WriteInt64(pv, i, 0);
                PROPERTYKEY key = PKEY_Device_FriendlyName;
                if (store.GetValue(ref key, pv) < 0) return "";
                string s = "";
                short vt = Marshal.ReadInt16(pv, 0);
                if (vt == 31) s = Marshal.PtrToStringUni(Marshal.ReadIntPtr(pv, 8)) ?? "";
                Native.PropVariantClear(pv);
                return s;
            }
            finally
            {
                Marshal.FreeHGlobal(pv);
                Marshal.ReleaseComObject(store);
            }
        }

        // WAVEFORMATEX, 48 kHz stereo, float32 or pcm16
        public static IntPtr MakeFormat(bool isFloat)
        {
            IntPtr f = Marshal.AllocHGlobal(18);
            short bits = (short)(isFloat ? 32 : 16);
            short block = (short)(2 * bits / 8);
            Marshal.WriteInt16(f, 0, (short)(isFloat ? 3 : 1));
            Marshal.WriteInt16(f, 2, 2);
            Marshal.WriteInt32(f, 4, 48000);
            Marshal.WriteInt32(f, 8, 48000 * block);
            Marshal.WriteInt16(f, 12, block);
            Marshal.WriteInt16(f, 14, bits);
            Marshal.WriteInt16(f, 16, 0);
            return f;
        }

        // Process loopback activation (Windows 10 2004+). mode 0 = include tree, 1 = exclude tree.
        public static IAudioClient ActivateProcessLoopback(int pid, int mode)
        {
            IntPtr prm = Marshal.AllocHGlobal(12);
            IntPtr pv = Marshal.AllocHGlobal(24);
            bool canFree = true;
            try
            {
                Marshal.WriteInt32(prm, 0, 1);    // AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
                Marshal.WriteInt32(prm, 4, pid);  // TargetProcessId
                Marshal.WriteInt32(prm, 8, mode); // ProcessLoopbackMode
                for (int i = 0; i < 24; i += 8) Marshal.WriteInt64(pv, i, 0);
                Marshal.WriteInt16(pv, 0, 65);    // VT_BLOB
                Marshal.WriteInt32(pv, 8, 12);    // blob.cbSize
                Marshal.WriteIntPtr(pv, 16, prm); // blob.pBlobData
                ActivationHandler handler = new ActivationHandler();
                IActivateAudioInterfaceAsyncOperation op;
                int hr = Native.ActivateAudioInterfaceAsync(@"VAD\Process_Loopback", IID_IAudioClient, pv, handler, out op);
                Check(hr, "ActivateAudioInterfaceAsync");
                if (!handler.Done.WaitOne(5000))
                {
                    canFree = false;
                    throw new TimeoutException("process loopback activation timed out");
                }
                if (op != null) Marshal.ReleaseComObject(op);
                Check(handler.Hr, "process loopback activation (pid " + pid + ")");
                IAudioClient client = handler.Result as IAudioClient;
                if (client == null) throw new InvalidOperationException("process loopback activation returned no IAudioClient");
                return client;
            }
            finally
            {
                if (canFree)
                {
                    Marshal.FreeHGlobal(pv);
                    Marshal.FreeHGlobal(prm);
                }
            }
        }
    }

    // ------------------------------------------------------------------ process helpers

    public class ProcInfo
    {
        public int Pid;
        public int ParentPid;
        public string Exe;
    }

    public static class Procs
    {
        public static List<ProcInfo> Snapshot()
        {
            List<ProcInfo> list = new List<ProcInfo>();
            IntPtr snap = Native.CreateToolhelp32Snapshot(2, 0); // TH32CS_SNAPPROCESS
            if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return list;
            try
            {
                PROCESSENTRY32W e = new PROCESSENTRY32W();
                e.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
                if (!Native.Process32First(snap, ref e)) return list;
                do
                {
                    ProcInfo p = new ProcInfo();
                    p.Pid = (int)e.th32ProcessID;
                    p.ParentPid = (int)e.th32ParentProcessID;
                    p.Exe = e.szExeFile ?? "";
                    list.Add(p);
                } while (Native.Process32Next(snap, ref e));
            }
            finally { Native.CloseHandle(snap); }
            return list;
        }

        // Root processes of the given exe names: matching processes whose parent is not the same exe.
        public static List<int> FindRoots(List<string> exes)
        {
            List<ProcInfo> all = Snapshot();
            Dictionary<int, string> byPid = new Dictionary<int, string>();
            foreach (ProcInfo p in all) byPid[p.Pid] = p.Exe;
            List<int> roots = new List<int>();
            int self = Process.GetCurrentProcess().Id;
            foreach (ProcInfo p in all)
            {
                if (p.Pid == 0 || p.Pid == self) continue;
                bool match = false;
                foreach (string x in exes) if (string.Equals(p.Exe, x, StringComparison.OrdinalIgnoreCase)) { match = true; break; }
                if (!match) continue;
                string parentExe;
                if (p.ParentPid != 0 && byPid.TryGetValue(p.ParentPid, out parentExe) &&
                    string.Equals(parentExe, p.Exe, StringComparison.OrdinalIgnoreCase)) continue;
                roots.Add(p.Pid);
            }
            roots.Sort();
            return roots;
        }

        public static string ImagePath(int pid)
        {
            IntPtr h = Native.OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
            if (h == IntPtr.Zero) return null;
            try
            {
                StringBuilder sb = new StringBuilder(1024);
                int size = sb.Capacity;
                return Native.QueryFullProcessImageName(h, 0, sb, ref size) ? sb.ToString(0, size) : null;
            }
            finally { Native.CloseHandle(h); }
        }
    }

    // ------------------------------------------------------------------ ring buffer (stereo float frames)

    public class Ring
    {
        const int PREBUFFER = 960;     // 20 ms: hold onset data until this much is queued (absorbs tick/packet jitter)
        const int MAX_BACKLOG = 4800;  // 100 ms: beyond this, drop oldest ...
        const int TRIM_TO = 960;       // ... down to 20 ms
        readonly float[] buf;
        readonly int cap;
        int head, count;
        bool playing;
        long lastWrite;
        readonly object lk = new object();

        public Ring(int capFrames) { cap = capFrames; buf = new float[capFrames * 2]; }

        void MakeRoom(int frames)
        {
            if (count + frames > cap)
            {
                int drop = count + frames - cap;
                head = (head + drop) % cap;
                count -= drop;
            }
        }

        public void Write(float[] src, int frames)
        {
            lock (lk)
            {
                int off = 0;
                if (frames > cap) { off = frames - cap; frames = cap; }
                MakeRoom(frames);
                int tail = (head + count) % cap;
                int first = Math.Min(frames, cap - tail);
                Array.Copy(src, off * 2, buf, tail * 2, first * 2);
                if (frames > first) Array.Copy(src, (off + first) * 2, buf, 0, (frames - first) * 2);
                count += frames;
                lastWrite = Program.Sw.ElapsedTicks;
            }
        }

        public void WriteSilence(int frames)
        {
            lock (lk)
            {
                if (frames > cap) frames = cap;
                MakeRoom(frames);
                int tail = (head + count) % cap;
                int first = Math.Min(frames, cap - tail);
                Array.Clear(buf, tail * 2, first * 2);
                if (frames > first) Array.Clear(buf, 0, (frames - first) * 2);
                count += frames;
                lastWrite = Program.Sw.ElapsedTicks;
            }
        }

        // Adds up to `frames` frames into dst (missing frames contribute nothing = silence).
        public void ReadAdd(float[] dst, int frames)
        {
            lock (lk)
            {
                if (count == 0) { playing = false; return; }
                if (!playing)
                {
                    bool stale = Program.Sw.ElapsedTicks - lastWrite > Stopwatch.Frequency * 30 / 1000;
                    if (count >= PREBUFFER || stale) playing = true;
                    else return;
                }
                if (count - frames > MAX_BACKLOG)
                {
                    int drop = count - frames - TRIM_TO;
                    head = (head + drop) % cap;
                    count -= drop;
                }
                int n = Math.Min(frames, count);
                int pos = head * 2;
                int total = n * 2;
                int capS = cap * 2;
                for (int i = 0; i < total; i++)
                {
                    dst[i] += buf[pos];
                    pos++;
                    if (pos == capS) pos = 0;
                }
                head = (head + n) % cap;
                count -= n;
                if (n < frames) playing = false;
            }
        }
    }

    // ------------------------------------------------------------------ one WASAPI client on its own thread

    public class Capture
    {
        public readonly string Key;   // "loop|<deviceId>", "cap|<deviceId>", "proc|<pid>|<mode>"
        public readonly Ring Ring = new Ring(48000);
        public volatile bool Failed;
        public volatile string Error;
        public long StartedMs;
        volatile bool stop;
        Thread th;

        public Capture(string key) { Key = key; }

        public void Start()
        {
            StartedMs = Program.NowMs();
            th = new Thread(Run);
            th.IsBackground = true;
            th.Priority = ThreadPriority.Highest;
            th.SetApartmentState(ApartmentState.MTA);
            th.Start();
        }

        public void Stop() { stop = true; }

        IAudioClient Activate(IMMDeviceEnumerator en)
        {
            string[] parts = Key.Split('|');
            if (parts[0] == "proc")
                return Wasapi.ActivateProcessLoopback(int.Parse(parts[1], CultureInfo.InvariantCulture), int.Parse(parts[2], CultureInfo.InvariantCulture));
            IMMDevice dev;
            Wasapi.Check(en.GetDevice(parts[1], out dev), "GetDevice");
            try
            {
                Guid iid = Wasapi.IID_IAudioClient;
                object o;
                Wasapi.Check(dev.Activate(ref iid, Wasapi.CLSCTX_ALL, IntPtr.Zero, out o), "IMMDevice.Activate");
                return (IAudioClient)o;
            }
            finally { Marshal.ReleaseComObject(dev); }
        }

        IAudioClient Open(IMMDeviceEnumerator en, out bool isFloat)
        {
            bool loop = !Key.StartsWith("cap|");
            uint flags = Wasapi.STREAMFLAGS_EVENTCALLBACK | Wasapi.STREAMFLAGS_AUTOCONVERTPCM | Wasapi.STREAMFLAGS_SRC_DEFAULT_QUALITY;
            if (loop) flags |= Wasapi.STREAMFLAGS_LOOPBACK;
            int lastHr = 0;
            for (int attempt = 0; attempt < 2; attempt++)
            {
                bool fl = attempt == 0;
                IAudioClient c = Activate(en);
                IntPtr fmt = Wasapi.MakeFormat(fl);
                int hr;
                try { hr = c.Initialize(0, flags, 2000000, 0, fmt, IntPtr.Zero); }
                finally { Marshal.FreeHGlobal(fmt); }
                if (hr >= 0) { isFloat = fl; return c; }
                lastHr = hr;
                Marshal.ReleaseComObject(c);
                if (fl) Program.Log(Key + ": float init failed 0x" + hr.ToString("X8") + ", trying pcm16");
            }
            Wasapi.Check(lastHr, "IAudioClient.Initialize");
            isFloat = false;
            return null;
        }

        void Run()
        {
            IAudioClient client = null;
            IAudioCaptureClient cc = null;
            IMMDeviceEnumerator en = null;
            AutoResetEvent ev = new AutoResetEvent(false);
            try
            {
                if (!Key.StartsWith("proc|")) en = Wasapi.NewEnumerator();
                bool isFloat;
                client = Open(en, out isFloat);
                Wasapi.Check(client.SetEventHandle(ev.SafeWaitHandle.DangerousGetHandle()), "SetEventHandle");
                Guid iid = Wasapi.IID_IAudioCaptureClient;
                object o;
                Wasapi.Check(client.GetService(ref iid, out o), "GetService(IAudioCaptureClient)");
                cc = (IAudioCaptureClient)o;
                Wasapi.Check(client.Start(), "IAudioClient.Start");
                Program.Log("opened " + Key + (isFloat ? " (float32)" : " (pcm16)"));

                float[] fbuf = new float[48000 * 2];
                short[] sbuf = new short[48000 * 2];
                while (!stop)
                {
                    ev.WaitOne(20); // also poll on timeout in case events are not signalled
                    while (!stop)
                    {
                        uint packet;
                        Wasapi.Check(cc.GetNextPacketSize(out packet), "GetNextPacketSize");
                        if (packet == 0) break;
                        IntPtr data;
                        uint frames, bflags;
                        ulong p1, p2;
                        int hr = cc.GetBuffer(out data, out frames, out bflags, out p1, out p2);
                        Wasapi.Check(hr, "GetBuffer");
                        if (hr == Wasapi.S_BUFFER_EMPTY) break;
                        int n = (int)frames;
                        if (n > 0)
                        {
                            if ((bflags & Wasapi.BUFFERFLAGS_SILENT) != 0 || data == IntPtr.Zero)
                            {
                                Ring.WriteSilence(n);
                            }
                            else
                            {
                                if (fbuf.Length < n * 2) { fbuf = new float[n * 2]; sbuf = new short[n * 2]; }
                                if (isFloat)
                                {
                                    Marshal.Copy(data, fbuf, 0, n * 2);
                                }
                                else
                                {
                                    Marshal.Copy(data, sbuf, 0, n * 2);
                                    for (int i = 0; i < n * 2; i++) fbuf[i] = sbuf[i] / 32768f;
                                }
                                Ring.Write(fbuf, n);
                            }
                        }
                        Wasapi.Check(cc.ReleaseBuffer(frames), "ReleaseBuffer");
                    }
                }
            }
            catch (Exception e)
            {
                if (!stop)
                {
                    Error = e.Message;
                    Failed = true;
                }
            }
            finally
            {
                try { if (client != null) client.Stop(); } catch { }
                try { if (cc != null) Marshal.ReleaseComObject(cc); } catch { }
                try { if (client != null) Marshal.ReleaseComObject(client); } catch { }
                try { if (en != null) Marshal.ReleaseComObject(en); } catch { }
                ev.Close();
            }
        }
    }

    // ------------------------------------------------------------------ logical source (one per --source)

    public class Source
    {
        public int Index;
        public string Spec, Kind, DeviceId, PipeName;
        public List<string> Exes = new List<string>();
        public int PttVk;
        public volatile bool Muted;
        public bool PttOpen;
        public long PttLastHeld = long.MinValue / 2;
        public float PeakAcc;
        float gain = 1f;
        bool gainInit;
        readonly List<Capture> caps = new List<Capture>();
        readonly object capLock = new object();
        readonly Dictionary<string, string> lastErr = new Dictionary<string, string>();

        public static Source Parse(string spec, int index)
        {
            Source s = new Source();
            s.Index = index;
            s.Spec = spec;
            int c = spec.IndexOf(':');
            string kind = (c < 0 ? spec : spec.Substring(0, c)).ToLowerInvariant();
            string arg = c < 0 ? "" : spec.Substring(c + 1);
            s.Kind = kind;
            if (kind == "system" || kind == "mic")
            {
                s.DeviceId = arg.Length > 0 ? arg : null;
            }
            else if (kind == "app" || kind == "except")
            {
                foreach (string raw in arg.Split(','))
                {
                    string x = raw.Trim();
                    if (x.Length == 0) continue;
                    if (!x.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) x += ".exe";
                    s.Exes.Add(x);
                }
                if (s.Exes.Count == 0) throw new ArgumentException("source '" + spec + "' needs an exe name");
                if (kind == "except" && s.Exes.Count > 1) throw new ArgumentException("except: takes exactly one exe");
            }
            else throw new ArgumentException("unknown source spec '" + spec + "'");
            return s;
        }

        public void Start()
        {
            Thread t = new Thread(ControlLoop);
            t.IsBackground = true;
            t.SetApartmentState(ApartmentState.MTA);
            t.Start();
        }

        List<string> Desired(IMMDeviceEnumerator en)
        {
            List<string> keys = new List<string>();
            if (Kind == "system" || Kind == "mic")
            {
                string id = DeviceId ?? Wasapi.DefaultId(en, Kind == "mic" ? Wasapi.eCapture : Wasapi.eRender);
                if (id != null) keys.Add((Kind == "mic" ? "cap|" : "loop|") + id);
            }
            else if (Kind == "app")
            {
                foreach (int pid in Procs.FindRoots(Exes)) keys.Add("proc|" + pid + "|0");
            }
            else if (Kind == "except")
            {
                List<int> roots = Procs.FindRoots(Exes);
                if (roots.Count > 0) keys.Add("proc|" + roots[0] + "|1");
                else
                {
                    string id = Wasapi.DefaultId(en, Wasapi.eRender);
                    if (id != null) keys.Add("loop|" + id);
                }
            }
            return keys;
        }

        void ControlLoop()
        {
            IMMDeviceEnumerator en = null;
            try { en = Wasapi.NewEnumerator(); }
            catch (Exception e) { Program.Log("source " + Index + ": cannot create device enumerator: " + e.Message); return; }
            long lastEval = long.MinValue / 2;
            while (true)
            {
                long now = Program.NowMs();
                bool healthyFailed = false;
                lock (capLock)
                {
                    foreach (Capture c in caps)
                        if (c.Failed && now - c.StartedMs > 2000) healthyFailed = true;
                }
                if (now - lastEval >= 2000 || (healthyFailed && now - lastEval >= 300))
                {
                    lastEval = now;
                    List<string> desired;
                    try { desired = Desired(en); }
                    catch (Exception e) { Program.Log("source " + Index + ": " + e.Message); desired = new List<string>(); }
                    lock (capLock)
                    {
                        for (int i = caps.Count - 1; i >= 0; i--)
                        {
                            Capture c = caps[i];
                            if (c.Failed)
                            {
                                string prev;
                                if (!lastErr.TryGetValue(c.Key, out prev) || prev != c.Error)
                                    Program.Log("source " + Index + " (" + Spec + "): " + c.Key + ": " + c.Error);
                                lastErr[c.Key] = c.Error;
                            }
                            if (c.Failed || !desired.Contains(c.Key))
                            {
                                if (!c.Failed) Program.Log("source " + Index + ": closing " + c.Key);
                                c.Stop();
                                caps.RemoveAt(i);
                            }
                        }
                        foreach (string k in desired)
                        {
                            bool have = false;
                            foreach (Capture c in caps) if (c.Key == k) { have = true; break; }
                            if (have) continue;
                            Capture nc = new Capture(k);
                            caps.Add(nc);
                            nc.Start();
                        }
                    }
                }
                Thread.Sleep(100);
            }
        }

        // Called from the clock thread only. Produces exactly `frames` frames into dst.
        public void Pull(float[] dst, int frames)
        {
            Array.Clear(dst, 0, frames * 2);
            lock (capLock)
            {
                foreach (Capture c in caps) c.Ring.ReadAdd(dst, frames);
            }
            float target = (Muted || (PttVk != 0 && !PttOpen)) ? 0f : 1f;
            if (!gainInit) { gain = target; gainInit = true; }
            const float step = 1f / 240f; // 5 ms fade
            float g = gain, pk = PeakAcc;
            int total = frames * 2;
            for (int i = 0; i < total; i += 2)
            {
                if (g != target)
                {
                    if (g < target) { g += step; if (g > target) g = target; }
                    else { g -= step; if (g < target) g = target; }
                }
                float l = dst[i] * g, r = dst[i + 1] * g;
                dst[i] = l;
                dst[i + 1] = r;
                if (l < 0) l = -l;
                if (r < 0) r = -r;
                if (l > pk) pk = l;
                if (r > pk) pk = r;
            }
            gain = g;
            PeakAcc = pk;
        }
    }

    // ------------------------------------------------------------------ named pipe output with drop-oldest writer queue

    public class PipeOut
    {
        // Until the reader has taken 200 ms, keep at most 10 ms waiting: the stream then starts right when
        // ffmpeg starts reading, the same every time, so the sound lines up with the picture. After that,
        // allow a full second of backlog so a short stall never drops sound (which would shift sync).
        const int START_QUEUE_BYTES = 48000 * 8 * 10 / 1000;
        const int RUN_QUEUE_BYTES = 48000 * 8;
        const long STARTED_AFTER_BYTES = 48000 * 8 / 5;
        int MaxQueueBytes { get { return Interlocked.Read(ref WrittenBytes) < STARTED_AFTER_BYTES ? START_QUEUE_BYTES : RUN_QUEUE_BYTES; } }
        public readonly string Name;
        public long ConnectedTicks = -1;
        public volatile bool Dead;
        readonly NamedPipeServerStream ps;
        readonly Queue<byte[]> q = new Queue<byte[]>();
        int qBytes;
        public long DroppedBytes, WrittenBytes;
        readonly object lk = new object();

        public PipeOut(string name)
        {
            Name = name;
            ps = new NamedPipeServerStream(name, PipeDirection.Out, 1, PipeTransmissionMode.Byte, PipeOptions.None, 0, 2048); // small: little stale sound can sit in the pipe
        }

        public void Start()
        {
            Thread t = new Thread(Run);
            t.IsBackground = true;
            t.Priority = ThreadPriority.AboveNormal;
            t.Start();
        }

        public void Enqueue(byte[] b)
        {
            lock (lk)
            {
                q.Enqueue(b);
                qBytes += b.Length;
                int max = MaxQueueBytes;
                while (qBytes > max && q.Count > 1)
                {
                    byte[] d = q.Dequeue();
                    qBytes -= d.Length;
                    DroppedBytes += d.Length;
                }
                Monitor.Pulse(lk);
            }
        }

        void Run()
        {
            try
            {
                ps.WaitForConnection();
                lock (lk) { q.Clear(); qBytes = 0; }
                Interlocked.Exchange(ref ConnectedTicks, Program.Sw.ElapsedTicks);
                Program.Log("pipe " + Name + " connected");
                while (true)
                {
                    byte[] b;
                    lock (lk)
                    {
                        while (q.Count == 0) Monitor.Wait(lk);
                        b = q.Dequeue();
                        qBytes -= b.Length;
                    }
                    ps.Write(b, 0, b.Length);
                    Interlocked.Add(ref WrittenBytes, b.Length);
                }
            }
            catch (Exception e)
            {
                Program.Log("pipe " + Name + " closed: " + e.Message + " (wrote " + (WrittenBytes / 8 / 48000.0).ToString("0.000", CultureInfo.InvariantCulture) +
                    " s, dropped " + (Interlocked.Read(ref DroppedBytes) / 8 / 48000.0).ToString("0.000", CultureInfo.InvariantCulture) + " s while the reader was not keeping up)");
            }
            Dead = true;
            try { ps.Dispose(); } catch { }
            Program.OnPipeDead();
        }
    }

    public class Output
    {
        public Source Src;
        public PipeOut Pipe;
        public long BaseTicks;
        public long Produced;
        public bool Synced;
    }

    // ------------------------------------------------------------------ program

    public static class Program
    {
        public static readonly Stopwatch Sw = Stopwatch.StartNew();
        static readonly object outLock = new object();
        static StreamWriter stdout;
        static List<Source> sources = new List<Source>();
        static List<Output> outputs = new List<Output>();
        static List<PipeOut> pipes = new List<PipeOut>();
        static bool levels;

        public static long NowMs() { return Sw.ElapsedMilliseconds; }

        public static void Log(string msg)
        {
            lock (outLock)
            {
                try { Console.Error.WriteLine("[glimpse-audio " + (Sw.ElapsedMilliseconds / 1000.0).ToString("0.000", CultureInfo.InvariantCulture) + "] " + msg); Console.Error.Flush(); } catch { }
            }
        }

        public static void Emit(string json)
        {
            lock (outLock)
            {
                try { stdout.Write(json + "\n"); stdout.Flush(); } catch { }
            }
        }

        public static void Exit(int code)
        {
            lock (outLock)
            {
                try { stdout.Flush(); } catch { }
            }
            Environment.Exit(code);
        }

        public static void OnPipeDead()
        {
            foreach (PipeOut p in pipes) if (!p.Dead) return;
            Log("all pipes closed, exiting");
            Exit(0);
        }

        public static string Json(string s)
        {
            if (s == null) return "\"\"";
            StringBuilder sb = new StringBuilder(s.Length + 2);
            sb.Append('"');
            foreach (char ch in s)
            {
                switch (ch)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (ch < 0x20 || ch > 0x7e) sb.Append("\\u").Append(((int)ch).ToString("x4"));
                        else sb.Append(ch);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }

        [MTAThread]
        public static int Main(string[] args)
        {
            stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            stdout.AutoFlush = false;
            try
            {
                return Run(args);
            }
            catch (Exception e)
            {
                Log("fatal: " + e.Message);
                return 1;
            }
        }

        static int Run(string[] args)
        {
            bool list = false, meter = false;
            Source last = null;
            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i];
                Func<string> next = delegate
                {
                    if (i + 1 >= args.Length) throw new ArgumentException(a + " needs a value");
                    return args[++i];
                };
                switch (a)
                {
                    case "--list": list = true; break;
                    case "--outputs": return Dxgi.PrintOutputs();
                    case "--meter": meter = true; break;
                    case "--levels": levels = true; break;
                    case "--source":
                        last = Source.Parse(next(), sources.Count);
                        sources.Add(last);
                        break;
                    case "--pipe":
                        if (last == null) throw new ArgumentException("--pipe must follow --source");
                        last.PipeName = next();
                        break;
                    case "--ptt":
                        if (last == null) throw new ArgumentException("--ptt must follow --source");
                        last.PttVk = int.Parse(next(), CultureInfo.InvariantCulture);
                        break;
                    default:
                        throw new ArgumentException("unknown argument '" + a + "'");
                }
            }

            if (list) return DoList();
            if (sources.Count == 0)
            {
                Log("usage: glimpse-audio --list | [--levels] (--source <spec> --pipe <name>)+ | --meter (--source <spec>)+");
                return 2;
            }
            if (meter) levels = true;

            Native.timeBeginPeriod(1);

            // pipes first so a name clash fails before anything starts
            foreach (Source s in sources)
            {
                Output o = new Output();
                o.Src = s;
                if (!meter)
                {
                    if (string.IsNullOrEmpty(s.PipeName)) throw new ArgumentException("source '" + s.Spec + "' has no --pipe");
                    o.Pipe = new PipeOut(s.PipeName);
                    pipes.Add(o.Pipe);
                }
                outputs.Add(o);
            }
            foreach (Source s in sources) s.Start();
            foreach (PipeOut p in pipes) p.Start();

            Thread clock = new Thread(ClockLoop);
            clock.IsBackground = true;
            clock.Priority = ThreadPriority.Highest;
            clock.Start();

            if (!meter) Emit("{\"ready\":true}");

            StreamReader stdin = new StreamReader(Console.OpenStandardInput());
            while (true)
            {
                string line;
                try { line = stdin.ReadLine(); }
                catch { line = null; }
                if (line == null) { Log("stdin closed, exiting"); Exit(0); }
                string[] parts = line.Trim().Split(new char[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length == 0) continue;
                string cmd = parts[0].ToLowerInvariant();
                if (cmd == "quit") { Log("quit"); Exit(0); }
                else if (cmd == "mute" && parts.Length == 3)
                {
                    int idx;
                    if (int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out idx) && idx >= 0 && idx < sources.Count)
                        sources[idx].Muted = parts[2] == "1" || parts[2].ToLowerInvariant() == "true";
                    else Log("bad mute index: " + parts[1]);
                }
                else Log("unknown command: " + line);
            }
        }

        static void ClockLoop()
        {
            long freq = Stopwatch.Frequency;
            long pttTail = freq * 150 / 1000;
            long levelEvery = freq / 20;
            float[] buf = new float[48000 * 2];
            long lastLevels = Sw.ElapsedTicks;
            foreach (Output o in outputs) o.BaseTicks = lastLevels;
            while (true)
            {
                long now = Sw.ElapsedTicks;
                foreach (Source s in sources)
                {
                    if (s.PttVk == 0) continue;
                    bool held = (Native.GetAsyncKeyState(s.PttVk) & 0x8000) != 0;
                    if (held) s.PttLastHeld = now;
                    s.PttOpen = held || now - s.PttLastHeld < pttTail;
                }
                foreach (Output o in outputs)
                {
                    if (o.Pipe != null && !o.Synced)
                    {
                        long ct = Interlocked.Read(ref o.Pipe.ConnectedTicks);
                        if (ct >= 0) { o.BaseTicks = ct; o.Produced = 0; o.Synced = true; }
                    }
                    long target = (now - o.BaseTicks) * 48000 / freq;
                    long n = target - o.Produced;
                    while (n > 0)
                    {
                        int chunk = (int)Math.Min(n, 48000);
                        o.Src.Pull(buf, chunk);
                        if (o.Synced && !o.Pipe.Dead)
                        {
                            byte[] b = new byte[chunk * 8];
                            Buffer.BlockCopy(buf, 0, b, 0, chunk * 8);
                            o.Pipe.Enqueue(b);
                        }
                        o.Produced += chunk;
                        n -= chunk;
                    }
                }
                if (levels && now - lastLevels >= levelEvery)
                {
                    lastLevels = now;
                    StringBuilder sb = new StringBuilder("{\"levels\":[");
                    for (int i = 0; i < sources.Count; i++)
                    {
                        float pk = sources[i].PeakAcc;
                        sources[i].PeakAcc = 0;
                        double db = pk > 0.00001f ? 20.0 * Math.Log10(pk) : -100.0;
                        if (db < -100) db = -100;
                        if (i > 0) sb.Append(',');
                        sb.Append(db.ToString("0.0", CultureInfo.InvariantCulture));
                    }
                    sb.Append("]}");
                    Emit(sb.ToString());
                }
                Thread.Sleep(10);
            }
        }

        // ---------------------------------------------------------------- --list

        static int DoList()
        {
            IMMDeviceEnumerator en = Wasapi.NewEnumerator();
            StringBuilder sb = new StringBuilder();
            List<IMMDevice> renderDevs = new List<IMMDevice>();
            sb.Append("{\"render\":[");
            AppendDevices(sb, en, Wasapi.eRender, renderDevs);
            sb.Append("],\"capture\":[");
            AppendDevices(sb, en, Wasapi.eCapture, null);
            sb.Append("],\"sessions\":[");
            AppendSessions(sb, renderDevs);
            sb.Append("]}");
            Emit(sb.ToString());
            return 0;
        }

        static void AppendDevices(StringBuilder sb, IMMDeviceEnumerator en, int flow, List<IMMDevice> keep)
        {
            string def = Wasapi.DefaultId(en, flow);
            IMMDeviceCollection col;
            if (en.EnumAudioEndpoints(flow, Wasapi.DEVICE_STATE_ACTIVE, out col) < 0 || col == null) return;
            uint count;
            col.GetCount(out count);
            bool first = true;
            for (uint i = 0; i < count; i++)
            {
                IMMDevice dev;
                if (col.Item(i, out dev) < 0 || dev == null) continue;
                string id;
                if (dev.GetId(out id) < 0 || id == null) continue;
                string name = "";
                try { name = Wasapi.FriendlyName(dev); } catch { }
                if (!first) sb.Append(',');
                first = false;
                sb.Append("{\"id\":").Append(Json(id))
                  .Append(",\"name\":").Append(Json(name))
                  .Append(",\"default\":").Append(id == def ? "true" : "false").Append('}');
                if (keep != null) keep.Add(dev);
            }
        }

        static void AppendSessions(StringBuilder sb, List<IMMDevice> devs)
        {
            HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            bool first = true;
            foreach (IMMDevice dev in devs)
            {
                try
                {
                    Guid iid = Wasapi.IID_IAudioSessionManager2;
                    object o;
                    if (dev.Activate(ref iid, Wasapi.CLSCTX_ALL, IntPtr.Zero, out o) < 0 || o == null) continue;
                    IAudioSessionManager2 mgr = (IAudioSessionManager2)o;
                    IAudioSessionEnumerator se;
                    if (mgr.GetSessionEnumerator(out se) < 0 || se == null) continue;
                    int n;
                    se.GetCount(out n);
                    for (int i = 0; i < n; i++)
                    {
                        object so;
                        if (se.GetSession(i, out so) < 0 || so == null) continue;
                        IAudioSessionControl2 ctl = so as IAudioSessionControl2;
                        if (ctl == null) continue;
                        if (ctl.IsSystemSoundsSession() == 0) continue;
                        uint pid;
                        if (ctl.GetProcessId(out pid) < 0 || pid == 0) continue;
                        Process p;
                        string exe;
                        try { p = Process.GetProcessById((int)pid); exe = p.ProcessName + ".exe"; }
                        catch { continue; }
                        if (!seen.Add(exe)) continue;
                        string title = "";
                        try { title = p.MainWindowTitle ?? ""; } catch { }
                        if (title.Length == 0)
                        {
                            try
                            {
                                foreach (Process q in Process.GetProcessesByName(p.ProcessName))
                                {
                                    string t = "";
                                    try { t = q.MainWindowTitle ?? ""; } catch { }
                                    if (t.Length > 0) { title = t; break; }
                                }
                            }
                            catch { }
                        }
                        string friendly = p.ProcessName;
                        try
                        {
                            string path = Procs.ImagePath((int)pid);
                            if (path != null)
                            {
                                string desc = FileVersionInfo.GetVersionInfo(path).FileDescription;
                                if (!string.IsNullOrEmpty(desc) && desc.Trim().Length > 0) friendly = desc.Trim();
                            }
                        }
                        catch { }
                        if (!first) sb.Append(',');
                        first = false;
                        sb.Append("{\"pid\":").Append(pid.ToString(CultureInfo.InvariantCulture))
                          .Append(",\"exe\":").Append(Json(exe))
                          .Append(",\"title\":").Append(Json(title))
                          .Append(",\"name\":").Append(Json(friendly)).Append('}');
                    }
                }
                catch (Exception e)
                {
                    Log("session enumeration: " + e.Message);
                }
            }
        }
    }
}
