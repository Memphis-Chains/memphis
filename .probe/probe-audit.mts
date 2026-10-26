import { buildToolSchemaAuditReport } from '../src/gateway/tool-schema-audit.js';
const env = { ...process.env } as NodeJS.ProcessEnv;
const report = buildToolSchemaAuditReport(env);
console.log(JSON.stringify({
  ok: report.ok,
  checked: report.checked,
  missingExecutorSchema: report.missingExecutorSchema,
  missingMcpSchema: report.missingMcpSchema,
  missingRegistrySchema: report.missingRegistrySchema,
  mismatches: report.mismatches.length,
  requiredMismatches: report.requiredMismatches.length,
}, null, 2));
