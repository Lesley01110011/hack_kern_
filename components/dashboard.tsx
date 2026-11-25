"use client";

import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { modelRefused } from "../lib/text";

const topicFull: Record<string, string> = {
  название_должности: "Название должности",
  обязанности: "Обязанности",
  требования: "Требования",
  оплата: "Оплата",
  график: "График",
  место_работы: "Место работы",
  тип_занятости: "Тип занятости",
};

type Remark = {
  topic: string;
  field: string;
  quote: string;
  problem: string;
  recommendation: string;
};

type Card = {
  vacancy_id: string;
  vac_url?: string | null;
  job_name?: string;
  company?: string;
  salary?: string;
  salary_min?: number | null;
  salary_max?: number | null;
  schedule?: string;
  employment?: string;
  address?: string;
  remark_count?: number;
};

type Item = { vacancy_id: string; vac_url?: string | null; remarks: Remark[] };

type Report = {
  generated_at?: string | null;
  status?: string;
  error?: string | null;
  mode?: string | null;
  vacancies_processed?: number;
  items?: Item[];
  cards?: Card[];
};

type RunState = { state?: string; processed?: number; total?: number; message?: string; finished_at?: string | null };

type Fields = Record<string, unknown>;

type Settings = {
  source_url: string;
  max_vacancies: number;
  page_size: number;
  interval_minutes: number;
  schedule_enabled: boolean;
  llm_base_url: string;
  llm_model: string;
  llm_timeout_sec: number;
};

type View = "list" | "detail" | "letters" | "resume";

async function getJson(url: string, options?: RequestInit) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || "Запрос не выполнен");
  return data;
}

function money(card: Card) {
  const value = Number(card.salary_min || card.salary_max || 0);
  return Number.isFinite(value) ? value : 0;
}

function plain(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(plain).filter(Boolean).join(", ");
  if (typeof value === "object") return "";
  return String(value).trim();
}

function shortUrl(url: string) {
  return url.replace(/^https?:\/\//, "");
}

function scheduleLabel(settings: Settings | null) {
  if (!settings?.schedule_enabled) return "Выключено";
  const minutes = Number(settings.interval_minutes) || 0;
  if (minutes > 0 && minutes % 1440 === 0) return `Каждые ${minutes / 1440} дн.`;
  if (minutes > 0 && minutes % 60 === 0) return `Каждые ${minutes / 60} ч`;
  return `Каждые ${minutes} мин`;
}

function remarkKind(remark: Remark) {
  const quote = String(remark.quote || "").trim();
  if (!quote) return "пропуск";
  const quoted = [...quote.matchAll(/«[^»]+»/g)];
  if (quoted.length >= 2 || quote.includes(";")) return "противоречие";
  return "неоднозначно";
}

function quotedParts(quote: string) {
  const parts = [...String(quote || "").matchAll(/«([^»]{2,})»/g)].map((match) => match[1]);
  if (!parts.length && String(quote || "").trim()) parts.push(String(quote).trim());
  return parts;
}

function buildLetter(name: string, remarks: Remark[]) {
  if (!remarks.length) {
    return `Здравствуйте!\n\nПо вакансии «${name}» в отчёте нет замечаний. Уточнения не требуются.\n\nСпасибо!`;
  }
  const lines = remarks.map((remark, index) => `${index + 1}. ${remark.recommendation}`);
  return `Здравствуйте!\n\nМы готовим к публикации вакансию «${name}». Просим уточнить:\n${lines.join("\n")}\n\nСпасибо!`;
}

function cutBlock(text: string, pattern: RegExp) {
  const match = text.match(pattern);
  if (!match || match.index == null) return { head: text, tail: "" };
  return { head: text.slice(0, match.index).trim(), tail: text.slice(match.index + match[0].length).trim() };
}

function alignDraft(body: string, jobName: string) {
  const job = jobName.trim();
  if (!job) return body.trim();
  const lines = body.split("\n").filter((line) => {
    const role = line.match(/^\s*(?:желаемая должность|целевая должность|должность)\s*:\s*(.+?)\s*$/i);
    if (!role) return true;
    return role[1].replace(/\s+/g, " ").toLowerCase() === job.toLowerCase();
  });
  let text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!/^целевая должность\s*:/i.test(text)) text = `Целевая должность: ${job}\n\n${text}`;
  return text;
}

function draftIsBlank(body: string) {
  const rest = body
    .replace(/целевая должность\s*:[^\n]*/gi, "")
    .replace(/^(опыт|образование|навыки)\s*:?\s*$/gim, "")
    .trim();
  return rest.length === 0;
}

function splitDraft(text: string) {
  const optionsCut = cutBlock(text, /(?:^|\n)\s*(?:===\s*)?варианты(?:\s+заполнения)?\s*(?:===)?\s*:?\s*/i);
  const marker = /(?:^|\n)\s*(?:===\s*)?(?:чего не хватает|чего нет в резюме|не подтверждено резюме)\s*(?:===)?\s*:?\s*/i;
  const match = optionsCut.head.match(marker);
  let body = optionsCut.head;
  let gap = "";
  if (match && match.index != null) {
    body = optionsCut.head.slice(0, match.index);
    gap = optionsCut.head.slice(match.index + match[0].length);
  }
  const missing: string[] = [];
  const labels: Record<string, string> = { опыт: "опыт работы", навыки: "навыки", образование: "образование" };
  body = body.replace(/(?:^|\n)\s*(Опыт|Навыки|Образование)\s*:?\s*(?:\n+\s*)?нет\.?\s*(?=\n|$)/gi, (_full, name: string) => {
    missing.push(`В резюме не указано: ${labels[name.toLowerCase()]}.`);
    return "\n";
  });
  body = body
    .replace(/^(опыт|образование|навыки)\s*:?\s*\n+(?=(?:опыт|образование|навыки)\s*:?\s*(?:\n|$)|$)/gim, "")
    .replace(/\n(опыт|образование|навыки)\s*:?\s*$/i, "")
    .replace(/^(опыт|образование|навыки)\s*:?\s*$/i, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  gap = gap.replace(/^(?:===\s*)?(?:чего не хватает|чего нет в резюме|не подтверждено резюме)\s*(?:===)?\s*:?\s*/i, "").trim();
  if (/^(нет|ничего)\.?$/i.test(gap)) gap = "";
  const lines = [...gapLines(gap), ...missing.filter((line) => !gap.toLowerCase().includes(line.slice(18, 28)))];
  return { body, gap: lines.join("\n"), options: optionsCut.tail };
}

function gapLines(gap: string) {
  return gap.split(/\n+/).map((line) => line.replace(/^[-–—•*\d.)\s]+/, "").trim()).filter((line) => line && !/^(нет|ничего)\.?$/i.test(line));
}

function saveFile(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Highlight({ text, remarks, topic }: { text: string; remarks: Remark[]; topic: string }) {
  const value = String(text || "").trim();
  if (!value) return <span className="mut">не указано</span>;
  const needles = remarks
    .filter((remark) => remark.topic === topic)
    .flatMap((remark) => quotedParts(remark.quote))
    .sort((a, b) => b.length - a.length);
  let chunks: Array<string | { mark: string }> = [value];
  for (const needle of needles) {
    if (needle.length <= 1) continue;
    const next: Array<string | { mark: string }> = [];
    for (const chunk of chunks) {
      if (typeof chunk !== "string" || !chunk.includes(needle)) {
        next.push(chunk);
        continue;
      }
      const parts = chunk.split(needle);
      parts.forEach((part, index) => {
        if (part) next.push(part);
        if (index < parts.length - 1) next.push({ mark: needle });
      });
    }
    chunks = next;
  }
  return (
    <>
      {chunks.map((chunk, index) => (
        typeof chunk === "string" ? <span key={index}>{chunk}</span> : <mark key={index}>{chunk.mark}</mark>
      ))}
    </>
  );
}

function Fact({ label, text, remarks, topic }: { label: string; text: string; remarks: Remark[]; topic: string }) {
  return (
    <div className="row block-row">
      <div className="lab">{label}</div>
      <div className="fact"><Highlight text={text} remarks={remarks} topic={topic} /></div>
    </div>
  );
}

export default function Dashboard() {
  const [report, setReport] = useState<Report | null>(null);
  const [status, setStatus] = useState<RunState | null>(null);
  const [view, setView] = useState<View>("list");
  const [selected, setSelected] = useState<string | null>(null);
  const [fields, setFields] = useState<Fields | null>(null);
  const [query, setQuery] = useState("");
  const [employment, setEmployment] = useState("all");
  const [schedule, setSchedule] = useState("all");
  const [salary, setSalary] = useState("all");
  const [onlyRemarks, setOnlyRemarks] = useState(true);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsKey, setSettingsKey] = useState("");
  const [notice, setNotice] = useState("");
  const [resumeText, setResumeText] = useState("");
  const resumeCache = useRef(new Map<string, { resume: string; draft: string }>());
  const shownFor = useRef("");
  const resumeRequest = useRef(0);
  const [resumeId, setResumeId] = useState("");
  const [resumeOut, setResumeOut] = useState("");
  const [fillOptions, setFillOptions] = useState("");
  const [resumeMsg, setResumeMsg] = useState("");
  const [draftEditing, setDraftEditing] = useState(false);
  const [resumeBusy, setResumeBusy] = useState(false);
  const [letterAi, setLetterAi] = useState<{ letter: string; questions: string[] } | null>(null);
  const [letterBusy, setLetterBusy] = useState(false);
  const [letterId, setLetterId] = useState("");
  const [letterEdit, setLetterEdit] = useState<string | null>(null);
  const [letterEditing, setLetterEditing] = useState(false);
  const [copyKey, setCopyKey] = useState("");
  const [copyFailed, setCopyFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const spinBaseline = useRef<string | null>(null);
  const jsonInput = useRef<HTMLInputElement>(null);
  const resumeInput = useRef<HTMLInputElement>(null);

  const itemsById = useMemo(() => new Map((report?.items || []).map((item) => [item.vacancy_id, item])), [report]);
  const cards = report?.cards || [];

  const refresh = useCallback(async () => {
    const [nextReport, nextStatus] = await Promise.all([
      getJson("/api?action=report"),
      getJson("/api?action=status"),
    ]);
    setReport(nextReport);
    setStatus(nextStatus);
  }, []);

  useEffect(() => {
    refresh().catch((error: Error) => setNotice(error.message));
    getJson("/api?action=config").then((config) => {
      setSettings({
        source_url: config.source_url || "",
        max_vacancies: config.max_vacancies,
        page_size: config.page_size,
        interval_minutes: config.interval_minutes,
        schedule_enabled: !!config.schedule_enabled,
        llm_base_url: config.llm_base_url || "",
        llm_model: config.llm_model || "",
        llm_timeout_sec: config.llm_timeout_sec,
      });
    }).catch((error: Error) => setNotice(error.message));
  }, [refresh]);

  useEffect(() => {
    if (status?.state !== "running") return;
    const timer = setInterval(() => {
      refresh().catch((error: Error) => setNotice(error.message));
    }, 1500);
    return () => clearInterval(timer);
  }, [status?.state, refresh]);

  useEffect(() => {
    if (!busy || spinBaseline.current == null || status?.state === "running") return;
    const finished = status?.finished_at ?? "none";
    if (finished !== spinBaseline.current) {
      spinBaseline.current = null;
      setBusy(false);
    }
  }, [busy, status]);

  useEffect(() => {
    if (!resumeId && cards[0]) setResumeId(cards[0].vacancy_id);
  }, [cards, resumeId]);

  useEffect(() => {
    if (view !== "resume" || !resumeId) return;
    if (shownFor.current === resumeId) return;
    const cached = resumeCache.current.get(resumeId);
    if (cached) {
      shownFor.current = resumeId;
      setResumeText(cached.resume);
      setResumeOut(cached.draft);
      setResumeMsg("");
      return;
    }
    void composeIndividual(resumeId);
  }, [view, resumeId]);

  useEffect(() => {
    if (!modelRefused(resumeText) && !modelRefused(resumeOut)) return;
    if (modelRefused(resumeText)) setResumeText("");
    if (modelRefused(resumeOut)) setResumeOut("");
    setResumeMsg("GigaChat не ответил по этой вакансии. Резюме не заменено.");
  }, [resumeText, resumeOut]);

  useEffect(() => {
    if (view !== "resume" || !resumeId || !resumeOut) return;
    const parts = splitDraft(resumeOut);
    if (parts.options) {
      setFillOptions(parts.options);
      return;
    }
    if (!draftIsBlank(parts.body)) {
      setFillOptions("");
      return;
    }
    let cancel = false;
    getJson("/api?action=resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vacancy_id: resumeId, options: true }),
    }).then((data) => {
      const options = String(data.options || "").trim();
      if (!cancel) setFillOptions(modelRefused(options) ? "" : options);
    }).catch((error: Error) => {
      if (!cancel) setResumeMsg(error.message);
    });
    return () => {
      cancel = true;
    };
  }, [view, resumeId, resumeOut]);

  useEffect(() => {
    if (!letterId && cards[0]) setLetterId(cards[0].vacancy_id);
  }, [cards, letterId]);

  useEffect(() => {
    setLetterEdit(null);
    setLetterEditing(false);
  }, [letterId]);

  useEffect(() => {
    if (view !== "letters" || !letterId) return;
    let cancel = false;
    setLetterBusy(true);
    setLetterAi(null);
    getJson("/api?action=letter", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vacancy_id: letterId }),
    }).then((data) => {
      if (!cancel) setLetterAi({ letter: data.letter || "", questions: Array.isArray(data.questions) ? data.questions : [] });
    }).catch(() => {
      if (!cancel) setLetterAi(null);
    }).finally(() => {
      if (!cancel) setLetterBusy(false);
    });
    return () => {
      cancel = true;
    };
  }, [view, letterId]);

  const employmentOptions = [...new Set(cards.map((card) => card.employment).filter(Boolean))].sort() as string[];
  const scheduleOptions = [...new Set(cards.map((card) => card.schedule).filter(Boolean))].sort() as string[];

  function passes(card: Card) {
    const haystack = `${card.job_name} ${card.company} ${card.vacancy_id}`.toLowerCase();
    if (query.trim() && !haystack.includes(query.trim().toLowerCase())) return false;
    if (employment !== "all" && card.employment !== employment) return false;
    if (schedule !== "all" && card.schedule !== schedule) return false;
    const pay = money(card);
    if (salary === "none" && pay > 0) return false;
    if (salary === "to40" && (pay <= 0 || pay > 40000)) return false;
    if (salary === "40to60" && (pay < 40000 || pay > 60000)) return false;
    if (salary === "from60" && pay < 60000) return false;
    if (onlyRemarks && !(card.remark_count || 0)) return false;
    return true;
  }

  const shown = cards.filter(passes);
  const running = status?.state === "running" || busy;

  async function openVacancy(id: string) {
    setSelected(id);
    setLetterId(id);
    setFields(null);
    setView("detail");
    try {
      const data = await getJson(`/api?action=vacancy&id=${encodeURIComponent(id)}`);
      setFields(data.fields);
    } catch {
      setFields(null);
    }
  }

  function openLetters(id: string) {
    setSelected(id);
    setLetterId(id);
    setView("letters");
  }

  async function start(action: string) {
    setNotice("");
    spinBaseline.current = status?.finished_at ?? "none";
    setBusy(true);
    try {
      await getJson(`/api?action=${action}`, { method: "POST" });
      await refresh();
    } catch (error) {
      spinBaseline.current = null;
      setBusy(false);
      setNotice(error instanceof Error ? error.message : "Запрос не выполнен");
    }
  }

  async function onJson(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setNotice("Загружаю JSON…");
    spinBaseline.current = status?.finished_at ?? "none";
    setBusy(true);
    setQuery("");
    setEmployment("all");
    setSchedule("all");
    setSalary("all");
    setOnlyRemarks(false);
    try {
      const body = new FormData();
      body.append("file", file);
      await getJson("/api?action=fixture", { method: "POST", body });
      await refresh();
      setNotice("Загружены вакансии из этого файла.");
    } catch (error) {
      spinBaseline.current = null;
      setBusy(false);
      setNotice(error instanceof Error ? error.message : "Запрос не выполнен");
    }
  }

  async function copyText(key: string, text: string) {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.left = "-9999px";
      document.body.appendChild(area);
      area.select();
      ok = document.execCommand("copy");
      area.remove();
    }
    setCopyKey(key);
    setCopyFailed(!ok);
    setTimeout(() => setCopyKey(""), 1600);
  }

  function copyLabel(key: string, idle: string) {
    if (copyKey !== key) return idle;
    return copyFailed ? "Не удалось скопировать" : "Скопировано";
  }

  function downloadReport() {
    saveFile("vacancies-report.json", JSON.stringify(report?.items || [], null, 2), "application/json");
  }

  function downloadVacancy(id: string) {
    const item = itemsById.get(id) || { vacancy_id: id, vac_url: null, remarks: [] };
    saveFile(`${id}.json`, JSON.stringify(item, null, 2), "application/json");
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settings) return;
    try {
      await getJson("/api?action=config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...settings,
          llm_api_key: settingsKey === "" ? "********" : settingsKey,
        }),
      });
      setNotice("Настройки сохранены.");
      setSettingsKey("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Запрос не выполнен");
    }
  }

  function rememberResume(vacancyId: string, resume: string, draft: string) {
    resumeCache.current.set(vacancyId, { resume, draft });
    shownFor.current = vacancyId;
  }

  async function composeIndividual(vacancyId: string, force = false) {
    if (!vacancyId) {
      setResumeMsg("Сначала выберите вакансию.");
      return;
    }
    if (!force) {
      const cached = resumeCache.current.get(vacancyId);
      if (cached) {
        rememberResume(vacancyId, cached.resume, cached.draft);
        setResumeText(cached.resume);
        setResumeOut(cached.draft);
        setResumeMsg("");
        return;
      }
    }
    const token = ++resumeRequest.current;
    setResumeBusy(true);
    setResumeMsg("GigaChat собирает исходное резюме под эту вакансию…");
    setResumeOut("");
    setDraftEditing(false);
    try {
      const data = await getJson("/api?action=resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vacancy_id: vacancyId, individual: true }),
      });
      if (resumeRequest.current !== token) return;
      const draft = String(data.draft || "");
      const rewritten = String(data.resume || "").trim() || splitDraft(draft).body;
      if (modelRefused(draft) || modelRefused(rewritten)) throw new Error("GigaChat не ответил по этой вакансии. Резюме не заменено.");
      rememberResume(vacancyId, rewritten, draft);
      setResumeOut(draft);
      if (rewritten) setResumeText(rewritten);
      setResumeMsg("");
    } catch (error) {
      if (resumeRequest.current !== token) return;
      shownFor.current = "";
      setResumeText((current) => modelRefused(current) ? "" : current);
      setResumeOut((current) => modelRefused(current) ? "" : current);
      setResumeMsg(error instanceof Error ? error.message : "Запрос не выполнен");
    } finally {
      if (resumeRequest.current === token) setResumeBusy(false);
    }
  }

  async function makeDraft(vacancyId: string, resume: string) {
    if (!vacancyId) {
      setResumeMsg("Сначала выберите вакансию.");
      return;
    }
    if (!resume.trim()) {
      await composeIndividual(vacancyId, true);
      return;
    }
    const token = ++resumeRequest.current;
    setResumeBusy(true);
    setResumeMsg("GigaChat собирает черновик по этому резюме…");
    setResumeOut("");
    setDraftEditing(false);
    try {
      const data = await getJson("/api?action=resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vacancy_id: vacancyId, resume }),
      });
      if (resumeRequest.current !== token) return;
      const draft = String(data.draft || "");
      const rewritten = String(data.resume || "").trim() || splitDraft(draft).body || resume;
      if (modelRefused(draft) || modelRefused(rewritten)) throw new Error("GigaChat не ответил по этой вакансии. Резюме не заменено.");
      rememberResume(vacancyId, rewritten, draft);
      setResumeOut(draft);
      setResumeText(rewritten || resume);
      setResumeMsg("");
    } catch (error) {
      if (resumeRequest.current !== token) return;
      if (!modelRefused(resume)) setResumeText(resume);
      setResumeOut((current) => modelRefused(current) ? "" : current);
      setResumeMsg(error instanceof Error ? error.message : "Запрос не выполнен");
    } finally {
      if (resumeRequest.current === token) setResumeBusy(false);
    }
  }

  function regenerateResume() {
    if (!resumeId) {
      setResumeMsg("Сначала выберите вакансию.");
      return;
    }
    resumeCache.current.delete(resumeId);
    shownFor.current = "";
    void composeIndividual(resumeId, true);
  }

  function onResumeFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    file.text().then((text) => {
      setResumeText(text);
      setDraftEditing(false);
      if (resumeId) void makeDraft(resumeId, text);
    }).catch(() => setResumeMsg("Не удалось прочитать файл."));
  }

  async function submitResume(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = resumeText.trim();
    if (!text) {
      await composeIndividual(resumeId, true);
      return;
    }
    await makeDraft(resumeId, text);
  }

  const selectedCard = cards.find((card) => card.vacancy_id === selected);
  const selectedItem = selected ? itemsById.get(selected) : undefined;
  const detailRemarks = selectedItem?.remarks || [];
  const requirement = (fields?.requirement || {}) as Record<string, unknown>;
  const requirements = [plain(fields?.requirements), plain(requirement.education), plain(requirement.qualification), requirement.experience != null && requirement.experience !== "" ? `Опыт: ${plain(requirement.experience)} лет` : ""]
    .filter(Boolean)
    .join("\n");
  const payText = plain(fields?.salary) || selectedCard?.salary || "";
  const payExtra = fields?.salary_max && !payText.includes(String(fields.salary_max)) ? [`до ${plain(fields.salary_max)} рублей`] : [];
  const pay = payText
    ? [payText, ...payExtra].join("; ")
    : [fields?.salary_min ? `от ${plain(fields.salary_min)} рублей` : "", fields?.salary_max ? `до ${plain(fields.salary_max)} рублей` : ""].filter(Boolean).join("; ");
  const place = plain(fields?.addresses) || selectedCard?.address || "";
  const scheduleText = [plain(fields?.schedule) || selectedCard?.schedule || "", plain(fields?.shift) ? `Смена: ${plain(fields.shift)}` : ""].filter(Boolean).join("\n");
  const when = report?.generated_at ? new Date(report.generated_at).toLocaleString("ru") : "ещё не было";
  const runLabel = running
    ? `загрузка ${status?.processed || 0}/${status?.total || "…"}`
    : report?.status === "error"
      ? "ошибка, сохранён прошлый отчёт"
      : report?.status === "ok"
        ? "успешно"
        : "нет отчёта";

  const letterCard = cards.find((card) => card.vacancy_id === letterId);
  const letterRemarks = itemsById.get(letterId)?.remarks || [];
  const letterName = letterCard?.job_name || "Вакансия";
  const generatedLetter = buildLetter(letterName, letterRemarks);
  const letterText = letterEdit ?? letterAi?.letter ?? generatedLetter;
  const questions = letterAi?.questions?.length ? letterAi.questions : letterRemarks.map((remark) => remark.recommendation);
  const resumeCard = cards.find((card) => card.vacancy_id === resumeId);
  const draftParts = splitDraft(resumeOut);
  const draftBody = alignDraft(draftParts.body, resumeCard?.job_name || "");
  const blankDraft = Boolean(resumeOut) && draftIsBlank(draftBody);
  const suggestions = draftParts.options || fillOptions;

  return (
    <div className="shell">
      <header className="top">
        <div className="in bar">
          <button type="button" className="brand" onClick={() => setView("list")}>Прозрачная вакансия</button>
          <nav className="nav">
            <button type="button" className={view === "list" || view === "detail" ? "on" : ""} onClick={() => setView("list")}>Вакансии</button>
            <button type="button" className={view === "letters" ? "on" : ""} onClick={() => setView("letters")}>Письма</button>
            <button type="button" className={view === "resume" ? "on" : ""} onClick={() => setView("resume")}>Резюме</button>
          </nav>
        </div>
      </header>

      <main className="in page">
        {view === "list" && (
          <>
            <div className="card source-card">
              <div className="source-main">
                <div className="lab">Источник</div>
                <div className="mono source-url">{report?.mode === "fixture" ? `Загруженный JSON · ${cards.length} вакансий` : shortUrl(settings?.source_url || "opendata.trudvsem.ru/api/v1/vacancies/region/39")}</div>
                <div className="meta">
                  <div><div className="lab">Расписание</div>{scheduleLabel(settings)}</div>
                  <div><div className="lab">Лимит вакансий</div>{settings?.max_vacancies ?? "…"}</div>
                  <div><div className="lab">Модель</div>{settings?.llm_model || "GigaChat-2"}</div>
                  <div><div className="lab">Последний запуск</div>{when} · {runLabel}</div>
                </div>
              </div>
              <div className="actions">
                {running ? <span className="loader" role="status" aria-label="Загрузка" /> : null}
                <button type="button" className="btn" disabled={running} onClick={() => start("run")}>Запустить сейчас</button>
                <button type="button" className="btn2" disabled={running} onClick={() => jsonInput.current?.click()}>Загрузить JSON</button>
                <input ref={jsonInput} type="file" accept="application/json,.json" hidden onChange={onJson} />
              </div>
              <div className="mut foot source-foot">
                Одна вакансия — одна строка, повторный запуск не создаёт дубли.{" "}
                <button type="button" className="linkish" onClick={() => setSettingsOpen((open) => !open)}>{settingsOpen ? "Скрыть настройки" : "Настроить"}</button>
                {" · "}
                <button type="button" className="linkish" onClick={downloadReport}>Скачать JSON отчёта</button>
              </div>
              {settingsOpen && settings && (
                <form className="settings stack" onSubmit={saveSettings}>
                  <label className="stack">URL API региона
                    <input className="control" required value={settings.source_url} onChange={(event) => setSettings({ ...settings, source_url: event.target.value })} />
                  </label>
                  <div className="grid">
                    <label className="stack">Максимум вакансий
                      <input className="control" type="number" min={1} max={500} required value={settings.max_vacancies} onChange={(event) => setSettings({ ...settings, max_vacancies: Number(event.target.value) })} />
                    </label>
                    <label className="stack">Размер страницы
                      <input className="control" type="number" min={1} max={100} required value={settings.page_size} onChange={(event) => setSettings({ ...settings, page_size: Number(event.target.value) })} />
                    </label>
                    <label className="stack">Интервал, минуты
                      <input className="control" type="number" min={1} required value={settings.interval_minutes} onChange={(event) => setSettings({ ...settings, interval_minutes: Number(event.target.value) })} />
                    </label>
                  </div>
                  <label className="check">
                    <input type="checkbox" checked={settings.schedule_enabled} onChange={(event) => setSettings({ ...settings, schedule_enabled: event.target.checked })} />
                    Запускать по расписанию
                  </label>
                  <div className="grid">
                    <label className="stack">Адрес GigaChat
                      <input className="control" required value={settings.llm_base_url} onChange={(event) => setSettings({ ...settings, llm_base_url: event.target.value })} />
                    </label>
                    <label className="stack">Модель
                      <input className="control" required value={settings.llm_model} onChange={(event) => setSettings({ ...settings, llm_model: event.target.value })} />
                    </label>
                    <label className="stack">Ключ
                      <input className="control" type="password" autoComplete="off" placeholder="Пусто — не менять" value={settingsKey} onChange={(event) => setSettingsKey(event.target.value)} />
                    </label>
                  </div>
                  <label className="stack">Таймаут, секунды
                    <input className="control" type="number" min={10} required value={settings.llm_timeout_sec} onChange={(event) => setSettings({ ...settings, llm_timeout_sec: Number(event.target.value) })} />
                  </label>
                  <div className="actions">
                    <button className="btn" type="submit">Сохранить</button>
                  </div>
                </form>
              )}
            </div>
            {notice ? <p className="note warn">{notice}</p> : null}
            {report?.error ? <p className="note warn">{report.error}</p> : null}

            <div className="head">
              <h1>Вакансии</h1>
              <label className="check">
                <input type="checkbox" checked={onlyRemarks} onChange={(event) => setOnlyRemarks(event.target.checked)} />
                Только с замечаниями
              </label>
            </div>
            <div className="filters">
              <label>Поиск
                <input className="control" type="search" placeholder="Должность, работодатель или ID" value={query} onChange={(event) => setQuery(event.target.value)} />
              </label>
              <label>Занятость
                <select className="control" aria-label="Тип занятости" value={employmentOptions.includes(employment) ? employment : "all"} onChange={(event) => setEmployment(event.target.value)}>
                  <option value="all">Любая занятость</option>
                  {employmentOptions.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <label>График
                <select className="control" aria-label="График" value={scheduleOptions.includes(schedule) ? schedule : "all"} onChange={(event) => setSchedule(event.target.value)}>
                  <option value="all">Любой график</option>
                  {scheduleOptions.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <label>Оплата
                <select className="control" aria-label="Оплата" value={salary} onChange={(event) => setSalary(event.target.value)}>
                  <option value="all">Любая оплата</option>
                  <option value="none">Оплата не указана</option>
                  <option value="to40">До 40 000 ₽</option>
                  <option value="40to60">40 000–60 000 ₽</option>
                  <option value="from60">От 60 000 ₽</option>
                </select>
              </label>
            </div>
            <div className="card table">
              <div className="row mut" style={{ fontSize: 13 }}>
                <div className="col-job" style={{ fontWeight: 400 }}>Должность</div>
                <div className="col-employer">Работодатель</div>
                <div className="col-count">Замечаний</div>
                <div className="col-open">Карточка</div>
              </div>
              {shown.length === 0 ? (
                <div className="row" style={{ borderBottom: 0 }}><div className="mut">Нет вакансий по этим условиям.</div></div>
              ) : shown.map((card, index) => (
                <div className="row" style={index === shown.length - 1 ? { borderBottom: 0 } : undefined} key={card.vacancy_id}>
                  <div className="col-job">{card.job_name || "Без названия"}</div>
                  <div className="col-employer mut">{card.company || "Работодатель не указан"}</div>
                  <div className="col-count"><span className="tag">{card.remark_count || 0}</span></div>
                  <div className="col-open"><button type="button" className="open" onClick={() => openVacancy(card.vacancy_id)}>Открыть</button></div>
                </div>
              ))}
            </div>
          </>
        )}

        {view === "detail" && (
          <>
            <button type="button" className="linkish back" onClick={() => setView("list")}>← К списку вакансий</button>
            {!selectedCard || !selectedItem ? (
              <div className="card" style={{ marginTop: 16 }}>Выберите вакансию в списке.</div>
            ) : (
              <>
                <div className="title-row">
                  <div>
                    <h1>{selectedCard.job_name || "Без названия"}</h1>
                    {selectedCard.company ? <div className="mut">{selectedCard.company}</div> : null}
                    <div className="mono" style={{ marginTop: 6 }}>
                      ID: {selectedCard.vacancy_id}
                      {selectedCard.vac_url ? <> · <a href={selectedCard.vac_url} target="_blank" rel="noreferrer">Карточка на портале</a></> : null}
                    </div>
                  </div>
                  <div className="actions">
                    <button type="button" className="btn" onClick={() => openLetters(selectedCard.vacancy_id)}>Письмо работодателю</button>
                    <button type="button" className="btn2" onClick={() => openLetters(selectedCard.vacancy_id)}>Вопросы для собеседования</button>
                    <button type="button" className="btn2" onClick={() => downloadVacancy(selectedCard.vacancy_id)}>Скачать JSON</button>
                  </div>
                </div>
                <div className="split">
                  <div className="card grow">
                    <h2 style={{ marginBottom: 8, fontSize: 18 }}>Данные вакансии</h2>
                    <Fact label="Название (job-name)" text={plain(fields?.["job-name"]) || selectedCard.job_name || ""} remarks={detailRemarks} topic="название_должности" />
                    <Fact label="Оплата (salary)" text={pay} remarks={detailRemarks} topic="оплата" />
                    <Fact label="График (schedule)" text={scheduleText} remarks={detailRemarks} topic="график" />
                    <Fact label="Тип занятости (employment)" text={plain(fields?.employment) || selectedCard.employment || ""} remarks={detailRemarks} topic="тип_занятости" />
                    <Fact label="Место работы (address)" text={place} remarks={detailRemarks} topic="место_работы" />
                    <Fact label="Обязанности (duty)" text={plain(fields?.duty)} remarks={detailRemarks} topic="обязанности" />
                    <div className="row block-row" style={{ borderBottom: 0 }}>
                      <div className="lab">Требования (requirements)</div>
                      <div className="fact"><Highlight text={requirements} remarks={detailRemarks} topic="требования" /></div>
                    </div>
                  </div>
                  <div className="wide">
                    {detailRemarks.length === 0 ? (
                      <div className="card"><p className="mut" style={{ margin: 0 }}>Замечаний нет.</p></div>
                    ) : detailRemarks.map((remark, index) => (
                      <div className="card remark" key={`${remark.topic}-${index}`}>
                        <div className="remark-top">
                          <span className="tag">{topicFull[remark.topic] || remark.topic} · {remarkKind(remark)}</span>
                          <span className="mono">{remark.field}</span>
                        </div>
                        <p>{remark.problem}</p>
                        {remark.quote ? <p className="mut" style={{ marginTop: 8 }}>{remark.quote}</p> : null}
                        <p className="ask"><b>Что уточнить:</b> {remark.recommendation}</p>
                        <button type="button" className="linkish" onClick={() => copyText(`remark-${index}`, remark.recommendation)}>
                          {copyLabel(`remark-${index}`, "Скопировать уточнение")}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </>
        )}

        {view === "letters" && (
          <>
            <h1>{letterCard?.job_name || "Письмо и вопросы"}</h1>
            <p className="mut lead">{letterBusy ? "GigaChat собирает письмо и вопросы по замечаниям этой вакансии." : "Тексты собраны только из замечаний отчёта, новых фактов в них нет."}</p>
            <label className="picker stack">Вакансия
              <select className="control" value={letterId} onChange={(event) => setLetterId(event.target.value)}>
                {cards.length === 0 ? <option value="">Сначала нужен отчёт</option> : cards.map((card) => (
                  <option key={card.vacancy_id} value={card.vacancy_id}>{card.job_name || card.vacancy_id}</option>
                ))}
              </select>
            </label>
            <div className="split">
              <div className="card" style={{ flex: "1 1 480px", minWidth: 0 }}>
                <div className="lab">Для редактора</div>
                <h2 style={{ marginBottom: 16 }}>Письмо работодателю</h2>
                {letterEditing ? (
                  <textarea className="letter letter-edit" value={letterText} onChange={(event) => setLetterEdit(event.target.value)} />
                ) : (
                  <div className="letter">{letterText}</div>
                )}
                <div className="actions" style={{ marginTop: 20 }}>
                  <button type="button" className="btn" onClick={() => copyText("letter", letterText)}>{copyLabel("letter", "Копировать")}</button>
                  <button type="button" className="btn2" onClick={() => { setLetterEdit(letterText); setLetterEditing((value) => !value); }}>Изменить</button>
                </div>
              </div>
              <div className="card" style={{ flex: "1 1 400px", minWidth: 0 }}>
                <div className="lab">Для соискателя</div>
                <h2 style={{ marginBottom: 16 }}>Вопросы для собеседования</h2>
                {questions.length === 0 ? (
                  <p className="mut" style={{ margin: 0 }}>Замечаний нет, вопросы не нужны.</p>
                ) : questions.map((question, index) => (
                  <div className={`row q${index === questions.length - 1 ? "" : ""}`} style={index === questions.length - 1 ? { borderBottom: 0 } : undefined} key={index}>
                    <span className="mono">{String(index + 1).padStart(2, "0")}</span>
                    <div className="q-text">{question}</div>
                  </div>
                ))}
                <div style={{ marginTop: 12 }}>
                  <button type="button" className="btn2" disabled={!questions.length} onClick={() => copyText("questions", questions.map((question, index) => `${index + 1}. ${question}`).join("\n"))}>
                    {copyLabel("questions", "Копировать список")}
                  </button>
                </div>
              </div>
            </div>
          </>
        )}

        {view === "resume" && (
          <form onSubmit={submitResume}>
            <h1>Черновик резюме под вакансию</h1>
            <p className="mut lead">Черновик сравнивает ваше резюме с вакансией на портале: должность, обязанности и требования берутся оттуда. Желаемая должность из резюме в сравнении не участвует.</p>
            <div className="card tools">
              <div className="grow">
                <div className="lab">Вакансия</div>
                <select className="control" value={resumeId} onChange={(event) => setResumeId(event.target.value)}>
                  {cards.length === 0 ? <option value="">Сначала нужен отчёт</option> : cards.map((card) => (
                    <option key={card.vacancy_id} value={card.vacancy_id}>{card.job_name || card.vacancy_id}{card.company ? ` · ${card.company}` : ""}</option>
                  ))}
                </select>
              </div>
              <button type="button" className="btn2" onClick={() => resumeInput.current?.click()}>Загрузить резюме</button>
              <button type="button" className="btn2" disabled={resumeBusy} onClick={regenerateResume}>Собрать заново</button>
              {resumeBusy ? <span className="loader" role="status" aria-label="Загрузка" /> : null}
              <button type="submit" className="btn" disabled={resumeBusy}>Сформировать черновик</button>
              <input ref={resumeInput} type="file" accept=".txt,.md,text/plain" hidden onChange={onResumeFile} />
            </div>
            <div className="split">
              <div className="resume-col">
                <div className="card">
                  <div className="lab">Исходное резюме</div>
                  <textarea className="plain" value={resumeText} onChange={(event) => {
                    const value = event.target.value;
                    setResumeText(value);
                    if (resumeId) resumeCache.current.set(resumeId, { resume: value, draft: resumeOut });
                  }} placeholder="Резюме появится здесь после выбора вакансии." />
                </div>
                {draftParts.gap ? (
                  <div className="card missing">
                    <div className="lab">Несоответствия</div>
                    <h2>Чего нет в резюме</h2>
                    <p className="mut">Это требует вакансия, а в резюме такого пункта нет.</p>
                    <ul className="missing-list">
                      {gapLines(draftParts.gap).map((line) => <li key={line}>{line}</li>)}
                    </ul>
                  </div>
                ) : null}
              </div>
              <div className="card" style={{ flex: "1 1 440px", minWidth: 0 }}>
                <div className="lab">Черновик под вакансию</div>
                {resumeOut ? (
                  draftEditing ? (
                    <textarea className="plain" value={resumeOut} onChange={(event) => setResumeOut(event.target.value)} />
                  ) : blankDraft ? (
                    <div>
                      <p className="mut" style={{ marginTop: 0 }}>В резюме нет сведений для этой вакансии.</p>
                      {suggestions ? (
                        <>
                          <h2 style={{ margin: "16px 0 8px" }}>Возможные варианты</h2>
                          <div className="prose">{suggestions}</div>
                        </>
                      ) : (
                        <p className="mut">GigaChat подбирает варианты заполнения…</p>
                      )}
                    </div>
                  ) : (
                    <div className="prose">{draftBody}</div>
                  )
                ) : (
                  <div className="mut">{resumeCard ? "Черновик соберётся вместе с резюме." : "Сначала нужен отчёт с вакансиями."}</div>
                )}
                <div className="actions" style={{ marginTop: 20 }}>
                  <button type="button" className="btn" disabled={!resumeOut} onClick={() => saveFile("resume-draft.txt", resumeOut, "text/plain")}>Скачать</button>
                  <button type="button" className="btn2" disabled={!resumeOut} onClick={() => setDraftEditing((value) => !value)}>Изменить</button>
                </div>
              </div>
            </div>
            {resumeMsg ? <p className="note">{resumeMsg}</p> : null}
          </form>
        )}
      </main>
    </div>
  );
}
