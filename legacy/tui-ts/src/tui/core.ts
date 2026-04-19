export type TuiScreen = 'overview' | 'chat' | 'memory' | 'sessions' | 'vault' | 'cases' | 'system';

export function normalizeScreen(value: string): TuiScreen | null {
  const normalized = value.trim().toLowerCase();
  const aliases: Record<string, TuiScreen> = {
    overview: 'overview',
    dashboard: 'overview',
    chat: 'chat',
    memory: 'memory',
    embed: 'memory',
    sessions: 'sessions',
    session: 'sessions',
    vault: 'vault',
    cases: 'cases',
    case: 'cases',
    decisions: 'cases',
    system: 'system',
    health: 'system',
  };
  if (normalized in aliases) return aliases[normalized]!;
  return null;
}

export function keybindToScreen(name?: string): TuiScreen | null {
  if (name === '1') return 'overview';
  if (name === '2') return 'chat';
  if (name === '3') return 'memory';
  if (name === '4') return 'sessions';
  if (name === '5') return 'vault';
  if (name === '6') return 'cases';
  if (name === '7') return 'system';
  return null;
}
