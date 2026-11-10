import { useState } from 'react';
import { Button } from '../../components/ui';

const EXAMPLES = [
  { label: 'Student', text: 'I wake up at 7. I have to revise maths for 2 hours, that’s the most important. Finish the history essay by 5pm, gym after lunch, call mom at 7pm and maybe buy groceries if I have time. I focus best in the morning.' },
  { label: 'Work day', text: 'Need to finish the quarterly report by 4pm, it’s urgent. Reply to emails in the morning, quick. Team meeting at 11 for 1 hour. Prepare slides for tomorrow 1.5h. Go for a run in the evening.' },
  { label: 'Work + study', text: 'Work 9 to 5 today. After work I need to study DBMS for 1.5 hours and do 2 leetcode problems. Cook dinner, call a friend at 9. I sleep at 11:30.' },
];

/** "Tell me about your day": one free-text box that Tempo turns into a plan. */
export function Composer({ onSubmit, busy, initial = '', onQuestions, placeholderDay = 'today' }: {
  onSubmit: (text: string) => void;
  busy: boolean;
  initial?: string;
  onQuestions?: () => void;
  placeholderDay?: 'today' | 'tomorrow';
}) {
  const [text, setText] = useState(initial);
  const submit = () => { if (text.trim()) onSubmit(text.trim()); };
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm focus-within:border-accent/60 focus-within:ring-4 focus-within:ring-accent/10">
      <label htmlFor="day-prompt" className="sr-only">Describe your day</label>
      <textarea
        id="day-prompt"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } }}
        rows={5}
        autoFocus
        placeholder={`What do you need to do ${placeholderDay}? Write it the way you’d tell a friend: tasks, deadlines, what matters most, when you’re free.\n\ne.g. “Finish my project 2h, it’s the most important. Leetcode 1h, gym after lunch, call mom at 7pm.”`}
        className="block w-full resize-none bg-transparent px-5 pt-4 text-[15px] leading-relaxed outline-none placeholder:text-muted/80"
      />
      <div className="flex flex-wrap items-center gap-2 border-t border-border bg-surface-2/40 px-4 py-3">
        <span className="text-xs text-muted">Try:</span>
        {EXAMPLES.map((ex) => (
          <button key={ex.label} type="button" onClick={() => setText(ex.text)} className="rounded-full border border-border bg-surface px-2.5 py-1 text-xs text-muted hover:border-accent hover:text-fg">
            {ex.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          {onQuestions && <button type="button" onClick={onQuestions} className="hidden text-xs text-muted hover:text-fg sm:inline">Answer questions instead</button>}
          <Button onClick={submit} loading={busy} disabled={!text.trim()}>Plan it <span className="ml-1 hidden text-[10px] opacity-70 sm:inline">Ctrl ↵</span></Button>
        </div>
      </div>
    </div>
  );
}
