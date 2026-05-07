declare module "sql.js" {
  export default function initSqlJs(config?: { locateFile?: (file: string) => string }): Promise<unknown>;
}
