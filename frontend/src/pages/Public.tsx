import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Logo } from '../components/Layout';

const REPO = 'https://github.com/assmitha2004/smart-scheduling';

export function MarketingShell({ children, title }: { children: ReactNode; title?: string }) {
  useEffect(() => {
    document.title = title ? `${title} · Smart Scheduling` : 'Smart Scheduling · Plan your days, weeks and month in minutes';
  }, [title]);
  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-30 border-b border-border/60 bg-bg/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Link to="/" aria-label="Smart Scheduling home"><Logo /></Link>
          <nav className="flex items-center gap-1 text-sm">
            <a href="/#features" className="hidden rounded-lg px-3 py-2 text-muted hover:text-fg sm:block">Features</a>
            <Link to="/login" className="rounded-lg px-3 py-2 text-muted hover:text-fg">Log in</Link>
            <Link to="/register" className="rounded-lg bg-accent px-3.5 py-2 font-medium text-accent-fg">Get started</Link>
          </nav>
        </div>
      </header>
      <main>{children}</main>
      <footer className="border-t border-border bg-surface">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 text-sm text-muted sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="flex items-center gap-3"><Logo /><span>Plan smarter, stress less.</span></div>
          <nav className="flex flex-wrap gap-4">
            <Link to="/terms" className="hover:text-fg">Terms</Link>
            <Link to="/privacy" className="hover:text-fg">Privacy</Link>
            <a href={REPO} target="_blank" rel="noreferrer" className="hover:text-fg">GitHub</a>
          </nav>
          <span>© {new Date().getFullYear()} Smart Scheduling</span>
        </div>
      </footer>
    </div>
  );
}

export const FAQ = [
  { q: 'Is it free?', a: 'Yes. Every feature is included: planning your day, week or month, the smart engine, calendar sync, the weekly review, focus timer, streaks and badges.' },
  { q: 'How does it decide when I should study or work?', a: 'You tell it your routine (classes, work hours, meals, commute, days off), when your brain is sharpest and your goals. It blocks out your fixed commitments, finds focus windows that match your energy, then places tasks by deadline, priority and what depends on what. Every placement comes with a reason.' },
  { q: 'What happens when I fall behind?', a: 'Mark a task as delayed and only the work that depends on it moves. You see a before/after preview and approve it. If there simply isn’t enough time, it tells you by how much and suggests options instead of cramming.' },
  { q: 'Does it work on my phone?', a: 'Yes. It works in any browser, you can install it to your home screen like an app, and you can sync your plan into Google Calendar or Apple Calendar.' },
  { q: 'Is my data private?', a: 'Your schedule is only visible to you (and teammates you invite). Task text is only sent to an AI provider if you switch that on. You can download all your data or delete your account at any time from Settings.' },
  { q: 'I work and study. Will it handle both?', a: 'That’s exactly what the Work + study mode is for: work shifts are fixed, study goes into the time around them, and a balance meter shows how your week splits between the two.' },
];

export function FaqList() {
  return (
    <div className="divide-y divide-border rounded-2xl border border-border bg-surface">
      {FAQ.map((f) => (
        <details key={f.q} className="group px-5 py-4">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium">
            {f.q}<span className="text-muted transition-transform group-open:rotate-45" aria-hidden>+</span>
          </summary>
          <p className="mt-2 text-sm leading-relaxed text-muted">{f.a}</p>
        </details>
      ))}
    </div>
  );
}

function LegalPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <MarketingShell title={title}>
      <article className="mx-auto max-w-3xl px-4 py-14 sm:px-6">
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm text-muted">Last updated {updated}</p>
        <div className="legal mt-8 space-y-6 text-[15px] leading-relaxed">{children}</div>
      </article>
    </MarketingShell>
  );
}

const Section = ({ h, children }: { h: string; children: ReactNode }) => (
  <section><h2 className="mb-2 text-lg font-semibold">{h}</h2><div className="space-y-2 text-muted">{children}</div></section>
);

export function TermsPage() {
  return (
    <LegalPage title="Terms of Service" updated="4 November 2026">
      <Section h="1. The service">Smart Scheduling helps you plan your time. It suggests schedules based on what you tell it; you decide what to accept. Suggestions are guidance, not guarantees that work will be finished on time.</Section>
      <Section h="2. Your account">You need an account to use the app. Keep your password safe and tell us if you think someone else has used your account. You must be old enough to agree to these terms where you live, or have a parent or guardian’s permission.</Section>
      <Section h="3. Cost">Smart Scheduling is free to use. If that ever changes, we’ll tell you in advance and you’ll always be able to export your data.</Section>
      <Section h="4. Your content">Your tasks, plans and notes belong to you. You give us permission to store and process them only to run the service for you. You can export or delete them at any time.</Section>
      <Section h="5. Acceptable use">Don’t misuse the service: no attempts to break security, overload the system, access other people’s data or use it for anything unlawful.</Section>
      <Section h="6. Availability and changes">We work to keep the service running but can’t promise it will never be interrupted. We may update features and these terms; for important changes we’ll let you know in the app.</Section>
      <Section h="7. Liability">The service is provided “as is”. To the extent the law allows, we aren’t liable for indirect losses, such as missed deadlines, arising from using the suggestions.</Section>
      <Section h="8. Contact">Questions about these terms? Open an issue on our <a className="text-accent" href={REPO} target="_blank" rel="noreferrer">GitHub repository</a>.</Section>
    </LegalPage>
  );
}

export function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" updated="4 November 2026">
      <Section h="What we collect">Your name, email and a securely hashed password; your timezone and preferences; and what you put into the app: answers to the planning questions, projects, tasks, calendar events and schedules.</Section>
      <Section h="How we use it">Only to run Smart Scheduling for you: building and showing your plans, reminders, progress and reviews. We don’t sell your data and we don’t show ads.</Section>
      <Section h="AI features">By default, task drafting and briefings run on our own servers. Task text is only sent to an external AI provider if you turn that on in Settings → Profile & planning, and you can turn it off at any time.</Section>
      <Section h="Calendar sync">If you create a calendar link, anyone who has that link can read your schedule, so keep it private. You can make a new link (the old one stops working) or turn it off in Settings.</Section>
      <Section h="Where it’s stored">Data is stored in a managed PostgreSQL database and served over encrypted (HTTPS) connections. Passwords are hashed with bcrypt and are never stored in plain text.</Section>
      <Section h="Your rights">You can see and edit your data in the app, download all of it (Settings → Account → Download my data) and permanently delete your account (Settings → Account → Delete my account).</Section>
      <Section h="Cookies and local storage">We use your browser’s local storage to keep you signed in and remember small preferences. We don’t use advertising or tracking cookies.</Section>
      <Section h="Contact">Questions about privacy? Open an issue on our <a className="text-accent" href={REPO} target="_blank" rel="noreferrer">GitHub repository</a>.</Section>
    </LegalPage>
  );
}
