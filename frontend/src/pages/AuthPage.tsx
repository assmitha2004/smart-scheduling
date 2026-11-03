import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../services/auth';
import { apiError } from '../services/api';
import { Button, ErrorBox, Field, Input } from '../components/ui';
import { Logo } from '../components/Layout';

export default function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const { login, register } = useAuth();
  const navigate = useNavigate();
  const loc = useLocation();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const u = mode === 'login' ? await login(email, password) : await register(name, email, password);
      const from = (loc.state as { from?: string } | null)?.from;
      navigate(!u.onboarded ? '/onboarding' : from ?? '/app', { replace: true });
    } catch (err) {
      const e2 = apiError(err);
      const details = Array.isArray(e2.details) ? (e2.details as { message: string }[]).map((d) => d.message).join(', ') : '';
      setError(details ? `${e2.message}: ${details}` : e2.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <Link to="/" className="mb-8 flex justify-center"><Logo /></Link>
        <form onSubmit={submit} className="space-y-4 rounded-xl border border-border bg-surface p-6">
          <h1 className="text-lg font-semibold">{mode === 'login' ? 'Welcome back' : 'Create your account'}</h1>
          {error && <ErrorBox message={error} />}
          {mode === 'register' && <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" /></Field>}
          <Field label="Email"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" /></Field>
          <Field label="Password" hint={mode === 'register' ? 'At least 8 characters' : undefined}>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={mode === 'register' ? 8 : 1} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
          </Field>
          <Button type="submit" loading={busy} className="w-full">{mode === 'login' ? 'Log in' : 'Create account'}</Button>
          <p className="text-center text-sm text-muted">
            {mode === 'login' ? <>New here? <Link className="text-accent" to="/register">Create an account</Link></> : <>Have an account? <Link className="text-accent" to="/login">Log in</Link></>}
          </p>
          {mode === 'login' && <p className="text-center text-xs text-muted">Demo: demo@smartscheduling.dev / password123</p>}
        </form>
      </div>
    </div>
  );
}
