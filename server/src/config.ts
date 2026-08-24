export interface Config {
  port: number
  publicUrl: string
  dataDir: string
  adminUsername?: string
  adminPassword?: string
}

function env(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() !== '' ? v.trim() : undefined
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const cfg: Config = {
    port: Number(env('PORT') ?? 8080),
    publicUrl: env('PUBLIC_URL') ?? `http://localhost:${Number(env('PORT') ?? 8080)}`,
    dataDir: env('DATA_DIR') ?? './data',
    adminUsername: env('ADMIN_USERNAME'),
    adminPassword: env('ADMIN_PASSWORD'),
    ...overrides,
  }
  return cfg
}
