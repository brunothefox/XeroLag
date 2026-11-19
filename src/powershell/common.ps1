$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

function Read-Payload([string]$Path) {
    return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
}

function Get-Context {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    $machineKey = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\Microsoft\Cryptography')
    try { $machine = [string]$machineKey.GetValue('MachineGuid') } finally { if ($machineKey) { $machineKey.Dispose() } }
    $sessionId = (Get-Process -Id $PID -ErrorAction Stop).SessionId
    $desktop = $false
    foreach ($shell in @(Get-CimInstance Win32_Process -Filter "Name = 'explorer.exe' AND SessionId = $sessionId" -ErrorAction Stop)) {
        $owner = Invoke-CimMethod -InputObject $shell -MethodName GetOwnerSid -ErrorAction Stop
        if ($owner.ReturnValue -eq 0 -and $owner.Sid -eq $identity.User.Value) { $desktop = $true }
    }
    return [ordered]@{ machine = $machine; sid = $identity.User.Value; administrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator); desktopMatch = $desktop; sessionId = $sessionId }
}

function Assert-Context($Expected) {
    $context = Get-Context
    if (-not $context.administrator) { throw 'Administrator access is required.' }
    if (-not $context.desktopMatch) { throw 'Use the Windows account that owns this desktop.' }
    if ($context.machine -ne $Expected.machine -or $context.sid -ne $Expected.sid) { throw 'This backup belongs to another Windows installation or account.' }
    return $context
}

function Open-Hive([string]$Hive) {
    switch ($Hive) {
        'HKCU' { return [Microsoft.Win32.Registry]::CurrentUser }
        'HKLM' { return [Microsoft.Win32.Registry]::LocalMachine }
        default { throw 'Unsupported registry hive.' }
    }
}

function Read-Value($Definition) {
    $key = $null
    try {
        $key = (Open-Hive $Definition.hive).OpenSubKey($Definition.key)
        $exists = $null -ne $key -and $key.GetValueNames() -contains $Definition.name
        if (-not $exists) { return [ordered]@{ exists = $false; keyExists = $null -ne $key; kind = $null; value = $null } }
        $kind = $key.GetValueKind($Definition.name).ToString()
        $value = $key.GetValue($Definition.name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        switch ($kind) {
            'Binary' { $value = [Convert]::ToBase64String([byte[]]$value) }
            'None' { $value = [Convert]::ToBase64String([byte[]]$value) }
            'QWord' { $value = ([long]$value).ToString([Globalization.CultureInfo]::InvariantCulture) }
            'MultiString' { $value = @([string[]]$value) }
        }
        return [ordered]@{ exists = $true; keyExists = $true; kind = $kind; value = $value }
    } catch { throw } finally { if ($key) { $key.Dispose() } }
}

function Write-Value($Definition, $State) {
    $key = $null
    try {
        $hive = Open-Hive $Definition.hive
        if ($State.exists) {
            $value = $State.value
            switch ($State.kind) {
                'DWord' { $value = [int]$value }
                'QWord' { $value = [long]::Parse([string]$value, [Globalization.CultureInfo]::InvariantCulture) }
                'Binary' { $value = [Convert]::FromBase64String([string]$value) }
                'None' { $value = [Convert]::FromBase64String([string]$value) }
                'MultiString' { $value = [string[]]$value }
                'String' { $value = [string]$value }
                'ExpandString' { $value = [string]$value }
                default { throw 'Unsupported registry data type.' }
            }
            $key = $hive.CreateSubKey($Definition.key)
            $key.SetValue($Definition.name, $value, [Microsoft.Win32.RegistryValueKind][Enum]::Parse([Microsoft.Win32.RegistryValueKind], $State.kind))
            $key.Flush()
        } else {
            $key = $hive.OpenSubKey($Definition.key, $true)
            if ($key) { $key.DeleteValue($Definition.name, $false); $key.Flush() }
        }
    } catch { throw } finally { if ($key) { $key.Dispose() } }
    if (-not $State.keyExists -and -not $State.exists) {
        $check = $null
        try {
            $check = $hive.OpenSubKey($Definition.key)
            $empty = $check -and $check.ValueCount -eq 0 -and $check.SubKeyCount -eq 0
        } finally { if ($check) { $check.Dispose() } }
        if ($empty) { try { $hive.DeleteSubKey($Definition.key, $false) } catch { throw } }
    }
    $actual = Read-Value $Definition
    if ($actual.exists -ne [bool]$State.exists -or ($State.exists -and ($actual.kind -ne $State.kind -or ($actual.value | ConvertTo-Json -Compress) -ne ($State.value | ConvertTo-Json -Compress)))) { throw 'Windows did not retain the registry setting.' }
}

function Get-PowerPlans {
    $active = & "$env:SystemRoot\System32\powercfg.exe" /getactivescheme
    if ($LASTEXITCODE -ne 0 -or $active -notmatch '([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})') { throw 'Cannot read power plan.' }
    $activeId = $Matches[1].ToLowerInvariant()
    $lines = & "$env:SystemRoot\System32\powercfg.exe" /list
    if ($LASTEXITCODE -ne 0) { throw 'Cannot list power plans.' }
    $plans = @($lines | ForEach-Object { if ($_ -match '([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})\s+\((.+)\)') { [ordered]@{ id = $Matches[1].ToLowerInvariant(); name = $Matches[2] } } })
    return [ordered]@{ active = $activeId; plans = $plans }
}

function Set-PowerPlan([string]$Id) {
    if ($Id -notmatch '^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' -or -not ((Get-PowerPlans).plans.id -contains $Id)) { throw 'Power plan is unavailable.' }
    & "$env:SystemRoot\System32\powercfg.exe" /setactive $Id | Out-Null
    if ($LASTEXITCODE -ne 0 -or (Get-PowerPlans).active -ne $Id) { throw 'Windows refused the power plan change.' }
}
