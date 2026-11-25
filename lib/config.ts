import fs from "node:fs";
import { dataPath } from "./root";

export type ConfigData = {
  source_url?: string;
  max_vacancies?: number;
  page_size?: number;
  schedule_enabled?: boolean;
  interval_minutes?: number;
  llm_base_url?: string;
  llm_model?: string;
  llm_api_key?: string;
  llm_timeout_sec?: number;
};

export class Config {
  constructor(private data: ConfigData) {}

  static load(): Config {
    return new Config(read());
  }

  static save(patch: ConfigData): Config {
    const current = read();
    for (const [key, value] of Object.entries(patch)) {
      if (key === "llm_api_key" && (value == null || value === "********")) continue;
      (current as Record<string, unknown>)[key] = value;
    }
    current.max_vacancies = Math.max(1, Number(current.max_vacancies ?? 20));
    current.page_size = Math.max(1, Number(current.page_size ?? 10));
    current.interval_minutes = Math.max(1, Number(current.interval_minutes ?? 360));
    current.llm_timeout_sec = Math.max(10, Number(current.llm_timeout_sec ?? 90));
    current.schedule_enabled = Boolean(current.schedule_enabled ?? false);
    fs.mkdirSync(dataPath(), { recursive: true });
    fs.writeFileSync(dataPath("config.json"), JSON.stringify(current, null, 4));
    return new Config(current);
  }

  sourceUrl(): string {
    return String(this.data.source_url ?? "http://opendata.trudvsem.ru/api/v1/vacancies/region/39");
  }

  maxVacancies(): number {
    return Math.max(1, Number(this.data.max_vacancies ?? 20));
  }

  pageSize(): number {
    return Math.max(1, Number(this.data.page_size ?? 10));
  }

  scheduleEnabled(): boolean {
    return Boolean(this.data.schedule_enabled ?? false);
  }

  intervalMinutes(): number {
    return Math.max(1, Number(this.data.interval_minutes ?? 360));
  }

  llmBaseUrl(): string {
    return String(this.data.llm_base_url ?? "https://api.giga.chat/v1").replace(/\/+$/, "");
  }

  llmModel(): string {
    return String(this.data.llm_model ?? "GigaChat-2").trim();
  }

  llmApiKey(): string {
    return String(this.data.llm_api_key ?? "").trim();
  }

  llmTimeout(): number {
    return Math.max(10, Number(this.data.llm_timeout_sec ?? 90));
  }

  llmConfigured(): boolean {
    if (this.llmModel() === "") return false;
    const host = this.llmBaseUrl().toLowerCase();
    if (host.includes("localhost") || host.includes("127.0.0.1")) return true;
    return this.llmApiKey() !== "";
  }

  modelStamp(): string {
    if (!this.llmConfigured()) return "rules";
    return `${this.llmBaseUrl()}|${this.llmModel()}`;
  }

  publicArray() {
    const key = this.llmApiKey();
    return {
      source_url: this.sourceUrl(),
      max_vacancies: this.maxVacancies(),
      page_size: this.pageSize(),
      schedule_enabled: this.scheduleEnabled(),
      interval_minutes: this.intervalMinutes(),
      llm_base_url: this.llmBaseUrl(),
      llm_model: this.llmModel(),
      llm_api_key: key === "" ? "" : "********",
      llm_api_key_set: key !== "",
      llm_timeout_sec: this.llmTimeout(),
      llm_configured: this.llmConfigured(),
    };
  }
}

function read(): ConfigData {
  const path = dataPath("config.json");
  if (!fs.existsSync(path)) {
    const example = `${process.cwd()}/config.example.json`;
    fs.mkdirSync(dataPath(), { recursive: true });
    if (fs.existsSync(example)) fs.copyFileSync(example, path);
    else fs.writeFileSync(path, "{}");
  }
  try {
    const decoded = JSON.parse(fs.readFileSync(path, "utf8"));
    return decoded && typeof decoded === "object" ? decoded : {};
  } catch {
    return {};
  }
}
