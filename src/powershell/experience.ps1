param([ValidateSet('Boot','Processes','Probe','Network','Restart','Close')][string]$Action,[string]$PayloadPath)
. (Join-Path $PSScriptRoot 'common.ps1')
try {
    $payload=Read-Payload $PayloadPath
    function Find-Adapter {
        if($payload.guid -notmatch '^[a-fA-F0-9-]{36}$'){throw 'Invalid adapter.'}
        $adapter=Get-NetAdapter -ErrorAction Stop|Where-Object{([guid]$_.InterfaceGuid).ToString() -eq $payload.guid}|Select-Object -First 1
        if(-not $adapter){throw 'The adapter is no longer available.'};return $adapter
    }
    function Controllable($Process,$Context){
        if($Process.SessionId -ne $Context.sessionId -or $Process.MainWindowHandle -eq [IntPtr]::Zero -or $Process.Id -eq $payload.parentPid -or $Process.ProcessName -in @('XeroLag','electron','explorer','dwm','ShellExperienceHost','SearchHost','StartMenuExperienceHost','ApplicationFrameHost','RuntimeBroker','TextInputHost','ctfmon','conhost','msedgewebview2')){return $false}
        try{if(-not $Process.Path -or $Process.Path.StartsWith($env:SystemRoot+'\',[StringComparison]::OrdinalIgnoreCase)){return $false};$cim=Get-CimInstance Win32_Process -Filter ('ProcessId='+$Process.Id) -ErrorAction Stop;$owner=Invoke-CimMethod -InputObject $cim -MethodName GetOwnerSid -ErrorAction Stop;return $owner.ReturnValue -eq 0 -and $owner.Sid -eq $Context.sid}catch{return $false}
    }
    switch($Action){
        'Boot' {
            $result=[ordered]@{supported=$false;milliseconds=$null;createdAt=$null;applications=@();reason='Windows has not supplied a boot-performance record.'}
            try{
                $event=Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-Diagnostics-Performance/Operational';Id=100} -MaxEvents 1 -ErrorAction Stop
                $values=@{};foreach($item in ([xml]$event.ToXml()).Event.EventData.Data){$values[[string]$item.Name]=[string]$item.'#text'}
                if($values.BootTime -match '^\d+$'){$result.supported=$true;$result.milliseconds=[double]$values.BootTime;$result.createdAt=$event.TimeCreated.ToUniversalTime().ToString('o');$result.reason=$null}
                try{foreach($item in @(Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-Diagnostics-Performance/Operational';Id=101;StartTime=$event.TimeCreated.AddMinutes(-10)} -MaxEvents 60 -ErrorAction Stop)){$fields=@{};foreach($value in ([xml]$item.ToXml()).Event.EventData.Data){$fields[[string]$value.Name]=[string]$value.'#text'};if($fields.TotalTime -match '^\d+$'){$result.applications+=[ordered]@{name=$fields.Name;label=$fields.FriendlyName;milliseconds=[double]$fields.TotalTime;createdAt=$item.TimeCreated.ToUniversalTime().ToString('o')}}}}catch{}
            }catch{}
            $result|ConvertTo-Json -Depth 8 -Compress
        }
        'Processes' {
            $context=Get-Context;$items=@()
            foreach($process in @(Get-Process -ErrorAction Stop|Where-Object{$_.SessionId -eq $context.sessionId}|Sort-Object WorkingSet64 -Descending|Select-Object -First 150)){
                try{$items+=[ordered]@{pid=$process.Id;name=$process.ProcessName;memory=[double]$process.WorkingSet64;cpuSeconds=[double]$process.CPU;priority=$process.PriorityClass.ToString();ticks=$process.StartTime.ToUniversalTime().Ticks.ToString();executable=$process.Path;canClose=(Controllable $process $context)}}catch{}
            }
            ConvertTo-Json -InputObject $items -Depth 5 -Compress
        }
        'Close' {
            $context=Assert-Context $payload.identity;$process=Get-Process -Id ([int]$payload.pid) -ErrorAction Stop
            if($process.StartTime.ToUniversalTime().Ticks.ToString() -ne [string]$payload.ticks -or -not (Controllable $process $context)){throw 'The selected app changed or is protected.'}
            if(-not $process.CloseMainWindow()){throw 'The app did not accept a normal close request. Use Windows Task Manager if it is unresponsive.'}
            [ordered]@{success=$true}|ConvertTo-Json -Compress
        }
        'Network' {
            $adapter=Find-Adapter;$config=Get-NetIPConfiguration -InterfaceIndex $adapter.ifIndex -ErrorAction Stop;$ip=Get-NetIPInterface -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -ErrorAction Stop|Select-Object -First 1
            [ordered]@{name=$adapter.Name;status=$adapter.Status.ToString();linkSpeed=$adapter.LinkSpeed;mode=$ip.Dhcp.ToString();mtu=$ip.NlMtu;gateway=@($config.IPv4DefaultGateway.NextHop);addresses=@($config.IPv4Address.IPAddress);dns=@((Get-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -ErrorAction Stop).ServerAddresses)}|ConvertTo-Json -Depth 5 -Compress
        }
        'Probe' {
            $samples=@();$ping=New-Object Net.NetworkInformation.Ping
            try{for($index=0;$index -lt 4;$index++){try{$reply=$ping.Send('1.1.1.1',1000);if($reply.Status -eq 'Success'){$samples+=[double]$reply.RoundtripTime}}catch{};Start-Sleep -Milliseconds 100}}finally{$ping.Dispose()}
            $jitter=@();for($index=1;$index -lt $samples.Count;$index++){$jitter+=[Math]::Abs($samples[$index]-$samples[$index-1])}
            [ordered]@{target='1.1.1.1';sent=4;received=$samples.Count;loss=(100*(4-$samples.Count)/4);latency=if($samples.Count){[Math]::Round(($samples|Measure-Object -Average).Average,1)}else{$null};jitter=if($jitter.Count){[Math]::Round(($jitter|Measure-Object -Average).Average,1)}else{$null};createdAt=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json -Compress
        }
        'Restart' {
            $null=Assert-Context $payload.identity;$adapter=Find-Adapter
            if($adapter.Status -eq 'Disabled'){throw 'Enable this adapter in Windows before restarting it.'}
            try{$adapter|Restart-NetAdapter -Confirm:$false -ErrorAction Stop}finally{try{$current=Find-Adapter;if($current.Status -eq 'Disabled'){$current|Enable-NetAdapter -Confirm:$false -ErrorAction Stop}}catch{throw}}
            [ordered]@{success=$true}|ConvertTo-Json -Compress
        }
    }
}catch{[Console]::Error.WriteLine($_.Exception.Message);exit 1}
