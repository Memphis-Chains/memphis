import { describe, expect, it } from 'vitest';

import {
  evaluateSurfacePolicyRisk,
  isToolAllowedForSurface,
  listSurfacePolicyOverrides,
  normalizeSurfacePolicySettingName,
  parseSurfacePolicySettingValue,
  resolveSurfacePolicy,
} from '../../src/gateway/surface-policy.js';

describe('surface policy', () => {
  it('treats cli chat as operator and telegram as full-tier companion chat by default', () => {
    const cliPolicy = resolveSurfacePolicy('cli.chat', {} as NodeJS.ProcessEnv);
    const tuiPolicy = resolveSurfacePolicy('tui', {} as NodeJS.ProcessEnv);
    const tuiLocalPolicy = resolveSurfacePolicy('tui.local', {} as NodeJS.ProcessEnv);
    const telegramPolicy = resolveSurfacePolicy('telegram', {} as NodeJS.ProcessEnv);

    expect(cliPolicy.surfaceClass).toBe('operator');
    expect(cliPolicy.maxToolTier).toBe(2);
    expect(cliPolicy.allowUrlFetch).toBe(true);
    expect(cliPolicy.allowUnknownTools).toBe(true);

    expect(tuiPolicy.surfaceClass).toBe('operator');
    expect(tuiPolicy.maxToolTier).toBe(2);
    expect(tuiPolicy.allowUnknownTools).toBe(true);
    expect(tuiLocalPolicy.surfaceClass).toBe('operator');

    expect(telegramPolicy.surfaceClass).toBe('chat');
    expect(telegramPolicy.maxToolTier).toBe(2);
    expect(telegramPolicy.allowUrlFetch).toBe(true);
    expect(telegramPolicy.allowUnknownTools).toBe(false);
  });

  it('honors surface-specific env overrides for tiered chat capabilities', () => {
    const telegramPolicy = resolveSurfacePolicy('telegram', {
      MEMPHIS_SURFACE_TELEGRAM_MAX_TOOL_TIER: '1',
      MEMPHIS_SURFACE_TELEGRAM_ALLOW_URL_FETCH: 'true',
      MEMPHIS_SURFACE_TELEGRAM_ALLOW_UNKNOWN_TOOLS: 'true',
    } as NodeJS.ProcessEnv);

    expect(telegramPolicy.maxToolTier).toBe(1);
    expect(telegramPolicy.allowUrlFetch).toBe(true);
    expect(telegramPolicy.allowUnknownTools).toBe(true);
  });

  it('fails closed for unknown tools on chat surfaces', () => {
    const telegramPolicy = resolveSurfacePolicy('telegram', {} as NodeJS.ProcessEnv);
    const cliPolicy = resolveSurfacePolicy('cli.chat', {} as NodeJS.ProcessEnv);

    expect(isToolAllowedForSurface('custom_tool', telegramPolicy)).toBe(false);
    expect(isToolAllowedForSurface('custom_tool', cliPolicy)).toBe(true);
  });

  it('lists explicit overrides and normalizes configurable setting names', () => {
    const rawEnv = {
      MEMPHIS_SURFACE_TELEGRAM_MAX_TOOL_TIER: '1',
      MEMPHIS_SURFACE_TELEGRAM_ALLOW_URL_FETCH: 'true',
    } as NodeJS.ProcessEnv;

    expect(listSurfacePolicyOverrides('telegram', rawEnv)).toEqual([
      expect.objectContaining({ setting: 'maxToolTier', rawValue: '1' }),
      expect.objectContaining({ setting: 'allowUrlFetch', rawValue: 'true' }),
    ]);
    expect(normalizeSurfacePolicySettingName('max-tool-tier')).toBe('maxToolTier');
    expect(normalizeSurfacePolicySettingName('allow_url_fetch')).toBe('allowUrlFetch');
    expect(parseSurfacePolicySettingValue('allowUrlFetch', 'yes')).toBe('true');
    expect(parseSurfacePolicySettingValue('maxToolTier', '2')).toBe('2');
  });

  it('surfaces DEFAULT_CONSENT in override list and accepts consent aliases', () => {
    const rawEnv = {
      MEMPHIS_SURFACE_TELEGRAM_DEFAULT_CONSENT: 'exportable',
    } as NodeJS.ProcessEnv;
    expect(listSurfacePolicyOverrides('telegram', rawEnv)).toEqual([
      expect.objectContaining({ setting: 'defaultConsent', rawValue: 'exportable' }),
    ]);
    expect(normalizeSurfacePolicySettingName('default-consent')).toBe('defaultConsent');
    expect(normalizeSurfacePolicySettingName('consent')).toBe('defaultConsent');
    expect(parseSurfacePolicySettingValue('defaultConsent', 'local-only')).toBe('local-only');
  });

  it('treats telegram default full-tier mode as canonical but still flags risky overrides', () => {
    const telegramDefault = resolveSurfacePolicy('telegram', {} as NodeJS.ProcessEnv);
    const telegramWarn = resolveSurfacePolicy('telegram', {
      MEMPHIS_SURFACE_TELEGRAM_MAX_TOOL_TIER: '1',
    } as NodeJS.ProcessEnv);
    const telegramFail = resolveSurfacePolicy('telegram', {
      MEMPHIS_SURFACE_TELEGRAM_ALLOW_UNKNOWN_TOOLS: 'true',
      MEMPHIS_SURFACE_TELEGRAM_MAX_TOOL_TIER: '2',
    } as NodeJS.ProcessEnv);

    expect(evaluateSurfacePolicyRisk(telegramDefault)).toMatchObject({
      level: 'pass',
      issues: [],
    });
    expect(evaluateSurfacePolicyRisk(telegramWarn)).toMatchObject({
      level: 'warn',
      issues: expect.arrayContaining(['max tool tier elevated to 1']),
    });
    expect(evaluateSurfacePolicyRisk(telegramFail)).toMatchObject({
      level: 'fail',
      issues: expect.arrayContaining([
        'unknown tools allowed on chat surface',
        'max tool tier elevated to 2',
      ]),
    });
  });
});
