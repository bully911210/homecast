# HomeCast tray light: GREEN = server answering, RED = off. Built-in .NET only, no files to install.
# Started detached by homecast.exe so it keeps working (and turns red) if the server dies.
param([int]$Port = 8096, [string]$Start = '', [string]$Cwd = '', [string]$StateFile = '')

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\HomeCastTray', [ref]$created)
if (-not $created) { exit }   # one tray icon, however many times the exe starts

function New-Dot([int]$r, [int]$g, [int]$b) {
  $bmp = New-Object System.Drawing.Bitmap 16, 16
  $gfx = [System.Drawing.Graphics]::FromImage($bmp)
  $gfx.SmoothingMode = 'AntiAlias'
  $gfx.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb($r, $g, $b))), 1, 1, 14, 14)
  $gfx.Dispose()
  [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}
$green = New-Dot 34 197 94
$red = New-Dot 220 38 38
$admin = "http://localhost:$Port/admin"

$icon = New-Object System.Windows.Forms.NotifyIcon
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $menu.Items.Add('Open admin')
$startItem = $menu.Items.Add('Start server')
$quitItem = $menu.Items.Add('Quit tray')
$icon.ContextMenuStrip = $menu
$icon.Icon = $red
$icon.Text = 'HomeCast'
$icon.Visible = $true

$openItem.add_Click({ Start-Process $admin })
$icon.add_MouseClick({ param($s, $e) if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Start-Process $admin } })
$startItem.add_Click({
  $parts = $Start.Split('|')
  $argList = @($parts | Select-Object -Skip 1) + '--background'
  $dir = if ($Cwd) { $Cwd } else { Split-Path -Parent $parts[0] }
  Start-Process -FilePath $parts[0] -ArgumentList $argList -WorkingDirectory $dir -WindowStyle Hidden
})

$script:state = ''
function Update-State {
  $live = $false; $url = ''
  try {
    $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2
    $live = $true
    if ($h.urls) { $url = @($h.urls)[0] }
  } catch { }
  $next = if ($live) { 'green' } else { 'red' }
  if ($next -eq $script:state) { return }   # redraw only on change
  $script:state = $next
  $icon.Icon = if ($live) { $green } else { $red }
  $tip = if ($live) { "HomeCast - Live ($url)" } else { 'HomeCast - Off' }
  $icon.Text = $tip.Substring(0, [Math]::Min(63, $tip.Length))
  $startItem.Enabled = (-not $live) -and ($Start -ne '')
  if ($StateFile) { Set-Content -Path $StateFile -Value $next }
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 4000   # under 5 s from crash to red, with margin
$timer.add_Tick({ Update-State })
$quitItem.add_Click({
  $timer.Stop(); $icon.Visible = $false; $icon.Dispose()
  [System.Windows.Forms.Application]::Exit()
})

Update-State
$timer.Start()
[System.Windows.Forms.Application]::Run()
$mutex.ReleaseMutex()
