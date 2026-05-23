export * as TuiKeybind from "./keybind"

import type { KeyEvent, Renderable } from "@opentui/core"
import type { Binding } from "@opentui/keymap"
import type { BindingCommandMap, BindingConfig, BindingDefaults } from "@opentui/keymap/extras"
import type { DeepMutable } from "@opencode-ai/core/schema"
import { Schema } from "effect"

const KeyStroke = Schema.Struct({
  name: Schema.String,
  ctrl: Schema.optional(Schema.Boolean),
  shift: Schema.optional(Schema.Boolean),
  meta: Schema.optional(Schema.Boolean),
  super: Schema.optional(Schema.Boolean),
  hyper: Schema.optional(Schema.Boolean),
})

const BindingObject = Schema.StructWithRest(
  Schema.Struct({
    key: Schema.Union([Schema.String, KeyStroke]),
    event: Schema.optional(Schema.Literals(["press", "release"])),
    preventDefault: Schema.optional(Schema.Boolean),
    fallthrough: Schema.optional(Schema.Boolean),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)

const BindingItem = Schema.Union([Schema.String, KeyStroke, BindingObject])
export const BindingValueSchema = Schema.Union([
  Schema.Literal(false),
  Schema.Literal("none"),
  BindingItem,
  Schema.Array(BindingItem),
])
export type BindingValueSchema = DeepMutable<Schema.Schema.Type<typeof BindingValueSchema>>

type Definition = {
  default: BindingValueSchema
  description: string
}

const inputUndoDefault = process.platform === "win32" ? "ctrl+z,ctrl+-,super+z" : "ctrl+-,super+z"
export const LeaderDefault = "ctrl+x"

const keybind = (value: Definition["default"], description: string): Definition => ({ default: value, description })

export const Definitions = {
  leader: keybind(LeaderDefault, "组合键前缀"),

  app_exit: keybind("ctrl+c,ctrl+d,<leader>q", "退出应用"),
  app_debug: keybind("none", "切换调试面板"),
  app_console: keybind("none", "切换控制台"),
  app_heap_snapshot: keybind("none", "写入堆快照"),
  app_toggle_animations: keybind("none", "切换动画"),
  app_toggle_file_context: keybind("none", "切换文件上下文"),
  app_toggle_diffwrap: keybind("none", "切换差异折叠"),
  app_toggle_paste_summary: keybind("none", "切换粘贴摘要"),
  app_toggle_session_directory_filter: keybind("none", "切换会话目录过滤"),
  command_list: keybind("ctrl+p", "列出可用命令"),
  help_show: keybind("none", "打开帮助"),
  docs_open: keybind("none", "打开文档"),
  diff_close: keybind("escape,q", "关闭差异查看器"),
  diff_toggle: keybind("enter,space", "切换差异项"),
  diff_expand: keybind("right", "展开差异项"),
  diff_expand_all: keybind("E", "展开所有差异文件夹"),
  diff_collapse: keybind("left", "折叠差异项"),
  diff_switch_focus: keybind("tab", "切换差异查看器焦点"),
  diff_next_file: keybind("n", "跳转到下一个差异文件"),
  diff_previous_file: keybind("p", "跳转到上一个差异文件"),
  diff_toggle_file_tree: keybind("b", "切换差异文件树"),
  diff_single_patch: keybind("s", "切换单补丁视图"),
  diff_switch_source: keybind("d", "切换差异来源"),
  diff_toggle_view: keybind("v", "切换分屏/统一视图"),
  diff_help: keybind("?", "显示更多差异快捷键"),

  editor_open: keybind("<leader>e", "打开外部编辑器"),
  theme_list: keybind("<leader>t", "列出可用主题"),
  theme_switch_mode: keybind("none", "切换亮/暗主题模式"),
  theme_mode_lock: keybind("none", "锁定/解锁主题模式"),
  sidebar_toggle: keybind("<leader>b", "切换侧边栏"),
  scrollbar_toggle: keybind("none", "切换滚动条"),
  status_view: keybind("<leader>s", "查看状态"),

  session_export: keybind("<leader>x", "导出会话到编辑器"),
  session_copy: keybind("none", "复制会话记录"),
  session_new: keybind("<leader>n", "新建会话"),
  session_list: keybind("<leader>l", "列出所有会话"),
  session_timeline: keybind("<leader>g", "显示会话时间线"),
  session_fork: keybind("none", "从消息分叉会话"),
  session_rename: keybind("ctrl+r", "重命名会话"),
  session_delete: keybind("ctrl+d", "删除会话"),
  session_share: keybind("none", "分享当前会话"),
  session_unshare: keybind("none", "取消分享会话"),
  session_interrupt: keybind("escape", "中断当前会话"),
  session_compact: keybind("<leader>c", "压缩会话"),
  session_toggle_timestamps: keybind("none", "切换时间戳"),
  session_toggle_generic_tool_output: keybind("none", "切换通用工具输出"),
  session_child_first: keybind("<leader>down", "跳转到首个子会话"),
  session_child_cycle: keybind("right", "跳转到下一个子会话"),
  session_child_cycle_reverse: keybind("left", "跳转到上一个子会话"),
  session_parent: keybind("up", "跳转到父会话"),
  session_pin_toggle: keybind("ctrl+f", "固定/取消固定会话"),
  session_quick_switch_1: keybind("<leader>1", "切换到快捷槽位 1"),
  session_quick_switch_2: keybind("<leader>2", "切换到快捷槽位 2"),
  session_quick_switch_3: keybind("<leader>3", "切换到快捷槽位 3"),
  session_quick_switch_4: keybind("<leader>4", "切换到快捷槽位 4"),
  session_quick_switch_5: keybind("<leader>5", "切换到快捷槽位 5"),
  session_quick_switch_6: keybind("<leader>6", "切换到快捷槽位 6"),
  session_quick_switch_7: keybind("<leader>7", "切换到快捷槽位 7"),
  session_quick_switch_8: keybind("<leader>8", "切换到快捷槽位 8"),
  session_quick_switch_9: keybind("<leader>9", "切换到快捷槽位 9"),

  stash_delete: keybind("ctrl+d", "删除暂存条目"),
  model_provider_list: keybind("ctrl+a", "打开提供商列表"),
  model_favorite_toggle: keybind("ctrl+f", "切换模型收藏"),
  model_list: keybind("<leader>m", "列出可用模型"),
  model_cycle_recent: keybind("f2", "下一个最近使用的模型"),
  model_cycle_recent_reverse: keybind("shift+f2", "上一个最近使用的模型"),
  model_cycle_favorite: keybind("none", "下一个收藏模型"),
  model_cycle_favorite_reverse: keybind("none", "上一个收藏模型"),
  mcp_list: keybind("none", "列出 MCP 服务器"),
  provider_connect: keybind("none", "连接提供商"),
  console_org_switch: keybind("none", "切换控制台组织"),
  agent_list: keybind("<leader>a", "列出代理"),
  agent_cycle: keybind("tab", "下一个代理"),
  agent_cycle_reverse: keybind("shift+tab", "上一个代理"),
  variant_cycle: keybind("ctrl+t", "循环切换模型变体"),
  variant_list: keybind("none", "列出模型变体"),

  messages_page_up: keybind("pageup,ctrl+alt+b", "向上翻页"),
  messages_page_down: keybind("pagedown,ctrl+alt+f", "向下翻页"),
  messages_line_up: keybind("ctrl+alt+y", "向上滚动一行"),
  messages_line_down: keybind("ctrl+alt+e", "向下滚动一行"),
  messages_half_page_up: keybind("ctrl+alt+u", "向上翻半页"),
  messages_half_page_down: keybind("ctrl+alt+d", "向下翻半页"),
  messages_first: keybind("ctrl+g,home", "跳转到首条消息"),
  messages_last: keybind("ctrl+alt+g,end", "跳转到末条消息"),
  messages_next: keybind("none", "跳转到下一条消息"),
  messages_previous: keybind("none", "跳转到上一条消息"),
  messages_last_user: keybind("none", "跳转到最后用户消息"),
  messages_copy: keybind("<leader>y", "复制消息"),
  messages_undo: keybind("<leader>u", "撤销消息"),
  messages_redo: keybind("<leader>r", "重做消息"),
  messages_toggle_conceal: keybind("<leader>h", "切换代码折叠"),
  tool_details: keybind("none", "切换工具详情"),
  display_thinking: keybind("none", "切换思考过程显示"),

  prompt_submit: keybind("none", "提交提示"),
  prompt_editor_context_clear: keybind("none", "清除编辑器上下文"),
  prompt_skills: keybind("none", "打开技能选择器"),
  prompt_stash: keybind("none", "暂存提示"),
  prompt_stash_pop: keybind("none", "恢复暂存提示"),
  prompt_stash_list: keybind("none", "列出暂存提示"),
  workspace_set: keybind("none", "设置工作区"),

  input_clear: keybind("ctrl+c", "清除输入"),
  input_paste: keybind({ key: "ctrl+v", preventDefault: false }, "粘贴"),
  input_submit: keybind("return", "提交输入"),
  input_newline: keybind("shift+return,ctrl+return,alt+return,ctrl+j", "插入换行"),
  input_move_left: keybind("left,ctrl+b", "光标左移"),
  input_move_right: keybind("right,ctrl+f", "光标右移"),
  input_move_up: keybind("up", "光标上移"),
  input_move_down: keybind("down", "光标下移"),
  input_select_left: keybind("shift+left", "向左选择"),
  input_select_right: keybind("shift+right", "向右选择"),
  input_select_up: keybind("shift+up", "向上选择"),
  input_select_down: keybind("shift+down", "向下选择"),
  input_line_home: keybind("ctrl+a", "移动到行首"),
  input_line_end: keybind("ctrl+e", "移动到行尾"),
  input_select_line_home: keybind("ctrl+shift+a", "选择到行首"),
  input_select_line_end: keybind("ctrl+shift+e", "选择到行尾"),
  input_visual_line_home: keybind("alt+a", "移动到视觉行首"),
  input_visual_line_end: keybind("alt+e", "移动到视觉行尾"),
  input_select_visual_line_home: keybind("alt+shift+a", "选择到视觉行首"),
  input_select_visual_line_end: keybind("alt+shift+e", "选择到视觉行尾"),
  input_buffer_home: keybind("home", "移动到缓冲区开头"),
  input_buffer_end: keybind("end", "移动到缓冲区末尾"),
  input_select_buffer_home: keybind("shift+home", "选择到缓冲区开头"),
  input_select_buffer_end: keybind("shift+end", "选择到缓冲区末尾"),
  input_delete_line: keybind("ctrl+shift+d", "删除当前行"),
  input_delete_to_line_end: keybind("ctrl+k", "删除到行尾"),
  input_delete_to_line_start: keybind("ctrl+u", "删除到行首"),
  input_backspace: keybind("backspace,shift+backspace", "退格"),
  input_delete: keybind("ctrl+d,delete,shift+delete", "删除字符"),
  input_undo: keybind(inputUndoDefault, "撤销"),
  input_redo: keybind("ctrl+.,super+shift+z", "重做"),
  input_word_forward: keybind("alt+f,alt+right,ctrl+right", "向后跳词"),
  input_word_backward: keybind("alt+b,alt+left,ctrl+left", "向前跳词"),
  input_select_word_forward: keybind("alt+shift+f,alt+shift+right", "向后选词"),
  input_select_word_backward: keybind("alt+shift+b,alt+shift+left", "向前选词"),
  input_delete_word_forward: keybind("alt+d,alt+delete,ctrl+delete", "向后删词"),
  input_delete_word_backward: keybind("ctrl+w,ctrl+backspace,alt+backspace", "向前删词"),
  input_select_all: keybind("super+a", "全选"),
  history_previous: keybind("up", "上一条历史"),
  history_next: keybind("down", "下一条历史"),

  "dialog.select.prev": keybind("up,ctrl+p", "上一项"),
  "dialog.select.next": keybind("down,ctrl+n", "下一项"),
  "dialog.select.page_up": keybind("pageup", "向上翻页"),
  "dialog.select.page_down": keybind("pagedown", "向下翻页"),
  "dialog.select.home": keybind("home", "跳转到首项"),
  "dialog.select.end": keybind("end", "跳转到末项"),
  "dialog.select.submit": keybind("return", "确认选择"),
  "dialog.prompt.submit": keybind("return", "确认输入"),
  "dialog.mcp.toggle": keybind("space", "切换 MCP"),
  "prompt.autocomplete.prev": keybind("up,ctrl+p", "上一个补全项"),
  "prompt.autocomplete.next": keybind("down,ctrl+n", "下一个补全项"),
  "prompt.autocomplete.hide": keybind("escape", "隐藏补全"),
  "prompt.autocomplete.select": keybind("return", "选择补全项"),
  "prompt.autocomplete.complete": keybind("tab", "补全当前项"),
  "permission.prompt.fullscreen": keybind("ctrl+f", "切换权限提示全屏"),
  "plugins.toggle": keybind("space", "切换插件"),
  "dialog.plugins.install": keybind("shift+i", "安装插件"),

  terminal_suspend: keybind("ctrl+z", "挂起终端"),
  terminal_title_toggle: keybind("none", "切换终端标题"),
  tips_toggle: keybind("<leader>h", "切换首页提示"),
  plugin_manager: keybind("none", "打开插件管理器"),
  plugin_install: keybind("none", "安装插件"),

  which_key_toggle: keybind("ctrl+alt+k", "切换快捷键面板"),
  which_key_layout_toggle: keybind("ctrl+alt+shift+k", "切换快捷键布局"),
  which_key_pending_toggle: keybind("ctrl+alt+shift+p", "切换待输入预览"),
  which_key_group_previous: keybind("ctrl+alt+left,ctrl+alt+[", "上一组快捷键"),
  which_key_group_next: keybind("ctrl+alt+right,ctrl+alt+]", "下一组快捷键"),
  which_key_scroll_up: keybind("ctrl+alt+up,ctrl+alt+p", "快捷键面板上滚"),
  which_key_scroll_down: keybind("ctrl+alt+down,ctrl+alt+n", "快捷键面板下滚"),
  which_key_page_up: keybind("ctrl+alt+pageup", "快捷键面板上翻页"),
  which_key_page_down: keybind("ctrl+alt+pagedown", "快捷键面板下翻页"),
  which_key_home: keybind("ctrl+alt+home", "跳转到首个快捷键"),
  which_key_end: keybind("ctrl+alt+end", "跳转到末个快捷键"),
} satisfies Record<string, Definition>

type KeybindName = keyof typeof Definitions
const KeybindNames = new Set<string>(Object.keys(Definitions))

export const KeybindOverrides = Schema.Struct(
  Object.fromEntries(
    Object.entries(Definitions).map(([name, item]) => [
      name,
      Schema.optional(BindingValueSchema).annotate({ description: item.description }),
    ]),
  ),
).annotate({ description: "TUI keybinding overrides" })
export const Descriptions = Object.fromEntries(
  Object.entries(Definitions).map(([name, item]) => [name, item.description]),
) as Record<KeybindName, string>
export const CommandMap = {
  app_exit: "app.exit",
  app_debug: "app.debug",
  app_console: "app.console",
  app_heap_snapshot: "app.heap_snapshot",
  app_toggle_animations: "app.toggle.animations",
  app_toggle_file_context: "app.toggle.file_context",
  app_toggle_diffwrap: "app.toggle.diffwrap",
  app_toggle_paste_summary: "app.toggle.paste_summary",
  app_toggle_session_directory_filter: "app.toggle.session_directory_filter",
  command_list: "command.palette.show",
  help_show: "help.show",
  docs_open: "docs.open",
  diff_close: "diff.close",
  diff_toggle: "diff.toggle",
  diff_expand: "diff.expand",
  diff_expand_all: "diff.expand_all",
  diff_collapse: "diff.collapse",
  diff_switch_focus: "diff.switch_focus",
  diff_next_file: "diff.next_file",
  diff_previous_file: "diff.previous_file",
  diff_toggle_file_tree: "diff.toggle_file_tree",
  diff_single_patch: "diff.single_patch",
  diff_switch_source: "diff.switch_source",
  diff_toggle_view: "diff.toggle_view",
  diff_help: "diff.help",
  editor_open: "prompt.editor",
  theme_list: "theme.switch",
  theme_switch_mode: "theme.switch_mode",
  theme_mode_lock: "theme.mode.lock",
  sidebar_toggle: "session.sidebar.toggle",
  scrollbar_toggle: "session.toggle.scrollbar",
  status_view: "opencode.status",
  session_export: "session.export",
  session_copy: "session.copy",
  session_new: "session.new",
  session_list: "session.list",
  session_timeline: "session.timeline",
  session_fork: "session.fork",
  session_rename: "session.rename",
  session_delete: "session.delete",
  session_share: "session.share",
  session_unshare: "session.unshare",
  session_interrupt: "session.interrupt",
  session_compact: "session.compact",
  session_toggle_timestamps: "session.toggle.timestamps",
  session_toggle_generic_tool_output: "session.toggle.generic_tool_output",
  session_child_first: "session.child.first",
  session_child_cycle: "session.child.next",
  session_child_cycle_reverse: "session.child.previous",
  session_parent: "session.parent",
  session_pin_toggle: "session.pin.toggle",
  session_quick_switch_1: "session.quick_switch.1",
  session_quick_switch_2: "session.quick_switch.2",
  session_quick_switch_3: "session.quick_switch.3",
  session_quick_switch_4: "session.quick_switch.4",
  session_quick_switch_5: "session.quick_switch.5",
  session_quick_switch_6: "session.quick_switch.6",
  session_quick_switch_7: "session.quick_switch.7",
  session_quick_switch_8: "session.quick_switch.8",
  session_quick_switch_9: "session.quick_switch.9",
  stash_delete: "stash.delete",
  model_provider_list: "model.dialog.provider",
  model_favorite_toggle: "model.dialog.favorite",
  model_list: "model.list",
  model_cycle_recent: "model.cycle_recent",
  model_cycle_recent_reverse: "model.cycle_recent_reverse",
  model_cycle_favorite: "model.cycle_favorite",
  model_cycle_favorite_reverse: "model.cycle_favorite_reverse",
  mcp_list: "mcp.list",
  provider_connect: "provider.connect",
  console_org_switch: "console.org.switch",
  agent_list: "agent.list",
  agent_cycle: "agent.cycle",
  agent_cycle_reverse: "agent.cycle.reverse",
  variant_cycle: "variant.cycle",
  variant_list: "variant.list",
  messages_page_up: "session.page.up",
  messages_page_down: "session.page.down",
  messages_line_up: "session.line.up",
  messages_line_down: "session.line.down",
  messages_half_page_up: "session.half.page.up",
  messages_half_page_down: "session.half.page.down",
  messages_first: "session.first",
  messages_last: "session.last",
  messages_next: "session.message.next",
  messages_previous: "session.message.previous",
  messages_last_user: "session.messages_last_user",
  messages_copy: "messages.copy",
  messages_undo: "session.undo",
  messages_redo: "session.redo",
  messages_toggle_conceal: "session.toggle.conceal",
  tool_details: "session.toggle.actions",
  display_thinking: "session.toggle.thinking",
  prompt_submit: "prompt.submit",
  prompt_editor_context_clear: "prompt.editor_context.clear",
  prompt_skills: "prompt.skills",
  prompt_stash: "prompt.stash",
  prompt_stash_pop: "prompt.stash.pop",
  prompt_stash_list: "prompt.stash.list",
  workspace_set: "workspace.set",
  input_clear: "prompt.clear",
  input_paste: "prompt.paste",
  input_submit: "input.submit",
  input_newline: "input.newline",
  input_move_left: "input.move.left",
  input_move_right: "input.move.right",
  input_move_up: "input.move.up",
  input_move_down: "input.move.down",
  input_select_left: "input.select.left",
  input_select_right: "input.select.right",
  input_select_up: "input.select.up",
  input_select_down: "input.select.down",
  input_line_home: "input.line.home",
  input_line_end: "input.line.end",
  input_select_line_home: "input.select.line.home",
  input_select_line_end: "input.select.line.end",
  input_visual_line_home: "input.visual.line.home",
  input_visual_line_end: "input.visual.line.end",
  input_select_visual_line_home: "input.select.visual.line.home",
  input_select_visual_line_end: "input.select.visual.line.end",
  input_buffer_home: "input.buffer.home",
  input_buffer_end: "input.buffer.end",
  input_select_buffer_home: "input.select.buffer.home",
  input_select_buffer_end: "input.select.buffer.end",
  input_delete_line: "input.delete.line",
  input_delete_to_line_end: "input.delete.to.line.end",
  input_delete_to_line_start: "input.delete.to.line.start",
  input_backspace: "input.backspace",
  input_delete: "input.delete",
  input_undo: "input.undo",
  input_redo: "input.redo",
  input_word_forward: "input.word.forward",
  input_word_backward: "input.word.backward",
  input_select_word_forward: "input.select.word.forward",
  input_select_word_backward: "input.select.word.backward",
  input_delete_word_forward: "input.delete.word.forward",
  input_delete_word_backward: "input.delete.word.backward",
  input_select_all: "input.select.all",
  history_previous: "prompt.history.previous",
  history_next: "prompt.history.next",
  terminal_suspend: "terminal.suspend",
  terminal_title_toggle: "terminal.title.toggle",
  tips_toggle: "tips.toggle",
  plugin_manager: "plugins.list",
  plugin_install: "plugins.install",
  which_key_toggle: "which-key.toggle",
  which_key_layout_toggle: "which-key.layout.toggle",
  which_key_pending_toggle: "which-key.pending.toggle",
  which_key_group_previous: "which-key.group.previous",
  which_key_group_next: "which-key.group.next",
  which_key_scroll_up: "which-key.scroll.up",
  which_key_scroll_down: "which-key.scroll.down",
  which_key_page_up: "which-key.page.up",
  which_key_page_down: "which-key.page.down",
  which_key_home: "which-key.home",
  which_key_end: "which-key.end",
} satisfies BindingCommandMap
const CommandDescriptions = Object.fromEntries(
  Object.entries(Definitions).map(([name, item]) => [
    CommandMap[name as keyof typeof CommandMap] ?? name,
    item.description,
  ]),
) as Record<string, string>

export type Keybinds = { [K in KeybindName]: BindingValueSchema }
export type KeybindOverrides = Partial<Keybinds>
export type BindingLookupView = {
  readonly bindings: readonly Binding<Renderable, KeyEvent>[]
  get(command: string): readonly Binding<Renderable, KeyEvent>[]
  has(command: string): boolean
  gather(name: string, commands: readonly string[]): readonly Binding<Renderable, KeyEvent>[]
  pick(name: string, commands: readonly string[]): Binding<Renderable, KeyEvent>[]
  omit(name: string, commands: readonly string[]): Binding<Renderable, KeyEvent>[]
}

export function toBindingConfig(keybinds: Keybinds): BindingConfig<Renderable, KeyEvent> {
  return Object.fromEntries(Object.entries(keybinds)) as BindingConfig<Renderable, KeyEvent>
}

const decodeBindingValue = Schema.decodeUnknownSync(BindingValueSchema)

export function defaultValue(name: KeybindName) {
  return Definitions[name].default
}

export function parse(keybinds: KeybindOverrides): Keybinds {
  const invalid = unknownKeys(keybinds)
  if (invalid.length) throw new Error(`Unrecognized keybind${invalid.length === 1 ? "" : "s"}: ${invalid.join(", ")}`)
  return Object.fromEntries(
    Object.entries(Definitions).map(([name, item]) => [
      name,
      decodeBindingValue(keybinds[name as KeybindName] ?? item.default),
    ]),
  ) as Keybinds
}

export const Keybinds = { parse }

export function unknownKeys(input: object) {
  return Object.keys(input).filter((key) => !KeybindNames.has(key))
}

export function bindingDefaults(): BindingDefaults<Renderable, KeyEvent> {
  return ({ command, binding }) => {
    if (binding.desc !== undefined) return
    return { desc: CommandDescriptions[command] }
  }
}
