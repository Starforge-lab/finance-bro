import type { DatabaseSync } from 'node:sqlite';

export function smsReferenceId(sqlite: DatabaseSync, platformId: string, receivedAt?: number): string {
  const rows = sqlite.prepare(`SELECT reference_id FROM sms_import_refs WHERE platform_id = ?${receivedAt === undefined ? '' : ' AND received_at = ?'}`)
    .all(...(receivedAt === undefined ? [platformId] : [platformId, receivedAt])) as Array<{ reference_id: string }>;
  if (rows.length !== 1) throw new Error('Expected exactly one SMS source reference');
  return rows[0]!.reference_id;
}
