import { Schema } from "effect"
import { PositiveInt } from "@opencode-ai/core/schema"
import DESCRIPTION from "./sandbox.txt"

export const LANGUAGES = ["python", "node", "ts", "bash", "go", "rust", "c", "cpp"] as const
export type Language = (typeof LANGUAGES)[number]

export const Parameters = Schema.Struct({
  sandbox_id: Schema.optional(Schema.String).annotate({
    description:
      "Omit to create a fresh sandbox. Provide the id returned by a previous call to reuse its persistent workspace (files, installed deps, build artifacts are kept).",
  }),
  language: Schema.Literals(LANGUAGES).annotate({
    description: "Primary language/runtime of this sandbox. Determines diagnostics and toolchain availability checks.",
  }),
  files: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description:
      "Files to write into the workspace before running, keyed by RELATIVE path (e.g. {\"main.go\":\"package main...\"}). Paths must stay inside the workspace. Existing files with the same path are overwritten.",
  }),
  command: Schema.String.annotate({
    description:
      "Shell command to run inside the workspace (cwd = workspace root). Compile and/or run your code here, e.g. `go run .`, `python main.py`, `cargo run`.",
  }),
  setup: Schema.optional(Schema.String).annotate({
    description:
      "One-time initialization command, run only on the first call for a sandbox before `command` (e.g. `python -m venv .venv && .venv/bin/pip install requests`, `npm init -y && npm i zod`, `go mod init scratch`). Skipped on subsequent reuse.",
  }),
  ephemeral: Schema.optional(Schema.Boolean).annotate({
    description:
      "When true, the workspace is deleted right after this call. Use for one-shot experiments. Default false (workspace is kept alive for reuse via sandbox_id).",
  }),
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "When true, run asynchronously and return immediately with the sandbox_id; poll completion with the sandbox_status tool. Use for long builds/runs. Default false.",
  }),
  timeout: Schema.optional(PositiveInt).annotate({
    description: "Optional timeout in milliseconds for `command` (and `setup`). Defaults to the shell default.",
  }),
  diagnostics: Schema.optional(Schema.Boolean).annotate({
    description:
      "When true (default), run LSP diagnostics on the written files and append a <lsp_diagnostics> block to the output. Set false to skip.",
  }),
})

export type Parameters = Schema.Schema.Type<typeof Parameters>

export const description = DESCRIPTION

export * as SandboxPrompt from "./prompt"
