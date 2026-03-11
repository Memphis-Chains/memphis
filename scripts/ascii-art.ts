// Memphis ASCII art logos
const LOGOS = {
  small: `
   △⬡◈
  MEMPHIS
  `,
  medium: `
    ███╗   ███╗██╗   ██╗
    ████╗ ████║██║   ██║
    ██╔████╔██║██║   ██║
    ██║╚██╔╝██║██║   ██║
    ██║ ╚═╝ ██║╚██████╔╝
    ╚═╝     ╚═╝ ╚═════╝
    △⬡◈ Memphis v5
  `,
  large: `
    ███████╗██╗   ██╗███████╗████████╗██████╗  ██████╗ ████████╗
    ██╔════╝██║   ██║██╔════╝╚══██╔══╝██╔══██╗██╔═══██╗╚══██╔══╝
    ███████╗██║   ██║███████╗   ██║   ██████╔╝██║   ██║   ██║
    ╚════██║██║   ██║╚════██║   ██║   ██╔══██╗██║   ██║   ██║
    ███████║╚██████╔╝███████║   ██║   ██║  ██║╚██████╔╝   ██║
    ╚══════╝ ╚═════╝ ╚══════╝   ╚═╝   ╚═╝  ╚═╝ ╚═════╝    ╚═╝
                    △⬡◈ Memphis v5 — "OpenClaw executes. Memphis remembers."
  `,
} as const;

export type LogoSize = keyof typeof LOGOS;

export function getLogo(size: LogoSize = 'medium'): string {
  return LOGOS[size];
}

export function banner(text: string): string {
  const line = '═'.repeat(text.length + 4);
  return `╔${line}╗\n║  ${text}  ║\n╚${line}╝`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const size = (process.argv[2] as LogoSize | undefined) ?? 'medium';
  const safeSize: LogoSize = size in LOGOS ? size : 'medium';
  process.stdout.write(`${banner('MEMPHIS CREATIVE MODE')}\n${getLogo(safeSize)}\n`);
}
