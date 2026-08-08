export async function refreshAfterCompact(
  reload: () => Promise<unknown>,
  invalidate: () => Promise<unknown>,
  remount: () => void
): Promise<void> {
  await reload()
  await invalidate()
  remount()
}
