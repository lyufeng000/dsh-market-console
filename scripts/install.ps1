#Requires -Version 5.1
<#
.SYNOPSIS
    把 dsh-market-console 安装到当前（或指定）DSH profile。

.DESCRIPTION
    profile 解析顺序严格遵循硬约束 C1，绝不写死 'web'：

        DSH_DESKTOP_PROFILE  →  DSH_PROFILE  →  DSH_PROFILE_DIR 反推  →  web

    安装做三步，每一步都幂等：

        ① 把包放进 <DSH_HOME>/profiles/node_modules/（默认 Junction 链接，便于改源码）
        ② 在 <profileDir>/package.json 的 dependencies 里用 link: 协议登记（满足 C3）
           必须用 link:，不能写裸版本号 —— 本包没发布到 npm，裸版本号会让 pnpm 在
           每次安装任何插件时都去 registry 解析它并 404，整次安装随之失败
        ③ 挂载：只保留一种来源，绝不两条都写
           - 若 dsh-market-console 已在 <profileDir>/package.json 的
             dsh.profile.bundles 里（DSH 0.2.1 起插件页按它管理组合包），
             本脚本不再追加 cordis.patch.yml 的 insert；若发现历史遗留的简单
             insert 块，会先备份再摘掉，避免两条同 id 挂载。
           - 只有不在 dsh.profile.bundles 里时，才走旧的 profile patch 模式：
             在 <profileDir>/cordis.patch.yml 末尾追加 insert 挂载行。

    为什么不能两条都写：0.2.1 的「组合包启停/卸载」只改 dsh.profile.bundles，
    而 cordis.patch.yml 里的 insert 仍会把插件挂上 —— 启停变成静默无效，
    卸载会被 bundle-in-use 拒绝。所以本脚本保证单一挂载来源。

    推荐（DSH 0.2.1）：让 dsh.profile.bundles 继续包含 dsh-market-console，
    由插件页管理；此时 ③ 只是一次 no-op 自检（必要时清理遗留 insert）。

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

.PARAMETER WhatIf
    只打印将要做的改动，不落盘（不建链接、不写 package.json、不改 cordis.patch.yml）。

.EXAMPLE
    pwsh -File scripts\install.ps1

.EXAMPLE
    pwsh -File scripts\install.ps1 -Profile desktop -Mode Copy -Verbose

.EXAMPLE
    pwsh -File scripts\install.ps1 -WhatIf

.NOTES
    装完必须**重启客户端**：cordis.patch.yml 只在启动时读取，刷新页面无效。
    挂载若走 dsh.profile.bundles，同样在启动时读取。
#>
[CmdletBinding()]
param(
    [string] $DshHome,
    [string] $Profile,
    [string] $Source,
    [ValidateSet('Junction', 'Copy')]
    [string] $Mode = 'Junction',
    [switch] $Force,
    [switch] $WhatIf
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
function Write-Dry     { param([string] $Text) Write-Host "    ..   $Text" -ForegroundColor Magenta }

# 扫描 cordis.patch.yml 的行，找出本包的 insert 块。
# Any        = 存在「- insert: / - id: market-console / name: dsh-market-console」的块
# SimpleStart/SimpleEnd = 该块是 install.ps1 写出的简单三行块时的起止行号（否则 -1）
function Get-MarketInsertInfo {
    param([string[]] $Lines)
    $any = $false
    $simpleStart = -1
    $simpleEnd = -1
    for ($i = 0; $i -lt $Lines.Count; $i++) {
        if ($Lines[$i] -notmatch '^- insert:\s*$') { continue }
        $idIndex = $i + 1
        if ($idIndex -ge $Lines.Count) { continue }
        if ($Lines[$idIndex] -notmatch ('^\s+-\s*id:\s*[''"]?' + [regex]::Escape($EntryId) + '[''"]?\s*$')) { continue }
        $any = $true
        $nameIndex = $idIndex + 1
        if ($nameIndex -ge $Lines.Count) { continue }
        if ($Lines[$nameIndex] -notmatch ('^\s+name:\s*[''"]?' + [regex]::Escape($PackageName) + '[''"]?\s*$')) { continue }
        # 只有「没有后续条目、也没有额外属性行」才算本脚本能安全摘掉的简单块
        $next = if (($nameIndex + 1) -lt $Lines.Count) { $Lines[$nameIndex + 1] } else { '' }
        $nextIsMore = ($next -match '^\s+-\s*id:') -or ($next -match '^\s+[A-Za-z_][A-Za-z0-9_-]*:\s')
        if (-not $nextIsMore -and $simpleStart -lt 0) {
            $simpleStart = $i
            $simpleEnd = $nameIndex
        }
    }
    return [pscustomobject]@{ Any = $any; SimpleStart = $simpleStart; SimpleEnd = $simpleEnd }
}

# 摘掉一个简单 insert 块（连同 install.ps1 写在它上面的注释与空行）。
function Remove-SimpleInsert {
    param([string[]] $Lines, [int] $Start, [int] $End, [string] $Newline = "`n")
    $out = New-Object 'System.Collections.Generic.List[string]'
    $i = 0
    while ($i -lt $Lines.Count) {
        if ($i -eq $Start) {
            while ($out.Count -gt 0 -and $out[$out.Count - 1] -match '^\s*#') { $out.RemoveAt($out.Count - 1) }
            while ($out.Count -gt 0 -and $out[$out.Count - 1].Trim() -eq '') { $out.RemoveAt($out.Count - 1) }
            $i = $End + 1
            continue
        }
        $out.Add($Lines[$i])
        $i++
    }
    return ($out -join $Newline)
}

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

if (-not (Test-Path $TargetRoot)) {
    if ($WhatIf) { Write-Dry "将创建目录：$TargetRoot" }
    else { New-Item -ItemType Directory -Path $TargetRoot -Force | Out-Null }
}

if (Test-Path $Target) {
    $existing = Get-Item $Target -Force
    if ($existing.LinkType -eq 'Junction' -or $existing.LinkType -eq 'SymbolicLink') {
        if ($WhatIf) {
            Write-Dry "将移除旧链接（未触碰目标内容）：$Target"
        } else {
            # 用 cmd 的 rmdir 删链接：PowerShell 的 Remove-Item -Recurse 在链接上可能误删目标内容
            cmd /c rmdir "$Target" | Out-Null
            Write-Ok "移除旧的链接（未触碰目标内容）"
        }
    } elseif ($Force) {
        if ($WhatIf) { Write-Dry "将强制删除已存在的实体目录：$Target" }
        else { Remove-Item $Target -Recurse -Force; Write-Warn2 '已强制删除已存在的实体目录' }
    } else {
        Write-Fail "目标已存在且不是链接：$Target`n         加 -Force 覆盖，或先手工确认它是什么。"
    }
}

if ($WhatIf) {
    if ($Mode -eq 'Junction') { Write-Dry "将建立 Junction：$Target  →  $Source" }
    else { Write-Dry "将复制到：$Target" }
} elseif ($Mode -eq 'Junction') {
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
} elseif ($WhatIf) {
    Write-Dry "将写入 dependencies.$PackageName = $linkValue"
} else {
    if ($currentValue) {
        Write-Warn2 "修正 $PackageName 的声明：'$currentValue' → '$linkValue'"
    }
    $manifestBackup = "$ProfileManifestPath.bak-$stamp"
    Copy-Item $ProfileManifestPath $manifestBackup -Force
    Write-Ok "备份：$manifestBackup"
    $manifest.dependencies | Add-Member -MemberType NoteProperty -Name $PackageName -Value $linkValue -Force
    # ConvertTo-Json 默认 depth 2 会截断嵌套结构，必须给足深度
    $json = ($manifest | ConvertTo-Json -Depth 100) + "`n"
    [System.IO.File]::WriteAllText($ProfileManifestPath, $json, $Utf8NoBom)
    Write-Ok "写入 dependencies.$PackageName = $linkValue"
}

# ── ③ 挂载：bundles 优先，绝不与 insert 并存 ───────────────────────────
Write-Section '③ 挂载登记（dsh.profile.bundles 优先，insert 仅旧模式）'
$PatchPath = Join-Path $ProfileDir 'cordis.patch.yml'

$bundleList = @()
if ($manifest.dsh -and $manifest.dsh.profile -and $manifest.dsh.profile.bundles) {
    $bundleList = @($manifest.dsh.profile.bundles)
}
$inBundles = $bundleList -contains $PackageName

$hasPatch = Test-Path $PatchPath
if (-not $hasPatch -and -not $inBundles) { Write-Fail "找不到 $PatchPath" }
$patchText = if ($hasPatch) { Get-Content $PatchPath -Raw -Encoding UTF8 } else { '' }
$patchNewline = if ($patchText -and $patchText.Contains("`r`n")) { "`r`n" } else { "`n" }
$patchLines = if ($hasPatch) { [System.IO.File]::ReadAllLines($PatchPath) } else { @() }
$insertInfo = Get-MarketInsertInfo $patchLines

if ($inBundles) {
    if ($insertInfo.Any -and $insertInfo.SimpleStart -ge 0) {
        if ($WhatIf) {
            Write-Dry "将从 cordis.patch.yml 摘掉遗留 insert 块（id: $EntryId），只保留 dsh.profile.bundles 挂载"
        } else {
            $patchBackup = "$PatchPath.bak-$stamp"
            Copy-Item $PatchPath $patchBackup -Force
            Write-Ok "备份：$patchBackup"
            $updated = Remove-SimpleInsert $patchLines $insertInfo.SimpleStart $insertInfo.SimpleEnd $patchNewline
            [System.IO.File]::WriteAllText($PatchPath, $updated, $Utf8NoBom)
            Write-Ok "已摘掉遗留 insert 块（id: $EntryId），只保留 dsh.profile.bundles 挂载"
        }
        $mountMode = 'bundles'
    } elseif ($insertInfo.Any) {
        Write-Warn2 'dsh.profile.bundles 已挂载，但 cordis.patch.yml 里还有带额外配置的 market-console insert'
        Write-Warn2 '请手工只保留一种挂载（推荐保留 dsh.profile.bundles），否则 0.2.1 的启停/卸载会失效。'
        $mountMode = 'bundles-ambiguous'
    } else {
        Write-Skip "dsh.profile.bundles 已选择 $PackageName，不需要 insert 挂载"
        $mountMode = 'bundles'
    }
} else {
    if ($insertInfo.Any) {
        Write-Skip "cordis.patch.yml 已有挂载行（旧版 profile patch 模式），不重复追加"
        Write-Skip "提示：DSH 0.2.1 起建议把 $PackageName 加进 dsh.profile.bundles，由插件页统一管理。"
        $mountMode = 'legacy-insert'
    } elseif ($WhatIf) {
        Write-Dry "将在 cordis.patch.yml 追加 insert 挂载行：id=$EntryId  name=$PackageName（旧版模式）"
        $mountMode = 'legacy-insert'
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
        Write-Ok "追加挂载行：id=$EntryId  name=$PackageName（旧版 profile patch 模式）"
        $mountMode = 'legacy-insert'
    }
}

# ── 验证 ───────────────────────────────────────────────────────────────
Write-Section '验证'
if ($WhatIf) {
    Write-Dry 'WhatIf：跳过 client bundle 与 host 导入探测（本次不写盘）'
} else {
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
}

$modeText = switch ($mountMode) {
    'bundles' { 'dsh.profile.bundles（0.2.1 原生挂载）' }
    'bundles-ambiguous' { 'dsh.profile.bundles + 未清理的 insert（需手工二选一）' }
    default { 'cordis.patch.yml insert（旧版 profile patch 模式）' }
}

Write-Host ''
Write-Host '───────────────────────────────────────────────────────────────' -ForegroundColor DarkGray
if ($WhatIf) {
    Write-Host " WhatIf：以上为计划改动，未写入任何文件。挂载方式：$modeText" -ForegroundColor Yellow
} else {
    Write-Host " 安装完成（挂载方式：$modeText）。下一步：**完全退出 DeepSeek Harness 并重新打开**。" -ForegroundColor Yellow
}
Write-Host ' cordis.patch.yml / dsh.profile.bundles 只在启动时读取，刷新页面无效。' -ForegroundColor DarkGray
Write-Host ' 重启后到「设置 → 插件」应能看到「插件市场」标签页。' -ForegroundColor DarkGray
Write-Host '───────────────────────────────────────────────────────────────' -ForegroundColor DarkGray
