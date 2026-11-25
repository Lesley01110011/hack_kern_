import { createHash } from "node:crypto";
import { RULES_VERSION } from "./version";
import type { Vacancy } from "./types";

export function unwrap(payload: unknown): Vacancy[] {
  if (!payload || typeof payload !== "object") return [];
  const data = payload as Vacancy;
  const results = data.results;
  if (results && typeof results === "object" && !Array.isArray(results)) {
    if (Array.isArray(results.vacancies)) return unwrapList(results.vacancies);
    if (Array.isArray(results.vacancy)) return unwrapList(results.vacancy);
  }
  if (Array.isArray(results)) return unwrapList(results);
  if (Array.isArray(data.vacancies)) return unwrapList(data.vacancies);
  if (Array.isArray(data.data)) return unwrapList(data.data);
  if (data.vacancy && typeof data.vacancy === "object" && !Array.isArray(data.vacancy)) return [data.vacancy];
  if (Array.isArray(payload)) return unwrapList(payload);
  if (data.id != null || data["job-name"] != null || data.job_name != null) return [data];
  return [];
}

export function readyReport(payload: unknown): { items: Vacancy[]; cards: Vacancy[] } | null {
  const source = Array.isArray(payload) ? { items: payload } : payload;
  if (!source || typeof source !== "object") return null;
  const record = source as Vacancy;
  const items = Array.isArray(record.items) ? record.items : null;
  if (!items || items.length === 0 || !items.every(isReadyItem)) return null;
  const normalized = items.map((item) => ({
    vacancy_id: String(item.vacancy_id).trim(),
    vac_url: String(item.vac_url ?? "").trim() || null,
    remarks: Array.isArray(item.remarks) ? item.remarks : [],
  }));
  const cards = Array.isArray(record.cards) && record.cards.length === normalized.length
    ? record.cards
    : normalized.map((item, index) => {
      const raw = items[index];
      return {
        vacancy_id: item.vacancy_id,
        vac_url: item.vac_url,
        job_name: String(raw.job_name ?? raw["job-name"] ?? item.vacancy_id),
        company: String(raw.company ?? raw.company_name ?? ""),
        salary: String(raw.salary ?? ""),
        salary_min: raw.salary_min ?? null,
        salary_max: raw.salary_max ?? null,
        schedule: String(raw.schedule ?? ""),
        employment: String(raw.employment ?? ""),
        address: String(raw.address ?? ""),
        remark_count: item.remarks.length,
      };
    });
  return { items: normalized, cards };
}

function isReadyItem(row: unknown): row is Vacancy {
  if (!row || typeof row !== "object") return false;
  const item = row as Vacancy;
  return Array.isArray(item.remarks) && String(item.vacancy_id ?? "").trim() !== "" && item["job-name"] == null && item.duty == null;
}

function unwrapList(list: unknown[]): Vacancy[] {
  const out: Vacancy[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const row = item as Vacancy;
    if (row.vacancy && typeof row.vacancy === "object") {
      out.push(row.vacancy);
      continue;
    }
    out.push(row);
  }
  return out;
}

export function vacancyId(vacancy: Vacancy, fallbackIndex: number): string {
  const id = String(vacancy.id ?? "").trim();
  return id !== "" ? id : `missing-id-${fallbackIndex}`;
}

export function vacancyUrl(vacancy: Vacancy): string | null {
  const url = String(vacancy.vac_url ?? "").trim();
  return url !== "" ? url : null;
}

function pick(vacancy: Vacancy, keys: string[]): unknown {
  for (const key of keys) {
    const value = vacancy[key];
    if (value != null && String(value).trim() !== "") return value;
  }
  return undefined;
}

export function fields(vacancy: Vacancy): Vacancy {
  const rawRequirement = vacancy.requirement ?? [];
  const requirement = Array.isArray(rawRequirement) || (rawRequirement && typeof rawRequirement === "object")
    ? rawRequirement
    : { text: String(rawRequirement) };
  const company = pick(vacancy, ["company", "employer", "organization"]);
  const companyName = typeof company === "string"
    ? company
    : company && typeof company === "object" && !Array.isArray(company)
      ? String((company as Vacancy).name ?? (company as Vacancy).title ?? "")
      : String(pick(vacancy, ["company_name", "companyName", "employer_name"]) ?? "");
  return {
    id: String(vacancy.id ?? vacancy.vacancy_id ?? ""),
    "job-name": String(pick(vacancy, ["job-name", "job_name", "jobName", "name", "title", "position"]) ?? ""),
    typicalPosition: String(pick(vacancy, ["typicalPosition", "typical_position"]) ?? ""),
    duty: String(pick(vacancy, ["duty", "duties", "responsibilities"]) ?? ""),
    requirements: String(pick(vacancy, ["requirements", "requirement_text"]) ?? ""),
    qualification: String(vacancy.qualification ?? ""),
    requirement: {
      education: String(requirement.education ?? ""),
      qualification: String(requirement.qualification ?? ""),
      experience: requirement.experience ?? null,
    },
    salary: String(vacancy.salary ?? ""),
    salary_min: vacancy.salary_min ?? null,
    salary_max: vacancy.salary_max ?? null,
    currency: String(vacancy.currency ?? ""),
    schedule: String(vacancy.schedule ?? ""),
    shift: vacancy.shift ?? [],
    employment: String(vacancy.employment ?? ""),
    addresses: locations(vacancy),
    conditions: String(vacancy.conditions ?? ""),
    skills: vacancy.skills ?? [],
    benefitDetails: String(vacancy.benefitDetails ?? ""),
    company_name: companyName,
    work_places: vacancy.work_places ?? null,
  };
}

export function locations(vacancy: Vacancy): string[] {
  const direct = pick(vacancy, ["address", "location", "workplace"]);
  let addresses = vacancy.addresses?.address ?? vacancy.addresses ?? direct ?? null;
  if (typeof addresses === "string") return addresses.trim() ? [addresses.trim()] : [];
  if (!addresses || typeof addresses !== "object") return [];
  if (!Array.isArray(addresses) && (addresses.location != null || addresses.address != null)) {
    addresses = [addresses];
  }
  if (!Array.isArray(addresses)) return [];
  const out: string[] = [];
  for (const address of addresses) {
    if (!address || typeof address !== "object") continue;
    const location = String(address.location ?? address.address ?? "").trim();
    if (location !== "") out.push(location);
  }
  return out;
}

export function hashVacancy(vacancy: Vacancy, modelStamp: string): string {
  const payload = fields(vacancy);
  delete payload.company_name;
  const json = JSON.stringify(payload);
  return createHash("sha1").update(`${RULES_VERSION}|${modelStamp}|${json}`).digest("hex");
}
