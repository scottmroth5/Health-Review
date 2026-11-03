# 0005: Run TypeScript through Node's type stripping; tsc only checks

- **Status:** accepted (Phase 0 spike, 2026-11-02; the image check is still to run, see below)
- **Date:** 2026-11-02

## Context
TypeScript becomes the core language in v3 (the AI service is Python). The code is ESM JavaScript with no build step today. The production image runs `node server/index.js` as a non-root user, and npm is removed from it.

Node 22.18 and later remove TypeScript types natively when they load a `.ts` file. The image uses Node 22 (`node:22-bookworm-slim`), and the PC has Node 22.22 (`process.features.typescript` is `strip`).

## What the spike showed (Node 22.22, scratchpad, nothing shipped)
- **Imports work both ways:** a `.js` module imports a `.ts` module, and that imports a `.js` one. Imports must name the real file, `./a.ts`. Without an extension the import fails, as it does for `.js` today.
- **`node --test` runs `.ts` tests,** both named and found by the default discovery that `npm test` uses.
- **Stack traces point at the right `.ts` line and column without source maps,** because types are replaced by spaces and positions don't move.
- **`node --env-file` works unchanged.**
- **Only syntax that can simply be deleted runs.** An `enum` fails at load (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`), and tsc catches it first with `erasableSyntaxOnly`.
- **A type imported without the `type` keyword fails at run time** ("does not provide an export named"). tsc catches it first with `verbatimModuleSyntax`.

## Decision
- **No build step.** Node runs `.ts` directly. tsc never emits; it only checks (`npm run typecheck`).
- **`tsconfig.json`:**
  - `allowImportingTsExtensions`, `erasableSyntaxOnly` and `verbatimModuleSyntax`, so whatever passes the typecheck also runs under Node's type stripping;
  - `module` and `moduleResolution` `nodenext`;
  - `allowJs` and `checkJs`, so JavaScript is checked as folders are added.
- **Allowed syntax:** no enums, namespaces, parameter properties or decorators. Use union types and `as const` objects instead.
- **TypeScript is pinned to 6.0.x for now.** TypeScript 7 (the native compiler) is out, but typescript-eslint 8.71 supports TypeScript below 6.1, and the promise lint rules need it. Move to 7 when typescript-eslint supports it.
- **Browser code stays plain JavaScript with no build** (strict CSP, `script-src 'self'`). Its shared modules (`goals.js`, `zone-defaults.js`) get their own ADR in Phase 2.

## Alternatives considered
- **A tsc build into `dist/`:** it adds a build stage, source maps, a second copy of every path in the npm scripts and CLAUDE.md, and a chance of running stale output. Its only gain is syntax we've chosen not to use.
- **tsx or another loader:** it would add a runtime dependency to an image that runs only `node`.

## Consequences
- **Moving a file is a rename plus type annotations,** with no change to how it runs. The guards already scan `.ts`, `.mts` and `.cts` (Phase 0).
- **Type stripping isn't type checking,** so CI must keep `npm run typecheck`. A wrong type runs anyway if the check is skipped.
- **Still open: the image check.** Docker was not running on the development machine during the spike. Before the first `.ts` file ships:
  - build the real image;
  - confirm `node -p process.features.typescript` prints `strip`;
  - confirm a `.ts` module loads under the read-only, non-root, npm-free image.

  Then add that check to the Dockerfile, so a base image without stripping fails the build.
