import { v7 as uuidv7 } from "uuid";

export function createPrefixedId(prefix: string): string {
  return `${prefix}${uuidv7().replaceAll("-", "")}`;
}
