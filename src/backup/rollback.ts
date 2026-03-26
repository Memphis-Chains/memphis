import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { getAppVersion, getDataDir } from '../config/paths.js';
import { createBackup, restoreBackup, verifyBackup } from '../infra/cli/commands/backup.js';
import { createLogger } from '../infra/logging/logger.js';

const logger = createLogger('info', 'text', { component: 'RollbackManager' });

const SNAPSHOT_LAYOUT = 'memphis-root-v2';
const SOURCE_OF_TRUTH_PATHS = ['config', 'chains', 'vault'] as const;
const DERIVED_PATHS = ['case-index.sqlite', 'embeddings'] as const;

export interface SnapshotMetadata {
  id: string;
  timestamp: number;
  description: string;
  version: string;
}

export interface RollbackResult {
  success: boolean;
  snapshotId?: string;
  timestamp?: string;
  error?: string;
}

interface SnapshotRecord extends SnapshotMetadata {
  archiveFile: string;
  archiveChecksum: string;
  dataDir: string;
  layout: typeof SNAPSHOT_LAYOUT;
  sourceOfTruthPaths: readonly string[];
  derivedPaths: readonly string[];
  checksum: string;
}

function snapshotMetadataChecksum(snapshot: Omit<SnapshotRecord, 'checksum'>): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: snapshot.id,
        timestamp: snapshot.timestamp,
        description: snapshot.description,
        version: snapshot.version,
        archiveFile: snapshot.archiveFile,
        archiveChecksum: snapshot.archiveChecksum,
        dataDir: snapshot.dataDir,
        layout: snapshot.layout,
        sourceOfTruthPaths: snapshot.sourceOfTruthPaths,
        derivedPaths: snapshot.derivedPaths,
      }),
    )
    .digest('hex');
}

export class RollbackManager {
  private readonly dataDir: string;
  private readonly snapshotDir: string;

  constructor(dataDir: string = getDataDir()) {
    this.dataDir = path.resolve(dataDir);
    this.snapshotDir = path.join(this.dataDir, 'backups', 'snapshots');
  }

  async createSnapshot(description?: string): Promise<string> {
    const timestamp = Date.now();
    const snapshotId = `snapshot-${timestamp}`;

    await fs.mkdir(this.snapshotDir, { recursive: true });

    const archive = await createBackup({
      memphisRoot: this.dataDir,
      backupRoot: this.snapshotDir,
      tag: snapshotId,
      showProgress: false,
    });

    const snapshot: SnapshotRecord = {
      id: snapshotId,
      timestamp,
      description: description || 'Manual snapshot',
      version: getAppVersion(),
      archiveFile: archive.file,
      archiveChecksum: archive.checksum,
      dataDir: this.dataDir,
      layout: SNAPSHOT_LAYOUT,
      sourceOfTruthPaths: [...SOURCE_OF_TRUTH_PATHS],
      derivedPaths: [...DERIVED_PATHS],
      checksum: '',
    };
    snapshot.checksum = snapshotMetadataChecksum(snapshot);

    const snapshotPath = path.join(this.snapshotDir, `${snapshotId}.json`);
    await fs.writeFile(snapshotPath, JSON.stringify(snapshot, null, 2));

    logger.info('Snapshot created', {
      snapshotId,
      archiveFile: archive.file,
      dataDir: this.dataDir,
    });
    return snapshotId;
  }

  async rollback(snapshotId: string): Promise<RollbackResult> {
    const snapshotPath = path.join(this.snapshotDir, `${snapshotId}.json`);

    try {
      const snapshot = await this.loadSnapshot(snapshotPath);

      const check = await verifyBackup({
        file: snapshot.archiveFile,
        backupRoot: this.snapshotDir,
        memphisRoot: this.dataDir,
      });
      if (!check.valid) {
        throw new Error(`Snapshot archive verification failed for ${snapshot.archiveFile}`);
      }

      await restoreBackup({
        file: snapshot.archiveFile,
        backupRoot: this.snapshotDir,
        memphisRoot: this.dataDir,
        confirm: true,
        showProgress: false,
      });

      logger.info('Rolled back to snapshot', {
        snapshotId,
        archiveFile: snapshot.archiveFile,
        dataDir: this.dataDir,
      });
      return {
        success: true,
        snapshotId,
        timestamp: new Date(snapshot.timestamp).toISOString(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Rollback failed', { error: message, snapshotId, dataDir: this.dataDir });
      return {
        success: false,
        error: message,
      };
    }
  }

  async listSnapshots(): Promise<SnapshotMetadata[]> {
    await fs.mkdir(this.snapshotDir, { recursive: true });
    const files = await fs.readdir(this.snapshotDir);

    const snapshots: SnapshotMetadata[] = [];
    for (const file of files) {
      if (!/^snapshot-\d+\.json$/.test(file)) continue;
      const snapshotPath = path.join(this.snapshotDir, file);
      try {
        const snapshot = await this.loadSnapshot(snapshotPath);
        snapshots.push({
          id: snapshot.id,
          timestamp: snapshot.timestamp,
          description: snapshot.description,
          version: snapshot.version,
        });
      } catch {
        // Skip corrupted snapshot metadata and let explicit rollback surface the error.
      }
    }

    return snapshots.sort((a, b) => b.timestamp - a.timestamp);
  }

  async autoRollback(maxAge: number = 24 * 60 * 60 * 1000): Promise<boolean> {
    const snapshots = await this.listSnapshots();
    const recentSnapshot = snapshots.find((s) => Date.now() - s.timestamp < maxAge);
    if (!recentSnapshot) {
      return false;
    }

    logger.info('Auto-rolling back', { snapshotId: recentSnapshot.id, dataDir: this.dataDir });
    const result = await this.rollback(recentSnapshot.id);
    return result.success;
  }

  private async loadSnapshot(snapshotPath: string): Promise<SnapshotRecord> {
    const snapshotData = await fs.readFile(snapshotPath, 'utf-8');
    const snapshot = JSON.parse(snapshotData) as SnapshotRecord;

    const expectedChecksum = snapshotMetadataChecksum(snapshot);
    if (expectedChecksum !== snapshot.checksum) {
      throw new Error('Snapshot metadata checksum mismatch - possible corruption');
    }
    if (!snapshot.archiveFile) {
      throw new Error('Snapshot metadata missing archiveFile');
    }
    if (!snapshot.archiveChecksum) {
      throw new Error('Snapshot metadata missing archiveChecksum');
    }
    if (snapshot.layout !== SNAPSHOT_LAYOUT) {
      throw new Error(`Unsupported snapshot layout: ${snapshot.layout}`);
    }

    return snapshot;
  }
}
