export type Vacancy = Record<string, any>;

export type Remark = {
  topic: string;
  field: string;
  quote: string;
  problem: string;
  recommendation: string;
  _severity?: "hard" | "soft";
};

export type PublicRemark = Omit<Remark, "_severity">;

export interface HttpClient {
  getJson(url: string): Promise<Vacancy>;
}

export interface RemarkModel {
  isConfigured(): boolean;
  suggest(fields: Vacancy, suspected: PublicRemark[]): Promise<Vacancy[]>;
  notConfiguredMessage?(): string;
}
