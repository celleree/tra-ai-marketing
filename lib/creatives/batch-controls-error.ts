/** Only application-authored batch-control guidance is safe to expose to operators. */
export class BatchControlsError extends Error {
  readonly status = 409;
}
