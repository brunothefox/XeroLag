$ErrorActionPreference='Stop'
$failures=@()
Get-ChildItem -LiteralPath @((Join-Path $PSScriptRoot '..\src\powershell'),$PSScriptRoot) -Filter '*.ps1' | ForEach-Object {
    $tokens=$null;$parseErrors=$null
    $null=[System.Management.Automation.Language.Parser]::ParseFile($_.FullName,[ref]$tokens,[ref]$parseErrors)
    foreach($errorRecord in $parseErrors){$failures+=($_.Name+': '+$errorRecord.Message)}
    $source=Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8
    foreach($definition in [regex]::Matches($source,"(?s)Add-Type -TypeDefinition @'\r?\n(.*?)\r?\n'@")){
        try{Add-Type -TypeDefinition $definition.Groups[1].Value -ErrorAction Stop}catch{$failures+=($_.Exception.Message)}
    }
}
if($failures.Count){$failures|ForEach-Object{[Console]::Error.WriteLine($_)};exit 1}
[Console]::WriteLine('PowerShell syntax and native API declarations passed.')
