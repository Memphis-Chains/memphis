import { existsSync } from 'node:fs';

import Database from 'better-sqlite3';

import { runMemphisLrDashboard } from '../mcp/tools/lr-dashboard.js';

export interface LrDashboardFastPathInput {
  text: string;
  timestamp: Date;
  rawEnv?: NodeJS.ProcessEnv;
}

export interface LrDashboardFastPathResult {
  handled: boolean;
  reply?: string;
}

interface ParsedMeasurement {
  measuredAt: string;
  category: 'body-ph';
  marker: 'urine_ph';
  value: string;
  unit: 'pH';
  note: string;
}

function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function localDate(timestamp: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(timestamp);
}

function localYear(timestamp: Date): number {
  return Number(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Warsaw',
      year: 'numeric',
    }).format(timestamp),
  );
}

function parseMeasurementDate(text: string, timestamp: Date): string {
  const iso = text.match(/\b(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/u);
  if (iso) return iso[0];

  // `DD.MM` is a common Polish date form. Require a two-digit month so a
  // pH value such as `6.2` can never be mistaken for a date.
  const polish = text.match(/\b([0-3]?\d)\.(0[1-9]|1[0-2])(?:\.(20\d{2}))?\b/u);
  if (!polish) return localDate(timestamp);

  const day = Number(polish[1]);
  const month = Number(polish[2]);
  const year = polish[3] ? Number(polish[3]) : localYear(timestamp);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return localDate(timestamp);
  }
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}

function isExplicitSaveCommand(text: string): boolean {
  const normalized = normalizeText(text);
  return /\b(?:to\s+)?zapisz\b/u.test(normalized) ||
    /\b(?:dodaj|wpisz|zaloguj|wrzuc)\b/u.test(normalized);
}

function asksWhereToSave(text: string): boolean {
  return /\bgdzie\b[\s\S]{0,80}\bzapisz(?:esz|emy|e)\b/u.test(normalizeText(text));
}

function parseUrinePhMeasurement(text: string, timestamp: Date): ParsedMeasurement | null {
  const normalized = normalizeText(text);
  if (!/\bph\b/u.test(normalized) || !/\bmocz(?:u)?\b/u.test(normalized)) return null;

  const values = Array.from(
    normalized.matchAll(/\bph(?:\s+moczu)?\s*(?:=|:|wynosi)?\s*(\d{1,2}(?:[,.]\d{1,2})?)\b/gu),
    (match) => match[1].replace(',', '.'),
  );
  if (values.length !== 1) return null;
  const value = values[0];
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0 || numericValue > 14) return null;

  return {
    measuredAt: parseMeasurementDate(normalized, timestamp),
    category: 'body-ph',
    marker: 'urine_ph',
    value,
    unit: 'pH',
    note: `z Telegrama: ${text.slice(0, 240)}`,
  };
}

function findDuplicate(
  dbPath: string,
  measurement: ParsedMeasurement,
): { id: number; createdAt: string } | null {
  if (!existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        `
          SELECT id, created_at AS createdAt
          FROM entries
          WHERE measured_at = @measuredAt
            AND category = @category
            AND marker = @marker
            AND value = @value
            AND unit = @unit
          ORDER BY id DESC
          LIMIT 1
        `,
      )
      .get({
        measuredAt: measurement.measuredAt,
        category: measurement.category,
        marker: measurement.marker,
        value: measurement.value,
        unit: measurement.unit,
      }) as { id: number; createdAt: string } | undefined;
    return row ?? null;
  } finally {
    db.close();
  }
}

export function handleLrDashboardFastPath(
  input: LrDashboardFastPathInput,
): LrDashboardFastPathResult {
  if (asksWhereToSave(input.text)) {
    return { handled: false };
  }
  if (!isExplicitSaveCommand(input.text)) {
    return { handled: false };
  }

  const measurement = parseUrinePhMeasurement(input.text, input.timestamp);
  if (!measurement) {
    return { handled: false };
  }

  const rawEnv = input.rawEnv ?? process.env;
  const status = runMemphisLrDashboard({ action: 'status' }, rawEnv);
  const duplicate = findDuplicate(status.dbPath, measurement);
  if (duplicate) {
    return {
      handled: true,
      reply: `Już jest w LR Dashboard: pH moczu ${measurement.value} (${measurement.measuredAt}), id=${duplicate.id}.`,
    };
  }

  const result = runMemphisLrDashboard(
    {
      action: 'add_entry',
      measuredAt: measurement.measuredAt,
      category: measurement.category,
      marker: measurement.marker,
      value: measurement.value,
      unit: measurement.unit,
      note: measurement.note,
    },
    rawEnv,
  );
  if (result.action !== 'add_entry') {
    return { handled: true, reply: 'Nie udało się potwierdzić zapisu w LR Dashboard.' };
  }

  return {
    handled: true,
    reply: `Zapisane w LR Dashboard: pH moczu ${result.entry.value} (${result.entry.measuredAt}), id=${result.entry.id}.`,
  };
}
