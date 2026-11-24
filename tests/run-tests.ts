import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Analyzer } from "../lib/analyzer";
import { fields, readyReport, unwrap } from "../lib/normalizer";
import { ReportStore } from "../lib/report-store";
import { RuleAnalyzer } from "../lib/rule-analyzer";
import { Runner } from "../lib/runner";
import type { PublicRemark, RemarkModel, Vacancy } from "../lib/types";
import { VacancySource } from "../lib/vacancy-source";
import { root } from "../lib/root";

let failed = 0;

function check(ok: boolean, name: string, debug?: unknown): void {
  if (ok) {
    process.stdout.write(`OK   ${name}\n`);
    return;
  }
  failed++;
  process.stdout.write(`FAIL ${name}\n`);
  if (debug !== undefined) process.stdout.write(`${JSON.stringify(debug, null, 2)}\n`);
}

function topicsOf(vacancy: Vacancy): string[] {
  return new RuleAnalyzer().analyze(vacancy).map((remark) => remark.topic);
}

function findVacancy(payload: unknown, id: string): Vacancy {
  const found = unwrap(payload).find((vacancy) => vacancy.id === id);
  if (!found) throw new Error(`Нет вакансии ${id}`);
  return found;
}

class SliceHttp {
  urls: string[] = [];
  constructor(private ids: string[]) {}
  async getJson(url: string) {
    this.urls.push(url);
    const query = new URL(url).searchParams;
    const offset = Number(query.get("offset") ?? 0);
    const limit = Number(query.get("limit") ?? 10);
    const slice = this.ids.slice(offset, offset + limit);
    return {
      meta: { total: this.ids.length, limit },
      results: { vacancies: slice.map((id) => ({ vacancy: { id, "job-name": "Инженер" } })) },
    };
  }
}

const offline: RemarkModel = {
  isConfigured: () => false,
  async suggest() {
    return [];
  },
};

const talker: RemarkModel = {
  isConfigured: () => true,
  async suggest(): Promise<Vacancy[]> {
    return [
      {
        topic: "обязанности",
        field: "duty",
        quote: "",
        problem: "Обязанности якобы отсутствуют.",
        recommendation: "Заполните duty.",
      },
      {
        topic: "график",
        field: "schedule",
        quote: "ночная смена по луне",
        problem: "Выдуманный график.",
        recommendation: "Уточните график.",
      },
      {
        topic: "график",
        field: "schedule",
        quote: "Гибкий график",
        problem: "Не указаны дни и часы.",
        recommendation: "Уточните дни, смены и часы и запишите их в schedule.",
      },
    ];
  },
};

async function main() {
const payload = JSON.parse(fs.readFileSync(path.join(root, "fixtures", "sample_api_response.json"), "utf8"));
check(payload && typeof payload === "object", "fixture json");
check(unwrap(payload).length === 3, "unwrap api envelope");
check(fields({ job_name: "Кассир", company: "МБУ «Пример»", address: "Калининград" })["job-name"] === "Кассир", "file aliases");
check(fields({ job_name: "Кассир", company: "МБУ «Пример»", address: "Калининград" }).company_name === "МБУ «Пример»", "file company");
const ready = readyReport([{ vacancy_id: "file-1", vac_url: null, remarks: [], job_name: "Кассир" }]);
check(ready?.items.length === 1 && ready.cards[0].job_name === "Кассир", "ready report keeps file data");

const clear = findVacancy(payload, "clear-metro");
const bad = findVacancy(payload, "bad-assistant");
const guard = findVacancy(payload, "clear-guard");

check(topicsOf(clear).length === 0, "clear vacancy has no remarks", new RuleAnalyzer().analyze(clear));
check(topicsOf(guard).length === 0, "shift with hours has no remarks", new RuleAnalyzer().analyze(guard));

const badTopics = topicsOf(bad);
for (const topic of ["название_должности", "обязанности", "требования", "оплата", "график", "место_работы", "тип_занятости"]) {
  check(badTopics.includes(topic), `bad vacancy topic ${topic}`, badTopics);
}
check(badTopics.filter((topic) => topic === "требования").length >= 2, "education and experience", badTopics);

const quoted = new RuleAnalyzer().analyze(bad);
const duty = quoted.find((remark) => remark.field === "duty")!;
check(duty.quote === "", "omission quote is empty", duty);
const salary = quoted.find((remark) => remark.topic === "оплата")!;
check(
  salary.quote.includes("80000") && salary.quote.includes("40000") && salary.quote.includes("30000"),
  "salary quote has both bounds",
  salary,
);

const either = structuredClone(clear);
either.requirements = "Среднее общее или среднее специальное образование, можно без опыта работы";
either.requirement.education = "Общее образование";
either.requirement.experience = 0;
check(!topicsOf(either).includes("требования"), "alternative education is not a contradiction", topicsOf(either));

const samePay = structuredClone(clear);
samePay.salary = "от 45000";
check(!topicsOf(samePay).includes("оплата"), "salary text may omit the max that is already in the field", topicsOf(samePay));

const generic = structuredClone(clear);
generic["job-name"] = "Специалист";
check(topicsOf(generic).includes("название_должности"), "generic title", topicsOf(generic));

const multi = structuredClone(clear);
multi.addresses = {
  address: [
    { location: "Калининградская область, г. Калининград, ул. Ленина, д. 1" },
    { location: "Калининградская область, г. Советск, ул. Победы, д. 2" },
  ],
};
check(topicsOf(multi).includes("место_работы"), "several addresses", topicsOf(multi));

const http = new SliceHttp(["a", "b", "c", "d", "e"]);
const fetched = await new VacancySource(http).fetch("http://opendata.trudvsem.ru/api/v1/vacancies/region/39", 10, 4);
check(fetched.pages === 2, "limit forces two pages", http.urls);
check(fetched.vacancies.length === 4, "respects max vacancies", fetched.vacancies.map((item) => item.id));
check(http.urls[0].includes("offset=0") && http.urls[1].includes("offset=2"), "second page offset", http.urls);

const dupHttp = new SliceHttp(["a", "b", "b", "c"]);
const dup = await new VacancySource(dupHttp).fetch("http://example.test/vacancies", 2, 10);
check(dup.vacancies.map((item) => item.id).join() === "a,b,c", "one vacancy per id while paging", dup.vacancies.map((item) => item.id));

const dir = path.join(os.tmpdir(), `kantkod-${Math.random().toString(16).slice(2, 10)}`);
fs.mkdirSync(dir);
const store = new ReportStore(path.join(dir, "report.json"));
store.saveSuccess({
  mode: "api",
  items: [{ vacancy_id: "keep", vac_url: null, remarks: [] }],
  cards: [],
  vacancies_processed: 1,
});
store.fail("Портал «Работа в России» недоступен: HTTP 503");
const kept = store.load();
check(kept.status === "error", "api error is recorded");
check((kept.items[0] as Vacancy).vacancy_id === "keep", "last successful items stay", kept);
check(String(kept.error).includes("недоступен"), "error text is kept");

const doubled = { results: { vacancies: [{ vacancy: clear }, { vacancy: clear }] } };
const fixturePath = path.join(dir, "in.json");
fs.writeFileSync(fixturePath, JSON.stringify(doubled));
const runner = new Runner(dir, null, offline);
await runner.execute(fixturePath);
const report = JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8"));
check(report.items.length === 1, "rerun keeps a single result per id", report.items ?? null);
check(JSON.stringify(report.items[0].remarks) === "[]", "clear fixture item is empty");

const ai = new Analyzer(new RuleAnalyzer(), talker);
const onClear = await ai.analyze(clear);
check(onClear.ai === true, "model is used");
check(onClear.remarks.length === 0, "ungrounded and false omissions are dropped", onClear.remarks);
const onBad = await ai.analyze(bad);
check(onBad.ai === true, "model used on bad vacancy");
const aiTopics = onBad.remarks.map((remark: PublicRemark) => remark.topic);
check(aiTopics.includes("обязанности"), "hard gap is kept if the model skips it", onBad.remarks);
check(aiTopics.includes("оплата"), "salary contradiction is kept", aiTopics);
check(aiTopics.includes("график"), "grounded model remark is kept", aiTopics);

try {
  await runner.execute(path.join(dir, "missing.json"));
  check(false, "missing fixture throws");
} catch (error) {
  check(error instanceof Error && error.message.includes("не найден"), "missing fixture message");
}
const after = JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8"));
check(after.status === "error" && after.items?.[0]?.vacancy_id === "clear-metro", "failed run keeps previous report", after);

process.stdout.write(failed === 0 ? "ALL PASSED\n" : `FAILED ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
}

main();
