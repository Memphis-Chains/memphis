import { BOLD, FG_COPPER_BRIGHT, FG_STEEL, RESET } from '../theme.js';

export function renderQuickActions(): string[] {
  return [
    `${FG_COPPER_BRIGHT}${BOLD}J${RESET}${FG_STEEL}ournal${RESET}  ${FG_COPPER_BRIGHT}${BOLD}A${RESET}${FG_STEEL}sk${RESET}  ${FG_COPPER_BRIGHT}${BOLD}R${RESET}${FG_STEEL}ecall${RESET}  ${FG_COPPER_BRIGHT}${BOLD}Q${RESET}${FG_STEEL}uit${RESET}`,
  ];
}
