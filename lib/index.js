/**
 * dsh-market-console —— Host 半边（M1 只读阶段）。
 *
 * 本阶段刻意保持为空：M1 只验证「模块加载 + 插槽注册 + profile 挂载」三个环节，
 * 所有数据都通过客户端半边的 `ctx.remote.pluginManager` / `ctx.remote.pluginInventory`
 * 直接读取官方服务，无需 Host 侧参与。
 *
 * 这个空 `apply` 的作用是让本包在 Loader 里占一条实例行，客户端模块系统据此
 * 把 `./client` 导出送进浏览器 —— 与官方 ui-settings-plugin-inventory 的做法一致。
 *
 * 后续里程碑（M2/M3）如需要代理第三方数据源或做缓存，再往这里加：
 *   - 注册自建 HTTP 路由（ctx.webServer.route）代理市场搜索 API
 *   - 缓存层与限流
 */

/** Host plugin body — M1 阶段无 Host 侧行为。 */
function apply() {}

export { apply };
