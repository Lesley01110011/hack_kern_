import https from "node:https";
import { randomUUID } from "node:crypto";
import { Config } from "./config";
import { analyzerPrompt, factsPrompt, individualResumePrompt, letterPrompt, optionsPrompt, resumePrompt } from "./prompt";
import { modelRefused } from "./text";
import type { PublicRemark, RemarkModel, Vacancy } from "./types";

export class LlmClient implements RemarkModel {
  constructor(private config: Config) {}

  isConfigured(): boolean {
    return this.config.llmConfigured();
  }

  notConfiguredMessage(): string {
    return "Модель не подключена. По умолчанию используется GigaChat: адрес https://api.giga.chat/v1, модель GigaChat-2 и ключ авторизации из личного кабинета.";
  }

  async suggest(fields: Vacancy, suspected: PublicRemark[]): Promise<Vacancy[]> {
    const payload = {
      fields,
      already_suspected: suspected,
      task: "Верни полный массив remarks. Подтверждённые пункты перепиши своими словами. Отбрось пункт, только если по полям условие уже однозначно. Добавь пропущенные неоднозначности и противоречия. Если проблем нет, верни пустой remarks.",
    };
    const content = await this.complete(analyzerPrompt(), JSON.stringify(payload));
    return this.remarksFromContent(content);
  }

  async draftResume(fields: Vacancy, resume: string, remarks: PublicRemark[] = []): Promise<{ resume: string; draft: string }> {
    if (!this.isConfigured()) throw new Error(this.notConfiguredMessage());
    const payload = {
      vacancy: {
        "job-name": fields["job-name"] ?? "",
        company: fields.company_name ?? "",
        duty: fields.duty ?? "",
        requirements: fields.requirements ?? "",
        requirement: fields.requirement ?? [],
        salary: fields.salary ?? "",
        schedule: fields.schedule ?? "",
        employment: fields.employment ?? "",
        addresses: fields.addresses ?? [],
        qualification: fields.qualification ?? "",
        skills: fields.skills ?? "",
        typicalPosition: fields.typicalPosition ?? "",
      },
      remarks,
      ...(resume.trim() ? { resume } : { task: "Собери новое резюме только по полям этой вакансии." }),
    };
    const individual = resume.trim() === "";
    try {
      const content = await this.complete(individual ? individualResumePrompt() : resumePrompt(), JSON.stringify(payload), false, individual ? 0.8 : 0.2);
      const parsed = this.resumeFromContent(content);
      return { ...parsed, draft: withPortalGaps(parsed.draft, resume, fields) };
    } catch (error) {
      if (!resume.trim()) throw error;
      return this.draftFromResumeFacts(fields, resume, payload);
    }
  }

  private async draftFromResumeFacts(fields: Vacancy, resume: string, payload: Vacancy): Promise<{ resume: string; draft: string }> {
    try {
      const content = await this.complete(factsPrompt(), JSON.stringify({ ...payload, resume, task: "Только факты резюме и пробелы по вакансии." }), false, 0.1);
      const parsed = this.resumeFromContent(content);
      return { resume, draft: withPortalGaps(parsed.draft || resume, resume, fields) };
    } catch {
      return { resume, draft: withPortalGaps(localFactsDraft(resume, fields), resume, fields) };
    }
  }

  async fillOptions(fields: Vacancy): Promise<string> {
    if (!this.isConfigured()) throw new Error(this.notConfiguredMessage());
    const payload = {
      vacancy: {
        "job-name": fields["job-name"] ?? "",
        company: fields.company_name ?? "",
        duty: fields.duty ?? "",
        requirements: fields.requirements ?? "",
        requirement: fields.requirement ?? [],
        schedule: fields.schedule ?? "",
        employment: fields.employment ?? "",
        addresses: fields.addresses ?? [],
        qualification: fields.qualification ?? "",
        skills: fields.skills ?? "",
      },
    };
    const text = (await this.complete(optionsPrompt(), JSON.stringify(payload), false, 0.7)).trim();
    if (modelRefused(text)) throw new Error("GigaChat не ответил по этой вакансии. Резюме не заменено.");
    return text;
  }

  async draftLetter(jobName: string, remarks: PublicRemark[]): Promise<{ letter: string; questions: string[] }> {
    if (!this.isConfigured()) throw new Error(this.notConfiguredMessage());
    const content = await this.complete(letterPrompt(), JSON.stringify({ job_name: jobName, remarks }), true);
    return this.letterFromContent(content);
  }

  private async complete(system: string, user: string, json = true, temperature = 0.1): Promise<string> {
    if (!this.isConfigured()) throw new Error(this.notConfiguredMessage());
    try {
      return await this.request(system, user, json, temperature);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (json && message.includes("HTTP 400")) return this.request(system, user, false, temperature);
      throw error;
    }
  }

  private async request(system: string, user: string, json: boolean, temperature = 0.1): Promise<string> {
    const base = this.config.llmBaseUrl();
    const giga = isGigaChat(base);
    const body: Vacancy = {
      model: this.config.llmModel(),
      temperature,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    };
    if (json && !giga) body.response_format = { type: "json_object" };
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    const key = this.config.llmApiKey();
    if (giga) headers.Authorization = `Bearer ${await gigaAccessToken(key)}`;
    else if (key !== "") headers.Authorization = `Bearer ${key}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.llmTimeout() * 1000);
    try {
      const response = giga
        ? await gigaPost(`${base}/chat/completions`, headers, JSON.stringify(body), controller.signal)
        : await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        }).then(async (result) => ({ status: result.status, text: await result.text() }));
      if (response.status < 200 || response.status >= 300) {
        const hint = publicHint(response.text, key);
        throw new Error(`Модель ответила HTTP ${response.status}${hint !== "" ? `: ${hint}` : ""}`);
      }
      const decoded = JSON.parse(response.text);
      const content = decoded?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.trim() === "") throw new Error("Модель вернула пустой ответ.");
      return content;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new Error("Модель недоступна: нет ответа");
      if (error instanceof Error && (error.message.startsWith("Модель") || error.message.startsWith("GigaChat"))) throw error;
      const message = error instanceof Error ? error.message : "нет ответа";
      throw new Error(`Модель недоступна: ${message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private remarksFromContent(content: string): Vacancy[] {
    let text = content.trim().replace(/^```(?:json)?\s*|\s*```$/u, "");
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          data = JSON.parse(match[0]);
        } catch {
          data = null;
        }
      }
    }
    if (!data || typeof data !== "object") throw new Error("Модель вернула не JSON.");
    if (Array.isArray((data as Vacancy).remarks)) return (data as Vacancy).remarks;
    if (Array.isArray(data)) return data;
    throw new Error("В ответе модели нет массива remarks.");
  }

  private resumeFromContent(content: string): { resume: string; draft: string } {
    const text = content.trim();
    if (modelRefused(text)) throw new Error("GigaChat не ответил по этой вакансии. Резюме не заменено.");
    const marked = text.match(/===\s*РЕЗЮМЕ\s*===\s*([\s\S]*?)\s*===\s*ЧЕРНОВИК\s*===\s*([\s\S]*)/i);
    if (marked) return { resume: marked[1].trim(), draft: marked[2].trim() };
    const record = this.parseRecord(text);
    const draft = String(record?.draft ?? "").trim();
    const resume = String(record?.resume ?? "").trim();
    const gapTail = /(?:^|\n)\s*(?:===\s*)?(?:чего не хватает|чего нет в резюме|не подтверждено резюме)[\s\S]*$/i;
    if (draft || resume) return { resume: resume || draft.replace(gapTail, "").trim(), draft: draft || resume };
    return { resume: text.replace(gapTail, "").trim(), draft: text };
  }

  private parseRecord(content: string): Vacancy | null {
    let text = content.trim().replace(/^```(?:json)?\s*|\s*```$/u, "");
    let data: unknown = null;
    try {
      data = JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          data = JSON.parse(match[0]);
        } catch {
          data = null;
        }
      }
    }
    return data && typeof data === "object" ? data as Vacancy : null;
  }

  private letterFromContent(content: string): { letter: string; questions: string[] } {
    const record = this.parseRecord(content);
    const letter = String(record?.letter ?? "").trim();
    const questions = Array.isArray(record?.questions) ? record.questions.map((item: unknown) => String(item).trim()).filter(Boolean) : [];
    if (letter) return { letter, questions };
    return { letter: content.trim(), questions };
  }
}

function contentWords(value: string): Set<string> {
  const skip = new Set(["опыт", "работы", "работа", "образование", "навыки", "резюме", "должность", "вакансия", "требования", "обязанности"]);
  return new Set(value.toLowerCase().split(/[^a-zа-яё0-9]+/i).filter((word) => word.length > 4 && !skip.has(word)));
}

function withPortalGaps(draft: string, resume: string, fields: Vacancy): string {
  if (/чего не хватает|чего нет в резюме|не подтверждено резюме/i.test(draft)) return draft;
  return `${draft.trim()}\n\n=== ЧЕГО НЕ ХВАТАЕТ ===\n${portalGaps(resume, fields)}`;
}

function portalGaps(resume: string, fields: Vacancy): string {
  const requirement = fields.requirement && typeof fields.requirement === "object" ? fields.requirement as Vacancy : {};
  const haystack = resume.toLowerCase();
  const gaps: string[] = [];
  const education = String(requirement.education || "").trim();
  if (education && !haystack.includes(education.toLowerCase())) gaps.push(`В резюме не указано образование: ${education}.`);
  const experience = String(requirement.experience ?? "").trim();
  if (experience && experience !== "0" && !haystack.includes(experience)) gaps.push(`В резюме не указан стаж, вакансия просит ${experience}.`);
  for (const part of `${fields.duty || ""}. ${fields.requirements || ""}`.split(/[.;\n]+/)) {
    const item = part.replace(/\s+/g, " ").trim();
    if (item.length < 12 || item.length > 180) continue;
    if (haystack.includes(item.toLowerCase())) continue;
    gaps.push(`Вакансия на портале требует: ${item}.`);
    if (gaps.length >= 6) break;
  }
  return gaps.length ? gaps.join("\n") : "ничего";
}

function localFactsDraft(resume: string, fields: Vacancy): string {
  const job = String(fields["job-name"] || "Вакансия");
  const requirement = fields.requirement && typeof fields.requirement === "object" ? fields.requirement as Vacancy : {};
  const vacancyText = [fields.duty, fields.requirements, fields.qualification, requirement.education, requirement.qualification, job].map((item) => String(item || "")).join(" ");
  const vacancyWords = contentWords(vacancyText);
  const matched = resume.split("\n").map((line) => line.trim()).filter((line) => {
    if (!line || /^(резюме|желаемая должность|целевая должность|должность)\b/i.test(line)) return false;
    const words = [...contentWords(line)];
    return words.filter((word) => vacancyWords.has(word)).length >= 2;
  });
  const draftBody = matched.length
    ? matched.join("\n")
    : "Подходящих сведений в резюме для этой вакансии нет.";
  return `Целевая должность: ${job}\n\n${draftBody}\n\n=== ЧЕГО НЕ ХВАТАЕТ ===\n${portalGaps(resume, fields)}`;
}

function isGigaChat(base: string): boolean {
  return /giga\.chat|gigachat|sberbank\.ru/i.test(base);
}

let gigaToken: { key: string; token: string; expiresAt: number } | null = null;

async function gigaAccessToken(authKey: string): Promise<string> {
  const key = authKey.replace(/^Basic\s+/i, "").trim();
  if (key.startsWith("eyJ")) return key;
  const now = Date.now();
  if (gigaToken && gigaToken.key === key && gigaToken.expiresAt - 60_000 > now) return gigaToken.token;
  const response = await gigaPost("https://ngw.devices.sberbank.ru:9443/api/v2/oauth", {
    Authorization: `Basic ${key}`,
    RqUID: randomUUID(),
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  }, "scope=GIGACHAT_API_PERS");
  if (response.status < 200 || response.status >= 300) {
    throw new Error(response.status === 401
      ? "GigaChat не принял ключ авторизации."
      : `GigaChat не выдал токен: HTTP ${response.status}`);
  }
  const data = JSON.parse(response.text);
  const token = String(data.access_token ?? "");
  if (!token) throw new Error("GigaChat не выдал токен доступа.");
  let expiresAt = Number(data.expires_at ?? 0);
  if (expiresAt > 0 && expiresAt < 10_000_000_000) expiresAt *= 1000;
  if (!expiresAt) expiresAt = Date.now() + 25 * 60 * 1000;
  gigaToken = { key, token, expiresAt };
  return token;
}

function gigaPost(url: string, headers: Record<string, string>, body: string, signal?: AbortSignal): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method: "POST",
      headers,
      rejectUnauthorized: false,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
    });
    const fail = (error: Error) => reject(error.name === "AbortError" ? error : new Error(`Модель недоступна: ${error.message}`));
    req.on("error", fail);
    signal?.addEventListener("abort", () => {
      const error = new Error("Модель недоступна: нет ответа");
      error.name = "AbortError";
      req.destroy(error);
    }, { once: true });
    req.write(body);
    req.end();
  });
}

function publicHint(raw: string, secret: string): string {
  let text = raw.trim();
  if (secret) text = text.replaceAll(secret, "");
  return text.length > 240 ? text.slice(0, 240) : text;
}
