$result = [ordered]@{
    operatingSystem = $null
    computer = $null
    processors = @()
    graphics = @()
    physicalDisks = @()
    volumes = @()
    memoryModules = @()
    memorySlots = $null
    processCount = $null
    powerPlan = $null
    diskReadBytesPerSecond = $null
    diskWriteBytesPerSecond = $null
    gpuPercent = $null
    dedicatedUsedBytes = $null
    dedicatedTotalBytes = $null
    memoryAdapterCount = $null
    diskActivePercent = $null
    systemDrive = $env:SystemDrive
    warnings = @()
}

if ($includeInventory) {
try {
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    $result.operatingSystem = [ordered]@{ name = $os.Caption; version = $os.Version; build = $os.BuildNumber }
} catch { $result.warnings += 'Windows information is unavailable.' }

try {
    $computer = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop
    $result.computer = [ordered]@{ manufacturer = $computer.Manufacturer; model = $computer.Model }
} catch { $result.warnings += 'Computer information is unavailable.' }

try {
    $result.processors = @(Get-CimInstance Win32_Processor -ErrorAction Stop | ForEach-Object {
        [ordered]@{ name = $_.Name.Trim(); cores = $_.NumberOfCores; threads = $_.NumberOfLogicalProcessors; maxClockMHz = $_.MaxClockSpeed }
    })
} catch { $result.warnings += 'Processor information is unavailable.' }

try {
    $result.graphics = @(Get-CimInstance Win32_VideoController -ErrorAction Stop | ForEach-Object {
        $memory = $null
        try {
            # AdapterRAM is a 32-bit value and cannot reliably describe modern VRAM.
            $driver = (Get-ItemProperty -LiteralPath ('Registry::HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Enum\' + $_.PNPDeviceID) -Name Driver -ErrorAction Stop).Driver
            $properties = Get-ItemProperty -LiteralPath ('Registry::HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Class\' + $driver) -ErrorAction Stop
            if ($properties.'HardwareInformation.qwMemorySize' -gt 0) { $memory = [double]$properties.'HardwareInformation.qwMemorySize' }
        } catch { $memory = $null }
        [ordered]@{ name = $_.Name; driverVersion = $_.DriverVersion; dedicatedTotalBytes = $memory }
    })
} catch { $result.warnings += 'Graphics information is unavailable.' }

try {
    $result.physicalDisks = @(Get-PhysicalDisk -ErrorAction Stop | ForEach-Object {
        [ordered]@{ name = $_.FriendlyName; sizeBytes = [double]$_.Size; busType = $_.BusType.ToString(); mediaType = $_.MediaType.ToString(); health = $_.HealthStatus.ToString() }
    })
} catch { $result.warnings += 'Physical disk information is unavailable.' }
try {
    $result.memoryModules = @(Get-CimInstance Win32_PhysicalMemory -ErrorAction Stop | ForEach-Object {
        [ordered]@{ slot = $_.DeviceLocator; capacityBytes = [double]$_.Capacity; speedMHz = $_.ConfiguredClockSpeed; manufacturer = ([string]$_.Manufacturer).Trim(); partNumber = ([string]$_.PartNumber).Trim() }
    })
    $result.memorySlots = (Get-CimInstance Win32_PhysicalMemoryArray -ErrorAction Stop | Measure-Object MemoryDevices -Sum).Sum
} catch { $result.warnings += 'Memory module information is unavailable.' }
}

try {
    $result.volumes = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType = 3' -ErrorAction Stop | Where-Object { $_.Size -gt 0 } | ForEach-Object {
        [ordered]@{ drive = $_.DeviceID; label = $_.VolumeName; sizeBytes = [double]$_.Size; freeBytes = [double]$_.FreeSpace; fileSystem = $_.FileSystem }
    })
} catch { $result.warnings += 'Storage capacity is unavailable.' }

try {
    $engines = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction Stop)
    # Sum processes on the same physical engine, then use the busiest engine.
    # Summing unrelated engines would incorrectly inflate whole-GPU utilization.
    $grouped = $engines | Where-Object { $_.Name -match 'luid_.+' } | Group-Object { [regex]::Match($_.Name, 'luid_.+').Value }
    if (@($grouped).Count -gt 0) {
        $busiest = ($grouped | ForEach-Object { ($_.Group | Measure-Object -Property UtilizationPercentage -Sum).Sum } | Measure-Object -Maximum).Maximum
        $result.gpuPercent = [Math]::Min(100, [Math]::Max(0, [double]$busiest))
    }
} catch { $result.warnings += 'GPU usage counters are unavailable.' }

try {
    $memoryCounters = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory -ErrorAction Stop)
    if ($memoryCounters.Count -gt 0) {
        $result.memoryAdapterCount = $memoryCounters.Count
        $result.dedicatedUsedBytes = [double]($memoryCounters | Measure-Object -Property DedicatedUsage -Sum).Sum
        # Only display capacity when it can be matched unambiguously.
        if ($memoryCounters.Count -eq 1 -and $result.graphics.Count -eq 1) {
            $result.dedicatedTotalBytes = $result.graphics[0].dedicatedTotalBytes
        }
    }
} catch { $result.warnings += 'Dedicated GPU memory counters are unavailable.' }

try {
    $disk = Get-CimInstance Win32_PerfFormattedData_PerfDisk_LogicalDisk -ErrorAction Stop | Where-Object { $_.Name -eq $env:SystemDrive } | Select-Object -First 1
    if ($null -ne $disk -and $null -ne $disk.PercentIdleTime) {
        $result.diskActivePercent = [Math]::Min(100, [Math]::Max(0, 100 - [double]$disk.PercentIdleTime))
        $result.diskReadBytesPerSecond = [double]$disk.DiskReadBytesPersec
        $result.diskWriteBytesPerSecond = [double]$disk.DiskWriteBytesPersec
    }
} catch { $result.warnings += 'Disk activity counters are unavailable.' }

try { $result.processCount = @(Get-Process -ErrorAction Stop).Count } catch { $result.warnings += 'Process count is unavailable.' }
try {
    $plan = & "$env:SystemRoot\System32\powercfg.exe" /getactivescheme
    if ($LASTEXITCODE -ne 0) { throw 'Cannot read the active power plan.' }
    if ($plan -match '([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})\s+\((.+)\)') {
        $result.powerPlan = [ordered]@{ id = $Matches[1]; name = $Matches[2] }
    }
} catch { $result.warnings += 'Power plan is unavailable.' }

$result | ConvertTo-Json -Depth 6 -Compress
