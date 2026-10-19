// A stand-in git.exe for the daemon's tests on Windows (files.test.js, fakeGit).
//
// alpd runs git with an argument list and no shell, which on Windows can start only a real
// executable: a script with a #! line, or a .cmd, is never run. This program is that executable.
// Copied as <dir>\git.exe, it runs `<node> <dir>\git.js <its arguments>`, where <node> is the
// path written in <dir>\git.node; the arguments go on exactly as they were received (the command
// line after the program name), and so do the working directory, the environment and the three
// standard handles. Node runs in a job that is killed when this process ends, so a test that
// kills git (a timeout) kills the script with it. The script's exit code is this one's.
using System;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;

static class FakeGit {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb; public string reserved, desktop, title;
    public int x, y, xSize, ySize, xCountChars, yCountChars, fillAttribute, flags;
    public short showWindow, reserved2; public IntPtr reserved3, stdInput, stdOutput, stdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr process, thread; public int processId, threadId; }
  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long perProcessUserTimeLimit, perJobUserTimeLimit; public int limitFlags;
    public UIntPtr minimumWorkingSetSize, maximumWorkingSetSize; public int activeProcessLimit;
    public UIntPtr affinity; public int priorityClass, schedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IO_COUNTERS { public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes; }
  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION basic; public IO_COUNTERS io;
    public UIntPtr processMemoryLimit, jobMemoryLimit, peakProcessMemoryUsed, peakJobMemoryUsed;
  }

  const int STARTF_USESTDHANDLES = 0x100;
  const int CREATE_SUSPENDED = 0x4;
  // alpd hides git's window (windowsHide), so this launcher has no console: node gets none either.
  const int CREATE_NO_WINDOW = 0x08000000;
  const int JobObjectExtendedLimitInformation = 9;
  const int JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcess(string application, string commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, int flags, IntPtr environment, string directory, ref STARTUPINFO startup, out PROCESS_INFORMATION info);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int length);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern int ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, int code);
  [DllImport("kernel32.dll")] static extern int WaitForSingleObject(IntPtr handle, int milliseconds);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out int code);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);

  static int Main() {
    string self = Assembly.GetExecutingAssembly().Location;
    string script = Path.ChangeExtension(self, ".js");
    string node = File.ReadAllText(Path.ChangeExtension(self, ".node")).Trim();
    // The program name ends at its closing quote, or at the first space or tab (CreateProcess's rule).
    string line = Environment.CommandLine;
    int end = 0;
    if (line.StartsWith("\"")) end = line.IndexOf('"', 1) + 1;
    else while (end < line.Length && line[end] != ' ' && line[end] != '\t') end++;
    string arguments = line.Substring(end);

    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    limits.basic.limitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (job == IntPtr.Zero || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)))) return Fail("no job");

    var startup = new STARTUPINFO();
    startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    startup.flags = STARTF_USESTDHANDLES;
    startup.stdInput = GetStdHandle(-10);
    startup.stdOutput = GetStdHandle(-11);
    startup.stdError = GetStdHandle(-12);
    PROCESS_INFORMATION child;
    if (!CreateProcess(node, "\"" + node + "\" \"" + script + "\"" + arguments, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_NO_WINDOW, IntPtr.Zero, null, ref startup, out child)) return Fail("node did not start");
    if (!AssignProcessToJobObject(job, child.process)) { TerminateProcess(child.process, 1); return Fail("node is not in the job"); }
    ResumeThread(child.thread);
    WaitForSingleObject(child.process, -1);
    int code;
    GetExitCodeProcess(child.process, out code);
    return code;
  }

  // 125: a code git never exits with, so a launcher failure is never read as git's answer.
  static int Fail(string why) {
    Console.Error.WriteLine("fake git.exe: " + why + " (error " + Marshal.GetLastWin32Error() + ")");
    return 125;
  }
}
