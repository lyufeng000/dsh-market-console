#Requires -Version 5.1
<#
.SYNOPSIS
    从当前（或指定）DSH profile 卸载 dsh-market-console。

.DESCRIPTION
    完整反向 install.ps1 做的三件事，并额外清理 0.2.1 的 bundle 选择：

        ① 从 <profileDir>/cordis.patch.yml 删掉挂载行
        ② 从 <profileDir>/package.json 的 dependencies 删掉登记
        ③ 从 <profileDir>/package.json 的 dsh.profile.bundles 删掉选择
        ④ 删掉 <DSH_HOME>/profiles/node_modules/dsh-market-console

    DSH 0.2.1 起「插件页」按 dsh.profile.bundles 管理组合包；本包若只从
    dependencies 摘掉却留在 bundles 里，下次启动会变成无法解析的悬挂条目。

    profile 解析顺序与 install.ps1 一致（C1）：
        DSH_DESKTOP_PROFILE  →  DSH_PROFILE  →  DSH_PROFILE_DIR 反推  →  web

    每个被改动的文件都会先备份成 *.bak-<时间戳>。

.PARAMETER DshHome
    DSH home 目录。默认取 $env:DSH_HOME，回退 ~/.dsh。

.PARAMETER Profile
    profile 名。默认按 C1 解析。

.PARAMETER KeepPackage
    只摘挂载与登记，保留 profiles\node_modules 下的包目录。

.PARAMETER WhatIf
    只打印将要做的改动，不落盘。

.EXAMPLE
    pwsh -File scripts\uninstall.ps1

.EXAMPLE
    pwsh -File scripts\uninstall.ps1 -WhatIf
#>
[CmdletBinding()]
param(
    [string] $DshHome,
    [string] $Profile,
    [switch] $KeepPackage,
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

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

# ── C1：profile 解析 ───────────────────────────────────────────────────
Write-Section 'C1 · 解析目标 profile'

if (-not $DshHome) {
    if ($env:DSH_HOME) { $DshHome = $env:DSH_HOME } else { $DshHome = Join-Path $HOME '.dsh' }
}
if (-not (Test-Path $DshHome)) { Write-Fail "DSH home 不存在：$DshHome" }

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
Write-Ok "DSH_HOME   = $DshHome"
Write-Ok "profile    = $Profile  （来源：$profileSource）"
if ($WhatIf) { Write-Warn2 'WhatIf 模式：只打印，不落盘。' }

# ── ① 摘掉挂载行 ───────────────────────────────────────────────────────
Write-Section '① 从 cordis.patch.yml 摘掉挂载行'
$PatchPath = Join-Path $ProfileDir 'cordis.patch.yml'
if (-not (Test-Path $PatchPath)) {
    Write-Skip 'cordis.patch.yml 不存在，跳过'
} else {
    $patchText = Get-Content $PatchPath -Raw -Encoding UTF8
    # 保留原文件的换行风格
    $newline = if ($patchText.Contains("`r`n")) { "`r`n" } else { "`n" }

    # 行扫描而不是正则：只摘掉「独占一个 insert 块」的形态，避免误删同一个
    # insert 块里的其它插件。（顺手记一个坑：[regex]::Replace 的第 4 个参数是
    # RegexOptions 而不是替换次数，别拿它当 count 用。）
    $lines = [System.IO.File]::ReadAllLines($PatchPath)
    $out = New-Object 'System.Collections.Generic.List[string]'
    $i = 0
    $removed = $false
    while ($i -lt $lines.Count) {
        if ((-not $removed) -and ($lines[$i] -match '^- insert:\s*$') -and (($i + 2) -lt $lines.Count)) {
            $idLine   = $lines[$i + 1]
            $nameLine = $lines[$i + 2]
            $nextLine = if (($i + 3) -lt $lines.Count) { $lines[$i + 3] } else { '' }
            $isOurs = ($idLine -match ("^\s+-\s*id:\s*['""]?" + [regex]::Escape($EntryId) + "['""]?\s*$")) -and
                      ($nameLine -match ("^\s+name:\s*['""]?" + [regex]::Escape($PackageName) + "['""]?\s*$")) -and
                      ($nextLine -notmatch '^\s+-\s*id:')
            if ($isOurs) {
                # 连同它上面 install.ps1 写的说明注释一起摘掉
                while ($out.Count -gt 0 -and $out[$out.Count - 1] -match '^\s*#') { $out.RemoveAt($out.Count - 1) }
                while ($out.Count -gt 0 -and $out[$out.Count - 1].Trim() -eq '') { $out.RemoveAt($out.Count - 1) }
                $out.Add('')
                $i += 3
                $removed = $true
                continue
            }
        }
        $out.Add($lines[$i])
        $i++
    }
    $updated = ($out -join $newline)

    if (-not $removed) {
        Write-Skip "没找到独占的 insert 块（id: $EntryId）——可能已摘掉，或它和别的条目共用一个块"
        Write-Warn2 '若有残留，请手工编辑该文件。'
    } elseif ($WhatIf) {
        Write-Dry "将删除 insert 块（id: $EntryId）"
    } else {
        Copy-Item $PatchPath "$PatchPath.bak-$stamp" -Force
        Write-Ok "备份：$PatchPath.bak-$stamp"
        # UTF8 无 BOM 写回，避免给 YAML 开头塞 BOM
        [System.IO.File]::WriteAllText($PatchPath, $updated, (New-Object System.Text.UTF8Encoding($false)))
        Write-Ok "已摘掉挂载行"
    }
}

# ── ② 摘掉 dependencies 与 dsh.profile.bundles ─────────────────────────
Write-Section '② 从 profile 的 package.json 摘掉登记'
$ManifestPath = Join-Path $ProfileDir 'package.json'
if (-not (Test-Path $ManifestPath)) {
    Write-Skip 'package.json 不存在，跳过'
} else {
    $manifest = Get-Content $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $hasDep = [bool]($manifest.dependencies -and ($manifest.dependencies.PSObject.Properties.Name -contains $PackageName))
    $bundleList = $null
    if ($manifest.dsh -and $manifest.dsh.profile -and $manifest.dsh.profile.bundles) {
        $bundleList = @($manifest.dsh.profile.bundles)
    }
    $hasBundle = [bool]($bundleList -and ($bundleList -contains $PackageName))
    if (-not $hasDep -and -not $hasBundle) {
        Write-Skip "dependencies 与 dsh.profile.bundles 里都没有 $PackageName"
    } elseif ($WhatIf) {
        if ($hasDep) { Write-Dry "将删除 dependencies.$PackageName" }
        if ($hasBundle) { Write-Dry "将从 dsh.profile.bundles 移除 $PackageName" }
    } else {
        Copy-Item $ManifestPath "$ManifestPath.bak-$stamp" -Force
        Write-Ok "备份：$ManifestPath.bak-$stamp"
        if ($hasDep) {
            $manifest.dependencies.PSObject.Properties.Remove($PackageName)
            Write-Ok "已摘掉 dependencies.$PackageName"
        }
        if ($hasBundle) {
            # 强制 [object[]]：Windows PowerShell 5.1 的 ConvertTo-Json 对单元素数组
            # 会退化成字符串，导致下一次启动读不到 bundles 列表。
            $manifest.dsh.profile.bundles = [object[]]@($bundleList | Where-Object { $_ -ne $PackageName })
            Write-Ok "已从 dsh.profile.bundles 移除 $PackageName"
        }
        $json = ($manifest | ConvertTo-Json -Depth 100) + "`n"
        [System.IO.File]::WriteAllText($ManifestPath, $json, $Utf8NoBom)
    }
}

# ── ③ 删包目录 ─────────────────────────────────────────────────────────
Write-Section '③ 删除 profiles\node_modules 下的包'
$Target = Join-Path (Join-Path (Join-Path $DshHome 'profiles') 'node_modules') $PackageName
if ($KeepPackage) {
    Write-Skip '-KeepPackage：保留包目录'
} elseif (-not (Test-Path $Target)) {
    Write-Skip "目标不存在：$Target"
} else {
    $item = Get-Item $Target -Force
    # Windows PowerShell 5.1 没有 ?? 运算符
    $kind = if ($item.LinkType) { $item.LinkType } else { '实体目录' }
    if ($WhatIf) {
        Write-Dry "将删除 $kind ：$Target"
    } elseif ($item.LinkType -eq 'Junction' -or $item.LinkType -eq 'SymbolicLink') {
        # 用 cmd 的 rmdir 删链接：PowerShell 的 Remove-Item -Recurse 在链接上可能误删目标内容
        cmd /c rmdir "$Target" | Out-Null
        Write-Ok "已删除链接（目标内容未受影响）"
    } else {
        Write-Warn2 "这是一个实体目录，不是链接：$Target"
        Write-Warn2 '为安全起见不自动删除。确认后手工 Remove-Item。'
    }
}

Write-Host ''
Write-Host '───────────────────────────────────────────────────────────────' -ForegroundColor DarkGray
if ($KeepPackage) {
    Write-Host ' 卸载完成（-KeepPackage：包文件保留）。' -ForegroundColor Yellow
} else {
    Write-Host ' 卸载完成。' -ForegroundColor Yellow
}
Write-Host ' 挂载行、dependencies 与 dsh.profile.bundles 选择均已摘除；' -ForegroundColor Yellow
Write-Host ' 重启客户端后「插件市场」标签页会消失。' -ForegroundColor Yellow
Write-Host '───────────────────────────────────────────────────────────────' -ForegroundColor DarkGray
