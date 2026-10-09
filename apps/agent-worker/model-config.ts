import { Config, supportedProtocols, type Options } from '@deepseek-ai/dsh-llm-pi-ai'

/** Read the provider catalog and initial selection from the host environment. */
export function loadModelConfig(env: Record<string, string | undefined>) {
  function required(name: string): string {
    const value = env[name]?.trim()
    if (!value) throw new Error(`${name} must be set in .env`)
    return value
  }

  const provider = required('MODEL_PROVIDER')
  const model = required('MODEL_NAME')
  const source = required('MODEL_PROVIDERS')
  let raw: Options['providers']
  try {
    raw = JSON.parse(source)
  } catch {
    throw new Error('MODEL_PROVIDERS must contain valid JSON')
  }
  const providers = Config({ providers: raw }).providers.get()
  for (const [name, route] of Object.entries(providers)) {
    if (!supportedProtocols().includes(route.api)) {
      throw new Error(`Provider "${name}" must specify api: ${supportedProtocols().join(', ')}`)
    }
    if (!route.baseURL?.trim() || !route.apiKeyEnv?.trim() || !route.models?.length) {
      throw new Error(`Provider "${name}" must specify baseURL, apiKeyEnv and a non-empty models list`)
    }
  }
  if (!Object.hasOwn(providers, provider)) {
    throw new Error(`MODEL_PROVIDER "${provider}" is not configured in MODEL_PROVIDERS`)
  }
  const route = providers[provider]
  if (!route.models.some(entry => entry.id === model)) {
    throw new Error(`MODEL_NAME "${model}" is not configured for provider "${provider}"`)
  }
  required(route.apiKeyEnv)
  return { provider, model, providers }
}
