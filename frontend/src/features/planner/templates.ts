import type { Chronotype, LifeAnswers, Persona } from '../../types';

/** Persona cards shown in onboarding and the planner. */
export const PERSONAS: { id: Persona; emoji: string; title: string; blurb: string }[] = [
  { id: 'STUDENT', emoji: '🎒', title: 'Student', blurb: 'Classes, assignments, exams, and still having a life' },
  { id: 'WORK', emoji: '💼', title: 'Working', blurb: 'Deep work, meetings, deadlines, and time for you' },
  { id: 'HYBRID', emoji: '🎓', title: 'Work + study', blurb: 'Juggling a job and your studies, balanced for you' },
];

export const CHRONOTYPES: { id: Chronotype; emoji: string; title: string; blurb: string }[] = [
  { id: 'EARLY_BIRD', emoji: '🐦', title: 'Early bird', blurb: 'Sharpest in the morning' },
  { id: 'DAYTIME', emoji: '☀️', title: 'Daytime', blurb: 'Best late morning & afternoon' },
  { id: 'NIGHT_OWL', emoji: '🦉', title: 'Night owl', blurb: 'Come alive in the evening' },
];

export const FOCUS_STYLES: { minutes: number; emoji: string; title: string; blurb: string }[] = [
  { minutes: 30, emoji: '🍅', title: 'Short sprints', blurb: '30 min, Pomodoro style' },
  { minutes: 50, emoji: '⏱️', title: 'Classic', blurb: '50 min, then a break' },
  { minutes: 90, emoji: '🎧', title: 'Deep focus', blurb: '90 min in the zone' },
];

export const SUBJECT_IDEAS = ['Maths', 'Physics', 'Chemistry', 'Biology', 'English', 'History', 'Computer Science', 'Economics', 'Accounting', 'Geography'];

export const HABIT_IDEAS: Record<Persona, { title: string; minutes: number }[]> = {
  STUDENT: [
    { title: '📖 Read for fun', minutes: 20 },
    { title: '🏃 Exercise', minutes: 30 },
    { title: '🧘 Meditate', minutes: 10 },
    { title: '🗣️ Language practice', minutes: 15 },
    { title: '🎸 Hobby time', minutes: 30 },
    { title: '🧹 Tidy my desk', minutes: 10 },
  ],
  WORK: [
    { title: '🏋️ Gym', minutes: 45 },
    { title: '📚 Learn a new skill', minutes: 30 },
    { title: '🚶 Evening walk', minutes: 20 },
    { title: '🧘 Mindfulness', minutes: 10 },
    { title: '📵 Screen-free wind down', minutes: 30 },
    { title: '👨‍🍳 Cook something nice', minutes: 45 },
  ],
  HYBRID: [
    { title: '🏃 Exercise', minutes: 30 },
    { title: '🧘 Meditate', minutes: 10 },
    { title: '📖 Read for fun', minutes: 20 },
    { title: '📞 Call family or friends', minutes: 20 },
    { title: '😴 Power nap', minutes: 20 },
  ],
};

export const MEETING_IDEAS = [
  { title: 'Daily standup', weekdays: [1, 2, 3, 4, 5], start: '09:30', end: '09:45' },
  { title: 'Weekly team sync', weekdays: [1], start: '11:00', end: '12:00' },
  { title: '1:1 with manager', weekdays: [4], start: '15:00', end: '15:30' },
];

export const ACTIVITY_IDEAS = [
  { title: 'Gym', weekdays: [1, 3, 5], start: '18:00', end: '19:00' },
  { title: 'Sports practice', weekdays: [2, 4], start: '17:00', end: '18:30' },
  { title: 'Club meeting', weekdays: [3], start: '16:00', end: '17:00' },
  { title: 'Tuition / coaching', weekdays: [2, 4, 6], start: '17:30', end: '19:00' },
];

/** Smart defaults per persona, so most people only tweak a few answers. */
export function defaultAnswers(persona: Persona): LifeAnswers {
  const base: LifeAnswers = {
    persona,
    horizon: 'WEEK',
    wakeTime: '07:00',
    sleepTime: '23:00',
    chronotype: 'DAYTIME',
    focusMinutes: 50,
    meals: { breakfast: '07:30', lunch: '13:00', dinner: '20:00' },
    commuteMinutes: 0,
    daysOff: [],
    activities: [],
    habits: [],
    classes: [],
    subjects: [],
    exams: [],
    assignments: [],
    studyHoursPerDay: 3,
    workDays: [1, 2, 3, 4, 5],
    workStart: '09:00',
    workEnd: '17:00',
    meetings: [],
    workTasks: [],
  };
  if (persona === 'STUDENT') return { ...base, focusMinutes: 50, commuteMinutes: 20, daysOff: [0] };
  if (persona === 'WORK') return { ...base, focusMinutes: 90, commuteMinutes: 30, daysOff: [0], meals: { breakfast: '07:30', lunch: '13:00', dinner: '20:00' } };
  return { ...base, studyHoursPerDay: 2, focusMinutes: 50, workDays: [1, 2, 3, 4, 5], workStart: '09:00', workEnd: '15:00', commuteMinutes: 20 };
}

export const studies = (p: Persona) => p === 'STUDENT' || p === 'HYBRID';
export const works = (p: Persona) => p === 'WORK' || p === 'HYBRID';

/** Cheerful lines for when something gets done. */
export const CELEBRATIONS: Record<Persona | 'ANY', string[]> = {
  ANY: [
    'Look at you go! 🚀',
    'One down, you legend ✨',
    'Done and dusted 🧹',
    'Future you says thank you 💌',
    'Tiny victory dance time 💃',
    'You showed up, and that matters 🌟',
  ],
  STUDENT: ['Brain gains unlocked 🧠', 'Your future self just got a better grade 📈', 'Study streak energy 🔥', 'Teacher would be proud 🍎'],
  WORK: ['Shipped it! 📦', 'Inbox zero vibes ☕', 'That deserves a coffee break ☕', 'Productivity level: boss 😎'],
  HYBRID: ['Juggling like a pro 🤹', 'Work + study, handled 💪', 'Balance achieved ⚖️', 'You make it look easy 🌈'],
};

export const TIPS: Record<Persona, string[]> = {
  STUDENT: [
    'Explain a topic out loud as if teaching a friend. If you get stuck, that’s what to revise. 🗣️',
    'Test yourself instead of re-reading. Active recall beats highlighting every time. 🧠',
    'Phone in another room during study blocks = up to 20% better focus. 📵',
    'Sleep is when your brain saves what you learned. Protect it before exams 😴',
    'Start assignments with the easiest part. Momentum is magic ✨',
    'Mix subjects in a session (interleaving). It feels harder but sticks better. 🔀',
  ],
  WORK: [
    'Do your hardest task first, before the inbox gets you. 🐸',
    'Batch email and messages into 2–3 slots a day. 📥',
    'End each day by writing tomorrow’s top 3. Your morning self will love you. 📝',
    'Block “no meeting” focus time on your calendar. Defend it like a meeting. 🛡️',
    'A 5-minute walk between deep-work blocks resets your brain. 🚶',
    'Shut the laptop at a set time. Rest makes tomorrow productive. 🌙',
  ],
  HYBRID: [
    'Use commutes and breaks for flashcards or podcasts. Tiny chunks add up. 🎧',
    'Keep one evening a week totally free. Burnout isn’t a badge. 🌿',
    'Tell your manager about exam weeks early. Most people are happy to help. 🤝',
    'Study right after work for 20 minutes before relaxing. The hardest part is starting. ⏱️',
    'Plan your week on Sunday: work shifts first, then study, then fun. 🗓️',
  ],
};
