import { File } from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
import { Platform } from 'react-native';
import { saveCsvToDocument } from './save-csv-document';

export async function saveCsv(content: string, filename: string): Promise<'saved' | 'cancelled'> {
  if (Platform.OS !== 'android') {
    throw new Error('CSV export is not available on iOS yet.');
  }

  const result = await IntentLauncher.startActivityAsync('android.intent.action.CREATE_DOCUMENT', {
    category: 'android.intent.category.OPENABLE',
    type: 'text/csv',
    extra: { 'android.intent.extra.TITLE': filename },
  });

  return saveCsvToDocument(result, content, IntentLauncher.ResultCode, (uri) => {
    const file = new File(uri);
    return {
      write: (csv) => file.write(csv),
      delete: () => file.delete(),
    };
  });
}
