import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, setOnAuthLost, tokens } from './api';
import type { User } from '../types';
import { queryClient } from './queryClient';

interface AuthState {
  user: User | null;
  loading: boolean;
  login(email: string, password: string): Promise<User>;
  register(name: string, email: string, password: string): Promise<User>;
  logout(): Promise<void>;
  setUser(u: User): void;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setOnAuthLost(() => { setUser(null); queryClient.clear(); });
    if (!tokens.access && !tokens.refresh) { setLoading(false); return; }
    api.get('/users/me')
      .then((r) => setUser(r.data.user))
      .catch(() => tokens.clear())
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const r = await api.post('/auth/login', { email, password });
    tokens.set(r.data.accessToken, r.data.refreshToken);
    setUser(r.data.user);
    return r.data.user as User;
  }, []);

  const register = useCallback(async (name: string, email: string, password: string) => {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const r = await api.post('/auth/register', { name, email, password, timezone });
    tokens.set(r.data.accessToken, r.data.refreshToken);
    setUser(r.data.user);
    return r.data.user as User;
  }, []);

  const logout = useCallback(async () => {
    const refreshToken = tokens.refresh;
    if (refreshToken) await api.post('/auth/logout', { refreshToken }).catch(() => undefined);
    tokens.clear();
    queryClient.clear();
    setUser(null);
  }, []);

  return <Ctx.Provider value={{ user, loading, login, register, logout, setUser }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth outside AuthProvider');
  return c;
}
