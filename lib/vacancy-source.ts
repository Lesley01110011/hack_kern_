import { unwrap } from "./normalizer";
import { VacancySourceError } from "./http";
import type { HttpClient, Vacancy } from "./types";

export class VacancySource {
  constructor(private http: HttpClient) {}

  async fetch(sourceUrl: string, pageSize: number, maxVacancies: number): Promise<{ vacancies: Vacancy[]; pages: number; total: number | null }> {
    pageSize = Math.max(1, pageSize);
    maxVacancies = Math.max(1, maxVacancies);
    if (maxVacancies >= 2 && pageSize >= maxVacancies) {
      pageSize = Math.floor(maxVacancies / 2);
      if (pageSize < 1) pageSize = 1;
    }
    const collected = new Map<string, Vacancy>();
    let offset = 0;
    let pages = 0;
    let total: number | null = null;
    while (collected.size < maxVacancies && pages < 50) {
      const url = this.withQuery(sourceUrl, { offset, limit: pageSize });
      const data = await this.http.getJson(url);
      pages++;
      if (total === null && data.meta?.total != null) total = Number(data.meta.total);
      const batch = unwrap(data);
      if (batch.length === 0) break;
      for (const vacancy of batch) {
        const id = String(vacancy.id ?? "").trim();
        if (id === "" || collected.has(id)) continue;
        collected.set(id, vacancy);
        if (collected.size >= maxVacancies) break;
      }
      offset += pageSize;
      if (batch.length < pageSize) break;
      if (total !== null && offset >= total) break;
    }
    return { vacancies: [...collected.values()], pages, total };
  }

  private withQuery(url: string, params: Record<string, number>): string {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new VacancySourceError("В настройках указан некорректный URL источника.");
    }
    for (const [key, value] of Object.entries(params)) parsed.searchParams.set(key, String(value));
    return parsed.toString();
  }
}
