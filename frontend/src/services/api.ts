import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import type { ApiErrorBody } from '../types';

const BASE = import.meta.env.VITE_API_URL ?? '';
const ACCESS = 'ss.access';
const REFRESH = 'ss.refresh';

/** Tokens live in localStorage; reads/writes are guarded for private windows. */
export const tokens = {
  get access() {
    try { return localStorage.getItem(ACCESS); } catch { return null; }
  },
  get refresh() {
    try { return localStorage.getItem(REFRESH); } catch { return null; }
  },
  set(access: string, refresh: string) {
    try { localStorage.setItem(ACCESS, access); localStorage.setItem(REFRESH, refresh); } catch { /* ignore */ }
  },
  clear() {
    try { localStorage.removeItem(ACCESS); localStorage.removeItem(REFRESH); } catch { /* ignore */ }
  },
};

export const api = axios.create({ baseURL: `${BASE}/api/v1` });

api.interceptors.request.use((config) => {
  const t = tokens.access;
  if (t) config.headers.Authorization = `Bearer ${t}`;
  return config;
});

let refreshing: Promise<string | null> | null = null;
export let onAuthLost: () => void = () => undefined;
export function setOnAuthLost(fn: () => void) { onAuthLost = fn; }

async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = tokens.refresh;
  if (!refreshToken) return null;
  try {
    const res = await axios.post(`${BASE}/api/v1/auth/refresh`, { refreshToken });
    tokens.set(res.data.accessToken, res.data.refreshToken);
    return res.data.accessToken as string;
  } catch {
    tokens.clear();
    return null;
  }
}

/** On 401, refresh once (shared across concurrent requests) and retry. */
api.interceptors.response.use(undefined, async (error: AxiosError) => {
  const original = error.config as (InternalAxiosRequestConfig & { _retried?: boolean }) | undefined;
  if (error.response?.status === 401 && original && !original._retried && !original.url?.startsWith('/auth/')) {
    original._retried = true;
    refreshing ??= refreshAccessToken().finally(() => { refreshing = null; });
    const t = await refreshing;
    if (t) {
      original.headers.Authorization = `Bearer ${t}`;
      return api(original);
    }
    onAuthLost();
  }
  throw error;
});

export function apiError(e: unknown): ApiErrorBody & { status?: number } {
  if (axios.isAxiosError(e)) {
    const body = (e.response?.data as { error?: ApiErrorBody } | undefined)?.error;
    if (body) return { ...body, status: e.response?.status };
    return { code: 'NETWORK', message: e.message, status: e.response?.status };
  }
  return { code: 'UNKNOWN', message: e instanceof Error ? e.message : String(e) };
}
