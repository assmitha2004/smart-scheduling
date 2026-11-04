import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, apiError, tokens } from '../../services/api';
import { useAuth } from '../../services/auth';
import { useToast } from '../../components/Toast';
import { Button, Card, ErrorBox, Field, Input, Modal } from '../../components/ui';
import { fmtDate } from '../../lib/format';
import type { User } from '../../types';
import { ProBadge, ProGate, usePlan, useStartTrial } from '../billing/plan';
import { PricingCards } from '../billing/Pricing';
import { useInstallPrompt } from '../../hooks/useInstallPrompt';

export function PlanTab() {
  const { user, setUser } = useAuth();
  const plan = usePlan();
  const trial = useStartTrial();
  const toast = useToast();
  const billing = useQuery({ queryKey: ['billing'], queryFn: async () => (await api.get<{ paymentsEnabled: boolean; trialUsed: boolean }>('/billing')).data });
  const [confirmCancel, setConfirmCancel] = useState(false);
  const cancel = useMutation({
    mutationFn: async () => (await api.post<{ user: User }>('/billing/cancel')).data.user,
    onSuccess: (u) => { setUser(u); setConfirmCancel(false); toast.show('You’re on the Free plan now. All your data is safe.', 'success'); },
  });
  const tz = user?.timezone ?? 'UTC';
  return (
    <div className="space-y-5">
      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <div className="text-3xl" aria-hidden>{plan.isPro ? '✨' : '🌱'}</div>
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 font-semibold">{plan.isPro ? <>Pro <ProBadge /></> : 'Free plan'}{plan.trialing && <span className="text-sm font-normal text-muted">· trial</span>}</p>
            <p className="text-sm text-muted">
              {plan.trialing ? `Your free trial ends ${fmtDate(user!.billing.trialEndsAt, tz)} (${plan.trialDaysLeft} day${plan.trialDaysLeft === 1 ? '' : 's'} left). After that you move to Free automatically, with nothing to cancel.`
                : plan.paidPro ? 'Thanks for supporting Smart Scheduling! 💜'
                : 'Upgrade any time for month planning, calendar sync, weekly reviews and team workspaces.'}
            </p>
          </div>
          {plan.isPro && <Button variant="ghost" size="sm" onClick={() => setConfirmCancel(true)}>{plan.trialing ? 'End trial now' : 'Cancel Pro'}</Button>}
        </div>
      </Card>
      {trial.error && <ErrorBox message={trial.error} />}
      <PricingCards current={plan.isPro ? 'PRO' : 'FREE'} action={(id) => id === 'FREE' ? (
        <Button variant="secondary" className="w-full" disabled>{plan.isPro ? 'Included in Pro' : 'Current plan'}</Button>
      ) : plan.isPro ? (
        <Button className="w-full" disabled>{plan.trialing ? `Trial active · ${plan.trialDaysLeft}d left` : 'Current plan'}</Button>
      ) : !billing.data?.trialUsed ? (
        <Button className="w-full" onClick={trial.start} loading={trial.busy}>Start 14-day free trial</Button>
      ) : (
        <div>
          <Button className="w-full" disabled={!billing.data?.paymentsEnabled}>Upgrade to Pro</Button>
          {!billing.data?.paymentsEnabled && <p className="mt-2 text-center text-xs text-muted">Card checkout isn’t connected on this deployment yet.</p>}
        </div>
      )} />
      <Modal open={confirmCancel} onClose={() => setConfirmCancel(false)} title={plan.trialing ? 'End your trial?' : 'Cancel Pro?'}
        footer={<><Button variant="ghost" onClick={() => setConfirmCancel(false)}>Keep Pro</Button><Button variant="danger" loading={cancel.isPending} onClick={() => cancel.mutate()}>Switch to Free</Button></>}>
        <p className="text-sm">You’ll lose month planning, calendar sync (your feed link stops working), weekly reviews and new team invites. Your tasks, plans and history all stay.</p>
      </Modal>
    </div>
  );
}

export function IntegrationsTab() {
  const toast = useToast();
  const install = useInstallPrompt();
  const feed = useQuery({ queryKey: ['calendar-feed'], queryFn: async () => (await api.get<{ enabled: boolean; path: string | null }>('/calendar-feed')).data });
  const create = useMutation({ mutationFn: async () => (await api.post<{ path: string }>('/calendar-feed')).data, onSuccess: () => feed.refetch() });
  const remove = useMutation({ mutationFn: () => api.delete('/calendar-feed'), onSuccess: () => feed.refetch() });
  const url = feed.data?.path ? `${window.location.origin}${feed.data.path}` : null;
  const webcal = url?.replace(/^https?:/, 'webcal:');
  const copy = async () => { try { await navigator.clipboard.writeText(url!); toast.show('Link copied! 📋', 'success'); } catch { toast.show('Couldn’t copy. Select the link and copy it manually.', 'error'); } };
  return (
    <div className="space-y-5">
      <Card title={<span className="flex items-center gap-2">🔗 Calendar sync <ProBadge /></span>}>
        <ProGate feature="CALENDAR_SYNC" compact>
          <p className="mb-3 text-sm text-muted">Subscribe to your plan from Google Calendar, Apple Calendar or Outlook. Your study blocks, tasks, classes and meetings show up next to everything else, on every device, and update by themselves (calendar apps refresh every few hours).</p>
          {create.error && <div className="mb-3"><ErrorBox message={apiError(create.error).message} /></div>}
          {!url ? (
            <Button onClick={() => create.mutate()} loading={create.isPending}>Create my calendar link</Button>
          ) : (
            <div className="space-y-3">
              <div className="flex gap-2">
                <Input readOnly value={url} onFocus={(e) => e.target.select()} aria-label="Calendar feed link" className="font-mono text-xs" />
                <Button variant="secondary" onClick={copy}>Copy</Button>
              </div>
              <div className="flex flex-wrap gap-2">
                <a href={`https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcal!)}`} target="_blank" rel="noreferrer"><Button size="sm">Add to Google Calendar</Button></a>
                <a href={webcal}><Button size="sm" variant="secondary">Open in Apple Calendar / Outlook</Button></a>
              </div>
              <details className="text-sm text-muted">
                <summary className="cursor-pointer text-accent">Step-by-step for Google Calendar</summary>
                <ol className="mt-2 list-decimal space-y-1 pl-5">
                  <li>Open Google Calendar on a computer.</li>
                  <li>Next to “Other calendars”, click <b>+</b> then <b>From URL</b>.</li>
                  <li>Paste the link above and click <b>Add calendar</b>. It appears on your phone too.</li>
                </ol>
              </details>
              <p className="text-xs text-muted">🔒 Anyone with this link can see your schedule, so keep it private. If it leaks, make a new one: the old link stops working instantly.</p>
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" loading={create.isPending} onClick={() => create.mutate()}>Make a new link</Button>
                <Button size="sm" variant="ghost" loading={remove.isPending} onClick={() => remove.mutate()}>Turn off</Button>
              </div>
            </div>
          )}
        </ProGate>
      </Card>
      <Card title="📱 Install the app">
        {install.installed ? <p className="text-sm">You’re using the installed app. Nice! 🎉</p> : (
          <>
            <p className="mb-3 text-sm text-muted">Add Smart Scheduling to your home screen or desktop. It opens in its own window like a normal app, without the browser bars.</p>
            {install.canPrompt ? <Button onClick={install.install}>Install Smart Scheduling</Button>
              : install.ios ? <p className="text-sm">On iPhone/iPad: tap <b>Share</b> <span aria-hidden>⬆️</span> in Safari, then <b>Add to Home Screen</b>.</p>
              : <p className="text-sm">In Chrome or Edge, use the install icon in the address bar, or the menu → <b>Install app</b>. On Android: menu → <b>Add to Home screen</b>.</p>}
          </>
        )}
      </Card>
    </div>
  );
}

export function AccountTab() {
  const { user, logout } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [pwError, setPwError] = useState<string | null>(null);
  const [del, setDel] = useState({ open: false, password: '', confirm: '' });
  const [delError, setDelError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const changePw = useMutation({
    mutationFn: async () => (await api.post<{ accessToken: string; refreshToken: string }>('/account/password', { currentPassword: pw.currentPassword, newPassword: pw.newPassword })).data,
    onSuccess: (t) => { tokens.set(t.accessToken, t.refreshToken); setPw({ currentPassword: '', newPassword: '', confirm: '' }); setPwError(null); toast.show('Password changed. Other devices were signed out 🔒', 'success'); },
    onError: (e) => setPwError(apiError(e).message),
  });
  const remove = useMutation({
    mutationFn: () => api.delete('/account', { data: { password: del.password, confirm: 'DELETE' } }),
    onSuccess: async () => { tokens.clear(); await logout().catch(() => undefined); navigate('/', { replace: true }); },
    onError: (e) => setDelError(apiError(e).message),
  });

  async function exportData() {
    setExporting(true);
    try {
      const r = await api.get('/account/export', { responseType: 'blob' });
      const href = URL.createObjectURL(r.data as Blob);
      const a = Object.assign(document.createElement('a'), { href, download: `smart-scheduling-export-${new Date().toISOString().slice(0, 10)}.json` });
      a.click();
      URL.revokeObjectURL(href);
      toast.show('Your data is downloading 📦', 'success');
    } catch (e) {
      toast.show(apiError(e).message, 'error');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card title="🔒 Change password">
        <form className="space-y-3" onSubmit={(e) => {
          e.preventDefault();
          if (pw.newPassword.length < 8) return setPwError('New password must be at least 8 characters');
          if (pw.newPassword !== pw.confirm) return setPwError('The new passwords don’t match');
          changePw.mutate();
        }}>
          <Field label="Current password"><Input type="password" autoComplete="current-password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} /></Field>
          <Field label="New password" hint="At least 8 characters."><Input type="password" autoComplete="new-password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} /></Field>
          <Field label="Repeat new password"><Input type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} /></Field>
          {pwError && <ErrorBox message={pwError} />}
          <Button type="submit" loading={changePw.isPending} disabled={!pw.currentPassword || !pw.newPassword}>Change password</Button>
        </form>
      </Card>
      <div className="space-y-5">
        <Card title="📦 Your data">
          <p className="mb-3 text-sm text-muted">Download everything Smart Scheduling stores about you (profile, plans, tasks, calendar and history) as a JSON file.</p>
          <Button variant="secondary" onClick={exportData} loading={exporting}>Download my data</Button>
        </Card>
        <Card title="Danger zone" className="border-danger/30">
          <p className="mb-3 text-sm text-muted">Permanently delete your account ({user?.email}), your workspace and everything in it. This can’t be undone.</p>
          <Button variant="danger" onClick={() => { setDel({ open: true, password: '', confirm: '' }); setDelError(null); }}>Delete my account</Button>
        </Card>
      </div>
      <Modal open={del.open} onClose={() => setDel({ ...del, open: false })} title="Delete your account?"
        footer={<><Button variant="ghost" onClick={() => setDel({ ...del, open: false })}>Keep my account</Button><Button variant="danger" loading={remove.isPending} disabled={del.confirm !== 'DELETE' || !del.password} onClick={() => remove.mutate()}>Delete forever</Button></>}>
        <div className="space-y-3 text-sm">
          <p>We’ll miss you 🥺 Tip: download your data first.</p>
          <Field label="Your password"><Input type="password" autoComplete="current-password" value={del.password} onChange={(e) => setDel({ ...del, password: e.target.value })} /></Field>
          <Field label='Type "DELETE" to confirm'><Input value={del.confirm} onChange={(e) => setDel({ ...del, confirm: e.target.value })} /></Field>
          {delError && <ErrorBox message={delError} />}
        </div>
      </Modal>
    </div>
  );
}
