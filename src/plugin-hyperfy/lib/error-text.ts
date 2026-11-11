/** An error as text for a log line: its stack when it has one, else its message. */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}
