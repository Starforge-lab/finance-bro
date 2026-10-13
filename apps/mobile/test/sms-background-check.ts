import * as BackgroundTask from 'expo-background-task';
import Constants from 'expo-constants';
import { File, Paths } from 'expo-file-system';
import * as SQLite from 'expo-sqlite';
import * as TaskManager from 'expo-task-manager';
import { AppState, Platform } from 'react-native';
import { ledgerMigrations } from '../src/db/migrations';
import type { LedgerSQLiteClient } from '../src/db/ledger';
import { getFingerprinter } from '../src/imports/fingerprint-store.native';
import { createSmsBackgroundTaskExecutor, dispatchAfterPendingReport } from './sms-background-coordinator';
import { runSmsRuntimeCheck } from './sms-runtime-check';

const TASK_NAME = 'finance-bro-sms-background-feasibility';
const REPORT_NAME = 'finance-bro-sms-background-qa.json';
const FIXTURE_DB_PREFIX = 'finance-bro-sms-background-fixture';
const CHECK_NAMES = [
  'parser-handoff', 'exact-paise', 'transaction-semantics', 'string-platform-id',
  'no-persisted-body', 'correction-replay', 'tombstone-replay',
];
let fixtureSequence = 0;
let testTriggerInProgress = false;
let reportWriteQueue: Promise<void> = Promise.resolve();

type ProbeRun = {
  startedAtMs: number;
  completedAtMs: number | null;
  appState: string;
  invocation: 'test-trigger-requested' | 'test-trigger-call-window' | 'origin-unknown';
  outcome: 'started' | 'passed' | 'failed';
  checks: string[];
  cleanup: 'passed' | 'failed' | 'not-needed';
  failureStage: string | null;
};

function assertProbeBuild() {
  if (Platform.OS !== 'android' || Constants.expoConfig?.extra?.androidBackgroundProbe !== true) {
    throw new Error('Android SMS background checks are only available in the isolated probe build');
  }
}

async function writeReport(report: ProbeRun) {
  const write = reportWriteQueue.then(async () => {
    const file = new File(Paths.document, REPORT_NAME);
    file.create({ overwrite: true, intermediates: true });
    await file.write(JSON.stringify(report));
  });
  reportWriteQueue = write.catch(() => undefined);
  return await write;
}

async function markFailed(report: ProbeRun, stage: string) {
  report.outcome = 'failed';
  report.completedAtMs = Date.now();
  report.failureStage = stage;
  try {
    await writeReport(report);
  } catch {
    report.failureStage = 'write-report';
  }
}

function createReport(invocation: ProbeRun['invocation']): ProbeRun {
  return {
    startedAtMs: Date.now(),
    completedAtMs: null,
    appState: AppState.currentState ?? 'unknown',
    invocation,
    outcome: 'started',
    checks: [],
    cleanup: 'not-needed',
    failureStage: null,
  };
}

async function runFixtureCheck(taskFailed: boolean): Promise<BackgroundTask.BackgroundTaskResult> {
  const report: ProbeRun = {
    ...createReport(testTriggerInProgress ? 'test-trigger-call-window' : 'origin-unknown'),
  };
  let databaseName: string | undefined;
  let database: SQLite.SQLiteDatabase | undefined;
  let databaseOpened = false;
  let currentStage = taskFailed ? 'task-manager' : 'write-start-report';

  try {
    if (taskFailed) {
      report.outcome = 'failed';
      report.failureStage = 'task-manager';
    } else {
      await writeReport(report);
      databaseName = `${FIXTURE_DB_PREFIX}-${Date.now()}-${++fixtureSequence}.db`;
      currentStage = 'open-fixture-db';
      database = await SQLite.openDatabaseAsync(databaseName);
      databaseOpened = true;
      currentStage = 'protected-hmac-key';
      const fingerprinter = await getFingerprinter();
      currentStage = 'run-fictional-runtime-check';
      const result = await runSmsRuntimeCheck(
        database as unknown as LedgerSQLiteClient,
        ledgerMigrations,
        fingerprinter,
      );
      if (!result.passed || result.checks.length !== CHECK_NAMES.length ||
        result.checks.some((check, index) => check !== CHECK_NAMES[index])) {
        throw new Error('fixture-check-list-mismatch');
      }
      report.checks = CHECK_NAMES;
      report.outcome = 'passed';
      report.failureStage = null;
    }
  } catch {
    report.outcome = 'failed';
    report.failureStage ??= currentStage;
  } finally {
    if (databaseName) {
      report.cleanup = 'passed';
      if (databaseOpened && database) {
        try {
          await database.closeAsync();
        } catch {
          report.cleanup = 'failed';
          report.failureStage ??= 'close-fixture-db';
        }
      }
      try {
        const databaseDirectory = SQLite.defaultDatabaseDirectory;
        if (!databaseDirectory) throw new Error('sqlite-directory-unavailable');
        if (new File(`file://${databaseDirectory}`, databaseName).exists) {
          await SQLite.deleteDatabaseAsync(databaseName);
        }
      } catch {
        report.cleanup = 'failed';
        report.failureStage ??= 'delete-fixture-db';
      }
    }
    if (report.cleanup === 'failed') report.outcome = 'failed';
    report.completedAtMs = Date.now();
    try {
      await writeReport(report);
    } catch {
      report.outcome = 'failed';
      report.failureStage ??= 'write-report';
    }
  }

  return report.outcome === 'passed' && report.cleanup !== 'failed' && report.failureStage === null
    ? BackgroundTask.BackgroundTaskResult.Success
    : BackgroundTask.BackgroundTaskResult.Failed;
}

const taskCoordinator = createSmsBackgroundTaskExecutor(runFixtureCheck);

TaskManager.defineTask(TASK_NAME, ({ error }) => taskCoordinator.execute(error));

export const smsBackgroundReportName = REPORT_NAME;

export async function registerSmsBackgroundCheck() {
  assertProbeBuild();
  if (!await TaskManager.isTaskRegisteredAsync(TASK_NAME)) {
    await BackgroundTask.registerTaskAsync(TASK_NAME, { minimumInterval: 15 });
  }
  return true;
}

export async function unregisterSmsBackgroundCheck() {
  assertProbeBuild();
  if (await TaskManager.isTaskRegisteredAsync(TASK_NAME)) {
    await BackgroundTask.unregisterTaskAsync(TASK_NAME);
  }
  return true;
}

export async function triggerSmsBackgroundCheckForTesting() {
  assertProbeBuild();
  const pendingReport = createReport('test-trigger-requested');
  try {
    return await taskCoordinator.afterIdle(() => dispatchAfterPendingReport(
        () => writeReport(pendingReport),
        async () => {
          let registered: boolean;
          try {
            registered = await TaskManager.isTaskRegisteredAsync(TASK_NAME);
          } catch {
            await markFailed(pendingReport, 'task-registration-check');
            return false;
          }
          if (!registered) {
            await markFailed(pendingReport, 'task-not-registered');
            return false;
          }
          testTriggerInProgress = true;
          try {
            return await BackgroundTask.triggerTaskWorkerForTestingAsync();
          } catch {
            await markFailed(pendingReport, 'test-trigger');
            return false;
          } finally {
            testTriggerInProgress = false;
          }
        },
      ));
  } catch {
    await markFailed(pendingReport, 'write-start-report');
    return false;
  }
}

export async function readSmsBackgroundCheckReport() {
  const file = new File(Paths.document, REPORT_NAME);
  return file.exists ? file.text() : null;
}
