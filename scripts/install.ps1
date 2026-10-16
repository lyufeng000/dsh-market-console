#Requires -Version 5.1
<#
.SYNOPSIS
    把 dsh-market-console 安装到当前（或指定）DSH profile。

.DESCRIPTION
    profile 解析顺序严格遵循硬约束 C1，绝不写死 'web'：

        DSH_DESKTOP_PROFILE  →  DSH_PROFILE  →  DSH_PROFILE_DIR 反推  →  web

    安装做三件事，每一步都幂等：

        ① 把包放进 <DSH_HOME>/profiles/node_modules/（默认 Junction 链接，便于改源码）
        ② 在 <profileDir>/package.json 的 dependencies 里用 link: 协议登记（满足 C3）
           必须用 link:，不能写裸版本号 —— 本包没发布到 npm，裸版本号会让 pnpm 在
           每次安装任何插件时都去 registry 解析它并 404，整次安装随之失败
        ③ 在 <profileDir>/cordis.patch.yml 末尾追加 insert 挂载行

    与 dsh-whale-widget 的装法一致：挂载走 profile 的 cordis.patch.yml，
    而不是 profile 的 dsh.profile.bundles。

    为什么不走 bundles：plugin-manager 的 reconcile() 会把「本次操作新增的
    dependencies」自动追加进 dsh.profile.bundles，而本包一开始就在 dependencies
    里，`beforeDeps.has(name)` 恒为真、会被 continue 跳过，所以不会重复挂载。
    但如果手工再把它加进 bundles，bundle patch 与 cordis.patch.yml 就会产生
    两条同 id 的 insert —— 别这么干。

.PARAMETER DshHome
    DSH home 目录。默认取 $env:DSH_HOME，回退 ~/.dsh。

.PARAMETER Profile
    profile 名。默认按 C1 解析。显式传入时优先。

.PARAMETER Source
    本包所在目录。默认取本脚本上一级（scripts/ 的父目录）。

.PARAMETER Mode
    Junction（默认，链接，改源码立即生效）或 Copy（复制一份）。

.PARAMETER Force
    目标已存在且不是本包时，直接替换而不报错。

.EXAMPLE
    pwsh -File scripts\install.ps1

.EXAMPLE
    pwsh -File scripts\install.ps1 -Profile desktop -Mode Copy -Verbose

.NOTES
    装完必须**重启客户端**：cordis.patch.yml 只在启动时读取，刷新页面无效。
#>
[CmdletBinding()]
param(
    [string] $DshHome,
    [string] $Profile,
    [string] $Source,
    [ValidateSet('Junction', 'Copy')]
    [string] $Mode = 'Junction',
    [switch] $Force
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# Windows PowerShell 5.1 的 Set-Content -Encoding UTF8 会写入 BOM，而带 BOM 的
# JSON/YAML 会让下游解析器直接失败。所以所有落盘都走这个无 BOM 的写法。
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$PackageName = 'dsh-market-console'
$EntryId     = 'market-console'

function Write-Section { param([string] $Text) Write-Host "`n==> $Text" -ForegroundColor Cyan }
function Write-Ok      { param([string] $Text) Write-Host "    OK   $Text" -ForegroundColor Green }
function Write-Skip    { param([string] $Text) Write-Host "     --  $Text" -ForegroundColor DarkGray }
function Write-Warn2   { param([string] $Text) Write-Host "    !!   $Text" -ForegroundColor Yellow }
function Write-Fail    { param([string] $Text) Write-Host "    XX   $Text" -ForegroundColor Red; exit 1 }

# ── C1：profile 解析（绝不写死） ────────────────────────────────────────
Write-Section 'C1 · 解析目标 profile'

if (-not $DshHome) {
    if ($env:DSH_HOME) { $DshHome = $env:DSH_HOME; $homeSource = '$env:DSH_HOME' }
    else { $DshHome = Join-Path $HOME '.dsh'; $homeSource = '默认 ~/.dsh' }
} else {
    $homeSource = '-DshHome 参数'
}
if (-not (Test-Path $DshHome)) { Write-Fail "DSH home 不存在：$DshHome" }
Write-Ok "DSH_HOME = $DshHome  （来源：$homeSource）"

if (-not $Profile) {
    if ($env:DSH_DESKTOP_PROFILE) {
        $Profile = $env:DSH_DESKTOP_PROFILE; $profileSource = 'DSH_DESKTOP_PROFILE'
    } elseif ($env:DSH_PROFILE) {
        $Profile = $env:DSH_PROFILE; $profileSource = 'DSH_PROFILE'
    } elseif ($env:DSH_PROFILE_DIR) {
        $Profile = Split-Path $env:DSH_PROFILE_DIR -Leaf; $profileSource = 'DSH_PROFILE_DIR 反推'
    } else {
        $Profile = 'web'; $profileSource = '兜底默认'
    }
} else {
    $profileSource = '-Profile 参数'
}
$ProfileDir = Join-Path (Join-Path $DshHome 'profiles') $Profile
if (-not (Test-Path $ProfileDir)) { Write-Fail "profile 目录不存在：$ProfileDir" }
Write-Ok "profile    = $Profile  （来源：$profileSource）"
Write-Ok "profileDir = $ProfileDir"
if ($Profile -eq 'web-desktop') {
    Write-Warn2 'web-desktop 在本机已废弃，确认你要装的是这个 profile。'
}

# ── 源目录 ─────────────────────────────────────────────────────────────
Write-Section '定位源包'
if (-not $Source) { $Source = Split-Path $PSScriptRoot -Parent }
if (-not (Test-Path (Join-Path $Source 'package.json'))) {
    Write-Fail "源目录里没有 package.json：$Source"
}
$sourceManifest = Get-Content (Join-Path $Source 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($sourceManifest.name -ne $PackageName) {
    Write-Fail "源包的 name 是 '$($sourceManifest.name)'，期望 '$PackageName'"
}
Write-Ok "源目录 = $Source  (v$($sourceManifest.version))"

# ── ① 放进 Node 解析路径 ───────────────────────────────────────────────
Write-Section '① 安装包到 profiles\node_modules'
$ProfilesDir = Join-Path $DshHome 'profiles'
$TargetRoot  = Join-Path $ProfilesDir 'node_modules'
$Target      = Join-Path $TargetRoot $PackageName

if (-not (Test-Path $TargetRoot)) { New-Item -ItemType Directory -Path $TargetRoot -Force | Out-Null }

if (Test-Path $Target) {
    $existing = Get-Item $Target -Force
    if ($existing.LinkType -eq 'Junction' -or $existing.LinkType -eq 'SymbolicLink') {
        # 用 cmd 的 rmdir 删链接：PowerShell 的 Remove-Item -Recurse 在链接上可能误删目标内容
        cmd /c rmdir "$Target" | Out-Null
        Write-Ok "移除旧的链接（未触碰目标内容）"
    } elseif ($Force) {
        Remove-Item $Target -Recurse -Force
        Write-Warn2 '已强制删除已存在的实体目录'
    } else {
        Write-Fail "目标已存在且不是链接：$Target`n         加 -Force 覆盖，或先手工确认它是什么。"
    }
}

if ($Mode -eq 'Junction') {
    New-Item -ItemType Junction -Path $Target -Target $Source | Out-Null
    Write-Ok "建立 Junction：$Target  →  $Source"
} else {
    Copy-Item $Source $Target -Recurse -Force
    Write-Ok "复制到：$Target"
}

# ── ② 登记 dependencies（C3） ──────────────────────────────────────────
Write-Section '② 在 profile 的 dependencies 里登记（C3）'
$ProfileManifestPath = Join-Path $ProfileDir 'package.json'
if (-not (Test-Path $ProfileManifestPath)) { Write-Fail "找不到 $ProfileManifestPath" }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$manifestBackup = "$ProfileManifestPath.bak-$stamp"
Copy-Item $ProfileManifestPath $manifestBackup -Force
Write-Ok "备份：$manifestBackup"

$manifest = Get-Content $ProfileManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $manifest.dependencies) {
    $manifest | Add-Member -MemberType NoteProperty -Name dependencies -Value ([PSCustomObject]@{}) -Force
}

# 值必须用 link: 协议，不能写裸版本号。本包没有发布到 npm，而 pnpm 在 profile
# 目录里执行任何 add/install 时都会重新解析全部 dependencies：裸版本号会让它去
# registry 找这个包并拿到 ERR_PNPM_FETCH_404，整次插件安装随之失败
# （症状：点「安装」转一会儿就复位，什么都没装上）。
$previousLocation = Get-Location
try {
    Set-Location $ProfileDir
    $relativeSource = (Resolve-Path -Relative $Source) -replace '\\', '/'
} finally {
    Set-Location $previousLocation
}
$linkValue = "link:$relativeSource"

$currentValue = if ($manifest.dependencies.PSObject.Properties.Name -contains $PackageName) {
    $manifest.dependencies.$PackageName
} else { $null }

if ($currentValue -eq $linkValue) {
    Write-Skip "dependencies 里已是正确的 link 声明（$linkValue）"
} else {
    if ($currentValue) {
        Write-Warn2 "修正 $PackageName 的声明：'$currentValue' → '$linkValue'"
    }
    $manifest.dependencies | Add-Member -MemberType NoteProperty -Name $PackageName -Value $linkValue -Force
    # ConvertTo-Json 默认 depth 2 会截断嵌套结构，必须给足深度
    $json = ($manifest | ConvertTo-Json -Depth 100) + "`n"
    [System.IO.File]::WriteAllText($ProfileManifestPath, $json, $Utf8NoBom)
    Write-Ok "写入 dependencies.$PackageName = $linkValue"
}

# ── ③ 追加挂载行 ───────────────────────────────────────────────────────
Write-Section '③ 在 cordis.patch.yml 里追加挂载行'
$PatchPath = Join-Path $ProfileDir 'cordis.patch.yml'
if (-not (Test-Path $PatchPath)) { Write-Fail "找不到 $PatchPath" }

$patchText = Get-Content $PatchPath -Raw -Encoding UTF8
if ($patchText -match "(?m)^\s*-?\s*id:\s*['""]?$([regex]::Escape($EntryId))['""]?\s*$") {
    Write-Skip "挂载行已存在（id: $EntryId），不重复追加"
} else {
    $patchBackup = "$PatchPath.bak-$stamp"
    Copy-Item $PatchPath $patchBackup -Force
    Write-Ok "备份：$patchBackup"

    $block = @"

# ── $PackageName ──────────────────────────────────────────────────────
# 由 install.ps1 于 $stamp 追加。客户端大版本更新可能重写本文件，
# 届时这一行会丢失（表现为「插件文件在但界面没有」）。
- insert:
    - id: $EntryId
      name: $PackageName
"@
    [System.IO.File]::AppendAllText($PatchPath, $block, $Utf8NoBom)
    Write-Ok "追加挂载行：id=$EntryId  name=$PackageName"
}

# ── 验证 ───────────────────────────────────────────────────────────────
Write-Section '验证'
$clientPath = Join-Path $Target 'lib\client.js'
if (Test-Path $clientPath) { Write-Ok "client bundle 就位" } else { Write-Fail "缺少 lib\client.js" }

# Node 的模块解析是从 cwd 起步的，所以探测必须在 profile 目录里跑
Push-Location $ProfileDir
try {
    $probe = & node --input-type=module -e "const m = await import('$PackageName'); console.log('导出:', Object.keys(m).join(','), '| apply:', typeof m.apply)" 2>&1
    if ($LASTEXITCODE -eq 0) { Write-Ok "Node 可解析并导入 host 半边 → $probe" }
    else { Write-Warn2 "Node 导入探测返回非零（不影响安装）：$probe" }
} catch {
    Write-Warn2 "Node 导入探测失败（不影响安装）：$_"
} finally {
    Pop-Location
}

Write-Host ''
Write-Host '───────────────────────────────────────────────────────────────' -ForegroundColor DarkGray
Write-Host ' 安装完成。下一步：**完全退出 DeepSeek Harness 并重新打开**。' -ForegroundColor Yellow
Write-Host ' cordis.patch.yml 只在启动时读取，刷新页面无效。' -ForegroundColor DarkGray
Write-Host ' 重启后到「设置 → 插件」应能看到「插件市场」标签页。' -ForegroundColor DarkGray
Write-Host '───────────────────────────────────────────────────────────────' -ForegroundColor DarkGray
