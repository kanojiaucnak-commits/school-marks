/**
 * A minimal `Deno` global so the Edge Function sources can be imported under Node.
 *
 * Only `env.get` and `env.toObject` are provided, and both are backed by
 * `process.env`. That is an exact equivalent rather than a stand-in, so nothing is
 * hidden: a genuine change to how the sources read configuration still shows up in
 * these tests. Providing more of the `Deno` API is deliberately avoided — the moment
 * a shim starts *faking* behaviour rather than translating it, a green test proves
 * nothing.
 *
 * `_shared/auth.ts` reads `Deno.env` at module scope, so this has to be in place
 * before any test imports it.
 */
if (typeof globalThis.Deno === 'undefined') {
  Object.defineProperty(globalThis, 'Deno', {
    configurable: true,
    writable: true,
    value: {
      env: {
        get: (key: string) => process.env[key],
        toObject: () => ({ ...process.env }),
      },
    },
  });
}