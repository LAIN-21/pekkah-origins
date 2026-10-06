import { spawn } from "node:child_process";

export interface DockerResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Docker = (args: string[]) => Promise<DockerResult>;

/** The docker CLI with an argument array, never a shell string. */
export const docker: Docker = (args) =>
  new Promise((resolve) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: String(err) }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
