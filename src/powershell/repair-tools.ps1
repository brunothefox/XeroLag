param([ValidateSet('sfc','dism','trim','winget','winsock','tcp-reset','standby','updateRecovery','recommended','delivery-cache','permissions')][string]$Action,[string]$PayloadPath)
. (Join-Path $PSScriptRoot 'common.ps1')
try {
    $payload=Read-Payload $PayloadPath
    $null=Assert-Context $payload.identity
    switch($Action){
        'recommended' {
            [Console]::WriteLine('Repairing the Windows component store...')
            & "$env:SystemRoot\System32\dism.exe" /Online /Cleanup-Image /RestoreHealth 2>&1|ForEach-Object{[Console]::WriteLine([string]$_)}
            if($LASTEXITCODE -notin @(0,3010)){exit $LASTEXITCODE}
            $restartRequired=$LASTEXITCODE -eq 3010
            [Console]::WriteLine('Checking protected system files...')
            $start=New-Object Diagnostics.ProcessStartInfo;$start.FileName=Join-Path $env:SystemRoot 'System32\sfc.exe';$start.Arguments='/scannow';$start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardOutput=$true;$start.StandardOutputEncoding=[Text.Encoding]::Unicode
            $process=New-Object Diagnostics.Process;$process.StartInfo=$start
            try{$null=$process.Start();while(-not $process.StandardOutput.EndOfStream){[Console]::WriteLine($process.StandardOutput.ReadLine())};$process.WaitForExit();if($process.ExitCode -eq 0 -and $restartRequired){exit 3010};exit $process.ExitCode}finally{$process.Dispose()}
        }
        'delivery-cache' {
            if(-not(Get-Command Delete-DeliveryOptimizationCache -ErrorAction SilentlyContinue)){throw 'Windows does not expose Delivery Optimization cache cleanup on this edition.'}
            Delete-DeliveryOptimizationCache -Force -ErrorAction Stop
            [Console]::WriteLine('Unpinned Delivery Optimization cache cleared by Windows.')
        }
        'permissions' {
            if(-not [IO.Path]::IsPathRooted($payload.folder) -or $payload.folder -eq [IO.Path]::GetPathRoot($payload.folder) -or -not(Test-Path -LiteralPath $payload.folder -PathType Container)){throw 'Choose an existing folder.'}
            & "$env:SystemRoot\System32\icacls.exe" $payload.folder /verify /T /C 2>&1|ForEach-Object{[Console]::WriteLine([string]$_)}
            exit $LASTEXITCODE
        }
        'sfc' {
            $start=New-Object Diagnostics.ProcessStartInfo
            $start.FileName=Join-Path $env:SystemRoot 'System32\sfc.exe';$start.Arguments='/scannow';$start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardOutput=$true;$start.StandardOutputEncoding=[Text.Encoding]::Unicode
            $process=New-Object Diagnostics.Process;$process.StartInfo=$start
            try{$null=$process.Start();while(-not $process.StandardOutput.EndOfStream){[Console]::WriteLine($process.StandardOutput.ReadLine())};$process.WaitForExit();exit $process.ExitCode}finally{$process.Dispose()}
        }
        'dism' {& "$env:SystemRoot\System32\dism.exe" /Online /Cleanup-Image /RestoreHealth 2>&1|ForEach-Object{[Console]::WriteLine([string]$_)};exit $LASTEXITCODE}
        'trim' {
            if($payload.drive -notmatch '^[A-Za-z]$'){throw 'Select a drive letter.'}
            $volume=Get-Volume -DriveLetter $payload.drive -ErrorAction Stop
            if($volume.DriveType -ne 'Fixed'){throw 'Only local fixed volumes can be trimmed.'}
            $disk=Get-Partition -DriveLetter $payload.drive -ErrorAction Stop|Get-Disk -ErrorAction Stop
            $media=Get-PhysicalDisk -ErrorAction Stop|Where-Object{$_.DeviceId -eq [string]$disk.Number}|Select-Object -First 1
            if($disk.BusType -ne 'NVMe' -and $media.MediaType -ne 'SSD'){throw 'The driver does not report this volume as an SSD.'}
            Optimize-Volume -DriveLetter $payload.drive -ReTrim -Verbose -ErrorAction Stop 4>&1|ForEach-Object{[Console]::WriteLine([string]$_)}
        }
        'winget' {
            $package=Get-AppxPackage Microsoft.DesktopAppInstaller -ErrorAction Stop|Where-Object{$_.PackageFamilyName -eq 'Microsoft.DesktopAppInstaller_8wekyb3d8bbwe'}|Select-Object -First 1
            if(-not $package){throw 'Install App Installer from Microsoft Store to use winget.'}
            $executable=Join-Path $package.InstallLocation 'winget.exe'
            if(-not(Test-Path -LiteralPath $executable)){throw 'winget is unavailable.'}
            $signature=Get-AuthenticodeSignature -LiteralPath $executable -ErrorAction Stop
            if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft Corporation'){throw 'A signed Microsoft winget executable is required.'}
            & $executable upgrade --all --silent --accept-source-agreements --accept-package-agreements --disable-interactivity 2>&1|ForEach-Object{[Console]::WriteLine([string]$_)}
            exit $LASTEXITCODE
        }
        'winsock' {& "$env:SystemRoot\System32\netsh.exe" winsock reset 2>&1|ForEach-Object{[Console]::WriteLine([string]$_)};if($LASTEXITCODE -ne 0){throw 'Winsock reset failed.'};[Console]::WriteLine('Restart Windows to finish.')}
        'tcp-reset' {
            $log=Join-Path $payload.dataRoot 'tcp-reset.log'
            & "$env:SystemRoot\System32\netsh.exe" int ip reset $log 2>&1|ForEach-Object{[Console]::WriteLine([string]$_)}
            if($LASTEXITCODE -ne 0){throw 'TCP/IP reset returned an error. Review the log before retrying.'}
            [Console]::WriteLine('Restart Windows to finish. Static network settings may need to be reconfigured.')
        }
        'standby' {
            Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class XeroMemory {
 [StructLayout(LayoutKind.Sequential)] public struct LUID { public uint LowPart; public int HighPart; }
 [StructLayout(LayoutKind.Sequential)] public struct TOKEN_PRIVILEGES { public uint Count; public LUID Luid; public uint Attributes; }
 [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
 [DllImport("advapi32.dll", SetLastError=true)] public static extern bool OpenProcessToken(IntPtr p,uint a,out IntPtr t);
 [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool LookupPrivilegeValue(string s,string n,out LUID l);
 [DllImport("advapi32.dll", SetLastError=true)] public static extern bool AdjustTokenPrivileges(IntPtr t,bool d,ref TOKEN_PRIVILEGES n,uint z,IntPtr p,IntPtr r);
 [DllImport("ntdll.dll")] public static extern int NtSetSystemInformation(int c,ref int n,int l);
 public static void Purge(){IntPtr token;if(!OpenProcessToken(GetCurrentProcess(),0x28,out token))throw new System.ComponentModel.Win32Exception();try{LUID l;if(!LookupPrivilegeValue(null,"SeProfileSingleProcessPrivilege",out l))throw new System.ComponentModel.Win32Exception();var p=new TOKEN_PRIVILEGES{Count=1,Luid=l,Attributes=2};if(!AdjustTokenPrivileges(token,false,ref p,0,IntPtr.Zero,IntPtr.Zero)||Marshal.GetLastWin32Error()!=0)throw new System.ComponentModel.Win32Exception();int command=4;int result=NtSetSystemInformation(80,ref command,4);if(result!=0)throw new Exception("Memory purge failed: NTSTATUS 0x"+result.ToString("X8"));}finally{CloseHandle(token);}}
}
'@ -ErrorAction Stop
            [XeroMemory]::Purge();[Console]::WriteLine('Standby memory purge completed. Cached data will refill as Windows needs it.')
        }
        'updateRecovery' {
            $entries=Get-Content -LiteralPath $payload.journal -Raw -Encoding UTF8|ConvertFrom-Json
            foreach($entry in $entries){if($entry.name -notin @('BITS','wuauserv')){throw 'Invalid update-service recovery record.'};if($entry.running){$service=Get-Service -Name $entry.name -ErrorAction Stop;$service.Refresh();if($service.Status -eq 'StopPending'){$service.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(10));$service.Refresh()};if($service.Status -ne 'Running'){if($service.Status -ne 'StartPending'){$service.Start()};$service.WaitForStatus('Running',[TimeSpan]::FromSeconds(15))}}}
            [Console]::WriteLine('Update services restored.')
        }
    }
}catch{[Console]::Error.WriteLine($_.Exception.Message);exit 1}
