import os from 'node:os';

function trimmed(value: string | undefined): string | undefined {
  const next = value?.trim();
  return next && next.length > 0 ? next : undefined;
}

function hostTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function hostLocale(rawEnv: NodeJS.ProcessEnv): string {
  const localeEnv =
    trimmed(rawEnv.LC_ALL) ?? trimmed(rawEnv.LC_MESSAGES) ?? trimmed(rawEnv.LANG);
  if (localeEnv) return localeEnv;
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || 'unknown';
  } catch {
    return 'unknown';
  }
}

export type RuntimeEnvironmentContext = {
  hostname: string;
  platform: string;
  arch: string;
  timezone: string;
  timezoneSource: 'config' | 'host';
  locale: string;
  localeSource: 'config' | 'host';
  deploymentName?: string;
  deploymentRegion?: string;
  weatherLocation?: string;
  weatherCountry?: string;
  weatherSearchLang?: string;
};

export function resolveRuntimeEnvironment(
  rawEnv: NodeJS.ProcessEnv = process.env,
): RuntimeEnvironmentContext {
  const configuredTimezone = trimmed(rawEnv.MEMPHIS_DEPLOYMENT_TIMEZONE);
  const configuredLocale = trimmed(rawEnv.MEMPHIS_DEPLOYMENT_LOCALE);
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    timezone: configuredTimezone ?? hostTimezone(),
    timezoneSource: configuredTimezone ? 'config' : 'host',
    locale: configuredLocale ?? hostLocale(rawEnv),
    localeSource: configuredLocale ? 'config' : 'host',
    deploymentName: trimmed(rawEnv.MEMPHIS_DEPLOYMENT_NAME),
    deploymentRegion: trimmed(rawEnv.MEMPHIS_DEPLOYMENT_REGION),
    weatherLocation: trimmed(rawEnv.MEMPHIS_WEATHER_LOCATION),
    weatherCountry: trimmed(rawEnv.MEMPHIS_WEATHER_COUNTRY),
    weatherSearchLang: trimmed(rawEnv.MEMPHIS_WEATHER_SEARCH_LANG),
  };
}
