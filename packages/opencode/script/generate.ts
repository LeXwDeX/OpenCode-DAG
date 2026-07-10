import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const modelsUrl = process.env.OPENCODE_MODELS_URL || "https://models.dev"

async function loadModelsData() {
  if (process.env.MODELS_DEV_API_JSON) {
    console.log("Loaded models.dev snapshot from MODELS_DEV_API_JSON")
    return Bun.file(process.env.MODELS_DEV_API_JSON).text()
  }

  const response = await fetch(`${modelsUrl}/api.json`).catch(() => undefined)
  if (response?.ok) {
    console.log("Loaded models.dev snapshot from api.json")
    return response.text()
  }

  const snapshotSpecifier = "@opencode-ai/models/snapshot"
  const snapshot = await import(snapshotSpecifier).catch(() => undefined)
  if (snapshot) {
    console.log("Loaded models.dev snapshot from @opencode-ai/models")
    return JSON.stringify(snapshot.providers)
  }

  console.log("Loaded no models.dev snapshot")
  return "undefined"
}

export const modelsData = await loadModelsData()
