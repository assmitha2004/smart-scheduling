import { useEffect } from 'react';
import { io } from 'socket.io-client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, tokens } from '../services/api';
import { useToast } from '../components/Toast';

/**
 * Live updates: refetch affected data when the server reports changes.
 * Serverless deployments (e.g. Vercel) have no WebSocket server; the API
 * says so via /meta and the app falls back to normal refetching.
 */
export function useRealtime(enabled: boolean) {
  const qc = useQueryClient();
  const toast = useToast();
  const meta = useQuery({
    queryKey: ['meta'],
    enabled,
    staleTime: Infinity,
    retry: false,
    queryFn: async () => (await api.get<{ realtime: boolean }>('/meta')).data,
  });
  const realtime = meta.data?.realtime === true;
  useEffect(() => {
    if (!enabled || !realtime || !tokens.access) return;
    const socket = io(import.meta.env.VITE_API_URL ?? '/', { auth: { token: tokens.access }, transports: ['websocket'] });
    const refreshPlan = () => {
      for (const k of ['calendar', 'briefing', 'risk', 'timeline', 'analytics']) qc.invalidateQueries({ queryKey: [k] });
    };
    socket.on('schedule:updated', refreshPlan);
    socket.on('calendar:updated', refreshPlan);
    socket.on('task:updated', () => {
      for (const k of ['tasks', 'task', 'projects', 'timeline', 'briefing']) qc.invalidateQueries({ queryKey: [k] });
    });
    socket.on('notification:new', (n: { message: string }) => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
      toast.show(n.message, 'info');
    });
    return () => { socket.disconnect(); };
  }, [enabled, realtime, qc, toast]);
}
