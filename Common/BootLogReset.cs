using System;
using System.Globalization;
using System.IO;
using System.Text;
using Microsoft.Win32;

namespace RealName.Simple;

internal static class BootLogReset
{
    public static bool TryPrepare(string logPath)
    {
        try
        {
            if (!TryGetCurrentBootId(out var currentBoot))
            {
                return false;
            }

            Directory.CreateDirectory(Path.GetDirectoryName(logPath)!);
            // The exclusive marker handle also prevents two processes from resetting together.
            using var marker = new FileStream(logPath + ".boot", FileMode.OpenOrCreate,
                FileAccess.ReadWrite, FileShare.None);
            using var reader = new StreamReader(marker, Encoding.UTF8, true, 1024, leaveOpen: true);
            if (string.Equals(reader.ReadToEnd().Trim(), currentBoot, StringComparison.Ordinal))
            {
                return true;
            }

            // Truncate in place so the existing log's permissions are preserved.
            File.WriteAllText(logPath, string.Empty);
            marker.Position = 0;
            marker.SetLength(0);
            using var writer = new StreamWriter(marker, new UTF8Encoding(false), 1024, leaveOpen: true);
            writer.Write(currentBoot);
            writer.Flush();
            marker.Flush(flushToDisk: true);
            return true;
        }
        catch
        {
            // Logging and normal startup must still work if reset is unavailable.
            return false;
        }
    }

    private static bool TryGetCurrentBootId(out string bootId)
    {
        const string keyPath = @"SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management\PrefetchParameters";
        using var key = Registry.LocalMachine.OpenSubKey(keyPath, writable: false);
        if (key?.GetValue("BootId") is int value)
        {
            bootId = $"boot-id:{unchecked((uint)value).ToString(CultureInfo.InvariantCulture)}";
            return true;
        }

        bootId = string.Empty;
        return false;
    }
}
