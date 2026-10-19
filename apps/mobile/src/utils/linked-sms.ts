/** Longest message a Shortcuts link may carry. Longer text is refused, never trimmed: a cut message can parse as a different transaction. */
export const LINKED_SMS_LIMIT = 2000;

/** Messages handed over by link: the one under review, those waiting behind an open form, and whether one was refused. */
export type LinkedInbox = { open?: string; seq: number; queue: string[]; rejected: boolean };

export const emptyInbox: LinkedInbox = { seq: 0, queue: [], rejected: false };

/** A message that arrives while a form is open waits its turn, so unsaved input is never replaced. */
export function receiveLinked(inbox: LinkedInbox, body: string, formOpen: boolean): LinkedInbox {
  if (body.length > LINKED_SMS_LIMIT) return { ...inbox, rejected: true };
  if (formOpen) return { ...inbox, queue: [...inbox.queue, body] };
  return { ...inbox, open: body, seq: inbox.seq + 1 };
}

/** Called when the open form closes; brings up the next waiting message, if any. */
export function finishLinked(inbox: LinkedInbox): LinkedInbox {
  const [open, ...queue] = inbox.queue;
  return { ...inbox, open, queue, seq: inbox.seq + 1 };
}
