#!/usr/bin/env bun
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

import { $ } from "bun"
import path from "path"

import { createClient } from "@hey-api/openapi-ts"

const opencode = path.resolve(dir, "../../opencode")

await $`bun dev generate > ${dir}/openapi.json`.cwd(opencode)

await createClient({
  input: "./openapi.json",
  output: {
    path: "./src/v2/gen",
    tsConfigPath: path.join(dir, "tsconfig.json"),
    clean: true,
  },
  plugins: [
    {
      name: "@hey-api/typescript",
      exportFromIndex: false,
    },
    {
      name: "@hey-api/sdk",
      instance: "OpencodeClient",
      exportFromIndex: false,
      auth: false,
      paramsStructure: "flat",
    },
    {
      name: "@hey-api/client-fetch",
      exportFromIndex: false,
      baseUrl: "http://localhost:4096",
    },
  ],
})

// Patch a @hey-api/openapi-ts codegen bug: SseFn incorrectly passes the
// endpoint's TError into the second generic of ServerSentEventsResult, which
// is the AsyncGenerator's TReturn slot. Iterator return values have nothing
// to do with HTTP errors, and any consumer that calls `.return()` or returns
// from a mock generator gets type-checked against the wrong shape. Drop the
// arg so TReturn defaults to void.
const sseTypesPath = "./src/v2/gen/client/types.gen.ts"
const sseTypesFile = Bun.file(sseTypesPath)
const sseTypesSource = await sseTypesFile.text()
const sseTypesPatched = sseTypesSource.replace(
  "=> Promise<ServerSentEventsResult<TData, TError>>",
  "=> Promise<ServerSentEventsResult<TData>>",
)
if (sseTypesPatched === sseTypesSource) {
  throw new Error(`SseFn patch did not apply; @hey-api/openapi-ts output may have changed (${sseTypesPath})`)
}
await Bun.write(sseTypesPath, sseTypesPatched)

// Patch a generated mismatch: the DAG HTTP schema allows `completed_at: null`
// for pending/running nodes, but the generated v2 type drops that null arm.
// Keep the SDK type aligned with the runtime wire shape.
const dagTypesPath = "./src/v2/gen/types.gen.ts"
const dagTypesSource = await Bun.file(dagTypesPath).text()
const dagCompletedAt =
  "    completed_at: number | 'NaN' | 'Infinity' | '-Infinity' | 'Infinity' | '-Infinity' | 'NaN';"
const dagTypesPatched = dagTypesSource.replace(
  `${dagCompletedAt}\n    end_time: number | 'NaN' | 'Infinity' | '-Infinity' | 'Infinity' | '-Infinity' | 'NaN';\n    duration_ms: number | 'NaN' | 'Infinity' | '-Infinity' | 'Infinity' | '-Infinity' | 'NaN';\n    parent_node: string;`,
  `${dagCompletedAt.slice(0, -1)} | null;\n    end_time: number | 'NaN' | 'Infinity' | '-Infinity' | 'Infinity' | '-Infinity' | 'NaN';\n    duration_ms: number | 'NaN' | 'Infinity' | '-Infinity' | 'Infinity' | '-Infinity' | 'NaN';\n    parent_node: string;`,
)
if (dagTypesPatched === dagTypesSource) {
  throw new Error(`DagNode completed_at nullability patch did not apply; generated output may have changed (${dagTypesPath})`)
}
await Bun.write(dagTypesPath, dagTypesPatched)

await $`bun prettier --write src/gen`
await $`bun prettier --write src/v2`
await $`rm -rf dist`
await $`bun tsc`
await $`rm openapi.json`
