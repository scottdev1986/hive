export function errorMessage<T>(error: T): string {
  return error instanceof Error ? error.message : String(error);
}

export function isErrnoCode<T>(error: T, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
