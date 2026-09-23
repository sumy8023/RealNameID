using System.IO;
using System.ComponentModel;
using System.Diagnostics;
using System.Net.Http;
using System.Net.Http.Json;
using System.Net.NetworkInformation;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using Microsoft.Web.WebView2.Core;
using System.Management;
using Drawing = System.Drawing;
using Forms = System.Windows.Forms;

namespace RealName.SimpleClient;

// 客户端主窗口：承载登录 WebView、登录后的右下角状态卡片、心跳和锁屏控制。
public partial class MainWindow : Window
{
    private const string InvalidIpMessage = "非法IP，请联系机房管理员";

    // WebView/C# 与后端交互统一使用 Web 风格 JSON 命名。
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    // Win32 扩展窗口样式位置，用于控制登录后小卡片是否进入 Alt+Tab 列表。
    private const int GwlExStyle = -20;

    // 工具窗口不会出现在 Alt+Tab 中，登录后右下角小卡片使用这个样式。
    private const int WsExToolWindow = 0x00000080;

    // 普通应用窗口样式，切成工具窗口时需要移除。
    private const int WsExAppWindow = 0x00040000;

    private const uint SwpNoSize = 0x0001;
    private const uint SwpNoMove = 0x0002;
    private const uint SwpNoZOrder = 0x0004;
    private const uint SwpNoActivate = 0x0010;
    private const uint SwpFrameChanged = 0x0020;

    // GetWindow：获取 Z 序中位于当前窗口上方的前一个窗口。
    private const uint GwHwndPrev = 3;

    // MonitorFromWindow：即使窗口不在任何显示器内，也返回距离最近的显示器。
    private const uint MonitorDefaultToNearest = 2;

    // 兼容窗口阴影和不同 DPI 下的少量边界误差。
    private const int FullscreenCoverageTolerancePixels = 16;

    // 外部全屏覆盖检测间隔；检测本身不调整 Z 序或输入焦点。
    private static readonly TimeSpan FullscreenCoverageCheckInterval = TimeSpan.FromMilliseconds(500);

    // 失焦后给教学广播窗口留出完成全屏切换的时间，避免过早抢回造成一次闪烁。
    private static readonly TimeSpan FullscreenCoverageSettleDelay = TimeSpan.FromMilliseconds(300);

    // 登录窗口默认宽度，单位：WPF 设备无关像素。
    private const double LoginWindowWidth = 1100;

    // 登录窗口默认高度，单位：WPF 设备无关像素。
    private const double LoginWindowHeight = 720;

    // 登录窗口最小宽度，避免调试窗口被缩得内容溢出。
    private const double LoginWindowMinWidth = 860;

    // 登录窗口最小高度，避免登录页内容被压扁。
    private const double LoginWindowMinHeight = 560;

    // 登录成功后的右下角状态卡片宽度。
    private const double SessionWindowWidth = 316;

    // 登录成功后的右下角状态卡片高度。
    private const double SessionWindowHeight = 112;

    // 右下角状态卡片距离工作区边缘的间距。
    private const double SessionWindowMargin = 16;

    // 右下角状态卡片圆角半径，用 Win32 窗口区域裁剪实现。
    private const double SessionWindowCornerRadius = 12;

    // 访问后端 API 的 HTTP 客户端，BaseAddress 来自 appsettings.jsonc。
    private readonly HttpClient _http = new();

    // 客户端本地配置。
    private readonly ClientSettings _settings;

    // 当前客户端运行期配置；启动时使用本地默认值，后端下发成功后覆盖。
    private ClientRuntimeConfig _clientConfig;

    // 当前电脑稳定机器 ID，优先 BIOS/系统 UUID，其次物理 MAC。
    private readonly string _machineId;

    // 心跳定时器，周期可以被后端动态下发配置调整。
    private readonly PeriodicTimer _timer;

    // 客户端配置刷新定时器，周期由 tp_smsj_client_config.config_refresh_seconds 控制。
    private readonly PeriodicTimer _configRefreshTimer;

    // UI 线程活性计时器，供 Watchdog 判断客户端是否假死未响应。
    private readonly System.Windows.Threading.DispatcherTimer _aliveTimer;

    // 外部全屏覆盖检测计时器，用于兼容极域等教学广播窗口。
    private readonly System.Windows.Threading.DispatcherTimer _fullscreenCoverageTimer;

    // 系统托盘图标，用于登录后最小化状态卡片。
    private readonly Forms.NotifyIcon _trayIcon;

    // 全屏锁定时使用的低级键盘钩子，拦截常见逃逸快捷键。
    private readonly LockKeyboardHook _keyboardHook;

    // 当前心跳周期，单位：秒。
    private int _heartbeatSeconds;

    // 当前客户端状态：Locked 未登录锁定，Unlocked 已登录，Disabled 教室停用。
    private string _status = "Locked";

    // 当前上机会话 ID，对应后端 tp_smsj_sessions.id。
    private string? _sessionId;

    // 当前登录用户显示名。
    private string? _currentUser;

    // 当前登录用户角色：student 或 teacher。
    private string? _currentUserRole;

    // 当前设备角色：student 或 teacher，由服务端按来源 IP 判定。
    private string? _deviceRole;

    // 当前教室是否允许教师下机时联动关机学生机。
    private bool _allowStudentShutdown;

    // 已处理过的远程命令结果；Node重发回执时只重复回报，不重复执行危险操作。
    private readonly Dictionary<string, (string Status, string Message)> _handledCommandResults = new(StringComparer.OrdinalIgnoreCase);

    // WebView 消息处理忙碌标记，防止重复提交。
    private bool _isBusy;

    // 登录后连续心跳失败次数，超过阈值时本地锁定，避免脱离后端后一直保持上机。
    private int _heartbeatFailureCount;

    // 最近一次已记录的客户端配置签名，用于配置变化时写一条日志。
    private string? _lastClientConfigSignature;

    // Node 后端当前是否可用；登录页据此提示服务器连接状态。
    private bool _nodeOnline;

    // 启动阶段先让主窗口透明，待会话恢复确认后再决定显示登录页或右下角卡片。
    private bool _startupLoginRevealPending = true;

    // 登录页 WebView 延迟初始化；恢复会话成功时不初始化，避免登录页在启动阶段闪现。
    private bool _loginViewInitialized;

    // 低级键盘钩子只在登录页真正进入锁屏时安装，避免启动恢复阶段拦截键盘。
    private bool _keyboardHookInstalled;

    // 恢复全屏锁定过程中的防重入标记。
    private bool _isRestoringLockScreen;

    // 是否有外部全屏窗口位于实名登录页上方。
    private bool _isExternalFullscreenCoveringLockScreen;

    // 是否允许窗口关闭；全屏锁定时默认不允许手动关闭。
    private bool _allowClose;

    // 教室停用处理标记，防止重复清理；客户端进程的最终结束由 Watchdog 负责。
    private bool _isExitingForDisabledClassroom;

    // 防止未登录窗口响应最小化时重复进入托盘流程。
    private bool _isMinimizingToTray;

    // 构造主窗口，初始化配置、机器 ID、心跳、托盘和窗口事件。
    public MainWindow()
    {
        InitializeComponent();
        Cursor = System.Windows.Input.Cursors.Arrow;
        LoginView.Cursor = System.Windows.Input.Cursors.Arrow;

        // 主窗口由 App 手动创建，启动恢复完成前不显示窗口。
        Opacity = 0;
        ShowInTaskbar = false;
        WindowStartupLocation = WindowStartupLocation.Manual;
        Left = -32000;
        Top = -32000;

        // 读取本地配置并设置后端地址。
        _settings = ClientSettings.Load();
        _clientConfig = ClientRuntimeConfig.FromSettings(_settings);
        _http.BaseAddress = new Uri(_settings.ServerUrl);
        _http.Timeout = Timeout.InfiniteTimeSpan;

        // 初始化机器 ID 和心跳周期。
        _machineId = MachineIdProvider.GetMachineId();
        _heartbeatSeconds = _clientConfig.HeartbeatSeconds;
        _timer = new PeriodicTimer(TimeSpan.FromSeconds(_heartbeatSeconds));
        _configRefreshTimer = new PeriodicTimer(TimeSpan.FromSeconds(_clientConfig.ConfigRefreshSeconds));
        _aliveTimer = new System.Windows.Threading.DispatcherTimer(System.Windows.Threading.DispatcherPriority.Background)
        {
            Interval = TimeSpan.FromSeconds(_clientConfig.ClientAliveSeconds),
        };
        _aliveTimer.Tick += (_, _) => ClientAliveMarker.Touch();
        _aliveTimer.Start();
        _fullscreenCoverageTimer = new System.Windows.Threading.DispatcherTimer(System.Windows.Threading.DispatcherPriority.Background)
        {
            Interval = FullscreenCoverageCheckInterval,
        };
        _fullscreenCoverageTimer.Tick += OnFullscreenCoverageTimerTick;
        ClientAliveMarker.Touch();
        ClientLog.Info("客户端启动。");

        // 初始化托盘和键盘锁定钩子。
        _trayIcon = CreateTrayIcon();
        _keyboardHook = new LockKeyboardHook(() => IsLockScreenActive);

        // 绑定窗口生命周期、锁屏恢复和快捷键拦截事件。
        Closing += OnClosing;
        System.Windows.Application.Current.SessionEnding += (_, _) => _allowClose = true;
        SourceInitialized += OnSourceInitialized;
        Deactivated += OnWindowDeactivated;
        StateChanged += OnWindowStateChanged;
        PreviewKeyDown += OnPreviewKeyDown;
    }

    // App 手动调用启动逻辑；恢复会话成功时不会显示登录窗口。
    public Task StartClientAsync()
    {
        return Task.Run(StartupBackendInitAsync);
    }

    // 登录页只在需要显示时初始化。初始化期间窗口保持透明，避免 WebView 白屏或登录页闪一下。
    private async Task EnsureLoginViewReadyAsync()
    {
        if (!Dispatcher.CheckAccess())
        {
            await Dispatcher.InvokeAsync(EnsureLoginViewReadyAsync).Task.Unwrap();
            return;
        }

        if (_loginViewInitialized)
        {
            return;
        }

        UnlockedPanel.Visibility = Visibility.Collapsed;
        LoginView.Visibility = Visibility.Visible;
        BeginAnimation(UIElement.OpacityProperty, null);
        Opacity = 0;

        ApplyWindowMode(revealWindow: false, activateWindow: false);

        // 为 WebView2 指定本地用户数据目录，避免 SMB 运行时写共享目录。
        var environment = await CoreWebView2Environment.CreateAsync(null, GetWebView2UserDataFolder());
        await LoginView.EnsureCoreWebView2Async(environment);
        LoginView.CoreWebView2.Settings.AreDevToolsEnabled = false;
        LoginView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
        LoginView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;

        // 将嵌入资源里的 HTML/CSS/JS 拼成完整登录页并加载。
        LoginView.NavigateToString(LoginPageProvider.BuildLoginPage());
        _loginViewInitialized = true;
    }

    // 启动后台初始化：优先恢复缓存会话；恢复失败或超时后再显示登录页。
    private async Task StartupBackendInitAsync()
    {
        try
        {
            // 如果本机有仍为 active 的缓存会话，恢复成功时直接进入右下角小卡片。
            var restored = await TryRestoreSessionAsync();
            if (_isExitingForDisabledClassroom)
            {
                return;
            }

            if (!restored)
            {
                await RevealStartupLoginAsync();
            }

            await LoadClientConfigAsync();
            if (_isExitingForDisabledClassroom)
            {
                return;
            }

            // 客户端启动后立即上报一次 Locked/Unlocked 状态，让后台总览不必等到下一轮心跳才亮机。
            await SendHeartbeatAsync();
        }
        catch (Exception error)
        {
            ClientLog.Error("客户端后台初始化异常，后续心跳会继续重试。", error);
            await RevealStartupLoginAsync();
            await SetNodeConnectionAsync(false, "服务器连接失败，正在重试。");
        }
        finally
        {
            if (!_isExitingForDisabledClassroom)
            {
                // 后台心跳循环，不阻塞 UI 线程。
                _ = Task.Run(HeartbeatLoopAsync);
                // 后台配置刷新循环，不阻塞 UI 线程。
                _ = Task.Run(ClientConfigRefreshLoopAsync);
            }
        }
    }

    // 当前是否处于需要锁屏保护的未登录状态。
    private bool IsLockScreenActive => _clientConfig.FullscreenEnabled && _status != "Unlocked";

    // 窗口关闭时处理锁屏阻止关闭和资源释放。
    private void OnClosing(object? sender, CancelEventArgs e)
    {
        // 全屏锁定时不允许用户直接关窗口，除非内部流程设置了 _allowClose。
        if (IsLockScreenActive && !_allowClose)
        {
            e.Cancel = true;
            EnsureLockScreen();
            return;
        }

        // 真正关闭时释放心跳、键盘钩子和托盘图标。
        _aliveTimer.Stop();
        _fullscreenCoverageTimer.Stop();
        _timer.Dispose();
        _configRefreshTimer.Dispose();
        _keyboardHook.Dispose();
        _trayIcon.Visible = false;
        _trayIcon.Dispose();
    }

    // 获取窗口句柄后挂载 Win32 消息钩子，用于拦截系统菜单关闭/最小化等命令。
    private void OnSourceInitialized(object? sender, EventArgs e)
    {
        var source = (HwndSource?)PresentationSource.FromVisual(this);
        source?.AddHook(WndProc);
        ApplyToolWindowStyle(_status == "Unlocked");
        _fullscreenCoverageTimer.Start();
    }

    // 周期检查极域一类的外部全屏窗口；只检测状态，不周期性争抢 Z 序或输入焦点。
    private void OnFullscreenCoverageTimerTick(object? sender, EventArgs e)
    {
        RefreshExternalFullscreenCoverageState();
    }

    // 窗口失去焦点时先识别是否由全屏教学广播覆盖；覆盖期间不与对方抢焦点。
    private async void OnWindowDeactivated(object? sender, EventArgs e)
    {
        await Task.Delay(FullscreenCoverageSettleDelay);
        if (_allowClose || _isExitingForDisabledClassroom)
        {
            return;
        }

        RefreshExternalFullscreenCoverageState();
        if (!_isExternalFullscreenCoveringLockScreen)
        {
            EnsureLockScreen();
        }
    }

    // 更新外部全屏覆盖状态，并同步暂停或重新启动登录页空闲关机倒计时。
    private void RefreshExternalFullscreenCoverageState()
    {
        // 登录成功或教室停用后只清理检测状态；若只是关闭全屏锁定，则恢复空闲关机策略。
        if (!IsLockScreenActive)
        {
            var shouldRestartIdleShutdown = _isExternalFullscreenCoveringLockScreen
                && _status != "Unlocked"
                && !_isExitingForDisabledClassroom;
            _isExternalFullscreenCoveringLockScreen = false;
            if (shouldRestartIdleShutdown)
            {
                _ = SendToWebAsync(new { type = "idleShutdownRestart" });
            }
            return;
        }

        var covered = IsCoveredByExternalFullscreenWindow();
        if (covered == _isExternalFullscreenCoveringLockScreen)
        {
            return;
        }

        _isExternalFullscreenCoveringLockScreen = covered;
        if (covered)
        {
            ClientLog.Info("检测到外部全屏窗口覆盖登录页，已暂停空闲关机倒计时。");
            _ = SendToWebAsync(new { type = "idleShutdownPause" });
            return;
        }

        ClientLog.Info("外部全屏窗口已退出，已重新启动空闲关机倒计时。");
        _ = SendToWebAsync(new { type = "idleShutdownRestart" });
        EnsureLockScreen();
    }

    // 判断实名登录页上方是否存在其他进程的可见全屏窗口。
    private bool IsCoveredByExternalFullscreenWindow()
    {
        if (!IsVisible || WindowState == WindowState.Minimized)
        {
            return false;
        }

        var handle = new WindowInteropHelper(this).Handle;
        if (handle == IntPtr.Zero)
        {
            return false;
        }

        var candidate = GetWindow(handle, GwHwndPrev);
        for (var inspected = 0; candidate != IntPtr.Zero && inspected < 512; inspected++)
        {
            GetWindowThreadProcessId(candidate, out var candidateProcessId);
            if (candidateProcessId != 0
                && candidateProcessId != (uint)Environment.ProcessId
                && IsWindowVisible(candidate)
                && !IsIconic(candidate)
                && CoversNearestMonitor(candidate))
            {
                return true;
            }

            candidate = GetWindow(candidate, GwHwndPrev);
        }

        return false;
    }

    // 判断窗口矩形是否覆盖其最近显示器，允许少量阴影和 DPI 边界误差。
    private static bool CoversNearestMonitor(IntPtr window)
    {
        if (!GetWindowRect(window, out var windowRect))
        {
            return false;
        }

        var monitor = MonitorFromWindow(window, MonitorDefaultToNearest);
        if (monitor == IntPtr.Zero)
        {
            return false;
        }

        var monitorInfo = new NativeMonitorInfo
        {
            Size = Marshal.SizeOf<NativeMonitorInfo>(),
        };
        if (!GetMonitorInfo(monitor, ref monitorInfo))
        {
            return false;
        }

        var bounds = monitorInfo.Monitor;
        return windowRect.Left <= bounds.Left + FullscreenCoverageTolerancePixels
            && windowRect.Top <= bounds.Top + FullscreenCoverageTolerancePixels
            && windowRect.Right >= bounds.Right - FullscreenCoverageTolerancePixels
            && windowRect.Bottom >= bounds.Bottom - FullscreenCoverageTolerancePixels;
    }

    // 窗口状态变化时恢复锁屏，防止被最小化或最大化破坏锁屏。
    private void OnWindowStateChanged(object? sender, EventArgs e)
    {
        // 未登录时点击系统标题栏最小化，也统一隐藏到托盘，不保留一个最小化窗口按钮。
        if (_status != "Unlocked" && WindowState == WindowState.Minimized)
        {
            if (_isMinimizingToTray)
            {
                return;
            }

            _isMinimizingToTray = true;
            Dispatcher.BeginInvoke(() =>
            {
                try
                {
                    WindowState = WindowState.Normal;
                    MinimizeToTray();
                }
                finally
                {
                    _isMinimizingToTray = false;
                }
            }, System.Windows.Threading.DispatcherPriority.Send);
            return;
        }

        EnsureLockScreen();
    }

    // 后台心跳循环：按当前心跳周期持续向后端上报设备和会话状态。
    private async Task HeartbeatLoopAsync()
    {
        while (!_isExitingForDisabledClassroom && await _timer.WaitForNextTickAsync())
        {
            try
            {
                await SendHeartbeatAsync();
            }
            catch (Exception error)
            {
                ClientLog.Error("心跳循环异常，下一轮将继续重试。", error);
            }
        }
    }

    // 后台配置刷新循环：按当前配置周期重新拉取客户端动态配置。
    private async Task ClientConfigRefreshLoopAsync()
    {
        while (!_isExitingForDisabledClassroom && await _configRefreshTimer.WaitForNextTickAsync())
        {
            await LoadClientConfigAsync();
        }
    }

    // 发送一次心跳，处理服务端返回的启停策略、会话超时和心跳间隔更新。
    private async Task SendHeartbeatAsync()
    {
        // 停用后的客户端不再继续产生心跳；进程结束由 Watchdog 统一处理。
        if (_isExitingForDisabledClassroom)
        {
            return;
        }

        try
        {
            // 上报机器 ID、主机名、IP、MAC、状态、当前用户和会话 ID；教室由后端按 IP 段匹配。
            using var cts = CreateHttpTimeoutToken();
            var response = await _http.PostAsJsonAsync(ApiPath("api/heartbeat"), new HeartbeatRequest(
                _machineId,
                Environment.MachineName,
                NetworkHelper.GetIpAddress(),
                NetworkHelper.GetMacAddress(),
                _status,
                _currentUser,
                _sessionId,
                "client"),
                JsonOptions,
                cts.Token);
            response.EnsureSuccessStatusCode();

            var heartbeat = await response.Content.ReadFromJsonAsync<HeartbeatResponse>(JsonOptions, cts.Token);
            _heartbeatFailureCount = 0;
            await SetNodeConnectionAsync(true, null);

            // 后端可以动态调整客户端心跳间隔，客户端本地最低按 3 秒处理。
            ApplyHeartbeatSeconds(heartbeat?.HeartbeatSeconds);

            // 当前教室停用实名上机系统时，客户端清理状态并退出。
            if (heartbeat?.ShouldExit == true || heartbeat?.SystemEnabled == false)
            {
                await ExitForDisabledClassroomAsync(heartbeat.Message ?? "当前教室未启用实名上机系统，客户端将退出。");
                return;
            }

            // 当前 IP 不在教室 IP 段/教师机 IP 配置内时，提示非法 IP 并禁止继续登录。
            if (heartbeat?.IpAllowed == false)
            {
                var message = heartbeat.Message ?? InvalidIpMessage;
                if (_status == "Unlocked")
                {
                    await LockLocallyAsync(message);
                }
                await SendToWebAsync(new { type = "clientPolicy", ipAllowed = false, message, idleShutdownMinutes = 0 });
                return;
            }

            if (!string.IsNullOrWhiteSpace(heartbeat?.DeviceRole))
            {
                _deviceRole = heartbeat.DeviceRole;
            }
            _allowStudentShutdown = heartbeat?.AllowStudentShutdown == true;

            // 未登录时同步登录页空闲关机策略，用于倒计时提示和自动关机。
            if (_status != "Unlocked" && heartbeat?.IdleShutdownMinutes is not null)
            {
                await SendToWebAsync(new { type = "clientPolicy", ipAllowed = heartbeat.IpAllowed ?? true, message = heartbeat.Message, idleShutdownMinutes = heartbeat.IdleShutdownMinutes });
            }

            // Vue 后台下发的远程下机/关机指令随心跳返回；执行后本轮心跳不再继续处理普通会话状态。
            if (await TryHandleRemoteCommandAsync(heartbeat?.Command))
            {
                return;
            }

            // 服务端判定会话超时时，本地只回到登录页，不再重复调用下机接口。
            if (heartbeat?.SessionExpired == true)
            {
                ClientLog.Warn("服务端要求锁定当前会话。");
                await LockLocallyAsync(heartbeat.Message ?? "本次登录已失效，请重新登录。");
            }
        }
        catch (Exception error)
        {
            ClientLog.Error($"心跳失败：status={_status}", error);
            // 配置无法确认时立即收紧联动权限，避免沿用旧教室策略显示危险操作。
            _allowStudentShutdown = false;
            if (_status == "Unlocked")
            {
                if (_clientConfig.HeartbeatFailLockCount > 0)
                {
                    _heartbeatFailureCount++;
                    if (_heartbeatFailureCount >= _clientConfig.HeartbeatFailLockCount)
                    {
                        ClientLog.Warn($"已登录状态连续 {_clientConfig.HeartbeatFailLockCount} 次心跳失败，执行本地锁定。");
                        await LockLocallyAsync("服务器连接失败，上机会话无法确认，请重新登录。");
                        return;
                    }
                }
            }

            // 未登录时只提示重试；已登录时连续失败会在上面本地锁定。
            await SetNodeConnectionAsync(false, "服务器连接失败，正在重试。");
            await SendToWebAsync(new { type = "status", message = "服务器连接失败，正在重试。" });
        }
    }

    // 客户端启动时尝试恢复本机缓存的未超时会话。
    private async Task<bool> TryRestoreSessionAsync()
    {
        if (!_clientConfig.RestoreSessionEnabled)
        {
            SessionCache.Clear();
            return false;
        }

        var cachedSession = SessionCache.Load();
        if (cachedSession is null)
        {
            return false;
        }

        // 缓存会话必须属于当前 machine_id，否则清理避免串机恢复。
        if (!string.Equals(cachedSession.MachineId, _machineId, StringComparison.OrdinalIgnoreCase)
            || string.IsNullOrWhiteSpace(cachedSession.SessionId))
        {
            SessionCache.Clear();
            return false;
        }

        try
        {
            // 请求后端校验 session 是否仍为当前机器的 active 会话。
            using var cts = CreateHttpTimeoutToken();
            var response = await _http.PostAsJsonAsync(ApiPath("api/restore-session"), new RestoreSessionRequest(
                _machineId,
                Environment.MachineName,
                NetworkHelper.GetIpAddress(),
                NetworkHelper.GetMacAddress(),
                cachedSession.SessionId,
                cachedSession.StudentNo),
                JsonOptions,
                cts.Token);
            var result = await response.Content.ReadFromJsonAsync<RestoreSessionResponse>(JsonOptions, cts.Token);

            // 恢复过程中如果发现教室停用，立即退出客户端。
            if (result?.ShouldExit == true || result?.SystemEnabled == false)
            {
                await ExitForDisabledClassroomAsync(result.Message);
                return false;
            }

            // 恢复成功后直接进入右下角上机卡片，并刷新一次心跳。
            if (response.IsSuccessStatusCode && result?.Allowed == true && !string.IsNullOrWhiteSpace(result.SessionId))
            {
                _status = "Unlocked";
                _sessionId = result.SessionId;
                _currentUser = result.Name ?? cachedSession.Name;
                _currentUserRole = result.UserRole;
                _heartbeatFailureCount = 0;
                SessionCache.Save(new SessionCacheRecord(_machineId, _sessionId, result.StudentNo ?? cachedSession.StudentNo, _currentUser ?? "", DateTimeOffset.UtcNow));
                await SetNodeConnectionAsync(true, null);
                await ShowUnlockedAsync(skipLoginTransition: _startupLoginRevealPending);
                await SendHeartbeatAsync();
                return true;
            }

            // 后端拒绝恢复时清理本地缓存，避免下次继续误恢复。
            SessionCache.Clear();
        }
        catch
        {
            // 服务器临时不可用时保留缓存，下次启动还能再次尝试恢复。
        }

        return false;
    }

    // 处理登录页 WebView 发来的消息：配置请求、登录、报修、自动关机等都从这里分发。
    private async void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        var message = e.TryGetWebMessageAsString();
        ClientFormMessage? form;
        try
        {
            form = JsonSerializer.Deserialize<ClientFormMessage>(message, JsonOptions);
        }
        catch
        {
            return;
        }

        // 登录页请求客户端配置时，由 C# 调后端后再回传给 JS。
        if (form?.Type == "clientConfig")
        {
            _ = Task.Run(async () =>
            {
                await LoadClientConfigAsync();
                if (_isExternalFullscreenCoveringLockScreen)
                {
                    await SendToWebAsync(new { type = "idleShutdownPause" });
                }
            });
            return;
        }

        // 登录请求处理中忽略新的提交类消息，避免重复提交。
        if (_isBusy)
        {
            return;
        }

        // 登录页空闲倒计时结束，请求系统关机。
        if (form?.Type == "idleShutdown")
        {
            ShutdownForIdleLogin();
            return;
        }

        // 登录页电源菜单请求本机执行关机或重启。
        if (form?.Type == "power")
        {
            ExecutePowerAction(form.PowerAction);
            return;
        }

        // 故障报修第一步：校验报修账号是否存在。
        if (form?.Type == "faultCheckStudent")
        {
            await CheckFaultStudentAsync(form);
            return;
        }

        // 故障报修第二步：正式提交故障。
        if (form?.Type == "fault")
        {
            await SubmitFaultAsync(form);
            return;
        }

        // 其他消息不是登录请求则忽略。
        if (form?.Type != "login")
        {
            return;
        }

        // 进入登录处理中状态，并通知页面显示“正在登录”。
        _isBusy = true;
        await SendToWebAsync(new { type = "status", message = "正在登录...", loading = true });

        try
        {
            // 提交登录请求，forceLogin 表示学生确认下线原电脑并登录本机。
            using var cts = CreateHttpTimeoutToken();
            var response = await _http.PostAsJsonAsync(ApiPath("api/login"), new LoginRequest(
                _machineId,
                Environment.MachineName,
                NetworkHelper.GetIpAddress(),
                NetworkHelper.GetMacAddress(),
                form.StudentNo ?? "",
                form.Name ?? "",
                form.Password ?? "",
                form.ForceLogin),
                JsonOptions,
                cts.Token);

            var result = await response.Content.ReadFromJsonAsync<LoginResponse>(JsonOptions, cts.Token);
            await ApplyLoginResponseAsync(result, form.StudentNo);
        }
        catch
        {
            // 登录请求失败时只提示网络错误，保持登录页可继续重试。
            await SendToWebAsync(new { type = "error", message = "无法连接服务器。" });
        }
        finally
        {
            _isBusy = false;
        }
    }

    // 加载后端客户端配置：故障类型、心跳间隔和当前教室空闲关机策略。
    private async Task LoadClientConfigAsync(bool notifyPage = true)
    {
        try
        {
            // /api/client-config 返回故障类型和心跳间隔。
            using var cts = CreateHttpTimeoutToken();
            var result = await _http.GetFromJsonAsync<ClientConfigResponse>(ApiPath("api/client-config"), JsonOptions, cts.Token);
            ApplyClientRuntimeConfig(result);

            // 再请求 /api/client-policy 获取当前 IP 所属教室启停和 out_time。
            var policy = await GetClientPolicyAsync();
            if (policy?.ShouldExit == true || policy?.SystemEnabled == false)
            {
                await ExitForDisabledClassroomAsync(policy.Message);
                return;
            }

            if (!notifyPage)
            {
                await SetNodeConnectionAsync(true, null, notifyPage: false);
                return;
            }

            await SetNodeConnectionAsync(true, null, notifyPage: false);

            // 将配置转发给登录页 JS。
            await SendToWebAsync(new
            {
                type = "clientConfig",
                nodeOnline = true,
                faultTypes = result?.Ok == true ? result.FaultTypes : null,
                loginFastClickMs = _clientConfig.LoginFastClickMs,
                loginCooldownSeconds = _clientConfig.LoginCooldownSeconds,
                faultEnabled = _clientConfig.FaultEnabled,
                ipAllowed = policy?.IpAllowed ?? true,
                message = policy?.Message,
                idleShutdownMinutes = policy?.IpAllowed == false ? 0 : policy?.IdleShutdownMinutes ?? 0,
            });
        }
        catch
        {
            // 后端不可用时回传离线状态，登录页提示服务器连接失败。
            await SetNodeConnectionAsync(false, "服务器连接失败，正在重试。", notifyPage: false);
            if (notifyPage)
            {
                await SendFallbackClientConfigToWebAsync();
            }
        }
    }

    // 后端配置暂不可用时，把客户端内置兜底配置发给登录页，但明确标记 Node 离线。
    private async Task SendFallbackClientConfigToWebAsync()
    {
        await SendToWebAsync(new
        {
            type = "clientConfig",
            nodeOnline = false,
            faultTypes = (IReadOnlyList<string>?)null,
            loginFastClickMs = _clientConfig.LoginFastClickMs,
            loginCooldownSeconds = _clientConfig.LoginCooldownSeconds,
            faultEnabled = _clientConfig.FaultEnabled,
            ipAllowed = true,
            message = "服务器连接失败，正在重试。",
            idleShutdownMinutes = 0,
        });
    }

    // 启动恢复未命中或超时后，才真正显示登录页。
    private async Task RevealStartupLoginAsync()
    {
        if (!_startupLoginRevealPending || _isExitingForDisabledClassroom || _status == "Unlocked")
        {
            return;
        }

        await EnsureLoginViewReadyAsync();

        await Dispatcher.InvokeAsync(() =>
        {
            if (!_startupLoginRevealPending || _isExitingForDisabledClassroom || _status == "Unlocked")
            {
                return;
            }

            _startupLoginRevealPending = false;
            UnlockedPanel.Visibility = Visibility.Collapsed;
            LoginView.Visibility = Visibility.Visible;
            BeginAnimation(UIElement.OpacityProperty, null);
            Opacity = 1;
            ApplyWindowMode();
            Activate();
        });
    }

    // 同步 Node 可用状态给登录页；离线时提示连接失败，恢复时由页面清理提示。
    private async Task SetNodeConnectionAsync(bool online, string? message, bool notifyPage = true)
    {
        var changed = _nodeOnline != online;
        _nodeOnline = online;

        if (!notifyPage || (!changed && online))
        {
            return;
        }

        await SendToWebAsync(new
        {
            type = "nodeConnection",
            online,
            message = online ? (string?)null : message ?? "服务器连接失败，正在重试。",
        });
    }

    // 应用后端下发的客户端运行期配置；缺失或非法值会回到本地默认值。
    private void ApplyClientRuntimeConfig(ClientConfigResponse? response)
    {
        var previous = _clientConfig;
        var next = ClientRuntimeConfig.FromResponse(response, previous);
        _clientConfig = next;

        ApplyHeartbeatSeconds(next.HeartbeatSeconds);

        if (previous.ConfigRefreshSeconds != next.ConfigRefreshSeconds)
        {
            _configRefreshTimer.Period = TimeSpan.FromSeconds(next.ConfigRefreshSeconds);
        }

        if (previous.ClientAliveSeconds != next.ClientAliveSeconds)
        {
            _ = Dispatcher.InvokeAsync(() =>
            {
                _aliveTimer.Interval = TimeSpan.FromSeconds(next.ClientAliveSeconds);
            });
        }

        if (previous.FullscreenEnabled != next.FullscreenEnabled && _status != "Unlocked")
        {
            _ = Dispatcher.InvokeAsync(() =>
            {
                if (_status != "Unlocked")
                {
                    ApplyWindowMode();
                }
            });
        }

        var signature = next.Signature();
        if (!string.Equals(_lastClientConfigSignature, signature, StringComparison.Ordinal))
        {
            _lastClientConfigSignature = signature;
            ClientLog.Info($"已应用客户端配置：心跳={next.HeartbeatSeconds}秒，全屏锁屏={(next.FullscreenEnabled ? "开启" : "关闭")}，失败锁定={(next.HeartbeatFailLockCount > 0 ? $"{next.HeartbeatFailLockCount}次" : "关闭")}，请求超时={next.HttpTimeoutSeconds}秒，配置刷新={next.ConfigRefreshSeconds}秒，登录快点={next.LoginFastClickMs}毫秒，登录冷却={next.LoginCooldownSeconds}秒，故障入口={(next.FaultEnabled ? "开启" : "关闭")}");
        }
    }

    // 登录接口返回结果的处理。
    private async Task ApplyLoginResponseAsync(LoginResponse? result, string? fallbackStudentNo)
    {
        if (result is null || !result.Allowed)
        {
            if (result?.ShouldExit == true || result?.SystemEnabled == false)
            {
                await ExitForDisabledClassroomAsync(result.Message);
                return;
            }

            if (result?.RequiresTakeover == true)
            {
                await SendToWebAsync(new
                {
                    type = "loginConflict",
                    message = result.Message,
                    activePlace = result.ActivePlace,
                    activeSession = result.ActiveSession,
                });
                return;
            }

            if (result?.IpAllowed == false)
            {
                await SendToWebAsync(new
                {
                    type = "clientPolicy",
                    ipAllowed = false,
                    message = result.Message ?? InvalidIpMessage,
                    idleShutdownMinutes = 0,
                });
                return;
            }

            await SendToWebAsync(new { type = "error", message = result?.Message ?? "登录失败。", toastDurationMs = result?.ToastDurationMs });
            return;
        }

        _status = "Unlocked";
        _sessionId = result.SessionId;
        _currentUser = result.Name;
        _currentUserRole = result.UserRole;
        _heartbeatFailureCount = 0;
        _isBusy = false;
        if (!string.IsNullOrWhiteSpace(_sessionId))
        {
            SessionCache.Save(new SessionCacheRecord(_machineId, _sessionId, result.StudentNo ?? fallbackStudentNo ?? "", _currentUser ?? "", DateTimeOffset.UtcNow));
        }
        await ShowUnlockedAsync();
        await SendHeartbeatAsync();
    }

    // 应用后端下发的心跳间隔，运行中直接调整 PeriodicTimer 周期。
    private void ApplyHeartbeatSeconds(int? seconds)
    {
        if (seconds is null)
        {
            return;
        }

        var nextSeconds = NormalizeHeartbeatSeconds(seconds.Value);
        if (nextSeconds == _heartbeatSeconds)
        {
            return;
        }

        _heartbeatSeconds = nextSeconds;
        _timer.Period = TimeSpan.FromSeconds(_heartbeatSeconds);
    }

    // 标准化心跳间隔，客户端最低按 3 秒处理。
    private static int NormalizeHeartbeatSeconds(int seconds)
    {
        return Math.Max(3, seconds);
    }

    // 启动时检查当前教室是否允许运行实名上机客户端。
    private async Task<bool> EnsureSystemEnabledAsync()
    {
        try
        {
            var result = await GetClientPolicyAsync();
            if (result?.ShouldExit == true || result?.SystemEnabled == false)
            {
                await ExitForDisabledClassroomAsync(result.Message);
                return false;
            }
        }
        catch
        {
            // 后端暂时不可用时保持保护行为，后续心跳会继续重试。
        }

        return true;
    }

    // 请求后端客户端策略接口，判断当前 IP 所属教室是否启用和 out_time。
    private async Task<ClientPolicyResponse?> GetClientPolicyAsync()
    {
        using var cts = CreateHttpTimeoutToken();
        var response = await _http.PostAsJsonAsync(ApiPath("api/client-policy"), BuildClientPolicyRequest(), JsonOptions, cts.Token);
        if (!response.IsSuccessStatusCode)
        {
            return null;
        }

        return await response.Content.ReadFromJsonAsync<ClientPolicyResponse>(JsonOptions, cts.Token);
    }

    // 组装客户端策略请求体，包含机器 ID、主机名、IP 和 MAC；教室由后端按 IP 段匹配。
    private ClientPolicyRequest BuildClientPolicyRequest()
    {
        return new ClientPolicyRequest(
            _machineId,
            Environment.MachineName,
            NetworkHelper.GetIpAddress(),
            NetworkHelper.GetMacAddress());
    }

    // 教室停用时清理客户端状态并停止继续使用；客户端进程的关闭由 Watchdog 统一负责。
    private async Task ExitForDisabledClassroomAsync(string? message)
    {
        if (_isExitingForDisabledClassroom)
        {
            return;
        }

        _isExitingForDisabledClassroom = true;
        _status = "Disabled";
        await Dispatcher.InvokeAsync(() => _aliveTimer.Stop());
        _sessionId = null;
        _currentUser = null;
        _currentUserRole = null;
        _deviceRole = null;
        _allowStudentShutdown = false;
        SessionCache.Clear();

        try
        {
            // 尽量把停用提示发给登录页，失败也不影响退出。
            await SendToWebAsync(new { type = "status", message = message ?? "当前教室未启用实名上机系统，客户端将退出。" });
        }
        catch
        {
        }

        // 不在客户端侧 Close/Shutdown，避免与 Watchdog 同时控制进程生命周期。
        // Watchdog 收到同一停用策略后会设置停用锁并结束本客户端进程。
    }

    // 登录页长时间无人登录时执行系统关机。
    private void ShutdownForIdleLogin()
    {
        // 先同步检查一次，避免外部全屏刚出现时与倒计时归零发生竞态。
        RefreshExternalFullscreenCoverageState();

        // 已经登录、教室停用或正被教学广播全屏覆盖时，不执行自动关机。
        if (_status == "Unlocked" || _isExitingForDisabledClassroom || _isExternalFullscreenCoveringLockScreen)
        {
            return;
        }

        _allowClose = true;
        SessionCache.Clear();

        try
        {
            // 立即强制关机：/s 关机，/t 0 不延迟，/f 强制关闭应用。
            Process.Start(new ProcessStartInfo("shutdown.exe")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                ArgumentList = { "/s", "/t", "0", "/f" },
            });
        }
        catch
        {
        }
    }

    private void ExecutePowerAction(string? action)
    {
        if (_status == "Unlocked") return;
        var normalized = String.Equals(action, "restart", StringComparison.OrdinalIgnoreCase) ? "/r" : "/s";
        _allowClose = true;
        try
        {
            Process.Start(new ProcessStartInfo("shutdown.exe")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                ArgumentList = { normalized, "/t", "0", "/f" },
            });
        }
        catch
        {
            _allowClose = false;
            _ = SendToWebAsync(new { type = "status", message = "系统电源操作失败，请联系管理员。" });
        }
    }

    // 处理 Vue 后台通过 Node 心跳下发的远程命令。
    private async Task<bool> TryHandleRemoteCommandAsync(ClientCommand? command)
    {
        var commandId = command?.Id?.Trim();
        var commandType = command?.Type?.Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(commandId) || string.IsNullOrWhiteSpace(commandType))
        {
            return false;
        }
        var commandMessage = command?.Message;
        var originalCommandType = command?.Type ?? commandType;

        if (_handledCommandResults.TryGetValue(commandId, out var previousResult))
        {
            await ReportCommandResultAsync(commandId, previousResult.Status, previousResult.Message);
            return true;
        }

        if (commandType == "force_logout")
        {
            ClientLog.Warn("收到远程下机指令。");
            const string resultMessage = "客户端已执行远程下机";
            _handledCommandResults[commandId] = ("completed", resultMessage);
            await ReportCommandResultAsync(commandId, "completed", resultMessage);
            await LockLocallyAsync(commandMessage ?? "管理员已远程下机，请重新登录。");
            return true;
        }

        if (commandType == "shutdown")
        {
            await ExecuteRemoteShutdownAsync(commandId, commandMessage);
            return true;
        }

        ClientLog.Warn("收到未知远程指令类型。");
        var unknownCommandMessage = $"未知远程指令：{originalCommandType}";
        _handledCommandResults[commandId] = ("failed", unknownCommandMessage);
        await ReportCommandResultAsync(commandId, "failed", unknownCommandMessage);
        return false;
    }

    // 执行远程关机，成功启动系统关机后让服务端结束 active 会话。
    private async Task ExecuteRemoteShutdownAsync(string commandId, string? message)
    {
        try
        {
            ClientLog.Warn("收到远程关机指令。");
            Process.Start(new ProcessStartInfo("shutdown.exe")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                ArgumentList = { "/s", "/t", "0", "/f" },
            });

            _allowClose = true;
            _status = "Locked";
            _sessionId = null;
            _currentUser = null;
            _currentUserRole = null;
            _deviceRole = null;
            _allowStudentShutdown = false;
            _heartbeatFailureCount = 0;
            SessionCache.Clear();

            var resultMessage = "客户端已启动系统关机";
            _handledCommandResults[commandId] = ("completed", resultMessage);
            await ReportCommandResultAsync(commandId, "completed", resultMessage);
        }
        catch (Exception error)
        {
            ClientLog.Error("远程关机失败。", error);
            _handledCommandResults[commandId] = ("failed", error.Message);
            await ReportCommandResultAsync(commandId, "failed", error.Message);
            await SendToWebAsync(new { type = "status", message = "远程关机失败：" + error.Message });
        }
    }

    // 回报远程命令执行结果；失败不影响客户端继续按本地状态处理。
    private async Task ReportCommandResultAsync(string commandId, string status, string message)
    {
        try
        {
            using var cts = CreateHttpTimeoutToken();
            await _http.PostAsJsonAsync(ApiPath("api/command-result"), new CommandResultRequest(
                _machineId,
                commandId,
                status,
                message),
                JsonOptions,
                cts.Token);
        }
        catch (Exception error)
        {
            ClientLog.Error($"远程命令结果回报失败：status={status}", error);
        }
    }

    // 故障报修前校验报修账号是否存在，结果回传给登录页。
    private async Task CheckFaultStudentAsync(ClientFormMessage form)
    {
        if (!_clientConfig.FaultEnabled)
        {
            await SendToWebAsync(new { type = "faultStudentCheckResult", ok = false, message = "故障报修入口已关闭。" });
            return;
        }

        var faultStudentNo = form.FaultStudentNo?.Trim() ?? "";
        if (string.IsNullOrWhiteSpace(faultStudentNo))
        {
            await SendToWebAsync(new { type = "faultStudentCheckResult", ok = false, message = "请输入报修账号。" });
            return;
        }

        try
        {
            // 由后端校验 tp_student/tp_teacher 中是否存在该账号。
            using var cts = CreateHttpTimeoutToken();
            var response = await _http.PostAsJsonAsync(ApiPath("api/fault/check-student"), new FaultStudentCheckRequest(faultStudentNo, form.Name?.Trim()), JsonOptions, cts.Token);
            var result = await response.Content.ReadFromJsonAsync<FaultResponse>(JsonOptions, cts.Token);
            if (response.IsSuccessStatusCode && result?.Ok == true)
            {
                await SendToWebAsync(new { type = "faultStudentCheckResult", ok = true });
                return;
            }

            await SendToWebAsync(new { type = "faultStudentCheckResult", ok = false, message = result?.Message ?? "账号不存在，请检查账号。" });
        }
        catch
        {
            await SendToWebAsync(new { type = "faultStudentCheckResult", ok = false, message = "无法连接服务器，账号校验失败。" });
        }
    }

    // 提交故障报修，后端会写入 tp_smsj_fault。
    private async Task SubmitFaultAsync(ClientFormMessage form)
    {
        if (!_clientConfig.FaultEnabled)
        {
            await SendToWebAsync(new { type = "faultResult", ok = false, message = "故障报修入口已关闭。" });
            return;
        }

        var faultType = form.FaultType?.Trim() ?? "";
        var faultStudentNo = form.FaultStudentNo?.Trim() ?? "";
        var faultInfo = form.FaultInfo?.Trim() ?? "";

        // 类型、报修账号、描述都必须填写。
        if (string.IsNullOrWhiteSpace(faultType) || string.IsNullOrWhiteSpace(faultStudentNo) || string.IsNullOrWhiteSpace(faultInfo))
        {
            await SendToWebAsync(new { type = "faultResult", ok = false, message = "请选择故障类型、填写报修账号和故障描述。" });
            return;
        }

        try
        {
            // 报修时附带当前客户端 IP，方便后台定位机器。
            using var cts = CreateHttpTimeoutToken();
            var response = await _http.PostAsJsonAsync(ApiPath("api/fault"), new FaultRequest(
                NetworkHelper.GetIpAddress(),
                faultType,
                faultStudentNo,
                form.Name?.Trim(),
                faultInfo),
                JsonOptions,
                cts.Token);
            var result = await response.Content.ReadFromJsonAsync<FaultResponse>(JsonOptions, cts.Token);

            if (response.IsSuccessStatusCode && result?.Ok == true)
            {
                await SendToWebAsync(new { type = "faultResult", ok = true, message = result.Message ?? "故障报修已提交，管理员会尽快处理。" });
                return;
            }

            await SendToWebAsync(new { type = "faultResult", ok = false, message = result?.Message ?? "故障报修提交失败。" });
        }
        catch
        {
            await SendToWebAsync(new { type = "faultResult", ok = false, message = "无法连接服务器，故障报修提交失败。" });
        }
    }

    // 右下角状态卡片的“退出上机”按钮事件。
    private async void OnLogoutClicked(object sender, RoutedEventArgs e)
    {
        var canBatchShutdown = string.Equals(_currentUserRole, "teacher", StringComparison.OrdinalIgnoreCase)
            && string.Equals(_deviceRole, "teacher", StringComparison.OrdinalIgnoreCase)
            && _allowStudentShutdown;
        var batchShutdown = false;
        // 卡片模式的主窗口只有右下角一张小卡片，普通模态只能挡住这张卡片本身，
        // 挡不住后面的其他程序。因此确认期间先盖一层全屏遮罩，让点击落在遮罩上。
        var curtain = CreateConfirmCurtain();
        try
        {
            if (canBatchShutdown)
            {
                var dialog = new TeacherLogoutDialog(_allowStudentShutdown) { Owner = curtain };
                if (dialog.ShowDialog() != true) return;
                batchShutdown = dialog.ShutdownStudents;
            }
            else
            {
                var result = System.Windows.MessageBox.Show(curtain, "确认退出当前上机吗？", "退出上机", MessageBoxButton.YesNo, MessageBoxImage.Question);
                if (result != MessageBoxResult.Yes) return;
            }
        }
        finally
        {
            curtain.Close();
        }

        await LogoutAsync(batchShutdown ? "teacher_special_shutdown" : "manual", batchShutdown);
    }

    // 生成确认遮罩：覆盖卡片所在显示器的整屏（含任务栏区域）、置顶、半透明。
    // 遮罩作为确认框的所有者被模态禁用，点击就会被丢弃，不会传到后面的程序。
    private Window CreateConfirmCurtain()
    {
        var bounds = Forms.Screen.FromHandle(new WindowInteropHelper(this).Handle).Bounds;
        var source = PresentationSource.FromVisual(this);
        var fromDevice = source?.CompositionTarget?.TransformFromDevice ?? Matrix.Identity;
        // 显式指定 System.Windows.Point，避免与 WinForms 隐式引入的 System.Drawing.Point 冲突。
        var topLeft = fromDevice.Transform(new System.Windows.Point(bounds.Left, bounds.Top));
        var bottomRight = fromDevice.Transform(new System.Windows.Point(bounds.Right, bounds.Bottom));

        var curtain = new Window
        {
            WindowStyle = WindowStyle.None,
            AllowsTransparency = true,
            Background = new SolidColorBrush(System.Windows.Media.Color.FromArgb(150, 15, 23, 42)),
            ShowInTaskbar = false,
            ResizeMode = ResizeMode.NoResize,
            WindowStartupLocation = WindowStartupLocation.Manual,
            Topmost = true,
            Left = topLeft.X,
            Top = topLeft.Y,
            Width = Math.Max(1, bottomRight.X - topLeft.X),
            Height = Math.Max(1, bottomRight.Y - topLeft.Y),
            Cursor = System.Windows.Input.Cursors.Arrow,
        };
        curtain.Show();
        return curtain;
    }

    // 右下角状态卡片的“最小化”按钮事件。
    private void OnMinimizeToTrayClicked(object sender, RoutedEventArgs e)
    {
        MinimizeToTray();
    }

    // 正常下机流程：通知后端、清理本地会话、回到登录页。
    private async Task LogoutAsync(string reason, bool shutdownStudents = false)
    {
        try
        {
            // 下机接口失败时也要本地锁定，避免客户端卡在已登录状态。
            using var cts = CreateHttpTimeoutToken();
            if (shutdownStudents)
            {
                var response = await _http.PostAsJsonAsync(ApiPath("api/teacher-logout"), new TeacherLogoutRequest(_machineId, _sessionId, NetworkHelper.GetIpAddress(), shutdownStudents), JsonOptions, cts.Token);
                if (!response.IsSuccessStatusCode)
                {
                    var failure = await response.Content.ReadFromJsonAsync<ApiMessage>(JsonOptions, cts.Token);
                    await SendToWebAsync(new { type = "status", message = failure?.Message ?? "联动关机请求失败，当前上机未退出。" });
                    return;
                }
            }
            else
            {
                await _http.PostAsJsonAsync(ApiPath("api/logout"), new LogoutRequest(_machineId, _sessionId, reason), JsonOptions, cts.Token);
            }
        }
        catch
        {
            if (shutdownStudents)
            {
                await SendToWebAsync(new { type = "status", message = "无法连接服务器，联动关机请求未发送。" });
                return;
            }
        }

        // 清理本地会话状态和 session.json 缓存。
        _status = "Locked";
        _sessionId = null;
        _currentUser = null;
        _currentUserRole = null;
        _deviceRole = null;
        _allowStudentShutdown = false;
        _heartbeatFailureCount = 0;
        SessionCache.Clear();

        await EnsureLoginViewReadyAsync();

        // 切回登录页窗口模式。
        await Dispatcher.InvokeAsync(() =>
        {
            _trayIcon.Visible = false;
            UnlockedPanel.Visibility = Visibility.Collapsed;
            LoginView.Visibility = Visibility.Visible;
            ApplyWindowMode();
            Activate();
        });
        await SendToWebAsync(new { type = "reset" });
    }

    // 本地锁定流程：用于服务端判定会话超时，不再调用下机接口。
    private async Task LockLocallyAsync(string message)
    {
        // 清理本地会话状态和缓存。
        _status = "Locked";
        _sessionId = null;
        _currentUser = null;
        _currentUserRole = null;
        _deviceRole = null;
        _allowStudentShutdown = false;
        _heartbeatFailureCount = 0;
        SessionCache.Clear();

        await EnsureLoginViewReadyAsync();

        // 显示登录页并恢复窗口锁屏/调试模式。
        await Dispatcher.InvokeAsync(() =>
        {
            _trayIcon.Visible = false;
            Show();
            UnlockedPanel.Visibility = Visibility.Collapsed;
            LoginView.Visibility = Visibility.Visible;
            ApplyWindowMode();
            Activate();
        });
        await SendToWebAsync(new { type = "reset" });
        await SendToWebAsync(new { type = "status", message });
    }


    // 登录成功后从登录页过渡到右下角上机状态卡片。
    private async Task ShowUnlockedAsync(bool skipLoginTransition = false)
    {
        // UI 操作必须在 Dispatcher 线程执行。
        if (!Dispatcher.CheckAccess())
        {
            await Dispatcher.InvokeAsync(() => ShowUnlockedAsync(skipLoginTransition)).Task.Unwrap();
            return;
        }

        UserText.Text = _currentUser ?? "已登录用户";

        if (skipLoginTransition)
        {
            _startupLoginRevealPending = false;
            BeginAnimation(UIElement.OpacityProperty, null);
            Opacity = 1;
            LoginView.IsEnabled = true;
            _trayIcon.Visible = false;

            Background = UnlockedPanel.Background;
            UnlockedPanel.Visibility = Visibility.Visible;
            UnlockedPanel.Opacity = 1;
            LoginView.Visibility = Visibility.Collapsed;

            ApplySessionWindowMode();
            Show();
            PlayUnlockedPanelIntro();
            return;
        }

        // 先通知 Web 登录页淡出，再淡出 WPF 窗口，减少 WebView 缩放闪黑。
        await SendToWebAsync(new { type = "fadeOut" });
        LoginView.IsEnabled = false;

        try
        {
            // 窗口淡出后隐藏，切换布局到右下角卡片，再淡入。
            await AnimateWindowOpacityAsync(0, TimeSpan.FromMilliseconds(160));

            Hide();
            BeginAnimation(UIElement.OpacityProperty, null);
            Opacity = 0;

            Background = UnlockedPanel.Background;
            UnlockedPanel.Visibility = Visibility.Visible;
            UnlockedPanel.Opacity = 1;
            LoginView.Visibility = Visibility.Collapsed;

            ApplySessionWindowMode();
            Show();

            // 等一帧渲染，确保窗口尺寸/位置更新后再播放卡片入场动画。
            await Dispatcher.InvokeAsync(() => { }, System.Windows.Threading.DispatcherPriority.Render);

            PlayUnlockedPanelIntro();
            await AnimateWindowOpacityAsync(1, TimeSpan.FromMilliseconds(180));
        }
        finally
        {
            // 无论动画是否异常，都恢复窗口透明度和 WebView 可用状态。
            BeginAnimation(UIElement.OpacityProperty, null);
            Opacity = 1;
            LoginView.IsEnabled = true;
        }
    }

    // 播放右下角上机卡片的小幅上移动画。
    private void PlayUnlockedPanelIntro()
    {
        // 确保面板有 TranslateTransform，便于单独控制 Y 轴位移。
        if (UnlockedPanel.RenderTransform is not TranslateTransform transform)
        {
            transform = new TranslateTransform();
            UnlockedPanel.RenderTransform = transform;
        }

        UnlockedPanel.BeginAnimation(UIElement.OpacityProperty, null);
        transform.BeginAnimation(TranslateTransform.YProperty, null);

        UnlockedPanel.Opacity = 1;
        transform.Y = 8;

        var ease = new CubicEase { EasingMode = EasingMode.EaseOut };
        var duration = TimeSpan.FromMilliseconds(180);

        // 从下方 8 像素滑入到当前位置。
        transform.BeginAnimation(TranslateTransform.YProperty, new DoubleAnimation
        {
            From = 8,
            To = 0,
            Duration = duration,
            EasingFunction = ease,
        });
    }

    // 用 Task 包装 WPF 透明度动画，方便登录成功流程按顺序等待动画结束。
    private Task AnimateWindowOpacityAsync(double to, TimeSpan duration)
    {
        BeginAnimation(UIElement.OpacityProperty, null);

        // 无需动画时直接设置目标透明度。
        if (duration <= TimeSpan.Zero || Math.Abs(Opacity - to) < 0.001)
        {
            Opacity = to;
            return Task.CompletedTask;
        }

        var tcs = new TaskCompletionSource<object?>();
        var animation = new DoubleAnimation
        {
            From = Opacity,
            To = to,
            Duration = duration,
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseInOut },
            FillBehavior = FillBehavior.Stop,
        };
        animation.Completed += (_, _) =>
        {
            // FillBehavior.Stop 后需要手动把最终 Opacity 固定到目标值。
            BeginAnimation(UIElement.OpacityProperty, null);
            Opacity = to;
            tcs.TrySetResult(null);
        };

        BeginAnimation(UIElement.OpacityProperty, animation);
        return tcs.Task;
    }

    // 应用登录页窗口模式：全屏锁定模式或开发调试窗口模式。
    private void ApplyWindowMode(bool revealWindow = true, bool activateWindow = true)
    {
        // 先清理右下角卡片模式留下的透明度、裁剪区域和背景。
        BeginAnimation(UIElement.OpacityProperty, null);
        if (revealWindow)
        {
            Opacity = 1;
        }
        LoginView.IsEnabled = true;
        ClearWindowRegion();
        ApplyToolWindowStyle(false);
        SetResourceReference(BackgroundProperty, "BackgroundBrush");

        _trayIcon.Visible = false;
        if (!IsVisible)
        {
            Show();
        }
        ShowInTaskbar = false;

        if (revealWindow && IsLockScreenActive)
        {
            EnsureKeyboardHookInstalled();
        }

        // 现场全屏模式：无边框、不可调整、覆盖虚拟屏幕并置顶。
        if (_clientConfig.FullscreenEnabled)
        {
            MinWidth = 0;
            MinHeight = 0;
            WindowState = WindowState.Normal;
            WindowStyle = WindowStyle.None;
            ResizeMode = ResizeMode.NoResize;
            Background = (System.Windows.Media.Brush)FindResource("BackgroundBrush");
            MoveToFullScreenBounds();
            Topmost = false;
            Topmost = true;
            if (activateWindow)
            {
                Activate();
                Focus();
            }
            RefreshMouseCursor();
            return;
        }

        // 开发调试模式：普通可调整窗口，方便调试时不锁死桌面。
        Topmost = false;
        MinWidth = LoginWindowMinWidth;
        MinHeight = LoginWindowMinHeight;
        WindowStyle = WindowStyle.SingleBorderWindow;
        ResizeMode = ResizeMode.CanResize;
        Width = LoginWindowWidth;
        Height = LoginWindowHeight;
        if (WindowState == WindowState.Maximized)
        {
            WindowState = WindowState.Normal;
        }

        CenterOnWorkArea();
        RefreshMouseCursor();
    }

    // 安装全屏锁屏快捷键钩子，重复调用时保持幂等。
    private void EnsureKeyboardHookInstalled()
    {
        if (_keyboardHookInstalled)
        {
            return;
        }

        _keyboardHook.Install();
        _keyboardHookInstalled = true;
    }

    // 确保窗口维持锁屏状态，用于失焦、最小化、系统命令等场景恢复。
    private void EnsureLockScreen()
    {
        // 不在锁屏状态或已经在恢复过程中时直接跳过。
        if (!IsLockScreenActive || _isRestoringLockScreen || _isExternalFullscreenCoveringLockScreen)
        {
            return;
        }

        _isRestoringLockScreen = true;
        _ = Dispatcher.InvokeAsync(() =>
        {
            try
            {
                // Dispatcher 执行时状态可能已经变化，需要再次判断。
                if (!IsLockScreenActive)
                {
                    return;
                }

                // 强制回到登录页全屏锁定状态。
                UnlockedPanel.Visibility = Visibility.Collapsed;
                LoginView.Visibility = Visibility.Visible;
                ApplyWindowMode();
            }
            finally
            {
                _isRestoringLockScreen = false;
            }
        }, System.Windows.Threading.DispatcherPriority.Send);
    }

    // 应用登录成功后的右下角状态卡片窗口模式。
    private void ApplySessionWindowMode()
    {
        ShowInTaskbar = false;
        ApplyToolWindowStyle(true);
        MinWidth = 0;
        MinHeight = 0;
        WindowState = WindowState.Normal;
        WindowStyle = WindowStyle.None;
        ResizeMode = ResizeMode.NoResize;
        Width = SessionWindowWidth;
        Height = SessionWindowHeight;
        Topmost = false;
        Background = UnlockedPanel.Background;
        MoveToBottomRight();
        ApplyRoundedWindowRegion();
        ApplyToolWindowStyle(true);
        RefreshMouseCursor();
    }

    // 程序化改动窗口尺寸、样式和裁剪区域后，系统有时会保留旧的光标状态（表现为悬停在卡片上光标不显示）。
    // 这里清除可能存在的覆盖光标并强制重新计算一次，确保回到卡片可见的箭头光标。
    private static void RefreshMouseCursor()
    {
        Mouse.OverrideCursor = null;
        Mouse.UpdateCursor();
    }

    // 把登录窗口移动并拉伸到覆盖整个虚拟屏幕。
    private void MoveToFullScreenBounds()
    {
        Left = SystemParameters.VirtualScreenLeft;
        Top = SystemParameters.VirtualScreenTop;
        Width = SystemParameters.VirtualScreenWidth;
        Height = SystemParameters.VirtualScreenHeight;
    }

    // 延迟到渲染阶段应用圆角窗口区域，确保 ActualWidth/ActualHeight 已更新。
    private void ApplyRoundedWindowRegion()
    {
        _ = Dispatcher.InvokeAsync(ApplyRoundedWindowRegionCore, System.Windows.Threading.DispatcherPriority.Render);
    }

    // 使用 Win32 Region 裁剪右下角卡片窗口圆角，避免透明窗口黑角。
    private void ApplyRoundedWindowRegionCore()
    {
        var handle = new WindowInteropHelper(this).Handle;
        if (handle == IntPtr.Zero)
        {
            return;
        }

        // 按当前 DPI 缩放计算真实像素尺寸。
        var source = PresentationSource.FromVisual(this);
        var scaleX = source?.CompositionTarget?.TransformToDevice.M11 ?? 1;
        var scaleY = source?.CompositionTarget?.TransformToDevice.M22 ?? 1;
        var width = Math.Max(1, (int)Math.Ceiling(ActualWidth * scaleX));
        var height = Math.Max(1, (int)Math.Ceiling(ActualHeight * scaleY));
        var cornerDiameter = Math.Max(1, (int)Math.Ceiling(SessionWindowCornerRadius * 2 * Math.Max(scaleX, scaleY)));

        var region = CreateRoundRectRgn(0, 0, width + 1, height + 1, cornerDiameter, cornerDiameter);
        if (region == IntPtr.Zero)
        {
            return;
        }

        // SetWindowRgn 成功后系统接管 region 句柄；失败时需要自己释放。
        if (SetWindowRgn(handle, region, true) == 0)
        {
            DeleteObject(region);
        }
        // 窗口形状刚发生变化，强制刷新一次光标，避免系统沿用裁剪前的光标状态。
        RefreshMouseCursor();
    }

    // 清理窗口区域裁剪，回到普通登录页窗口时使用。
    private void ClearWindowRegion()
    {
        var handle = new WindowInteropHelper(this).Handle;
        if (handle != IntPtr.Zero)
        {
            SetWindowRgn(handle, IntPtr.Zero, true);
        }
    }

    // 登录后的小卡片改成工具窗口，保留可点击但不进入 Alt+Tab。
    private void ApplyToolWindowStyle(bool enabled)
    {
        var handle = new WindowInteropHelper(this).Handle;
        if (handle == IntPtr.Zero)
        {
            return;
        }

        var style = GetWindowLongPtr(handle, GwlExStyle).ToInt64();
        var nextStyle = enabled
            ? (style | WsExToolWindow) & ~WsExAppWindow
            : style & ~WsExToolWindow;

        if (style == nextStyle)
        {
            return;
        }

        SetWindowLongPtr(handle, GwlExStyle, new IntPtr(nextStyle));
        SetWindowPos(handle, IntPtr.Zero, 0, 0, 0, 0, SwpNoMove | SwpNoSize | SwpNoZOrder | SwpNoActivate | SwpFrameChanged);
    }

    // 创建圆角矩形 GDI Region。
    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateRoundRectRgn(
        int left,
        int top,
        int right,
        int bottom,
        int widthEllipse,
        int heightEllipse);

    // 设置窗口显示区域，常用于做无边框窗口圆角。
    [DllImport("user32.dll")]
    private static extern int SetWindowRgn(IntPtr hWnd, IntPtr hRgn, bool redraw);

    // 释放 GDI 对象。
    [DllImport("gdi32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DeleteObject(IntPtr hObject);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW", SetLastError = true)]
    private static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)]
    private static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint flags);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetWindow(IntPtr hWnd, uint command);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetWindowRect(IntPtr hWnd, out NativeRect rect);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetMonitorInfo(IntPtr monitor, ref NativeMonitorInfo monitorInfo);

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeMonitorInfo
    {
        public int Size;
        public NativeRect Monitor;
        public NativeRect WorkArea;
        public uint Flags;
    }

    // 创建系统托盘图标和右键菜单。
    private Forms.NotifyIcon CreateTrayIcon()
    {
        var icon = new Forms.NotifyIcon
        {
            Icon = Drawing.SystemIcons.Application,
            Text = "实名上机客户端",
            Visible = false,
        };

        var menu = new Forms.ContextMenuStrip();
        menu.Items.Add("显示", null, (_, _) => Dispatcher.Invoke(RestoreFromTray));
        icon.ContextMenuStrip = menu;
        icon.DoubleClick += (_, _) => Dispatcher.Invoke(RestoreFromTray);
        return icon;
    }

    // 登录后把右下角卡片隐藏到系统托盘。
    private void MinimizeToTray()
    {
        _trayIcon.Visible = true;
        Hide();
        _trayIcon.ShowBalloonTip(1200, "实名上机客户端", "已最小化到系统托盘。", Forms.ToolTipIcon.Info);
    }

    // 从系统托盘恢复窗口，根据当前状态恢复登录页或右下角卡片。
    private void RestoreFromTray()
    {
        _trayIcon.Visible = false;
        Show();
        WindowState = WindowState.Normal;
        if (_status == "Unlocked")
        {
            ApplySessionWindowMode();
        }
        else
        {
            ApplyWindowMode();
        }
    }

    // 把右下角状态卡片移动到当前工作区右下角。
    private void MoveToBottomRight()
    {
        var area = SystemParameters.WorkArea;
        Left = Math.Max(area.Left, area.Right - Width - SessionWindowMargin);
        Top = Math.Max(area.Top, area.Bottom - Height - SessionWindowMargin);
    }

    // 把调试窗口居中到当前工作区。
    private void CenterOnWorkArea()
    {
        var area = SystemParameters.WorkArea;
        Left = area.Left + Math.Max(0, (area.Width - Width) / 2);
        Top = area.Top + Math.Max(0, (area.Height - Height) / 2);
    }

    // 获取 WebView2 用户数据目录，固定写本机 ProgramData，避免 SMB 共享目录被锁。
    private string GetWebView2UserDataFolder()
    {
        var folderName = SanitizePathSegment(_machineId);
        try
        {
            var folder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                "RealNameSimple",
                "WebView2",
                folderName);
            Directory.CreateDirectory(folder);
            return folder;
        }
        catch
        {
            // ProgramData 不可写时回退到当前用户 LocalAppData。
            var fallback = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "RealNameSimple",
                "WebView2",
                folderName);
            Directory.CreateDirectory(fallback);
            return fallback;
        }
    }

    // 清理路径片段中的非法字符，避免机器 ID 直接作为目录名时出错。
    private static string SanitizePathSegment(string value)
    {
        var text = string.Concat(value.Where(item => char.IsLetterOrDigit(item) || item is '-' or '_'));
        return string.IsNullOrWhiteSpace(text) ? "default" : text;
    }

    // Win32 窗口消息钩子：全屏锁定时拦截系统菜单关闭、最小化、最大化等命令。
    private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (IsLockScreenActive && msg == NativeWindowMessages.WmSysCommand)
        {
            var command = wParam.ToInt32() & 0xFFF0;
            // 屏蔽 Alt+F4、系统菜单、最小化、最大化等窗口级逃逸动作。
            if (command is NativeWindowMessages.ScClose
                or NativeWindowMessages.ScMinimize
                or NativeWindowMessages.ScMaximize
                or NativeWindowMessages.ScKeyMenu)
            {
                handled = true;
                EnsureLockScreen();
                return IntPtr.Zero;
            }
        }

        return IntPtr.Zero;
    }

    // 向登录页 WebView 发送 JSON 消息。
    private async Task SendToWebAsync(object payload)
    {
        var json = JsonSerializer.Serialize(payload, JsonOptions);
        await Dispatcher.InvokeAsync(() =>
        {
            if (LoginView.CoreWebView2 is null)
            {
                return;
            }

            LoginView.CoreWebView2.PostWebMessageAsJson(json);
        });
    }

    // 生成后端 API 路径。
    private string ApiPath(string path)
    {
        var basePath = _http.BaseAddress?.AbsolutePath.TrimEnd('/') ?? "";
        var normalizedPath = "/" + path.TrimStart('/');

        // 客户端只连接后端节点的标准 API 路径。
        // 常规后端地址直接使用 /api/...。
        if (string.IsNullOrWhiteSpace(basePath) || basePath == "/")
        {
            return normalizedPath;
        }

        return basePath + normalizedPath;
    }

    // 为每次后端请求创建独立超时控制，超时时本次请求按网络失败处理。
    private CancellationTokenSource CreateHttpTimeoutToken()
    {
        return new CancellationTokenSource(TimeSpan.FromSeconds(_clientConfig.HttpTimeoutSeconds));
    }

    // 为后台轮询创建可外部取消的请求超时控制。
    private CancellationTokenSource CreateHttpTimeoutToken(CancellationToken cancellationToken)
    {
        var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        cts.CancelAfter(TimeSpan.FromSeconds(_clientConfig.HttpTimeoutSeconds));
        return cts;
    }

    // WPF 预览按键拦截：全屏锁定时屏蔽部分常见快捷键。
    private static void OnPreviewKeyDown(object sender, System.Windows.Input.KeyEventArgs e)
    {
        if (sender is not MainWindow window || !window.IsLockScreenActive)
        {
            return;
        }

        var key = e.Key == Key.System ? e.SystemKey : e.Key;
        var modifiers = Keyboard.Modifiers;
        // 屏蔽 Esc、F11、Win、Alt+F4、Alt+Tab、Ctrl+Esc、Ctrl+Shift+Esc 等。
        if (key is Key.Escape or Key.F11 or Key.LWin or Key.RWin
            || (modifiers.HasFlag(ModifierKeys.Alt) && key is (Key.F4 or Key.Tab or Key.Escape or Key.Space))
            || (modifiers.HasFlag(ModifierKeys.Control) && key is Key.Escape)
            || (modifiers.HasFlag(ModifierKeys.Control) && modifiers.HasFlag(ModifierKeys.Shift) && key is Key.Escape))
        {
            e.Handled = true;
            window.EnsureLockScreen();
        }
    }
}

// Win32 系统窗口消息常量，用于锁屏模式下拦截窗口系统命令。
static class NativeWindowMessages
{
    // 系统命令消息。
    public const int WmSysCommand = 0x0112;

    // 关闭窗口命令。
    public const int ScClose = 0xF060;

    // 最小化窗口命令。
    public const int ScMinimize = 0xF020;

    // 最大化窗口命令。
    public const int ScMaximize = 0xF030;

    // 系统菜单命令，常见于 Alt+Space。
    public const int ScKeyMenu = 0xF100;
}

// 低级键盘钩子：全屏锁定时拦截 Alt+Tab、Win+D 等系统级快捷键。
sealed class LockKeyboardHook : IDisposable
{
    // WH_KEYBOARD_LL：全局低级键盘钩子类型。
    private const int WhKeyboardLl = 13;

    // 普通按键按下消息。
    private const int WmKeyDown = 0x0100;

    // 普通按键抬起消息。
    private const int WmKeyUp = 0x0101;

    // 系统按键按下消息，例如 Alt 组合键。
    private const int WmSysKeyDown = 0x0104;

    // 系统按键抬起消息。
    private const int WmSysKeyUp = 0x0105;

    // 键盘钩子标志位：Alt 键处于按下状态。
    private const int LlkhfAltDown = 0x20;

    // Tab 虚拟键码。
    private const int VkTab = 0x09;

    // Esc 虚拟键码。
    private const int VkEscape = 0x1B;

    // Space 虚拟键码。
    private const int VkSpace = 0x20;

    // D 虚拟键码，用于 Win+D。
    private const int VkD = 0x44;

    // F4 虚拟键码，用于 Alt+F4。
    private const int VkF4 = 0x73;

    // F11 虚拟键码。
    private const int VkF11 = 0x7A;

    // 左 Windows 键虚拟键码。
    private const int VkLWin = 0x5B;

    // 右 Windows 键虚拟键码。
    private const int VkRWin = 0x5C;

    // Ctrl 虚拟键码。
    private const int VkControl = 0x11;

    // 左 Ctrl 虚拟键码。
    private const int VkLControl = 0xA2;

    // 右 Ctrl 虚拟键码。
    private const int VkRControl = 0xA3;

    // Shift 虚拟键码。
    private const int VkShift = 0x10;

    // 左 Shift 虚拟键码。
    private const int VkLShift = 0xA0;

    // 右 Shift 虚拟键码。
    private const int VkRShift = 0xA1;

    // Alt 虚拟键码。
    private const int VkMenu = 0x12;

    // 左 Alt 虚拟键码。
    private const int VkLMenu = 0xA4;

    // 右 Alt 虚拟键码。
    private const int VkRMenu = 0xA5;

    // M 虚拟键码，用于 Win+M。
    private const int VkM = 0x4D;

    // 判断当前是否处于锁屏状态的回调，由主窗口提供。
    private readonly Func<bool> _isLockScreenActive;

    // 保持回调委托引用，避免被 GC 回收后钩子失效。
    private readonly LowLevelKeyboardProc _proc;

    // 当前安装的键盘钩子句柄。
    private IntPtr _hookId;

    // 初始化键盘钩子对象。
    public LockKeyboardHook(Func<bool> isLockScreenActive)
    {
        _isLockScreenActive = isLockScreenActive;
        _proc = HookCallback;
    }

    // 安装全局低级键盘钩子。
    public void Install()
    {
        // 已安装时不重复安装。
        if (_hookId != IntPtr.Zero)
        {
            return;
        }

        IntPtr moduleHandle = IntPtr.Zero;
        try
        {
            // 获取当前模块句柄，传给 SetWindowsHookEx。
            using var process = Process.GetCurrentProcess();
            using var module = process.MainModule;
            moduleHandle = module is null ? IntPtr.Zero : GetModuleHandle(module.ModuleName);
        }
        catch
        {
        }

        _hookId = SetWindowsHookEx(WhKeyboardLl, _proc, moduleHandle, 0);
    }

    // 卸载键盘钩子。
    public void Dispose()
    {
        if (_hookId == IntPtr.Zero)
        {
            return;
        }

        UnhookWindowsHookEx(_hookId);
        _hookId = IntPtr.Zero;
    }

    // 键盘钩子回调：锁屏状态下命中特定快捷键就拦截。
    private IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0 && _isLockScreenActive() && IsKeyboardMessage(wParam) && ShouldBlock(lParam))
        {
            return new IntPtr(1);
        }

        return CallNextHookEx(_hookId, nCode, wParam, lParam);
    }

    // 判断当前消息是否是键盘按下/抬起消息。
    private static bool IsKeyboardMessage(IntPtr wParam)
    {
        var message = wParam.ToInt32();
        return message is WmKeyDown or WmKeyUp or WmSysKeyDown or WmSysKeyUp;
    }

    // 判断当前按键组合是否需要被锁屏模式拦截。
    private static bool ShouldBlock(IntPtr lParam)
    {
        var data = Marshal.PtrToStructure<KeyboardHookData>(lParam);
        var vkCode = data.VkCode;

        // 组合键状态既看钩子 flags，也用 GetAsyncKeyState 兜底。
        var alt = (data.Flags & LlkhfAltDown) != 0 || IsKeyDown(VkMenu) || IsKeyDown(VkLMenu) || IsKeyDown(VkRMenu);
        var ctrl = IsKeyDown(VkControl) || IsKeyDown(VkLControl) || IsKeyDown(VkRControl);
        var shift = IsKeyDown(VkShift) || IsKeyDown(VkLShift) || IsKeyDown(VkRShift);
        var win = IsKeyDown(VkLWin) || IsKeyDown(VkRWin);

        // 单键拦截：Esc、F11、Win 键。
        if (vkCode is VkEscape or VkF11 or VkLWin or VkRWin)
        {
            return true;
        }

        // Alt 组合键拦截：Alt+F4、Alt+Tab、Alt+Esc、Alt+Space。
        if (alt && vkCode is (VkF4 or VkTab or VkEscape or VkSpace))
        {
            return true;
        }

        // Ctrl+Esc 拦截，避免打开开始菜单。
        if (ctrl && vkCode == VkEscape)
        {
            return true;
        }

        // Ctrl+Shift+Esc 拦截，避免打开任务管理器。
        if (ctrl && shift && vkCode == VkEscape)
        {
            return true;
        }

        // Win 组合键拦截：桌面、最小化、切换等。
        return win && vkCode is (VkD or VkM or VkTab or VkEscape);
    }

    // 查询某个虚拟键当前是否处于按下状态。
    private static bool IsKeyDown(int virtualKey)
    {
        return (GetAsyncKeyState(virtualKey) & 0x8000) != 0;
    }

    // 低级键盘钩子回调委托。
    private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

    // Win32 KBDLLHOOKSTRUCT，低级键盘钩子返回的按键信息。
    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardHookData
    {
        // 虚拟键码。
        public int VkCode;

        // 硬件扫描码。
        public int ScanCode;

        // 键盘事件标志位。
        public int Flags;

        // 事件时间戳。
        public int Time;

        // 附加信息指针。
        public IntPtr ExtraInfo;
    }

    // 安装 Windows 钩子。
    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

    // 卸载 Windows 钩子。
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    // 把未拦截的钩子事件继续传给下一个钩子。
    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    // 获取当前模块句柄。
    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr GetModuleHandle(string? lpModuleName);

    // 查询按键当前状态。
    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vKey);
}

// 登录页 JS 发给 C# 的消息体。
sealed record ClientFormMessage(
    // 消息类型：login、clientConfig、fault、faultCheckStudent、idleShutdown 等。
    string Type,
    // 登录账号，可填写学生学号或教师工号、身份证号、手机号。
    string? StudentNo,
    // 登录姓名。
    string? Name,
    // 登录密码。
    string? Password,
    // 故障报修类型。
    string? FaultType,
    // 故障报修人账号，兼容旧字段名。
    string? FaultStudentNo,
    // 故障描述。
    string? FaultInfo,
    // 是否强制接管登录，即下线原电脑并登录本机。
    bool ForceLogin,
    // 电源菜单动作：shutdown 或 restart。
    string? PowerAction);

// 后端 /api/client-config 返回的客户端配置。
sealed record ClientConfigResponse(
    // 接口是否成功。
    bool Ok,
    // 后端配置的故障类型列表。
    IReadOnlyList<string>? FaultTypes,
    // 后端下发的客户端心跳间隔，单位：秒。
    int? HeartbeatSeconds,
    // 是否启用未登录锁屏全屏模式。
    bool? FullscreenEnabled,
    // 连续心跳失败锁定次数，0 表示关闭连续失败本地锁定。
    int? HeartbeatFailLockCount,
    // 客户端请求后端接口的超时秒数。
    int? HttpTimeoutSeconds,
    // 客户端动态配置刷新间隔秒数。
    int? ConfigRefreshSeconds,
    // client.alive 活性文件写入间隔秒数。
    int? ClientAliveSeconds,
    // 是否允许启动时自动恢复本机缓存会话。
    bool? RestoreSessionEnabled,
    // 是否显示并允许使用故障报修入口。
    bool? FaultEnabled);

// 客户端运行期配置，启动时用本地默认值，后端 /api/client-config 成功后动态覆盖。
sealed record ClientRuntimeConfig(
    int HeartbeatSeconds,
    bool FullscreenEnabled,
    int HeartbeatFailLockCount,
    int HttpTimeoutSeconds,
    int ConfigRefreshSeconds,
    int ClientAliveSeconds,
    bool RestoreSessionEnabled,
    int LoginFastClickMs,
    int LoginCooldownSeconds,
    bool FaultEnabled)
{
    public static ClientRuntimeConfig FromSettings(ClientSettings settings)
    {
        return new ClientRuntimeConfig(
            Clamp(settings.HeartbeatSeconds, 3, 60, 10),
            FullscreenEnabled: settings.FullScreen,
            HeartbeatFailLockCount: Clamp(settings.HeartbeatFailLockCount, 0, 20, 0),
            HttpTimeoutSeconds: Clamp(settings.HttpTimeoutSeconds, 5, 60, 10),
            ConfigRefreshSeconds: Clamp(settings.ConfigRefreshSeconds, 3, 3600, 60),
            ClientAliveSeconds: Clamp(settings.ClientAliveSeconds, 1, 20, 5),
            RestoreSessionEnabled: settings.RestoreSessionEnabled,
            LoginFastClickMs: Clamp(settings.LoginFastClickMs, 0, 10000, 1000),
            LoginCooldownSeconds: Clamp(settings.LoginCooldownSeconds, 0, 300, 3),
            FaultEnabled: settings.FaultEnabled);
    }

    public static ClientRuntimeConfig FromResponse(ClientConfigResponse? response, ClientRuntimeConfig fallback)
    {
        if (response?.Ok != true)
        {
            return fallback;
        }

        return new ClientRuntimeConfig(
            Clamp(response.HeartbeatSeconds, 3, 60, fallback.HeartbeatSeconds),
            response.FullscreenEnabled ?? fallback.FullscreenEnabled,
            Clamp(response.HeartbeatFailLockCount, 0, 20, fallback.HeartbeatFailLockCount),
            Clamp(response.HttpTimeoutSeconds, 5, 60, fallback.HttpTimeoutSeconds),
            Clamp(response.ConfigRefreshSeconds, 3, 3600, fallback.ConfigRefreshSeconds),
            Clamp(response.ClientAliveSeconds, 1, 20, fallback.ClientAliveSeconds),
            response.RestoreSessionEnabled ?? fallback.RestoreSessionEnabled,
            fallback.LoginFastClickMs,
            fallback.LoginCooldownSeconds,
            response.FaultEnabled ?? fallback.FaultEnabled);
    }

    public string Signature()
    {
        return string.Join("|",
            HeartbeatSeconds,
            FullscreenEnabled,
            HeartbeatFailLockCount,
            HttpTimeoutSeconds,
            ConfigRefreshSeconds,
            ClientAliveSeconds,
            RestoreSessionEnabled,
            LoginFastClickMs,
            LoginCooldownSeconds,
            FaultEnabled);
    }

    private static int Clamp(int? value, int min, int max, int fallback)
    {
        if (value is null)
        {
            return fallback;
        }

        return Math.Min(max, Math.Max(min, value.Value));
    }
}

// 请求后端 /api/client-policy 的请求体。
sealed record ClientPolicyRequest(
    // 当前电脑稳定机器 ID。
    string MachineId,
    // Windows 主机名。
    string MachineName,
    // 当前客户端 IPv4 地址。
    string? IpAddress,
    // 当前客户端 MAC 地址。
    string? MacAddress);

// 后端 /api/client-policy 返回的教室策略。
sealed record ClientPolicyResponse(
    // 接口是否成功。
    bool Ok,
    // 当前 IP 是否命中 tp_smsj_classroom 配置。
    bool? IpAllowed,
    // 当前教室是否启用实名上机系统。
    bool? SystemEnabled,
    // 客户端是否应该退出。
    bool? ShouldExit,
    // 策略提示文案。
    string? Message,
    // 当前匹配到的教室名称。
    string? ClassroomName,
    // 设备角色：student、teacher、unknown。
    string? DeviceRole,
    // 登录页空闲自动关机分钟数，0 表示不启用。
    int? IdleShutdownMinutes);

// 登录请求体。
sealed record LoginRequest(
    // 当前电脑稳定机器 ID。
    string MachineId,
    // Windows 主机名。
    string MachineName,
    // 当前客户端 IPv4 地址。
    string? IpAddress,
    // 当前客户端 MAC 地址。
    string? MacAddress,
    // 学号/登录账号。
    string StudentNo,
    // 登录姓名。
    string Name,
    // 登录密码。
    string Password,
    // 是否接管其他电脑上的 active 会话。
    bool ForceLogin);

// 重复登录冲突时，后端返回的已登录设备信息。
sealed record ActiveLoginInfo(
    // 已登录设备所属教室名称。
    string? ClassroomName,
    // 已登录设备 IP 地址。
    string? IpAddress,
    // 已登录设备主机名。
    string? MachineName,
    // 已登录设备机器 ID。
    string? MachineId,
    // 原会话开始时间。
    string? StartedAt);

// 登录接口返回体。
sealed record LoginResponse(
    // 是否允许登录。
    bool Allowed,
    // 登录成功后的会话 ID。
    string? SessionId,
    // 兼容字段名，学生返回学号，教师统一返回 teacher_num。
    string? StudentNo,
    // 登录用户身份：student 或 teacher。
    string? UserRole,
    // 登录成功后的显示姓名。
    string? Name,
    // 返回给登录页的提示文案。
    string Message,
    // toast 显示时长，单位：毫秒。
    int? ToastDurationMs,
    // 是否需要学生确认接管原电脑。
    bool RequiresTakeover,
    // 原电脑已登录设备信息。
    ActiveLoginInfo? ActiveSession,
    // 原电脑登录位置摘要，优先使用教室或设备名称。
    string? ActivePlace,
    // 当前 IP 是否命中 tp_smsj_classroom 配置。
    bool? IpAllowed,
    // 当前教室是否启用实名上机系统。
    bool? SystemEnabled,
    // 账号是否被屏蔽；后端仍会在拒绝登录时返回该标记，客户端只按 message 提示。
    bool? AccountBlocked,
    // 客户端是否应该退出。
    bool? ShouldExit);

// 客户端启动时恢复本地缓存会话的请求体。
sealed record RestoreSessionRequest(
    // 当前电脑稳定机器 ID。
    string MachineId,
    // Windows 主机名。
    string MachineName,
    // 当前客户端 IPv4 地址。
    string? IpAddress,
    // 当前客户端 MAC 地址。
    string? MacAddress,
    // 本地缓存的会话 ID。
    string SessionId,
    // 本地缓存的规范账号。
    string StudentNo);

// 恢复会话接口返回体。
sealed record RestoreSessionResponse(
    // 是否允许恢复会话。
    bool Allowed,
    // 恢复成功后的会话 ID。
    string? SessionId,
    // 恢复成功后的规范账号。
    string? StudentNo,
    // 恢复成功后的用户身份：student 或 teacher。
    string? UserRole,
    // 恢复成功后的显示姓名。
    string? Name,
    // 返回给客户端/页面的提示。
    string Message,
    // 当前教室是否启用实名上机系统。
    bool? SystemEnabled,
    // 客户端是否应该退出。
    bool? ShouldExit);

// 故障报修账号校验请求体。
sealed record FaultStudentCheckRequest(
    // 报修人账号，兼容后端旧 studentNo 字段名。
    string StudentNo,
    // 报修人姓名，用于教师手机号等重复标识消歧。
    string? Name);

// 故障报修提交请求体。
sealed record FaultRequest(
    // 报修电脑 IP 地址。
    string? Ip,
    // 故障类型。
    string Type,
    // 报修人账号，兼容后端旧 studentNo 字段名。
    string StudentNo,
    // 报修人姓名，用于教师手机号等重复标识消歧。
    string? Name,
    // 故障描述。
    string Info);

// 故障报修相关接口返回体。
sealed record FaultResponse(
    // 是否处理成功。
    bool Ok,
    // 返回给登录页的提示文案。
    string? Message);

// 下机请求体。
sealed record LogoutRequest(
    // 当前电脑稳定机器 ID。
    string MachineId,
    // 当前会话 ID。
    string? SessionId,
    // 下机原因：manual、client-closing、classroom-disabled 等。
    string Reason);

sealed record TeacherLogoutRequest(string MachineId, string? SessionId, string? IpAddress, bool ShutdownStudents);
sealed record ApiMessage(string? Message);

// 远程命令执行结果请求体。
sealed record CommandResultRequest(
    // 当前电脑稳定机器 ID。
    string MachineId,
    // Node心跳下发的命令 ID。
    string CommandId,
    // 执行结果：completed 或 failed。
    string Status,
    // 执行结果说明。
    string Message);

// 心跳请求体。
sealed record HeartbeatRequest(
    // 当前电脑稳定机器 ID。
    string MachineId,
    // Windows 主机名。
    string MachineName,
    // 当前客户端 IPv4 地址。
    string? IpAddress,
    // 当前客户端 MAC 地址。
    string? MacAddress,
    // 当前设备状态：Locked、Unlocked、Disabled。
    string Status,
    // 当前登录用户姓名。
    string? CurrentUserName,
    // 当前会话 ID。
    string? CurrentSessionId,
    // 心跳来源，Node只会向真正客户端派发远程命令。
    string Source);

// Node随心跳下发给客户端的远程命令。
sealed record ClientCommand(
    // 命令唯一 ID。
    string? Id,
    // 命令类型：force_logout 或 shutdown。
    string? Type,
    // 命令提示文案。
    string? Message);

// 心跳接口返回体。
sealed record HeartbeatResponse(
    // 接口是否成功。
    bool Ok,
    // 当前 IP 是否命中 tp_smsj_classroom 配置。
    bool? IpAllowed,
    // 当前会话是否已被服务端判定超时。
    bool SessionExpired,
    // 返回给客户端/页面的提示。
    string? Message,
    // 当前教室是否启用实名上机系统。
    bool? SystemEnabled,
    // 客户端是否应该退出。
    bool? ShouldExit,
    // 登录页空闲自动关机分钟数。
    int? IdleShutdownMinutes,
    // 当前设备角色：student 或 teacher。
    string? DeviceRole,
    // 当前教室是否允许教师联动关机学生机。
    bool? AllowStudentShutdown,
    // 服务端下发的客户端心跳间隔，单位：秒。
    int? HeartbeatSeconds,
    // Vue 后台下发的远程命令；为空表示本次无命令。
    ClientCommand? Command);

// 本地 session.json 缓存记录，用于客户端被强制关闭后恢复会话。
sealed record SessionCacheRecord(
    // 缓存所属机器 ID。
    string MachineId,
    // 缓存的会话 ID。
    string SessionId,
    // 缓存的规范账号；学生为学号，教师为 teacher_num。
    string StudentNo,
    // 缓存的显示姓名。
    string Name,
    // 缓存写入时间。
    DateTimeOffset SavedAt);

// 客户端配置：Debug 环境读取外部 appsettings.jsonc，Release 发布版读取 EXE 内置资源。
sealed class ClientSettings
{
    private const string JsoncFileName = "appsettings.jsonc";
    private const string LegacyJsonFileName = "appsettings.json";

    // 读取本地配置使用的 JSONC 配置，允许 // 注释、/* */ 注释和尾逗号。
    private static readonly JsonSerializerOptions SettingsJsonOptions = new(JsonSerializerDefaults.Web)
    {
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
    };

    // 后端 API 地址。
    public string ServerUrl { get; init; } = "http://127.0.0.1:14848";

    // 是否启用全屏锁屏模式。
    public bool FullScreen { get; init; } = true;

    // 客户端默认心跳间隔，单位：秒；后端下发配置会覆盖运行中周期。
    public int HeartbeatSeconds { get; init; } = 10;

    // 连续心跳失败锁定次数，0 表示关闭；后端下发配置会覆盖。
    public int HeartbeatFailLockCount { get; init; } = 0;

    // 客户端请求后端接口的超时秒数；后端下发配置会覆盖。
    public int HttpTimeoutSeconds { get; init; } = 10;

    // 客户端动态配置刷新间隔秒数；后端下发配置会覆盖。
    public int ConfigRefreshSeconds { get; init; } = 60;

    // client.alive 活性文件写入间隔秒数；后端下发配置会覆盖。
    public int ClientAliveSeconds { get; init; } = 5;

    // 是否允许启动时自动恢复本机缓存会话；后端下发配置会覆盖。
    public bool RestoreSessionEnabled { get; init; } = true;

    // 登录按钮快速重复点击判定窗口，只是客户端本地配置，不由 Node 下发。
    public int LoginFastClickMs { get; init; } = 1000;

    // 登录快速重复点击后的冷却秒数，只是客户端本地配置，不由 Node 下发。
    public int LoginCooldownSeconds { get; init; } = 3;

    // 是否显示故障报修入口；后端下发配置会覆盖。
    public bool FaultEnabled { get; init; } = true;

    // 加载客户端配置。开发环境保留外置文件便利，正式发布版不依赖程序目录配置文件。
    public static ClientSettings Load()
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
                return JsonSerializer.Deserialize<ClientSettings>(json, SettingsJsonOptions) ?? new ClientSettings();
            }
            catch (Exception error)
            {
                ClientLog.Error($"客户端本地配置读取失败：{path}，将继续尝试其他配置或使用默认值。", error);
            }
        }
#endif

        try
        {
            var assembly = typeof(ClientSettings).Assembly;
            var resourceName = assembly.GetManifestResourceNames()
                .FirstOrDefault(name => name.EndsWith($".{JsoncFileName}", StringComparison.OrdinalIgnoreCase));
            if (!string.IsNullOrWhiteSpace(resourceName))
            {
                using var stream = assembly.GetManifestResourceStream(resourceName);
                using var reader = stream is null ? null : new StreamReader(stream);
                if (reader is not null)
                {
                    var json = reader.ReadToEnd();
                    return JsonSerializer.Deserialize<ClientSettings>(json, SettingsJsonOptions) ?? new ClientSettings();
                }
            }

            ClientLog.Error("客户端 EXE 内未找到内置 appsettings.jsonc，改用代码兜底配置。",
                new InvalidOperationException("Embedded client settings resource is missing."));
        }
        catch (Exception error)
        {
            ClientLog.Error("客户端内置配置读取失败，将使用代码兜底配置。", error);
        }

        return new ClientSettings();
    }
}

// 客户端本机日志，记录心跳失败等现场排查信息。
static class ClientLog
{
    private static readonly object SyncRoot = new();
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

    public static void Initialize()
    {
        lock (SyncRoot)
        {
            PrepareForBoot(LogPath);
        }
    }

    private static string LogPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "RealNameSimple", "client.log");

    private static void PrepareForBoot(string path)
    {
        if (!_bootLogPrepared)
        {
            _bootLogPrepared = RealName.Simple.BootLogReset.TryPrepare(path);
        }
    }

    public static void Info(string message) => Write("INFO", message);

    public static void Warn(string message) => Write("WARN", message);

    public static void Error(string message, Exception error)
    {
        Write("ERROR", $"{message}；{error.GetType().Name}：{error.Message}");
    }

    private static void Write(string level, string message)
    {
        try
        {
            var folder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                "RealNameSimple");
            Directory.CreateDirectory(folder);
            var path = Path.Combine(folder, "client.log");
            var line = $"[{DateTime.Now:yyyy/MM/dd HH:mm:ss}] {level} {Sanitize(message)}{Environment.NewLine}";
            lock (SyncRoot)
            {
                PrepareForBoot(path);
                SanitizeExistingLog(path);
                File.AppendAllText(path, line);
            }
        }
        catch
        {
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
            File.WriteAllText(path, sanitized);
        }
        _existingLogSanitized = true;
    }
}

// UI 线程活性标记：Watchdog 用它判断客户端是否假死未响应。
static class ClientAliveMarker
{
    public static void Touch()
    {
        try
        {
            var folder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                "RealNameSimple");
            Directory.CreateDirectory(folder);
            File.WriteAllText(Path.Combine(folder, "client.alive"), DateTimeOffset.UtcNow.ToString("O"));
        }
        catch
        {
        }
    }
}

// 本机会话缓存：保存登录成功后的 session.json，供客户端重启后尝试恢复。
static class SessionCache
{
    // session.json 使用的 JSON 序列化配置。
    private static readonly JsonSerializerOptions CacheJsonOptions = new(JsonSerializerDefaults.Web);

    // 读取本地会话缓存；失败时返回 null，避免坏缓存阻塞启动。
    public static SessionCacheRecord? Load()
    {
        try
        {
            var path = CachePath();
            if (!File.Exists(path))
            {
                return null;
            }

            var json = File.ReadAllText(path);
            return JsonSerializer.Deserialize<SessionCacheRecord>(json, CacheJsonOptions);
        }
        catch
        {
            return null;
        }
    }

    // 写入本地会话缓存。
    public static void Save(SessionCacheRecord session)
    {
        try
        {
            var path = CachePath();
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, JsonSerializer.Serialize(session, CacheJsonOptions));
        }
        catch
        {
        }
    }

    // 删除本地会话缓存，用于正常下机、超时、恢复失败等场景。
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

    // 本机会话缓存固定路径。
    private static string CachePath()
    {
        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            "RealNameSimple",
            "session.json");
    }
}

// 登录页资源提供器：把嵌入到 EXE 的 HTML/CSS/JS 拼成 WebView 可加载页面。
static class LoginPageProvider
{
    // 构建完整登录页 HTML。
    public static string BuildLoginPage()
    {
        // 读取嵌入资源里的页面、样式、Vue 和业务脚本。
        var html = ReadResource(".wwwroot.login.html");
        var css = ReadResource(".wwwroot.login.css");
        var vue = ReadResource(".wwwroot.vendor.vue.global.prod.js");
        var loginJs = ReadResource(".wwwroot.login.js");

        // 把外链资源替换成内联资源，保证单 EXE/SMB 运行时也能加载。
        return html
            .Replace("""<link rel="stylesheet" href="./login.css" />""", $"<style>{css}</style>", StringComparison.Ordinal)
            .Replace("""<script src="./vendor/vue.global.prod.js"></script>""", $"<script>{EscapeScript(vue)}</script>", StringComparison.Ordinal)
            .Replace("""<script src="./login.js"></script>""", $"<script>{EscapeScript(loginJs)}</script>", StringComparison.Ordinal);
    }

    // 按资源名后缀读取嵌入资源文本。
    private static string ReadResource(string suffix)
    {
        var assembly = Assembly.GetExecutingAssembly();
        var resourceName = assembly.GetManifestResourceNames()
            .FirstOrDefault(name => name.EndsWith(suffix, StringComparison.OrdinalIgnoreCase));

        if (resourceName is null)
        {
            throw new InvalidOperationException($"找不到嵌入资源：{suffix}");
        }

        using var stream = assembly.GetManifestResourceStream(resourceName)
            ?? throw new InvalidOperationException($"无法读取嵌入资源：{resourceName}");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }

    // 避免内联脚本内容中的 </script> 提前结束 script 标签。
    private static string EscapeScript(string script)
    {
        return script.Replace("</script>", "<\\/script>", StringComparison.OrdinalIgnoreCase);
    }
}

// 机器 ID 提供器：生成并缓存本机稳定机器标识。
static class MachineIdProvider
{
    // 获取当前机器 ID，优先使用硬件 ID，并写入 ProgramData 缓存。
    public static string GetMachineId()
    {
        var folder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            "RealNameSimple");
        var path = Path.Combine(folder, "machine.id");

        Directory.CreateDirectory(folder);

        // 优先使用当前硬件 ID，保证机器 ID 能从旧随机值升级到稳定值。
        var hardwareId = BuildHardwareMachineId();
        if (!string.IsNullOrWhiteSpace(hardwareId))
        {
            File.WriteAllText(path, hardwareId);
            return hardwareId;
        }

        // 硬件 ID 取不到时，尝试使用历史缓存。
        if (File.Exists(path))
        {
            var storedId = NormalizeMachineId(File.ReadAllText(path));
            if (!string.IsNullOrWhiteSpace(storedId))
            {
                File.WriteAllText(path, storedId);
                return storedId;
            }
        }

        return "UNKNOWN";
    }

    // 构造硬件机器 ID：系统 UUID 优先，其次物理 MAC。
    private static string? BuildHardwareMachineId()
    {
        var systemUuid = GetSystemUuid();
        if (!string.IsNullOrWhiteSpace(systemUuid))
        {
            return systemUuid;
        }

        var macAddress = NetworkHelper.GetMacAddress();
        if (!string.IsNullOrWhiteSpace(macAddress))
        {
            return macAddress;
        }

        return null;
    }

    // 从 WMI 读取 BIOS/系统 UUID。
    private static string? GetSystemUuid()
    {
        try
        {
            // Win32_ComputerSystemProduct.UUID 通常是最稳定的机器标识。
            using var searcher = new ManagementObjectSearcher("SELECT UUID FROM Win32_ComputerSystemProduct");
            foreach (ManagementObject item in searcher.Get())
            {
                var uuid = NormalizeUuid(item["UUID"]?.ToString());
                if (!string.IsNullOrWhiteSpace(uuid))
                {
                    return uuid;
                }
            }
        }
        catch
        {
        }

        return null;
    }

    // 标准化系统 UUID，过滤空值、全 0 和无效占位值。
    private static string? NormalizeUuid(string? value)
    {
        var text = NormalizeHardwareValue(value);
        if (string.IsNullOrWhiteSpace(text) || text.All(item => item is '0' or '-'))
        {
            return null;
        }

        return Guid.TryParse(text, out var guid) ? guid.ToString("D").ToUpperInvariant() : text;
    }

    // 清理硬件字段中的无效值和非法字符。
    private static string? NormalizeHardwareValue(string? value)
    {
        var text = value?.Trim();
        if (string.IsNullOrWhiteSpace(text))
        {
            return null;
        }

        // 厂商常见的无效占位值，不适合作为机器 ID。
        var invalidValues = new[]
        {
            "0",
            "none",
            "null",
            "unknown",
            "default string",
            "system serial number",
            "to be filled by o.e.m.",
            "to be filled by oem",
        };
        if (invalidValues.Contains(text, StringComparer.OrdinalIgnoreCase))
        {
            return null;
        }

        var normalized = string.Concat(text.Where(item => char.IsLetterOrDigit(item) || item is '-' or '_'));
        return string.IsNullOrWhiteSpace(normalized) ? null : normalized.ToUpperInvariant();
    }

    // 兼容旧版本缓存格式，尽量提取真正的 32 位 GUID 文本。
    private static string NormalizeMachineId(string value)
    {
        var text = value.Trim();
        if (IsGuidText(text))
        {
            return text;
        }

        var index = text.LastIndexOf('-');
        if (index >= 0 && index + 1 < text.Length)
        {
            var suffix = text[(index + 1)..];
            if (IsGuidText(suffix))
            {
                return suffix;
            }
        }

        return text;
    }

    // 判断字符串是否是 32 位十六进制 GUID 文本。
    private static bool IsGuidText(string value)
    {
        return value.Length == 32 && value.All(Uri.IsHexDigit);
    }
}

// 网络信息工具：获取用于上报和教室匹配的本机 IPv4/MAC。
static class NetworkHelper
{
    // 获取优先网卡的 IPv4 地址，排除 127.0.0.1。
    public static string? GetIpAddress()
    {
        return GetCandidateNetworkInterfaces()
            .SelectMany(item => item.GetIPProperties().UnicastAddresses)
            .Where(item => item.Address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
            .Select(item => item.Address.ToString())
            .FirstOrDefault(item => !item.StartsWith("127.", StringComparison.Ordinal));
    }

    // 获取优先网卡的 MAC 地址。
    public static string? GetMacAddress()
    {
        return GetCandidateNetworkInterfaces()
            .Select(item => item.GetPhysicalAddress().GetAddressBytes())
            .Where(bytes => bytes.Length > 0)
            .Select(bytes => string.Join("-", bytes.Select(item => item.ToString("X2"))))
            .FirstOrDefault();
    }

    // 筛选可用于实名上机识别的真实网卡，有线优先、无线其次。
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
            address.Address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork &&
            !address.Address.ToString().StartsWith("127.", StringComparison.Ordinal));
    }

    // 判断网卡 MAC 是否有效，要求 6 字节且不能全 0。
    private static bool HasValidMacAddress(NetworkInterface item)
    {
        var bytes = item.GetPhysicalAddress().GetAddressBytes();
        return bytes.Length == 6 && bytes.Any(value => value != 0);
    }

    // 网卡排序权重：有线网卡优先，其他网卡靠后。
    private static int AdapterPriority(NetworkInterfaceType type)
    {
        return type is NetworkInterfaceType.Ethernet or NetworkInterfaceType.GigabitEthernet or NetworkInterfaceType.FastEthernetFx or NetworkInterfaceType.FastEthernetT ? 0 : 1;
    }

    // 排除虚拟网卡、VPN、蓝牙、容器等不适合作为机房识别依据的适配器。
    private static bool IsVirtualAdapter(NetworkInterface item)
    {
        var text = $"{item.Name} {item.Description}".ToLowerInvariant();

        // 常见虚拟/隧道/容器网卡关键词。
        var virtualKeywords = new[]
        {
            "virtual",
            "vmware",
            "virtualbox",
            "hyper-v",
            "tap",
            "vpn",
            "npcap",
            "loopback",
            "bluetooth",
            "wsl",
            "docker",
            "container",
            "pseudo",
        };
        return virtualKeywords.Any(text.Contains);
    }
}
