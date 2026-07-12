/** `graphify.lock` is imported as inlined text (Bun `with { type: "text" }`),
 * the same mechanism that ships skills inside the compiled binary. */
declare module "*.lock" {
  const text: string;
  export default text;
}
