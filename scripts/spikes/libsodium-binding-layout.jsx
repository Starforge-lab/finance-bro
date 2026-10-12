import { useEffect, useState } from 'react';
import { Platform, ScrollView, Text } from 'react-native';
import { File, Paths } from 'expo-file-system';
import sodium from 'react-native-libsodium';
import { runLibsodiumBindingVectors } from '../../scripts/libsodium-binding-vectors.mjs';

sodium.loadSumoVersion();
let qaRun;

export default function CryptoBindingQa() {
  const [status, setStatus] = useState('Running fictional crypto checks. No ledger or keys are opened.');
  useEffect(() => {
    const finish = async (result) => {
      try {
        if (Platform.OS !== 'web') {
          const report = new File(Paths.document, 'finance-bro-sodium-binding-qa.json');
          report.create({ overwrite: true });
          await report.write(JSON.stringify(result, null, 2));
        }
      } catch (error) {
        result = { status: 'fail', failure: `QA report write failed: ${String(error)}` };
      }
      setStatus(JSON.stringify(result, null, 2));
    };
    qaRun ??= runLibsodiumBindingVectors(sodium);
    void qaRun
      .then(finish)
      .catch((error) => { void finish({ status: 'fail', failure: error instanceof Error ? error.message : String(error) }); });
  }, []);
  return <ScrollView contentContainerStyle={{ padding: 28, paddingTop: 72 }}>
    <Text accessibilityRole="header" style={{ fontSize: 22 }}>Crypto binding QA</Text>
    <Text selectable style={{ marginTop: 24, fontSize: 16 }}>{status}</Text>
  </ScrollView>;
}
