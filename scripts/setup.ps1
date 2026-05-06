# ============================================================
# opcode-pg-memory 一键安装脚本
# 用法: .\scripts\setup.ps1
# 所有配置在 .env 文件中
# ============================================================
param(
    [switch]$SkipBuild,
    [switch]$SkipMigration,
    [string]$EnvFile = ".env"
)

$ErrorActionPreference = "Stop"
$PluginDir = Split-Path -Parent $PSScriptRoot

Write-Host "`n=== opcode-pg-memory Setup ===" -ForegroundColor Cyan

# ── 1. 加载 .env 配置 ──────────────────────────────────
$envPath = Join-Path $PluginDir $EnvFile
if (Test-Path $envPath) {
    Get-Content $envPath | ForEach-Object {
        if ($_ -match '^\s*([^#][\w_]+)\s*=\s*(.+)$') {
            [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2].Trim(), 'Process')
        }
    }
    Write-Host "[OK] Loaded config from $EnvFile" -ForegroundColor Green
} else {
    Write-Host "[!] $EnvFile not found. Copy .env.example and edit it." -ForegroundColor Yellow
    Write-Host "    cp .env.example .env" -ForegroundColor Gray
    exit 1
}

# ── 2. 检查依赖 ────────────────────────────────────────
function Test-Binary($name, $searchPaths) {
    $found = Get-Command $name -ErrorAction SilentlyContinue
    if (-not $found) {
        foreach ($p in $searchPaths) {
            if (Test-Path $p) { $found = $p; break }
        }
    }
    if ($found) { Write-Host "  [OK] $name" -ForegroundColor Green; return $true }
    else { Write-Host "  [!!] $name NOT FOUND" -ForegroundColor Red; return $false }
}

Write-Host "`nChecking dependencies..." -ForegroundColor Cyan
$ok = $true
$ok = (Test-Binary "bun" @("$env:USERPROFILE\.bun\bin\bun.exe", "$env:LOCALAPPDATA\bun\bin\bun.exe")) -and $ok
$psqlPaths = @("E:\PostgreSQL\18\bin\psql.exe", "${env:ProgramFiles}\PostgreSQL\18\bin\psql.exe", "${env:ProgramFiles}\PostgreSQL\17\bin\psql.exe")
if ($env:PG_BIN_PATH) { $psqlPaths += "$env:PG_BIN_PATH\psql.exe" }
$ok = (Test-Binary "psql" $psqlPaths) -and $ok
if (-not $ok) { exit 1 }

# ── 3. 安装依赖并构建 ──────────────────────────────────
Set-Location $PluginDir

if (-not $SkipBuild) {
    Write-Host "`nInstalling dependencies..." -ForegroundColor Cyan
    bun install --frozen-lockfile 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  Lockfile mismatch, running bun install..." -ForegroundColor Yellow
        bun install
    }
    Write-Host "[OK] Dependencies installed" -ForegroundColor Green

    Write-Host "`nBuilding..." -ForegroundColor Cyan
    bun run build
    Write-Host "[OK] Build complete" -ForegroundColor Green
}

# ── 4. 数据库迁移 ──────────────────────────────────────
if (-not $SkipMigration) {
    Write-Host "`nRunning database migration..." -ForegroundColor Cyan
    $env:PGPASSWORD = $env:PG_PASSWORD

    # 找到 psql 可执行文件
    $psql = $psqlPaths | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $psql) { $psql = "psql.exe" }

    $migrationFile = Join-Path $PluginDir "scripts\migration-v2.sql"
    if (Test-Path $migrationFile) {
        & $psql -h $env:PG_HOST -p $env:PG_PORT -U $env:PG_USER -d $env:PG_DATABASE -f $migrationFile
        if ($LASTEXITCODE -eq 0) {
            Write-Host "[OK] Database schema up to date" -ForegroundColor Green
        } else {
            Write-Host "[!!] Migration failed. Run manually:" -ForegroundColor Yellow
            Write-Host "     `$env:PGPASSWORD='...'; psql -h localhost -U opencode -d PGOMO -f scripts\migration-v2.sql" -ForegroundColor Gray
        }
    } else {
        Write-Host "[!] migration-v2.sql not found" -ForegroundColor Yellow
    }
}

# ── 5. 验证 ─────────────────────────────────────────────
Write-Host "`n=== Verification ===" -ForegroundColor Cyan

# 检查编译输出
$distFiles = @(
    "dist/mcp-server.js",
    "dist/src/index.js",
    "dist/src/topic/segment-manager.js"
)
foreach ($f in $distFiles) {
    $path = Join-Path $PluginDir $f
    if (Test-Path $path) {
        Write-Host "  [OK] $f" -ForegroundColor Green
    } else {
        Write-Host "  [!!] $f missing - rebuild with: bun run build" -ForegroundColor Red
    }
}

# 测试数据库连接
try {
    $env:PGPASSWORD = $env:PG_PASSWORD
    $result = & $psql -h $env:PG_HOST -p $env:PG_PORT -U $env:PG_USER -d $env:PG_DATABASE -t -c "SELECT COUNT(*) FROM session_map;"
    Write-Host "  [OK] Database connected ($($result.Trim()) session maps)" -ForegroundColor Green
} catch {
    Write-Host "  [!!] Database connection failed" -ForegroundColor Red
}

Write-Host "`nSetup complete! Add to opencode.jsonc:" -ForegroundColor Cyan
Write-Host @'
{
  "plugin": ["opcode-pg-memory"],
  "mcp": {
    "pg-memory": {
      "type": "local",
      "command": ["bun", "PATH_TO/plugins/opcode-pg-memory/dist/mcp-server.js"],
      "enabled": true,
      "environment": {
        "PG_HOST": "localhost",
        "PG_PORT": "5432",
        "PG_DATABASE": "PGOMO",
        "PG_USER": "opencode",
        "PG_PASSWORD": "123456",
        "EMBEDDING_PROVIDER": "ollama",
        "EMBEDDING_MODEL": "qwen3-embedding:0.6b"
      }
    }
  }
}
'@ -ForegroundColor Gray
Write-Host "`n"
