import { writeCsvWithCleanup } from './save-csv-write';

type SaveDocumentResult = { resultCode: number; data?: string };
type SaveResultCodes = { Canceled: number; Success: number };
type CsvDocument = { write(content: string): Promise<void>; delete(): void };

export async function saveCsvToDocument(
  result: SaveDocumentResult,
  content: string,
  resultCodes: SaveResultCodes,
  documentForUri: (uri: string) => CsvDocument,
): Promise<'saved' | 'cancelled'> {
  if (result.resultCode === resultCodes.Canceled) return 'cancelled';
  if (result.resultCode !== resultCodes.Success || !result.data || !/^content:\/\/[^/\s]+\/\S+$/.test(result.data)) {
    throw new Error('The system file picker did not return a destination.');
  }

  const document = documentForUri(result.data);
  await writeCsvWithCleanup(() => document.write(content), async () => document.delete());
  return 'saved';
}
