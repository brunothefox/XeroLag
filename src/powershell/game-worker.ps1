param([ValidateSet('Run','Recover')][string]$Action='Run',[string]$PayloadPath)
. (Join-Path $PSScriptRoot 'common.ps1')
$config=$null;$session=$null;$handles=@{};$timerSet=$false;$fatalError=$null
try {
    $config=Read-Payload $PayloadPath
    $context=Assert-Context $config.identity
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class XeroGameNative {
 [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
 [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr process);
 [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr process);
 [DllImport("ntdll.dll")] public static extern int NtSetTimerResolution(uint desired,bool set,out uint actual);
 [DllImport("ntdll.dll")] public static extern int NtQueryTimerResolution(out uint minimum,out uint maximum,out uint actual);
}
'@ -ErrorAction Stop
    function Save-Json([string]$Path,$Value){
        $temporary=$Path+'.tmp';[IO.File]::WriteAllText($temporary,($Value|ConvertTo-Json -Depth 10 -Compress),[Text.Encoding]::UTF8)
        Move-Item -LiteralPath $temporary -Destination $Path -Force -ErrorAction Stop
    }
    function Owned-Process([int]$Id,[string]$Ticks){
        $process=Get-Process -Id $Id -ErrorAction SilentlyContinue
        if(-not $process -or $process.SessionId -ne $context.sessionId -or ($Ticks -and $process.StartTime.ToUniversalTime().Ticks.ToString() -ne $Ticks)){return $null}
        $cim=Get-CimInstance Win32_Process -Filter "ProcessId = $Id" -ErrorAction Stop
        if(-not $cim){return $null};$owner=Invoke-CimMethod -InputObject $cim -MethodName GetOwnerSid -ErrorAction Stop
        if($owner.ReturnValue -ne 0 -or $owner.Sid -ne $context.sid){return $null}
        return $process
    }
    function Restore-Session($Saved){
        $errors=@();$remainingSuspended=@();$remainingPriorities=@()
        foreach($entry in @($Saved.suspended)){
            try{
                $process=Owned-Process ([int]$entry.pid) ([string]$entry.ticks)
                if(-not $process){continue}
                if($process.ProcessName -notin @('chrome','msedge','firefox','Discord','steam','EpicGamesLauncher','RiotClientServices')){throw 'Unknown background process in recovery record.'}
                $handle=if($handles.ContainsKey([string]$entry.pid)){$handles[[string]$entry.pid]}else{[XeroGameNative]::OpenProcess(0x0800,$false,$process.Id)}
                if($handle -eq [IntPtr]::Zero){throw 'Cannot open suspended process.'}
                try{if([XeroGameNative]::NtResumeProcess($handle) -ne 0){throw 'Resume failed.'}}finally{[XeroGameNative]::CloseHandle($handle)|Out-Null;$handles.Remove([string]$entry.pid)}
            }catch{$errors+=$_.Exception.Message;$remainingSuspended+=$entry}
        }
        $Saved.suspended=@($remainingSuspended)
        foreach($entry in @($Saved.priorities)){
            try{$process=Owned-Process ([int]$entry.pid) ([string]$entry.ticks);if($process){if($entry.priority -notin @('Normal','High','AboveNormal','BelowNormal','Idle','RealTime')){throw 'Invalid original priority.'};$process.PriorityClass=[Diagnostics.ProcessPriorityClass][Enum]::Parse([Diagnostics.ProcessPriorityClass],[string]$entry.priority)}}catch{$errors+=$_.Exception.Message;$remainingPriorities+=$entry}
        }
        $Saved.priorities=@($remainingPriorities)
        if($Saved.power){try{Set-PowerPlan $Saved.power;$Saved.power=$null}catch{$errors+=$_.Exception.Message}}
        if($config){try{Save-Json $config.journal $Saved}catch{$errors+=$_.Exception.Message}}
        return $errors
    }
    if($Action -eq 'Recover'){
        if(Test-Path -LiteralPath $config.journal){$saved=Get-Content -LiteralPath $config.journal -Raw -Encoding UTF8|ConvertFrom-Json;$null=Assert-Context $saved.identity;$errors=@(Restore-Session $saved);if($errors.Count){throw ($errors -join '; ')};Save-Json $config.journal ([ordered]@{identity=$context;power=$null;priorities=@();suspended=@();restored=$true})}
        exit 0
    }
    $parent=Get-Process -Id $config.parentPid -ErrorAction Stop
    $worker=Get-CimInstance Win32_Process -Filter "ProcessId = $PID" -ErrorAction Stop
    if($worker.ParentProcessId -ne $config.parentPid){throw 'Parent process identity does not match.'}
    $parentTicks=$parent.StartTime.ToUniversalTime().Ticks
    $session=[ordered]@{identity=$context;power=$null;priorities=@();suspended=@();restored=$true}
    [uint32]$minimum=0;[uint32]$maximum=0;[uint32]$resolution=0
    if($config.timer){if([XeroGameNative]::NtSetTimerResolution(10000,$true,[ref]$resolution) -ne 0){throw 'Windows refused the timer-resolution request.'};$timerSet=$true}
    Save-Json $config.status ([ordered]@{running=$true;activeGames=@();suspended=0;timer=$timerSet;resolutionMs=if($timerSet){$resolution/10000}else{$null}})
    while(-not(Test-Path -LiteralPath $config.stop)){
        $parent=Get-Process -Id $config.parentPid -ErrorAction SilentlyContinue
        if(-not $parent -or $parent.StartTime.ToUniversalTime().Ticks -ne $parentTicks){break}
        $games=@()
        if($config.booster){
            foreach($process in @(Get-Process -ErrorAction Stop|Where-Object{$_.SessionId -eq $context.sessionId -and $_.MainWindowHandle -ne [IntPtr]::Zero})){
                try{
                    $executable=$process.Path;if(-not $executable){continue}
                    $matched=$false
                    foreach($root in @($config.gameRoots)){
                        if(-not $root -or -not [IO.Path]::IsPathRooted($root) -or $root -eq [IO.Path]::GetPathRoot($root) -or $root -like ($env:SystemRoot+'*')){continue}
                        if(([IO.Path]::GetExtension($root) -eq '.exe' -and $executable.Equals($root,[StringComparison]::OrdinalIgnoreCase)) -or ([IO.Path]::GetExtension($root) -ne '.exe' -and $executable.StartsWith($root.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase))){$matched=$true;break}
                    }
                    if($matched -and (Owned-Process $process.Id $null)){$games+=$process}
                }catch{}
            }
        }
        if($games.Count -gt 0){
            if(-not $session.power){$session.power=(Get-PowerPlans).active;$session.restored=$false;Save-Json $config.journal $session;Set-PowerPlan $config.powerPlan}
            foreach($game in $games){
                if(-not @($session.priorities|Where-Object{$_.pid -eq $game.Id -and $_.ticks -eq $game.StartTime.ToUniversalTime().Ticks.ToString()}).Count){
                    $session.priorities+= [ordered]@{pid=$game.Id;ticks=$game.StartTime.ToUniversalTime().Ticks.ToString();priority=$game.PriorityClass.ToString()};Save-Json $config.journal $session
                    try{$game.PriorityClass=[Diagnostics.ProcessPriorityClass]::High}catch{}
                }
            }
            foreach($name in @($config.backgrounds)){
                if($name -notin @('chrome','msedge','firefox','Discord','steam','EpicGamesLauncher','RiotClientServices')){continue}
                foreach($process in @(Get-Process -Name $name -ErrorAction SilentlyContinue)){
                    if(@($games.Id) -contains $process.Id){continue}
                    if(@($session.suspended|Where-Object{$_.pid -eq $process.Id -and $_.ticks -eq $process.StartTime.ToUniversalTime().Ticks.ToString()}).Count){continue}
                    if($handles.ContainsKey([string]$process.Id)){[XeroGameNative]::CloseHandle($handles[[string]$process.Id])|Out-Null;$handles.Remove([string]$process.Id);$session.suspended=@($session.suspended|Where-Object{$_.pid -ne $process.Id})}
                    $handle=[IntPtr]::Zero
                    try{
                        if(-not (Owned-Process $process.Id $null)){continue}
                        $handle=[XeroGameNative]::OpenProcess(0x0800,$false,$process.Id);if($handle -eq [IntPtr]::Zero){continue}
                        $entry=[ordered]@{pid=$process.Id;ticks=$process.StartTime.ToUniversalTime().Ticks.ToString()}
                        $session.suspended+=$entry;Save-Json $config.journal $session
                        if([XeroGameNative]::NtSuspendProcess($handle) -ne 0){$session.suspended=@($session.suspended|Where-Object{$_.pid -ne $process.Id});[XeroGameNative]::CloseHandle($handle)|Out-Null;Save-Json $config.journal $session;continue}
                        $handles[[string]$process.Id]=$handle
                    }catch{if($handle -ne [IntPtr]::Zero -and -not $handles.ContainsKey([string]$process.Id)){[XeroGameNative]::CloseHandle($handle)|Out-Null};throw}
                }
            }
        }elseif($session.power){
            $errors=@(Restore-Session $session);if($errors.Count){throw ($errors -join '; ')}
            $session=[ordered]@{identity=$context;power=$null;priorities=@();suspended=@();restored=$true};Save-Json $config.journal $session
        }
        if($timerSet){$null=[XeroGameNative]::NtQueryTimerResolution([ref]$minimum,[ref]$maximum,[ref]$resolution)}
        Save-Json $config.status ([ordered]@{running=$true;activeGames=@($games|Select-Object -ExpandProperty ProcessName);suspended=@($session.suspended).Count;timer=$timerSet;resolutionMs=if($timerSet){$resolution/10000}else{$null}})
        Start-Sleep -Milliseconds 1000
    }
}catch{$fatalError=$_.Exception.Message;[Console]::Error.WriteLine($fatalError)}
finally{
    $errors=@()
    if($session){$errors=@(Restore-Session $session);if(-not $errors.Count){$session.restored=$true;try{Save-Json $config.journal $session}catch{}}}
    if($timerSet){[uint32]$actual=0;$null=[XeroGameNative]::NtSetTimerResolution(10000,$false,[ref]$actual)}
    foreach($handle in @($handles.Values)){[XeroGameNative]::CloseHandle($handle)|Out-Null}
    if($config){try{Save-Json $config.status ([ordered]@{running=$false;activeGames=@();suspended=0;timer=$false;error=$fatalError;errors=$errors})}catch{}}
}
