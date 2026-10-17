const UPI_REF =
  /\b(?:upi\s*ref(?:erence)?(?:\s*no\.?)?|ref(?:erence)?(?:\s*(?:no\.?|number|#))?|rrn|utr(?:\s*no\.?)?)\s*[:-]?\s*(\d{12})\b/i;

// Handles have no dots after "@", which keeps email addresses out.
export const VPA = /\b([a-z0-9][a-z0-9._-]{1,255}@[a-z][a-z0-9]{1,63})(?![.\w])/i;

/** 12-digit UPI reference / RRN / UTR. The best key for merging duplicate SMS. */
export function extractUpiRef(text: string): string | null {
  return UPI_REF.exec(text)?.[1] ?? null;
}

export function extractVpa(text: string): string | null {
  return VPA.exec(text)?.[1]?.toLowerCase() ?? null;
}
