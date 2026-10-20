import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { XML } = require('expo/config-plugins');
const { writeBackupRules } = require('../plugins/withLocalOnlyAndroidBackup.cjs');

test('Android backup rules exclude all app storage from cloud and device transfer', async t => {
  const temporaryRoot = path.resolve(tmpdir());
  const root = await mkdtemp(path.join(temporaryRoot, 'finance-backup-rules-'));
  assert.equal(path.dirname(root), temporaryRoot);
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeBackupRules(root);
  const directory = path.join(root, 'app/src/main/res/xml');
  const legacy = await XML.parseXMLAsync(await readFile(path.join(directory, 'finance_backup_rules.xml'), 'utf8'));
  const modern = await XML.parseXMLAsync(await readFile(path.join(directory, 'finance_data_extraction_rules.xml'), 'utf8'));
  const sections = [legacy['full-backup-content'], modern['data-extraction-rules']['cloud-backup'][0], modern['data-extraction-rules']['device-transfer'][0]];
  const requiredDomains = ['root', 'file', 'database', 'sharedpref', 'external', 'device_root', 'device_file', 'device_database', 'device_sharedpref'].sort();
  for (const section of sections) {
    assert.equal(section.include, undefined);
    assert.deepEqual(section.exclude.map((rule: { $: { domain: string } }) => rule.$.domain).sort(), requiredDomains);
    assert.ok(section.exclude.every((rule: { $: { path: string } }) => rule.$.path === '.'));
  }
  await writeBackupRules(root);
  assert.deepEqual(await XML.parseXMLAsync(await readFile(path.join(directory, 'finance_data_extraction_rules.xml'), 'utf8')), modern);
});
