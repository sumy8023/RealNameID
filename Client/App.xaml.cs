using System.Configuration;
using System.Threading;
using System.Windows;

namespace RealName.SimpleClient;

/// <summary>
/// Interaction logic for App.xaml
/// </summary>
public partial class App : System.Windows.Application
{
    private const string SingleInstanceMutexName = @"Global\RealName.SimpleClient.Singleton";
    private static Mutex? _singleInstanceMutex;
    private static bool _ownsSingleInstanceMutex;

    protected override void OnStartup(StartupEventArgs e)
    {
        if (!TryAcquireSingleInstance())
        {
            Shutdown(0);
            return;
        }

        ClientLog.Initialize();
        base.OnStartup(e);

        Exit += (_, _) => ReleaseSingleInstance();

        var window = new MainWindow();
        MainWindow = window;
        _ = window.StartClientAsync();
    }

    private static bool TryAcquireSingleInstance()
    {
        try
        {
            _singleInstanceMutex = new Mutex(
                initiallyOwned: true,
                SingleInstanceMutexName,
                out var createdNew);
            _ownsSingleInstanceMutex = createdNew;

            if (createdNew)
            {
                return true;
            }

            _singleInstanceMutex.Dispose();
            _singleInstanceMutex = null;
            return false;
        }
        catch (UnauthorizedAccessException)
        {
            // A Global mutex created by another Windows session may not be openable
            // with this user's token. Treat it as an existing client instance.
            _singleInstanceMutex?.Dispose();
            _singleInstanceMutex = null;
            return false;
        }
    }

    private static void ReleaseSingleInstance()
    {
        if (_singleInstanceMutex is null)
        {
            return;
        }

        try
        {
            if (_ownsSingleInstanceMutex)
            {
                _singleInstanceMutex.ReleaseMutex();
            }
        }
        catch (ApplicationException)
        {
            // The operating system also releases the mutex when the process exits.
        }
        finally
        {
            _singleInstanceMutex.Dispose();
            _singleInstanceMutex = null;
            _ownsSingleInstanceMutex = false;
        }
    }
}
