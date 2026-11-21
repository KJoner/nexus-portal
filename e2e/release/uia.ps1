# Windows UI Automation for the release-package extension tests: what a person does in the
# browser's own (non-web) UI and in the extension popup — the site-access prompt of
# chrome.permissions.request, the native context menu, the toolbar popup. Only windows of the
# browser started with -ProfileDir are searched (never the person's own browser); elements are
# driven through UIA patterns, not by moving the mouse.
#   pwsh -File uia.ps1 -ProfileDir <dir> -Names 允许,Allow [-Type Button] [-Action Invoke|SetValue|Toggle|WaitText] [-Value text] [-TimeoutMs 15000]
#   -Action WaitText: -Names are regular expressions; prints the first element name that matches.
#   -Match: -Names are regular expressions for the other actions too.
#   -List: prints every named element of the browser's windows.
param(
  [Parameter(Mandatory = $true)][string]$ProfileDir,
  [Parameter(Mandatory = $true)][string[]]$Names,
  [string]$Type = '',
  [ValidateSet('Invoke', 'SetValue', 'Toggle', 'WaitText')][string]$Action = 'Invoke',
  [string]$Value = '',
  [int]$TimeoutMs = 15000,
  # -Names are regular expressions for any action (names that carry a state, e.g. a toolbar button).
  [switch]$Match,
  [switch]$List
)
$ErrorActionPreference = 'Stop'
# pwsh -File passes "a,b" as one string: split it here.
$Names = @($Names | ForEach-Object { $_ -split ',' } | Where-Object { $_ })
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$root = $A::RootElement
$needle = [System.IO.Path]::GetFullPath($ProfileDir).TrimEnd('\').ToLowerInvariant()

function Get-BrowserPids {
  Get-CimInstance Win32_Process -Filter "Name='chrome.exe' or Name='msedge.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Replace('/', '\').Contains($needle) -and $_.CommandLine -notmatch '--type=' } |
    ForEach-Object { [int]$_.ProcessId }
}

Add-Type -Namespace NexusE2E -Name Input -MemberDefinition @'
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, System.UIntPtr extra);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
'@
[NexusE2E.Input]::SetProcessDPIAware() | Out-Null

# Buttons without an Invoke pattern (the extension's toolbar button): a real left click in the
# middle of the element — a user gesture, which is what grants activeTab. Its window is brought to
# the front first (an Alt press lets SetForegroundWindow through), so the click cannot land on a
# window that happens to cover it.
function Click-Element($e, $window) {
  if ($window) {
    [NexusE2E.Input]::keybd_event(0x12, 0, 0, [System.UIntPtr]::Zero)
    [NexusE2E.Input]::SetForegroundWindow([System.IntPtr]$window.Current.NativeWindowHandle) | Out-Null
    [NexusE2E.Input]::keybd_event(0x12, 0, 2, [System.UIntPtr]::Zero)
    Start-Sleep -Milliseconds 300
  }
  $r = $e.Current.BoundingRectangle
  [NexusE2E.Input]::SetCursorPos([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2)) | Out-Null
  [NexusE2E.Input]::mouse_event(0x0002, 0, 0, 0, [System.UIntPtr]::Zero)
  [NexusE2E.Input]::mouse_event(0x0004, 0, 0, 0, [System.UIntPtr]::Zero)
}

# Returns whether the element was used; what was done is written to stdout directly (a function's
# own output would become its return value here).
function Use-Element($e, $name, $procId, $window) {
  if ($Type -and $e.Current.ControlType.ProgrammaticName -ne "ControlType.$Type") { return $false }
  if ($Action -ne 'WaitText' -and -not $e.Current.IsEnabled) { return $false }
  $p = $null
  $how = $Action
  switch ($Action) {
    'Invoke' {
      if ($e.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke() }
      # Toolbar buttons that open a popup (the extension's action) expose ExpandCollapse instead.
      # (Chrome answers Expand() with a COM error: then it is clicked, as a person would.)
      elseif ($e.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) { try { $p.Expand(); $how = 'Expand' } catch { Click-Element $e $window; $how = 'Click' } }
      elseif (-not $e.Current.IsOffscreen) { Click-Element $e $window; $how = 'Click' }
      else { return $false }
    }
    'SetValue' { if ($e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) { $p.SetValue($Value) } else { return $false } }
    'Toggle' { if ($e.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { $p.Toggle() } else { return $false } }
    'WaitText' { }
  }
  [Console]::Out.WriteLine(("{0}`t{1}`t{2}`tpid={3}" -f $how, $e.Current.ControlType.ProgrammaticName, ($e.Current.Name -replace "`r?`n", ' / '), $procId))
  return $true
}

$deadline = (Get-Date).AddMilliseconds($TimeoutMs)
$pids = @()
do {
  $pids = @(Get-BrowserPids)
  foreach ($procId in $pids) {
    $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, (New-Object System.Windows.Automation.PropertyCondition($A::ProcessIdProperty, $procId)))
    foreach ($w in $windows) {
      if ($List) {
        foreach ($e in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
          if ($e.Current.Name) { "{0}`t{1}`t{2}" -f $w.Current.Name, $e.Current.ControlType.ProgrammaticName, $e.Current.Name }
        }
        continue
      }
      if ($Action -eq 'WaitText' -or $Match) {
        foreach ($e in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
          $n = $e.Current.Name
          if (-not $n) { continue }
          foreach ($re in $Names) { if ($n -match $re -and (Use-Element $e $n $procId $w)) { exit 0 } }
        }
        continue
      }
      foreach ($name in $Names) {
        $cond = New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, $name)
        foreach ($e in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)) {
          if (Use-Element $e $name $procId $w) { exit 0 }
        }
      }
    }
  }
  if ($List) { exit 0 }
  Start-Sleep -Milliseconds 250
} while ((Get-Date) -lt $deadline)
Write-Output ("not found: {0} (action {1}, browser pids: {2})" -f ($Names -join ' | '), $Action, ($pids -join ','))
exit 1
