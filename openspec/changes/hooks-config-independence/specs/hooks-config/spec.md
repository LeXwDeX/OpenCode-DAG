## ADDED Requirements

### Requirement: Hooks configuration uses dedicated hooks.json files

The system SHALL read hooks configuration exclusively from `hooks.json` files in OpenCode-owned directories. The system SHALL NOT read hooks from `.claude/` directories or from the `hooks` field of `settings.json`.

#### Scenario: Global hooks loaded from ~/.config/opencode/hooks.json
- **WHEN** a session starts and `~/.config/opencode/hooks.json` exists
- **THEN** the hooks defined therein are loaded as the global hooks layer

#### Scenario: Project hooks loaded from .opencode/hooks.json
- **WHEN** a session starts in a project directory and `.opencode/hooks.json` exists
- **THEN** the hooks defined therein are loaded as the project hooks layer
- **AND** project hooks are appended after global hooks (concat-append, matching existing `mergeSettings()` semantics — hooks accumulate, they do not replace)

#### Scenario: .claude/ settings.json is not read for hooks
- **WHEN** `~/.claude/settings.json` or `./.claude/settings.json` contains a `hooks` field
- **THEN** the system does NOT load those hooks
- **AND** no error or warning is emitted (silent ignore)

#### Scenario: settings.json hooks field is not read
- **WHEN** `.opencode/settings.json` contains a `hooks` field
- **THEN** the system does NOT load those hooks from settings.json
- **AND** hooks are only loaded from `hooks.json`

### Requirement: hooks.json format is top-level events

The `hooks.json` file SHALL use event names as top-level keys, without an outer `hooks` wrapper. Each event key maps to an array of `HookMatcher` objects (same schema as the current `HookMatcher` type).

#### Scenario: Valid hooks.json structure
- **WHEN** `hooks.json` contains `{"PreToolUse": [{"matcher": "Bash", "hooks": [...]}], "SessionStart": [...]}`
- **THEN** the system parses it correctly and registers the hooks

#### Scenario: hooks.json with outer wrapper is tolerated but not required
- **WHEN** `hooks.json` contains `{"hooks": {"PreToolUse": [...]}}`
- **THEN** the system detects the wrapper and extracts the inner object (graceful degradation for migrated configs)

### Requirement: Import command migrates Claude hooks via agent-guided QA

A slash command `/import-claude-hooks` SHALL be available as a global command. It is an agent-guided prompt (txt file, zero TypeScript code) that reads Claude Code hook configurations and migrates them to OpenCode's `hooks.json` format via interactive user review.

#### Scenario: Import discovers hooks from Claude configs
- **WHEN** the user runs `/import-claude-hooks`
- **THEN** the agent reads `~/.claude/settings.json`, `./.claude/settings.json`, and `./.claude/settings.local.json`
- **AND** the agent also reads existing `.opencode/settings.json` hooks field (old-format migration)
- **AND** the agent presents each discovered hook to the user for review

#### Scenario: User reviews each hook individually
- **WHEN** the agent presents a hook for review
- **THEN** the user can choose to import, skip, or edit the hook before import
- **AND** only user-approved hooks are written to `hooks.json`

#### Scenario: Global hooks imported to global hooks.json
- **WHEN** a hook from `~/.claude/settings.json` is approved for import
- **THEN** it is written to `~/.config/opencode/hooks.json`

#### Scenario: Project hooks imported to project hooks.json
- **WHEN** a hook from `./.claude/settings.json` is approved for import
- **THEN** it is written to `.opencode/hooks.json`

#### Scenario: Original Claude files are not modified
- **WHEN** the import command completes
- **THEN** the original `.claude/settings.json` files are unchanged
- **AND** the agent reports that the user can safely delete `.claude/` directories

#### Scenario: Idempotent re-run
- **WHEN** the user runs `/import-claude-hooks` again after a previous import
- **THEN** the agent detects hooks already present in `hooks.json` and skips or asks about duplicates

### Requirement: AGENTS.md managed section provides hook self-awareness

The import command SHALL update a managed section in `AGENTS.md` delimited by `<!-- Hooks_START -->` and `<!-- Hooks_END -->` markers. This section contains a summary table of active hooks, giving the agent self-awareness of its hook environment at session start.

#### Scenario: Managed section created if markers absent
- **WHEN** the import command runs and AGENTS.md has no `<!-- Hooks_START -->` marker
- **THEN** the agent appends the markers and summary table at the end of AGENTS.md

#### Scenario: Managed section updated if markers present
- **WHEN** the import command runs and AGENTS.md already has the markers
- **THEN** the agent replaces all content between the markers with the updated summary
- **AND** content outside the markers is preserved unchanged

#### Scenario: Summary table format
- **WHEN** the managed section is written
- **THEN** it contains a markdown table with columns: Event, Matcher, Type, Summary
- **AND** it includes a reference line pointing to the full config files
- **AND** it does NOT include full handler details (command paths, timeouts, prompts) — those are read on-demand from `hooks.json`

#### Scenario: Agent reads managed section at session start
- **WHEN** a session starts
- **THEN** the agent's system prompt includes the AGENTS.md content (including the managed hooks section)
- **AND** the agent is aware of what hooks exist without reading `hooks.json` directly

### Requirement: Hot-reload watches hooks.json files

The settings hot-reload watcher SHALL monitor `hooks.json` files in `~/.config/opencode/` and `.opencode/` directories. It SHALL NOT monitor `.claude/` directories.

#### Scenario: hooks.json change triggers reload
- **WHEN** `hooks.json` is modified in a watched directory
- **THEN** the hot-reload mechanism re-reads the hooks configuration
- **AND** subsequent hook triggers use the updated configuration

#### Scenario: .claude/ directory changes are ignored
- **WHEN** a file in `.claude/` changes
- **THEN** no reload is triggered
