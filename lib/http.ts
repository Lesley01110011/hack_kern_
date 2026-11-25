import type { HttpClient, Vacancy } from "./types";

export class VacancySourceError extends Error {}

export class FetchHttpClient implements HttpClient {
  constructor(private timeoutMs = 30000) {}

  async getJson(url: string): Promise<Vacancy> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "paradon-transparent-vacancy/1.0" },
        signal: controller.signal,
        redirect: "follow",
      });
      if (!response.ok) {
        throw new VacancySourceError(`Портал «Работа в России» недоступен: HTTP ${response.status}`);
      }
      const decoded = await response.json();
      if (!decoded || typeof decoded !== "object") {
        throw new VacancySourceError("Портал «Работа в России» вернул не JSON.");
      }
      return decoded as Vacancy;
    } catch (error) {
      if (error instanceof VacancySourceError) throw error;
      const message = error instanceof Error ? error.message : "нет ответа";
      throw new VacancySourceError(`Портал «Работа в России» недоступен: ${message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
