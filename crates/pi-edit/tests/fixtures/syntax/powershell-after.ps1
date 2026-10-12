$sets = @()
try {
$json=[pscustomobject]@{Machine=$env:COMPUTERNAME;ResultSets=$sets} | ConvertTo-Json -Depth 8 -EscapeHandling EscapeNonAscii
$reportPath=Join-Path $env:TEMP 'edit-guard.json'
[IO.File]::WriteAllText($reportPath,$json,(New-Object Text.UTF8Encoding($false)))
[pscustomobject]@{ReportPath=$reportPath;ResultSetCounts=@($sets|ForEach-Object {@($_).Count});JobCount=@($sets[2]).Count;JobsByDriver=@($sets[2]|Group-Object DriverID|Select-Object Name,Count)} | ConvertTo-Json -Depth 6 -EscapeHandling EscapeNonAscii
} finally { $sets = $null }
