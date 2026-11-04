using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

internal static class WindowsProcessSnapshot {
  const uint SnapshotProcesses = 0x00000002;
  const int NoMoreFiles = 18;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct ProcessEntry {
    public uint Size, Usage, Pid;
    public UIntPtr DefaultHeap;
    public uint Module, Threads, ParentPid;
    public int BasePriority;
    public uint Flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
    public string Executable;
  }

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern SafeFileHandle CreateToolhelp32Snapshot(uint flags, uint pid);

  [DllImport("kernel32.dll", EntryPoint = "Process32FirstW", ExactSpelling = true, SetLastError = true)]
  static extern bool Process32First(SafeFileHandle snapshot, ref ProcessEntry entry);

  [DllImport("kernel32.dll", EntryPoint = "Process32NextW", ExactSpelling = true, SetLastError = true)]
  static extern bool Process32Next(SafeFileHandle snapshot, ref ProcessEntry entry);

  static int Main() {
    try {
      using (var snapshot = CreateToolhelp32Snapshot(SnapshotProcesses, 0)) {
        if (snapshot.IsInvalid) throw new Win32Exception();
        var entry = new ProcessEntry { Size = (uint)Marshal.SizeOf(typeof(ProcessEntry)) };
        if (!Process32First(snapshot, ref entry)) throw new Win32Exception();
        do {
          Console.WriteLine("{0} {1}", entry.Pid, entry.ParentPid);
        } while (Process32Next(snapshot, ref entry));
        int error = Marshal.GetLastWin32Error();
        if (error != NoMoreFiles) throw new Win32Exception(error);
      }
      return 0;
    } catch (Exception error) {
      Console.Error.WriteLine("Process snapshot: " + error.Message);
      return 1;
    }
  }
}
