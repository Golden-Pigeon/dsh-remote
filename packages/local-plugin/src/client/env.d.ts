/**
 * Browser module declaration for CSS imported as text and injected by the
 * plugin's own style tag.
 */
declare module '*.css' {
  const text: string
  export default text
}
