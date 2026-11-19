param([ValidateSet('Processes','Devices','Adapters','Startup','Packages','Roots','Health','Capabilities')][string]$Action,[string]$PayloadPath)
. (Join-Path $PSScriptRoot 'common.ps1')
try {
    $result = $null
    switch ($Action) {
        'Processes' { $result = @((Get-Process -ErrorAction Stop) | Select-Object -ExpandProperty ProcessName -Unique) }
        'Roots' {
            $roots = @()
            foreach ($entry in @(@('HKCU','Software\Valve\Steam','SteamPath'),@('HKLM','SOFTWARE\WOW6432Node\Valve\Steam','InstallPath'),@('HKLM','SOFTWARE\Valve\Steam','InstallPath'))) {
                try { $value=Read-Value ([pscustomobject]@{hive=$entry[0];key=$entry[1];name=$entry[2]});if($value.exists -and (Test-Path -LiteralPath $value.value -PathType Container)){$roots += [string]$value.value} } catch {}
            }
            $result = [ordered]@{steam=@($roots|Select-Object -Unique);context=(Get-Context)}
        }
        'Devices' {
            $result = @(Get-CimInstance Win32_PnPEntity -ErrorAction Stop | Where-Object { $_.PNPClass -in @('Display','Net','USB') -and $_.PNPDeviceID -like 'PCI\*' } | ForEach-Object {
                $key='SYSTEM\CurrentControlSet\Enum\'+$_.PNPDeviceID+'\Device Parameters\Interrupt Management'
                $msi=Read-Value ([pscustomobject]@{hive='HKLM';key=($key+'\MessageSignaledInterruptProperties');name='MSISupported'})
                $priority=Read-Value ([pscustomobject]@{hive='HKLM';key=($key+'\Affinity Policy');name='DevicePriority'})
                [ordered]@{name=$_.Name;device=$_.PNPDeviceID;class=$_.PNPClass;supported=$msi.exists;msi=($msi.exists -and $msi.value -eq 1);priority=if($priority.exists){$priority.value}else{$null}}
            })
        }
        'Adapters' {
            $result=@(Get-NetAdapter -ErrorAction Stop|Where-Object {$_.Status -ne 'Not Present'}|ForEach-Object {
                $adapter=$_
                $addresses=@(Get-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -ErrorAction Stop|ForEach-Object{$_.ServerAddresses})
                [ordered]@{name=$adapter.Name;description=$adapter.InterfaceDescription;guid=([guid]$adapter.InterfaceGuid).ToString();index=$adapter.ifIndex;status=$adapter.Status.ToString();speed=$adapter.LinkSpeed;dns=$addresses}
            })
        }
        'Startup' {
            $entries=@()
            foreach($location in @(@('HKCU','Software\Microsoft\Windows\CurrentVersion\Run'),@('HKLM','SOFTWARE\Microsoft\Windows\CurrentVersion\Run'),@('HKLM','SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run'))) {
                $key=$null
                try {
                    $key=(Open-Hive $location[0]).OpenSubKey($location[1])
                    if($key){foreach($name in $key.GetValueNames()){$value=Read-Value ([pscustomobject]@{hive=$location[0];key=$location[1];name=$name});$entries += [ordered]@{type='startup-run';label=$name;hive=$location[0];key=$location[1];name=$name;command=[string]$value.value;enabled=$true;risk=if($location[0] -eq 'HKLM'){'Advanced'}else{'Moderate'}}}}
                } catch {} finally {if($key){$key.Dispose()}}
            }
            try {
                foreach($task in @(Get-ScheduledTask -ErrorAction Stop|Where-Object {$_.TaskPath -notlike '\Microsoft\*'})) {
                    $entries += [ordered]@{type='startup-task';label=$task.TaskName;taskPath=$task.TaskPath;taskName=$task.TaskName;enabled=[bool]$task.Settings.Enabled;risk='Advanced';command=(@($task.Actions|ForEach-Object{$_.Execute}) -join ', ')}
                }
            } catch {}
            $result=$entries
        }
        'Packages' {
            $labels=@{'Microsoft.Copilot'='Copilot';'MicrosoftWindows.Client.WebExperience'='Windows Widgets';'Microsoft.XboxGamingOverlay'='Xbox Game Bar';'Microsoft.XboxGameOverlay'='Xbox Game Overlay';'Microsoft.BingNews'='Microsoft News';'Microsoft.BingWeather'='Microsoft Weather';'Microsoft.549981C3F5F10'='Cortana';'Microsoft.GetHelp'='Get Help';'Microsoft.Getstarted'='Windows Tips';'Microsoft.MicrosoftSolitaireCollection'='Microsoft Solitaire';'Microsoft.People'='People';'Microsoft.WindowsFeedbackHub'='Feedback Hub'}
            $allow=@('Microsoft.Copilot','MicrosoftWindows.Client.WebExperience','Microsoft.XboxGamingOverlay','Microsoft.XboxGameOverlay','Microsoft.BingNews','Microsoft.BingWeather','Microsoft.549981C3F5F10','Microsoft.GetHelp','Microsoft.Getstarted','Microsoft.MicrosoftSolitaireCollection','Microsoft.People','Microsoft.WindowsFeedbackHub')
            $result=@(Get-AppxPackage -ErrorAction Stop|Where-Object {$_.Name -in $allow -and -not $_.IsFramework -and -not $_.NonRemovable}|ForEach-Object{[ordered]@{type='appx';label=$labels[$_.Name];name=$_.Name;family=$_.PackageFamilyName;fullName=$_.PackageFullName;installLocation=$_.InstallLocation;risk='Moderate'}})
            try { $recall=Get-WindowsOptionalFeature -Online -FeatureName Recall -ErrorAction Stop;if($recall.State -in @('Enabled','Disabled')){$result += [ordered]@{type='recall';label='Windows Recall';name='Recall';enabled=($recall.State -eq 'Enabled');risk='Advanced'}} } catch {}
            $setups=@((Join-Path $env:SystemRoot 'System32\OneDriveSetup.exe'),(Join-Path $env:SystemRoot 'SysWOW64\OneDriveSetup.exe'))
            try { $setups+=@(Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'Microsoft\OneDrive') -Directory -ErrorAction Stop|ForEach-Object{Join-Path $_.FullName 'OneDriveSetup.exe'}) }catch{}
            $setup=$setups|Where-Object{Test-Path -LiteralPath $_ -PathType Leaf}|Select-Object -First 1
            if($setup){$result += [ordered]@{type='onedrive';label='Microsoft OneDrive';setup=$setup;risk='Advanced'}}
        }
        'Health' {
            $disks=@(Get-PhysicalDisk -ErrorAction Stop|ForEach-Object{
                $disk=$_;$reliability=$null;$errorText=$null
                try {$reliability=Get-StorageReliabilityCounter -PhysicalDisk $disk -ErrorAction Stop}catch{$errorText='Reliability counters not supported by this driver'}
                [ordered]@{name=$disk.FriendlyName;health=$disk.HealthStatus.ToString();media=$disk.MediaType.ToString();bus=$disk.BusType.ToString();size=[double]$disk.Size;temperature=if($reliability){$reliability.Temperature}else{$null};wear=if($reliability){$reliability.Wear}else{$null};hours=if($reliability){$reliability.PowerOnHours}else{$null};readErrors=if($reliability){$reliability.ReadErrorsTotal}else{$null};writeErrors=if($reliability){$reliability.WriteErrorsTotal}else{$null};note=$errorText}
            })
            $smart=@();try{$smart=@(Get-CimInstance -Namespace root\wmi -ClassName MSStorageDriver_FailurePredictStatus -ErrorAction Stop|Select-Object InstanceName,PredictFailure)}catch{}
            $result=[ordered]@{disks=$disks;smart=$smart}
        }
        'Capabilities' {
            $winget=Get-AppxPackage Microsoft.DesktopAppInstaller -ErrorAction SilentlyContinue|Select-Object -First 1
            $volumes=@(Get-Volume -ErrorAction Stop|Where-Object{$_.DriveLetter -and $_.DriveType -eq 'Fixed'}|Select-Object DriveLetter,FileSystemLabel,FileSystem,HealthStatus)
            $trimVolumes=@();$physical=@(Get-PhysicalDisk -ErrorAction SilentlyContinue)
            foreach($volume in $volumes){try{$disk=Get-Partition -DriveLetter $volume.DriveLetter -ErrorAction Stop|Get-Disk -ErrorAction Stop;$media=$physical|Where-Object{$_.DeviceId -eq [string]$disk.Number}|Select-Object -First 1;if($disk.BusType -eq 'NVMe' -or $media.MediaType -eq 'SSD'){$trimVolumes+=$volume}}catch{}}
            $result=[ordered]@{winget=($null -ne $winget -and (Test-Path -LiteralPath (Join-Path $winget.InstallLocation 'winget.exe')));volumes=$volumes;trimVolumes=$trimVolumes;power=(Get-PowerPlans)}
        }
    }
    ConvertTo-Json -InputObject $result -Depth 12 -Compress
}catch{[Console]::Error.WriteLine($_.Exception.Message);exit 1}
