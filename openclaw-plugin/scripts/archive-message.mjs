const action = process.argv[2] ?? 'run';

console.error('[ARCHIVED] openclaw-plugin is downstream-only reference material.');
console.error(
  `[ARCHIVED] Refusing to ${action}; this package is not publishable and does not produce dist/ artifacts.`,
);
console.error(
  '[ARCHIVED] Use the standalone Memphis runtime instead of the deprecated OpenClaw plugin scaffold.',
);

process.exit(1);
