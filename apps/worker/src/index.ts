// `tsx src/index.ts` runs the worker; `tsx src/index.ts probe` checks the machine and exits.
const command = process.argv[2];

if (command === "probe") {
  const { runProbeCli } = await import("./probe-cli.js");
  process.exitCode = await runProbeCli();
} else if (command === undefined) {
  const { runWorker } = await import("./worker.js");
  runWorker();
} else {
  console.error(`unknown command: ${command}. Usage: tsx src/index.ts [probe]`);
  process.exitCode = 2;
}
