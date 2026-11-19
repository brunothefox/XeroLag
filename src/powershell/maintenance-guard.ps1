param([string]$PayloadPath)
. (Join-Path $PSScriptRoot 'common.ps1')
$states=@();$payload=$null;$failures=@()
try {
    $payload=Read-Payload $PayloadPath
    $null=Assert-Context $payload.identity
    $parent=Get-Process -Id $payload.parentPid -ErrorAction Stop
    $parentTime=$parent.StartTime.ToUniversalTime().Ticks
    foreach($name in @('wuauserv','BITS')){
        $service=Get-Service -Name $name -ErrorAction Stop
        if($service.Status -notin @('Running','Stopped')){throw ($name+' is changing state. Try again after Windows Update finishes.')}
        $states+=[ordered]@{name=$name;running=$service.Status -eq 'Running'}
    }
    [IO.File]::WriteAllText($payload.journal,($states|ConvertTo-Json -Compress),[Text.Encoding]::UTF8)
    foreach($entry in $states){if($entry.running){
        try{$service=Get-Service -Name $entry.name -ErrorAction Stop;$service.Stop();$service.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(10))}
        catch{throw ('Could not pause '+$entry.name+': '+$_.Exception.Message)}
    }}
    [IO.File]::WriteAllText($payload.ready,'ready',[Text.Encoding]::UTF8)
    while(-not(Test-Path -LiteralPath $payload.stop)){
        Start-Sleep -Milliseconds 500
        $current=Get-Process -Id $payload.parentPid -ErrorAction SilentlyContinue
        if(-not $current -or $current.StartTime.ToUniversalTime().Ticks -ne $parentTime){break}
    }
}catch{[Console]::Error.WriteLine($_.Exception.Message);if($payload){try{[IO.File]::WriteAllText($payload.ready,('error: '+$_.Exception.Message),[Text.Encoding]::UTF8)}catch{[Console]::Error.WriteLine($_.Exception.Message)}}}
finally{
    $restored=$true
    foreach($entry in $states){if($entry.running){try{$service=Get-Service -Name $entry.name -ErrorAction Stop;$service.Refresh();if($service.Status -eq 'StopPending'){$service.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(10));$service.Refresh()};if($service.Status -ne 'Running'){if($service.Status -ne 'StartPending'){$service.Start()};$service.WaitForStatus('Running',[TimeSpan]::FromSeconds(15))}}catch{$restored=$false;$failures+=('Could not restart '+$entry.name+': '+$_.Exception.Message);[Console]::Error.WriteLine($failures[-1])}}}
    if($payload -and $restored){try{[IO.File]::WriteAllText($payload.done,'done',[Text.Encoding]::UTF8)}catch{[Console]::Error.WriteLine($_.Exception.Message)}}
}
