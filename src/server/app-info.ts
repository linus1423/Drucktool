// Version und Umgebung der laufenden Instanz. APP_VERSION und GIT_COMMIT setzt die CI beim Bauen des Images.

export type AppEnvironment = 'production' | 'staging' | 'development'

export type AppInfo = {
  version: string
  commit: string | null
  environment: AppEnvironment
}

export function getAppInfo(): AppInfo {
  const env = process.env.APP_ENVIRONMENT
  const environment: AppEnvironment =
    env === 'staging' || env === 'development' || env === 'production'
      ? env
      : process.env.NODE_ENV === 'production'
        ? 'production'
        : 'development'
  const commit = process.env.GIT_COMMIT?.trim()
  return {
    version: process.env.APP_VERSION?.trim() || 'dev',
    commit: commit && commit !== 'unknown' ? commit.slice(0, 12) : null,
    environment,
  }
}
