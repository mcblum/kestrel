/** Cursor control requires a real terminal. Keep the ordinary transcript for pipes,
 * dumb terminals, NO_COLOR, screen readers, and terminals too small for the controls. */
export function canUseWorkerInk(
  input: Pick<NodeJS.ReadStream, 'isTTY'> = process.stdin,
  output: Pick<NodeJS.WriteStream, 'isTTY' | 'columns' | 'rows'> = process.stdout,
  error: Pick<NodeJS.WriteStream, 'isTTY'> = process.stderr,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(input.isTTY && output.isTTY && error.isTTY)
    && (output.columns || 80) >= 24 && (output.rows || 24) >= 20
    && env.TERM !== 'dumb' && env.NO_COLOR === undefined && env.INK_SCREEN_READER !== 'true'
    && (!env.CI || env.CI === 'false');
}
