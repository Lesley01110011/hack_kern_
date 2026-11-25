import fs from "node:fs";
import path from "node:path";
import { AnalysisCache } from "./cache";
import { Config } from "./config";
import { FetchHttpClient } from "./http";
import { LlmClient } from "./llm";
import { Analyzer } from "./analyzer";
import { fields, hashVacancy, unwrap, vacancyId, vacancyUrl } from "./normalizer";
import { ReportStore } from "./report-store";
import { RuleAnalyzer } from "./rule-analyzer";
import { dataPath } from "./root";
import { RunStatus } from "./run-status";
import { isoNow } from "./text";
import type { HttpClient, RemarkModel, Vacancy } from "./types";
import { VacancySource } from "./vacancy-source";

export class Runner {
  constructor(
    private dataDir = dataPath(),
    private http: HttpClient | null = null,
    private model: RemarkModel | null = null,
    private config: Config | null = null,
  ) {
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  isLocked(): boolean {
    const lock = this.lockPath();
    if (!fs.existsSync(lock)) return false;
    const pid = Number.parseInt(fs.readFileSync(lock, "utf8").trim(), 10);
    if (pid > 0 && pidAlive(pid)) return true;
    if (!(pid > 0) && Date.now() - fs.statSync(lock).mtimeMs < 7_200_000) return true;
    fs.rmSync(lock, { force: true });
    return false;
  }

  async execute(fixturePath: string | null, max: number | null = null, pageSize: number | null = null): Promise<void> {
    if (!this.acquireLock()) throw new Error("Проверка уже выполняется.");
    const status = new RunStatus(path.join(this.dataDir, "status.json"));
    status.update({
      state: "running",
      message: fixturePath ? "Читаю проверочный JSON" : "Загружаю вакансии с портала",
      processed: 0,
      total: 0,
      started_at: isoNow(),
      finished_at: null,
    });
    try {
      const config = this.config ?? Config.load();
      let pages = 0;
      let sourceTotal: number | null = null;
      let sourceUrl: string | null = null;
      let vacancies: Vacancy[];
      let mode: string;
      if (fixturePath !== null) {
        vacancies = this.readFixture(fixturePath);
        if (vacancies.length === 0) throw new Error("В файле нет вакансий. Проверьте, что JSON содержит вакансии портала.");
        mode = "fixture";
      } else {
        sourceUrl = config.sourceUrl();
        const limit = max ?? config.maxVacancies();
        const size = pageSize ?? config.pageSize();
        const fetched = await new VacancySource(this.http ?? new FetchHttpClient()).fetch(sourceUrl, size, limit);
        vacancies = fetched.vacancies;
        pages = fetched.pages;
        sourceTotal = fetched.total;
        mode = "api";
      }
      vacancies = this.dedupe(vacancies);
      if (mode === "fixture") this.writePreview(vacancies);
      status.update({ message: "Разбираю условия", total: vacancies.length });

      const model = this.model ?? new LlmClient(config);
      const analyzer = new Analyzer(new RuleAnalyzer(), model);
      const cache = new AnalysisCache(path.join(this.dataDir, "cache.json"));
      const items: Vacancy[] = [];
      const cards: Vacancy[] = [];
      const snapshot: Record<string, Vacancy> = {};
      let aiUsed = false;
      let aiMisses = 0;
      let aiError: string | null = null;
      let index = 0;
      for (const vacancy of vacancies) {
        index++;
        const id = vacancyId(vacancy, index);
        const hash = hashVacancy(vacancy, config.modelStamp());
        const cached = cache.get(id);
        let remarks;
        if (cached && cached.hash === hash) {
          remarks = cached.remarks;
        } else {
          const result = await analyzer.analyze(vacancy);
          remarks = result.remarks;
          if (result.ai) aiUsed = true;
          else {
            aiMisses++;
            aiError ??= analyzer.lastError;
          }
          cache.put(id, hash, remarks);
        }
        const normalized = fields(vacancy);
        snapshot[id] = normalized;
        items.push({
          vacancy_id: id,
          vac_url: vacancyUrl(vacancy),
          remarks,
        });
        cards.push({
          vacancy_id: id,
          vac_url: vacancyUrl(vacancy),
          job_name: normalized["job-name"],
          company: normalized.company_name,
          salary: normalized.salary,
          salary_min: normalized.salary_min,
          salary_max: normalized.salary_max,
          schedule: normalized.schedule,
          employment: normalized.employment,
          address: (normalized.addresses as string[]).join("; "),
          remark_count: remarks.length,
        });
        status.update({
          processed: index,
          total: vacancies.length,
          message: `Проверено ${index} из ${vacancies.length}`,
        });
      }

      if (!config.llmConfigured()) {
        aiUsed = false;
        aiError = new LlmClient(config).notConfiguredMessage();
      } else if (aiMisses === 0) {
        aiUsed = items.length > 0;
        aiError = null;
      } else if (aiUsed) {
        aiError = "По части вакансий модель не ответила, для них оставлены структурные проверки.";
      }

      fs.writeFileSync(path.join(this.dataDir, "vacancies.json"), JSON.stringify(snapshot));
      new ReportStore(path.join(this.dataDir, "report.json")).saveSuccess({
        mode,
        source_url: sourceUrl,
        pages_fetched: pages,
        source_total: sourceTotal,
        vacancies_processed: items.length,
        ai_used: aiUsed,
        ai_error: aiError,
        items,
        cards,
      });
      status.update({
        state: "ok",
        message: "Отчёт обновлён",
        processed: items.length,
        total: items.length,
        finished_at: isoNow(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== "Проверка уже выполняется.") {
        new ReportStore(path.join(this.dataDir, "report.json")).fail(message);
      }
      status.update({ state: "error", message, finished_at: isoNow() });
      throw error;
    } finally {
      this.releaseLock();
    }
  }

  private dedupe(vacancies: Vacancy[]): Vacancy[] {
    const out = new Map<string, Vacancy>();
    let index = 0;
    for (const vacancy of vacancies) {
      index++;
      const id = vacancyId(vacancy, index);
      if (out.has(id)) continue;
      vacancy.id = id;
      out.set(id, vacancy);
    }
    return [...out.values()];
  }

  private writePreview(vacancies: Vacancy[]): void {
    const items: Vacancy[] = [];
    const cards: Vacancy[] = [];
    const snapshot: Record<string, Vacancy> = {};
    vacancies.forEach((vacancy, index) => {
      const id = vacancyId(vacancy, index + 1);
      const normalized = fields(vacancy);
      snapshot[id] = normalized;
      items.push({ vacancy_id: id, vac_url: vacancyUrl(vacancy), remarks: [] });
      cards.push({
        vacancy_id: id,
        vac_url: vacancyUrl(vacancy),
        job_name: normalized["job-name"],
        company: normalized.company_name,
        salary: normalized.salary,
        salary_min: normalized.salary_min,
        salary_max: normalized.salary_max,
        schedule: normalized.schedule,
        employment: normalized.employment,
        address: (normalized.addresses as string[]).join("; "),
        remark_count: 0,
      });
    });
    fs.writeFileSync(path.join(this.dataDir, "vacancies.json"), JSON.stringify(snapshot));
    new ReportStore(path.join(this.dataDir, "report.json")).saveSuccess({
      mode: "fixture",
      source_url: null,
      pages_fetched: 0,
      source_total: vacancies.length,
      vacancies_processed: vacancies.length,
      ai_used: false,
      ai_error: null,
      items,
      cards,
    });
  }

  private readFixture(filePath: string): Vacancy[] {
    if (!fs.existsSync(filePath)) throw new Error("Файл проверочного JSON не найден.");
    let decoded: unknown;
    try {
      decoded = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      decoded = null;
    }
    if (!decoded || typeof decoded !== "object") {
      throw new Error("Проверочный файл не является JSON-объектом или массивом.");
    }
    return unwrap(decoded);
  }

  private acquireLock(): boolean {
    if (this.isLocked()) return false;
    fs.writeFileSync(this.lockPath(), String(process.pid));
    return true;
  }

  private releaseLock(): void {
    const lock = this.lockPath();
    if (!fs.existsSync(lock)) return;
    const pid = Number.parseInt(fs.readFileSync(lock, "utf8").trim(), 10);
    if (pid === process.pid) fs.rmSync(lock, { force: true });
  }

  private lockPath(): string {
    return path.join(this.dataDir, "run.lock");
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    return code === "EPERM";
  }
}
