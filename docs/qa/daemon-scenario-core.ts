export async function requireMutationReadback<T>(
  mutate: () => Promise<void>,
  readback: () => Promise<T>,
): Promise<T> {
  await mutate();
  return await readback();
}
