const { AndroidConfig, withAndroidManifest, withDangerousMod } = require('expo/config-plugins');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');

const domains = ['root', 'file', 'database', 'sharedpref', 'external', 'device_root', 'device_file', 'device_database', 'device_sharedpref'];
const exclusions = domains.map(domain => `    <exclude domain="${domain}" path="." />`).join('\n');
const legacyRules = `<?xml version="1.0" encoding="utf-8"?>\n<full-backup-content>\n${exclusions}\n</full-backup-content>\n`;
const extractionRules = `<?xml version="1.0" encoding="utf-8"?>\n<data-extraction-rules>\n  <cloud-backup>\n${exclusions}\n  </cloud-backup>\n  <device-transfer>\n${exclusions}\n  </device-transfer>\n</data-extraction-rules>\n`;

async function writeBackupRules(projectRoot) {
  const directory = path.join(projectRoot, 'app/src/main/res/xml');
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(path.join(directory, 'finance_backup_rules.xml'), legacyRules),
    writeFile(path.join(directory, 'finance_data_extraction_rules.xml'), extractionRules),
  ]);
}

function withLocalOnlyAndroidBackup(config) {
  config = withAndroidManifest(config, mod => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);
    application.$['android:allowBackup'] = 'false';
    application.$['android:fullBackupContent'] = '@xml/finance_backup_rules';
    application.$['android:dataExtractionRules'] = '@xml/finance_data_extraction_rules';
    return mod;
  });
  return withDangerousMod(config, ['android', async mod => {
    await writeBackupRules(mod.modRequest.platformProjectRoot);
    return mod;
  }]);
}

module.exports = withLocalOnlyAndroidBackup;
module.exports.writeBackupRules = writeBackupRules;
