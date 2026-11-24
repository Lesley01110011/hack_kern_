import path from "node:path";
import { Runner } from "../lib/runner";

const args = process.argv.slice(2);
let fixture: string | null = null;
let max: number | null = null;
let pageSize: number | null = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--fixture" && args[i + 1]) fixture = path.resolve(args[++i]);
  else if (args[i] === "--max" && args[i + 1]) max = Number(args[++i]);
  else if (args[i] === "--page-size" && args[i + 1]) pageSize = Number(args[++i]);
}

async function main() {
  try {
    await new Runner().execute(fixture, max, pageSize);
    process.stdout.write("Готово\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}

main();
