$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$outputDirectory = Join-Path $projectRoot 'assets\generated'
$logo = $null
$brandIcon = $null
$iconImage = $null
try {
    $null = New-Item -ItemType Directory -Path $outputDirectory -Force
    $logo = [Drawing.Image]::FromFile((Join-Path $projectRoot 'assets\branding\HeaderLOGO.png'))
    $brandIcon = New-Object Drawing.Icon((Join-Path $projectRoot 'assets\branding\iconLOGO.ico'))
    $iconImage = $brandIcon.ToBitmap()
    foreach ($kind in @('sidebar', 'header')) {
        $width = if ($kind -eq 'sidebar') { 164 } else { 150 }
        $height = if ($kind -eq 'sidebar') { 314 } else { 57 }
        $canvas = $null
        $graphics = $null
        $edge = $null
        try {
            $canvas = New-Object Drawing.Bitmap($width, $height, ([Drawing.Imaging.PixelFormat]::Format24bppRgb))
            $graphics = [Drawing.Graphics]::FromImage($canvas)
            $graphics.Clear([Drawing.ColorTranslator]::FromHtml('#101319'))
            $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.CompositingQuality = [Drawing.Drawing2D.CompositingQuality]::HighQuality
            if ($kind -eq 'sidebar') {
                $graphics.DrawImage($logo, 4, 20, 156, 52)
                $graphics.DrawImage($iconImage, 38, 132, 88, 88)
                $edge = New-Object Drawing.Pen([Drawing.ColorTranslator]::FromHtml('#2a313d'))
                $graphics.DrawLine($edge, 163, 0, 163, 314)
            } else {
                $graphics.DrawImage($logo, 0, 3, 150, 50)
            }
            $canvas.Save((Join-Path $outputDirectory ('installer-' + $kind + '.bmp')), [Drawing.Imaging.ImageFormat]::Bmp)
        } finally {
            foreach ($resource in @($edge, $graphics, $canvas)) { if ($null -ne $resource) { $resource.Dispose() } }
        }
    }
    Write-Output 'Installer branding prepared from the supplied XeroLag artwork.'
} catch {
    [Console]::Error.WriteLine('Unable to prepare installer branding: ' + $_.Exception.Message)
    exit 1
} finally {
    foreach ($resource in @($iconImage, $brandIcon, $logo)) { if ($null -ne $resource) { $resource.Dispose() } }
}
