// Runs one build in its own worker thread and resolves with its outcome.
// No vscode import, so the tests run it in plain Node.

import { Worker } from "worker_threads";
import * as path from "path";
import type { BuildOutcome, BuildRequest } from "./build";

export function runBuild(request: BuildRequest): Promise<BuildOutcome> {
  return new Promise(resolve => {
    const worker = new Worker(path.join(__dirname, "buildWorker.js"), { workerData: request });
    let settled = false;
    const finish = (outcome: BuildOutcome) => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      resolve(outcome);
    };
    const failed = (message: string): BuildOutcome =>
      ({ ok: false, usedFiles: [], problems: [{ severity: "error", message }] });
    worker.once("message", (outcome: BuildOutcome) => finish(outcome));
    worker.once("error", err => finish(failed(err.message)));
    worker.once("exit", code => finish(failed(`the build worker exited with code ${code}`)));
  });
}
