param(
    [Parameter(Mandatory = $true)][ValidateSet('Read', 'Write', 'RestorePoint')][string]$Action,
    [string]$PayloadBase64 = 'e30='
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

try {
    $catalogPath = Join-Path $PSScriptRoot '..\main\profile-catalog.json'
    $catalog = Get-Content -LiteralPath $catalogPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadBase64)) | ConvertFrom-Json -ErrorAction Stop

    function Get-Identity {
        try {
            $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
            $principal = New-Object Security.Principal.WindowsPrincipal($identity)
            $machineKey = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\Microsoft\Cryptography')
            try { $machine = [string]$machineKey.GetValue('MachineGuid') } finally { if ($null -ne $machineKey) { $machineKey.Dispose() } }
            if ([string]::IsNullOrWhiteSpace($machine)) { throw 'Windows installation identity is unavailable.' }
            $desktopMatch = $false
            $sessionId = (Get-Process -Id $PID -ErrorAction Stop).SessionId
            $shells = @(Get-CimInstance Win32_Process -Filter "Name = 'explorer.exe' AND SessionId = $sessionId" -ErrorAction Stop)
            foreach ($shell in $shells) {
                $owner = Invoke-CimMethod -InputObject $shell -MethodName GetOwnerSid -ErrorAction Stop
                if ($owner.ReturnValue -eq 0 -and $owner.Sid -eq $identity.User.Value) { $desktopMatch = $true }
            }
            return [ordered]@{ machine = $machine; sid = $identity.User.Value; administrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator); desktopMatch = $desktopMatch }
        } catch { throw }
    }

    function Get-Plans {
        try {
            $lines = & "$env:SystemRoot\System32\powercfg.exe" /list
            if ($LASTEXITCODE -ne 0) { throw 'Cannot list Windows power plans.' }
            return @($lines | ForEach-Object {
                if ($_ -match '([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})\s+\((.+)\)') {
                    [ordered]@{ id = $Matches[1].ToLowerInvariant(); name = $Matches[2] }
                }
            })
        } catch { throw }
    }

    function Read-Registry {
        param($Specification)
        $key = $null
        try {
            $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($Specification.key)
            $exists = $null -ne $key -and $key.GetValueNames() -contains $Specification.name
            if (-not $exists) { return [ordered]@{ id = $Specification.id; keyExists = $null -ne $key; exists = $false; kind = $null; value = $null } }
            $kind = $key.GetValueKind($Specification.name).ToString()
            $value = $key.GetValue($Specification.name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            switch ($kind) {
                'Binary' { $value = [Convert]::ToBase64String([byte[]]$value) }
                'None' { $value = [Convert]::ToBase64String([byte[]]$value) }
                'QWord' { $value = ([long]$value).ToString([Globalization.CultureInfo]::InvariantCulture) }
                'MultiString' { $value = @([string[]]$value) }
            }
            return [ordered]@{ id = $Specification.id; keyExists = $true; exists = $true; kind = $kind; value = $value }
        } catch { throw } finally { if ($null -ne $key) { $key.Dispose() } }
    }

    $identity = Get-Identity
    if ($Action -eq 'Read') {
        $active = & "$env:SystemRoot\System32\powercfg.exe" /getactivescheme
        if ($LASTEXITCODE -ne 0 -or $active -notmatch '([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})') { throw 'Cannot read the active power plan.' }
        $activeId = $Matches[1].ToLowerInvariant()
        $entries = @($catalog.settings | ForEach-Object { Read-Registry $_ })
        [ordered]@{ identity = $identity; plans = @(Get-Plans); state = [ordered]@{ powerPlan = $activeId; registry = $entries } } | ConvertTo-Json -Depth 8 -Compress
        exit 0
    }

    if (-not $identity.administrator) { throw 'Administrator access is required.' }
    if (-not $identity.desktopMatch) { throw 'Run XeroLag as the Windows user who owns the current desktop.' }
    if ($payload.identity.machine -ne $identity.machine -or $payload.identity.sid -ne $identity.sid) { throw 'The backup belongs to another Windows installation or user.' }

    if ($Action -eq 'RestorePoint') {
        if ($payload.snapshotId -notmatch '^[0-9a-fA-F-]{36}$') { throw 'Invalid backup identifier.' }
        $description = 'XeroLag ' + $payload.snapshotId
        $points = @(Get-ComputerRestorePoint -ErrorAction Stop)
        $existing = $points | Where-Object { $_.Description -eq $description } | Sort-Object SequenceNumber -Descending | Select-Object -First 1
        $reused = $false
        if ($null -ne $existing) {
            $created = [Management.ManagementDateTimeConverter]::ToDateTime($existing.CreationTime)
            $reused = $created -gt (Get-Date).AddHours(-24)
        }
        if (-not $reused) {
            Checkpoint-Computer -Description $description -RestorePointType MODIFY_SETTINGS -ErrorAction Stop -WarningAction Stop
            $existing = Get-ComputerRestorePoint -ErrorAction Stop | Where-Object { $_.Description -eq $description } | Sort-Object SequenceNumber -Descending | Select-Object -First 1
            if ($null -eq $existing) { throw 'Windows did not confirm the restore point.' }
        }
        [ordered]@{ sequence = [int]$existing.SequenceNumber; createdAt = [Management.ManagementDateTimeConverter]::ToDateTime($existing.CreationTime).ToUniversalTime().ToString('o'); reused = $reused } | ConvertTo-Json -Compress
        exit 0
    }

    $state = $payload.state
    if ($state.powerPlan -notmatch '^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$') { throw 'Invalid power plan identifier.' }
    if (-not (@(Get-Plans).id -contains $state.powerPlan)) { throw 'The saved power plan is no longer installed.' }
    if (@($state.registry).Count -ne @($catalog.settings).Count) { throw 'The registry snapshot is incomplete.' }
    $ids = @($state.registry | ForEach-Object { $_.id } | Select-Object -Unique)
    if ($ids.Count -ne @($catalog.settings).Count) { throw 'The registry snapshot contains duplicates.' }
    foreach ($entry in $state.registry) {
        if (-not (@($catalog.settings).id -contains $entry.id)) { throw 'Unknown registry setting.' }
        if ($entry.exists -isnot [bool] -or $entry.keyExists -isnot [bool]) { throw 'Invalid registry value state.' }
        if ($entry.exists -and $entry.kind -notin @('String', 'ExpandString', 'MultiString', 'DWord', 'QWord', 'Binary', 'None')) { throw 'Unsupported original registry type.' }
    }

    foreach ($specification in $catalog.settings) {
        $entry = $state.registry | Where-Object { $_.id -eq $specification.id } | Select-Object -First 1
        $key = $null
        try {
            if ($entry.exists) {
                $kind = [Microsoft.Win32.RegistryValueKind][Enum]::Parse([Microsoft.Win32.RegistryValueKind], $entry.kind)
                $value = $entry.value
                switch ($entry.kind) {
                    'DWord' { $value = [int]$value }
                    'QWord' { $value = [long]::Parse([string]$value, [Globalization.CultureInfo]::InvariantCulture) }
                    'Binary' { $value = [Convert]::FromBase64String([string]$value) }
                    'None' { $value = [Convert]::FromBase64String([string]$value) }
                    'MultiString' { $value = [string[]]$value }
                    default { $value = [string]$value }
                }
                $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($specification.key)
                $key.SetValue($specification.name, $value, $kind)
                $key.Flush()
            } else {
                $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($specification.key, $true)
                if ($null -ne $key) { $key.DeleteValue($specification.name, $false); $key.Flush() }
            }
        } catch { throw } finally { if ($null -ne $key) { $key.Dispose() } }
    }
    # Only remove an originally absent key if nobody has added other values to it.
    foreach ($group in ($catalog.settings | Group-Object key)) {
        $remove = $true
        foreach ($specification in $group.Group) {
            $entry = $state.registry | Where-Object { $_.id -eq $specification.id } | Select-Object -First 1
            if ($entry.keyExists -or $entry.exists) { $remove = $false }
        }
        if ($remove) {
            $key = $null
            $empty = $false
            try {
                $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($group.Name)
                $empty = $null -ne $key -and $key.ValueCount -eq 0 -and $key.SubKeyCount -eq 0
            } catch { throw } finally { if ($null -ne $key) { $key.Dispose() } }
            if ($empty) {
                try { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey($group.Name, $false) } catch { throw }
            }
        }
    }
    try {
        & "$env:SystemRoot\System32\powercfg.exe" /setactive $state.powerPlan | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Windows refused the power plan change.' }
    } catch { throw }
    [ordered]@{ written = $true } | ConvertTo-Json -Compress
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
