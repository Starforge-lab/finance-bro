export function createSmsBackgroundTaskExecutor<Result>(
  run: (taskFailed: boolean) => Promise<Result>,
) {
  let inFlight: Promise<Result> | undefined;

  function track(task: Promise<Result>) {
    let tracked: Promise<Result>;
    tracked = task.finally(() => {
      if (inFlight === tracked) inFlight = undefined;
    });
    inFlight = tracked;
    return tracked;
  }

  function execute(error: unknown | null): Promise<Result> {
    if (error !== null) {
      const current = inFlight;
      return track(current
        ? current.catch(() => undefined).then(() => run(true))
        : run(true));
    }
    if (inFlight) return inFlight;
    return track(run(false));
  }

  async function afterIdle<Output>(action: () => Promise<Output>): Promise<Output> {
    while (inFlight) {
      const active = inFlight;
      await active.catch(() => undefined);
    }
    return await action();
  }

  return { execute, afterIdle };
}

export async function dispatchAfterPendingReport<Result>(
  writePendingReport: () => Promise<void>,
  dispatch: () => Promise<Result>,
) {
  await writePendingReport();
  return await dispatch();
}
