import type Database from 'better-sqlite3';

export type ToolPolicy = 'allow' | 'deny' | 'require-approval';

export interface ToolPermission {
  tool_name: string;
  policy: ToolPolicy;
  updated_at: string;
}

export class SqliteToolPermissionRepository {
  constructor(private db: Database.Database) {}

  list(): ToolPermission[] {
    return this.db
      .prepare('SELECT tool_name, policy, updated_at FROM tool_permissions ORDER BY tool_name')
      .all() as ToolPermission[];
  }

  get(toolName: string): ToolPermission | null {
    const row = this.db
      .prepare('SELECT tool_name, policy, updated_at FROM tool_permissions WHERE tool_name = ?')
      .get(toolName) as ToolPermission | undefined;
    return row ?? null;
  }

  set(toolName: string, policy: ToolPolicy): ToolPermission {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO tool_permissions (tool_name, policy, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(tool_name) DO UPDATE SET policy = excluded.policy, updated_at = excluded.updated_at`,
      )
      .run(toolName, policy, now);
    return { tool_name: toolName, policy, updated_at: now };
  }

  delete(toolName: string): boolean {
    const result = this.db
      .prepare('DELETE FROM tool_permissions WHERE tool_name = ?')
      .run(toolName);
    return result.changes > 0;
  }

  reset(): number {
    const result = this.db.prepare('DELETE FROM tool_permissions').run();
    return result.changes;
  }

  /**
   * Check if a tool is allowed to execute.
   * Tools without explicit permissions default to 'allow'.
   */
  isAllowed(toolName: string): { allowed: boolean; policy: ToolPolicy; reason?: string } {
    const perm = this.get(toolName);
    if (!perm) return { allowed: true, policy: 'allow' };

    switch (perm.policy) {
      case 'allow':
        return { allowed: true, policy: 'allow' };
      case 'deny':
        return { allowed: false, policy: 'deny', reason: `tool '${toolName}' is denied by policy` };
      case 'require-approval':
        return { allowed: false, policy: 'require-approval', reason: `tool '${toolName}' requires approval` };
      default:
        return { allowed: false, policy: 'deny', reason: 'unknown policy' };
    }
  }

  /**
   * Filter a list of tool names to only those that are allowed.
   */
  filterAllowed(toolNames: string[]): string[] {
    return toolNames.filter((name) => this.isAllowed(name).allowed);
  }
}
