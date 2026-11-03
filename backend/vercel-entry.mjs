// Vercel entrypoint for the backend service (see vercel.json).
// Vercel checks the entrypoint exists before building, so this file is
// committed and re-exports the bundle that `npm run vercel-build` writes.
// The .mjs extensions make Node load both files as ES modules, even though
// Vercel does not ship backend/package.json ("type": "module") with them.
// The bundle must not live in dist/: when dist/ exists, Vercel deploys its
// contents as the whole function and leaves out node_modules.
export { default } from './bundle/server.mjs';
