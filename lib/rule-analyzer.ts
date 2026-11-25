import { locations } from "./normalizer";
import { contains, len, lower, meaningless } from "./text";
import type { PublicRemark, Remark, Vacancy } from "./types";
import { RULES_VERSION } from "./version";

export { RULES_VERSION };

export class RuleAnalyzer {
  analyze(vacancy: Vacancy): Remark[] {
    return [
      ...this.title(vacancy),
      ...this.duty(vacancy),
      ...this.requirements(vacancy),
      ...this.salary(vacancy),
      ...this.schedule(vacancy),
      ...this.place(vacancy),
      ...this.employment(vacancy),
    ];
  }

  export(remarks: Remark[]): PublicRemark[] {
    return remarks.map((remark) => this.publicRemark(remark));
  }

  hardOnly(remarks: Remark[]): PublicRemark[] {
    return remarks
      .filter((remark) => (remark._severity ?? "hard") === "hard")
      .map((remark) => this.publicRemark(remark));
  }

  private title(vacancy: Vacancy): Remark[] {
    const name = String(vacancy["job-name"] ?? "").trim();
    const typical = String(vacancy.typicalPosition ?? "").trim();
    const remarks: Remark[] = [];
    if (name === "") {
      remarks.push(this.make(
        "название_должности",
        "job-name",
        "",
        "В вакансии нет названия должности, поэтому непонятно, на какую работу откликаться.",
        "Спросите у работодателя точное название должности и напишите его в вакансии, например «инженер по метрологии», а не пустую строку.",
        "hard",
      ));
    } else if (this.isGenericTitle(name)) {
      remarks.push(this.make(
        "название_должности",
        "job-name",
        name,
        `Название «${name}» не говорит, в какой области нужна работа.`,
        `Уточните направление и впишите его в название: не просто «${name}», а, например, «${name} по кадрам» или другая конкретная должность.`,
        "soft",
      ));
    }
    if (name !== "" && typical !== "" && !this.isPlaceholderTitle(typical) && this.titlesConflict(name, typical)) {
      remarks.push(this.make(
        "название_должности",
        "job-name / typicalPosition",
        `название: «${name}»; типовая должность: «${typical}»`,
        `В вакансии одновременно указаны разные должности: «${name}» и «${typical}».`,
        `Уточните, кого именно ищут — «${name}» или «${typical}», — и оставьте в вакансии одно название.`,
        "hard",
      ));
    }
    return remarks;
  }

  private duty(vacancy: Vacancy): Remark[] {
    const duty = String(vacancy.duty ?? "").trim();
    if (duty === "") {
      return [this.make(
        "обязанности",
        "duty",
        "",
        "Не написано, что именно человек будет делать на этой работе.",
        "Попросите работодателя перечислить конкретные задачи на день или смену и запишите их в обязанности.",
        "hard",
      )];
    }
    let stripped = lower(duty).replace(
      /выполнение должностных обязанностей|согласно должностной инструкции|в соответствии с должностной инструкцией|согласно инструкции|соблюдение правил внутреннего распорядка/gu,
      " ",
    );
    stripped = stripped.replace(/\s+/gu, " ").replace(/^[ \t\n\r\0\v.;\-—]+|[ \t\n\r\0\v.;\-—]+$/g, "");
    if (len(stripped) < 25) {
      return [this.make(
        "обязанности",
        "duty",
        duty,
        "В обязанностях только общая фраза, без конкретных задач.",
        "Допишите, что сотрудник делает в течение рабочего дня: какие действия, с чем работает и какой результат сдаёт.",
        "soft",
      )];
    }
    return [];
  }

  private requirements(vacancy: Vacancy): Remark[] {
    const text = String(vacancy.requirements ?? "").trim();
    const requirement = vacancy.requirement && typeof vacancy.requirement === "object" ? vacancy.requirement : {};
    const education = String(requirement.education ?? "").trim();
    const qualification = String(requirement.qualification ?? "").trim();
    const topQualification = String(vacancy.qualification ?? "").trim();
    const hasExperience = Object.prototype.hasOwnProperty.call(requirement, "experience")
      && requirement.experience !== null
      && requirement.experience !== "";
    const hasContent = !meaningless(text)
      || !meaningless(education)
      || !meaningless(qualification)
      || !meaningless(topQualification)
      || hasExperience;
    if (!hasContent) {
      return [this.make(
        "требования",
        "requirements",
        "",
        "Не указаны ни образование, ни квалификация, ни нужен ли опыт.",
        "Уточните три вещи: какое образование нужно, какая квалификация и сколько лет опыта, включая вариант «опыт не требуется».",
        "hard",
      )];
    }
    const remarks: Remark[] = [];
    const textLevels = this.educationLevels(`${text} ${qualification}`);
    const fieldLevels = this.educationLevels(education);
    if (textLevels.length === 1 && fieldLevels.length === 1 && textLevels[0] !== fieldLevels[0]) {
      remarks.push(this.make(
        "требования",
        "requirements / requirement.education",
        `в тексте требований: «${this.clip(text)}»; в сведениях об образовании: «${education}»`,
        "В тексте требований и в сведениях об образовании назван разный уровень.",
        "Уточните, какое образование нужно на самом деле, и напишите один и тот же уровень и в тексте, и в сведениях об образовании.",
        "hard",
      ));
    }
    const experience = this.experienceConflict(requirement, `${text} ${qualification}`);
    if (experience) {
      remarks.push(this.make(
        "требования",
        "requirements / requirement.experience",
        `в тексте: «${experience.fragment}»; в сведениях об опыте: ${experience.years} лет`,
        "Фраза про опыт в тексте не совпадает с указанным числом лет.",
        "Уточните, сколько полных лет опыта нужно. Если опыт не нужен, уберите требование опыта из текста. Если нужен, напишите это же число лет в требованиях.",
        "hard",
      ));
    }
    return remarks;
  }

  private salary(vacancy: Vacancy): Remark[] {
    const text = String(vacancy.salary ?? "").trim();
    const min = this.money(vacancy.salary_min);
    const max = this.money(vacancy.salary_max);
    const hasMin = min !== null && min > 0;
    const hasMax = max !== null && max > 0;
    const lowered = lower(text);
    const negotiable = lowered !== "" && /договор|обсужда|по итогам собесед/u.test(lowered);
    const parsed = this.salaryNumbers(text);
    const hasNumberInText = Object.keys(parsed).length > 0;
    if (!hasMin && !hasMax && !hasNumberInText) {
      if (negotiable) {
        return [this.make(
          "оплата",
          "salary",
          text,
          "Про оплату сказано только «по договорённости», суммы нет.",
          "Уточните сумму или вилку в рублях: от какой суммы и до какой, либо одну фиксированную оплату.",
          "soft",
        )];
      }
      return [this.make(
        "оплата",
        "salary",
        "",
        "В вакансии нет ни суммы, ни вилки оплаты.",
        "Уточните оплату в рублях: одну сумму или границы «от» и «до».",
        "hard",
      )];
    }
    const problems: string[] = [];
    if (hasMin && hasMax && min! > max!) problems.push(`нижняя граница ${this.rub(min!)} больше верхней ${this.rub(max!)}`);
    if (parsed.from != null && parsed.to != null && parsed.from > parsed.to) {
      problems.push(`в тексте оплата «от ${this.rub(parsed.from)}» выше, чем «до ${this.rub(parsed.to)}»`);
    }
    if (parsed.from != null && hasMin && Math.abs(parsed.from - min!) > 1) {
      problems.push(`в тексте указано от ${this.rub(parsed.from)}, а нижняя граница — ${this.rub(min!)}`);
    }
    if (parsed.to != null && hasMax && Math.abs(parsed.to - max!) > 1) {
      problems.push(`в тексте указано до ${this.rub(parsed.to)}, а верхняя граница — ${this.rub(max!)}`);
    }
    if (parsed.exact != null && hasMin && Math.abs(parsed.exact - min!) > 1 && !(hasMax && Math.abs(parsed.exact - max!) <= 1)) {
      problems.push(`в тексте указано ${this.rub(parsed.exact)}, а нижняя граница — ${this.rub(min!)}`);
    }
    if (parsed.to != null && hasMin && !hasMax && parsed.to < min!) {
      problems.push(`в тексте указано до ${this.rub(parsed.to)}, а нижняя граница — ${this.rub(min!)}`);
    }
    if (problems.length === 0) return [];
    const quoteParts: string[] = [];
    if (text !== "") quoteParts.push(`в тексте: «${text}»`);
    if (hasMin) quoteParts.push(`от ${this.rub(min!)}`);
    if (hasMax) quoteParts.push(`до ${this.rub(max!)}`);
    return [this.make(
      "оплата",
      "salary / salary_min / salary_max",
      quoteParts.join("; "),
      `Суммы оплаты не сходятся: ${problems.join("; ")}.`,
      "Уточните одну сумму или одну вилку в рублях и напишите одни и те же границы и в тексте, и в нижней и верхней оплате.",
      "hard",
    )];
  }

  private schedule(vacancy: Vacancy): Remark[] {
    const schedule = String(vacancy.schedule ?? "").trim();
    if (schedule === "") {
      return [this.make(
        "график",
        "schedule",
        "",
        "Не указано, в какие дни и часы нужно работать.",
        "Уточните дни недели, время начала и окончания работы или какие именно смены предусмотрены.",
        "hard",
      )];
    }
    const remarks: Remark[] = [];
    const lowered = lower(schedule);
    const concrete = this.hasConcreteHours(vacancy);
    const ambiguous = /гибк|свободн|индивидуальн|по согласован|по договор|сменн|вахт|ненормир|неполн|плавающ/u.test(lowered);
    if (ambiguous && !concrete) {
      remarks.push(this.make(
        "график",
        "schedule",
        schedule,
        `График назван «${schedule}», но ни дни, ни часы, ни состав смен больше нигде не названы.`,
        "Уточните, по каким дням и с какого по какое время идёт работа и есть ли ночные или скользящие смены.",
        "soft",
      ));
    }
    const duty = lower(`${vacancy.duty ?? ""} ${vacancy.requirements ?? ""}`);
    if (lowered.includes("полный") && !lowered.includes("неполн") && /ночн(?:ая|ые|ой)?\s+смен|только ночь/u.test(duty)) {
      remarks.push(this.make(
        "график",
        "schedule / duty",
        `график: «${schedule}»; обязанности: «${this.clip(String(vacancy.duty ?? ""))}»`,
        "В графике указан полный рабочий день, а в обязанностях — ночная смена.",
        "Уточните, смена дневная, ночная или бывают обе, и напишите это одинаково в графике и в обязанностях.",
        "hard",
      ));
    }
    return remarks;
  }

  private place(vacancy: Vacancy): Remark[] {
    const found = locations(vacancy);
    if (found.length === 0) {
      return [this.make(
        "место_работы",
        "addresses",
        "",
        "Не указано, в каком городе и по какому адресу находится работа.",
        "Уточните населённый пункт, улицу и дом, куда выходить на работу.",
        "hard",
      )];
    }
    const specific = found.filter((location) => !this.isRegionOnly(location));
    if (specific.length === 0) {
      return [this.make(
        "место_работы",
        "addresses",
        found.join("; "),
        "В адресе только регион, без города и улицы. Непонятно, куда выходить на работу.",
        "Уточните город, улицу и дом площадки.",
        "soft",
      )];
    }
    if (specific.length >= 2) {
      return [this.make(
        "место_работы",
        "addresses",
        specific.join("; "),
        "Указано несколько адресов, и не сказано, сотрудник работает на всех, на одном или может выбрать площадку.",
        "Напишите, по какому адресу проходит работа, или прямо укажите, что площадку можно выбрать.",
        "soft",
      )];
    }
    return [];
  }

  private employment(vacancy: Vacancy): Remark[] {
    const employment = String(vacancy.employment ?? "").trim();
    if (employment === "") {
      return [this.make(
        "тип_занятости",
        "employment",
        "",
        "Не сказано, берут на полную ставку, на часть ставки, временно или на стажировку.",
        "Уточните у работодателя один вариант и напишите его словами: полная занятость, частичная занятость, временная работа или стажировка.",
        "hard",
      )];
    }
    const lowered = lower(employment);
    const full = lowered.includes("полн") && !lowered.includes("неполн") && !lowered.includes("частич");
    const partial = lowered.includes("частич") || lowered.includes("неполн");
    const otherLower = lower(`${vacancy.duty ?? ""} ${vacancy.requirements ?? ""} ${vacancy.schedule ?? ""}`);
    let match: RegExpMatchArray | null;
    if (full && (match = otherLower.match(/частичн\p{L}*|неполн\p{L}*|совместитель\p{L}*|0[,.]5\s*ставк\p{L}*|полставк\p{L}*/u))) {
      return [this.make(
        "тип_занятости",
        "employment",
        `тип занятости: «${employment}»; в тексте: «${match[0]}»`,
        "В типе занятости указана полная работа, а в тексте встречается частичная занятость, неполная ставка или совместительство.",
        "Уточните ставку: полная или частичная. Напишите один и тот же вариант и в типе занятости, и в тексте вакансии.",
        "hard",
      )];
    }
    if (partial && (match = otherLower.match(/полн(?:ая|ой|ую)\s+занятост|полн(?:ая|ую)\s+ставк|полный рабочий день/u))) {
      return [this.make(
        "тип_занятости",
        "employment",
        `тип занятости: «${employment}»; в тексте: «${match[0]}»`,
        "В типе занятости указана неполная работа, а в тексте — полная ставка или полный рабочий день.",
        "Уточните, сколько часов в день и какая ставка, и оставьте в вакансии одну формулировку.",
        "hard",
      )];
    }
    return [];
  }

  private isGenericTitle(name: string): boolean {
    let norm = lower(name).replace(/^(ищу|требуется|вакансия)\s+/u, "");
    norm = norm.replace(/^[ \t\n\r\0\v.]+|[ \t\n\r\0\v.]+$/g, "");
    return ["специалист", "сотрудник", "работник", "менеджер", "рабочий", "стажер", "стажёр"].includes(norm);
  }

  private titlesConflict(left: string, right: string): boolean {
    const a = lower(left);
    const b = lower(right);
    if (a === "" || b === "" || a === b) return false;
    const prefixes = ["главный", "главная", "старший", "старшая", "младший", "младшая", "помощник", "помощница", "заместитель", "ведущий", "ведущая"];
    for (const [title, other] of [[a, b], [b, a]] as const) {
      for (const prefix of prefixes) {
        if (!title.startsWith(`${prefix} `)) continue;
        const rest = title.slice(prefix.length + 1).trim();
        if (rest !== "" && this.sameStem(rest, other)) return true;
      }
    }
    return false;
  }

  private sameStem(left: string, right: string): boolean {
    if (left === right || contains(left, right) || contains(right, left)) return true;
    const stem = (value: string) => value.replace(/[аяоеёуюыиьй]+$/u, "");
    const a = stem(left);
    const b = stem(right);
    if (len(a) < 5 || len(b) < 5) return false;
    return a === b || contains(a, b) || contains(b, a);
  }

  private isPlaceholderTitle(value: string): boolean {
    const text = lower(value);
    return text === "-" || text.includes("ничего не выбрано") || text.includes("нет содержательной") || text.includes("не указан");
  }

  private educationLevels(text: string): string[] {
    if (meaningless(text)) return [];
    const value = lower(text);
    const found = this.matchEducation(value);
    if (/(?:^|[^\p{L}\p{N}_])или(?![\p{L}\p{N}_])/u.test(value) && Object.keys(found).length > 1) return [];
    if (found.vocational && found.secondary) delete found.secondary;
    if (found.higher && found.vocational) delete found.vocational;
    if (found.basic) delete found.secondary;
    if (found.primary) {
      delete found.secondary;
      delete found.basic;
    }
    return Object.keys(found);
  }

  private matchEducation(value: string): Record<string, true> {
    const found: Record<string, true> = {};
    if (/высш/u.test(value)) found.higher = true;
    if (/среднее\s+професс|среднее\s+специал|средне-специал|профессиональн\p{L}*\s+образован|(?:^|[^\p{L}\p{N}_])спо(?![\p{L}\p{N}_])/u.test(value)) found.vocational = true;
    if (/среднее\s+общее|общее\s+образование|среднее\s+образование/u.test(value)) found.secondary = true;
    if (/основн/u.test(value)) found.basic = true;
    if (/начальн/u.test(value)) found.primary = true;
    return found;
  }

  private experienceConflict(requirement: Vacancy, text: string): { fragment: string; years: number } | null {
    if (!Object.prototype.hasOwnProperty.call(requirement, "experience") || requirement.experience === null || requirement.experience === "") {
      return null;
    }
    const years = Number.parseInt(String(requirement.experience), 10) || 0;
    const value = lower(text);
    const none = value.match(/без опыта|опыт не требуется|опыт необязател|можно без опыта/u);
    if (none) {
      if (years >= 1) return { fragment: none[0], years };
      return null;
    }
    if (/опыт[^\.]{0,80}приветств|приветств[^\.]{0,80}опыт/u.test(value)) return null;
    const needMatch = value.match(/опыт(?:а|е|у|ом)?\s+(?:работы\s+)?(?:от|не менее)\s*(\d+)/u);
    if (needMatch) {
      const need = Number.parseInt(needMatch[1], 10);
      if (years < need) return { fragment: needMatch[0].trim(), years };
    }
    return null;
  }

  private salaryNumbers(text: string): { from?: number; to?: number; exact?: number } {
    const value = lower(text).replace(/[ \u00a0\u2009]/g, "");
    let match = value.match(/от(\d+)до(\d+)/u);
    if (match) return { from: Number(match[1]), to: Number(match[2]) };
    match = value.match(/(\d+)[-\u2013\u2014](\d+)/u);
    if (match) return { from: Number(match[1]), to: Number(match[2]) };
    match = value.match(/от(\d+)/u);
    if (match) return { from: Number(match[1]) };
    match = value.match(/до(\d+)/u);
    if (match) return { to: Number(match[1]) };
    match = value.match(/(\d{4,})/u);
    if (match) return { exact: Number(match[1]) };
    return {};
  }

  private rub(value: number): string {
    return `${value} рублей`;
  }

  private money(value: unknown): number | null {
    if (value === null || value === undefined || value === "") return null;
    const raw = typeof value === "string" ? value.replace(/[ \u00a0]/g, "") : value;
    const number = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(number)) return null;
    return Math.trunc(number);
  }

  private hasConcreteHours(vacancy: Vacancy): boolean {
    const shift = vacancy.shift ?? [];
    if (Array.isArray(shift) && shift.length > 0) return true;
    if (shift && typeof shift === "object" && !Array.isArray(shift) && Object.keys(shift).length > 0) return true;
    const blob = lower(`${vacancy.duty ?? ""} ${vacancy.requirements ?? ""} ${vacancy.schedule ?? ""} ${vacancy.benefitDetails ?? ""}`);
    return /\d{1,2}[:.]\d{2}|\d+\s*\/\s*\d+|с\s*\d{1,2}\s*до\s*\d{1,2}|\d+\s*час/u.test(blob);
  }

  private isRegionOnly(location: string): boolean {
    let value = lower(location).replace(/\s+/gu, " ").replace(/^[ \t\n\r\0\v,.;]+|[ \t\n\r\0\v,.;]+$/g, "");
    if (value === "") return true;
    if (/(?:^|[^\p{L}\p{N}_])(город|ул\.|улиц|пр-т|просп|пер\.|переул|шоссе|пос\.|пгт|село|деревн|мкр|микрорайон|дом)(?![\p{L}\p{N}_])/u.test(value)) return false;
    if (/(^|[,\s])г\.?\s*[а-яё]/u.test(value)) return false;
    if (/(?:^|[^\p{L}\p{N}_])д\.\s*\d/u.test(value)) return false;
    return true;
  }

  private clip(value: string): string {
    const compact = value.trim().replace(/\s+/gu, " ");
    if (len(compact) <= 180) return compact;
    return `${Array.from(compact).slice(0, 177).join("")}...`;
  }

  private make(topic: string, field: string, quote: string, problem: string, recommendation: string, severity: "hard" | "soft"): Remark {
    return { topic, field, quote, problem, recommendation, _severity: severity };
  }

  private publicRemark(remark: Remark): PublicRemark {
    return {
      topic: remark.topic,
      field: remark.field,
      quote: remark.quote,
      problem: remark.problem,
      recommendation: remark.recommendation,
    };
  }
}
