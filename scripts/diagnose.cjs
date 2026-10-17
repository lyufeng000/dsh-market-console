#!/usr/bin/env node
/**
 * dsh-market-console 诊断工具
 *
 * 一条命令走完「静态安装 → host 运行实例」的全链路检查，逐项给出结论与修复建议。
 * 不需要认证：客户端模块系统的 `/plugins` 路由与 HMR 的 `/plugins/events` SSE
 * 都是公开的（`dsh-host-frontend-static` 的契约是 "Non-index assets stay public"）。
 *
 * 用法：
 *   node scripts/diagnose.cjs
 *   node scripts/diagnose.cjs --url http://127.0.0.1:19387
 *   node scripts/diagnose.cjs --package dsh-market-console --entry-id market-console
 *   node scripts/diagnose.cjs --offline          # 只做不依赖运行实例的检查
 *
 * 退出码：0 全绿；1 有失败项。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// ── CLI ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (token === '--offline') { out.offline = true; continue; }
		if (token.startsWith('--')) {
			const key = token.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
			out[key] = argv[++i];
		}
	}
	return out;
}

const args = parseArgs(process.argv.slice(2));
const PKG = args.package || 'dsh-market-console';
const ENTRY_ID = args.entryId || 'market-console';
const BASE_URL = (args.url || process.env.DSH_WEB_URL || 'http://127.0.0.1:19387').replace(/\/+$/, '');
const OFFLINE = args.offline === true;

// ── 报告 ───────────────────────────────────────────────────────────────
let failed = 0;
let warned = 0;
const SUGGESTIONS = [];

const C = process.stdout.isTTY
	? { ok: '\x1b[32m', bad: '\x1b[31m', warn: '\x1b[33m', dim: '\x1b[90m', head: '\x1b[36m', off: '\x1b[0m' }
	: { ok: '', bad: '', warn: '', dim: '', head: '', off: '' };

function section(title) { console.log('\n' + C.head + title + C.off); }
function ok(text) { console.log('  ' + C.ok + 'OK  ' + C.off + ' ' + text); }
function bad(text, fix) {
	failed++;
	console.log('  ' + C.bad + 'FAIL' + C.off + ' ' + text);
	if (fix) SUGGESTIONS.push(fix);
}
function warn(text, fix) {
	warned++;
	console.log('  ' + C.warn + 'WARN' + C.off + ' ' + text);
	if (fix) SUGGESTIONS.push(fix);
}
function skip(text) { console.log('  ' + C.dim + '--   ' + text + C.off); }

// ── C1：profile 解析（绝不写死） ───────────────────────────────────────
function resolveHome() {
	if (process.env.DSH_HOME) return { home: process.env.DSH_HOME, from: '$env:DSH_HOME' };
	return { home: path.join(os.homedir(), '.dsh'), from: '默认 ~/.dsh' };
}

function resolveProfile() {
	if (process.env.DSH_DESKTOP_PROFILE) return { profile: process.env.DSH_DESKTOP_PROFILE, from: 'DSH_DESKTOP_PROFILE' };
	if (process.env.DSH_PROFILE) return { profile: process.env.DSH_PROFILE, from: 'DSH_PROFILE' };
	if (process.env.DSH_PROFILE_DIR) return { profile: path.basename(process.env.DSH_PROFILE_DIR), from: 'DSH_PROFILE_DIR 反推' };
	return { profile: 'web', from: '兜底默认' };
}

// ── rev 算法（复刻 @deepseek-ai/dsh-client-modules 的 artifactRevision）──
const HASH_REVISION_LENGTH = 12;
function framedHash(domain, parts) {
	const hash = crypto.createHash('sha1').update(domain).update('\0');
	for (const part of parts) hash.update(String(Buffer.byteLength(part)) + ':').update(part);
	return hash.digest('hex').slice(0, HASH_REVISION_LENGTH);
}
function artifactRevision(stat) {
	return framedHash('plugin-artifact', [String(stat.mtimeMs), String(stat.ctimeMs), String(stat.size)]);
}

// ── 与运行实例通信 ─────────────────────────────────────────────────────
/** 读 HMR SSE 的第一帧，拿到 host 的实时组合图 `{rev, entries, batches}`。 */
async function fetchGraph(timeoutMs) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(BASE_URL + '/plugins/events', {
			signal: controller.signal,
			headers: { accept: 'text/event-stream' }
		});
		if (res.status !== 200) return { error: 'HTTP ' + res.status };
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		while (buffer.length < 4 * 1024 * 1024) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const at = buffer.indexOf('data: ');
			if (at >= 0 && buffer.indexOf('\n\n', at) > 0) break;
		}
		try { await reader.cancel(); } catch (error) { /* 已取消 */ }
		const line = buffer.split('\n').find((l) => l.startsWith('data: '));
		if (!line) return { error: 'SSE 没有 data 帧' };
		const frame = JSON.parse(line.slice(6));
		return { graph: frame.graph, type: frame.type };
	} catch (error) {
		return { error: error.name === 'AbortError' ? '超时' : error.message };
	} finally {
		clearTimeout(timer);
	}
}

/** 取一个 bundle 资源。 */
async function fetchBundle(url) {
	try {
		const res = await fetch(url);
		const body = await res.text();
		return { status: res.status, body };
	} catch (error) {
		return { status: 0, error: error.message };
	}
}

// ── 主流程 ─────────────────────────────────────────────────────────────
(async () => {
	console.log(C.head + 'dsh-market-console 诊断' + C.off + C.dim + '   (' + new Date().toLocaleString() + ')' + C.off);

	// ───── 静态安装检查 ─────
	section('1. profile 与安装位置（C1 / C3）');
	const { home, from: homeFrom } = resolveHome();
	const { profile, from: profileFrom } = resolveProfile();
	const profileDir = path.join(home, 'profiles', profile);

	if (!fs.existsSync(home)) { bad('DSH_HOME 不存在：' + home, '确认安装目录，或用 DSH_HOME 环境变量指定。'); }
	else ok('DSH_HOME = ' + home + '  (' + homeFrom + ')');

	ok('profile = ' + profile + '  (' + profileFrom + ')');
	if (profile === 'web-desktop') warn('web-desktop 在本机已废弃，确认这是你要的 profile。');
	if (!fs.existsSync(profileDir)) bad('profile 目录不存在：' + profileDir, '用 -Profile 指定正确的 profile 名。');
	else ok('profileDir = ' + profileDir);

	const nodeModulePaths = [
		path.join(profileDir, 'node_modules', PKG),
		path.join(home, 'profiles', 'node_modules', PKG)
	];
	const installedAt = nodeModulePaths.find((p) => fs.existsSync(p));
	if (!installedAt) {
		bad('包不在 Node 解析路径上', '跑 scripts\\install.cmd 安装，或手工放到 <DSH_HOME>\\profiles\\node_modules\\。');
	} else {
		ok('包可达：' + installedAt);
	}

	// ───── 包清单 ─────
	section('2. 包清单与客户端声明');
	let manifest = null;
	let clientPath = null;
	let localBundle = null;
	let localRev = null;

	if (installedAt) {
		const manifestPath = path.join(installedAt, 'package.json');
		try {
			manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
			ok('package.json 可解析（name=' + manifest.name + ' v' + manifest.version + '）');
		} catch (error) {
			bad('package.json 解析失败：' + error.message, '若报 BOM 相关错误，检查是否有工具给它写了 UTF-8 BOM。');
		}

		if (manifest) {
			const decl = manifest.dsh && manifest.dsh.client;
			if (!decl || typeof decl !== 'object') bad('缺少 dsh.client 声明', 'package.json 需要 dsh.client = { platform, inject }。');
			else if (decl.platform !== 'web') bad("dsh.client.platform 不是 'web'（实际：" + decl.platform + '）');
			else ok("dsh.client.platform = 'web'");

			const clientRel = manifest.exports && manifest.exports['./client']
				&& (manifest.exports['./client'].default || manifest.exports['./client']);
			if (!clientRel) {
				bad('exports["./client"] 缺失', '客户端模块系统会直接抛 "declares dsh.client but exports no \\"./client\\" bundle"。');
			} else {
				clientPath = path.join(installedAt, clientRel);
				if (!fs.existsSync(clientPath)) bad('client bundle 不存在：' + clientPath);
				else {
					const bytes = fs.readFileSync(clientPath);
					localBundle = bytes.toString('utf8');
					localRev = artifactRevision(fs.statSync(clientPath));
					ok('client bundle：' + bytes.length + ' 字节，rev=' + localRev);
				}
			}
		}
	} else {
		skip('包未安装，跳过');
	}

	// ───── 挂载登记 ─────
	section('3. 挂载登记');
	let inBundles = false;
	let hasInsert = false;
	const profileManifestPath = path.join(profileDir, 'package.json');
	if (fs.existsSync(profileManifestPath)) {
		try {
			const pm = JSON.parse(fs.readFileSync(profileManifestPath, 'utf8'));
			const deps = pm.dependencies || {};
			if (Object.prototype.hasOwnProperty.call(deps, PKG)) ok('dependencies 已登记 ' + PKG + ' = ' + deps[PKG]);
			else bad('profile 的 dependencies 里没有 ' + PKG, '跑 scripts\\install.cmd。');
			const bundles = (pm.dsh && pm.dsh.profile && pm.dsh.profile.bundles) || [];
			inBundles = bundles.includes(PKG);
		} catch (error) { bad('profile package.json 解析失败：' + error.message); }
	} else skip('profile package.json 不存在');

	const patchPath = path.join(profileDir, 'cordis.patch.yml');
	if (fs.existsSync(patchPath)) {
		const patch = fs.readFileSync(patchPath, 'utf8');
		// 只把 insert 块里的行算作挂载；`- id: market-console disabled: false` 之类
		// 由 0.2.1 插件页写入的覆盖行不是挂载声明。
		const insertId = new RegExp('^\\s*-\\s*id:\\s*[\'"]?' + ENTRY_ID + '[\'"]?\\s*$', 'm');
		hasInsert = patch
			.split(/\r?\n(?=- )/)
			.filter((block) => /^-\s+insert:/m.test(block))
			.some((block) => insertId.test(block));
	} else skip('cordis.patch.yml 不存在');

	if (inBundles && hasInsert) {
		warn('同时存在两种挂载：dsh.profile.bundles 与 cordis.patch.yml 的 insert 块');
		SUGGESTIONS.push('只保留一种挂载：建议留在 dsh.profile.bundles（0.2.1 插件页按它管理），删掉 cordis.patch.yml 里的 insert 块。');
	} else if (inBundles) {
		ok('dsh.profile.bundles 已选择 ' + PKG + '（0.2.1 原生挂载）');
	} else if (hasInsert) {
		ok('cordis.patch.yml 含 insert 挂载行（id: ' + ENTRY_ID + '）');
	} else {
		bad('没有找到挂载：dsh.profile.bundles 与 cordis.patch.yml 的 insert 块都没有 ' + PKG,
			'把包加进 dsh.profile.bundles（0.2.1 推荐），或跑 scripts\\install.cmd 追加 insert 后重启客户端。');
	}

	// ───── 运行实例 ─────
	section('4. 运行中的实例（' + BASE_URL + '）');
	if (OFFLINE) {
		skip('--offline，跳过在线检查');
	} else {
		const got = await fetchGraph(8000);
		if (got.error) {
			warn('拿不到 host 组合图：' + got.error,
				'确认客户端在跑，或用 --url 指定正确端口。SSE 端点是 ' + BASE_URL + '/plugins/events');
			skip('跳过 bundle 路由检查');
		} else {
			const graph = got.graph;
			const entries = (graph && graph.entries) || [];
			ok('读到组合图：' + entries.length + ' 条 entry，rev=' + graph.rev);

			const mine = entries.find((e) => e.id === PKG);
			if (!mine) {
				bad('组合图里没有 ' + PKG,
					'说明 Loader 行没生效：改完 cordis.patch.yml 后若 HMR 未启用，必须重启客户端。');
			} else {
				ok('组合图里有该 row：' + mine.url);
				if (localRev && mine.rev !== localRev) {
					warn('图中的 rev（' + mine.rev + '）与本地文件算出的（' + localRev + '）不一致',
						'host 可能还持有旧一代 bundle。重启客户端即可对齐。');
				} else if (localRev) {
					ok('rev 与本地文件一致（' + mine.rev + '）');
				}

				const batch = (graph.batches || []).find((b) => (b.entries || []).includes(PKG));
				if (batch) ok('已编入 ' + batch.phase + ' batch');
				else warn('没有编入任何 batch，浏览器不会加载它。');

				// 元数据缓存检测：package.json 的 dsh.client.inject 会不会没被重读？
				if (manifest && manifest.dsh && manifest.dsh.client && Array.isArray(manifest.dsh.client.inject)) {
					const declared = manifest.dsh.client.inject.slice().sort().join(',');
					const inGraph = (mine.inject || []).slice().sort().join(',');
					if (declared !== inGraph) {
						warn('图中 inject 与 package.json 不一致 —— 元数据被缓存了');
						console.log('        package.json: ' + declared);
						console.log('        组合图      : ' + inGraph);
						SUGGESTIONS.push('dsh-client-modules 会把 dsh.client 声明按 Loader specifier 缓存。' +
							'单纯改 package.json 不会热生效；但 lib/client.js 一旦有变化，dsh-client-hmr 的 bundle 监视就会调 ' +
							'clientModules.rebuilt()，重新组合时顺带重读 package.json —— 所以「改完 package.json 再 touch 一下 client.js」即可免重启生效。');
					} else {
						ok('图中 inject 与 package.json 一致');
					}
				}

				// 真实取一次 bundle，核对字节
				if (localBundle) {
					const res = await fetchBundle(BASE_URL + '/' + mine.url);
					if (res.status !== 200) {
						bad('bundle 路由返回 HTTP ' + res.status, '契约要求「advertised revisioned bundle」才回 200，404 说明没在组合图里。');
					} else if (res.body.startsWith(localBundle)) {
						ok('bundle 路由 200，内容与本文件逐字节一致（仅追加 source-map trailer）');
					} else {
						warn('bundle 路由 200，但内容与本地文件不同（长度 ' + res.body.length + ' vs ' + localBundle.length + '）',
							'host 可能持有旧一代 bundle；重启客户端对齐。');
					}
				}
			}
		}
	}

	// ───── 结论 ─────
	console.log('\n' + C.dim + '─'.repeat(64) + C.off);
	if (failed === 0 && warned === 0) {
		console.log(C.ok + '全链路正常。' + C.off + ' 插件已挂载；打开「设置 → 插件」应能看到「插件市场」标签页。');
	} else {
		console.log((failed > 0 ? C.bad : C.warn) + '失败 ' + failed + ' 项，警告 ' + warned + ' 项。' + C.off);
	}
	if (SUGGESTIONS.length > 0) {
		console.log('\n' + C.head + '建议' + C.off);
		SUGGESTIONS.forEach((s, i) => console.log('  ' + (i + 1) + '. ' + s));
	}
	process.exitCode = failed > 0 ? 1 : 0;
})().catch((error) => {
	console.error('诊断脚本自身崩溃：', error);
	process.exitCode = 2;
});
