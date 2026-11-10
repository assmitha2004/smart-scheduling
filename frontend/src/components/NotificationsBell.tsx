import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import type { Notification } from '../types';
import { useAuth } from '../services/auth';
import { fmtDateTime } from '../lib/format';

const ICON: Record<string, string> = { TASK_REMINDER: '⏰', DEADLINE_RISK: '⚠️', DEPENDENCY_UNBLOCKED: '🔓', DAILY_PLAN: '☀️', CARRIED_OVER: '↪️' };

export function NotificationsBell() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: async () => (await api.get<{ notifications: Notification[]; unreadCount: number }>('/notifications')).data,
    refetchInterval: 60_000,
  });
  const readAll = useMutation({
    mutationFn: () => api.post('/notifications/read-all'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const unread = data?.unreadCount ?? 0;
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="relative rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-fg" aria-label={`Notifications (${unread} unread)`}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>
        {unread > 0 && <span className="absolute -right-0.5 -top-0.5 rounded-full bg-danger px-1.5 text-[10px] font-semibold text-white">{unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-surface shadow-xl">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-sm font-semibold">Notifications</span>
            {unread > 0 && <button className="text-xs text-accent" onClick={() => readAll.mutate()}>Mark all read</button>}
          </div>
          <ul className="max-h-96 overflow-y-auto">
            {!data?.notifications.length && <li className="px-3 py-6 text-center text-sm text-muted">You're all caught up.</li>}
            {data?.notifications.map((n) => (
              <li key={n.id} className={`border-b border-border px-3 py-2 text-sm last:border-0 ${n.readAt ? 'opacity-60' : ''}`}>
                <div className="flex gap-2"><span aria-hidden>{ICON[n.type] ?? '•'}</span><span>{n.message}</span></div>
                <div className="mt-0.5 pl-6 text-xs text-muted">{fmtDateTime(n.createdAt, user?.timezone ?? 'UTC')}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
