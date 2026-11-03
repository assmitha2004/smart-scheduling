import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { useState } from 'react';
import { useAuth } from '../services/auth';
import { NotificationsBell } from './NotificationsBell';
import { useRealtime } from '../hooks/useRealtime';

const NAV = [
  { to: '/app', label: 'Dashboard', icon: 'M3 12l9-9 9 9M5 10v10h14V10', end: true },
  { to: '/app/calendar', label: 'Calendar', icon: 'M4 6h16v14H4zM4 10h16M9 3v4M15 3v4' },
  { to: '/app/projects', label: 'Projects', icon: 'M3 7h7l2 2h9v10H3z' },
  { to: '/app/planning', label: 'Smart planning', icon: 'M12 3l2.5 5 5.5.8-4 3.9.9 5.5L12 15.6 7.1 18.2 8 12.7 4 8.8l5.5-.8z' },
  { to: '/app/analytics', label: 'Analytics', icon: 'M4 20V10M10 20V4M16 20v-7M22 20H2' },
  { to: '/app/settings', label: 'Settings', icon: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z' },
];

export function Logo() {
  return (
    <span className="flex items-center gap-2 font-semibold tracking-tight">
      <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden><rect width="32" height="32" rx="8" fill="var(--c-accent)" /><path d="M9 11h14M9 16h9M9 21h11" stroke="var(--c-accent-fg)" strokeWidth="2.5" strokeLinecap="round" /></svg>
      Smart Scheduling
    </span>
  );
}

export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  useRealtime(!!user);
  const nav = (
    <nav className="flex flex-col gap-0.5">
      {NAV.map((n) => (
        <NavLink key={n.to} to={n.to} end={n.end} onClick={() => setMobileOpen(false)}
          className={({ isActive }) => clsx('flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm', isActive ? 'bg-accent-soft font-medium text-accent' : 'text-muted hover:bg-surface-2 hover:text-fg')}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={n.icon} /></svg>
          {n.label}
        </NavLink>
      ))}
    </nav>
  );
  return (
    <div className="flex min-h-full">
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-border bg-surface p-3 md:flex">
        <div className="mb-6 px-2 pt-1"><Logo /></div>
        {nav}
        <div className="mt-auto border-t border-border px-2 pt-3 text-xs text-muted">
          <div className="truncate font-medium text-fg">{user?.name}</div>
          <div className="truncate">{user?.timezone}</div>
          <button className="mt-2 text-accent" onClick={async () => { await logout(); navigate('/'); }}>Sign out</button>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center justify-between border-b border-border bg-surface/90 px-4 py-2 backdrop-blur md:justify-end">
          <button className="rounded p-2 text-muted md:hidden" onClick={() => setMobileOpen((o) => !o)} aria-label="Menu">☰</button>
          <div className="md:hidden"><Logo /></div>
          <NotificationsBell />
        </header>
        {mobileOpen && <div className="border-b border-border bg-surface p-3 md:hidden">{nav}</div>}
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6"><Outlet /></main>
      </div>
    </div>
  );
}
