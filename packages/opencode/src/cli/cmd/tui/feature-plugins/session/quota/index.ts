// quota/index.ts — 聚合导出 + 默认导出 SessionQuota 插件模块。
// internal.ts 仍然按 default import 使用 SessionQuota 模块对象。
import plugin, { QuotaView } from "./view"

export { QuotaView }
export * from "./enabled"
export * from "./endpoint"
export * from "./fetch"
export default plugin
