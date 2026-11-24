import fs from "node:fs";
import path from "node:path";

export type StatusFile = {
  state: string;
  message: string;
  processed: number;
  total: number;
  started_at: string | null;
  finished_at: string | null;
};

export class RunStatus {
  constructor(private filePath: string) {}

  read(): StatusFile {
    if (!fs.existsSync(this.filePath)) return idle();
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return data && typeof data === "object" ? { ...idle(), ...data } : idle();
    } catch {
      return idle();
    }
  }

  update(patch: Partial<StatusFile>): void {
    const data = { ...this.read(), ...patch };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(data));
  }
}

function idle(): StatusFile {
  return {
    state: "idle",
    message: "",
    processed: 0,
    total: 0,
    started_at: null,
    finished_at: null,
  };
}
