const { exec } = require("node:child_process");
const { createServer } = require("node:http");
const next = require("next");

const port = Number.parseInt(process.env.PORT || "3000", 10);
const dev = process.env.NODE_ENV !== "production";
const app = next({ dev, hostname: "localhost", port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer((req, res) => {
    handle(req, res);
  });
  server.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log(`PARADON: ${url}`);
    const command = process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
    exec(command);
  });
  server.on("error", (error) => {
    console.error(error.message);
    process.exit(1);
  });
});
