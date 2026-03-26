import type { SessionRecord } from '../../core/contracts/repository.js';

function relativeAge(ts: string): string {
  const deltaMs = Date.now() - new Date(ts).getTime();
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return 'n/a';
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hrs = Math.floor(min / 60);
  if (hrs < 48) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

export function renderSessionScreen(records: SessionRecord[]): string[] {
  if (records.length === 0) {
    return [
      'No persisted sessions yet.',
      'Sessions appear here after chat, gateway, or HTTP runtime activity.',
    ];
  }

  return [
    `Persisted Sessions (${records.length})`,
    ...records.slice(0, 24).map((record, index) => {
      const updated = relativeAge(record.updatedAt);
      return `${String(index + 1).padStart(2, '0')}. ${record.id}  updated=${updated}  created=${record.createdAt}`;
    }),
  ];
}
