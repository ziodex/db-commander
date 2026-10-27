using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

// A separate process survives Electron's Node-environment teardown. Retain
// kernel handles, rather than polling PIDs that Windows can later reuse.
internal static class WindowsOwnerGuard {
  const uint Synchronize = 0x00100000, Query = 0x1000, Terminate = 1;
  const uint Signaled = 0, Timeout = 258, Infinite = 0xffffffff;
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr handle, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr handle, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  static long Created(IntPtr handle) {
    long created, exited, kernel, user;
    if (!GetProcessTimes(handle, out created, out exited, out kernel, out user)) throw new Win32Exception();
    return created;
  }
  static void EndHost(IntPtr host) {
    uint state = WaitForSingleObject(host, 0);
    if (state == Signaled) return;
    if (state != Timeout || !TerminateProcess(host, 1)) throw new Win32Exception();
  }
  static int Main(string[] args) {
    IntPtr owner = IntPtr.Zero, host = IntPtr.Zero;
    try {
      uint ownerPid, hostPid; long ownerCreated;
      if (args.Length != 3 || !UInt32.TryParse(args[0], out ownerPid) || !UInt32.TryParse(args[1], out hostPid) || !Int64.TryParse(args[2], out ownerCreated) || ownerPid == 0 || hostPid == 0 || ownerPid == hostPid || ownerCreated <= 0) throw new ArgumentException("Invalid owner/host identity.");
      long watcherCreated = Created(GetCurrentProcess());
      host = OpenProcess(Synchronize | Query | Terminate, false, hostPid);
      if (host == IntPtr.Zero) throw new Win32Exception();
      if (Created(host) > watcherCreated) throw new InvalidOperationException("The host PID was reused before monitoring began.");
      owner = OpenProcess(Synchronize | Query, false, ownerPid);
      // Electron reports creation time in milliseconds. Allow only its final
      // sub-millisecond rounding, never a different process reusing that PID.
      if (owner == IntPtr.Zero || Math.Abs(Created(owner) / 10000 - 11644473600000L - ownerCreated) > 1) { EndHost(host); return 0; }
      Console.WriteLine("Db Commander owner guard ready");
      uint result = WaitForMultipleObjects(2, new IntPtr[] { host, owner }, false, Infinite);
      if (result == Signaled + 1) EndHost(host);
      else if (result != Signaled) throw new Win32Exception();
      return 0;
    } catch (Exception error) {
      Console.Error.WriteLine("Windows owner guard: " + error.Message);
      return 1;
    } finally {
      if (owner != IntPtr.Zero) CloseHandle(owner);
      if (host != IntPtr.Zero) CloseHandle(host);
    }
  }
}
