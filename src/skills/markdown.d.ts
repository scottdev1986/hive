/** Bun's text loader (`import … with { type: "text" }`) hands back the file's
 * contents as a string; TypeScript needs telling that a `.md` import is one. */
declare module "*.md" {
  const content: string;
  export default content;
}
