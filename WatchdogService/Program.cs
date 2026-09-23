using System.Diagnostics;
using System.Net.Http.Json;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.ServiceProcess;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace RealName.SimpleWatchdogService;

// ========================= 现场部署配置 =========================
// 发布到现场前通常只需要改这里：
// ClientPath 是 SMB 共享里的客户端 EXE 路径。
// ServerUrl 是 Node 后端地址，必须和 Server/src/config.js 里的监听端口对应。
// 这些值只是最终兜底；Release 会嵌入 watchdogsettings.jsonc，修改正式版配置后需要重新编译。
internal static class DeploymentSettings
{
    // SMB 共享中的实名上机客户端 EXE 完整路径。
    public const string DefaultClientPath = @"C:\Program Files\RealNameSimple\Client\RealName.SimpleClient.exe";

    // 实名上机 Node 后端地址，用于请求 /api/client-policy。
    public const string DefaultServerUrl = "http://127.0.0.1:14848";

    public static string ClientPath => WatchdogLocalSettings.Current.ClientPath;

    public static string ServerUrl => WatchdogLocalSettings.Current.ServerUrl;
}

// 程序入口：同时支持命令行模式和 Windows 服务模式。
internal static class Program
{
    // Main 是整个守护服务 EXE 的入口，根据运行环境决定走命令行还是服务托管。
    public static int Main(string[] args)
    {
        // 手动双击或命令行运行时设置 UTF-8，避免中文提示乱码。
        if (Environment.UserInteractive)
        {
            Console.OutputEncoding = Encoding.UTF8;
        }

        // 带参数时执行 install/start/stop/status/run 等命令。
        if (args.Length > 0)
        {
            try
            {
                return ServiceCommands.Run(args);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"操作失败，错误码：0x{ex.HResult:X8}。请确认权限和服务状态后重试。");
                return 1;
            }
        }

        // 无参数且是交互运行时，只打印帮助，不直接启动守护逻辑。
        if (Environment.UserInteractive)
        {
            ServiceCommands.PrintUsage();
            return 0;
        }

        // 由 Windows 服务控制器启动时，进入标准 ServiceBase 生命周期。
        ServiceBase.Run(new WatchdogWindowsService());
        return 0;
    }
}

// 守护服务固定配置：服务名、安装位置、进程名和轮询间隔。
internal static class WatchdogSettings
{
    // Windows 服务注册名，sc.exe 操作服务时使用。
    public const string ServiceName = "RealNameSimpleWatchdog";

    // Windows 服务管理器里看到的显示名称。
    public const string ServiceDisplayName = "RealName Simple Watchdog";

    // Windows 服务管理器里看到的服务描述，用于警示随意停止服务的后果。
    public const string ServiceDescription = "防君子不防小人，停止的话会被记录标记";

    // 服务最终安装目录，install 命令会把当前 EXE 复制到这里。
    public static readonly string InstallDirectory = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
        "RealNameSimple",
        "Watchdog");

    // 服务注册到 Windows 后实际运行的 EXE 路径。
    public static readonly string InstalledExePath = Path.Combine(InstallDirectory, "RealName.SimpleWatchdogService.exe");

    // 被守护的客户端进程名，不带 .exe。
    public const string ClientProcessName = "RealName.SimpleClient";

    // 守护检查间隔，单位：秒；用于判断客户端是否需要拉起或结束。
    public const int CheckSeconds = 2;

    // 后端启停策略检查间隔，单位：秒；避免每 2 秒都请求后端。
    public const int PolicyCheckSeconds = 10;

    // 已登录会话兜底检查间隔，单位：秒；用于发现被其他电脑接管后的旧客户端。
    public const int SessionCheckSeconds = 2;

    // 客户端 UI 活性文件超过该秒数未更新时，认为客户端假死未响应。
    public const int ClientAliveStaleSeconds = 30;

    // 相同错误日志的最短重复输出间隔，单位：秒。
    public const int RetryLogSeconds = 10;
}

// Watchdog 配置：Debug 环境读取外部 watchdogsettings.jsonc，Release 发布版读取 EXE 内置资源。
internal sealed class WatchdogLocalSettings
{
    public const string JsoncFileName = "watchdogsettings.jsonc";
    private const string LegacyJsonFileName = "watchdogsettings.json";

    private static readonly Lazy<WatchdogLocalSettings> LazyCurrent = new(Load);

    private static readonly JsonSerializerOptions SettingsJsonOptions = new(JsonSerializerDefaults.Web)
    {
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
    };

    public static WatchdogLocalSettings Current => LazyCurrent.Value;

    public string ServerUrl { get; init; } = DeploymentSettings.DefaultServerUrl;

    public string ClientPath { get; init; } = DeploymentSettings.DefaultClientPath;

    public int CheckSeconds { get; init; } = WatchdogSettings.CheckSeconds;

    public int PolicySeconds { get; init; } = WatchdogSettings.PolicyCheckSeconds;

    public int SessionSeconds { get; init; } = WatchdogSettings.SessionCheckSeconds;

    public int AliveStaleSeconds { get; init; } = WatchdogSettings.ClientAliveStaleSeconds;

    public int HttpTimeoutSeconds { get; init; } = 3;

    public int RetryLogSeconds { get; init; } = WatchdogSettings.RetryLogSeconds;

    public bool SessionGuard { get; init; } = true;

    public bool AliveGuard { get; init; } = true;

    public static void CopyConfigToInstallDirectory(string sourceExePath)
    {
        var sourceDirectory = Path.GetDirectoryName(sourceExePath) ?? AppContext.BaseDirectory;
        var sourcePath = ExistingConfigPath(sourceDirectory);
        if (sourcePath is null)
        {
            return;
        }

        var targetPath = Path.Combine(WatchdogSettings.InstallDirectory, JsoncFileName);
        if (string.Equals(Path.GetFullPath(sourcePath), Path.GetFullPath(targetPath), StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        File.Copy(sourcePath, targetPath, true);
        Console.WriteLine($"已复制 Watchdog 配置到：{targetPath}");
    }

    // 加载 Watchdog 配置。开发环境保留外置文件便利，正式发布版不依赖程序目录配置文件。
    private static WatchdogLocalSettings Load()
    {
#if DEBUG
        foreach (var fileName in new[] { JsoncFileName, LegacyJsonFileName })
        {
            var path = Path.Combine(AppContext.BaseDirectory, fileName);
            if (!File.Exists(path))
            {
                continue;
            }

            try
            {
                var json = File.ReadAllText(path);
                return JsonSerializer.Deserialize<WatchdogLocalSettings>(json, SettingsJsonOptions) ?? new WatchdogLocalSettings();
            }
            catch (Exception ex)
            {
                FileLogger.Write($"Watchdog本地配置读取失败：{path}，将继续尝试其他配置或使用默认值。{ex.GetType().Name}：{ex.Message}");
            }
        }
#endif

        try
        {
            var assembly = typeof(WatchdogLocalSettings).Assembly;
            var resourceName = assembly.GetManifestResourceNames()
                .FirstOrDefault(name => name.EndsWith($".{JsoncFileName}", StringComparison.OrdinalIgnoreCase));
            if (!string.IsNullOrWhiteSpace(resourceName))
            {
                using var stream = assembly.GetManifestResourceStream(resourceName);
                using var reader = stream is null ? null : new StreamReader(stream);
                if (reader is not null)
                {
                    var json = reader.ReadToEnd();
                    return JsonSerializer.Deserialize<WatchdogLocalSettings>(json, SettingsJsonOptions)
                        ?? new WatchdogLocalSettings();
                }
            }

            FileLogger.Write("Watchdog EXE 内未找到内置 watchdogsettings.jsonc，改用代码兜底配置。");
        }
        catch (Exception ex)
        {
            FileLogger.Write($"Watchdog 内置配置读取失败，将使用代码兜底配置。{ex.GetType().Name}：{ex.Message}");
        }

        return new WatchdogLocalSettings();
    }

    private static string? ExistingConfigPath(string directory)
    {
        foreach (var fileName in new[] { JsoncFileName, LegacyJsonFileName })
        {
            var path = Path.Combine(directory, fileName);
            if (File.Exists(path))
            {
                return path;
            }
        }

        return null;
    }
}

// 命令行入口：负责安装、卸载、启动、停止、查看状态和调试运行。
internal static class ServiceCommands
{
    // 分发命令行参数到具体操作。
    public static int Run(string[] args)
    {
        var command = args[0].Trim().ToLowerInvariant();
        return command switch
        {
            "install" => Install(),
            "uninstall" => Uninstall(),
            "start" => StartService(),
            "stop" => StopService(),
            "status" => PrintStatus(),
            "run" => RunConsole(),
            _ => PrintUsage(1),
        };
    }

    // 打印命令行用法；不在控制台展示后端地址和 SMB 客户端路径。
    public static int PrintUsage(int exitCode = 0)
    {
        Console.WriteLine("实名上机守护服务");
        Console.WriteLine();
        Console.WriteLine("用法：");
        Console.WriteLine("  RealName.SimpleWatchdogService.exe install");
        Console.WriteLine("  RealName.SimpleWatchdogService.exe start");
        Console.WriteLine("  RealName.SimpleWatchdogService.exe stop");
        Console.WriteLine("  RealName.SimpleWatchdogService.exe uninstall");
        Console.WriteLine("  RealName.SimpleWatchdogService.exe status");
        Console.WriteLine("  RealName.SimpleWatchdogService.exe run");
        Console.WriteLine();
        Console.WriteLine($"服务安装路径：{WatchdogSettings.InstalledExePath}");
        Console.WriteLine("客户端路径：已使用内置兜底和后台下发配置");
        Console.WriteLine("后端地址：已使用内置兜底配置");
        return exitCode;
    }

    // 安装或更新 Windows 服务：复制 EXE、注册服务、设置自启动并启动服务。
    private static int Install()
    {
        // 当前正在运行的 EXE 是发布包里的临时 EXE，安装时会复制到固定目录。
        var exePath = Environment.ProcessPath ?? Process.GetCurrentProcess().MainModule?.FileName;
        if (string.IsNullOrWhiteSpace(exePath))
        {
            Console.WriteLine("无法获取当前服务 EXE 路径。");
            return 1;
        }

        // 确保安装目录存在；如果当前路径不是固定安装路径，就覆盖复制过去。
        Directory.CreateDirectory(WatchdogSettings.InstallDirectory);
        WatchdogLocalSettings.CopyConfigToInstallDirectory(exePath);
        if (!PathEquals(exePath, WatchdogSettings.InstalledExePath))
        {
            var stopResult = StopService();
            if (stopResult != 0)
            {
                return stopResult;
            }
            if (!CopyInstalledExecutable(exePath))
            {
                return 1;
            }
            Console.WriteLine($"已复制服务 EXE 到：{WatchdogSettings.InstalledExePath}");
        }

        // 服务已存在就更新配置，不存在就创建新服务。
        var registerResult = ServiceExists()
            ? RunSc(
                "config",
                WatchdogSettings.ServiceName,
                "binPath=",
                $"\"{WatchdogSettings.InstalledExePath}\"",
                "start=",
                "auto",
                "DisplayName=",
                WatchdogSettings.ServiceDisplayName)
            : RunSc(
                "create",
                WatchdogSettings.ServiceName,
                "binPath=",
                $"\"{WatchdogSettings.InstalledExePath}\"",
                "start=",
                "auto",
                "DisplayName=",
                WatchdogSettings.ServiceDisplayName);
        if (registerResult != 0)
        {
            Console.WriteLine($"服务注册失败，请确认已使用管理员身份运行。错误码：{registerResult}");
            return registerResult;
        }

        // 每次安装都刷新描述，避免保留旧安装时被修改过的描述文本。
        RunSc("description", WatchdogSettings.ServiceName, WatchdogSettings.ServiceDescription);
        Console.WriteLine($"服务安装完成，启动路径：{WatchdogSettings.InstalledExePath}");
        return StartService();
    }

    // 某些 Windows 10 版本在服务报告 Stopped 后仍会短暂占用 EXE，等待句柄释放后再覆盖。
    private static bool CopyInstalledExecutable(string sourcePath)
    {
        Exception? lastError = null;
        for (var attempt = 0; attempt < 10; attempt++)
        {
            try
            {
                File.Copy(sourcePath, WatchdogSettings.InstalledExePath, true);
                return true;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                lastError = ex;
                if (attempt < 9)
                {
                    System.Threading.Thread.Sleep(500);
                }
            }
        }

        Console.WriteLine($"服务文件更新失败，错误码：0x{lastError?.HResult:X8}。请稍后重试。");
        return false;
    }

    // 这里只停止并删除服务；数据目录由 uninstall-service.bat 清理。
    private static int Uninstall()
    {
        var stopResult = StopService();
        if (stopResult != 0)
        {
            return stopResult;
        }

        var result = RunSc("delete", WatchdogSettings.ServiceName);
        if (result is 0 or 1060 or 1072)
        {
            Console.WriteLine("服务卸载完成。");
            return 0;
        }

        Console.WriteLine($"服务卸载失败，请确认已使用管理员身份运行。错误码：{result}");
        return result;
    }

    // 启动已安装的 Windows 服务。
    private static int StartService()
    {
        try
        {
            // 找不到服务时提示先安装。
            using var service = GetService();
            if (service is null)
            {
                Console.WriteLine("服务未安装，请先执行 install。");
                return 1;
            }

            // 已经运行就直接返回成功。
            if (service.Status == ServiceControllerStatus.Running)
            {
                Console.WriteLine("服务已在运行。");
                return 0;
            }

            // 服务不处于启动中时才调用 Start，避免重复启动异常。
            if (service.Status is not ServiceControllerStatus.StartPending)
            {
                service.Start();
            }

            // 等待状态变成 Running，超时会进入 catch。
            service.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(15));
            Console.WriteLine("服务启动成功。");
            return 0;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"服务启动失败，错误码：0x{ex.HResult:X8}");
            return 1;
        }
    }

    // 停止已安装的 Windows 服务。
    private static int StopService()
    {
        try
        {
            // 服务不存在时视为已经停止，方便卸载流程继续执行。
            using var service = GetService();
            if (service is null)
            {
                Console.WriteLine("服务未安装。");
                return 0;
            }

            // 已停止时不重复 Stop。
            if (service.Status == ServiceControllerStatus.Stopped)
            {
                Console.WriteLine("服务已经停止。");
                return 0;
            }

            // 服务允许停止且不在停止中时才发 Stop 命令。
            if (service.CanStop && service.Status is not ServiceControllerStatus.StopPending)
            {
                service.Stop();
            }

            // 等待服务真正停止，避免卸载时服务还在占用 EXE。
            service.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(15));
            Console.WriteLine("服务停止成功。");
            return 0;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"服务停止失败，错误码：0x{ex.HResult:X8}");
            return 1;
        }
    }

    // 打印当前服务安装状态；不在控制台展示后端地址和 SMB 客户端路径。
    private static int PrintStatus()
    {
        using var service = GetService();
        if (service is null)
        {
            Console.WriteLine("服务状态：未安装");
            return 1;
        }

        Console.WriteLine($"服务名称：{service.ServiceName}");
        Console.WriteLine($"显示名称：{service.DisplayName}");
        Console.WriteLine($"当前状态：{ToChineseStatus(service.Status)}");
        Console.WriteLine($"启动路径：{WatchdogSettings.InstalledExePath}");
        Console.WriteLine("客户端路径：已隐藏");
        Console.WriteLine("后端地址：已隐藏");
        return 0;
    }

    // 判断服务是否已经注册到 Windows 服务控制器。
    private static bool ServiceExists()
    {
        using var service = GetService();
        return service is not null;
    }

    // 根据固定服务名查找当前服务对象。
    private static ServiceController? GetService()
    {
        var service = new ServiceController(WatchdogSettings.ServiceName);
        try
        {
            _ = service.Status;
            return service;
        }
        catch (InvalidOperationException ex) when (ex.InnerException is System.ComponentModel.Win32Exception { NativeErrorCode: 1060 })
        {
            service.Dispose();
            return null;
        }
        catch
        {
            service.Dispose();
            throw;
        }
    }

    // 把 ServiceControllerStatus 转成中文，方便命令行 status 查看。
    private static string ToChineseStatus(ServiceControllerStatus status)
    {
        return status switch
        {
            ServiceControllerStatus.Stopped => "已停止",
            ServiceControllerStatus.StartPending => "正在启动",
            ServiceControllerStatus.StopPending => "正在停止",
            ServiceControllerStatus.Running => "正在运行",
            ServiceControllerStatus.ContinuePending => "正在继续",
            ServiceControllerStatus.PausePending => "正在暂停",
            ServiceControllerStatus.Paused => "已暂停",
            _ => status.ToString(),
        };
    }

    // 比较两个路径是否指向同一个位置，忽略大小写和结尾斜杠差异。
    private static bool PathEquals(string left, string right)
    {
        return string.Equals(
            Path.GetFullPath(left).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
            Path.GetFullPath(right).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
            StringComparison.OrdinalIgnoreCase);
    }

    // 控制台调试模式：不安装服务，直接在当前窗口运行守护监控。
    private static int RunConsole()
    {
        using var monitor = new WatchdogMonitor();
        using var exit = new ManualResetEventSlim(false);

        // Ctrl+C 时优雅退出调试监控。
        Console.CancelKeyPress += (_, e) =>
        {
            e.Cancel = true;
            exit.Set();
        };

        FileLogger.Write("调试模式启动，按 Ctrl+C 退出。");
        monitor.Start();
        exit.Wait();
        FileLogger.Write("调试模式退出。");
        return 0;
    }

    // 调用 sc.exe 执行服务注册、删除、配置等系统命令。
    private static int RunSc(params string[] arguments)
    {
        using var process = new Process();

        // 使用 ArgumentList 避免手动拼接命令行带来的空格和引号问题。
        process.StartInfo = new ProcessStartInfo(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.System), "sc.exe"))
        {
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        foreach (var argument in arguments)
        {
            process.StartInfo.ArgumentList.Add(argument);
        }

        // 直接继承控制台输出，不用重定向管道；系统命令必须在限时内结束。
        process.Start();
        if (!process.WaitForExit(15000))
        {
            process.Kill(entireProcessTree: true);
            process.WaitForExit(5000);
            Console.WriteLine("服务管理命令执行超时，请检查 Windows 服务状态后重试。");
            return 1;
        }

        return process.ExitCode;
    }
}

// Windows 服务托管类：把 ServiceBase 生命周期转成 WatchdogMonitor 的启动和停止。
internal sealed class WatchdogWindowsService : ServiceBase
{
    // 实际执行守护逻辑的监控器实例。
    private WatchdogMonitor? _monitor;

    // 配置服务基础属性，关闭系统事件日志 AutoLog，统一写自己的 watchdog.log。
    public WatchdogWindowsService()
    {
        ServiceName = WatchdogSettings.ServiceName;
        CanStop = true;
        CanShutdown = true;
        AutoLog = false;
    }

    // 服务启动时创建监控器并开始定时检查客户端。
    protected override void OnStart(string[] args)
    {
        FileLogger.Write("服务启动。");
        _monitor = new WatchdogMonitor();
        _monitor.Start();
    }

    // 服务停止时释放定时器，避免后台继续拉起客户端。
    protected override void OnStop()
    {
        _monitor?.Dispose();
        _monitor = null;
        FileLogger.Write("服务停止。");
    }

    // 系统关机时复用停止逻辑，确保日志和资源释放一致。
    protected override void OnShutdown()
    {
        OnStop();
        base.OnShutdown();
    }
}

// 守护监控核心：周期检查教室策略、客户端进程和活动用户会话。
internal sealed class WatchdogMonitor : IDisposable
{
    // 请求后端策略接口的 HttpClient，全局复用避免频繁创建连接。
    private static readonly HttpClient PolicyHttpClient = new() { Timeout = Timeout.InfiniteTimeSpan };

    // 与后端和 session.json 交互统一使用 Web 风格 JSON 命名。
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    // 防止上一次检查还没结束时下一次 Timer 回调重入。
    private readonly object _gate = new();

    // 定时检查器，Start 时创建，Dispose 时释放。
    private Timer? _timer;

    // 当前运行期配置；启动时使用内置默认值，后端下发成功后动态覆盖。
    private WatchdogRuntimeConfig _config = WatchdogRuntimeConfig.Default;

    // 最近一次已记录的配置签名，用于配置变化时写一条日志。
    private string? _lastConfigSignature;

    // 失败日志写入时间，按错误消息分别限频，避免不同错误互相覆盖。
    private readonly Dictionary<string, DateTimeOffset> _failureLogTimes = new(StringComparer.Ordinal);

    // 日志冷却设为 0 时，同一类错误在本次 Watchdog 进程生命周期内只记录一次。
    private readonly HashSet<string> _failureMessagesLoggedWithoutCooldown = new(StringComparer.Ordinal);

    // 最近一次从后端拿到的完整有效策略，策略检查间隔内复用。
    private ClientPolicyResponse? _lastPolicy;

    // 下一次允许请求后端策略的时间；成功后按正常周期刷新，失败后短间隔重试。
    private DateTimeOffset _nextPolicyCheckTime = DateTimeOffset.MinValue;

    // 最近一次检查本机会话是否仍有效的时间。
    private DateTimeOffset _lastSessionCheckTime = DateTimeOffset.MinValue;

    // 后端明确返回教室停用后保持锁定，避免后续策略请求失败时又把客户端拉起来。
    private bool _classroomDisabledLock;

    // 启动命令通过 cmd /c start 异步执行；在真实客户端进程出现前保留启动中的保护，
    // 避免下一轮检查重复提交同一个启动请求。
    private readonly Dictionary<uint, DateTimeOffset> _launchInFlight = new();

    // SMB/WebView2 慢启动时给真实客户端进程留出的确认窗口。
    private static readonly TimeSpan LaunchConfirmationWindow = TimeSpan.FromSeconds(15);

    // 策略请求失败后尽快重试；在拿到有效启用策略前不会拉起客户端。
    private static readonly TimeSpan PolicyFailureRetryDelay = TimeSpan.FromSeconds(2);

    // 启动定时器，立即检查一次，之后按 CheckSeconds 周期检查。
    public void Start()
    {
        _timer = new Timer(_ => CheckClient(), null, TimeSpan.Zero, TimeSpan.FromSeconds(_config.CheckSeconds));
    }

    // 释放定时器，服务停止或调试模式退出时调用。
    public void Dispose()
    {
        _timer?.Dispose();
        _timer = null;
    }

    // Timer 回调入口，负责防重入和兜底异常捕获。
    private void CheckClient()
    {
        // 如果上一轮检查还在执行，当前轮直接跳过。
        if (!Monitor.TryEnter(_gate))
        {
            return;
        }

        try
        {
            CheckClientCore();
        }
        catch (Exception ex)
        {
            // 任意异常都写日志，但不让 Timer 线程崩掉。
            LogFailure($"守护检查异常：{ex.Message}");
        }
        finally
        {
            Monitor.Exit(_gate);
        }
    }

    // 守护检查主逻辑：先看教室策略，再决定结束客户端或拉起客户端。
    private void CheckClientCore()
    {
        // 只有完整且成功的策略响应才可改变教室启停状态。
        var policy = GetClientPolicy();
        var hasValidPolicy = policy?.Ok == true
            && policy.SystemEnabled.HasValue
            && policy.ShouldExit.HasValue;

        // 后端明确返回教室停用时，结束正在运行的客户端并停止拉起。
        if (hasValidPolicy && (policy!.ShouldExit == true || policy.SystemEnabled == false))
        {
            _classroomDisabledLock = true;
            var stopped = StopRunningClients();
            _launchInFlight.Clear();
            if (stopped > 0)
            {
                FileLogger.Write($"教室未启用实名上机系统，已结束客户端进程 {stopped} 个。");
            }

            ClearFailure();
            return;
        }

        if (hasValidPolicy && policy!.SystemEnabled == true && policy.ShouldExit == false)
        {
            if (_classroomDisabledLock)
            {
                FileLogger.Write("教室实名上机系统已重新启用，Watchdog 恢复客户端守护。");
            }
            _classroomDisabledLock = false;
        }

        if (_classroomDisabledLock)
        {
            var stopped = StopRunningClients();
            _launchInFlight.Clear();
            if (stopped > 0)
            {
                FileLogger.Write($"教室停用状态保持中，已结束客户端进程 {stopped} 个。");
            }
            return;
        }

        // 后端不可达、响应失败或策略字段不完整时，不拉起新客户端；
        // 已经运行的客户端保持不变，避免短暂网络波动造成中断。
        if (!hasValidPolicy)
        {
            _launchInFlight.Clear();
            LogFailure("尚未取得完整有效的教室策略，暂不拉起客户端；已运行客户端保持不变。");
            return;
        }

        // 只在存在活动用户桌面会话时拉起客户端，避免拉到无人桌面。
        var sessionIds = NativeMethods.GetActiveUserSessionIds().ToArray();
        if (sessionIds.Length == 0)
        {
            LogFailure("当前没有活动用户桌面会话，等待用户登录。");
            return;
        }

        var anyClientRunning = sessionIds.Any(sessionId => IsClientRunningInSession((int)sessionId));
        if (anyClientRunning && _config.AliveGuard && ShouldRestartUnresponsiveClient(out var unresponsiveReason))
        {
            var stopped = StopRunningClients();
            _launchInFlight.Clear();
            FileLogger.Write($"{unresponsiveReason}，已结束客户端进程 {stopped} 个，等待下一轮重新拉起。");
            ClearFailure();
            return;
        }

        if (anyClientRunning && _config.SessionGuard && ShouldStopStaleLoggedInClient())
        {
            var stopped = StopRunningClients();
            _launchInFlight.Clear();
            WatchdogSessionCache.Clear();
            FileLogger.Write($"检测到本机上机会话已失效，已结束旧客户端进程 {stopped} 个并清理 session.json。");
            ClearFailure();
            return;
        }

        // 对每个活动用户会话检查客户端进程，不在该会话中运行就拉起。
        var anyStarted = false;
        var now = DateTimeOffset.UtcNow;
        foreach (var sessionId in sessionIds)
        {
            if (IsClientRunningInSession((int)sessionId))
            {
                _launchInFlight.Remove(sessionId);
                continue;
            }

            if (_launchInFlight.TryGetValue(sessionId, out var launchDeadline))
            {
                if (now < launchDeadline)
                {
                    continue;
                }

                // 启动确认窗口已过且仍未出现真实客户端，允许带保护地重试。
                _launchInFlight.Remove(sessionId);
            }

            if (StartClientInSession(sessionId))
            {
                _launchInFlight[sessionId] = now + LaunchConfirmationWindow;
                anyStarted = true;
            }
        }

        // 所有活动会话都有客户端运行，清理最近失败状态。
        if (!anyStarted)
        {
            ClearFailure();
        }
    }

    // 请求后端 /api/client-policy，判断当前 IP 所属教室是否启用实名上机系统。
    private ClientPolicyResponse? GetClientPolicy()
    {
        var now = DateTimeOffset.Now;

        // 策略检查做本地缓存，并给下一次刷新加随机抖动，避免所有 Watchdog 同时请求后端。
        if (now < _nextPolicyCheckTime)
        {
            return _lastPolicy;
        }

        try
        {
            // 上报机器名、IP 和 MAC，后端用 IP 匹配教室策略。
            var request = new ClientPolicyRequest(
                Environment.MachineName,
                WatchdogNetworkHelper.GetIpAddress(),
                WatchdogNetworkHelper.GetMacAddress());
            using var cts = CreateHttpTimeoutToken();
            using var response = PolicyHttpClient.PostAsJsonAsync(BuildPolicyUri(), request, JsonOptions, cts.Token).GetAwaiter().GetResult();

            // 后端异常时不主动结束客户端，但本轮不允许拉起新客户端。
            if (!response.IsSuccessStatusCode)
            {
                _lastPolicy = null;
                _nextPolicyCheckTime = DateTimeOffset.Now + PolicyFailureRetryDelay;
                LogFailure($"实名上机策略检查失败，HTTP {(int)response.StatusCode}；暂不拉起新客户端，已运行客户端保持不变。");
                return null;
            }

            // 空响应、失败响应或关键字段缺失都不算有效策略，也不能授权拉起客户端。
            var policy = response.Content.ReadFromJsonAsync<ClientPolicyResponse>(JsonOptions, cts.Token).GetAwaiter().GetResult();
            if (policy?.Ok != true || !policy.SystemEnabled.HasValue || !policy.ShouldExit.HasValue)
            {
                _lastPolicy = null;
                _nextPolicyCheckTime = DateTimeOffset.Now + PolicyFailureRetryDelay;
                LogFailure("实名上机策略检查失败：后端未返回完整有效的教室策略；暂不拉起新客户端，已运行客户端保持不变。");
                return null;
            }

            // 只缓存完整有效的策略，并按后端配置安排正常刷新间隔。
            _lastPolicy = policy;
            ApplyRuntimeConfig(policy.WatchdogConfig);
            _nextPolicyCheckTime = DateTimeOffset.Now + BuildPolicyRefreshDelay();
            return _lastPolicy;
        }
        catch (Exception ex)
        {
            // 请求失败时不保留旧策略，确保断网后不会继续授权新的客户端启动。
            _lastPolicy = null;
            _nextPolicyCheckTime = DateTimeOffset.Now + PolicyFailureRetryDelay;
            LogFailure($"实名上机策略检查失败：{ex.Message}；暂不拉起新客户端，已运行客户端保持不变。");
            return null;
        }
    }

    // 构造下一次策略刷新延迟：基础间隔来自 policy_seconds，再追加最多 3 秒随机抖动。
    private TimeSpan BuildPolicyRefreshDelay()
    {
        var baseDelay = TimeSpan.FromSeconds(Math.Max(1, _config.PolicySeconds));
        var maxJitterMilliseconds = Math.Min(3000, Math.Max(500, _config.PolicySeconds * 1000 / 3));
        var jitter = TimeSpan.FromMilliseconds(Random.Shared.Next(0, maxJitterMilliseconds + 1));
        return baseDelay + jitter;
    }

    // 应用后端下发的 Watchdog 配置，非法值会在 WatchdogRuntimeConfig 内部回退默认值。
    private void ApplyRuntimeConfig(WatchdogConfigResponse? response)
    {
        var previous = _config;
        var next = WatchdogRuntimeConfig.FromResponse(response);
        _config = next;

        if (_timer is not null && previous.CheckSeconds != next.CheckSeconds)
        {
            _timer.Change(TimeSpan.FromSeconds(next.CheckSeconds), TimeSpan.FromSeconds(next.CheckSeconds));
        }

        var signature = next.Signature();
        if (!string.Equals(_lastConfigSignature, signature, StringComparison.Ordinal))
        {
            _lastConfigSignature = signature;
            FileLogger.Write($"已应用Watchdog配置：客户端路径={(string.IsNullOrWhiteSpace(next.ClientPath) ? "未配置" : "已配置")}，主检查={next.CheckSeconds}秒，策略={next.PolicySeconds}秒，会话={next.SessionSeconds}秒，无响应={next.AliveStaleSeconds}秒，接口超时={next.HttpTimeoutSeconds}秒，日志冷却={next.RetryLogSeconds}秒，会话守护={(next.SessionGuard ? "开启" : "关闭")}，无响应守护={(next.AliveGuard ? "开启" : "关闭")}。");
        }
    }

    // 拼接后端策略接口地址，兼容 ServerUrl 末尾有没有斜杠。
    private static Uri BuildPolicyUri()
    {
        return new Uri(new Uri(DeploymentSettings.ServerUrl.TrimEnd('/') + "/"), "api/client-policy");
    }

    // 通过现有 /api/heartbeat 检查本机缓存的已登录会话是否仍然有效。
    private bool ShouldStopStaleLoggedInClient()
    {
        var now = DateTimeOffset.Now;
        if (now - _lastSessionCheckTime < TimeSpan.FromSeconds(_config.SessionSeconds))
        {
            return false;
        }
        _lastSessionCheckTime = now;

        var cachedSession = WatchdogSessionCache.Load();
        if (cachedSession is null || string.IsNullOrWhiteSpace(cachedSession.SessionId) || string.IsNullOrWhiteSpace(cachedSession.MachineId))
        {
            return false;
        }

        try
        {
            var request = new WatchdogHeartbeatRequest(
                cachedSession.MachineId,
                Environment.MachineName,
                WatchdogNetworkHelper.GetIpAddress(),
                WatchdogNetworkHelper.GetMacAddress(),
                "Unlocked",
                cachedSession.Name,
                cachedSession.SessionId,
                "watchdog");
            using var cts = CreateHttpTimeoutToken();
            using var response = PolicyHttpClient.PostAsJsonAsync(BuildHeartbeatUri(), request, JsonOptions, cts.Token).GetAwaiter().GetResult();
            if (!response.IsSuccessStatusCode)
            {
                LogFailure($"本机会话状态检查失败，HTTP {(int)response.StatusCode}，暂不结束客户端。");
                return false;
            }

            var heartbeat = response.Content.ReadFromJsonAsync<WatchdogHeartbeatResponse>(JsonOptions, cts.Token).GetAwaiter().GetResult();
            if (heartbeat is null)
            {
                LogFailure("本机会话状态检查失败：后端返回为空，暂不结束客户端。");
                return false;
            }

            if (heartbeat.ShouldExit == true || heartbeat.SystemEnabled == false)
            {
                _classroomDisabledLock = true;
                FileLogger.Write(heartbeat.Message ?? "当前教室未启用实名上机系统，准备结束客户端。");
                return true;
            }

            if (heartbeat.IpAllowed == false || heartbeat.SessionExpired)
            {
                FileLogger.Write(heartbeat.Message ?? "本机上机会话已失效，准备结束客户端。");
                return true;
            }

            return false;
        }
        catch (Exception ex)
        {
            LogFailure($"本机会话状态检查失败：{ex.Message}，暂不结束客户端。");
            return false;
        }
    }

    // 拼接后端心跳接口地址，复用客户端同一会话校验逻辑。
    private static Uri BuildHeartbeatUri()
    {
        return new Uri(new Uri(DeploymentSettings.ServerUrl.TrimEnd('/') + "/"), "api/heartbeat");
    }

    // 判断客户端进程是否还活着但 UI 已经假死。
    private bool ShouldRestartUnresponsiveClient(out string reason)
    {
        reason = "";

        // 无响应秒为 0 时完全关闭 client.alive 无响应检测。
        if (_config.AliveStaleSeconds <= 0)
        {
            return false;
        }

        var newestStartTime = GetNewestClientStartTimeUtc();
        if (newestStartTime is null)
        {
            return false;
        }

        var now = DateTimeOffset.UtcNow;
        var processAge = now - newestStartTime.Value;
        if (processAge < TimeSpan.FromSeconds(_config.AliveStaleSeconds))
        {
            return false;
        }

        var lastAliveTime = WatchdogClientAliveMarker.GetLastWriteTimeUtc();
        if (lastAliveTime is null)
        {
            reason = $"客户端进程已运行 {Math.Floor(processAge.TotalSeconds)} 秒，但没有生成 client.alive 活性文件";
            return true;
        }

        var staleFor = now - lastAliveTime.Value;
        if (staleFor <= TimeSpan.FromSeconds(_config.AliveStaleSeconds))
        {
            return false;
        }

        reason = $"客户端 UI 活性文件已 {Math.Floor(staleFor.TotalSeconds)} 秒未更新，判定客户端未响应";
        return true;
    }

    // 获取当前正在运行客户端进程里最新的启动时间，用于新启动宽限。
    private static DateTimeOffset? GetNewestClientStartTimeUtc()
    {
        DateTimeOffset? newest = null;
        foreach (var process in Process.GetProcessesByName(WatchdogSettings.ClientProcessName))
        {
            using (process)
            {
                try
                {
                    if (process.HasExited)
                    {
                        continue;
                    }

                    var startTime = new DateTimeOffset(process.StartTime.ToUniversalTime(), TimeSpan.Zero);
                    if (newest is null || startTime > newest.Value)
                    {
                        newest = startTime;
                    }
                }
                catch
                {
                }
            }
        }

        return newest;
    }

    // 结束所有正在运行的客户端进程，用于教室停用时立即退出实名上机客户端。
    private static int StopRunningClients()
    {
        var stopped = 0;

        // 按进程名查找客户端，逐个 Kill 整棵进程树。
        foreach (var process in Process.GetProcessesByName(WatchdogSettings.ClientProcessName))
        {
            using (process)
            {
                try
                {
                    // 已退出的进程跳过，避免访问状态时报错。
                    if (process.HasExited)
                    {
                        continue;
                    }

                    // 客户端无交互退出接口，这里按停用策略强制结束。
                    process.Kill(entireProcessTree: true);
                    process.WaitForExit(3000);
                    stopped++;
                }
                catch
                {
                    // 单个进程结束失败不影响继续尝试其他客户端进程。
                }
            }
        }

        return stopped;
    }

    // 判断指定 Windows 会话里是否已经有客户端进程运行。
    private static bool IsClientRunningInSession(int sessionId)
    {
        // 同一台机器可能多用户登录，所以要按 SessionId 判断。
        foreach (var process in Process.GetProcessesByName(WatchdogSettings.ClientProcessName))
        {
            using (process)
            {
                try
                {
                    if (process.SessionId == sessionId && !process.HasExited)
                    {
                        return true;
                    }
                }
                catch
                {
                    // 进程可能刚好退出，忽略这类竞态错误。
                }
            }
        }

        return false;
    }

    // 在指定活动用户桌面会话中启动客户端。
    private bool StartClientInSession(uint sessionId)
    {
        // Windows API 句柄必须手动释放，先统一初始化为空。
        IntPtr userToken = IntPtr.Zero;
        IntPtr primaryToken = IntPtr.Zero;
        IntPtr environment = IntPtr.Zero;
        NativeMethods.ProcessInformation processInfo = default;

        try
        {
            // 获取活动用户会话的令牌，服务进程需要靠它把客户端拉到用户桌面。
            if (!NativeMethods.WTSQueryUserToken(sessionId, out userToken))
            {
                LogLastWin32Failure("获取当前用户令牌失败");
                return false;
            }

            // 复制成主令牌，CreateProcessAsUser 需要主令牌才能启动进程。
            if (!NativeMethods.DuplicateTokenEx(
                userToken,
                NativeMethods.TokenAllAccess,
                IntPtr.Zero,
                NativeMethods.SecurityImpersonation,
                NativeMethods.TokenPrimary,
                out primaryToken))
            {
                LogLastWin32Failure("复制当前用户令牌失败");
                return false;
            }

            // 创建用户环境变量块，失败时也允许继续启动，只是不带完整用户环境。
            if (!NativeMethods.CreateEnvironmentBlock(out environment, primaryToken, false))
            {
                environment = IntPtr.Zero;
            }

            // 指定启动到交互桌面，并隐藏 cmd 窗口。
            var startupInfo = new NativeMethods.StartupInfo
            {
                Cb = Marshal.SizeOf<NativeMethods.StartupInfo>(),
                Desktop = @"winsta0\default",
                Flags = NativeMethods.StartfUseShowWindow,
                ShowWindow = NativeMethods.SwHide,
            };
            var commandLine = BuildClientStartCommandLine();
            var creationFlags = NativeMethods.CreateUnicodeEnvironment | NativeMethods.CreateNoWindow;

            // 通过用户令牌启动隐藏 cmd，再由 cmd start 拉起 SMB 上的客户端 EXE。
            if (!NativeMethods.CreateProcessAsUser(
                primaryToken,
                GetCommandProcessorPath(),
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                creationFlags,
                environment,
                Environment.GetFolderPath(Environment.SpecialFolder.System),
                ref startupInfo,
                out processInfo))
            {
                LogLastWin32Failure($"启动客户端失败：{_config.ClientPath}");
                return false;
            }

            ClearFailure();
            FileLogger.Write($"已请求启动客户端，启动进程 PID={processInfo.ProcessId}，Session={sessionId}。");
            return true;
        }
        finally
        {
            // 释放 CreateProcessAsUser 返回的进程句柄。
            if (processInfo.Process != IntPtr.Zero)
            {
                NativeMethods.CloseHandle(processInfo.Process);
            }

            // 释放 CreateProcessAsUser 返回的线程句柄。
            if (processInfo.Thread != IntPtr.Zero)
            {
                NativeMethods.CloseHandle(processInfo.Thread);
            }

            // 释放用户环境变量块。
            if (environment != IntPtr.Zero)
            {
                NativeMethods.DestroyEnvironmentBlock(environment);
            }

            // 释放复制出来的主令牌。
            if (primaryToken != IntPtr.Zero)
            {
                NativeMethods.CloseHandle(primaryToken);
            }

            // 释放原始用户令牌。
            if (userToken != IntPtr.Zero)
            {
                NativeMethods.CloseHandle(userToken);
            }
        }
    }

    // 读取最近一次 Win32 API 错误码并写入日志。
    private void LogLastWin32Failure(string prefix)
    {
        var error = Marshal.GetLastWin32Error();
        LogFailure($"{prefix}，错误码：{error}。");
    }

    // 构造启动客户端的命令行，使用 cmd /c start 兼容 UNC/SMB 路径。
    private string BuildClientStartCommandLine()
    {
        return $"\"{GetCommandProcessorPath()}\" /d /c start \"\" \"{_config.ClientPath}\"";
    }

    // 获取系统 cmd.exe 路径，避免依赖 PATH 环境变量。
    private static string GetCommandProcessorPath()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe");
    }

    // 写失败日志：大于 0 按时间冷却，等于 0 时同一类错误只写一次。
    private void LogFailure(string message)
    {
        var now = DateTimeOffset.Now;
        if (_config.RetryLogSeconds <= 0)
        {
            if (!_failureMessagesLoggedWithoutCooldown.Add(message))
            {
                return;
            }
        }
        else if (_failureLogTimes.TryGetValue(message, out var lastLogTime)
            && now - lastLogTime < TimeSpan.FromSeconds(_config.RetryLogSeconds))
        {
            return;
        }

        _failureLogTimes[message] = now;
        FileLogger.Write(message);
    }

    // 清理按时间冷却状态；0 值模式的“一次性”记录保留到进程退出，确保不会重复刷日志。
    private void ClearFailure()
    {
        _failureLogTimes.Clear();
    }

    // 给每次后端请求套当前配置的超时时间，HttpClient 本身保持无限超时以便运行期动态调整。
    private CancellationTokenSource CreateHttpTimeoutToken()
    {
        return new CancellationTokenSource(TimeSpan.FromSeconds(_config.HttpTimeoutSeconds));
    }
}

// 请求后端策略接口的请求体：后端用机器名、IP、MAC 判断当前教室策略。
internal sealed record ClientPolicyRequest(string MachineName, string? IpAddress, string? MacAddress);

// 后端策略接口返回体：守护服务主要关心 systemEnabled/shouldExit，并顺带接收 Watchdog 配置。
internal sealed record ClientPolicyResponse(
    bool Ok,
    bool? SystemEnabled,
    bool? ShouldExit,
    string? Message,
    string? ClassroomName,
    string? DeviceRole,
    WatchdogConfigResponse? WatchdogConfig);

// 后端下发的 Watchdog 运行期配置，字段来自 tp_smsj_watchdog_config。
internal sealed record WatchdogConfigResponse(
    string? ClientPath,
    int? CheckSeconds,
    int? PolicySeconds,
    int? SessionSeconds,
    int? AliveStaleSeconds,
    int? HttpTimeoutSeconds,
    int? RetryLogSeconds,
    bool? SessionGuard,
    bool? AliveGuard);

// Watchdog 本地实际使用的配置；任何非法配置都回退到内置默认值。
internal sealed record WatchdogRuntimeConfig(
    string ClientPath,
    int CheckSeconds,
    int PolicySeconds,
    int SessionSeconds,
    int AliveStaleSeconds,
    int HttpTimeoutSeconds,
    int RetryLogSeconds,
    bool SessionGuard,
    bool AliveGuard)
{
    public static WatchdogRuntimeConfig Default { get; } = FromLocalSettings(WatchdogLocalSettings.Current);

    public static WatchdogRuntimeConfig FromResponse(WatchdogConfigResponse? response)
    {
        if (response is null)
        {
            return Default;
        }

        return new WatchdogRuntimeConfig(
            NormalizeClientPath(response.ClientPath, Default.ClientPath),
            NormalizeRange(response.CheckSeconds, Default.CheckSeconds, 1, 60),
            NormalizeRange(response.PolicySeconds, Default.PolicySeconds, 2, 300),
            NormalizeRange(response.SessionSeconds, Default.SessionSeconds, 1, 60),
            NormalizeRange(response.AliveStaleSeconds, Default.AliveStaleSeconds, 0, 600),
            NormalizeRange(response.HttpTimeoutSeconds, Default.HttpTimeoutSeconds, 1, 30),
            NormalizeRange(response.RetryLogSeconds, Default.RetryLogSeconds, 0, 300),
            response.SessionGuard ?? Default.SessionGuard,
            response.AliveGuard ?? Default.AliveGuard);
    }

    private static WatchdogRuntimeConfig FromLocalSettings(WatchdogLocalSettings settings)
    {
        return new WatchdogRuntimeConfig(
            NormalizeClientPath(settings.ClientPath, DeploymentSettings.DefaultClientPath),
            NormalizeRange(settings.CheckSeconds, WatchdogSettings.CheckSeconds, 1, 60),
            NormalizeRange(settings.PolicySeconds, WatchdogSettings.PolicyCheckSeconds, 2, 300),
            NormalizeRange(settings.SessionSeconds, WatchdogSettings.SessionCheckSeconds, 1, 60),
            NormalizeRange(settings.AliveStaleSeconds, WatchdogSettings.ClientAliveStaleSeconds, 0, 600),
            NormalizeRange(settings.HttpTimeoutSeconds, 3, 1, 30),
            NormalizeRange(settings.RetryLogSeconds, WatchdogSettings.RetryLogSeconds, 0, 300),
            settings.SessionGuard,
            settings.AliveGuard);
    }

    public string Signature()
    {
        return string.Join("|", ClientPath, CheckSeconds, PolicySeconds, SessionSeconds, AliveStaleSeconds, HttpTimeoutSeconds, RetryLogSeconds, SessionGuard, AliveGuard);
    }

    private static string NormalizeClientPath(string? value, string fallback)
    {
        var text = (value ?? "").Trim();
        if (string.IsNullOrWhiteSpace(text) || text.Length > 500)
        {
            return fallback;
        }

        if (text.IndexOfAny(new[] { '\r', '\n', '"', '<', '>', '|' }) >= 0)
        {
            return fallback;
        }

        if (!text.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
        {
            return fallback;
        }

        if (!text.StartsWith(@"\\", StringComparison.Ordinal) && !IsDrivePath(text))
        {
            return fallback;
        }

        return text;
    }

    private static int NormalizeRange(int? value, int fallback, int min, int max)
    {
        if (value is null)
        {
            return fallback;
        }

        return Math.Min(max, Math.Max(min, value.Value));
    }

    private static bool IsDrivePath(string value)
    {
        return value.Length >= 3
            && char.IsLetter(value[0])
            && value[1] == ':'
            && (value[2] == '\\' || value[2] == '/');
    }
}

// 守护服务复用 /api/heartbeat 校验本机缓存会话是否仍然有效。
internal sealed record WatchdogHeartbeatRequest(
    string MachineId,
    string MachineName,
    string? IpAddress,
    string? MacAddress,
    string Status,
    string? CurrentUserName,
    string? CurrentSessionId,
    string Source);

// /api/heartbeat 返回体中守护服务关心的字段。
internal sealed record WatchdogHeartbeatResponse(
    bool Ok,
    bool? IpAllowed,
    bool SessionExpired,
    string? Message,
    bool? SystemEnabled,
    bool? ShouldExit);

// 客户端 session.json 记录，字段与 Client/MainWindow.xaml.cs 的 SessionCacheRecord 保持一致。
internal sealed record CachedSessionRecord(
    string MachineId,
    string SessionId,
    string? StudentNo,
    string? Name,
    DateTimeOffset SavedAt);

// 守护服务读取客户端缓存，用于在客户端自身失联时兜底挤下线。
internal static class WatchdogSessionCache
{
    private static readonly JsonSerializerOptions CacheJsonOptions = new(JsonSerializerDefaults.Web);

    public static CachedSessionRecord? Load()
    {
        try
        {
            var path = CachePath();
            if (!File.Exists(path))
            {
                return null;
            }

            var json = File.ReadAllText(path);
            return JsonSerializer.Deserialize<CachedSessionRecord>(json, CacheJsonOptions);
        }
        catch
        {
            return null;
        }
    }

    public static void Clear()
    {
        try
        {
            var path = CachePath();
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch
        {
        }
    }

    private static string CachePath()
    {
        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            "RealNameSimple",
            "session.json");
    }
}

// 读取客户端 UI 线程周期更新的活性文件。
internal static class WatchdogClientAliveMarker
{
    public static DateTimeOffset? GetLastWriteTimeUtc()
    {
        try
        {
            var path = MarkerPath();
            if (!File.Exists(path))
            {
                return null;
            }

            return new DateTimeOffset(File.GetLastWriteTimeUtc(path), TimeSpan.Zero);
        }
        catch
        {
            return null;
        }
    }

    private static string MarkerPath()
    {
        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            "RealNameSimple",
            "client.alive");
    }
}

// 本机网络信息工具：获取用于教室匹配的 IPv4 和物理 MAC。
internal static class WatchdogNetworkHelper
{
    // 获取优先网卡的 IPv4 地址，排除 127.0.0.1。
    public static string? GetIpAddress()
    {
        return GetCandidateNetworkInterfaces()
            .SelectMany(item => item.GetIPProperties().UnicastAddresses)
            .Where(item => item.Address.AddressFamily == AddressFamily.InterNetwork)
            .Select(item => item.Address.ToString())
            .FirstOrDefault(item => !item.StartsWith("127.", StringComparison.Ordinal));
    }

    // 获取优先网卡的 MAC 地址，格式为 AA-BB-CC-DD-EE-FF。
    public static string? GetMacAddress()
    {
        return GetCandidateNetworkInterfaces()
            .Select(item => item.GetPhysicalAddress().GetAddressBytes())
            .Where(bytes => bytes.Length > 0)
            .Select(bytes => string.Join("-", bytes.Select(item => item.ToString("X2"))))
            .FirstOrDefault();
    }

    // 筛选可用于实名上机识别的真实网卡，并按有线优先排序。
    private static IEnumerable<NetworkInterface> GetCandidateNetworkInterfaces()
    {
        return NetworkInterface.GetAllNetworkInterfaces()
            .Where(item => item.OperationalStatus == OperationalStatus.Up)
            .Where(item => item.NetworkInterfaceType is NetworkInterfaceType.Ethernet or NetworkInterfaceType.GigabitEthernet or NetworkInterfaceType.FastEthernetFx or NetworkInterfaceType.FastEthernetT or NetworkInterfaceType.Wireless80211)
            .Where(item => !IsVirtualAdapter(item))
            .Where(item => HasValidIpv4Address(item))
            .Where(item => HasValidMacAddress(item))
            .OrderBy(item => AdapterPriority(item.NetworkInterfaceType))
            .ThenBy(item => item.Name, StringComparer.OrdinalIgnoreCase);
    }

    // 判断网卡是否有可用 IPv4 地址。
    private static bool HasValidIpv4Address(NetworkInterface item)
    {
        return item.GetIPProperties().UnicastAddresses.Any(address =>
            address.Address.AddressFamily == AddressFamily.InterNetwork &&
            !address.Address.ToString().StartsWith("127.", StringComparison.Ordinal));
    }

    // 判断网卡是否有物理地址。
    private static bool HasValidMacAddress(NetworkInterface item)
    {
        return item.GetPhysicalAddress().GetAddressBytes().Length > 0;
    }

    // 网卡排序权重：有线网卡优先，无线网卡其次。
    private static int AdapterPriority(NetworkInterfaceType type)
    {
        return type is NetworkInterfaceType.Ethernet or NetworkInterfaceType.GigabitEthernet or NetworkInterfaceType.FastEthernetFx or NetworkInterfaceType.FastEthernetT ? 0 : 1;
    }

    // 排除虚拟网卡、蓝牙、回环、隧道等不适合作为机房识别依据的适配器。
    private static bool IsVirtualAdapter(NetworkInterface item)
    {
        var text = $"{item.Name} {item.Description}".ToLowerInvariant();
        return text.Contains("virtual")
            || text.Contains("vmware")
            || text.Contains("hyper-v")
            || text.Contains("bluetooth")
            || text.Contains("loopback")
            || text.Contains("tap")
            || text.Contains("tunnel");
    }
}

// 简单文件日志：服务模式写文件，调试模式同时输出到控制台。
internal static class FileLogger
{
    // 多线程写日志锁，避免 Timer 回调和命令行输出并发写同一个文件。
    private static readonly object Gate = new();
    private static bool _bootLogPrepared;
    private static bool _existingLogSanitized;

    private static readonly Regex UrlPattern = new(@"(?i)\bhttps?://[^\s，。；、""'<>]+", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex UncPathPattern = new(@"\\\\[^\s，。；、""']+", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex WindowsPathPattern = new(@"(?i)\b[A-Z]:\\[^\r\n，。；、""']+", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex HostPortPattern = new(@"(?i)(?<![\w.-])(?:localhost|(?=[a-z0-9.-]*[a-z])[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?):\d{2,5}(?!\d)", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex Ipv4Pattern = new(@"(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?::\d{1,5})?(?![\d.])", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex BracketedIpv6Pattern = new(@"\[[0-9a-fA-F:]+\](?::\d{1,5})?", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex IdentifierPattern = new(@"(?i)\b(machineId|sessionId|commandId|token)\s*=\s*[^\s,，；]+", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex ConfigurationValuePattern = new(@"(?i)\b(server|serverUrl|clientPath)\s*=\s*[^\s,，；]+", RegexOptions.Compiled | RegexOptions.CultureInvariant);

    // 写一行日志到 C:\ProgramData\RealNameSimple\Watchdog\watchdog.log。
    public static void Write(string message)
    {
        var line = $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {Sanitize(message)}";

        // 交互调试时同步打印到控制台，便于现场观察。
        if (Environment.UserInteractive)
        {
            Console.WriteLine(line);
        }

        try
        {
            // 文件日志目录不存在时自动创建。
            lock (Gate)
            {
                var folder = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                    "RealNameSimple",
                    "Watchdog");
                Directory.CreateDirectory(folder);
                var path = Path.Combine(folder, "watchdog.log");
                if (!_bootLogPrepared)
                {
                    _bootLogPrepared = RealName.Simple.BootLogReset.TryPrepare(path);
                }
                SanitizeExistingLog(path);
                File.AppendAllText(path, line + Environment.NewLine, Encoding.UTF8);
            }
        }
        catch
        {
            // 日志写入失败不能影响守护主流程。
        }
    }

    private static string Sanitize(string message)
    {
        var sanitized = UrlPattern.Replace(message ?? string.Empty, "[地址已隐藏]");
        sanitized = UncPathPattern.Replace(sanitized, "[网络路径已隐藏]");
        sanitized = WindowsPathPattern.Replace(sanitized, "[本机路径已隐藏]");
        sanitized = HostPortPattern.Replace(sanitized, "[地址已隐藏]");
        sanitized = Ipv4Pattern.Replace(sanitized, "[IP已隐藏]");
        sanitized = BracketedIpv6Pattern.Replace(sanitized, "[IP已隐藏]");
        sanitized = IdentifierPattern.Replace(sanitized, match => $"{match.Groups[1].Value}=[标识已隐藏]");
        return ConfigurationValuePattern.Replace(sanitized, match => $"{match.Groups[1].Value}=[配置值已隐藏]");
    }

    private static void SanitizeExistingLog(string path)
    {
        if (_existingLogSanitized)
        {
            return;
        }

        if (!File.Exists(path))
        {
            _existingLogSanitized = true;
            return;
        }

        var existing = File.ReadAllText(path);
        var sanitized = Sanitize(existing);
        if (!string.Equals(existing, sanitized, StringComparison.Ordinal))
        {
            File.WriteAllText(path, sanitized, Encoding.UTF8);
        }
        _existingLogSanitized = true;
    }
}

// Win32 API 封装：用于枚举活动用户会话并在用户桌面中启动客户端。
internal static class NativeMethods
{
    // DuplicateTokenEx 需要的完整令牌访问权限。
    public const uint TokenAllAccess = 0x000F01FF;

    // 安全模拟级别：SecurityImpersonation。
    public const int SecurityImpersonation = 2;

    // 令牌类型：主令牌，CreateProcessAsUser 需要这个类型。
    public const int TokenPrimary = 1;

    // 创建进程时使用 Unicode 环境变量块。
    public const uint CreateUnicodeEnvironment = 0x00000400;

    // 创建进程时不显示控制台窗口。
    public const uint CreateNoWindow = 0x08000000;

    // STARTUPINFO.Flags：启用 ShowWindow 字段。
    public const int StartfUseShowWindow = 0x00000001;

    // SW_HIDE：隐藏窗口。
    public const short SwHide = 0;

    // WTS 当前服务器句柄，IntPtr.Zero 表示本机。
    private static readonly IntPtr WtsCurrentServerHandle = IntPtr.Zero;

    // 枚举当前本机所有活动用户桌面会话 ID。
    public static IEnumerable<uint> GetActiveUserSessionIds()
    {
        IntPtr sessionInfoPointer = IntPtr.Zero;
        try
        {
            // 调用 WTS API 获取会话数组指针和数量。
            if (!WTSEnumerateSessions(WtsCurrentServerHandle, 0, 1, out sessionInfoPointer, out var count))
            {
                yield break;
            }

            // 逐个读取 WtsSessionInfo，只返回活动状态且非 0 的用户会话。
            var dataSize = Marshal.SizeOf<WtsSessionInfo>();
            for (var index = 0; index < count; index++)
            {
                var itemPointer = IntPtr.Add(sessionInfoPointer, index * dataSize);
                var item = Marshal.PtrToStructure<WtsSessionInfo>(itemPointer);
                if (item.SessionId != 0 && item.State == WtsConnectStateClass.WTSActive)
                {
                    yield return item.SessionId;
                }
            }
        }
        finally
        {
            // WTSEnumerateSessions 分配的内存必须用 WTSFreeMemory 释放。
            if (sessionInfoPointer != IntPtr.Zero)
            {
                WTSFreeMemory(sessionInfoPointer);
            }
        }
    }

    // 枚举终端服务会话，返回 unmanaged 内存，需要手动释放。
    [DllImport("wtsapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WTSEnumerateSessions(
        IntPtr serverHandle,
        int reserved,
        int version,
        out IntPtr sessionInfo,
        out int count);

    // 释放 WTSEnumerateSessions 返回的 unmanaged 内存。
    [DllImport("wtsapi32.dll")]
    private static extern void WTSFreeMemory(IntPtr memory);

    // 获取指定活动用户会话的用户令牌。
    [DllImport("wtsapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool WTSQueryUserToken(uint sessionId, out IntPtr token);

    // 复制用户令牌并转换为可启动进程的主令牌。
    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool DuplicateTokenEx(
        IntPtr existingToken,
        uint desiredAccess,
        IntPtr tokenAttributes,
        int impersonationLevel,
        int tokenType,
        out IntPtr newToken);

    // 为指定用户令牌创建用户环境变量块。
    [DllImport("userenv.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CreateEnvironmentBlock(out IntPtr environment, IntPtr token, bool inherit);

    // 释放 CreateEnvironmentBlock 创建的环境变量块。
    [DllImport("userenv.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool DestroyEnvironmentBlock(IntPtr environment);

    // 使用指定用户令牌创建进程，把客户端拉到真实用户桌面。
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CreateProcessAsUser(
        IntPtr token,
        string? applicationName,
        string commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string? currentDirectory,
        ref StartupInfo startupInfo,
        out ProcessInformation processInformation);

    // 关闭 Win32 句柄，令牌、进程、线程句柄都用它释放。
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseHandle(IntPtr handle);

    // CreateProcessAsUser 使用的启动参数结构，对应 Win32 STARTUPINFO。
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct StartupInfo
    {
        // 结构体大小，调用前必须填写。
        public int Cb;

        // 保留字段，当前不用。
        public string? Reserved;

        // 目标桌面，winsta0\default 表示当前交互桌面。
        public string? Desktop;

        // 窗口标题，当前不用。
        public string? Title;

        // 窗口初始 X 坐标，当前不用。
        public int X;

        // 窗口初始 Y 坐标，当前不用。
        public int Y;

        // 窗口初始宽度，当前不用。
        public int XSize;

        // 窗口初始高度，当前不用。
        public int YSize;

        // 控制台缓冲区宽度，当前不用。
        public int XCountChars;

        // 控制台缓冲区高度，当前不用。
        public int YCountChars;

        // 控制台颜色属性，当前不用。
        public int FillAttribute;

        // 启动标志，这里使用 StartfUseShowWindow。
        public int Flags;

        // 窗口显示方式，这里使用 SwHide 隐藏窗口。
        public short ShowWindow;

        // 保留字段，当前不用。
        public short Reserved2;

        // 保留指针，当前不用。
        public IntPtr Reserved2Pointer;

        // 标准输入句柄，当前不用。
        public IntPtr StdInput;

        // 标准输出句柄，当前不用。
        public IntPtr StdOutput;

        // 标准错误句柄，当前不用。
        public IntPtr StdError;
    }

    // CreateProcessAsUser 返回的进程和线程信息。
    [StructLayout(LayoutKind.Sequential)]
    public struct ProcessInformation
    {
        // 新进程句柄，使用后必须 CloseHandle。
        public IntPtr Process;

        // 主线程句柄，使用后必须 CloseHandle。
        public IntPtr Thread;

        // 新进程 PID，用于日志展示。
        public int ProcessId;

        // 新进程主线程 ID，当前只保留不使用。
        public int ThreadId;
    }

    // WTS 会话信息结构，对应 Win32 WTS_SESSION_INFO。
    [StructLayout(LayoutKind.Sequential)]
    private struct WtsSessionInfo
    {
        // Windows 会话 ID。
        public uint SessionId;

        // 会话站名称。
        [MarshalAs(UnmanagedType.LPWStr)]
        public string? WinStationName;

        // 会话连接状态。
        public WtsConnectStateClass State;
    }

    // WTS 会话连接状态枚举。
    private enum WtsConnectStateClass
    {
        // 活动会话，可用于启动客户端。
        WTSActive,

        // 已连接但不一定是活动桌面。
        WTSConnected,

        // 正在连接查询。
        WTSConnectQuery,

        // 影子会话。
        WTSShadow,

        // 已断开连接。
        WTSDisconnected,

        // 空闲状态。
        WTSIdle,

        // 正在监听。
        WTSListen,

        // 正在重置。
        WTSReset,

        // 会话关闭中。
        WTSDown,

        // 初始化中。
        WTSInit,
    }
}
