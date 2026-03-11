// Rollback Mechanism for Memphis-v5
// Enables atomic rollback to any previous state

import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';

export class RollbackManager {
  private snapshotDir: string;
  private chainPath: string;

  constructor(dataDir: string = './data') {
    this.snapshotDir = path.join(dataDir, 'snapshots');
    this.chainPath = path.join(dataDir, 'chains');
  }

  /**
   * Create atomic snapshot of current state
   */
  async createSnapshot(description?: string): Promise<string> {
    const timestamp = Date.now();
    const snapshotId = `snapshot-${timestamp}`;

    const snapshot: Snapshot = {
      id: snapshotId,
      timestamp,
      description: description || 'Manual snapshot',
      chains: await this.backupChains(),
      config: await this.backupConfig(),
      version: await this.getCurrentVersion(),
      checksum: '' // Will be computed below
    };

    // Compute checksum for integrity
    snapshot.checksum = this.computeChecksum(snapshot);

    // Save snapshot
    const snapshotPath = path.join(this.snapshotDir, `${snapshotId}.json`);
    await fs.mkdir(this.snapshotDir, { recursive: true });
    await fs.writeFile(snapshotPath, JSON.stringify(snapshot, null, 2));

    console.log(`✅ Snapshot created: ${snapshotId}`);
    return snapshotId;
  }

  /**
   * Rollback to specific snapshot
   */
  async rollback(snapshotId: string): Promise<RollbackResult> {
    const snapshotPath = path.join(this.snapshotDir, `${snapshotId}.json`);

    try {
      // Load snapshot
      const snapshotData = await fs.readFile(snapshotPath, 'utf-8');
      const snapshot: Snapshot = JSON.parse(snapshotData);

      // Verify integrity
      const checksum = this.computeChecksum(snapshot);
      if (checksum !== snapshot.checksum) {
        throw new Error('Snapshot checksum mismatch - possible corruption');
      }

      // Atomic rollback
      await this.atomicRestore(snapshot);

      console.log(`✅ Rolled back to: ${snapshotId}`);
      return {
        success: true,
        snapshotId,
        timestamp: new Date(snapshot.timestamp).toISOString()
      };
    } catch (error) {
      console.error(`❌ Rollback failed:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * List all available snapshots
   */
  async listSnapshots(): Promise<SnapshotMetadata[]> {
    await fs.mkdir(this.snapshotDir, { recursive: true });
    const files = await fs.readdir(this.snapshotDir);

    const snapshots: SnapshotMetadata[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      const snapshotData = await fs.readFile(
        path.join(this.snapshotDir, file),
        'utf-8'
      );
      const snapshot: Snapshot = JSON.parse(snapshotData);

      snapshots.push({
        id: snapshot.id,
        timestamp: snapshot.timestamp,
        description: snapshot.description,
        version: snapshot.version
      });
    }

    return snapshots.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Auto-rollback on critical error
   */
  async autoRollback(maxAge: number = 24 * 60 * 60 * 1000): Promise<boolean> {
    const snapshots = await this.listSnapshots();

    // Find most recent healthy snapshot
    const recentSnapshot = snapshots.find(s => {
      const age = Date.now() - s.timestamp;
      return age < maxAge;
    });

    if (recentSnapshot) {
      console.log(`🔄 Auto-rolling back to: ${recentSnapshot.id}`);
      await this.rollback(recentSnapshot.id);
      return true;
    }

    return false;
  }

  /**
   * Backup all chains
   */
  private async backupChains(): Promise<Record<string, ChainBackup>> {
    const chains: Record<string, ChainBackup> = {};

    try {
      const chainFiles = await fs.readdir(this.chainPath);

      for (const file of chainFiles) {
        if (!file.endsWith('.db')) continue;

        const chainName = file.replace('.db', '');
        const chainPath = path.join(this.chainPath, file);
        const data = await fs.readFile(chainPath);

        chains[chainName] = {
          data: data.toString('base64'),
          checksum: createHash('sha256').update(data).digest('hex')
        };
      }
    } catch {
      // Chain directory doesn't exist yet
    }

    return chains;
  }

  /**
   * Backup configuration
   */
  private async backupConfig(): Promise<ConfigBackup> {
    const configPath = './config.json';

    try {
      const data = await fs.readFile(configPath, 'utf-8');
      return {
        data,
        checksum: createHash('sha256').update(data).digest('hex')
      };
    } catch {
      return null;
    }
  }

  /**
   * Get current version
   */
  private async getCurrentVersion(): Promise<string> {
    const packagePath = './package.json';

    try {
      const data = await fs.readFile(packagePath, 'utf-8');
      const pkg = JSON.parse(data);
      return pkg.version || '0.0.0';
    } catch {
      return '0.0.0';
    }
  }

  /**
   * Atomic restore operation
   */
  private async atomicRestore(snapshot: Snapshot): Promise<void> {
    // 1. Create temporary backup of current state
    const tempBackup = await this.createSnapshot('Pre-rollback backup');

    try {
      // 2. Restore chains
      await fs.mkdir(this.chainPath, { recursive: true });

      for (const [chainName, backup] of Object.entries(snapshot.chains)) {
        const chainPath = path.join(this.chainPath, `${chainName}.db`);
        const data = Buffer.from(backup.data, 'base64');

        // Verify checksum
        const checksum = createHash('sha256').update(data).digest('hex');
        if (checksum !== backup.checksum) {
          throw new Error(`Chain ${chainName} checksum mismatch`);
        }

        await fs.writeFile(chainPath, data);
      }

      // 3. Restore config (if exists)
      if (snapshot.config) {
        const configData = Buffer.from(snapshot.config.data, 'utf-8');
        const checksum = createHash('sha256').update(configData).digest('hex');

        if (checksum !== snapshot.config.checksum) {
          throw new Error('Config checksum mismatch');
        }

        await fs.writeFile('./config.json', configData);
      }

      console.log('✅ Atomic restore complete');
    } catch (error) {
      // Rollback to pre-rollback state
      console.error('❌ Restore failed, rolling back to pre-rollback state');
      await this.rollback(tempBackup);
      throw error;
    }
  }

  /**
   * Compute checksum for snapshot integrity
   */
  private computeChecksum(snapshot: Omit<Snapshot, 'checksum'>): string {
    const data = JSON.stringify({
      chains: snapshot.chains,
      config: snapshot.config,
      version: snapshot.version,
      timestamp: snapshot.timestamp
    });

    return createHash('sha256').update(data).digest('hex');
  }
}

// Types
interface Snapshot {
  id: string;
  timestamp: number;
  description: string;
  chains: Record<string, ChainBackup>;
  config: ConfigBackup | null;
  version: string;
  checksum: string;
}

interface ChainBackup {
  data: string; // Base64-encoded
  checksum: string;
}

type ConfigBackup = {
  data: string;
  checksum: string;
} | null;

interface SnapshotMetadata {
  id: string;
  timestamp: number;
  description: string;
  version: string;
}

interface RollbackResult {
  success: boolean;
  snapshotId?: string;
  timestamp?: string;
  error?: string;
}
