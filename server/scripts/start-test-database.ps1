param([string]$PostgresBin = 'C:/Program Files/PostgreSQL/16/bin')
$ErrorActionPreference = 'Stop'
$fixture = Join-Path $PSScriptRoot '../data/pg-test-55449'
$fixture = [IO.Path]::GetFullPath($fixture)
if (!$fixture.StartsWith([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../data/')))) { throw 'REFUSE_FIXTURE_PATH' }
if (!(Test-Path "$PostgresBin/initdb.exe")) { throw 'POSTGRES_RUNTIME_MISSING: supply installed PostgreSQL bin path' }
if (!(Test-Path "$fixture/PG_VERSION")) {
  & "$PostgresBin/initdb.exe" -D $fixture -U dfm_test -A trust --encoding=UTF8
  if ($LASTEXITCODE) { throw 'INITDB_FAILED' }
}
& "$PostgresBin/pg_ctl.exe" -D $fixture status *> $null
if ($LASTEXITCODE) {
  & "$PostgresBin/pg_ctl.exe" -D $fixture -l "$fixture/server.log" -o '-h 127.0.0.1 -p 55449' -w start
  if ($LASTEXITCODE) { throw 'FIXTURE_START_FAILED' }
}
$exists = & "$PostgresBin/psql.exe" -h 127.0.0.1 -p 55449 -U dfm_test -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname='dfm_test'"
if ($LASTEXITCODE) { throw 'FIXTURE_CONNECTION_FAILED' }
if ($exists -ne '1') { & "$PostgresBin/createdb.exe" -h 127.0.0.1 -p 55449 -U dfm_test dfm_test; if ($LASTEXITCODE) { throw 'FIXTURE_DATABASE_FAILED' } }
Write-Output 'Dedicated disposable fixture ready: loopback 55449, dfm_test. Trust authentication is local test only.'
