import { createInterface } from "node:readline/promises";
import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";

import { OpCliError } from "../core/errors.js";

/**
 * Minimal structural view of a readable prompt source: `process.stdin`
 * satisfies it, and tests pass plain PassThrough streams. A stream that
 * offers `setRawMode` is a terminal, so its driver echoes keystrokes
 * unless raw mode silences it; anything else cannot echo at all.
 */
export interface PromptInput extends Readable {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  setRawMode?(enabled: boolean): void;
}

export interface NodeIo {
  readonly prompt: (message: string, secret: boolean) => Promise<string>;
  readonly readStdin: () => Promise<string>;
  readonly stdinIsTTY: boolean;
}

const ENV_HINT =
  "set OPENPROJECT_URL and OPENPROJECT_API_KEY in the environment for non-interactive use.";

/**
 * The binary's RunIo over real streams. Both prompt styles are bounded:
 * a readline question races the interface's close event, so EOF settles
 * the wait instead of hanging the awaited run() forever, and a secret is
 * read through a raw-mode byte loop that never forwards keystrokes to
 * the output stream.
 */
export function createNodeIo(
  input: PromptInput = process.stdin,
  output: Writable = process.stdout,
): NodeIo {
  const stdinIsTTY = input.isTTY === true;

  // Executor form on purpose: Promise.withResolvers needs ES2024, and the
  // published engines field still supports Node 20.
  const askLine = (message: string): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      const line = createInterface({ input, output });
      let settled = false;
      const eofError = new OpCliError(
        "USAGE_ERROR",
        "stdin closed while waiting for input.",
        ENV_HINT,
      );
      const settle = (finish: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        line.removeListener("close", onClose);
        finish();
        // Closing after every question keeps the process free to exit;
        // an open interface would hold the event loop open.
        line.close();
      };
      const onClose = (): void => settle(() => reject(eofError));
      line.once("close", onClose);
      void line.question(message).then(
        (answer) => settle(() => resolve(answer)),
        (error) => settle(() => reject(error)),
      );
    });

  const readSecret = async (message: string): Promise<string> => {
    output.write(message);
    const wasRaw = input.isRaw === true;
    if (typeof input.setRawMode === "function" && !wasRaw) {
      input.setRawMode(true);
    }
    const decoder = new StringDecoder("utf8");
    let answer = "";
    let terminated = false;
    try {
      for await (const chunk of input) {
        const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
        for (const char of text) {
          if (char === "\r" || char === "\n") {
            terminated = true;
            break;
          }
          if (char === "\b" || char === "\u007f") {
            answer = answer.slice(0, -1);
            continue;
          }
          if (char === "\u0003") {
            throw new OpCliError(
              "USAGE_ERROR",
              "credential entry cancelled.",
              ENV_HINT,
            );
          }
          answer += char;
        }
        if (terminated) {
          break;
        }
      }
      if (!terminated) {
        throw new OpCliError(
          "USAGE_ERROR",
          "stdin closed while waiting for input.",
          ENV_HINT,
        );
      }
      output.write("\n");
      return answer;
    } finally {
      if (typeof input.setRawMode === "function") {
        input.setRawMode(wasRaw);
      }
    }
  };

  return {
    stdinIsTTY,
    prompt: (message, secret) => (secret ? readSecret(message) : askLine(message)),
    readStdin: async () => {
      const chunks: Array<Uint8Array> = [];
      for await (const chunk of input) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      return Buffer.concat(chunks).toString("utf8");
    },
  };
}
