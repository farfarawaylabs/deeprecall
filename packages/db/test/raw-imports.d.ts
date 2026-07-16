/** Vite `?raw` imports (used to byte-compare the canonical .sql file). */
declare module '*.sql?raw' {
  const content: string;
  export default content;
}
