/**
 * dsh-market-console —— Client 半边（M1 发现 / M2 安装 / M3 启停删除 / M4 打磨）
 *
 * 本文件由 DSH 的客户端模块系统（@deepseek-ai/dsh-client-modules）送进浏览器执行，
 * **不是** Node 模块：
 *   - 只能用传给 factory 的 `require()` 拿平台模块表里的包（react），不能 import
 *   - 不能用 fs / path / child_process / fetch 之外的宿主能力
 *   - 一切数据与写操作都通过 `ctx.remote.pluginManager` 走官方服务
 *
 * 契约来源（本机 DSH 0.2.0-rc.1 复核，关键契约未变）：
 *   - 模块包装 / tab 注册：@deepseek-ai/dsh-client-ui-settings-plugin-inventory/lib/client.js
 *   - settings.plugins.tab 消费方（list slot, scope: root）：
 *     @deepseek-ai/dsh-client-ui-settings-plugins/lib/client.js
 *   - remote 方法表与返回结构：@deepseek-ai/dsh-plugin-manager/lib/typert.remote-client.js
 *   - `dsh.client` 声明解析：@deepseek-ai/dsh-client-modules/lib/index.js → parseDshClient()
 *
 * ── 两条必须记住的契约（写错就白干）────────────────────────────────
 * 1. `inject` 选项的返回值会被**展开成组件的 props**（所以组件直接解构
 *    `{ t, data, ... }`）。`hooks: { clientSync }` 会被系统转成
 *    `useClientSync` 这样的 hook prop —— 普通字段原样传递。
 * 2. `ctx.remote.*` 的每次调用返回 `{ ok: true, value }` 或
 *    `{ ok: false, error: { code, message } }`，必须解包。
 */
window.__ModuleLoader__.load({
	id: 'dsh-market-console',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const React = require('react');
		const { useState, useEffect, useMemo, useCallback, useRef } = React;
		const h = React.createElement;

		// ════════════════════════════════════════════════════════════════
		// 1. 常量与策略
		// ════════════════════════════════════════════════════════════════

		/** 本插件拥有的字典命名空间。 */
		const NS = 'settings.marketConsole';

		/** 本插件自身的包名 —— 必须从管理列表和搜索结果里硬过滤掉（C4）。 */
		const SELF_PACKAGE = 'dsh-market-console';

		/** 自身挂载行的 id（cordis.patch.yml 里的 market-console）。 */
		const SELF_ENTRY_ID = 'market-console';

		/**
		 * 管理基础设施：它们能管理插件，但不该被本插件管理（C4）。
		 * 卸载它们等于把插件管理器本身拆了，界面会直接消失。
		 */
		const MANAGER_MODULES = [
			'dsh-market-console',
			'dsh-unified-market',
			'dsh-plugin-shop',
			'@deepseek-ai/dsh-plugin-manager',
			'@deepseek-ai/dsh-host-plugin-inventory',
			'@deepseek-ai/dsh-client-ui-plugin-manager',
			'@deepseek-ai/dsh-client-ui-settings-plugin',
			'@deepseek-ai/dsh-api-remotes',
			'@deepseek-ai/dsh-client-modules'
		];

		/** DSH 运行底座：只读展示，避免误伤（拆了就开不了机）。 */
		const SYSTEM_MODULES = [
			'@deepseek-ai/dsh-base',
			'@deepseek-ai/dsh-web-app',
			'@deepseek-ai/cordis'
		];

		/** npm 搜索关键词：DSH 插件的约定标签。 */
		const NPM_KEYWORD = 'keywords:dsh-plugin';

		/** registry 兜底顺序（用户配置 → 环境默认 → 镜像）。 */
		const DEFAULT_REGISTRIES = [
			'https://registry.npmjs.org',
			'https://registry.npmmirror.com'
		];

		/** 本地偏好存储键（registry / 搜索历史等）。 */
		const PREFS_KEY = 'dsh-market-console/prefs';

		/** 搜索防抖延迟（毫秒）。 */
		const SEARCH_DEBOUNCE_MS = 420;

		/** 用户备注的存储键：`{ "<包名>": "备注文本" }`。 */
		const NOTES_KEY = 'dsh-market-console/notes';

		/**
		 * 内置插件说明：一句话中文备注，讲清「这个插件让你能做什么」。
		 *
		 * key 用 Loader 条目的 moduleName（组合包则用包名）。表里没有的插件
		 * 只显示模块名 —— 用户可以在界面上自己补。
		 *
		 * 用户在 UI 上改过的备注存在 localStorage 的 {@link NOTES_KEY} 下，
		 * **优先级高于这张表**，所以内置文案随时可以覆盖，不会被写死。
		 */
		const BUILTIN_NOTES = {
			// ── 客户端底座 ──────────────────────────────────────────────
			'@deepseek-ai/dsh-client-modules': '客户端模块系统：扫描已启用的插件，把它们的浏览器代码组合起来送进页面。',
			'@deepseek-ai/dsh-client-connection': '浏览器与主进程之间的协议层：远程调用、事件流、精确路由与信任栅栏。',
			'@deepseek-ai/dsh-client-hmr': '热重载：改完插件代码或配置文件不用重启，页面自动跟上。',
			'@deepseek-ai/dsh-client-locale': '多语言底座：中英文偏好、命名空间字典与翻译。',
			'@deepseek-ai/dsh-client-resources': '资源模型：把 URL 解析成实时值，组件用 useResource 读取。',
			'@deepseek-ai/dsh-client-file-upload': '文件上传：流式接收、进度、取消与暂存凭证。',
			'@deepseek-ai/dsh-cordis-client-runner': '动态包的浏览器侧执行器：在页面里装载临时生成的代码。',
			'@deepseek-ai/dsh-typert-registry': '运行时类型注册表：保存反射信息、schema 工厂与远程调用描述符。',
			'@deepseek-ai/dsh-api-gateway': '浏览器到主进程的类型化调用通道：分发、校验、取消与重连。',
			'@deepseek-ai/dsh-api-remotes': '能力装配：为主进程挑出哪些能力可以暴露给浏览器。',
			'@deepseek-ai/dsh-api-session-controller': '会话控制：创建、恢复、发提示、跟随历史与实时状态。',
			'@deepseek-ai/dsh-api-workspace-controller': '工作区控制：切换工作区并跟随它的完整状态。',
			'@deepseek-ai/dsh-api-workspace-files': '工作区文件服务：有界读取、按目标监听变化、列目录。',
			'@deepseek-ai/dsh-api-terminal-controller': '交互式终端：默认 shell、屏幕恢复与远程控制。',
			'@deepseek-ai/dsh-api-job-controller': '后台任务控制：把任务名册与保留输出镜像到界面，并可手动停止。',

			// ── 界面外壳 ────────────────────────────────────────────────
			'@deepseek-ai/dsh-client-ui-renderer': 'UI 渲染器：把插槽和组件工厂接到 React 上。',
			'@deepseek-ai/dsh-client-ui-layout': '界面外壳：三栏布局、面板几何与主题呈现。',
			'@deepseek-ai/dsh-client-ui-theme': '主题与字号：整套 --dsw-* 设计变量都由它定义。',
			'@deepseek-ai/dsh-client-ui-brand-official': '官方品牌标识（只在官方构建里生效）。',
			'@deepseek-ai/dsh-client-ui-sidebar': '左侧边栏：品牌行、新建会话、折叠控件与底部设置入口。',
			'@deepseek-ai/dsh-client-ui-sidebar-right': '右侧边栏：每个会话一个停靠面，支持多种呈现形态。',
			'@deepseek-ai/dsh-client-ui-sidebar-files': '右侧栏的「文件」标签页：会话工作区文件树。',
			'@deepseek-ai/dsh-client-ui-sidebar-terminal': '右侧栏的「终端」标签页：打开并操作交互式 shell。',
			'@deepseek-ai/dsh-client-ui-sidebar-browser': '右侧栏的「浏览器」标签页：在沙箱里访问网页（含本机服务）。',
			'@deepseek-ai/dsh-client-ui-sidebar-documentpreview': '右侧栏的文档预览：Markdown、代码、图片、PDF、Office、HTML。',
			'@deepseek-ai/dsh-client-ui-open-in-app': '「在其他应用中打开」：把工作区目录交给记住的应用，或让文件走系统默认程序。',
			'@deepseek-ai/dsh-client-ui-directory-picker-native': '原生目录选择器：调用操作系统的文件夹对话框。',
			'@deepseek-ai/dsh-client-ui-session': '会话列表与状态的 React 适配层。',

			// ── 设置页 ──────────────────────────────────────────────────
			'@deepseek-ai/dsh-client-ui-settings': '设置页底座：共享配置表单、schema 服务与插槽约定。',
			'@deepseek-ai/dsh-client-ui-settings-general': '设置里的「通用」分区。',
			'@deepseek-ai/dsh-client-ui-settings-models': '模型设置：服务商、API Key 与模型列表。',
			'@deepseek-ai/dsh-client-ui-settings-account': '账号设置：DeepSeek 登录状态、浏览器授权与退出登录。',
			'@deepseek-ai/dsh-client-ui-settings-plugins': '「内置插件」分区壳 —— 本插件就注册在它的标签行里。',
			'@deepseek-ai/dsh-client-ui-settings-plugin-inventory': '官方只读插件清单页：按作用域分组、可搜索。',
			'@deepseek-ai/dsh-client-ui-settings-shell': '插件页里的终端设置：命令超时与单流输出上限。',
			'@deepseek-ai/dsh-client-ui-settings-agent-loop': '插件页里的 Agent 循环设置：并行工具调用上限。',
			'@deepseek-ai/dsh-client-ui-settings-subagent': '插件页里的子智能体设置：委派深度、并行容量与可选模型。',
			'@deepseek-ai/dsh-client-ui-settings-web-search': '插件页里的网页搜索设置：API Key、接口地址与次数上限。',
			'@deepseek-ai/dsh-client-ui-plugin-manager': '官方插件管理器：从侧栏管理组合包、插件行与配置。',
			'@deepseek-ai/dsh-client-ui-shortcuts': '快捷键查看页：按名称、别名或键位搜索当前可用命令。',
			'@deepseek-ai/dsh-client-shortcuts': '按设备自定义键盘快捷键。',
			'@deepseek-ai/dsh-client-ui-permission-presets': '权限预设：默认设置行与 /permission 会话切换器。',
			'@deepseek-ai/dsh-client-ui-agent-preset': 'Agent 预设选择：挑预设、看各模式的说明与默认值。',

			// ── 对话与输入 ──────────────────────────────────────────────
			'@deepseek-ai/dsh-client-ui-conversation': '对话装配层：事件与视图注册、输入状态与 composer 接管。',
			'@deepseek-ai/dsh-client-ui-chat': '对话渲染：消息节点、历史图片、操作按钮与滚动状态。',
			'@deepseek-ai/dsh-client-ui-tool': '工具调用展示：调用树、按工具名键控的视图与内置工具卡片。',
			'@deepseek-ai/dsh-client-ui-input-trigger': '输入触发：光标处的 / 与 @ 检测、候选菜单。',
			'@deepseek-ai/dsh-client-ui-commands': '斜杠命令：命令来源、派发与会话级命令目录。',
			'@deepseek-ai/dsh-client-ui-skill': '技能：/ 触发与技能调用卡片。',
			'@deepseek-ai/dsh-client-ui-subagent': '子智能体：对话目录、续接路由与 @ 引用。',
			'@deepseek-ai/dsh-client-ui-reference': '@文件 与 @会话 引用：候选项、排序与行内引用。',
			'@deepseek-ai/dsh-client-ui-attachment': '附件体验：草稿附件栏、拖放上传、历史图片画廊与灯箱。',
			'@deepseek-ai/dsh-client-ui-model-selection': '模型选择：/model 弹窗与 composer 上的模型位。',
			'@deepseek-ai/dsh-client-ui-message-feedback': '消息反馈：点赞/点踩与 /feedback 弹窗。',
			'@deepseek-ai/dsh-client-ui-approval': '权限请求的批准界面。',
			'@deepseek-ai/dsh-client-ui-user-questions': 'ask_user_question 的提问界面与 plan 审批卡片。',
			'@deepseek-ai/dsh-client-ui-plan': 'Plan 模式徽章：显示已开启，并可一键关闭。',
			'@deepseek-ai/dsh-client-ui-goal': '目标条：显示当前目标，可编辑、暂停、恢复或清除。',
			'@deepseek-ai/dsh-client-ui-jobs': '会话头部的后台任务列表：流式输出面板与进行中/已结束分组。',
			'@deepseek-ai/dsh-client-ui-trajectory': '轨迹视图：按轮次组织的事件表与时间概览。',
			'@deepseek-ai/dsh-client-ui-deliverables': '交付物卡片：改动文件、交付文件与可点击的行内文件引用。',
			'@deepseek-ai/dsh-client-ui-workspace': '工作区浏览器与目录选择器。',
			'@deepseek-ai/dsh-client-ui-workflow-run': '工作流运行节点：把多智能体运行重建为可折叠的聊天节点。',
			'@deepseek-ai/dsh-client-ui-cordis': '历史 Cordis 卡片与进程内运行器的控件。',
			'@deepseek-ai/dsh-session-log-export': '会话日志导出：ZIP 打包与 /export 命令。',

			// ── 实验特性与第三方 ────────────────────────────────────────
			'@deepseek-ai/dsh-experimental-client-ui-agent-team': '实验性 Agent 团队面板：成员名册、共享任务板与队友导航。',
			'@deepseek-ai/dsh-experimental-client-ui-voice-input': '语音输入：录音并把转写文字插入草稿。',
			'dsh-whale-widget': '右下角的鲸鱼挂件：显示账户余额与今日消耗，可换角色、动图和音效。',


			// ── 0.2.0-rc.1 新增与随后装入的插件 ──
			'@deepseek-ai/dsh-otel': '通过共享 Cordis OTel 服务创建独立的 OTLP 上报通道。',
			'@deepseek-ai/dsh-host-product-telemetry-otel': '配置显式产品使用事件、OTLP/HTTP 路由、批量发送与退出等待上限。',
			'@deepseek-ai/dsh-client-product-analytics': '配置桌面端产品埋点：身份字段与事件时机（不采集 Web 使用情况）。',
			'@deepseek-ai/dsh-client-ui-settings-session-log': '通用设置里控制是否随 DeepSeek API 请求上传会话日志。',
			'dsh-persona-cards': '人设卡：在设置里写多套人设，逐卡启用，直接注入系统提示词。',

			// ── host 侧插件：从各自 README 的 description 提取并精简（可被用户备注覆盖）──
			'@deepseek-ai/cordis-plugin-timer': 'Cordis 定时器服务。',
			'@deepseek-ai/dsh-agent': '面向插件、UI 与编排器的 Agent 句柄、实时注册表、进程本地发起方作用域，以及 agent/* 事件词汇',
			'@deepseek-ai/dsh-agent-default-model': '部署默认模型选择：用于选择、配置或调试新创建的 agent（智能体）初始使用哪个模型',
			'@deepseek-ai/dsh-agent-instructions': '工作区指令上下文：用于启用、设置预算或排查 AGENTS.md/CLAUDE.md 的加载与刷新',
			'@deepseek-ai/dsh-agent-loop': '默认 agent（智能体）驱动器：用于选择、配置或调试 agent 的创建方式以及轮次与步骤的运行方式',
			'@deepseek-ai/dsh-agent-preset': '在普通 Cordis YAML 中定义 Agent 的子插件列表',
			'@deepseek-ai/dsh-agent-preset-registry': '通过声明式 preset 选择 Agent 的工具、提示词和技能',
			'@deepseek-ai/dsh-api-account-controller': '账号页面使用经过认证的 Remote 操作和快照流。控制器提供登录状态，不返回 token 或 PKCE 私密数据',
			'@deepseek-ai/dsh-api-settings-controller': 'settings 与凭据配置界面的 Host Remote owner，涵盖脱敏读取、写入、凭据引用与原生文档打开',
			'@deepseek-ai/dsh-attachment-local': 'DSH_HOME 下附加图片的本地存储',
			'@deepseek-ai/dsh-authorization': '面向用户与维护者的授权 flow 注册表：获取配置无法提供的凭据，因为拿到它需要与人对话',
			'@deepseek-ai/dsh-bash-sandbox': '沙箱 Bash 执行器：用于选择、配置或排查受限命令执行及其拒绝与升权事实',
			'@deepseek-ai/dsh-client-ui-schedule': '跨会话的 Web 任务管理页面及当前会话的提醒列表',
			'@deepseek-ai/dsh-command-compact': '面向交互式组合的按需 /compact 命令：它做什么、你会看到什么，以及如何挂载',
			'@deepseek-ai/dsh-command-feedback': '会话反馈：`/feedback` 命令、Web 反馈弹窗背后的 `sessionFeedback` Host Rem',
			'@deepseek-ai/dsh-command-goal': '/goal 斜杠命令',
			'@deepseek-ai/dsh-commands': '交互式 UI 的面向用户斜杠命令注册表：插件拥有的命令直接针对 agent（智能体）执行，不产生模型消息',
			'@deepseek-ai/dsh-compaction-basic': '面向部署场景的自动会话压缩（compaction）：用于选择、调优或排查随 token 压力上升对较早历史进行摘要的方式',
			'@deepseek-ai/dsh-compaction-image-offload': '图片省略执行器：支持图片的路由以请求超出图片预算拒绝时会发生什么',
			'@deepseek-ai/dsh-compaction-tool-result-pruner': '面向组合压缩（compaction）部署场景的工具输出修剪：选择大小限制或排查超大工具结果为何被缩短',
			'@deepseek-ai/dsh-config-editor': '保存当前 profile 配置，并通过 Loader 应用',
			'@deepseek-ai/dsh-cordis-host-runner': '动态 Cordis 包的 host 半说明',
			'@deepseek-ai/dsh-credentials-local': '面向用户与维护者的文件型凭据提供方：选择、配置或排查本地凭据存储及其环境分层',
			'@deepseek-ai/dsh-deepseek-account-platform': '通过系统浏览器登录，并将账号凭证保存在现有本地凭证存储中。本地取消会阻止迟到的回调和兑换响应使用户登录',
			'@deepseek-ai/dsh-deepseek-llm-api-extensions': '面向提供方插件的官方 DeepSeek 请求扩展注册表',
			'@deepseek-ai/dsh-experimental-agent-team': '在一个会话中运行一个小型具名 agent（智能体）团队：成员之间的持久消息与共享任务板',
			'@deepseek-ai/dsh-experimental-api-speech-to-text': '通过带认证的 Web Remote 提供有界临时转写',
			'@deepseek-ai/dsh-experimental-auto-review': '为 Web profile 添加实验性逐调用 Auto review，在工具以 Full access 执行前使用当',
			'@deepseek-ai/dsh-experimental-speech-to-text': '具名实验性转写 Provider 及取消操作的所有权',
			'@deepseek-ai/dsh-experimental-speech-to-text-sensevoice': '按需准备和运行本地 CPU SenseVoice 工作进程',
			'@deepseek-ai/dsh-experimental-tool-agent-team': '九个让模型创建、发消息与协调 teammate 的工具',
			'@deepseek-ai/dsh-file-reference-local': '面向用户与维护者的本地工作区 @file 补全提供方',
			'@deepseek-ai/dsh-fs-observation-policy': '编辑前读取的文件系统策略插件：面向选择或排查受防护写入/编辑行为的部署方与维护者',
			'@deepseek-ai/dsh-fs-sandbox': '强制沙箱的 `ctx.fs` 后端：面向把模型文件变更限制在会话工作区内的部署方与维护者',
			'@deepseek-ai/dsh-goal': '面向选择、配置或排查同会话持久 goal 服务的用户与维护者：每会话一个持久的完成目标',
			'@deepseek-ai/dsh-goal-round-driver': '同会话续行驱动器',
			'@deepseek-ai/dsh-hmr': '通过统一协调队列热重载插件代码和 profile 配置',
			'@deepseek-ai/dsh-host-directory-picker-auto': '目录选择 seam 的自适应选择器：在启动时判定一次 web GUI 宿主的处境，并挂载匹配的原生或浏览后端',
			'@deepseek-ai/dsh-host-open-in-app': 'open-in-app 的主机半边：在 macOS、Windows、Linux 上把已安装的编辑器、Git GUI、',
			'@deepseek-ai/dsh-host-plugin-inventory': '当前 Cordis Loader 插件状态的只读投影，并附带每个 agent preset（智能体预设）的组合：面向',
			'@deepseek-ai/dsh-host-webserver': 'web GUI 宿主的 HTTP 服务器：具名路由与 upgrade 注册、index 转换，以及服务 Web 壳 ',
			'@deepseek-ai/dsh-jobs-local': '进程本地后台任务注册表',
			'@deepseek-ai/dsh-llm': '提供方无关模型调用服务：流式发起请求、注册提供方适配器或解析模型元数据',
			'@deepseek-ai/dsh-llm-deepseek-account': 'DeepSeek 账号认证与模型发现。',
			'@deepseek-ai/dsh-llm-deepseek-api-key': 'DeepSeek API Key 认证与模型发现。',
			'@deepseek-ai/dsh-llm-pi-ai': 'pi-ai 多提供方适配器：通过 pi-ai 目录与手工声明网关路由 harness LLM（大语言模型）服务',
			'@deepseek-ai/dsh-llm-retry': '重试执行器：在持久 agent（智能体）步骤边界上配置按提供方路由的模型请求恢复',
			'@deepseek-ai/dsh-mcp-resources': '通过共享工具、显式服务器选择和 agent 作用域访问，按需发现与读取 MCP 资源',
			'@deepseek-ai/dsh-message-feedback': '在权威 Session 日志中保存已完成 assistant 消息的评分、分类与备注',
			'@deepseek-ai/dsh-office-to-pdf': '通过独立发布的 LibreOffice kit 在 Host 转换 Office 文档',
			'@deepseek-ai/dsh-permission-presets': '权限预设：把沙箱模式与审批策略捆在一起，供 Permissions 选择器使用。',
			'@deepseek-ai/dsh-persona': 'preset 挂载的可组装人设行，让单个 agent 拥有自己的系统提示词人设',
			'@deepseek-ai/dsh-plan-mode': '计划模式：用于选择、配置或排查带部署引导、/plan 命令与经用户评审退出的逐 agent（智能体）规划功能',
			'@deepseek-ai/dsh-plugin-manager': '通过 Web 侧边栏或 agent 启停 profile 插件，并安装、删除或选择组合包',
			'@deepseek-ai/dsh-plugin-manager/tools': '通过 Web 侧边栏或 agent 启停 profile 插件，并安装、删除或选择组合包',
			'@deepseek-ai/dsh-plugin-package-inventory-deepseek': '面向发送官方 DeepSeek 请求的部署，说明活跃 Loader 包清单元数据',
			'@deepseek-ai/dsh-ptc-runtime-node': '在全新 Node 进程中运行 TypeScript 程序，使用会话文件系统沙箱、受管清理以及可配置的执行与输出限制',
			'@deepseek-ai/dsh-pwsh-sandbox': '沙箱 PowerShell 执行器：用于选择、配置或排查受限 PowerShell 命令执行及其拒绝事实',
			'@deepseek-ai/dsh-repeat-tool-reminder': '建议性循环卫生 guard：当 agent（智能体）重复完全相同的工具调用时提醒模型',
			'@deepseek-ai/dsh-sandbox-local': '面向 Linux、macOS 或 Windows 上选择、配置或排查进程隔离的用户与维护者的本地各平台沙箱后端',
			'@deepseek-ai/dsh-sandbox-policy': '面向需要在各项负责强制执行的能力之间组合、配置或排查文件操作策略的用户与维护者，提供共享的逐调用沙箱策略解析器与当前',
			'@deepseek-ai/dsh-schedule': '宿主级持久提醒与按会话绑定的共享任务管理',
			'@deepseek-ai/dsh-session': '事件溯源会话日志与内存存储：用于构建、检查或扩展每个 agent（智能体）交互背后的持久记录',
			'@deepseek-ai/dsh-session-checkpoint-policy': '语义会话持久性检查点：用于部署不会在崩溃时丢失模型请求或工具副作用的持久化 agent（智能体）',
			'@deepseek-ai/dsh-session-log-deepseek': '面向启用官方 DeepSeek 请求元数据的部署，增量上传规范会话日志',
			'@deepseek-ai/dsh-session-persistence-jsonl': '随产品交付 JSONL 会话持久化后端：用于选择、配置或排查带可选 Zstandard 压缩的逐会话持久日志',
			'@deepseek-ai/dsh-session-projection': '会话投影注册表：用于向客户端载体提供日志派生逐会话状态的完整当前值，或维护驱动约定',
			'@deepseek-ai/dsh-session-projection-cache': '持久会话投影缓存：用于选择、配置或排查持久检查点、零 I/O 列表读取与加速的冷投影折叠',
			'@deepseek-ai/dsh-session-query-sqlite': '面向部署方与维护者的 SQLite FTS5 会话历史全文搜索后端',
			'@deepseek-ai/dsh-session-reference': '跨会话快照引用与持久的不受信任模型上下文',
			'@deepseek-ai/dsh-session-stats': '全日志会话计数与墙钟时间：用于选择、组合或排查 sessionStats 投影单元',
			'@deepseek-ai/dsh-session-telemetry-otel': 'OpenTelemetry 会话遥测后端：用于选择模式、配置导出器或排查哪些数据离开本机',
			'@deepseek-ai/dsh-session-title': '日志支持型会话标题：用于选择标题来源、配置服务或排查标题状态',
			'@deepseek-ai/dsh-session-title-first-prompt-llm': '首消息 LLM（大语言模型）会话标题提供方：用于选择标题策略或排查自动标题生成',
			'@deepseek-ai/dsh-session-turn-outline': '全量轮次大纲：支撑整会话轮次导航',
			'@deepseek-ai/dsh-settings': '通过 Config 派生表单查看和编辑插件的即时配置',
			'@deepseek-ai/dsh-shell-env': '受管 DSH_* shell 环境',
			'@deepseek-ai/dsh-skill': 'skill（技能）提供方注册表',
			'@deepseek-ai/dsh-skill-badge': '随包附带的「powered by dsh」徽章 skill（技能）',
			'@deepseek-ai/dsh-skill-filesystem': '本地文件系统 skill 提供方',
			'@deepseek-ai/dsh-spill-local': '本地文件系统 spill 后端：spill 文本如何保存到私有会话级文件，并用 read 或 grep 取回',
			'@deepseek-ai/dsh-spill-policy': '工具结果保留：文字和图片共享 token 预算，并通过完整结果文件恢复省略内容',
			'@deepseek-ai/dsh-storage': '存储枢纽（ctx.storage）：面向选择、挂载或排查具名存储后端与数据形式设施的组合方与维护者',
			'@deepseek-ai/dsh-storage-domain': '领域数据形式（ctx.storageDomain）：面向在存储后端之上选择、挂载或排查经过 schema 校验、发出',
			'@deepseek-ai/dsh-storage-json': 'JSON 存储后端：面向在配置根目录下选择、配置或排查整单元文件与逐记录文件的宿主与维护者',
			'@deepseek-ai/dsh-subagent': '面向用户与维护者的 subagent 委派 seam',
			'@deepseek-ai/dsh-subagent-fork-in-process': '进程内 fork subagent 后端：用于选择、配置或排查以父级已完成轮次作初始内容的子 agent（智能体）',
			'@deepseek-ai/dsh-subagent-spawn-in-process': '进程内 spawn subagent 后端：用于选择、配置或排查全新子级委派',
			'@deepseek-ai/dsh-subprocess-local': '子进程服务的本地宿主提供方：在宿主机器上运行由 OS 所有的受管范围与真实终端会话，并明确披露较弱的 fallback',
			'@deepseek-ai/dsh-system-prompt': '系统提示词组装：用于添加提示词段、变量、工具 schema 来源或配置面向模型的提示词',
			'@deepseek-ai/dsh-time-context': '按步骤提供时钟上下文，包含当前时间、浏览器时区与经过时长',
			'@deepseek-ai/dsh-token-meter': 'token 与上下文压力计量：评估提示词规模或构建压缩（compaction）与占用显示',
			'@deepseek-ai/dsh-tool-ask-user': '基于 user-questions seam 的模型侧 ask_user_question 工具',
			'@deepseek-ai/dsh-tool-bash': '面向模型的 bash 工具',
			'@deepseek-ai/dsh-tool-call-timeout-policy': '为配合取消的工具调用设置协作式时间上限，并在超时流程完成后映射为清晰的模型错误',
			'@deepseek-ai/dsh-tool-cordis/host': '为开发和配置已安装 Harness 插件的 agent 提供只读运行时 API 查询',
			'@deepseek-ai/dsh-tool-fs': '面向模型的 read、read_image、write 与 edit 工具：供组合或排查 agent 文件系统访问的',
			'@deepseek-ai/dsh-tool-fs-search': '面向模型的 glob 与 grep 发现工具：供组合或排查 agent（智能体）工作区搜索的用户与维护者使用',
			'@deepseek-ai/dsh-tool-goal': '模型侧 goal 工具',
			'@deepseek-ai/dsh-tool-jobs': '面向模型的后台任务控制',
			'@deepseek-ai/dsh-tool-present': '通过 present 声明交付可访问的文件；配置、Session 归属与源文件打开',
			'@deepseek-ai/dsh-tool-pwsh': '面向模型的 pwsh 工具',
			'@deepseek-ai/dsh-tool-ralph': '面向模型的 ralph 工具：固定前台 agent loop（智能体循环），让全新 agent 围绕一个不可变目标迭代',
			'@deepseek-ai/dsh-tool-skill': '面向模型的 skill（技能）目录与加载工具',
			'@deepseek-ai/dsh-tool-subagent': '面向模型的 subagent 委派工具',
			'@deepseek-ai/dsh-tool-subagent-control': '供用户与维护者在组合或调试可继续子级控制功能时使用的全局 send_message、interrupt_agent ',
			'@deepseek-ai/dsh-tool-subagent-control/list-agents': '供用户与维护者在组合或调试可继续子级控制功能时使用的全局 send_message、interrupt_agent ',
			'@deepseek-ai/dsh-tool-subagent/model-selection-settings': '面向模型的 subagent 委派工具',
			'@deepseek-ai/dsh-tool-todo': '面向 DeepSeek Harness 会话日志的模型侧 todo_write 工具：整表替换、单一会话归属与 to',
			'@deepseek-ai/dsh-tool-web': '构建于 ctx.web 之上的面向模型 web 工具（web_search、web_fetch）：部署方如何启用、配',
			'@deepseek-ai/dsh-tool-workflow': '面向模型的工作流工具：运行扇出 subagent 的 JavaScript 编排脚本',
			'@deepseek-ai/dsh-tools': '工具注册表与执行流水线：用于注册、限制、呈现或调试面向模型的工具',
			'@deepseek-ai/dsh-typert-loader': '生成的 Typert 产物所用的 Loader 集成：已挂载的包如何自动把宿主侧反射与 schema 贡献给运行时注册表',
			'@deepseek-ai/dsh-user-approval': '与通道无关的一次性审批 seam',
			'@deepseek-ai/dsh-user-questions': '基于 waterfall 的问答服务',
			'@deepseek-ai/dsh-web': 'web 访问服务（ctx.web）：部署方与插件作者如何通过可互换的提供方搜索 web 与抓取 URL，以及统一的选',
			'@deepseek-ai/dsh-web-app': 'Web 浏览器 GUI 的门面：交互式聊天、模型与设置管理、会话历史。',
			'@deepseek-ai/dsh-web-app/startup': 'Web 启动器：解析命令行与 profile，提供 webStartup 服务。',
			'@deepseek-ai/dsh-web-fetch-http': 'ctx.web 的匿名公共 HTTP(S) 抓取后端：部署方如何挂载有界、安全的 URL 抓取，含同源重定向与仅文本解码',
			'@deepseek-ai/dsh-web-search-deepseek': 'ctx.web 的 DeepSeek 搜索提供方：部署方如何通过 Anthropic 兼容 Messages API',
			'@deepseek-ai/dsh-workflow-ptc': '通过共享的沙箱化 PTC Node 进程运行时执行工作流编排，保留工作流钩子、subagent 路由和调用方拥有的取',
			'@deepseek-ai/dsh-workspace': 'Workspace 实体注册表（ctx.workspaceRegistry）',
			'@deepseek-ai/dsh-workspace-changes': '用 git 工作树快照和文件工具编辑前后的整文件捕获汇总每个顶层轮次改动的文件，以 workspace/change',
			'cordis:include': 'Cordis 的 include 机制：把被引用的配置文件挂进插件树。',
			'cordis:group': 'Cordis 的分组容器：把一组插件当成一个单元挂载，可隔离服务。',
			'cordis:timer': 'Cordis 的定时器服务。',
			'cordis:loader': 'Cordis 的插件加载器：按配置树装载与热更新插件。',
			'dsh-market-console': '插件市场控制台（就是本插件）：搜索、安装、启停、卸载第三方插件。',		};

		// ════════════════════════════════════════════════════════════════
		// 2. 本地化字典
		// ════════════════════════════════════════════════════════════════

		const zh = {
			tab: '插件市场',
			title: '插件市场',
			intro: '搜索、安装、启停与卸载这个 profile 的插件。所有写操作都会先做预检并要求确认。',

			viewInstalled: '已安装',
			viewDiscover: '发现插件',

			refresh: '刷新',
			loading: '正在读取插件清单…',
			emptyInstalled: '当前 profile 没有可展示的插件。',
			emptyFiltered: '没有匹配「{q}」的插件。',
			loadFailed: '读取插件清单失败：{msg}',
			retry: '重试',

			installedHeading: '已安装插件',
			bundlesHeading: '组合包',
			mountDiagTitle: '未在 host 插件清单里找到自身的挂载行',
			mountDiagBody: '本页可能来自缓存。请检查 profile 的 cordis.patch.yml 里是否还有 market-console 条目 —— 客户端大版本更新会重写这个文件。补上后重启客户端。',

			filterPlaceholder: '在已装插件里过滤（名称 / 模块 / 条目 id）',

			discoverPlaceholder: '搜索 npm 上的 DSH 插件，例如「whale」「余额」',
			discoverHint: '按 {kw} 标签检索 npm registry；留空则列出该标签下的全部插件。',
			searching: '搜索中…',
			searchFailed: '搜索失败：{msg}',
			searchEmpty: '没有搜到插件。换个关键词试试。',
			searchEmptyHint: '提示：本机若访问不了 {registry}，可在上方切换镜像。',
			registryLabel: 'registry',
			install: '安装',
			installing: '安装中…',
			installedBadge: '已安装',
			cancel: '取消',
			cancelling: '正在取消…',
			sourceNpm: 'npm',

			badgeReadonly: '只读',
			badgeOfficial: '官方',
			officialTitle: 'DSH 官方自带（@deepseek-ai/* 或 cordis:*）',
			hideOfficial: '隐藏官方',
			hideOfficialHint: '只看自己装的第三方插件',
			hiddenOfficialCount: '已隐藏 {count} 个官方插件',
			allFilteredOut: '匹配到的都是官方插件，已被「隐藏官方」过滤掉。',
			badgeEnabled: '已启用',
			badgeDisabled: '已禁用',

			phasePending: '等待加载',
			phaseLoading: '加载中',
			phaseActive: '运行中',
			phaseFailed: '启动失败',
			phaseUnloading: '卸载中',
			phaseAbsent: '未运行',

			reasonSelf: '这是市场插件自身',
			reasonManager: '插件管理基础设施，卸载会导致界面消失',
			reasonSystem: 'DSH 运行底座',
			reasonInventoryManagement: '插件管理所需，不可停用或卸载',
			reasonUnaddressable: '不属于当前 profile，或无法唯一定位',
			reasonNotRemovable: '该组合包不可卸载',

			enable: '启用',
			disable: '停用',
			remove: '卸载',
			working: '处理中…',

			confirmRemoveTitle: '确认卸载「{name}」？',
			confirmRemoveBody: '将从 profile 的依赖与挂载配置里移除 {name}{version}。',
			confirmRemoveWarn: '该插件提供的功能会立即失效；若它正在被别的插件依赖，可能连带失效。',
			confirmRemoveYes: '确认卸载',
			confirmRemoveNo: '再想想',
			dismiss: '关闭',

			applied: '已生效',
			restartRequired: '需要重启客户端才能生效',
			restartHint: 'cordis.patch.yml 只在客户端启动时读取，刷新页面无效。请重启客户端：完全退出 DeepSeek Harness 后重新打开。',
			restartReasonLabel: '重启原因',
			restartReasonNoHmr: '该 profile 未启用热重载。',
			restartReasonPackageMoved: '依赖包的位置或解析结果发生变化。',
			restartReasonHostModule: '改动涉及宿主模块。',
			restartReasonUnmanagedPlugin: '改动涉及未受本 profile 管理的插件。',
			restartReasonModuleComparison: '模块比较结果要求重启。',
			restartReasonNotApplied: '变更未能在运行中的 Loader 里生效。',
			restartReasonUnknown: '原因未公开。',
			overridden: '被更高优先级的 overlay 覆盖，本次改动未生效',
			opCancelled: '操作已取消',
			opFailed: '操作失败',

			problemInvalidSpec: '不是合法的安装目标。可填包名、包名@版本、本地绝对路径、github:owner/repo 或 tarball URL。',
			problemAlreadyInstalled: '已经装过了。',
			problemNotFound: '在 registry 里找不到这个包。',
			problemNotAPackage: '目标存在，但它不是一个 npm 包。',
			problemNotABundle: '这个包不是 DSH bundle：它的 package.json 里没有 dsh.bundle.patch 声明，装上也挂载不了。',
			problemNetwork: '连不上 registry。检查网络，或换一个 registry 重试。',
			problemUnknown: '未知错误。',

			errManagementRequired: '当前 profile 不允许通过界面管理插件。',
			errUnaddressable: '无法唯一定位这个插件。',
			errUnknownPlugin: '插件管理器不认识这个插件。',
			errInvalidSpec: '安装目标格式不合法。',
			errAmbiguousInstall: '这个包名在多个 registry 里指向不同内容，无法确定装哪个。',
			errNotBundle: '不是 DSH bundle，无法挂载。',
			errNotRemovable: '该组合包不可卸载。',
			errStopProfile: '这是当前 profile 自身，不能停用。',
			errBundleInUse: '该组合包正在被使用（它可能提供了本插件依赖的能力）。',
			errStaleApproval: '构建脚本的批准已过期，需要重新确认。',
			errIncompatibleVersion: '版本不兼容：{detail}',
			errOperationError: '操作过程中出错：{detail}',

			buildApprovalTitle: '这个包需要运行构建脚本',
			buildApprovalBody: '以下包在安装时会执行安装脚本（postinstall 等）。确认来源可信后再批准：',
			buildApprovalYes: '批准并重试',
			buildApprovalNo: '取消',

			incompatibleTitle: '版本门控拒绝',
			incompatibleBody: '以下依赖与本机 DSH 不兼容：',

			warnings: '警告',
			detailToggle: '详情',

			notePlaceholder: '写点这个插件是干什么的、你为什么装它……',
			noteSave: '保存',
			noteEdit: '编辑',
			noteReset: '恢复内置说明',
			noteCustom: '我的备注',
			noteBuiltin: '内置说明',
			noteEmpty: '还没有备注。',
			logPath: '日志',
			installedVersion: '已安装版本',
			catalogOnlyHidden: '已隐藏 {count} 个未安装的目录条目（DSH 0.2.1 官方市场目录）。',

			sourceLabel: '来源',
			moduleLabel: '模块',
			entryLabel: '条目',
			versionLabel: '版本',
			downloads: '月下载'
		};

		const en = {
			tab: 'Plugin Market',
			title: 'Plugin Market',
			intro: 'Search, install, enable/disable and remove plugins for this profile. Every write asks for confirmation after a dry-run check.',

			viewInstalled: 'Installed',
			viewDiscover: 'Discover',

			refresh: 'Refresh',
			loading: 'Reading plugin inventory…',
			emptyInstalled: 'This profile exposes no plugins to show.',
			emptyFiltered: 'Nothing matches “{q}”.',
			loadFailed: 'Failed to read the plugin inventory: {msg}',
			retry: 'Retry',

			installedHeading: 'Installed plugins',
			bundlesHeading: 'Bundles',
			mountDiagTitle: 'This plugin has no mount row in the host inventory',
			mountDiagBody: 'This page may be served from cache. Check that cordis.patch.yml in the profile still carries the market-console entry — client major updates rewrite that file. Re-add it, then restart the client.',

			filterPlaceholder: 'Filter installed plugins (name / module / entry id)',

			discoverPlaceholder: 'Search DSH plugins on npm, e.g. “whale”',
			discoverHint: 'Queries the npm registry by the {kw} tag; leave empty to list everything under it.',
			searching: 'Searching…',
			searchFailed: 'Search failed: {msg}',
			searchEmpty: 'No plugins found. Try another keyword.',
			searchEmptyHint: 'Hint: if this machine cannot reach {registry}, switch the mirror above.',
			registryLabel: 'registry',
			install: 'Install',
			installing: 'Installing…',
			installedBadge: 'Installed',
			cancel: 'Cancel',
			cancelling: 'Cancelling…',
			sourceNpm: 'npm',

			badgeReadonly: 'read-only',
			badgeOfficial: 'official',
			officialTitle: 'Ships with DSH (@deepseek-ai/* or cordis:*)',
			hideOfficial: 'Hide official',
			hideOfficialHint: 'Show only third-party plugins you installed',
			hiddenOfficialCount: '{count} official plugins hidden',
			allFilteredOut: 'Everything that matched is official and hidden by the filter.',
			badgeEnabled: 'enabled',
			badgeDisabled: 'disabled',

			phasePending: 'waiting',
			phaseLoading: 'loading',
			phaseActive: 'running',
			phaseFailed: 'failed to start',
			phaseUnloading: 'unloading',
			phaseAbsent: 'not running',

			reasonSelf: 'this is the market plugin itself',
			reasonManager: 'plugin-management infrastructure — removing it hides this UI',
			reasonSystem: 'DSH runtime base',
			reasonInventoryManagement: 'required by plugin management; cannot be disabled or removed',
			reasonUnaddressable: 'not part of this profile, or not uniquely addressable',
			reasonNotRemovable: 'this bundle cannot be removed',

			enable: 'Enable',
			disable: 'Disable',
			remove: 'Remove',
			working: 'Working…',

			confirmRemoveTitle: 'Remove “{name}”?',
			confirmRemoveBody: 'This drops {name}{version} from the profile dependencies and mount configuration.',
			confirmRemoveWarn: 'Its features stop immediately; anything depending on it may break with it.',
			confirmRemoveYes: 'Remove it',
			confirmRemoveNo: 'Keep it',
			dismiss: 'Dismiss',

			applied: 'Applied',
			restartRequired: 'Restart the client to apply',
			restartHint: 'cordis.patch.yml is read at startup only — reloading the page is not enough. Restart the client: quit DeepSeek Harness completely and reopen it.',
			restartReasonLabel: 'Restart reason',
			restartReasonNoHmr: 'Hot reload is not enabled for this profile.',
			restartReasonPackageMoved: 'A dependency moved or resolves differently.',
			restartReasonHostModule: 'The change touches Host modules.',
			restartReasonUnmanagedPlugin: 'The change touches a plugin this profile does not manage.',
			restartReasonModuleComparison: 'The module comparison requires a restart.',
			restartReasonNotApplied: 'The change could not be applied to the running Loader.',
			restartReasonUnknown: 'The reason was not published.',
			overridden: 'Overridden by a higher-priority layer; nothing changed',
			opCancelled: 'Cancelled',
			opFailed: 'Failed',

			problemInvalidSpec: 'Not a valid install target. Use a package name, name@version, an absolute path, github:owner/repo, or a tarball URL.',
			problemAlreadyInstalled: 'Already installed.',
			problemNotFound: 'No such package in the registry.',
			problemNotAPackage: 'The target exists but is not an npm package.',
			problemNotABundle: 'Not a DSH bundle: its package.json declares no dsh.bundle.patch, so installing it would mount nothing.',
			problemNetwork: 'Cannot reach the registry. Check the network or switch registries.',
			problemUnknown: 'Unknown error.',

			errManagementRequired: 'This profile does not allow plugin management from the UI.',
			errUnaddressable: 'This plugin cannot be uniquely addressed.',
			errUnknownPlugin: 'The plugin manager does not know this plugin.',
			errInvalidSpec: 'Malformed install target.',
			errAmbiguousInstall: 'That name resolves differently across registries; cannot decide what to install.',
			errNotBundle: 'Not a DSH bundle; nothing to mount.',
			errNotRemovable: 'This bundle cannot be removed.',
			errStopProfile: 'This is the active profile itself and cannot be disabled.',
			errBundleInUse: 'The bundle is in use (it likely provides something this plugin needs).',
			errStaleApproval: 'The build-script approval went stale; confirm again.',
			errIncompatibleVersion: 'Incompatible version: {detail}',
			errOperationError: 'The operation failed: {detail}',

			buildApprovalTitle: 'This package wants to run build scripts',
			buildApprovalBody: 'These packages run install scripts (postinstall & co.). Approve only if you trust the source:',
			buildApprovalYes: 'Approve and retry',
			buildApprovalNo: 'Cancel',

			incompatibleTitle: 'Refused by version gating',
			incompatibleBody: 'These dependencies are incompatible with this DSH build:',

			warnings: 'Warnings',
			detailToggle: 'Details',

			notePlaceholder: 'What does this plugin do, and why did you install it?',
			noteSave: 'Save',
			noteEdit: 'Edit',
			noteReset: 'Restore built-in',
			noteCustom: 'My note',
			noteBuiltin: 'Built-in',
			noteEmpty: 'No note yet.',
			logPath: 'Log',
			installedVersion: 'Installed version',
			catalogOnlyHidden: '{count} catalog-only bundles hidden (DSH 0.2.1 official market catalog).',

			sourceLabel: 'Source',
			moduleLabel: 'Module',
			entryLabel: 'Entry',
			versionLabel: 'Version',
			downloads: 'monthly downloads'
		};

		// ════════════════════════════════════════════════════════════════
		// 3. 纯工具
		// ════════════════════════════════════════════════════════════════

		/** 插值：t('x', { a: 1 }) 把 {a} 换掉。 */
		function format(template, params) {
			if (typeof template !== 'string' || params === undefined || params === null) return template;
			return template.replace(/\{(\w+)\}/g, (whole, key) =>
				Object.prototype.hasOwnProperty.call(params, key) && params[key] !== undefined && params[key] !== null
					? String(params[key])
					: whole);
		}

		/**
		 * 解包 Remote 结果：`{ ok, value }` / `{ ok: false, error }`。
		 * 也容忍直接返回数据的实现（防御未来版本差异）。
		 */
		function unwrap(result) {
			if (result === null || result === undefined) return result;
			if (typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'ok')) {
				if (result.ok === false) {
					const err = result.error || {};
					const error = new Error(err.message || err.code || 'remote call failed');
					error.code = err.code;
					throw error;
				}
				return result.value;
			}
			return result;
		}

		/** Start-of-day-safe unique-ish request id (a plain string on the wire). */
		function makeRequestId(prefix) {
			return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
		}

		/** 模块名 → 短名。 */
		function shortenModule(name) {
			let s = String(name || '');
			if (s.startsWith('@')) {
				const slash = s.indexOf('/');
				if (slash >= 0) s = s.slice(slash + 1);
			}
			return s.replace(/^(cordis-plugin-|dsh-client-ui-|dsh-client-|dsh-host-|dsh-)/, '');
		}

		/** 前缀匹配（带段边界，避免 dsh-base 命中 dsh-baseball）。 */
		function matchesModule(value, prefix) {
			return value === prefix || value.startsWith(prefix + '/');
		}

		function isAnyOf(value, list) {
			return list.some((prefix) => matchesModule(value, prefix));
		}

		/**
		 * 「官方自带」判定。
		 *
		 * 三种都算官方：
		 *   - `@deepseek-ai/*` —— DSH 自家发布的包；
		 *   - `cordis:*` —— cordis 框架内置插件（协议限定名，磁盘上没有对应目录）；
		 *   - 裸 `@deepseek-ai/cordis` 之类已在第一条覆盖。
		 *
		 * 第三方（`dsh-whale-widget`、本插件自己）一律不算。
		 */
		function isOfficialPackage(name) {
			const value = String(name || '');
			return value.startsWith('@deepseek-ai/') || value.startsWith('cordis:');
		}

		/** 简单偏好存储（localStorage 可能被禁用，一律 try）。 */
		function readPrefs() {
			try {
				const raw = window.localStorage.getItem(PREFS_KEY);
				if (!raw) return {};
				const parsed = JSON.parse(raw);
				return parsed && typeof parsed === 'object' ? parsed : {};
			} catch (error) {
				return {};
			}
		}

		function writePrefs(patch) {
			try {
				window.localStorage.setItem(PREFS_KEY, JSON.stringify({ ...readPrefs(), ...patch }));
			} catch (error) {
				/* 存不了就算了，不影响功能 */
			}
		}

		/** 读取用户备注表：`{ "<包名>": "文本" }`。 */
		function readNotes() {
			try {
				const raw = window.localStorage.getItem(NOTES_KEY);
				if (!raw) return {};
				const parsed = JSON.parse(raw);
				return parsed && typeof parsed === 'object' ? parsed : {};
			} catch (error) {
				return {};
			}
		}

		/**
		 * 写入或清除一条备注，返回生效后的自定义文本（null = 已恢复内置说明）。
		 *
		 * 传空串等于「恢复内置说明」—— 直接从表里删掉这个键，而不是存一个空值，
		 * 这样以后改版内置文案时能重新显示出来。
		 */
		function writeNote(pkgName, text) {
			try {
				const notes = readNotes();
				const trimmed = String(text === undefined || text === null ? '' : text).trim();
				if (trimmed === '') delete notes[pkgName];
				else notes[pkgName] = trimmed;
				window.localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
				return trimmed === '' ? null : trimmed;
			} catch (error) {
				return null;
			}
		}

		/**
		 * C4 判定：null = 可管理；否则返回不可管理的字典键。
		 * 这里只处理**插件条目**（listPlugins 的行）。
		 */
		function pluginReadOnlyReason(entry) {
			const moduleName = String(entry.moduleName || '');
			const entryId = String(entry.entryId || '');
			if (moduleName === SELF_PACKAGE || entryId === SELF_ENTRY_ID) return 'reasonSelf';
			if (entryId === SELF_PACKAGE) return 'reasonSelf';
			if (entry.readOnlyReason === 'management-required') return 'reasonInventoryManagement';
			if (entry.readOnlyReason === 'unaddressable') return 'reasonUnaddressable';
			if (isAnyOf(moduleName, MANAGER_MODULES)) return 'reasonManager';
			if (isAnyOf(moduleName, SYSTEM_MODULES)) return 'reasonSystem';
			return null;
		}

		/**
		 * C4 判定：组合包。`removable` 与 `readOnlyReason` 由官方服务给出，
		 * 但自身与系统底座仍要额外兜底。
		 */
		function bundleReadOnlyReason(item) {
			const name = String(item.name || '');
			if (name === SELF_PACKAGE) return 'reasonSelf';
			if (item.readOnlyReason === 'management-required') return 'reasonInventoryManagement';
			if (item.readOnlyReason === 'unaddressable') return 'reasonUnaddressable';
			if (isAnyOf(name, MANAGER_MODULES)) return 'reasonManager';
			if (item.removable === false) return 'reasonNotRemovable';
			if (isAnyOf(name, SYSTEM_MODULES)) return 'reasonSystem';
			return null;
		}

		/** 搜索结果里也必须过滤自身与管理组件（C4 同样适用于市场侧）。 */
		function isSearchResultManageable(pkgName) {
			const name = String(pkgName || '');
			return name !== SELF_PACKAGE && !isAnyOf(name, MANAGER_MODULES);
		}

		/**
		 * DSH 0.2.1 的 `listBundles` 还会返回「官方市场目录里存在、但本 profile 既没装
		 * 也没启用」的组合包（`installed === false`）。它们只是目录项：既不能启停也不
		 * 能卸载，不属于「已安装」。真实的已安装行、可移除行、或仍处启用态的行一律保留。
		 */
		function isCatalogOnlyBundle(item) {
			return Boolean(item) && item.installed === false && item.removable !== true && item.enabled !== true;
		}

		/** fiber 阶段 → { 字典键, 色调 }。 */
		function phaseInfo(phase) {
			switch (phase) {
				case 'pending': return { key: 'phasePending', tone: 'idle' };
				case 'loading': return { key: 'phaseLoading', tone: 'ongoing' };
				case 'active': return { key: 'phaseActive', tone: 'ok' };
				case 'failed': return { key: 'phaseFailed', tone: 'error' };
				case 'unloading': return { key: 'phaseUnloading', tone: 'ongoing' };
				default: return { key: 'phaseAbsent', tone: 'idle' };
			}
		}

		/** inspect 的 problem 枚举 → 字典键。 */
		const PROBLEM_KEYS = {
			'invalid-spec': 'problemInvalidSpec',
			'already-installed': 'problemAlreadyInstalled',
			'not-found': 'problemNotFound',
			'not-a-package': 'problemNotAPackage',
			'not-a-bundle': 'problemNotABundle',
			network: 'problemNetwork',
			unknown: 'problemUnknown'
		};

		/** 写操作 error.code 枚举 → 字典键。 */
		const ERROR_CODE_KEYS = {
			'management-required': 'errManagementRequired',
			unaddressable: 'errUnaddressable',
			'unknown-plugin': 'errUnknownPlugin',
			'invalid-spec': 'errInvalidSpec',
			'already-installed': 'problemAlreadyInstalled',
			'ambiguous-install': 'errAmbiguousInstall',
			'not-bundle': 'errNotBundle',
			'not-removable': 'errNotRemovable',
			'stop-profile': 'errStopProfile',
			'bundle-in-use': 'errBundleInUse',
			'stale-approval': 'errStaleApproval',
			'incompatible-version': 'errIncompatibleVersion',
			'operation-error': 'errOperationError'
		};

		/**
		 * DSH 0.2.1 的 `restartReason` 枚举 → 字典键。
		 * 值来自官方 schema：no-hmr / package-moved / host-module /
		 * unmanaged-plugin / module-comparison（另加本插件保守自检的 not-applied）。
		 */
		const RESTART_REASON_KEYS = {
			'no-hmr': 'restartReasonNoHmr',
			'package-moved': 'restartReasonPackageMoved',
			'host-module': 'restartReasonHostModule',
			'unmanaged-plugin': 'restartReasonUnmanagedPlugin',
			'module-comparison': 'restartReasonModuleComparison',
			'not-applied': 'restartReasonNotApplied'
		};

		/** 写操作 application 枚举 → 字典键 + 色调。 */
		function applicationInfo(application) {
			switch (application) {
				case 'applied': return { key: 'applied', tone: 'ok' };
				case 'restart-required': return { key: 'restartRequired', tone: 'warn' };
				case 'overridden': return { key: 'overridden', tone: 'warn' };
				case 'cancelled': return { key: 'opCancelled', tone: 'idle' };
				default: return { key: 'opFailed', tone: 'error' };
			}
		}

		/** 从写操作结果里提炼一句能读的错误说明。 */
		function describeOperationFailure(result, t) {
			if (!result || typeof result !== 'object') return t('opFailed');
			const error = result.error;
			if (!error) return t('opFailed');
			const key = ERROR_CODE_KEYS[error.code];
			if (key === undefined) return error.diagnostic || error.code || t('opFailed');
			return t(key, { detail: error.diagnostic || error.code || '' });
		}

		// ════════════════════════════════════════════════════════════════
		// 4. 样式（只吃 DSH 设计变量，不引入任何 UI 框架）
		// ════════════════════════════════════════════════════════════════

		const CSS = [
			'.mc_root{width:100%;max-width:760px;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary)}',
			'.mc_root h2{margin:0;font-size:18px;font-weight:600;line-height:24px}',
			'.mc_root h3{margin:0;font-size:13px;font-weight:600;line-height:20px}',
			'.mc_intro{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}',
			'.mc_tabs{display:flex;align-items:flex-end;gap:22px;border-bottom:.5px solid var(--dsw-alias-border-l2);margin-top:2px}',
			'.mc_tab{position:relative;background:0 0;border:0;padding:7px 1px 9px;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary);cursor:pointer}',
			'.mc_tab:hover,.mc_tab[data-active=true]{color:var(--dsw-alias-label-primary)}',
			'.mc_tab[data-active=true]:after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:2px 2px 0 0;background:var(--dsw-alias-label-primary)}',
			'.mc_tab:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px;border-radius:2px}',
			'.mc_panel{display:flex;flex-direction:column;gap:12px;min-width:0;padding-top:2px}',

			'.mc_toolbar{display:flex;align-items:center;gap:8px}',
			'.mc_search{position:relative;display:flex;align-items:center;flex:1;min-width:0}',
			'.mc_search input,.mc_input{width:100%;height:36px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none;padding:0 12px}',
			'.mc_search input::placeholder,.mc_input::placeholder{color:var(--dsw-alias-label-tertiary)}',
			'.mc_search input:focus-visible,.mc_input:focus-visible{border-color:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary)) 18%,transparent)}',
			'.mc_registry{flex:none;min-width:190px;max-width:230px}',

			'.mc_btn{height:32px;padding:0 12px;border:none;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;flex:none}',
			'.mc_btn:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover)}',
			'.mc_btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
			'.mc_btn[disabled]{opacity:.45;cursor:default}',
			'.mc_btn[data-tone=primary]{background:var(--dsw-alias-state-business-primary);color:#fff}',
			'.mc_btn[data-tone=primary]:hover:not([disabled]){filter:brightness(1.08)}',
			'.mc_btn[data-tone=danger]{background:0 0;border:.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 55%,transparent);color:var(--dsw-alias-state-error-primary)}',
			'.mc_btn[data-tone=danger]:hover:not([disabled]){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}',
			'.mc_btn[data-tone=ghost]{background:0 0;border:.5px solid var(--dsw-alias-border-l3)}',

			'.mc_status,.mc_failure{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}',
			'.mc_failure{display:flex;align-items:center;gap:10px;flex-wrap:wrap;color:var(--dsw-alias-state-error-primary)}',
			'.mc_hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',

			'.mc_group{display:flex;flex-direction:column;gap:10px}',
			'.mc_groupHead{display:flex;align-items:baseline;gap:7px;padding:0 2px}',
			'.mc_count{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}',
			'.mc_cards{display:flex;flex-direction:column;gap:10px;margin:0;padding:0;list-style:none}',

			'.mc_card{border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1));min-width:0;overflow:hidden}',
			'.mc_card[data-failed=true]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent)}',
			'.mc_cardBody{display:flex;flex-direction:column;gap:6px;padding:12px 14px}',
			'.mc_cardTop{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}',
			'.mc_titleWrap{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}',
			'.mc_title{font-size:14px;font-weight:600;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.mc_trailing{display:inline-flex;align-items:center;gap:7px;flex:none;color:var(--dsw-alias-label-tertiary);flex-wrap:wrap;justify-content:flex-end}',
			'.mc_actions{display:inline-flex;align-items:center;gap:7px;flex:none}',
			'.mc_id{font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.mc_desc{margin:0;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:18px;overflow-wrap:anywhere}',
			'.mc_badge{display:inline-flex;align-items:center;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:1px 6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
			'.mc_badge[data-on=true]{color:var(--dsw-alias-state-business-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 40%,transparent)}',
			'.mc_badge[data-tone=warn]{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary))}',
			'.mc_dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary)}',
			'.mc_dot[data-tone=ok]{background:var(--dsw-alias-state-business-primary)}',
			'.mc_dot[data-tone=ongoing]{background:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-tertiary))}',
			'.mc_dot[data-tone=error]{background:var(--dsw-alias-state-error-primary)}',
			'.mc_phase{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',

			'.mc_note{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);padding:8px 10px;font-size:12.5px;line-height:18px;display:flex;flex-direction:column;gap:6px}',
			'.mc_note[data-tone=ok]{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 40%,transparent)}',
			'.mc_note[data-tone=warn]{border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,var(--dsw-alias-border-l3)) 55%,transparent)}',
			'.mc_note[data-tone=error]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);color:var(--dsw-alias-state-error-primary)}',
			'.mc_noteTitle{margin:0;font-size:12.5px;font-weight:600;line-height:18px}',
			'.mc_noteBody{margin:0;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:18px;overflow-wrap:anywhere}',
			'.mc_note[data-tone=error] .mc_noteBody{color:inherit}',
			'.mc_list{margin:0;padding-left:18px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;font-family:var(--ds-font-family-code)}',

			'.mc_switch{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
			'.mc_switch input{appearance:none;width:30px;height:18px;border-radius:9px;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1));position:relative;cursor:pointer;transition:background .14s var(--ds-ease-in-out,ease);margin:0}',
			'.mc_switch input:checked{background:var(--dsw-alias-state-business-primary);border-color:transparent}',
			'.mc_switch input:after{content:"";position:absolute;top:1.5px;left:1.5px;width:14px;height:14px;border-radius:50%;background:#fff;transition:transform .14s var(--ds-ease-in-out,ease)}',
			'.mc_switch input:checked:after{transform:translateX(12px)}',
			'.mc_switch input:disabled{opacity:.45;cursor:default}',
			'.mc_switch input:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',

			'.mc_confirm{border:.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);border-radius:var(--dsw-radius-lg);padding:10px 12px;display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-layer-1)}',
			'.mc_confirmRow{display:flex;gap:8px;flex-wrap:wrap}',
			'.mc_spin{display:inline-block;width:11px;height:11px;border:1.5px solid var(--dsw-alias-border-l4);border-top-color:var(--dsw-alias-label-secondary);border-radius:50%;animation:mc_spin .7s linear infinite}',
			'@keyframes mc_spin{to{transform:rotate(360deg)}}',
			'.mc_titleLine{display:flex;align-items:center;gap:6px;min-width:0}',
			'.mc_titleLine .mc_title{min-width:0}',
			'.mc_badge[data-official=true]{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 35%,transparent)}',
			'.mc_noteRow{display:flex;align-items:flex-start;gap:8px;border-top:.5px solid var(--dsw-alias-border-l2);padding-top:8px;margin-top:2px}',
			'.mc_noteText{flex:1;min-width:0;margin:0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
			'.mc_noteText[data-custom=true]{color:var(--dsw-alias-label-primary)}',
			'.mc_noteEmpty{color:var(--dsw-alias-label-tertiary);font-style:italic}',
			'.mc_noteTag{display:inline-block;margin-right:6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:0 4px;font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary);vertical-align:1px;font-style:normal}',
			'.mc_noteTag[data-builtin=true]{opacity:.7}',
			'.mc_noteEdit{display:flex;flex-direction:column;gap:8px;border-top:.5px solid var(--dsw-alias-border-l2);padding-top:8px;margin-top:2px}',
			'.mc_textarea{width:100%;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;line-height:18px;padding:8px 10px;resize:vertical;outline:none}',
			'.mc_textarea::placeholder{color:var(--dsw-alias-label-tertiary)}',
			'.mc_textarea:focus-visible{border-color:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary)) 18%,transparent)}',
			'.mc_noteActions{display:flex;gap:8px;flex-wrap:wrap}',
			'@media (prefers-reduced-motion:reduce){.mc_spin{animation-duration:2s}}'
		].join('');

		const STYLE_TAG_ID = 'dsh-market-console/market.css';

		/** 注入样式（幂等）。 */
		function ensureStyle() {
			if (typeof document === 'undefined') return;
			if (document.querySelector('style[data-plugin-css="' + STYLE_TAG_ID + '"]') !== null) return;
			const tag = document.createElement('style');
			tag.setAttribute('data-plugin-css', STYLE_TAG_ID);
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		// ════════════════════════════════════════════════════════════════
		// 5. 数据层 —— 全部走官方 pluginManager 远程接口
		// ════════════════════════════════════════════════════════════════

		/**
		 * 组装数据访问器。
		 *
		 * 注意：**惰性**读取 `ctx.remote.pluginManager`，不在创建时快照 —— 远程
		 * 命名空间可能晚于本插件就绪，提前取值会拿到 undefined。
		 */
		function createDataSource(ctx) {
			let operationPending = false;
			/** 取插件管理器远程面；不可用时给出可读错误。 */
			function pm() {
				const face = ctx.remote && ctx.remote.pluginManager;
				if (!face || typeof face.listPlugins !== 'function') {
					throw new Error('pluginManager remote face is unavailable');
				}
				return face;
			}

			return {
				beginOperation() {
					if (operationPending) return false;
					operationPending = true;
					return true;
				},
				endOperation() { operationPending = false; },
				/**
				 * 订阅 host 侧清单变更，返回释放函数。
				 *
				 * DSH 0.2.1 的插件管理器在每次写入后广播 `plugin-manager/changed`，官方
				 * 客户端页就是通过 `ctx.remote.$on` 监听它。这里只使用这个公开的远程事
				 * 件面：没有 `$on` 的宿主静默退化为手动刷新，绝不轮询。
				 */
				subscribeChanges(listener) {
					if (typeof listener !== 'function') return () => {};
					const disposers = [];
					const add = (register) => {
						try {
							const dispose = register();
							if (typeof dispose === 'function') disposers.push(dispose);
						} catch (error) {
							/* 事件面不可用：保持手动刷新 */
						}
					};
					const remoteFace = ctx.remote;
					if (remoteFace && typeof remoteFace.$on === 'function') {
						add(() => remoteFace.$on('plugin-manager/changed', () => listener()));
					}
					if (typeof ctx.on === 'function') {
						add(() => ctx.on('connection/reset', () => listener()));
					}
					return () => {
						for (const dispose of disposers.splice(0)) {
							try { dispose(); } catch (error) { /* 已释放 */ }
						}
					};
				},
				/** 插件条目数组。 */
				async listPlugins() {
					const value = unwrap(await pm().listPlugins());
					return Array.isArray(value) ? value : [];
				},
				/** 组合包数组。 */
				async listBundles() {
					const value = unwrap(await pm().listBundles());
					return Array.isArray(value) ? value : [];
				},
				/** 可用 registry 信息：{ registry, fallbackRegistries, resolved }。 */
				async registries() {
					try {
						return unwrap(await pm().registries());
					} catch (error) {
						return { registry: null, fallbackRegistries: [], resolved: null };
					}
				},
				/** 安装预检。 */
				async inspect(spec, options) {
					return unwrap(await pm().inspect(spec, options));
				},
				/** 发起安装。 */
				async installBundle(spec, options) {
					return unwrap(await pm().installBundle(spec, options));
				},
				/** 等待安装落定（返回 null 表示没有在途任务）。 */
				async waitForInstall(requestId, options) {
					return unwrap(await pm().waitForInstall(requestId, options));
				},
				/** 取消在途安装。 */
				async cancelInstall(requestId) {
					return unwrap(await pm().cancelInstall(requestId));
				},
				/** 单个插件条目启停。 */
				async setPluginEnabled(id, enabled) {
					return unwrap(await pm().setPluginEnabled(id, enabled));
				},
				/** 组合包启停。 */
				async setBundleEnabled(name, enabled) {
					return unwrap(await pm().setBundleEnabled(name, enabled));
				},
				/** 卸载组合包。 */
				async removeBundle(name) {
					return unwrap(await pm().removeBundle(name));
				}
			};
		}

		/**
		 * npm registry 搜索。
		 *
		 * 客户端直连：registry.npmjs.org 的 `/-/v1/search` 带
		 * `Access-Control-Allow-Origin: *`，因此不需要 Host 侧代理。
		 * 按 registry 顺序依次尝试，全部失败时抛出最后一次的错误。
		 */
		async function searchNpm(keyword, registries, signal) {
			const text = keyword.trim() === '' ? NPM_KEYWORD : NPM_KEYWORD + ' ' + keyword.trim();
			let lastError;
			for (const registry of registries) {
				const base = String(registry || '').replace(/\/+$/, '');
				if (base === '') continue;
				const url = base + '/-/v1/search?text=' + encodeURIComponent(text) + '&size=50';
				if (signal?.aborted) throw signal.reason || new Error('Search cancelled');
				const controller = new AbortController();
				const cancel = () => controller.abort(signal.reason);
				signal?.addEventListener('abort', cancel, { once: true });
				const timeout = setTimeout(() => controller.abort(new Error('Registry search timed out')), 12000);
				try {
					const response = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal });
					if (!response.ok) throw new Error('HTTP ' + response.status + ' @ ' + base);
					const payload = await response.json();
					const objects = Array.isArray(payload && payload.objects) ? payload.objects : [];
					return {
						registry: base,
						items: objects.map((object) => {
							const pkg = object.package || {};
							return {
								name: String(pkg.name || ''),
								version: String(pkg.version || ''),
								description: String(pkg.description || ''),
								date: pkg.date ? String(pkg.date) : '',
								keywords: Array.isArray(pkg.keywords) ? pkg.keywords : [],
								links: pkg.links || {},
								downloads: object.downloads && typeof object.downloads.monthly === 'number' ? object.downloads.monthly : null,
								registry: base
							};
						}).filter((item) => item.name !== '')
					};
				} catch (error) {
					if (signal?.aborted) throw signal.reason || error;
					lastError = error;
				} finally {
					clearTimeout(timeout);
					signal?.removeEventListener('abort', cancel);
				}
			}
			throw lastError || new Error('no usable registry');
		}

		// ════════════════════════════════════════════════════════════════
		// 6. 展示型小组件
		// ════════════════════════════════════════════════════════════════

		/** 状态点 + 文案。 */
		function Phase(props) {
			const { t, phase } = props;
			const info = phaseInfo(phase);
			return h('span', { className: 'mc_trailing' },
				h('span', { className: 'mc_dot', 'data-tone': info.tone, 'aria-hidden': 'true' }),
				h('span', { className: 'mc_phase' }, t(info.key))
			);
		}

		/** 只读徽章。 */
		function ReadonlyBadge(props) {
			const { t, reasonKey } = props;
			return h('span', { className: 'mc_badge', title: t(reasonKey) }, t('badgeReadonly'));
		}

		/** 官方徽章：标出 DSH 自带的插件，方便和第三方区分。 */
		function OfficialBadge(props) {
			return h('span', { className: 'mc_badge', 'data-official': 'true', title: props.t('officialTitle') }, props.t('badgeOfficial'));
		}

		/** 操作结果提示条（applied / restart-required / overridden / failed）。 */
		function ResultNote(props) {
			const { t, result, onDismiss } = props;
			if (!result) return null;

			if (result.kind === 'refused') {
				return h('div', { className: 'mc_note', 'data-tone': 'error' },
					h('p', { className: 'mc_noteTitle' }, t(result.problemKey)),
					result.reason ? h('p', { className: 'mc_noteBody' }, result.reason) : null,
					result.registries && result.registries.length > 0
						? h('p', { className: 'mc_noteBody' }, t('registryLabel') + ': ' + result.registries.filter(Boolean).join(', '))
						: null,
					onDismiss ? h('div', { className: 'mc_confirmRow' }, h('button', { className: 'mc_btn', 'data-tone': 'ghost', type: 'button', onClick: onDismiss }, t('dismiss'))) : null
				);
			}

			if (result.kind === 'needsApproval') {
				return h('div', { className: 'mc_note', 'data-tone': 'warn' },
					h('p', { className: 'mc_noteTitle' }, t('buildApprovalTitle')),
					h('p', { className: 'mc_noteBody' }, t('buildApprovalBody')),
					h('ul', { className: 'mc_list' }, result.pendingBuilds.map((name) => h('li', { key: name }, name))),
					h('div', { className: 'mc_confirmRow' },
						h('button', { className: 'mc_btn', 'data-tone': 'primary', type: 'button', onClick: result.onApprove }, t('buildApprovalYes')),
						h('button', { className: 'mc_btn', 'data-tone': 'ghost', type: 'button', onClick: onDismiss }, t('buildApprovalNo'))
					)
				);
			}

			const info = applicationInfo(result.application);
			const tone = info.tone === 'ok' ? 'ok' : info.tone === 'error' ? 'error' : 'warn';
			const message = result.application === 'failed' ? describeOperationFailure(result, t) : t(info.key);
			const restartReasonKey = result.restartReason === undefined
				? undefined
				: (RESTART_REASON_KEYS[result.restartReason] || 'restartReasonUnknown');

			return h('div', { className: 'mc_note', 'data-tone': tone },
				h('p', { className: 'mc_noteTitle' }, message),
				result.target ? h('p', { className: 'mc_noteBody' }, result.target) : null,
				result.application === 'restart-required'
					? h('div', null,
						h('p', { className: 'mc_noteBody' }, t('restartHint')),
						restartReasonKey ? h('p', { className: 'mc_noteBody' }, t('restartReasonLabel') + ': ' + t(restartReasonKey)) : null)
					: null,
				result.error && result.error.incompatible && result.error.incompatible.length > 0
					? h('div', null,
						h('p', { className: 'mc_noteBody' }, t('incompatibleBody')),
						h('ul', { className: 'mc_list' }, result.error.incompatible.map((item) =>
							h('li', { key: item.name }, item.name + '@' + item.version + ' ← dsh ' + item.runtimeVersion)))
					)
					: null,
				result.warnings && result.warnings.length > 0
					? h('div', null,
						h('p', { className: 'mc_noteBody' }, t('warnings')),
						h('ul', { className: 'mc_list' }, result.warnings.map((warning, index) => h('li', { key: index }, warning))))
					: null,
				result.packageResult && result.packageResult.version
					? h('p', { className: 'mc_noteBody' }, t('installedVersion') + ': ' + result.packageResult.version)
					: null,
				result.packageResult && result.packageResult.logPath
					? h('p', { className: 'mc_noteBody' }, t('logPath') + ': ' + result.packageResult.logPath)
					: null,
				onDismiss ? h('div', { className: 'mc_confirmRow' }, h('button', { className: 'mc_btn', 'data-tone': 'ghost', type: 'button', onClick: onDismiss }, t('dismiss'))) : null
			);
		}

		/** 行内二次确认。 */
		function ConfirmInline(props) {
			const { t, name, version, busy, onConfirm, onCancel } = props;
			return h('div', { className: 'mc_confirm' },
				h('p', { className: 'mc_noteTitle' }, format(t('confirmRemoveTitle'), { name })),
				h('p', { className: 'mc_noteBody' }, format(t('confirmRemoveBody'), { name, version: version ? ' @' + version : '' })),
				h('p', { className: 'mc_noteBody' }, t('confirmRemoveWarn')),
				h('div', { className: 'mc_confirmRow' },
					h('button', { className: 'mc_btn', 'data-tone': 'danger', type: 'button', disabled: busy, onClick: onConfirm },
						busy ? h('span', null, h('span', { className: 'mc_spin' }), ' ' + t('working')) : t('confirmRemoveYes')),
					h('button', { className: 'mc_btn', 'data-tone': 'ghost', type: 'button', disabled: busy, onClick: onCancel }, t('confirmRemoveNo'))
				)
			);
		}

		/**
		 * 插件备注块：显示、编辑、恢复内置说明。
		 *
		 * 显示优先级：**用户改过的备注 > 内置说明 > 提示添加**。
		 * 编辑结果落在 localStorage，随改随生效，不需要重启。
		 */
		function NoteBlock(props) {
			const { t, pkgName } = props;
			const [custom, setCustom] = useState(() => {
				const notes = readNotes();
				return Object.prototype.hasOwnProperty.call(notes, pkgName) ? notes[pkgName] : null;
			});
			const [editing, setEditing] = useState(false);
			const [draft, setDraft] = useState('');

			const builtin = BUILTIN_NOTES[pkgName] || '';
			const effective = custom !== null ? custom : builtin;
			const isCustom = custom !== null;

			if (editing) {
				return h('div', { className: 'mc_noteEdit' },
					h('textarea', {
						className: 'mc_textarea',
						value: draft,
						rows: 3,
						placeholder: t('notePlaceholder'),
						'aria-label': t('notePlaceholder'),
						onChange: (event) => setDraft(event.target.value)
					}),
					h('div', { className: 'mc_noteActions' },
						h('button', { className: 'mc_btn', 'data-tone': 'primary', type: 'button', onClick: () => { setCustom(writeNote(pkgName, draft)); setEditing(false); } }, t('noteSave')),
						h('button', { className: 'mc_btn', 'data-tone': 'ghost', type: 'button', onClick: () => setEditing(false) }, t('dismiss')),
						isCustom ? h('button', { className: 'mc_btn', 'data-tone': 'ghost', type: 'button', onClick: () => { writeNote(pkgName, ''); setCustom(null); setEditing(false); } }, t('noteReset')) : null
					)
				);
			}

			return h('div', { className: 'mc_noteRow' },
				effective !== ''
					? h('p', { className: 'mc_noteText', 'data-custom': isCustom ? 'true' : undefined },
						isCustom ? h('span', { className: 'mc_noteTag' }, t('noteCustom')) : h('span', { className: 'mc_noteTag', 'data-builtin': 'true' }, t('noteBuiltin')),
						effective)
					: h('p', { className: 'mc_noteText mc_noteEmpty' }, t('noteEmpty')),
				h('button', { className: 'mc_btn', 'data-tone': 'ghost', type: 'button', onClick: () => { setDraft(effective); setEditing(true); } }, t('noteEdit'))
			);
		}

		/** 已装插件条目卡片。 */
		function PluginCard(props) {
			const { entry, t, resolveText, busy, onToggle } = props;
			const reasonKey = pluginReadOnlyReason(entry);
			const readOnly = reasonKey !== null;
			const title = resolveText(entry.meta && entry.meta.title) || shortenModule(entry.moduleName || entry.entryId);
			const desc = resolveText(entry.meta && entry.meta.description) || '';

			return h('li', { className: 'mc_card', 'data-failed': entry.fiberPhase === 'failed' ? 'true' : undefined },
				h('div', { className: 'mc_cardBody' },
					h('div', { className: 'mc_cardTop' },
						h('div', { className: 'mc_titleWrap' },
							h('div', { className: 'mc_titleLine' },
								h('span', { className: 'mc_title', title }, title),
								isOfficialPackage(entry.moduleName) ? h(OfficialBadge, { t }) : null
							),
							h('span', { className: 'mc_id', title: String(entry.entryId || '') }, String(entry.moduleName || ''))
						),
						h('span', { className: 'mc_trailing' },
							readOnly ? h(ReadonlyBadge, { t, reasonKey }) : null,
							h(Phase, { t, phase: entry.fiberPhase }),
							h('label', { className: 'mc_switch', title: readOnly ? t(reasonKey) : undefined },
								h('input', {
									type: 'checkbox',
									checked: entry.enabled === true,
									disabled: readOnly || busy,
									onChange: (event) => onToggle(entry, event.target.checked)
								}),
								entry.enabled ? t('badgeEnabled') : t('badgeDisabled')
							)
						)
					),
					desc ? h('p', { className: 'mc_desc' }, desc) : null,
					h(NoteBlock, { t, pkgName: String(entry.moduleName || entry.entryId || '') }),
					entry.meta && entry.meta.error ? h('p', { className: 'mc_failure' }, String(entry.meta.error)) : null
				)
			);
		}

		/** 组合包卡片（启停 + 卸载）。 */
		function BundleCard(props) {
			const { item, t, resolveText, busy, onToggle, onRemove, confirming, onCancelRemove } = props;
			const reasonKey = bundleReadOnlyReason(item);
			const readOnly = reasonKey !== null;
			const title = resolveText(item.meta && item.meta.title) || shortenModule(item.name);
			const desc = resolveText(item.meta && item.meta.description) || resolveText(item.description) || '';

			return h('li', { className: 'mc_card' },
				h('div', { className: 'mc_cardBody' },
					h('div', { className: 'mc_cardTop' },
						h('div', { className: 'mc_titleWrap' },
							h('div', { className: 'mc_titleLine' },
								h('span', { className: 'mc_title', title }, title),
								isOfficialPackage(item.name) ? h(OfficialBadge, { t }) : null
							),
							h('span', { className: 'mc_id', title: String(item.name || '') }, String(item.name || '') + (item.version ? ' @' + item.version : ''))
						),
						h('span', { className: 'mc_trailing' },
							readOnly ? h(ReadonlyBadge, { t, reasonKey }) : null,
							item.installed === false ? h('span', { className: 'mc_badge' }, t('badgeReadonly')) : null,
							h('span', { className: 'mc_badge', 'data-on': item.enabled ? 'true' : undefined }, item.enabled ? t('badgeEnabled') : t('badgeDisabled')),
							h('span', { className: 'mc_actions' },
								h('label', { className: 'mc_switch', title: readOnly ? t(reasonKey) : undefined },
									h('input', {
										type: 'checkbox',
										checked: item.enabled === true,
										disabled: readOnly || busy,
										onChange: (event) => onToggle(item, event.target.checked)
									}),
									item.enabled ? t('badgeEnabled') : t('badgeDisabled')
								),
								readOnly ? null : h('button', {
									className: 'mc_btn',
									'data-tone': 'danger',
									type: 'button',
									disabled: busy,
									onClick: () => onRemove(item)
								}, t('remove'))
							)
						)
					),
					desc ? h('p', { className: 'mc_desc' }, desc) : null,
					item.error ? h('p', { className: 'mc_failure' }, String(item.error.diagnostic || item.error.code || '')) : null,
					h(NoteBlock, { t, pkgName: String(item.name || '') }),
					confirming ? h(ConfirmInline, {
						t,
						name: item.name,
						version: item.version,
						busy,
						onConfirm: () => onRemove(item, true),
						onCancel: onCancelRemove
					}) : null
				)
			);
		}

		/** 市场搜索结果卡片。 */
		function SearchCard(props) {
			const { item, t, installedNames, busySpec, onInstall, onCancel } = props;
			const installed = installedNames.has(item.name);
			const busy = busySpec !== null && busySpec !== undefined && busySpec === item.name;
			const homepage = item.links && (item.links.npm || item.links.homepage || item.links.repository);

			return h('li', { className: 'mc_card' },
				h('div', { className: 'mc_cardBody' },
					h('div', { className: 'mc_cardTop' },
						h('div', { className: 'mc_titleWrap' },
							h('div', { className: 'mc_titleLine' },
								h('span', { className: 'mc_title', title: item.name }, item.name),
								isOfficialPackage(item.name) ? h(OfficialBadge, { t }) : null
							),
							h('span', { className: 'mc_id' },
								t('versionLabel') + ' ' + (item.version || '?')
								+ (item.downloads !== null ? ' · ' + item.downloads.toLocaleString() + ' ' + t('downloads') : '')
							)
						),
						h('span', { className: 'mc_trailing' },
							h('span', { className: 'mc_badge' }, t('sourceNpm')),
							installed ? h('span', { className: 'mc_badge', 'data-on': 'true' }, t('installedBadge')) : null,
							installed
								? null
								: busy
									? h('span', { className: 'mc_actions' },
										h('span', { className: 'mc_phase' }, h('span', { className: 'mc_spin' }), ' ' + t('installing')),
										h('button', { className: 'mc_btn', 'data-tone': 'ghost', type: 'button', onClick: () => onCancel(item.name) }, t('cancel'))
									)
									: h('button', {
										className: 'mc_btn',
										'data-tone': 'primary',
										type: 'button',
										disabled: busySpec !== null && busySpec !== undefined,
										onClick: () => onInstall(item)
									}, t('install'))
						)
					),
					item.description ? h('p', { className: 'mc_desc' }, item.description) : null,
					homepage ? h('p', { className: 'mc_hint' }, h('a', {
						href: homepage,
						target: '_blank',
						rel: 'noreferrer noopener',
						style: { color: 'inherit' }
					}, homepage)) : null
				)
			);
		}

		// ════════════════════════════════════════════════════════════════
		// 7. 已安装视图
		// ════════════════════════════════════════════════════════════════

		function InstalledView(props) {
			const { t, data, inventory, reload, refreshing } = props;

			const [filter, setFilter] = useState('');
			const [busyKey, setBusyKey] = useState(null);
			const [confirming, setConfirming] = useState(null);
			const [note, setNote] = useState(null);
			// 偏好持久化：关掉官方插件是「看自己装了什么」的常用视角，不该每次重开都丢
			const [hideOfficial, setHideOfficial] = useState(() => readPrefs().hideOfficial === true);

			const toggleHideOfficial = useCallback((next) => {
				setHideOfficial(next);
				writePrefs({ hideOfficial: next });
			}, []);

			const plugins = inventory.plugins;
			const bundles = inventory.bundles;

			/**
			 * 自诊断：host 侧的 Loader 清单里应该有本插件自己的行。
			 * 找不到时说明挂载行丢了（profile patch 被覆盖），本页很可能是缓存。
			 */
			const selfEntry = useMemo(
				() => plugins.find((entry) => String(entry.moduleName || '') === SELF_PACKAGE || String(entry.entryId || '') === SELF_ENTRY_ID),
				[plugins]
			);

			const filteredPlugins = useMemo(() => {
				const q = filter.trim().toLowerCase();
				return plugins.filter((entry) => {
					if (hideOfficial && isOfficialPackage(String(entry.moduleName || ''))) return false;
					if (q === '') return true;
					const haystack = [entry.entryId, entry.moduleName]
						.map((value) => String(value || '').toLowerCase())
						.join(' ');
					return haystack.includes(q);
				});
			}, [plugins, filter, hideOfficial]);

			/**
			 * 0.2.1 的目录项（installed === false 且不可移除、未启用）不属于「已安装」；
			 * 只隐藏这类行，已安装 / 可移除 / 启用中的行原样保留。
			 */
			const visibleBundles = useMemo(
				() => bundles.filter((item) => !isCatalogOnlyBundle(item)),
				[bundles]
			);
			const catalogOnlyCount = bundles.length - visibleBundles.length;

			const filteredBundles = useMemo(
				() => (hideOfficial ? visibleBundles.filter((item) => !isOfficialPackage(String(item.name || ''))) : visibleBundles),
				[visibleBundles, hideOfficial]
			);

			/** 被「隐藏官方」挡掉的条数，用于给出可解释的空态。 */
			const hiddenCount = useMemo(() => {
				if (!hideOfficial) return 0;
				const pluginHits = plugins.filter((entry) => isOfficialPackage(String(entry.moduleName || ''))).length;
				const bundleHits = visibleBundles.filter((item) => isOfficialPackage(String(item.name || ''))).length;
				return pluginHits + bundleHits;
			}, [plugins, visibleBundles, hideOfficial]);

			/** 同步锁在 setState 生效之前挡住双击，也覆盖另一个常驻标签页。 */
			const runOperation = useCallback(async (key, operation) => {
				if (!data.beginOperation()) return;
				setBusyKey(key);
				setNote(null);
				try {
					const result = await operation();
					setNote({ kind: 'operation', ...result });
					if (result && result.application !== 'cancelled') await reload();
				} catch (error) {
					setNote({ kind: 'operation', application: 'failed', error: { code: 'operation-error', diagnostic: error && error.message ? error.message : String(error) } });
				} finally {
					data.endOperation();
					setBusyKey(null);
				}
			}, [data, reload]);

			const handlePluginToggle = useCallback((entry, enabled) => {
				runOperation('plugin:' + entry.entryId, () => data.setPluginEnabled(entry.entryId, enabled));
			}, [data, runOperation]);

			const handleBundleToggle = useCallback((item, enabled) => {
				runOperation('bundle:' + item.name, () => data.setBundleEnabled(item.name, enabled));
			}, [data, runOperation]);

			const handleBundleRemove = useCallback((item, confirmed) => {
				if (confirmed !== true) {
					setConfirming(item.name);
					setNote(null);
					return;
				}
				setConfirming(null);
				runOperation('remove:' + item.name, () => data.removeBundle(item.name));
			}, [data, runOperation]);

			return h('div', { className: 'mc_panel' },
				h('div', { className: 'mc_toolbar' },
					h('div', { className: 'mc_search' },
						h('input', {
							type: 'search',
							value: filter,
							placeholder: t('filterPlaceholder'),
							'aria-label': t('filterPlaceholder'),
							onChange: (event) => setFilter(event.target.value)
						})
					),
					h('button', {
						className: 'mc_btn',
						type: 'button',
						disabled: refreshing,
						onClick: () => reload()
					}, refreshing ? t('loading') : t('refresh')),
					h('label', { className: 'mc_switch', title: t('hideOfficialHint') },
						h('input', {
							type: 'checkbox',
							'data-role': 'hide-official',
							checked: hideOfficial,
							onChange: (event) => toggleHideOfficial(event.target.checked)
						}),
						t('hideOfficial')
					)
				),

				note ? h(ResultNote, { t, result: note, onDismiss: () => setNote(null) }) : null,

				plugins.length > 0 && selfEntry === undefined
					? h('div', { className: 'mc_note', 'data-tone': 'warn' },
						h('p', { className: 'mc_noteTitle' }, t('mountDiagTitle')),
						h('p', { className: 'mc_noteBody' }, t('mountDiagBody')))
					: null,

				hideOfficial && hiddenCount > 0
					? h('p', { className: 'mc_hint' }, format(t('hiddenOfficialCount'), { count: hiddenCount }))
					: null,

				catalogOnlyCount > 0
					? h('p', { className: 'mc_hint' }, format(t('catalogOnlyHidden'), { count: catalogOnlyCount }))
					: null,

				h('div', { className: 'mc_group' },
					h('div', { className: 'mc_groupHead' },
						h('h3', null, t('installedHeading')),
						h('span', { className: 'mc_count' }, String(filteredPlugins.length) + ' / ' + String(plugins.length))
					),
					filteredPlugins.length === 0
						? h('p', { className: 'mc_status' },
							filter.trim() !== ''
								? format(t('emptyFiltered'), { q: filter.trim() })
								: (hideOfficial && plugins.length > 0 ? t('allFilteredOut') : t('emptyInstalled')))
						: h('ul', { className: 'mc_cards' }, filteredPlugins.map((entry) => h(PluginCard, {
							key: 'p:' + String(entry.entryId || entry.moduleName),
							entry,
							t,
							resolveText: props.resolveText,
							busy: busyKey === 'plugin:' + entry.entryId,
							onToggle: handlePluginToggle
						})))
				),

				h('div', { className: 'mc_group' },
					h('div', { className: 'mc_groupHead' },
						h('h3', null, t('bundlesHeading')),
						h('span', { className: 'mc_count' }, String(filteredBundles.length) + (visibleBundles.length !== filteredBundles.length ? ' / ' + String(visibleBundles.length) : ''))
					),
					filteredBundles.length === 0
						? h('p', { className: 'mc_status' }, hideOfficial && visibleBundles.length > 0 ? t('allFilteredOut') : t('emptyInstalled'))
						: h('ul', { className: 'mc_cards' }, filteredBundles.map((item) => h(BundleCard, {
							key: 'b:' + String(item.name),
							item,
							t,
							resolveText: props.resolveText,
							busy: busyKey === 'bundle:' + item.name || busyKey === 'remove:' + item.name,
							onToggle: handleBundleToggle,
							onRemove: handleBundleRemove,
							confirming: confirming === item.name,
							onCancelRemove: () => setConfirming(null)
						})))
				)
			);
		}

		// ════════════════════════════════════════════════════════════════
		// 8. 发现视图（npm 搜索 + 安装）
		// ════════════════════════════════════════════════════════════════

		function DiscoverView(props) {
			const { t, data, inventory, reload, registries, active } = props;

			const [keyword, setKeyword] = useState('');
			const [registry, setRegistry] = useState(registries[0] || DEFAULT_REGISTRIES[0]);
			const [state, setState] = useState({ status: 'idle', items: [], error: null, usedRegistry: null });
			const [busySpec, setBusySpec] = useState(null);
			const [note, setNote] = useState(null);
			const [approval, setApproval] = useState(null);

			const requestIdRef = useRef(null);
			const cancelRequestedRef = useRef(false);

			/** 已安装的包名集合：搜索结果据此打「已安装」标记（目录项不算已安装）。 */
			const installedNames = useMemo(() => {
				const names = new Set();
				for (const item of inventory.bundles) if (item.name && !isCatalogOnlyBundle(item)) names.add(String(item.name));
				for (const entry of inventory.plugins) {
					const moduleName = String(entry.moduleName || '');
					if (moduleName !== '') names.add(moduleName);
				}
				return names;
			}, [inventory]);

			// 防抖搜索。两个视图为了保住搜索词都常驻渲染，所以必须用 active
			// 门控 —— 否则打开设置页的首屏就会白发一次 npm 请求。
			useEffect(() => {
				if (active !== true) return undefined;
				const trimmed = keyword.trim();
				let cancelled = false;
				const controller = new AbortController();
				const timer = window.setTimeout(async () => {
					setState((previous) => ({ ...previous, status: 'searching', error: null }));
					try {
						const outcome = await searchNpm(trimmed, [registry, ...DEFAULT_REGISTRIES.filter((r) => r !== registry)], controller.signal);
						if (cancelled) return;
						setState({ status: 'ready', items: outcome.items, error: null, usedRegistry: outcome.registry });
						if (outcome.registry !== registry) {
							// 兜底命中镜像：记下来，下次直接用它
							setRegistry(outcome.registry);
						}
					} catch (error) {
						if (cancelled) return;
						setState({ status: 'error', items: [], error: error && error.message ? error.message : String(error), usedRegistry: null });
					}
				}, SEARCH_DEBOUNCE_MS);
				return () => {
					cancelled = true;
					controller.abort();
					window.clearTimeout(timer);
				};
			}, [keyword, registry, active]);

			/** 安装主流程：inspect 预检 → installBundle → waitForInstall。 */
			const startInstall = useCallback(async (spec, options) => {
				if (!data.beginOperation()) return;
				const opts = options || {};
				cancelRequestedRef.current = false;
				setBusySpec(opts.label || spec);
				setNote(null);
				setApproval(null);
				try {
					// 1) 预检
					const inspected = await data.inspect(spec, { registry });
					if (cancelRequestedRef.current) {
						setNote({ kind: 'operation', application: 'cancelled' });
						return;
					}
					if (inspected && inspected.status === 'refused') {
						setNote({
							kind: 'refused',
							problemKey: PROBLEM_KEYS[inspected.problem] || 'problemUnknown',
							reason: inspected.reason,
							registries: inspected.registries
						});
						return;
					}
					if (inspected && inspected.bundle === false) {
						setNote({ kind: 'refused', problemKey: 'problemNotABundle', reason: inspected.description || '', registries: null });
						return;
					}

					// 2) 安装
					const requestId = makeRequestId('mkt');
					requestIdRef.current = requestId;
					const started = await data.installBundle(spec, {
						requestId,
						registry,
						approvedBuilds: opts.approvedBuilds
					});

					if (cancelRequestedRef.current) await data.cancelInstall(requestId);

					// 3) 等待落定（没有在途任务时返回 null）
					let settled = null;
					if (started && (started.changed === false || started.application === 'failed')) {
						settled = started;
					} else {
						// Losing the wait connection is not proof of installation success.
						settled = await data.waitForInstall(requestId);
					}
					const result = settled || started;

					// 4) 构建脚本待批准 → 走用户确认后带 approvedBuilds 重试
					const pending = result && result.packageResult && result.packageResult.pendingBuilds;
					if (result && result.application === 'failed' && Array.isArray(pending) && pending.length > 0) {
						setNote(null);
						setApproval({
							pendingBuilds: pending,
							retry: () => startInstall(spec, { approvedBuilds: pending, label: opts.label })
						});
						return;
					}

					setNote({ kind: 'operation', ...result });
					if (result && (result.application === 'applied' || result.application === 'restart-required')) {
						await reload();
					}
				} catch (error) {
					setNote({ kind: 'operation', application: 'failed', error: { code: 'operation-error', diagnostic: error && error.message ? error.message : String(error) } });
				} finally {
					requestIdRef.current = null;
					data.endOperation();
					setBusySpec(null);
				}
			}, [data, registry, reload]);

			/** 取消在途安装。 */
			const cancelInstall = useCallback(async () => {
				cancelRequestedRef.current = true;
				const requestId = requestIdRef.current;
				if (requestId === null) return; // Preflight will observe the cancellation.
				try {
					await data.cancelInstall(requestId);
					// The main flow owns the lock and reports the actual terminal result.
				} catch (error) {
					setNote({ kind: 'operation', application: 'failed', error: { code: 'operation-error', diagnostic: error && error.message ? error.message : String(error) } });
				}
			}, [data]);

			const items = useMemo(
				() => state.items.filter((item) => isSearchResultManageable(item.name)),
				[state.items]
			);

			return h('div', { className: 'mc_panel' },
				h('div', { className: 'mc_toolbar' },
					h('div', { className: 'mc_search' },
						h('input', {
							type: 'search',
							value: keyword,
							placeholder: t('discoverPlaceholder'),
							'aria-label': t('discoverPlaceholder'),
							onChange: (event) => setKeyword(event.target.value)
						})
					),
					h('select', {
						className: 'mc_input mc_registry',
						value: registry,
						'aria-label': t('registryLabel'),
						onChange: (event) => setRegistry(event.target.value),
						style: { width: 'auto' }
					}, [registry, ...DEFAULT_REGISTRIES.filter((item) => item !== registry)].map((item) =>
						h('option', { key: item, value: item }, item.replace(/^https?:\/\//, ''))))
				),
				h('p', { className: 'mc_hint' }, format(t('discoverHint'), { kw: NPM_KEYWORD })),

				note ? h(ResultNote, { t, result: note, onDismiss: () => setNote(null) }) : null,
				approval ? h(ResultNote, {
					t,
					result: { kind: 'needsApproval', pendingBuilds: approval.pendingBuilds, onApprove: approval.retry },
					onDismiss: () => setApproval(null)
				}) : null,

				state.status === 'searching' && items.length === 0
					? h('p', { className: 'mc_status' }, h('span', { className: 'mc_spin' }), ' ' + t('searching'))
					: null,

				state.status === 'error'
					? h('div', { className: 'mc_note', 'data-tone': 'error' },
						h('p', { className: 'mc_noteTitle' }, format(t('searchFailed'), { msg: state.error })),
						h('p', { className: 'mc_noteBody' }, format(t('searchEmptyHint'), { registry })))
					: null,

				state.status === 'ready' && items.length === 0
					? h('div', { className: 'mc_group' },
						h('p', { className: 'mc_status' }, t('searchEmpty')),
						h('p', { className: 'mc_hint' }, format(t('searchEmptyHint'), { registry })))
					: null,

				items.length > 0
					? h('ul', { className: 'mc_cards' }, items.map((item) => h(SearchCard, {
						key: item.name,
						item,
						t,
						installedNames,
						busySpec,
						onInstall: (target) => startInstall(
							// 版本可能缺失（registry 返回残缺 packument）。拼出 "pkg@" 是非法 spec，
							// 会被 inspect 直接判成 invalid-spec，所以缺版本时退回裸包名。
							target.version ? target.name + '@' + target.version : target.name,
							{ label: target.name }
						),
						onCancel: cancelInstall
					})))
					: null
			);
		}

		// ════════════════════════════════════════════════════════════════
		// 9. 主组件
		// ════════════════════════════════════════════════════════════════

		/**
		 * 插件市场页。
		 *
		 * 注意：`inject` 的返回值被**展开为 props** —— 所以这里直接解构
		 * `{ t, data, resolveText, registries }`，不要再套一层 `props.injected()`。
		 */
		function MarketConsoleTab(props) {
			const { t, data, resolveText, availableRegistries } = props;

			const [view, setView] = useState('installed');
			const [state, setState] = useState({ status: 'loading', plugins: [], bundles: [], error: null });
			const reloadRef = useRef(0);

			const reload = useCallback(async () => {
				const sequence = ++reloadRef.current;
				setState((previous) => ({ ...previous, status: 'loading', error: null }));
				try {
					const [plugins, bundles] = await Promise.all([data.listPlugins(), data.listBundles()]);
					if (sequence === reloadRef.current) setState({ status: 'ready', plugins, bundles, error: null });
				} catch (error) {
					if (sequence === reloadRef.current) setState((previous) => ({ ...previous, status: 'error', error: error && error.message ? error.message : String(error) }));
				}
			}, [data]);

			useEffect(() => { ensureStyle(); }, []);
			useEffect(() => { reload(); return () => { reloadRef.current++; }; }, [reload]);
			// DSH 0.2.1 在每次插件管理写入后广播 `plugin-manager/changed`：订阅它，
			// 让内置 Plugins 页或其他标签页的改动即时反映到本页。宿主未暴露该事件面
			// 时 subscribeChanges 返回空释放函数，保持原有的手动刷新，不引入轮询。
			useEffect(() => {
				const dispose = typeof data.subscribeChanges === 'function'
					? data.subscribeChanges(() => { void reload(); })
					: () => {};
				return () => { if (typeof dispose === 'function') dispose(); };
			}, [data, reload]);

			const inventory = useMemo(
				() => ({ plugins: state.plugins, bundles: state.bundles }),
				[state.plugins, state.bundles]
			);

			return h('div', { className: 'mc_root' },
				h('h2', null, t('title')),
				h('p', { className: 'mc_intro' }, t('intro')),

				h('div', { className: 'mc_tabs', role: 'tablist' },
					h('button', {
						className: 'mc_tab',
						type: 'button',
						role: 'tab',
						'data-active': view === 'installed' ? 'true' : undefined,
						'aria-selected': view === 'installed',
						onClick: () => setView('installed')
					}, t('viewInstalled')),
					h('button', {
						className: 'mc_tab',
						type: 'button',
						role: 'tab',
						'data-active': view === 'discover' ? 'true' : undefined,
						'aria-selected': view === 'discover',
						onClick: () => setView('discover')
					}, t('viewDiscover'))
				),

				state.status === 'error'
					? h('p', { className: 'mc_failure' },
						h('span', null, format(t('loadFailed'), { msg: state.error })),
						h('button', { className: 'mc_btn', 'data-tone': 'ghost', type: 'button', onClick: reload }, t('retry')))
					: null,

				// 两个视图各自保活：切 tab 不丢搜索词与结果
				h('div', { hidden: view !== 'installed' },
					h(InstalledView, {
						t,
						data,
						inventory,
						reload,
						refreshing: state.status === 'loading',
						resolveText
					})
				),
				h('div', { hidden: view !== 'discover' },
					h(DiscoverView, {
						t,
						data,
						inventory,
						reload,
						registries: availableRegistries,
						resolveText,
						active: view === 'discover'
					})
				)
			);
		}

		// ════════════════════════════════════════════════════════════════
		// 10. 插件注册
		// ════════════════════════════════════════════════════════════════

		/**
		 * 注册与新标签页所需的全部服务。
		 *
		 * `remote.pluginManager` 必须显式声明：官方 api-remotes 的客户端组合会在
		 * 构建期固定可用的 remote 命名空间，声明本项才能确保注入时它已经挂载。
		 */
		const inject = ['slots', 'locale', 'remote', 'remote.pluginManager', 'modules'];

		/** 把标签页贡献到「插件」设置分区（list slot，scope: root）。 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'market-console: dictionaries');
			const t = ctx.locale.bind(NS);

			const data = createDataSource(ctx);

			/** `meta.title` 可能是字面串，也可能是 {en,...} 映射。 */
			const resolveText = (text) => {
				if (text === undefined || text === null) return '';
				if (typeof text === 'string') return text;
				try {
					const resolved = ctx.locale.resolveText(text);
					if (typeof resolved === 'string') return resolved;
				} catch (error) {
					/* 落到下面的兜底 */
				}
				if (typeof text.zh === 'string') return text.zh;
				if (typeof text.en === 'string') return text.en;
				const first = Object.keys(text)[0];
				return first !== undefined && typeof text[first] === 'string' ? text[first] : '';
			};

			/** registry 候选：偏好 > 官方服务解析出的 > 内置兜底。 */
			const availableRegistries = (() => {
				const prefs = readPrefs();
				const list = [];
				if (typeof prefs.registry === 'string' && prefs.registry !== '') list.push(prefs.registry);
				for (const item of DEFAULT_REGISTRIES) if (!list.includes(item)) list.push(item);
				return list;
			})();

			// 异步补上官方解析出的 registry，不阻塞注册
			const registryProbe = data.registries().then((info) => {
				if (info && typeof info.resolved === 'string' && info.resolved !== '' && !availableRegistries.includes(info.resolved)) {
					availableRegistries.unshift(info.resolved);
				}
			}).catch(() => { /* 忽略：兜底列表够用 */ });
			void registryProbe;

			const injected = () => ({
				t,
				data,
				resolveText,
				availableRegistries
			});

			ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
				name: 'settings.plugins.tab',
				id: 'market',
				order: 20,
				label: () => t('tab'),
				locale: NS,
				inject: injected
			}, MarketConsoleTab));
		}

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		// 导出纯函数，便于离线单测 C4 过滤与枚举映射
		exports.pluginReadOnlyReason = pluginReadOnlyReason;
		exports.bundleReadOnlyReason = bundleReadOnlyReason;
		exports.phaseInfo = phaseInfo;
		exports.applicationInfo = applicationInfo;
		exports.PROBLEM_KEYS = PROBLEM_KEYS;
		exports.ERROR_CODE_KEYS = ERROR_CODE_KEYS;
		exports.RESTART_REASON_KEYS = RESTART_REASON_KEYS;
		exports.isOfficialPackage = isOfficialPackage;
		exports.isCatalogOnlyBundle = isCatalogOnlyBundle;
		exports.BUILTIN_NOTES = BUILTIN_NOTES;
		return module.exports;
	}
});
