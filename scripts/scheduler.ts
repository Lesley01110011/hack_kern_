import fs from "node:fs";
import { Config } from "../lib/config";
import { dataPath } from "../lib/root";
import { Runner } from "../lib/runner";
import { isoNow } from "../lib/text";

async function main() {
process.stdout.write("Планировщик запущен. Остановка: Ctrl+C\n");
const statePath = dataPath("schedule_state.json");

while (true) {
  try {
    const config = Config.load();
    let state: { last_run?: number } = {};
    if (fs.existsSync(statePath)) {
      const decoded = JSON.parse(fs.readFileSync(statePath, "utf8"));
      state = decoded && typeof decoded === "object" ? decoded : {};
    }
    const last = Number(state.last_run ?? 0);
    const due = config.scheduleEnabled() && (Date.now() / 1000 - last) >= config.intervalMinutes() * 60;
    const runner = new Runner();
    if (due && !runner.isLocked()) {
      state.last_run = Math.floor(Date.now() / 1000);
      fs.writeFileSync(statePath, JSON.stringify(state));
      process.stdout.write(`${isoNow()} запуск\n`);
      await runner.execute(null, null, null);
      process.stdout.write(`${isoNow()} готово\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${isoNow()} ${message}\n`);
  }
  await new Promise((resolve) => setTimeout(resolve, 20_000));
}
}

main();
