declare module "better-sqlite3" {
  export interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  export interface Statement {
    run(...params: unknown[]): RunResult;
    get(...params: unknown[]): unknown;
  }

  export default class Database {
    constructor(filename: string);
    pragma(value: string): unknown;
    exec(sql: string): this;
    prepare(sql: string): Statement;
    transaction<TArgs extends unknown[]>(fn: (...args: TArgs) => void): (...args: TArgs) => void;
    close(): void;
  }
}

