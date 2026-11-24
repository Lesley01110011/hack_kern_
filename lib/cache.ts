import fs from "node:fs";
import path from "node:path";
import type { PublicRemark } from "./types";

type CacheRow = { hash: string; remarks: PublicRemark[] };

export class AnalysisCache {
  constructor(private filePath: string) {}

  get(id: string): CacheRow | null {
    const row = this.read()[id];
    if (!row || typeof row.hash !== "string" || !Array.isArray(row.remarks)) return null;
    return { hash: row.hash, remarks: row.remarks };
  }

  put(id: string, hash: string, remarks: PublicRemark[]): void {
    const all = this.read();
    all[id] = { hash, remarks };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(all));
  }

  private read(): Record<string, CacheRow> {
    if (!fs.existsSync(this.filePath)) return {};
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return data && typeof data === "object" ? data : {};
    } catch {
      return {};
    }
  }
}
