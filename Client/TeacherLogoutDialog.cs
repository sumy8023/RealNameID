using System.Windows;
using System.Windows.Input;
using System.Windows.Media;
using MediaBrushes = System.Windows.Media.Brushes;
using MediaColor = System.Windows.Media.Color;
using MediaSolidColorBrush = System.Windows.Media.SolidColorBrush;
using Forms = System.Windows.Forms;

namespace RealName.SimpleClient;

// 教师机下机确认框；勾选联动关学生机时才显示不可恢复的风险提示。
internal sealed class TeacherLogoutDialog : Window
{
    private readonly System.Windows.Controls.TextBlock _warning;
    internal bool ShutdownStudents => _shutdownCheck?.IsChecked == true;
    private readonly System.Windows.Controls.CheckBox? _shutdownCheck;

    public TeacherLogoutDialog(bool allowStudentShutdown)
    {
        Title = "退出上机";
        Width = 390;
        SizeToContent = SizeToContent.Height;
        // 登录成功后主窗口只是一张贴在屏幕右下角的 316×112 小卡片，用 CenterOwner 会把确认框顶到
        // 任务栏下方看不见，所以改为手动定位：在所属显示器的工作区内居中显示。
        WindowStartupLocation = WindowStartupLocation.Manual;
        ResizeMode = ResizeMode.NoResize;
        ShowInTaskbar = false;
        WindowStyle = WindowStyle.None;
        AllowsTransparency = true;
        Background = MediaBrushes.Transparent;
        Cursor = System.Windows.Input.Cursors.Arrow;
        Loaded += (_, _) => CenterInOwnerWorkArea();
        // 勾选风险提示后高度会变化，重新收回到工作区内，避免又被任务栏遮挡。
        SizeChanged += (_, _) => ClampToOwnerWorkArea();

        var primaryButtonStyle = CreateButtonStyle(
            new MediaSolidColorBrush(MediaColor.FromRgb(37, 99, 235)),
            MediaBrushes.White,
            MediaBrushes.Transparent,
            new MediaSolidColorBrush(MediaColor.FromRgb(29, 78, 216)),
            new MediaSolidColorBrush(MediaColor.FromRgb(30, 64, 175)));
        var secondaryButtonStyle = CreateButtonStyle(
            new MediaSolidColorBrush(MediaColor.FromRgb(238, 246, 255)),
            new MediaSolidColorBrush(MediaColor.FromRgb(15, 59, 99)),
            new MediaSolidColorBrush(MediaColor.FromRgb(207, 224, 243)),
            new MediaSolidColorBrush(MediaColor.FromRgb(224, 242, 254)),
            new MediaSolidColorBrush(MediaColor.FromRgb(191, 219, 254)));

        if (allowStudentShutdown)
        {
            _shutdownCheck = new System.Windows.Controls.CheckBox
            {
                Content = "同时关闭学生机",
                FontSize = 12,
                Foreground = new MediaSolidColorBrush(MediaColor.FromRgb(51, 65, 85)),
                Margin = new Thickness(0, 0, 0, 10),
                Cursor = System.Windows.Input.Cursors.Arrow,
            };
        }
        _warning = new System.Windows.Controls.TextBlock
        {
            Text = "请确认学生机没有要保存的资料，关机后不可恢复！",
            Foreground = System.Windows.Media.Brushes.Red,
            TextWrapping = TextWrapping.Wrap,
            FontSize = 12,
            LineHeight = 19,
            // 左侧缩进对齐复选框文字，未勾选时折叠不占位。
            Margin = new Thickness(21, 6, 0, 10),
            HorizontalAlignment = System.Windows.HorizontalAlignment.Left,
            Visibility = Visibility.Collapsed,
        };
        if (_shutdownCheck is not null)
        {
            _shutdownCheck.Checked += (_, _) => _warning.Visibility = Visibility.Visible;
            _shutdownCheck.Unchecked += (_, _) => _warning.Visibility = Visibility.Collapsed;
        }

        // 确定/取消改成上下两排，整体靠右对齐。
        var ok = new System.Windows.Controls.Button { Content = "确定", Width = 82, Height = 30, IsDefault = true, Margin = new Thickness(0, 0, 0, 10), Style = primaryButtonStyle };
        ok.Click += (_, _) => { DialogResult = true; Close(); };
        var cancel = new System.Windows.Controls.Button { Content = "取消", Width = 82, Height = 30, IsCancel = true, Style = secondaryButtonStyle };
        var buttons = new System.Windows.Controls.StackPanel
        {
            Orientation = System.Windows.Controls.Orientation.Vertical,
            HorizontalAlignment = System.Windows.HorizontalAlignment.Right,
            VerticalAlignment = System.Windows.VerticalAlignment.Top,
            Margin = new Thickness(18, 14, 0, 0),
        };
        buttons.Children.Add(ok);
        buttons.Children.Add(cancel);

        var content = new System.Windows.Controls.StackPanel { Margin = new Thickness(22) };
        content.Cursor = System.Windows.Input.Cursors.Arrow;
        content.Children.Add(new System.Windows.Controls.TextBlock
        {
            Text = "确认退出当前上机吗？",
            FontSize = 16,
            FontWeight = FontWeights.SemiBold,
            Foreground = new MediaSolidColorBrush(MediaColor.FromRgb(15, 59, 99)),
            HorizontalAlignment = System.Windows.HorizontalAlignment.Center,
            TextAlignment = TextAlignment.Center,
        });
        // 勾选项和风险提示靠左成竖排，按钮靠右。
        var options = new System.Windows.Controls.StackPanel
        {
            Orientation = System.Windows.Controls.Orientation.Vertical,
            HorizontalAlignment = System.Windows.HorizontalAlignment.Left,
            VerticalAlignment = System.Windows.VerticalAlignment.Top,
            Margin = new Thickness(0, 14, 0, 0),
        };
        if (_shutdownCheck is not null)
        {
            options.Children.Add(_shutdownCheck);
            // 红色风险提示紧跟"同时关闭学生机"复选框下方，未勾选时折叠不占位。
            options.Children.Add(_warning);
        }

        // 左列放勾选项和风险提示、右列放按钮。
        var body = new System.Windows.Controls.Grid();
        body.ColumnDefinitions.Add(new System.Windows.Controls.ColumnDefinition
        {
            Width = new System.Windows.GridLength(1, System.Windows.GridUnitType.Star),
        });
        body.ColumnDefinitions.Add(new System.Windows.Controls.ColumnDefinition
        {
            Width = System.Windows.GridLength.Auto,
        });
        System.Windows.Controls.Grid.SetColumn(options, 0);
        System.Windows.Controls.Grid.SetColumn(buttons, 1);
        body.Children.Add(options);
        body.Children.Add(buttons);
        content.Children.Add(body);

        var surface = new System.Windows.Controls.Border
        {
            Background = new MediaSolidColorBrush(MediaColor.FromRgb(248, 251, 255)),
            BorderBrush = new MediaSolidColorBrush(MediaColor.FromRgb(219, 231, 245)),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(12),
            Child = content,
            Cursor = System.Windows.Input.Cursors.Arrow,
        };
        surface.Effect = new System.Windows.Media.Effects.DropShadowEffect
        {
            BlurRadius = 18,
            Direction = 270,
            Opacity = 0.18,
            ShadowDepth = 4,
            Color = MediaColor.FromRgb(37, 99, 235),
        };
        Content = surface;
    }

    // 在所属显示器的工作区内居中显示：工作区已排除任务栏，保证整个确认框完整可见。
    private void CenterInOwnerWorkArea()
    {
        var area = OwnerWorkAreaInDips();
        Left = area.Left + Math.Max(0, (area.Width - ActualWidth) / 2);
        Top = area.Top + Math.Max(0, (area.Height - ActualHeight) / 2);
    }

    // 高度变化（例如勾选风险提示）后把确认框收回工作区内，避免被任务栏或屏幕下边缘遮挡。
    private void ClampToOwnerWorkArea()
    {
        if (double.IsNaN(Left) || double.IsNaN(Top))
        {
            return;
        }

        var area = OwnerWorkAreaInDips();
        Left = Math.Min(Math.Max(Left, area.Left), Math.Max(area.Left, area.Right - ActualWidth));
        Top = Math.Min(Math.Max(Top, area.Top), Math.Max(area.Top, area.Bottom - ActualHeight));
    }

    // 取主窗口所在显示器的工作区，并把设备像素换算成 WPF 的设备无关单位。
    private Rect OwnerWorkAreaInDips()
    {
        var workingArea = ResolveOwnerScreen().WorkingArea;
        var source = PresentationSource.FromVisual(this);
        var fromDevice = source?.CompositionTarget?.TransformFromDevice ?? Matrix.Identity;
        // 显式指定 System.Windows.Point，避免与 WinForms 隐式引入的 System.Drawing.Point 冲突。
        var topLeft = fromDevice.Transform(new System.Windows.Point(workingArea.Left, workingArea.Top));
        var bottomRight = fromDevice.Transform(new System.Windows.Point(workingArea.Right, workingArea.Bottom));
        return new Rect(topLeft, bottomRight);
    }

    // 优先跟随主窗口所在显示器；主窗口句柄拿不到时按鼠标位置判断（点击卡片时鼠标就在卡片上）。
    private Forms.Screen ResolveOwnerScreen()
    {
        var owner = Owner;
        if (owner is not null)
        {
            var ownerHandle = new System.Windows.Interop.WindowInteropHelper(owner).Handle;
            if (ownerHandle != IntPtr.Zero)
            {
                return Forms.Screen.FromHandle(ownerHandle);
            }
        }

        return Forms.Screen.FromPoint(Forms.Cursor.Position);
    }

    private static System.Windows.Style CreateButtonStyle(
        System.Windows.Media.Brush background,
        System.Windows.Media.Brush foreground,
        System.Windows.Media.Brush borderBrush,
        System.Windows.Media.Brush hoverBackground,
        System.Windows.Media.Brush pressedBackground)
    {
        var style = new System.Windows.Style(typeof(System.Windows.Controls.Button));
        style.Setters.Add(new Setter(System.Windows.Controls.Control.BackgroundProperty, background));
        style.Setters.Add(new Setter(System.Windows.Controls.Control.ForegroundProperty, foreground));
        style.Setters.Add(new Setter(System.Windows.Controls.Control.BorderBrushProperty, borderBrush));
        style.Setters.Add(new Setter(System.Windows.Controls.Control.BorderThicknessProperty, new Thickness(1)));
        style.Setters.Add(new Setter(System.Windows.Controls.Control.FontSizeProperty, 13d));
        style.Setters.Add(new Setter(System.Windows.Controls.Control.FontWeightProperty, FontWeights.SemiBold));
        style.Setters.Add(new Setter(System.Windows.Controls.Control.CursorProperty, System.Windows.Input.Cursors.Hand));

        var template = new System.Windows.Controls.ControlTemplate(typeof(System.Windows.Controls.Button));
        var border = new System.Windows.FrameworkElementFactory(typeof(System.Windows.Controls.Border));
        border.Name = "ButtonBorder";
        border.SetBinding(System.Windows.Controls.Border.BackgroundProperty, new System.Windows.Data.Binding(nameof(System.Windows.Controls.Control.Background)) { RelativeSource = new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent) });
        border.SetBinding(System.Windows.Controls.Border.BorderBrushProperty, new System.Windows.Data.Binding(nameof(System.Windows.Controls.Control.BorderBrush)) { RelativeSource = new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent) });
        border.SetBinding(System.Windows.Controls.Border.BorderThicknessProperty, new System.Windows.Data.Binding(nameof(System.Windows.Controls.Control.BorderThickness)) { RelativeSource = new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent) });
        border.SetValue(System.Windows.Controls.Border.CornerRadiusProperty, new CornerRadius(8));
        var presenter = new System.Windows.FrameworkElementFactory(typeof(System.Windows.Controls.ContentPresenter));
        presenter.SetValue(System.Windows.Controls.ContentPresenter.HorizontalAlignmentProperty, System.Windows.HorizontalAlignment.Center);
        presenter.SetValue(System.Windows.Controls.ContentPresenter.VerticalAlignmentProperty, System.Windows.VerticalAlignment.Center);
        presenter.SetBinding(System.Windows.Controls.ContentPresenter.ContentProperty, new System.Windows.Data.Binding(nameof(System.Windows.Controls.ContentControl.Content)) { RelativeSource = new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent) });
        border.AppendChild(presenter);
        template.VisualTree = border;

        var hover = new Trigger { Property = System.Windows.Controls.Button.IsMouseOverProperty, Value = true };
        hover.Setters.Add(new Setter(System.Windows.Controls.Border.BackgroundProperty, hoverBackground, "ButtonBorder"));
        var pressed = new Trigger { Property = System.Windows.Controls.Button.IsPressedProperty, Value = true };
        pressed.Setters.Add(new Setter(System.Windows.Controls.Border.BackgroundProperty, pressedBackground, "ButtonBorder"));
        template.Triggers.Add(hover);
        template.Triggers.Add(pressed);
        style.Setters.Add(new Setter(System.Windows.Controls.Button.TemplateProperty, template));
        return style;
    }
}
