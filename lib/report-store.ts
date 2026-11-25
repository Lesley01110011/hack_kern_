import fs from "node:fs";
import path from "node:path";
import { isoNow } from "./text";

export type ReportFile = {
  generated_at: string | null;
  status: string;
  error: string | null;
  last_error_at: string | null;
  mode: string | null;
  source_url: string | null;
  pages_fetched: number;
  source_total: number | null;
  vacancies_processed: number;
  ai_used: boolean;
  ai_error: string | null;
  items: unknown[];
  cards: unknown[];
};

export class ReportStore {
  constructor(private filePath: string) {}

  load(): ReportFile {
    if (!fs.existsSync(this.filePath)) return emptyReport();
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (!data || typeof data !== "object") return emptyReport();
      return { ...emptyReport(), ...data };
    } catch {
      return emptyReport();
    }
  }

  saveSuccess(report: Partial<ReportFile>): void {
    const next: ReportFile = {
      ...emptyReport(),
      ...report,
      status: "ok",
      error: null,
      generated_at: isoNow(),
    };
    this.write(next);
  }

  fail(message: string): void {
    const report = this.load();
    report.status = "error";
    report.error = message;
    report.last_error_at = isoNow();
    if ((report.items ?? []).length === 0 && !report.generated_at) report.generated_at = isoNow();
    this.write(report);
  }

  private write(report: ReportFile): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(report, null, 4));
  }
}

function emptyReport(): ReportFile {
  return {
    generated_at: null,
    status: "empty",
    error: null,
    last_error_at: null,
    mode: null,
    source_url: null,
    pages_fetched: 0,
    source_total: null,
    vacancies_processed: 0,
    ai_used: false,
    ai_error: null,
    items: [],
    cards: [],
  };
}
