import { fields as normalizeFields } from "./normalizer";
import { RuleAnalyzer } from "./rule-analyzer";
import { contains, len, lower } from "./text";
import type { PublicRemark, RemarkModel, Vacancy } from "./types";

const TOPICS = new Set([
  "название_должности",
  "обязанности",
  "требования",
  "оплата",
  "график",
  "место_работы",
  "тип_занятости",
]);

export class Analyzer {
  lastError: string | null = null;

  constructor(
    private rules: RuleAnalyzer,
    private model: RemarkModel | null = null,
  ) {}

  async analyze(vacancy: Vacancy): Promise<{ remarks: PublicRemark[]; ai: boolean }> {
    this.lastError = null;
    const ruled = this.rules.analyze(vacancy);
    const model = this.model;
    if (!model || !model.isConfigured()) {
      this.lastError = model?.notConfiguredMessage?.()
        ?? "Модель не подключена. Отчёт собран структурными проверками.";
      return { remarks: this.rules.export(ruled), ai: false };
    }
    try {
      const suspected = this.rules.export(ruled);
      const raw = await model.suggest(normalizeFields(vacancy), suspected);
      const accepted = this.sanitize(raw, vacancy);
      return { remarks: this.backfill(accepted, this.rules.hardOnly(ruled)), ai: true };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return { remarks: this.rules.export(ruled), ai: false };
    }
  }

  private sanitize(raw: unknown[], vacancy: Vacancy): PublicRemark[] {
    const blob = lower(this.flatten(normalizeFields(vacancy)));
    const out: PublicRemark[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const row = item as Vacancy;
      const topic = String(row.topic ?? "").trim();
      const field = String(row.field ?? "").trim();
      const quote = String(row.quote ?? "").trim();
      const problem = String(row.problem ?? "").trim();
      const recommendation = String(row.recommendation ?? "").trim();
      if (!TOPICS.has(topic) || field === "" || problem === "" || recommendation === "") continue;
      if (!this.quoteGrounded(quote, blob)) continue;
      if (quote === "" && this.falseOmission(topic, vacancy)) continue;
      out.push({ topic, field, quote, problem, recommendation });
    }
    return out;
  }

  private backfill(primary: PublicRemark[], hard: PublicRemark[]): PublicRemark[] {
    for (const remark of hard) {
      const covered = primary.some((existing) => existing.topic === remark.topic && existing.field === remark.field);
      if (!covered) primary.push(remark);
    }
    return primary;
  }

  private quoteGrounded(quote: string, blob: string): boolean {
    if (quote === "") return true;
    let q = lower(quote);
    if (contains(blob, q)) return true;
    q = q.replace(
      /job-name|typicalposition|salary_min|salary_max|requirements|requirement|qualification|education|experience|schedule|employment|addresses|address|salary|shift|duty/g,
      " ",
    );
    const numbers = quote.match(/\d{2,}/gu) ?? [];
    for (const number of numbers) {
      if (!blob.includes(number)) return false;
    }
    const words = q.match(/[\p{L}]{5,}/gu) ?? [];
    if (words.length === 0) return numbers.length > 0;
    const hits = words.filter((word) => contains(blob, word)).length;
    return hits / words.length >= 0.6;
  }

  private flatten(value: unknown): string {
    if (Array.isArray(value)) return value.map((item) => this.flatten(item)).join(" ");
    if (value && typeof value === "object") return Object.values(value).map((item) => this.flatten(item)).join(" ");
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
    return "";
  }

  private falseOmission(topic: string, vacancy: Vacancy): boolean {
    const data = normalizeFields(vacancy);
    switch (topic) {
      case "название_должности":
        return String(data["job-name"]).trim() !== "";
      case "обязанности":
        return len(String(data.duty).trim()) > 40;
      case "требования":
        return String(data.requirements).trim() !== ""
          || String(data.requirement?.education ?? "").trim() !== ""
          || String(data.requirement?.qualification ?? "").trim() !== "";
      case "оплата":
        return String(data.salary).trim() !== ""
          || Number(data.salary_min ?? 0) > 0
          || Number(data.salary_max ?? 0) > 0;
      case "график":
        return String(data.schedule).trim() !== "";
      case "место_работы":
        return Array.isArray(data.addresses) && data.addresses.length > 0;
      case "тип_занятости":
        return String(data.employment).trim() !== "";
      default:
        return false;
    }
  }
}
