/**
 * Measures API latency (p50/p95/p99) against a running server using the demo account.
 *   API_URL=http://localhost:4000 npx tsx scripts/latency.ts
 */
const API = (process.env.API_URL ?? 'http://localhost:4000') + '/api/v1';
const N = Number(process.env.N ?? 50);

async function main() {
  const login = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'demo@smartscheduling.dev', password: 'password123' }),
  });
  if (!login.ok) throw new Error('Login failed — run `npm run db:seed` first');
  const { accessToken } = await login.json();
  const h = { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' };
  const endpoints: [string, string][] = [
    ['GET', '/projects'],
    ['GET', '/calendar'],
    ['GET', '/briefings/daily'],
    ['GET', '/analytics/deadline-risk'],
    ['POST', '/schedules/preview'],
  ];
  console.log(`| Endpoint | p50 (ms) | p95 (ms) | p99 (ms) |  (n=${N})`);
  console.log('|---|---|---|---|');
  for (const [method, path] of endpoints) {
    const times: number[] = [];
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      const r = await fetch(API + path, { method, headers: h });
      await r.arrayBuffer();
      if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}`);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const q = (p: number) => times[Math.min(times.length - 1, Math.floor(p * times.length))].toFixed(1);
    console.log(`| ${method} ${path} | ${q(0.5)} | ${q(0.95)} | ${q(0.99)} |`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
