# Generates PWA icons for the Couples Life App.
# Design-system compliant: dark chassis, graphite overlap, no emoji, no gradients.
# Mark: two overlapping circles = two partners with shared/mutual time.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts/generate-icons.ps1

Add-Type -AssemblyName System.Drawing

$outputDir = Join-Path $PSScriptRoot '..\icons'
if (-not (Test-Path $outputDir)) {
    New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
}

# Design tokens
$bgColour      = [System.Drawing.ColorTranslator]::FromHtml('#1A1A1A')  # surface
$strokeColour  = [System.Drawing.ColorTranslator]::FromHtml('#E8E8E8')  # ink
$overlapColour = [System.Drawing.ColorTranslator]::FromHtml('#6E6E6E')  # ink-2 graphite

function New-Icon {
    param(
        [int]$Size,
        [string]$Path
    )

    $bitmap   = New-Object System.Drawing.Bitmap($Size, $Size)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

    # Full-bleed background (required for maskable icons)
    $bgBrush = New-Object System.Drawing.SolidBrush($bgColour)
    $graphics.FillRectangle($bgBrush, 0, 0, $Size, $Size)

    # Two circles, centred, inside the maskable safe zone (middle 80%)
    $radius  = $Size * 0.16
    $centreY = $Size * 0.5
    $centreXLeft  = $Size * 0.42
    $centreXRight = $Size * 0.58

    $rectLeft = New-Object System.Drawing.RectangleF(
        [float]($centreXLeft - $radius),
        [float]($centreY - $radius),
        [float]($radius * 2),
        [float]($radius * 2)
    )
    $rectRight = New-Object System.Drawing.RectangleF(
        [float]($centreXRight - $radius),
        [float]($centreY - $radius),
        [float]($radius * 2),
        [float]($radius * 2)
    )

    $pathLeft = New-Object System.Drawing.Drawing2D.GraphicsPath
    $pathLeft.AddEllipse($rectLeft)
    $pathRight = New-Object System.Drawing.Drawing2D.GraphicsPath
    $pathRight.AddEllipse($rectRight)

    # Fill the intersection in graphite — shared items use neutral, not a third colour
    $region = New-Object System.Drawing.Region($pathLeft)
    $region.Intersect($pathRight)
    $overlapBrush = New-Object System.Drawing.SolidBrush($overlapColour)
    $graphics.FillRegion($overlapBrush, $region)

    # Stroke both circles (1.5px at 20px box, scaled)
    $strokeWidth = [float]($Size * 0.022)
    $pen = New-Object System.Drawing.Pen($strokeColour, $strokeWidth)
    $graphics.DrawPath($pen, $pathLeft)
    $graphics.DrawPath($pen, $pathRight)

    $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)

    # Release resources
    $pen.Dispose()
    $overlapBrush.Dispose()
    $region.Dispose()
    $pathLeft.Dispose()
    $pathRight.Dispose()
    $bgBrush.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()

    Write-Host "Created $Path ($Size x $Size)"
}

New-Icon -Size 192 -Path (Join-Path $outputDir 'icon-192x192.png')
New-Icon -Size 512 -Path (Join-Path $outputDir 'icon-512x512.png')

Write-Host 'Icon generation complete.'
