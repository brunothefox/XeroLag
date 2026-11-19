$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$prefix = $workspace + '\'
$targets = @('.cache', 'assets\generated', 'src\renderer\styles\output.css', 'coverage')

function Assert-GeneratedPath([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Refusing to clean a path outside this project.'
    }
    $pending = New-Object 'Collections.Generic.Stack[string]'
    $pending.Push($full)
    while ($pending.Count -gt 0) {
        $item = Get-Item -LiteralPath ($pending.Pop()) -Force -ErrorAction Stop
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw ('Refusing to recursively clean a linked path: ' + $item.FullName)
        }
        if ($item.PSIsContainer) {
            foreach ($child in @(Get-ChildItem -LiteralPath $item.FullName -Force -ErrorAction Stop)) {
                $pending.Push($child.FullName)
            }
        }
    }
    return $full
}

foreach ($relative in $targets) {
    $candidate = [IO.Path]::GetFullPath((Join-Path $workspace $relative))
    if (Test-Path -LiteralPath $candidate) {
        $checked = Assert-GeneratedPath $candidate
        Remove-Item -LiteralPath $checked -Recurse -Force -ErrorAction Stop
        Write-Output ('Removed ' + $relative)
    }
}
Write-Output 'Generated files cleaned. Source, dependencies, releases and application backups were kept.'
