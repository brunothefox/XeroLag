param([ValidateSet('Inspect','Capture','Apply','Restore')][string]$Action, [string]$PayloadPath)
. (Join-Path $PSScriptRoot 'common.ps1')
try {
    $payload = Read-Payload $PayloadPath
    $catalog = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\main\action-catalog.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    function Get-Definition([string]$Id) {
        $definition = $catalog | Where-Object { $_.id -eq $Id } | Select-Object -First 1
        if (-not $definition) { throw 'Unknown system setting.' }
        return $definition
    }
    function Initialize-PowerApi {
        if ('XeroPower' -as [type]) { return }
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class XeroPower {
 [DllImport("powrprof.dll")] public static extern uint PowerReadACValueIndex(IntPtr r, ref Guid p, ref Guid s, ref Guid v, out uint n);
 [DllImport("powrprof.dll")] public static extern uint PowerReadDCValueIndex(IntPtr r, ref Guid p, ref Guid s, ref Guid v, out uint n);
 [DllImport("powrprof.dll")] public static extern uint PowerWriteACValueIndex(IntPtr r, ref Guid p, ref Guid s, ref Guid v, uint n);
 [DllImport("powrprof.dll")] public static extern uint PowerWriteDCValueIndex(IntPtr r, ref Guid p, ref Guid s, ref Guid v, uint n);
}
'@ -ErrorAction Stop
    }
    function Power-Items($Definition, [string]$Plan) {
        Initialize-PowerApi
        $items = if ($Definition.kind -eq 'usb') { [pscustomobject]@{subgroup='2a737441-1930-4402-8d77-b2bebba308a3';setting='48e6b7a6-50f5-4782-a5d4-53bb8f07e226';target=0} } else { @([pscustomobject]@{subgroup='54533251-82be-4824-96c1-47b60b740d00';setting='0cc5b647-c1df-4637-891a-dec35c318583';target=100},[pscustomobject]@{subgroup='54533251-82be-4824-96c1-47b60b740d00';setting='ea062031-0e34-4ff1-9b6d-eb1059334028';target=100}) }
        return @($items | ForEach-Object {
            $p = [guid]$Plan; $s = [guid]$_.subgroup; $v = [guid]$_.setting; [uint32]$ac = 0; [uint32]$dc = 0
            if ([XeroPower]::PowerReadACValueIndex([IntPtr]::Zero,[ref]$p,[ref]$s,[ref]$v,[ref]$ac) -ne 0 -or [XeroPower]::PowerReadDCValueIndex([IntPtr]::Zero,[ref]$p,[ref]$s,[ref]$v,[ref]$dc) -ne 0) { throw 'This power setting is not supported on the current plan.' }
            [ordered]@{ subgroup = $s.ToString(); setting = $v.ToString(); ac = $ac; dc = $dc; target = $_.target }
        })
    }
    function Capture-Setting($Definition) {
        switch ($Definition.type) {
            'registry' { return [ordered]@{ values = @($Definition.entries | ForEach-Object { Read-Value $_ }) } }
            'service' {
                $service = Get-CimInstance Win32_Service -Filter ("Name='" + $Definition.name + "'") -ErrorAction Stop
                if (-not $service) { throw 'Service is not installed.' }
                $delayed = Read-Value ([pscustomobject]@{ hive='HKLM'; key=('SYSTEM\CurrentControlSet\Services\' + $Definition.name); name='DelayedAutoStart' })
                return [ordered]@{ mode = $service.StartMode; running = $service.State -eq 'Running'; delayed = $delayed }
            }
            'special' {
                if ($Definition.kind -in @('clock','tick')) {
                    $name = if ($Definition.kind -eq 'clock') { 'useplatformclock' } else { 'disabledynamictick' }
                    $lines = & "$env:SystemRoot\System32\bcdedit.exe" /enum '{current}'
                    if ($LASTEXITCODE -ne 0) { throw 'Boot settings cannot be read. Administrator access is required.' }
                    $line = $lines | Where-Object { $_ -match ('^\s*' + $name + '\s+') } | Select-Object -First 1
                    $value = $null
                    if ($line) {
                        $raw = ($line -replace ('^\s*' + $name + '\s+'),'').Trim()
                        if ($raw -notmatch '^(Yes|No)$') { throw 'This boot value cannot be interpreted safely in the current Windows language.' }
                        $value = $raw
                    }
                    return [ordered]@{ value = $value }
                }
                $plans = Get-PowerPlans
                if ($Definition.kind -in @('usb','unpark')) { return [ordered]@{ plan = $plans.active; items = @(Power-Items $Definition $plans.active) } }
                if ($Definition.kind -eq 'ultimate') { return [ordered]@{ plan = $plans.active; existing = @($plans.plans.id); created = $null } }
                throw 'Unknown power operation.'
            }
        }
    }
    function Change-Setting($Definition, $Original, [bool]$Restore) {
        switch ($Definition.type) {
            'registry' {
                if ($Restore -and @($Original.values).Count -ne @($Definition.entries).Count) { throw 'Incomplete registry backup.' }
                for ($index = 0; $index -lt @($Definition.entries).Count; $index++) {
                    $entry = $Definition.entries[$index]
                    if ($Restore) { $state = $Original.values[$index] }
                    else {
                        $value = $entry.value
                        if ($entry.clearBits) { $current = Read-Value $entry; $number = 510; if ($current.exists -and [string]$current.value -match '^\d+$') { $number = [int]$current.value }; $value = [string]($number -band (-bnot [int]$entry.clearBits)) }
                        $state = [pscustomobject]@{ exists=$true; keyExists=$true; kind=$entry.kind; value=$value }
                    }
                    try { Write-Value $entry $state } catch { throw }
                }
            }
            'service' {
                if ($Restore) {
                    $mode = switch ($Original.mode) { 'Auto' {'Automatic'} 'Manual' {'Manual'} 'Disabled' {'Disabled'} default { throw 'Unknown saved service mode.' } }
                    try {
                        Set-Service -Name $Definition.name -StartupType $(if($mode -eq 'Disabled' -and $Original.running){'Manual'}else{$mode}) -ErrorAction Stop
                        Write-Value ([pscustomobject]@{ hive='HKLM'; key=('SYSTEM\CurrentControlSet\Services\' + $Definition.name); name='DelayedAutoStart' }) $Original.delayed
                        if ($Original.running) { Start-Service -Name $Definition.name -ErrorAction Stop } else { Stop-Service -Name $Definition.name -ErrorAction Stop }
                        if($mode -eq 'Disabled' -and $Original.running){Set-Service -Name $Definition.name -StartupType Disabled -ErrorAction Stop}
                    } catch { throw }
                } elseif($Definition.enable) {
                    $mode=if($Definition.name -eq 'SysMain'){'Automatic'}else{'Manual'}
                    try{Set-Service -Name $Definition.name -StartupType $mode -ErrorAction Stop;Start-Service -Name $Definition.name -ErrorAction Stop}catch{throw}
                } else {
                    try { Stop-Service -Name $Definition.name -ErrorAction Stop; Set-Service -Name $Definition.name -StartupType Disabled -ErrorAction Stop } catch { throw }
                }
                $actual = Capture-Setting $Definition
                if (($Restore -and ($actual.mode -ne $Original.mode -or $actual.running -ne $Original.running)) -or (-not $Restore -and -not $Definition.enable -and ($actual.mode -ne 'Disabled' -or $actual.running)) -or (-not $Restore -and $Definition.enable -and -not $actual.running)) { throw 'Service state verification failed.' }
            }
            'special' {
                if ($Definition.kind -in @('clock','tick')) {
                    $name = if ($Definition.kind -eq 'clock') { 'useplatformclock' } else { 'disabledynamictick' }
                    $target = if ($Restore) { $Original.value } elseif($Definition.PSObject.Properties.Name -contains 'bootValue'){$Definition.bootValue} elseif ($Definition.kind -eq 'tick') { 'Yes' } else { $null }
                    if ($null -eq $target) {
                        if ($null -ne (Capture-Setting $Definition).value) { & "$env:SystemRoot\System32\bcdedit.exe" /deletevalue '{current}' $name | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'Windows refused the boot setting change.' } }
                    } else {
                        if ($target -notin @('Yes','No')) { throw 'Invalid saved boot value.' }
                        & "$env:SystemRoot\System32\bcdedit.exe" /set '{current}' $name $target | Out-Null
                        if ($LASTEXITCODE -ne 0) { throw 'Windows refused the boot setting change. Check Secure Boot and device policy.' }
                    }
                    if ((Capture-Setting $Definition).value -ne $target) { throw 'Boot setting verification failed.' }
                } elseif ($Definition.kind -in @('usb','unpark')) {
                    Initialize-PowerApi
                    $p = [guid]$Original.plan
                    $known = @(Power-Items $Definition $Original.plan)
                    if (@($Original.items).Count -ne $known.Count) { throw 'Incomplete power setting backup.' }
                    for ($index=0; $index -lt $known.Count; $index++) {
                        $s = [guid]$known[$index].subgroup; $v = [guid]$known[$index].setting
                        [uint32]$ac = if ($Restore) { $Original.items[$index].ac } else { $known[$index].target }
                        [uint32]$dc = if ($Restore) { $Original.items[$index].dc } else { $known[$index].target }
                        if ([XeroPower]::PowerWriteACValueIndex([IntPtr]::Zero,[ref]$p,[ref]$s,[ref]$v,$ac) -ne 0 -or [XeroPower]::PowerWriteDCValueIndex([IntPtr]::Zero,[ref]$p,[ref]$s,[ref]$v,$dc) -ne 0) { throw 'Power setting write failed.' }
                    }
                    if ((Get-PowerPlans).active -eq $Original.plan) { Set-PowerPlan $Original.plan }
                    $verified = @(Power-Items $Definition $Original.plan)
                    for ($index=0; $index -lt $verified.Count; $index++) {
                        $expectedAc = if ($Restore) { $Original.items[$index].ac } else { $known[$index].target }
                        $expectedDc = if ($Restore) { $Original.items[$index].dc } else { $known[$index].target }
                        if ($verified[$index].ac -ne $expectedAc -or $verified[$index].dc -ne $expectedDc) { throw 'Power setting verification failed.' }
                    }
                } elseif ($Definition.kind -eq 'ultimate') {
                    if ($Restore) {
                        Set-PowerPlan $Original.plan
                        if ($Original.created -and $Original.created -match '^[a-fA-F0-9-]{36}$' -and -not ($Original.existing -contains $Original.created) -and (Get-PowerPlans).plans.id -contains $Original.created) {
                            & "$env:SystemRoot\System32\powercfg.exe" /delete $Original.created | Out-Null
                            if ($LASTEXITCODE -ne 0) { throw 'The XeroLag power plan could not be removed.' }
                        }
                    } else {
                        $id = [string]$payload.createdPlan
                        if ($id -notmatch '^[a-fA-F0-9-]{36}$' -or (Get-PowerPlans).plans.id -contains $id) { throw 'Invalid new power plan identifier.' }
                        & "$env:SystemRoot\System32\powercfg.exe" /duplicatescheme e9a42b02-d5df-448d-aa00-03f14749eb61 $id | Out-Null
                        if ($LASTEXITCODE -ne 0) { throw 'Ultimate Performance is unavailable on this Windows installation.' }
                        & "$env:SystemRoot\System32\powercfg.exe" /changename $id 'XeroLag Ultimate Performance' | Out-Null
                        if ($LASTEXITCODE -ne 0) { throw 'Could not name the new power plan.' }
                        Set-PowerPlan $id
                    }
                }
            }
        }
    }
    if ($Action -eq 'Inspect') {
        $result = @($catalog | ForEach-Object {
            $definition = $_
            try { $state = Capture-Setting $definition; [ordered]@{ id=$definition.id; supported=$true; state=$state } }
            catch { [ordered]@{ id=$definition.id; supported=$false; reason=$_.Exception.Message } }
        })
        [ordered]@{ items=$result; context=(Get-Context); power=(Get-PowerPlans) } | ConvertTo-Json -Depth 12 -Compress
        exit 0
    }
    $definition = Get-Definition $payload.id
    if ($Action -eq 'Capture') { Capture-Setting $definition | ConvertTo-Json -Depth 12 -Compress; exit 0 }
    $null = Assert-Context $payload.identity
    Change-Setting $definition $payload.original ($Action -eq 'Restore')
    [ordered]@{ success=$true } | ConvertTo-Json -Compress
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
