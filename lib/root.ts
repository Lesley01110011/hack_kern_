import path from "node:path";

export const root = process.cwd();

export function dataPath(...parts: string[]): string {
  return path.join(root, "data", ...parts);
}
