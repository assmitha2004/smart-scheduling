import { useMemo, useRef, useState } from 'react';
import FullCalendar from '@fullcalendar/react';
import timeGridPlugin from '@fullcalendar/timegrid';
import dayGridPlugin from '@fullcalendar/daygrid';
import interactionPlugin from '@fullcalendar/interaction';
import luxonPlugin from '@fullcalendar/luxon3';
import type { DatesSetArg, EventChangeArg, EventClickArg, DateSelectArg, EventInput } from '@fullcalendar/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiError } from '../services/api';
import { useAuth } from '../services/auth';
import { useToast } from '../components/Toast';
import { Badge, Button, ErrorBox, Field, Input, Modal, PageHeader, Select } from '../components/ui';
import { fmtDateTime, fromLocalInput, toLocalInput } from '../lib/format';
import type { CalendarData, CalendarEvent, Project } from '../types';
import { useTaskPanel } from '../features/tasks/TaskPanel';

interface Issue { severity: 'error' | 'warning'; type: string; message: string }
interface PendingMove { blockId: string; title: string; startAt: string; endAt: string; issues: Issue[]; revert: () => void }

export default function CalendarPage() {
  const { user } = useAuth();
  const tz = user?.timezone ?? 'UTC';
  const qc = useQueryClient();
  const toast = useToast();
  const { openTask } = useTaskPanel();
  const calRef = useRef<FullCalendar>(null);
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [projectFilter, setProjectFilter] = useState<string[]>([]);
  const [showCompleted, setShowCompleted] = useState(true);
  const [pending, setPending] = useState<PendingMove | null>(null);
  const [newEvent, setNewEvent] = useState<{ startAt: string; endAt: string } | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);

  const projects = useQuery({ queryKey: ['projects'], queryFn: async () => (await api.get<{ projects: Project[] }>('/projects')).data.projects });
  const data = useQuery({
    queryKey: ['calendar', range],
    enabled: !!range,
    placeholderData: (prev) => prev,
    queryFn: async () => (await api.get<CalendarData>('/calendar', { params: range })).data,
  });

  const events: EventInput[] = useMemo(() => {
    if (!data.data) return [];
    const blocks = data.data.blocks
      .filter((b) => (!projectFilter.length || projectFilter.includes(b.projectId)) && (showCompleted || b.status !== 'COMPLETED'))
      .map<EventInput>((b) => ({
        id: `block:${b.id}`, title: b.title, start: b.startAt, end: b.endAt,
        backgroundColor: `color-mix(in srgb, ${b.color} 22%, var(--c-surface))`, borderColor: b.color, textColor: 'var(--c-fg)',
        classNames: ['block-event', ...(b.status === 'COMPLETED' ? ['completed-event'] : [])],
        editable: b.status === 'CONFIRMED',
        extendedProps: { kind: 'block', block: b },
      }));
    const fixed = data.data.events.map<EventInput>((e) => ({
      id: `event:${e.id}`, title: `${e.eventType === 'BREAK' ? '☕ ' : e.eventType === 'UNAVAILABLE' ? '⛔ ' : '📌 '}${e.title}`, start: e.startAt, end: e.endAt,
      editable: false, classNames: ['fixed-event'], extendedProps: { kind: 'event', event: e },
    }));
    const working = data.data.workingHours.map<EventInput>((w, i) => ({ id: `wh:${i}`, start: w.startAt, end: w.endAt, display: 'background', classNames: ['working-hours'] }));
    return [...working, ...fixed, ...blocks];
  }, [data.data, projectFilter, showCompleted]);

  async function onChange(arg: EventChangeArg) {
    const block = arg.event.extendedProps.block as CalendarData['blocks'][number];
    const startAt = arg.event.start!.toISOString();
    const endAt = (arg.event.end ?? new Date(arg.event.start!.getTime() + (Date.parse(block.endAt) - Date.parse(block.startAt)))).toISOString();
    try {
      const r = await api.post<{ ok: boolean; issues: Issue[] }>(`/calendar/blocks/${block.id}/check`, { startAt, endAt });
      if (!r.data.issues.length) {
        await commitMove(block.id, startAt, endAt, false);
      } else {
        setPending({ blockId: block.id, title: block.title, startAt, endAt, issues: r.data.issues, revert: arg.revert });
      }
    } catch (e) {
      arg.revert();
      toast.show(apiError(e).message, 'error');
    }
  }

  async function commitMove(blockId: string, startAt: string, endAt: string, acknowledgeWarnings: boolean) {
    try {
      const r = await api.patch(`/calendar/blocks/${blockId}`, { startAt, endAt, acknowledgeWarnings, expectedVersion: data.data?.scheduleVersion });
      toast.show(r.data.replanSuggested ? 'Block moved. Downstream work may need replanning.' : 'Block moved.', r.data.replanSuggested ? 'info' : 'success');
    } catch (e) {
      const err = apiError(e);
      toast.show(err.code === 'STALE_SCHEDULE' ? 'Your schedule changed in another tab — reloaded.' : err.message, 'error');
    } finally {
      for (const k of ['calendar', 'briefing', 'timeline']) qc.invalidateQueries({ queryKey: [k] });
    }
  }

  const deleteEvent = useMutation({
    mutationFn: (id: string) => api.delete(`/calendar/events/${id}`),
    onSuccess: () => { setSelectedEvent(null); qc.invalidateQueries({ queryKey: ['calendar'] }); },
  });

  return (
    <>
      <PageHeader title="Calendar" subtitle={<>Task blocks (colored) alongside fixed commitments (hatched). Drag blocks to reschedule — conflicts are checked before saving. Shown in {tz}.</>}
        actions={<Button variant="secondary" onClick={() => { const now = new Date(); setNewEvent({ startAt: new Date(now.setMinutes(0, 0, 0) + 3_600_000).toISOString(), endAt: new Date(now.getTime() + 7_200_000).toISOString() }); }}>Add fixed event</Button>} />
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">Filter:</span>
        {(projects.data ?? []).map((p) => {
          const on = projectFilter.includes(p.id);
          return <button key={p.id} onClick={() => setProjectFilter(on ? projectFilter.filter((x) => x !== p.id) : [...projectFilter, p.id])}
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs ${on ? 'border-accent bg-accent-soft text-accent' : 'border-border text-muted'}`}><span className="h-2 w-2 rounded-full" style={{ background: p.color }} />{p.name}</button>;
        })}
        <label className="ml-auto flex items-center gap-1.5 text-xs text-muted"><input type="checkbox" checked={showCompleted} onChange={(e) => setShowCompleted(e.target.checked)} /> Show completed</label>
      </div>
      <div className="rounded-xl border border-border bg-surface p-3">
        <FullCalendar
          ref={calRef}
          plugins={[timeGridPlugin, dayGridPlugin, interactionPlugin, luxonPlugin]}
          timeZone={tz}
          initialView={typeof window !== 'undefined' && window.innerWidth < 640 ? 'timeGridDay' : 'timeGridWeek'}
          headerToolbar={{ left: 'prev,next today', center: 'title', right: 'timeGridDay,timeGridWeek,dayGridMonth' }}
          buttonText={{ today: 'Today', day: 'Day', week: 'Week', month: 'Month' }}
          firstDay={1}
          nowIndicator
          height="auto"
          slotMinTime="06:00:00"
          slotMaxTime="23:00:00"
          scrollTime="08:00:00"
          allDaySlot={false}
          snapDuration="00:15:00"
          events={events}
          eventStartEditable
          eventDurationEditable
          selectable
          selectMirror
          datesSet={(arg: DatesSetArg) => setRange({ from: arg.start.toISOString(), to: arg.end.toISOString() })}
          eventChange={onChange}
          select={(arg: DateSelectArg) => { setNewEvent({ startAt: arg.start.toISOString(), endAt: arg.end.toISOString() }); arg.view.calendar.unselect(); }}
          eventClick={(arg: EventClickArg) => {
            const p = arg.event.extendedProps;
            if (p.kind === 'block') openTask(p.block.taskId);
            else if (p.kind === 'event') setSelectedEvent(p.event);
          }}
        />
      </div>

      <Modal open={!!pending} onClose={() => { pending?.revert(); setPending(null); }} title={`Move "${pending?.title ?? ''}"?`}
        footer={pending && (<>
          <Button variant="ghost" onClick={() => { pending.revert(); setPending(null); }}>Cancel</Button>
          {!pending.issues.some((i) => i.severity === 'error') && <Button onClick={async () => { const p = pending; setPending(null); await commitMove(p.blockId, p.startAt, p.endAt, true); }}>Move anyway</Button>}
        </>)}>
        {pending && (
          <div className="space-y-2">
            <p className="text-sm text-muted">{fmtDateTime(pending.startAt, tz)} – {fmtDateTime(pending.endAt, tz).split(', ').pop()}</p>
            {pending.issues.map((i, k) => (
              <div key={k} className={`rounded-md px-3 py-2 text-sm ${i.severity === 'error' ? 'bg-danger-soft text-danger' : 'bg-warn-soft text-warn'}`}>
                <b>{i.severity === 'error' ? 'Not allowed:' : 'Warning:'}</b> {i.message}
              </div>
            ))}
            {pending.issues.some((i) => i.severity === 'error') && <p className="text-xs text-muted">Fixed commitments, double-booking and starting before a prerequisite finishes can't be overridden.</p>}
          </div>
        )}
      </Modal>

      {newEvent && <EventModal initial={newEvent} tz={tz} onClose={() => setNewEvent(null)} />}

      <Modal open={!!selectedEvent} onClose={() => setSelectedEvent(null)} title={selectedEvent?.title ?? ''}
        footer={selectedEvent && <><Button variant="ghost" onClick={() => setSelectedEvent(null)}>Close</Button><Button variant="danger" loading={deleteEvent.isPending} onClick={() => deleteEvent.mutate(selectedEvent.id)}>Delete event</Button></>}>
        {selectedEvent && <div className="space-y-1 text-sm"><Badge>{selectedEvent.eventType.toLowerCase()}</Badge><p>{fmtDateTime(selectedEvent.startAt, tz)} – {fmtDateTime(selectedEvent.endAt, tz)}</p><p className="text-muted">The scheduler never moves or overlaps fixed events.</p></div>}
      </Modal>
    </>
  );
}

function EventModal({ initial, tz, onClose }: { initial: { startAt: string; endAt: string }; tz: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({ title: '', eventType: 'FIXED', start: toLocalInput(initial.startAt, tz), end: toLocalInput(initial.endAt, tz) });
  const create = useMutation({
    mutationFn: async () => (await api.post('/calendar/events', { title: form.title, eventType: form.eventType, startAt: fromLocalInput(form.start, tz), endAt: fromLocalInput(form.end, tz) })).data,
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ['calendar'] });
      if (d.replanSuggested) toast.show(`This event overlaps ${d.conflictingBlocks.length} scheduled block(s). Open Smart planning to replan.`, 'info');
      onClose();
    },
  });
  return (
    <Modal open onClose={onClose} title="Add to calendar" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => create.mutate()} disabled={!form.title.trim()} loading={create.isPending}>Save</Button></>}>
      <div className="space-y-3">
        {create.error && <ErrorBox message={apiError(create.error).message} />}
        <Field label="Title"><Input autoFocus value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Team meeting" /></Field>
        <Field label="Type">
          <Select value={form.eventType} onChange={(e) => setForm({ ...form, eventType: e.target.value })}>
            <option value="FIXED">Fixed event (meeting, class)</option>
            <option value="BREAK">Break</option>
            <option value="UNAVAILABLE">Unavailable (time off)</option>
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Start"><Input type="datetime-local" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} /></Field>
          <Field label="End"><Input type="datetime-local" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} /></Field>
        </div>
      </div>
    </Modal>
  );
}
