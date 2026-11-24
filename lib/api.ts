import fs from "node:fs";
import path from "node:path";
import { Config } from "./config";
import { LlmClient } from "./llm";
import { fields, readyReport, unwrap } from "./normalizer";
import { ReportStore } from "./report-store";
import { dataPath, root } from "./root";
import { Runner } from "./runner";
import { RunStatus } from "./run-status";
import { isoNow } from "./text";
import type { PublicRemark, Vacancy } from "./types";

export async function handleAction(action: string, request: Request): Promise<Response> {
  try {
    switch (action) {
      case "status":
        return json(new RunStatus(dataPath("status.json")).read());
      case "vacancy": {
        const id = new URL(request.url).searchParams.get("id")?.trim() ?? "";
        const stored = storedVacancy(id);
        if (!stored) throw new Error("Полный текст этой вакансии ещё не сохранён.");
        return json({ ok: true, fields: stored });
      }
      case "report":
        return json(new ReportStore(dataPath("report.json")).load());
      case "config":
        if (request.method === "POST") {
          const payload = await readJson(request);
          const config = Config.save({
            source_url: String(payload.source_url ?? "").trim(),
            max_vacancies: Number(payload.max_vacancies ?? 20),
            page_size: Number(payload.page_size ?? 10),
            schedule_enabled: Boolean(payload.schedule_enabled ?? false),
            interval_minutes: Number(payload.interval_minutes ?? 360),
            llm_base_url: String(payload.llm_base_url ?? "").trim(),
            llm_model: String(payload.llm_model ?? "").trim(),
            llm_api_key: payload.llm_api_key == null ? "********" : String(payload.llm_api_key),
            llm_timeout_sec: Number(payload.llm_timeout_sec ?? 90),
          });
          return json({ ok: true, config: config.publicArray() });
        }
        return json(Config.load().publicArray());
      case "run":
        return startRun([]);
      case "demo":
        return startRun(["--fixture", path.join(root, "fixtures", "sample_api_response.json")]);
      case "fixture":
        return await startFixture(request);
      case "resume":
        return await draft(request);
      case "letter":
        return await letter(request);
      case "sample-resume":
        return json({ text: fs.readFileSync(path.join(root, "fixtures", "sample_resume.txt"), "utf8") });
      default:
        return json({ ok: false, error: "Неизвестное действие." }, 404);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ ok: false, error: message }, 400);
  }
}

function startRun(args: string[]): Response {
  const runner = new Runner();
  if (runner.isLocked()) return json({ ok: false, error: "Проверка уже выполняется." }, 409);
  const parsed = parseRunArgs(args);
  void runner.execute(parsed.fixture, parsed.max, parsed.pageSize).catch(() => undefined);
  return json({ ok: true, started: true });
}

function parseRunArgs(args: string[]): { fixture: string | null; max: number | null; pageSize: number | null } {
  let fixture: string | null = null;
  let max: number | null = null;
  let pageSize: number | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--fixture" && args[i + 1]) fixture = args[++i];
    else if (args[i] === "--max" && args[i + 1]) max = Number(args[++i]);
    else if (args[i] === "--page-size" && args[i + 1]) pageSize = Number(args[++i]);
  }
  return { fixture, max, pageSize };
}

async function startFixture(request: Request): Promise<Response> {
  const target = dataPath("inbox.json");
  const type = request.headers.get("content-type") ?? "";
  let raw = "";
  if (type.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    if (!file || typeof file !== "object" || !("text" in file)) throw new Error("Нужен JSON в формате ответа API или массив вакансий.");
    const blob = file as Blob;
    if (blob.size > 5_000_000) throw new Error("Файл больше 5 МБ.");
    raw = await blob.text();
  } else {
    raw = await request.text();
    if (raw.length > 5_000_000) throw new Error("JSON больше 5 МБ.");
  }
  const decoded = parseFixture(raw);
  const ready = readyReport(decoded);
  if (ready) return loadReadyReport(ready.items, ready.cards);
  const vacancies = unwrap(decoded);
  if (vacancies.length === 0) throw new Error("В файле нет вакансий. Нужен ответ API «Работа в России», массив вакансий или ранее сохранённый отчёт.");
  fs.mkdirSync(dataPath(), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(decoded));
  return startRun(["--fixture", target]);
}

function loadReadyReport(items: Vacancy[], cards: Vacancy[]): Response {
  new ReportStore(dataPath("report.json")).saveSuccess({
    mode: "fixture",
    source_url: null,
    pages_fetched: 0,
    source_total: items.length,
    vacancies_processed: items.length,
    ai_used: false,
    ai_error: null,
    items,
    cards,
  });
  new RunStatus(dataPath("status.json")).update({
    state: "ok",
    message: "Отчёт загружен из JSON",
    processed: items.length,
    total: items.length,
    finished_at: isoNow(),
  });
  return json({ ok: true, loaded: items.length });
}

async function draft(request: Request): Promise<Response> {
  const payload = await readJson(request);
  const vacancyId = String(payload.vacancy_id ?? "").trim();
  const individual = Boolean(payload.individual);
  const resume = individual ? "" : String(payload.resume ?? "").trim();
  if (vacancyId === "") throw new Error("Выберите вакансию.");
  if (!payload.options && !individual && resume === "") throw new Error("Выберите вакансию и вставьте текст резюме.");
  const report = new ReportStore(dataPath("report.json")).load();
  const card = (report.cards as Vacancy[]).find((item) => item.vacancy_id === vacancyId);
  if (!card) throw new Error("Этой вакансии нет в текущем отчёте. Сначала сформируйте отчёт.");
  const stored = storedVacancy(vacancyId) ?? {};
  const source = {
    ...stored,
    "job-name": stored["job-name"] || card.job_name || "",
    company_name: stored.company_name || card.company || "",
    salary: stored.salary || card.salary || "",
    schedule: stored.schedule || card.schedule || "",
    employment: stored.employment || card.employment || "",
    addresses: Array.isArray(stored.addresses) && stored.addresses.length ? stored.addresses : (card.address ? [card.address] : []),
  };
  if (payload.options) {
    const options = await new LlmClient(Config.load()).fillOptions(source);
    return json({ vacancy_id: vacancyId, options });
  }
  const remarks = ((report.items as Vacancy[]).find((item) => item.vacancy_id === vacancyId)?.remarks ?? []) as PublicRemark[];
  const text = await new LlmClient(Config.load()).draftResume(source, resume, remarks);
  const result = {
    vacancy_id: vacancyId,
    job_name: card.job_name ?? "",
    resume: text.resume,
    draft: text.draft,
    created_at: isoNow(),
  };
  return json(result);
}

async function letter(request: Request): Promise<Response> {
  const payload = await readJson(request);
  const vacancyId = String(payload.vacancy_id ?? "").trim();
  const report = new ReportStore(dataPath("report.json")).load();
  const card = (report.cards as Vacancy[]).find((item) => item.vacancy_id === vacancyId);
  if (!card) throw new Error("Этой вакансии нет в текущем отчёте. Сначала сформируйте отчёт.");
  const remarks = ((report.items as Vacancy[]).find((item) => item.vacancy_id === vacancyId)?.remarks ?? []) as PublicRemark[];
  const jobName = String(card.job_name || "Вакансия");
  if (remarks.length === 0) {
    return json({
      letter: `Здравствуйте!\n\nПо вакансии «${jobName}» в отчёте нет замечаний. Уточнения не требуются.\n\nСпасибо!`,
      questions: [],
      ai: false,
    });
  }
  const text = await new LlmClient(Config.load()).draftLetter(jobName, remarks);
  const questions = text.questions.length ? text.questions : remarks.map((remark) => remark.recommendation);
  return json({ letter: text.letter, questions, ai: true });
}

function storedVacancy(id: string): Vacancy | null {
  const snapshotPath = dataPath("vacancies.json");
  if (fs.existsSync(snapshotPath)) {
    try {
      const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
      if (snapshot?.[id] && typeof snapshot[id] === "object") return snapshot[id];
    } catch {
      /* fall through */
    }
  }
  for (const filePath of [dataPath("inbox.json"), path.join(root, "fixtures", "sample_api_response.json")]) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const decoded = JSON.parse(fs.readFileSync(filePath, "utf8"));
      for (const vacancy of unwrap(decoded)) {
        if (String(vacancy.id ?? "") === id) return fields(vacancy);
      }
    } catch {
      /* next file */
    }
  }
  return null;
}

async function readJson(request: Request): Promise<Vacancy> {
  const decoded = await request.json().catch(() => null);
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("Ожидался JSON.");
  return decoded as Vacancy;
}

function parseFixture(raw: string): unknown {
  const text = raw.replace(/^\uFEFF/, "").trim();
  try {
    return JSON.parse(text || "null");
  } catch {
    throw new Error("Файл не является JSON. Нужен ответ API «Работа в России», массив вакансий или сохранённый отчёт.");
  }
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}
