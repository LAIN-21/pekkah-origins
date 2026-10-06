// docs/RUNS.md: the runs table first, then the Masumi evidence after a marker, so new rows
// always join the table (scripts/demo-check.sh).
const HEADER =
  "# Runs\n\nReal runs on Cardano preprod, appended by `scripts/demo-check.sh`.\n\n| Time (SGT) | Scenario | Worker | Price | Tx | Duration | sha256 |\n| --- | --- | --- | --- | --- | --- | --- |\n";
const MARKER = "<!-- masumi-evidence -->";
const EVIDENCE_INTRO = `${MARKER}\n## Masumi evidence\n\nWritten by \`scripts/demo-check.sh --escrow\` from the run's events (PLAN 12.3).\n\n`;

/** The file with `rows` (table lines) added to the runs table and `block` to the evidence. */
export function updateRunsMd(text: string | null, rows: string[], block?: string): string {
  const current = text ?? HEADER;
  const at = current.indexOf(MARKER);
  const table =
    (at >= 0 ? current.slice(0, at) : current).replace(/\n*$/, "\n") +
    rows.map((r) => `${r}\n`).join("");
  let evidence = at >= 0 ? current.slice(at) : "";
  if (block) evidence = `${evidence || EVIDENCE_INTRO}${block.replace(/\n*$/, "\n")}\n`;
  return evidence ? `${table}\n${evidence}` : table;
}
