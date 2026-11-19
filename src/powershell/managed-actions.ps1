param([ValidateSet('Inspect','Preview','Capture','Apply','Restore','Ping','Flush')][string]$Action,[string]$PayloadPath)
. (Join-Path $PSScriptRoot 'common.ps1')
try {
    $payload=Read-Payload $PayloadPath
    $target=$payload.target
    function Adapter([string]$Guid) {
        if($Guid -notmatch '^[a-fA-F0-9-]{36}$'){throw 'Invalid network adapter.'}
        $adapter=Get-NetAdapter -ErrorAction Stop|Where-Object {([guid]$_.InterfaceGuid).ToString() -eq $Guid}|Select-Object -First 1
        if(-not $adapter){throw 'The selected adapter is no longer available.'}
        return $adapter
    }
    function Msi-Definitions([string]$Device) {
        $deviceInfo=Get-CimInstance Win32_PnPEntity -ErrorAction Stop|Where-Object {$_.PNPDeviceID -eq $Device -and $_.PNPClass -in @('Display','Net','USB') -and $_.PNPDeviceID -like 'PCI\*'}|Select-Object -First 1
        if(-not $deviceInfo){throw 'Unsupported interrupt device.'}
        $root='SYSTEM\CurrentControlSet\Enum\'+$deviceInfo.PNPDeviceID+'\Device Parameters\Interrupt Management'
        $msi=[pscustomobject]@{hive='HKLM';key=($root+'\MessageSignaledInterruptProperties');name='MSISupported'}
        if(-not (Read-Value $msi).exists){throw 'The driver does not expose MSI support. Forced enable is not supported.'}
        return @($msi,[pscustomobject]@{hive='HKLM';key=($root+'\Affinity Policy');name='DevicePriority'})
    }
    function Run-Definition($Target) {
        $allowed=@('Software\Microsoft\Windows\CurrentVersion\Run','SOFTWARE\Microsoft\Windows\CurrentVersion\Run','SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run')
        if($Target.hive -notin @('HKCU','HKLM') -or $Target.key -notin $allowed -or [string]::IsNullOrWhiteSpace($Target.name)){throw 'Invalid startup item.'}
        return [pscustomobject]@{hive=$Target.hive;key=$Target.key;name=$Target.name}
    }
    function Capture-Managed($Target) {
        switch($Target.type) {
            'mtu' {
                $adapter=Adapter $Target.guid
                $active=Get-NetIPInterface -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -PolicyStore ActiveStore -ErrorAction Stop|Select-Object -First 1
                $persistent=Get-NetIPInterface -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -PolicyStore PersistentStore -ErrorAction Stop|Select-Object -First 1
                return [ordered]@{active=[int]$active.NlMtu;persistent=[int]$persistent.NlMtu}
            }
            'markc' {
                $allowed=@('SmoothMouseXCurve','SmoothMouseYCurve','MouseSensitivity','MouseSpeed','MouseThreshold1','MouseThreshold2')
                if(@($Target.values).Count -gt 6){throw 'Invalid mouse preset.'}
                return [ordered]@{values=@($Target.values|ForEach-Object{if($_.name -notin $allowed){throw 'Unsupported mouse setting.'};Read-Value ([pscustomobject]@{hive='HKCU';key='Control Panel\Mouse';name=$_.name})})}
            }
            'msi' {return [ordered]@{values=@((Msi-Definitions $Target.device)|ForEach-Object{Read-Value $_})}}
            'nagle' {
                $adapter=Adapter $Target.guid
                $key='SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces\{'+([guid]$adapter.InterfaceGuid).ToString()+'}'
                return [ordered]@{values=@('TcpAckFrequency','TCPNoDelay'|ForEach-Object{Read-Value ([pscustomobject]@{hive='HKLM';key=$key;name=$_})})}
            }
            'dns' {
                $adapter=Adapter $Target.guid
                $families=@()
                foreach($family in @('IPv4','IPv6')) {
                    $branch=if($family -eq 'IPv4'){'Tcpip'}else{'Tcpip6'}
                    $definition=[pscustomobject]@{hive='HKLM';key=('SYSTEM\CurrentControlSet\Services\'+$branch+'\Parameters\Interfaces\{'+([guid]$adapter.InterfaceGuid).ToString()+'}');name='NameServer'}
                    $value=Read-Value $definition
                    $addresses=@((Get-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -AddressFamily $family -ErrorAction Stop).ServerAddresses)
                    $enabled=$true
                    if($family -eq 'IPv6'){$binding=Get-NetAdapterBinding -Name $adapter.Name -ComponentID ms_tcpip6 -ErrorAction Stop;$enabled=[bool]$binding.Enabled}
                    $families+= [ordered]@{family=$family;enabled=$enabled;manual=($value.exists -and -not [string]::IsNullOrWhiteSpace([string]$value.value));addresses=$addresses;registry=$value}
                }
                return [ordered]@{families=$families}
            }
            'startup-run' {return [ordered]@{value=(Read-Value (Run-Definition $Target))}}
            'startup-task' {
                if($Target.taskPath -like '\Microsoft\*' -or [string]::IsNullOrWhiteSpace($Target.taskName)){throw 'Windows system tasks are protected.'}
                $task=Get-ScheduledTask -TaskPath $Target.taskPath -TaskName $Target.taskName -ErrorAction Stop
                return [ordered]@{enabled=[bool]$task.Settings.Enabled}
            }
            'appx' {
                $allowed=@('Microsoft.Copilot','MicrosoftWindows.Client.WebExperience','Microsoft.XboxGamingOverlay','Microsoft.XboxGameOverlay','Microsoft.BingNews','Microsoft.BingWeather','Microsoft.549981C3F5F10','Microsoft.GetHelp','Microsoft.Getstarted','Microsoft.MicrosoftSolitaireCollection','Microsoft.People','Microsoft.WindowsFeedbackHub')
                if($Target.name -notin $allowed){throw 'This Windows package is protected.'}
                $package=Get-AppxPackage -Name $Target.name -ErrorAction Stop|Where-Object{-not $_.IsFramework -and -not $_.NonRemovable}|Select-Object -First 1
                if(-not $package){throw 'The package is no longer installed.'}
                return [ordered]@{name=$package.Name;fullName=$package.PackageFullName;family=$package.PackageFamilyName;location=$package.InstallLocation}
            }
            'recall' {return [ordered]@{state=(Get-WindowsOptionalFeature -Online -FeatureName Recall -ErrorAction Stop).State.ToString()}}
            'onedrive' {
                $signature=Get-AuthenticodeSignature -LiteralPath $Target.setup -ErrorAction Stop
                if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft Corporation'){throw 'A signed Microsoft OneDrive installer is required.'}
                if([Diagnostics.FileVersionInfo]::GetVersionInfo($Target.setup).OriginalFilename -notmatch '^OneDriveSetup\.exe$'){throw 'The selected signed file is not the OneDrive installer.'}
                if($Action -eq 'Preview'){return [ordered]@{installer=$Target.setup;verified=$true}}
                $folder=Join-Path $payload.dataRoot 'installers'
                try{New-Item -ItemType Directory -Path $folder -Force -ErrorAction Stop|Out-Null;$backup=Join-Path $folder 'OneDriveSetup.exe';Copy-Item -LiteralPath $Target.setup -Destination $backup -Force -ErrorAction Stop}catch{throw}
                return [ordered]@{setup=$backup}
            }
            default {throw 'Unsupported managed action.'}
        }
    }
    if($Action -eq 'Inspect'){[ordered]@{items=@()}|ConvertTo-Json -Compress;exit 0}
    if($Action -eq 'Ping') {
        $results=@()
        foreach($provider in @(@('cloudflare','1.1.1.1'),@('google','8.8.8.8'),@('quad9','9.9.9.9'))) {
            $latencies=@();$ping=New-Object Net.NetworkInformation.Ping
            try {for($attempt=0;$attempt -lt 2;$attempt++){try{$reply=$ping.Send($provider[1],1000);if($reply.Status -eq 'Success'){$latencies+=$reply.RoundtripTime}}catch{}}}finally{$ping.Dispose()}
            $lookup=$null;$watch=[Diagnostics.Stopwatch]::StartNew();try{$null=Resolve-DnsName -Name example.com -Server $provider[1] -Type A -DnsOnly -NoHostsFile -QuickTimeout -ErrorAction Stop;$lookup=[Math]::Round($watch.Elapsed.TotalMilliseconds,1)}catch{}finally{$watch.Stop()}
            $results+=[ordered]@{id=$provider[0];address=$provider[1];lookupMs=$lookup;milliseconds=if($latencies.Count){[Math]::Round(($latencies|Measure-Object -Average).Average,1)}else{$null}}
        }
        ConvertTo-Json -InputObject $results -Compress;exit 0
    }
    if($Action -eq 'Flush'){Clear-DnsClientCache -ErrorAction Stop;[ordered]@{success=$true}|ConvertTo-Json -Compress;exit 0}
    if($Action -in @('Capture','Preview')){Capture-Managed $target|ConvertTo-Json -Depth 12 -Compress;exit 0}
    $null=Assert-Context $payload.identity
    $restore=$Action -eq 'Restore';$original=$payload.original
    switch($target.type) {
        'mtu' {
            $adapter=Adapter $target.guid
            if(-not $restore -and [int]$target.value -notin @(1280,1400,1472,1492,1500)){throw 'Unsupported MTU choice.'}
            foreach($store in @('PersistentStore','ActiveStore')){
                $value=if($restore){if($store -eq 'ActiveStore'){[int]$original.active}else{[int]$original.persistent}}else{[int]$target.value}
                if($value -lt 576 -or $value -gt 65535){throw 'Invalid saved IPv4 MTU.'}
                try{Set-NetIPInterface -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -PolicyStore $store -NlMtuBytes $value -ErrorAction Stop}catch{throw}
            }
            $actual=Capture-Managed $target
            if(($restore -and ($actual.active -ne $original.active -or $actual.persistent -ne $original.persistent)) -or (-not $restore -and ($actual.active -ne $target.value -or $actual.persistent -ne $target.value))){throw 'MTU verification failed.'}
        }
        'markc' {
            $allowed=@('SmoothMouseXCurve','SmoothMouseYCurve','MouseSensitivity','MouseSpeed','MouseThreshold1','MouseThreshold2')
            if(@($target.values).Count -gt 6){throw 'Invalid mouse preset.'}
            for($i=0;$i -lt @($target.values).Count;$i++){
                $entry=$target.values[$i];if($entry.name -notin $allowed){throw 'Unsupported mouse setting.'}
                if($entry.name -like 'SmoothMouse*'){if($entry.kind -ne 'Binary' -or [Convert]::FromBase64String($entry.value).Length -ne 40){throw 'Invalid curve length.'}}elseif($entry.kind -ne 'String' -or $entry.value -notmatch '^\d{1,2}$'){throw 'Invalid mouse preference.'}
                $state=if($restore){$original.values[$i]}else{[pscustomobject]@{exists=$true;keyExists=$true;kind=$entry.kind;value=$entry.value}}
                try{Write-Value ([pscustomobject]@{hive='HKCU';key='Control Panel\Mouse';name=$entry.name}) $state}catch{throw}
            }
        }
        'msi' {
            $definitions=@(Msi-Definitions $target.device)
            for($i=0;$i -lt $definitions.Count;$i++){
                $state=if($restore){$original.values[$i]}elseif($i -eq 1 -and -not $target.highPriority){[pscustomobject]@{exists=$false;keyExists=$true;kind=$null;value=$null}}else{[pscustomobject]@{exists=$true;keyExists=$true;kind='DWord';value=if($i -eq 0){[int][bool]$target.msi}else{3}}}
                try {Write-Value $definitions[$i] $state}catch{throw}
            }
        }
        'nagle' {
            $adapter=Adapter $target.guid;$key='SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces\{'+([guid]$adapter.InterfaceGuid).ToString()+'}'
            $names=@('TcpAckFrequency','TCPNoDelay')
            for($i=0;$i -lt 2;$i++){$state=if($restore){$original.values[$i]}else{[pscustomobject]@{exists=$true;keyExists=$true;kind='DWord';value=if($target.disabled){1}elseif($i -eq 0){2}else{0}}};try{Write-Value ([pscustomobject]@{hive='HKLM';key=$key;name=$names[$i]}) $state}catch{throw}}
        }
        'dns' {
            $adapter=Adapter $target.guid
            if($restore) {
                foreach($family in $original.families){
                    if($family.family -notin @('IPv4','IPv6')){throw 'Invalid address family in backup.'}
                    $dns=Get-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -AddressFamily $family.family -ErrorAction Stop
                    if($family.manual){$validated=@($family.addresses|ForEach-Object{([Net.IPAddress]::Parse($_)).ToString()});if(-not $validated.Count){throw 'Static DNS backup is empty.'};$dns|Set-DnsClientServerAddress -ServerAddresses $validated -ErrorAction Stop}
                    else{$dns|Set-DnsClientServerAddress -ResetServerAddresses -ErrorAction Stop}
                    $branch=if($family.family -eq 'IPv4'){'Tcpip'}else{'Tcpip6'}
                    Write-Value ([pscustomobject]@{hive='HKLM';key=('SYSTEM\CurrentControlSet\Services\'+$branch+'\Parameters\Interfaces\{'+([guid]$adapter.InterfaceGuid).ToString()+'}');name='NameServer'}) $family.registry
                }
            } else {
                $addresses=switch($target.provider){'cloudflare'{@('1.1.1.1','1.0.0.1')}'google'{@('8.8.8.8','8.8.4.4')}'quad9'{@('9.9.9.9','149.112.112.112')}'default'{@()}default{throw 'Unknown DNS provider.'}}
                $dns=Get-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -ErrorAction Stop
                if($target.provider -eq 'default'){$dns|Set-DnsClientServerAddress -ResetServerAddresses -ErrorAction Stop}else{$dns|Set-DnsClientServerAddress -ServerAddresses $addresses -ErrorAction Stop}
                if($target.provider -ne 'default'){$actual=@((Get-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -ErrorAction Stop).ServerAddresses);if(($actual -join ',') -ne ($addresses -join ',')){throw 'DNS verification failed.'}}
                $ipv6=Get-NetAdapterBinding -Name $adapter.Name -ComponentID ms_tcpip6 -ErrorAction SilentlyContinue
                if($ipv6.Enabled){
                    $v6=Get-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv6 -ErrorAction Stop
                    if($target.provider -eq 'default'){$v6|Set-DnsClientServerAddress -ResetServerAddresses -ErrorAction Stop}
                    else{
                        $v6Addresses=switch($target.provider){'cloudflare'{@('2606:4700:4700::1111','2606:4700:4700::1001')}'google'{@('2001:4860:4860::8888','2001:4860:4860::8844')}'quad9'{@('2620:fe::fe','2620:fe::9')}}
                        $v6|Set-DnsClientServerAddress -ServerAddresses $v6Addresses -ErrorAction Stop
                    }
                }
                Clear-DnsClientCache -ErrorAction Stop
            }
        }
        'startup-run' {
            $definition=Run-Definition $target
            $state=if($restore){$original.value}else{[pscustomobject]@{exists=$false;keyExists=$true;kind=$null;value=$null}}
            try{Write-Value $definition $state}catch{throw}
        }
        'startup-task' {
            if($target.taskPath -like '\Microsoft\*'){throw 'Windows system tasks are protected.'}
            $null=Get-ScheduledTask -TaskPath $target.taskPath -TaskName $target.taskName -ErrorAction Stop
            $enable=if($restore){[bool]$original.enabled}else{[bool]$target.enable}
            if($enable){Enable-ScheduledTask -TaskPath $target.taskPath -TaskName $target.taskName -ErrorAction Stop|Out-Null}else{Disable-ScheduledTask -TaskPath $target.taskPath -TaskName $target.taskName -ErrorAction Stop|Out-Null}
            $actual=(Get-ScheduledTask -TaskPath $target.taskPath -TaskName $target.taskName -ErrorAction Stop).Settings.Enabled
            if([bool]$actual -ne $enable){throw 'Scheduled task verification failed.'}
        }
        'appx' {
            if($restore){
                if($original.name -ne $target.name -or $original.location -notlike (Join-Path $env:ProgramFiles 'WindowsApps\*')){throw 'Invalid package recovery location.'}
                $manifest=Join-Path $original.location 'AppxManifest.xml'
                if(-not(Test-Path -LiteralPath $manifest)){throw 'Windows removed this package payload. Reinstall it from Microsoft Store.'}
                Add-AppxPackage -DisableDevelopmentMode -Register $manifest -ErrorAction Stop
            }else{$package=Capture-Managed $target;Remove-AppxPackage -Package $package.fullName -ErrorAction Stop}
        }
        'recall' {
            if($restore -and $original.state -eq 'Enabled'){Enable-WindowsOptionalFeature -Online -FeatureName Recall -NoRestart -ErrorAction Stop|Out-Null}else{Disable-WindowsOptionalFeature -Online -FeatureName Recall -NoRestart -ErrorAction Stop|Out-Null}
        }
        'onedrive' {
            $source=$original.setup
            $signature=Get-AuthenticodeSignature -LiteralPath $source -ErrorAction Stop
            if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft Corporation'){throw 'A signed Microsoft OneDrive installer is required for this operation.'}
            $arguments=if($restore){'/silent'}else{'/uninstall'}
            $process=Start-Process -FilePath $source -ArgumentList $arguments -PassThru -Wait -WindowStyle Hidden -ErrorAction Stop
            if($process.ExitCode -ne 0){throw 'OneDrive setup returned an error.'}
        }
        default{throw 'Unknown managed operation.'}
    }
    [ordered]@{success=$true}|ConvertTo-Json -Compress
}catch{[Console]::Error.WriteLine($_.Exception.Message);exit 1}
