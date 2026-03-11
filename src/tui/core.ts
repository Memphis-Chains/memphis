export type TuiScreen = 'chat' | 'health' | 'embed' | 'vault' | 'dashboard';

export function normalizeScreen(value: string): TuiScreen | null {
  if (
    value === 'chat' ||
    value === 'health' ||
    value === 'embed' ||
    value === 'vault' ||
    value === 'dashboard'
  )
    return value;
  return null;
}

export function keybindToScreen(name?: string): TuiScreen | null {
  if (name === '1') return 'chat';
  if (name === '2') return 'health';
  if (name === '3') return 'embed';
  if (name === '4') return 'vault';
  if (name === '5') return 'dashboard';
  return null;
}
