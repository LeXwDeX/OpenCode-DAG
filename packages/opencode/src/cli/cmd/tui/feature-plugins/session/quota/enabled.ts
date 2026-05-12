// enabled.ts — quota 取数功能是否对当前 providerID 生效的纯判定。
// providerID 以 "github-copilot" 开头即视为启用（包括 github-copilot-custom 等子变体）。
export function isCopilotMode(providerID: string): boolean {
  return providerID.startsWith("github-copilot")
}
