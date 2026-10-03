$names = @()
$names += (Get-Content src\agent\tools.ts | Select-String -Pattern 'name: "' | ForEach-Object { ($_.Line -split 'name: "')[1].Split('"')[0] })
foreach ($f in @('github','cloudflare','website','web','vision','paystack')) {
  $names += (Get-Content "src\integrations\$f.ts" | Select-String -Pattern 'name: "' | ForEach-Object { ($_.Line -split 'name: "')[1].Split('"')[0] })
}
$names += (Get-Content src\core\doctor.ts | Select-String -Pattern 'name: "system' | ForEach-Object { ($_.Line -split 'name: "')[1].Split('"')[0] })
$names = $names | Sort-Object -Unique
"UNIQUE REGISTERED TOOL NAMES: " + $names.Count
$names -join "`n"
