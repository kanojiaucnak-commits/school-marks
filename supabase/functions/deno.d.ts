/**
 * Minimal ambient Deno surface for editor/`tsc` typechecking.
 *
 * The Edge Functions run on Deno and reference `Deno.env`, `Deno.serve` and
 * `Deno.readTextFile`. `tsc` under Node has no such global, and the alternative
 * was to have these functions excluded from typechecking altogether — which is
 * how a type error reached `report-generate` in the first place.
 *
 * Only the members actually used are declared. A wider stub would let code type
 * -check against APIs that do not exist on the deployed runtime, which is worse
 * than not checking.
 */

declare namespace Deno {
  /** Process environment. Secrets for Edge Functions arrive here at runtime. */
  const env: {
    get(key: string): string | undefined;
    set(key: string, value: string): void;
    has(key: string): boolean;
    delete(key: string): void;
    toObject(): Record<string, string>;
  };

  function serve(handler: (request: Request) => Response | Promise<Response>): {
    finished: Promise<void>;
    shutdown(): Promise<void>;
  };

  function readTextFile(path: string | URL): Promise<string>;
  function readFile(path: string | URL): Promise<Uint8Array>;
  function writeTextFile(path: string | URL, data: string): Promise<void>;
}
