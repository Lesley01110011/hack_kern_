export function modelRefused(value: string): boolean {
  return /генеративные языковые модели|чувствительными темами/i.test(value);
}

export function lower(value: string): string {
  return value.trim().toLowerCase();
}

export function len(value: string): number {
  return Array.from(value).length;
}

export function contains(haystack: string, needle: string): boolean {
  if (needle === "") return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

const EMPTY = new Set([
  "нет",
  "не указано",
  "не указан",
  "не указана",
  "не требуется",
  "отсутствует",
  "н/д",
  "н.д",
  "нет данных",
]);

export function meaningless(value: unknown): boolean {
  let text = lower(String(value ?? ""));
  text = text.replace(/^[ \t\n\r\0\v.\-—]+|[ \t\n\r\0\v.\-—]+$/g, "");
  return text === "" || EMPTY.has(text);
}

export function isoNow(): string {
  const date = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const tz = -date.getTimezoneOffset();
  const sign = tz >= 0 ? "+" : "-";
  const abs = Math.abs(tz);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}
