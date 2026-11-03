// Builds the backend for Vercel as a self-contained bundle (run by `npm run vercel-build`).
//
// Vercel does not reliably ship backend/node_modules or backend/package.json
// with the function, so everything the API needs is placed in bundle/:
//   - server.mjs: src/app.ts with all JS dependencies bundled in. The .mjs
//     extension makes Node load it as an ES module without "type": "module".
//   - schema.prisma + the Prisma query engine for Vercel's runtime
//     (rhel-openssl-3.0.x). The generated Prisma client looks for both next
//     to the code that loads it, which after bundling is server.mjs.
// vercel-entry.mjs (the service entrypoint in vercel.json) re-exports server.mjs.
import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const outDir = 'bundle';
// When dist/ exists, Vercel deploys only its contents as the function.
rmSync('dist', { recursive: true, force: true });
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir);

await build({
  entryPoints: ['src/app.ts'],
  outfile: join(outDir, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Optional native add-ons that ws (via socket.io) loads inside try/catch.
  external: ['bufferutil', 'utf-8-validate'],
  // Bundled CommonJS packages expect require, __filename and __dirname.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __pathDirname } from 'node:path';",
      'const require = __createRequire(import.meta.url);',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __pathDirname(__filename);',
    ].join('\n'),
  },
  logLevel: 'warning',
});

const prismaDir = join('node_modules', '.prisma', 'client');
const engines = readdirSync(prismaDir).filter((f) => f.startsWith('libquery_engine-rhel-openssl-3.0.x'));
if (process.env.VERCEL && engines.length === 0) {
  throw new Error(`No rhel-openssl-3.0.x Prisma engine in ${prismaDir}; check binaryTargets in schema.prisma`);
}
for (const file of ['schema.prisma', ...engines]) {
  if (existsSync(join(prismaDir, file))) copyFileSync(join(prismaDir, file), join(outDir, file));
}
console.log(`Built ${outDir}/server.mjs (+ ${['schema.prisma', ...engines].join(', ')})`);
