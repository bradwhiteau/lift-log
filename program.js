// Program definition — the one place to change when the plan changes.
// Agreed in the "Brad's Fitness" Claude project. Bump `version` whenever the rules change,
// so every logged session records which rules applied.
window.PROGRAM = {
  name: 'Stronglifts 5x5',
  version: 'SL5x5-v1',
  units: 'kg',
  startDate: '2026-09-28',      // Monday, Workout A
  sessionTime: '15:00',
  barWeight: 20,

  lifts: {
    squat:    { name: 'Squat',          start: 40, increment: 2.5 },
    bench:    { name: 'Bench Press',    start: 30, increment: 2.5 },   // 1.25 with micro-plates (Settings)
    row:      { name: 'Barbell Row',    start: 30, increment: 2.5 },
    ohp:      { name: 'Overhead Press', start: 25, increment: 2.5 },   // 1.25 with micro-plates (Settings)
    deadlift: { name: 'Deadlift',       start: 40, increment: 5 },     // switch to 2.5 in Settings
  },

  workouts: {
    A: ['squat', 'bench', 'row'],
    B: ['squat', 'ohp', 'deadlift'],
  },
  sets: 5,
  reps: 5,

  // Any failed set: repeat the weight. This many failed sessions in a row: deload.
  deload: { afterFailedSessions: 3, percent: 10, roundTo: 2.5 },

  // Rest timer defaults in seconds (adjustable in Settings)
  rest: { easy: 90, hard: 180, failed: 300 },

  // Day of week (0 = Sunday) -> session type. Thursday is a walk until hiitFrom, then HIIT.
  schedule: { 1: 'lift', 2: 'walk', 3: 'lift', 4: 'hiit', 5: 'lift' },
  hiitFrom: '2026-10-08',

  walk: {
    steps: ['5 min @ 4 kph', '25 min @ 5 kph', '5 min @ 4 kph'],
    minutes: 35,
  },
  hiit: {
    rounds: 8,                  // adjustable in Settings as it increases
    hardSec: 30, easySec: 90,
    warmup: '5 min warm-up @ 5 kph',
    hard: 'Hard: jog 7–8 kph, or fast walk at 8–10% incline',
    easy: 'Easy: walk @ 5 kph',
    cooldown: '5 min cool-down @ 4 kph',
  },
};
