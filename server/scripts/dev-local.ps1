$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
Set-Location -LiteralPath '..'
$env:APP_MODE = 'development'
$env:MEMORY_MODE = 'local'
if (-not $env:SESSION_SECRET) {
    $keyPath = Join-Path (Get-Location) 'data/local-session.key'
    if (-not (Test-Path -LiteralPath $keyPath)) {
        New-Item -ItemType Directory -Path 'data' -Force | Out-Null
        $bytes = [byte[]]::new(48)
        $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
        $generator.GetBytes($bytes)
        $generator.Dispose()
        [IO.File]::WriteAllText($keyPath, [Convert]::ToBase64String($bytes))
    }
    $env:SESSION_SECRET = [IO.File]::ReadAllText($keyPath)
}
& npm run dev
