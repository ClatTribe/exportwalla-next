// Runs a batch of calls through the Python engine (export-desk/evals/bridge.py) and returns its answers in order.
import { spawn } from "node:child_process";
import path from "node:path";

const PY_APP = process.env.EXPORTWALLA_PY ?? path.resolve(process.cwd(), "../export-desk");

export type Call = { fn: string; args: unknown[] };
export type Answer = { ok: true; value: unknown } | { ok: false; error: string };

export function python(calls: Call[]): Promise<Answer[]> {
  return new Promise((resolve, reject) => {
    const p = spawn(path.join(PY_APP, ".venv/bin/python"), ["-m", "evals.bridge"], {
      cwd: PY_APP, env: { ...process.env, EXPORTWALLA_READONLY: "1" },
    });
    const out: Buffer[] = [], err: Buffer[] = [];
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => err.push(d));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error("python bridge failed: " + Buffer.concat(err).toString().slice(-2000)));
      const lines = Buffer.concat(out).toString().trim().split("\n").map((l) => JSON.parse(l) as Answer);
      if (lines.length !== calls.length) return reject(new Error(`bridge returned ${lines.length} answers for ${calls.length} calls`));
      resolve(lines);
    });
    p.stdin.end(calls.map((c) => JSON.stringify(c)).join("\n") + "\n");
  });
}

/** Runs the same call in TypeScript, shaped like the bridge's answer (JSON round trip, so key order and
 * undefined-vs-missing don't matter, exactly as when the API serialises it). */
export function ts(fn: () => unknown): Answer {
  try {
    const v = fn();
    return { ok: true, value: v === undefined ? null : JSON.parse(JSON.stringify(v)) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
