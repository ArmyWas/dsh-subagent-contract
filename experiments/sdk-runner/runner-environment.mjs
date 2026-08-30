/** Build the only environment shape the public-endpoint experiment permits. */
export function publicDeepSeekEnvironment(scrubbedEnv, apiKey) {
  if (scrubbedEnv === null || typeof scrubbedEnv !== 'object' || Array.isArray(scrubbedEnv)) {
    throw new TypeError('scrubbedEnv must be an object')
  }
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new TypeError('apiKey must be a non-empty string')
  }
  const env = { ...scrubbedEnv }
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'DEEPSEEK_BASE_URL') delete env[key]
  }
  env.DEEPSEEK_API_KEY = apiKey
  env.DSH_TELEMETRY_DISABLED = '1'
  return env
}
