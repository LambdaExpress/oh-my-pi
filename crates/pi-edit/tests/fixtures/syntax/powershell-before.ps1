$sets = @()
try {
[pscustomobject]@{Machine=$env:COMPUTERNAME;ResultSets=$sets} | ConvertTo-Json -Depth 8 -EscapeHandling EscapeNonAscii
} finally { $sets = $null }
