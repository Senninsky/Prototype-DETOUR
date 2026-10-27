'use strict';

/* =========================================================================
   Detour — interactive prototype
   1. Input modules   (signals the phone can read)
   2. Output modules  (the kinds of distraction Detour can send)
   3. Personas        (each with their own inputs, preferences and phone)
   4. The model       (predict craving → choose what & when → learn)
   5. Rendering       (persona picker, inputs card, model panel, phone, researcher)
   ========================================================================= */

const $ = (s, el = document) => el.querySelector(s);
const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const sigmoid = z => 1 / (1 + Math.exp(-z));
const pad = n => String(n).padStart(2, '0');
const clone = o => JSON.parse(JSON.stringify(o));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hhmm = h => { const t = Math.round((((h % 24) + 24) % 24) * 60); return `${pad(Math.floor(t / 60) % 24)}:${pad(t % 60)}`; };
const hourDiff = (a, b) => { const d = Math.abs(a - b) % 24; return Math.min(d, 24 - d); };
const partOfDay = h => (h < 5 ? 'night' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : h < 22 ? 'evening' : 'night');

const LOGO = `<svg class="logo" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="6" fill="#16241F"/><path d="M5.5 10.5c2.6-2.6 4.4-2.6 6.5 0s3.9 2.6 6.5 0" stroke="#E0592A" stroke-width="2.2" fill="none" stroke-linecap="round"/><path d="M5.5 15c2.6-2.6 4.4-2.6 6.5 0s3.9 2.6 6.5 0" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round"/></svg>`;

const TRIGGERS = {
  stress: { label: 'Stress', color: 'var(--t-stress)' },
  habit: { label: 'Habit / routine', color: 'var(--t-habit)' },
  social: { label: 'Social', color: 'var(--t-social)' },
  boredom: { label: 'Boredom', color: 'var(--t-boredom)' },
};

/* -------------------------------------------------------------------------
   1. INPUT MODULES
   Each module turns a raw value into an activation a ∈ [0,1] plus a mix of
   trigger types. The model adds w · (a − 0.3): 0.3 is "nothing special".
   ------------------------------------------------------------------------- */
const BASE = 0.3;
const opt = (v, a, t = {}) => ({ v, a, t });

const MODULES = {
  heartRate: {
    label: 'Heart rate', icon: 'heart-pulse', kind: 'range', min: 45, max: 150, step: 1, def: 74, w: 2.4,
    fmt: v => `${v} bpm${v >= 88 ? ' ↑' : v <= 66 ? ', resting' : ''}`,
    act: v => clamp((v - 62) / 40), trig: () => ({ stress: 1 }),
  },
  stress: {
    label: 'Stress', icon: 'activity', kind: 'select', def: 'Medium', w: 2.6,
    options: [opt('Low', 0, { stress: 1 }), opt('Medium', .5, { stress: 1 }), opt('High', 1, { stress: 1 })],
  },
  sleep: {
    label: 'Sleep', icon: 'moon', kind: 'range', min: 180, max: 600, step: 10, def: 450, w: 1.4,
    fmt: v => `${Math.floor(v / 60)}h ${pad(v % 60)}m`,
    act: v => clamp((480 - v) / 180), trig: () => ({ stress: .7, boredom: .3 }),
  },
  location: {
    label: 'Location', icon: 'map-pin', kind: 'select', def: 'Home, couch', w: 2.2,
    options: [
      opt('Home, kitchen', .55, { habit: 1 }), opt('Home, couch', .45, { boredom: 1 }),
      opt('Office', .4, { stress: .8, habit: .2 }), opt('Smoking spot at work', 1, { habit: 1 }),
      opt('Train, commute', .6, { boredom: .6, habit: .4 }), opt('Bar, city centre', .9, { social: 1 }),
      opt('Gym', 0), opt("Parents' place", .25, { stress: .6 }),
    ],
  },
  social: {
    label: 'Social context', icon: 'users', kind: 'select', def: 'Alone', w: 2.2,
    options: [
      opt('Alone', .45, { boredom: .8, stress: .2 }), opt('With colleagues', .4, { social: .6, stress: .4 }),
      opt('With friends', .85, { social: 1 }), opt('With smoking friends', 1, { social: 1 }), opt('With family', .1),
    ],
  },
  music: {
    label: 'Music', icon: 'music', kind: 'select', def: 'Nothing playing', w: 1.6,
    options: [
      opt('Nothing playing', .55, { boredom: 1 }), opt('Party playlist', .75, { social: 1 }),
      opt('Chill / lo-fi', .15), opt('Podcast', .2, { boredom: .3 }), opt('Sad songs', .6, { stress: .6, boredom: .4 }),
    ],
  },
  time: { label: 'Time & routine', icon: 'clock', kind: 'range', min: 0, max: 23.75, step: .25, def: 12, w: 2.6, routine: true },
  steps: {
    label: 'Steps today', icon: 'footprints', kind: 'range', min: 0, max: 15000, step: 100, def: 6000, w: 1.2,
    fmt: v => `${v.toLocaleString('en-US')} steps`, act: v => clamp((7000 - v) / 7000), trig: () => ({ boredom: 1 }),
  },
  agenda: {
    label: 'Agenda', icon: 'calendar', kind: 'select', def: 'Nothing planned', w: 1.8,
    options: [
      opt('Nothing planned', .5, { boredom: 1 }), opt('Meeting just ended', .75, { habit: .6, stress: .4 }),
      opt('Deadline in 1h', .85, { stress: 1 }), opt('Dentist at 10:00', .35, { stress: .6 }),
      opt('Party tonight', .6, { social: 1 }), opt('Gym session soon', .05),
    ],
  },
  pickups: {
    label: 'Phone pickups', icon: 'smartphone', kind: 'range', min: 0, max: 60, step: 1, def: 8, w: 1.8,
    fmt: v => `${v} in last hour`, act: v => clamp(v / 35), trig: () => ({ boredom: 1 }),
  },
  drinks: {
    label: 'Alcohol', icon: 'wine', kind: 'range', min: 0, max: 8, step: 1, def: 0, w: 1.8,
    fmt: v => (v === 0 ? 'None' : `${v} drink${v > 1 ? 's' : ''}`), act: v => clamp(v / 4), trig: () => ({ social: .7, habit: .3 }),
  },
  coffee: {
    label: 'Caffeine', icon: 'coffee', kind: 'select', def: 'None yet', w: 1.6,
    options: [opt('None yet', .1), opt('Just finished', .95, { habit: 1 }), opt('A while ago', .3, { habit: .5 })],
  },
};

/* -------------------------------------------------------------------------
   2. OUTPUT MODULES — fit = how well it answers each trigger type
   ------------------------------------------------------------------------- */
const OUTPUTS = {
  breathing: { label: 'Breathing prompt', icon: 'wind', kind: 'Detour notification', fit: { stress: 1, habit: .35, social: .15, boredom: .3 } },
  routineSwap: { label: 'Routine swap', icon: 'footprints', kind: 'Detour notification', fit: { habit: 1, boredom: .45, stress: .35, social: .1 } },
  buddy: { label: 'Buddy nudge', icon: 'message-circle', kind: 'Message a quit-buddy', fit: { social: 1, stress: .45, boredom: .4, habit: .3 } },
  healing: { label: 'Healing-body view', icon: 'heart', kind: 'Informative · opens the app', fit: { boredom: .85, habit: .55, stress: .35, social: .2 } },
  media: { label: 'Media distraction', icon: 'circle-play', kind: 'Covert · Spotify, YouTube or News', fit: { boredom: 1, habit: .65, stress: .45, social: .2 } },
  chatbot: { label: 'Chatbot message', icon: 'bot', kind: 'Chat with Detour', fit: { boredom: .85, stress: .75, habit: .5, social: .35 } },
};

/* -------------------------------------------------------------------------
   3. PERSONAS
   ------------------------------------------------------------------------- */
const DEFAULT_MEDIA = {
  podcast: { show: 'Small Wonders', ep: 'Why octopuses have three hearts', len: 24, colors: ['#F2994A', '#C0392B'] },
  video: { channel: 'Weeknight Kitchen', title: '15-minute ramen that beats takeout', len: '12:48', views: '184K views · 2 days ago' },
  news: { headline: 'Scientists map the quietest place on Earth', source: 'Morning Brief', mins: 4 },
};

const PERSONAS = [
  {
    id: 'sara', name: 'Sara', age: 29, color: '#E0592A',
    type: 'Stress smoker', style: 'Notifications only', styleClass: 'style-dark',
    blurb: 'Project lead. Reaches for a cigarette when the day piles up.',
    screen: 'home', wallpaper: 'linear-gradient(165deg,#7D9DF0 0%,#A9A2EE 55%,#D2B3EE 100%)',
    clock: 17.8, date: 'Tuesday 21 October', days: 5,
    inputs: { heartRate: 96, stress: 'High', sleep: 340 },
    routines: [{ t: 13, label: 'after lunch' }],
    buddy: { name: 'Mila', online: true, color: '#C76AA8' },
    bias: -2.0,
    prefs: { breathing: .9, routineSwap: .45, buddy: .4, healing: .25, media: .45, chatbot: .5 },
    ctx: [],
  },
  {
    id: 'lena', name: 'Lena', age: 41, color: '#D9A23A',
    type: 'Habit smoker', style: 'Notifications only', styleClass: 'style-dark',
    blurb: 'Nurse. Twenty years of the same cigarette after the same coffee.',
    screen: 'lock', wallpaper: 'linear-gradient(180deg,#F4B48C 0%,#EE9DA0 55%,#E88AA8 100%)',
    clock: 7.75, date: 'Monday 27 October', days: 9,
    inputs: { time: 7.75, location: 'Home, kitchen' },
    routines: [{ t: 7.75, label: 'after coffee' }, { t: 12.75, label: 'after lunch' }, { t: 18.25, label: 'after work' }],
    buddy: { name: 'Ruth', online: false, color: '#7A9E7E' },
    bias: -1.2,
    prefs: { breathing: .5, routineSwap: .9, buddy: .3, healing: .35, media: .4, chatbot: .35 },
    ctx: [{ app: 'Calendar', icon: 'calendar', color: '#4F86F7', title: 'Dentist', body: 'Today at 10:00', time: '1h ago' }],
  },
  {
    id: 'tom', name: 'Tom', age: 24, color: '#8A6BE0',
    type: 'Social smoker', style: 'Notifications only', styleClass: 'style-dark',
    blurb: 'Student. Only smokes on nights out with friends.',
    screen: 'lock', wallpaper: 'linear-gradient(180deg,#2A2154 0%,#4A2B78 55%,#6B3693 100%)',
    clock: 23 + 10 / 60, date: 'Friday 7 November', days: 3,
    inputs: { location: 'Bar, city centre', social: 'With friends', music: 'Party playlist' },
    routines: [{ t: 23, label: 'night out' }],
    buddy: { name: 'Jens', online: true, color: '#3E9AAE' },
    bias: -1.8,
    prefs: { breathing: .35, routineSwap: .4, buddy: .9, healing: .2, media: .5, chatbot: .45 },
    ctx: [{ app: 'Messages', icon: 'message-circle', color: '#34C759', title: 'Group chat', body: 'Next round is on me! 🍻', time: '2m ago' }],
  },
  {
    id: 'yusuf', name: 'Yusuf', age: 35, color: '#2E7D5B',
    type: 'Bored smoker', style: 'Likes to open the app', styleClass: 'style-green',
    blurb: 'Developer. Smokes out of boredom when the evening goes quiet.',
    screen: 'lock', wallpaper: 'linear-gradient(180deg,#1C3A31 0%,#14261F 60%,#0D1814 100%)',
    clock: 21.5, date: 'Sunday 26 October', days: 12,
    inputs: { music: 'Nothing playing', heartRate: 62, time: 21.5 },
    routines: [{ t: 21.5, label: 'evening', trig: { boredom: .75, habit: .25 } }, { t: 13, label: 'after lunch' }],
    buddy: { name: 'Amir', online: false, color: '#D9A23A' },
    bias: -0.6,
    prefs: { breathing: .3, routineSwap: .4, buddy: .3, healing: .95, media: .45, chatbot: .5 },
    ctx: [],
  },
  {
    id: 'noor', name: 'Noor', age: 27, color: '#3E9AAE',
    type: 'Restless smoker', style: 'Avoids confrontation', styleClass: 'style-teal',
    blurb: "Designer. Doesn't want to be reminded of smoking, just wants something else to do.",
    screen: 'lock', wallpaper: 'linear-gradient(180deg,#78BDB4 0%,#3F7F8C 55%,#2B5770 100%)',
    clock: 17.25, date: 'Wednesday 29 October', days: 6,
    inputs: { location: 'Train, commute', pickups: 28, steps: 3200, time: 17.25 },
    routines: [{ t: 17.25, label: 'after work', trig: { habit: .5, boredom: .5 } }, { t: 10.5, label: 'coffee break' }],
    buddy: null,
    bias: -2.0,
    prefs: { breathing: .3, routineSwap: .35, buddy: .25, healing: .05, media: .95, chatbot: .35 },
    media: {
      podcast: { show: 'Cold Case Files', ep: "Ep. 41 · The lighthouse keeper's last log", len: 38, colors: ['#2C3E50', '#4CA1AF'] },
      video: { channel: 'Studio Clay', title: 'Throwing a 40 cm vase in one go', len: '17:02', views: '96K views · 1 day ago' },
      news: { headline: 'The tiny Dutch town that turned its roofs into gardens', source: 'Morning Brief', mins: 5 },
    },
    ctx: [{ app: 'Messages', icon: 'message-circle', color: '#34C759', title: 'Mom', body: 'Dinner on Sunday? 🍲', time: '14m ago' }],
  },
  {
    id: 'max', name: 'Max', age: 52, color: '#4F6BB0',
    type: 'Lonely smoker', style: 'Likes to chat', styleClass: 'style-purple',
    blurb: 'Retired teacher. Evenings alone are when the cravings talk loudest.',
    screen: 'lock', wallpaper: 'linear-gradient(180deg,#1B2340 0%,#2C3A64 55%,#4A5880 100%)',
    clock: 22.75, date: 'Thursday 30 October', days: 20,
    inputs: { social: 'Alone', agenda: 'Nothing planned', steps: 1800, time: 22.75 },
    routines: [{ t: 22.75, label: 'late evening', trig: { boredom: .6, stress: .2, habit: .2 } }],
    buddy: { name: 'Sam', online: false, color: '#C76AA8' },
    bias: -1.6,
    prefs: { breathing: .35, routineSwap: .3, buddy: .35, healing: .45, media: .4, chatbot: .95 },
    ctx: [],
  },
];

/* -------------------------------------------------------------------------
   STATE
   ------------------------------------------------------------------------- */
function freshPersona(p) {
  const c = clone(p);
  c.order = Object.keys(c.inputs);
  c.log = [];
  c.slips = 0;
  return c;
}

const state = {
  pid: 'sara',
  personas: Object.fromEntries(PERSONAS.map(p => [p.id, freshPersona(p)])),
  enabledOutputs: new Set(Object.keys(OUTPUTS)),
  threshold: .6,
  screen: 'base',
  sheet: false,
  dismissed: false,
  excluded: new Set(),
  lastNotifKey: null,
  activeOutput: null,
  fromNotif: false,
  chat: null,
  timers: [],
  appStart: 0,
  customCount: 0,
};
const persona = () => state.personas[state.pid];
const currentHour = P => (P.order.includes('time') ? P.inputs.time : P.clock);

/* -------------------------------------------------------------------------
   4. THE MODEL
   ------------------------------------------------------------------------- */
function nearestRoutine(P, h) {
  let best = null;
  for (const r of P.routines) if (!best || hourDiff(h, r.t) < hourDiff(h, best.t)) best = r;
  return best;
}

function evalInput(id, value, P) {
  const m = MODULES[id];
  if (m.kind === 'select') {
    const o = m.options.find(o => o.v === value) || m.options[0];
    return { a: o.a, t: o.t, text: o.v };
  }
  if (m.routine) {
    const r = nearestRoutine(P, value);
    const a = r ? Math.exp(-(hourDiff(value, r.t) ** 2) / (2 * 0.45 ** 2)) : 0;
    const label = r && hourDiff(value, r.t) <= .5 ? r.label : partOfDay(value);
    return { a, t: (r && r.trig) || { habit: 1 }, text: `${hhmm(value)} · ${label}` };
  }
  return { a: m.act(value), t: m.trig(value), text: m.fmt(value) };
}

// Step 1 — logistic model: p = σ(bias + Σ w·(a − 0.3))
function predict(P) {
  let z = P.bias;
  const contribs = [];
  const mix = { stress: 0, habit: 0, social: 0, boredom: 0 };
  for (const id of P.order) {
    const m = MODULES[id];
    const e = evalInput(id, P.inputs[id], P);
    const c = m.w * (e.a - BASE);
    z += c;
    contribs.push({ id, label: m.label, c, text: e.text });
    if (c > 0) for (const [k, f] of Object.entries(e.t)) mix[k] += c * f;
  }
  const tot = Object.values(mix).reduce((a, b) => a + b, 0);
  for (const k in mix) mix[k] = tot ? mix[k] / tot : .25;
  const dominant = Object.entries(mix).sort((a, b) => b[1] - a[1])[0][0];
  return { z, p: sigmoid(z), contribs, mix, dominant };
}

function contextFactor(id, P) {
  const loc = P.inputs.location, soc = P.inputs.social, ag = P.inputs.agenda;
  const crowd = loc === 'Bar, city centre' || soc === 'With friends' || soc === 'With smoking friends';
  switch (id) {
    case 'breathing': return crowd ? { f: .45, note: 'hard to breathe calmly in a crowd' } : { f: 1 };
    case 'routineSwap':
      if (loc === 'Train, commute') return { f: .55, note: "can't walk around on a train" };
      return crowd ? { f: .6, note: 'awkward to leave the group' } : { f: 1 };
    case 'buddy':
      if (!P.buddy) return { f: 0, note: 'no quit-buddy linked' };
      return P.buddy.online ? { f: 1, note: `${P.buddy.name} is online` } : { f: .6, note: `${P.buddy.name} is offline` };
    case 'healing': return crowd ? { f: .6, note: 'not a moment to open an app' } : { f: 1 };
    case 'media': return ag === 'Deadline in 1h' ? { f: .7, note: 'would cost focus' } : crowd ? { f: .75 } : { f: 1 };
    case 'chatbot': return crowd ? { f: .7, note: 'already talking to people' } : { f: 1 };
  }
  return { f: 1 };
}

// Step 2 — choose what: preference × trigger fit × context
function choose(P, pred) {
  const ranked = Object.keys(OUTPUTS).map(id => {
    const fit = Object.entries(pred.mix).reduce((s, [k, v]) => s + v * (OUTPUTS[id].fit[k] || 0), 0);
    const cx = contextFactor(id, P);
    const enabled = state.enabledOutputs.has(id);
    const tried = state.excluded.has(id);
    const score = enabled && !tried ? P.prefs[id] * (.35 + .65 * fit) * cx.f : 0;
    return { id, score, fit, pref: P.prefs[id], cx, enabled, tried };
  }).sort((a, b) => b.score - a.score);
  return { ranked, chosen: ranked[0].score > 0 ? ranked[0] : null };
}

// ...and when
function timing(P, pred) {
  if (pred.dominant === 'habit' && P.order.includes('time')) {
    const h = P.inputs.time, r = nearestRoutine(P, h);
    if (r && hourDiff(h, r.t) <= .5) return `Timed to land at the usual ${r.label} cigarette (${hhmm(r.t)})`;
  }
  return {
    stress: 'Now, while stress signals are climbing',
    social: 'Now, before the next round outside',
    boredom: 'Now, during the idle moment',
    habit: 'Now, as the routine slot opens up',
  }[pred.dominant];
}

// Step 3 — learn
function learn(delta, verb, id = state.activeOutput) {
  const P = persona();
  if (!id) return;
  const old = P.prefs[id];
  P.prefs[id] = clamp(old + delta, .02, 1);
  P.log.unshift({
    t: hhmm(currentHour(P)), kind: delta >= 0 ? 'up' : 'down',
    text: `${verb} ${OUTPUTS[id].label}. Preference ${old.toFixed(2)} → ${P.prefs[id].toFixed(2)}`,
  });
}

function logSlip() {
  const P = persona();
  const pred = predict(P);
  const id = state.activeOutput;
  P.bias += .15;
  P.slips += 1;
  let extra = '';
  if (id) {
    const old = P.prefs[id];
    P.prefs[id] = clamp(old - .15, .02, 1);
    extra = ` ${OUTPUTS[id].label} ${old.toFixed(2)} → ${P.prefs[id].toFixed(2)}.`;
  }
  P.log.unshift({
    t: hhmm(currentHour(P)), kind: 'slip',
    text: `Slip logged in a ${TRIGGERS[pred.dominant].label.toLowerCase()} moment. Baseline risk +0.15.${extra} Streak kept: slips are data.`,
  });
}

/* -------------------------------------------------------------------------
   NOTIFICATION CONTENT — what the model's output turns into on the phone
   ------------------------------------------------------------------------- */
const healing = days => ({
  lungs: Math.min(100, Math.round(days * 1.5)),
  circ: Math.min(100, Math.round(30 + days * 2.7)),
  taste: Math.min(100, Math.round(40 + days * 3.75)),
});
const MILESTONES = [
  { d: 1, t: 'carbon monoxide gone' }, { d: 3, t: 'breathing feels easier' }, { d: 7, t: 'taste sharpens' },
  { d: 14, t: 'climbing stairs' }, { d: 30, t: 'lungs clearing faster' }, { d: 90, t: 'circulation fully back' },
];

function pickMedia(P) {
  const h = currentHour(P);
  const m = P.media || DEFAULT_MEDIA;
  if (P.inputs.location === 'Train, commute' || P.inputs.music === 'Podcast') return { kind: 'podcast', ...m.podcast };
  if (h >= 5 && h < 11) return { kind: 'news', ...m.news };
  return { kind: 'video', ...m.video };
}

function routineLead(label, name) {
  if (/coffee/.test(label)) return `Coffee's ready, ${name} ☕`;
  if (/lunch/.test(label)) return `Lunch done, ${name}`;
  if (/work/.test(label)) return `Workday's done, ${name}`;
  return `Your usual moment, ${name}`;
}

function buildNotification(P, pred, id) {
  const h = currentHour(P), part = partOfDay(h), day = P.date.split(' ')[0];
  switch (id) {
    case 'breathing':
      return {
        app: 'Detour', title: `Rough ${part}, ${P.name}?`,
        body: pred.dominant === 'stress'
          ? 'Your stress is climbing. Two minutes of box breathing usually gets you through this.'
          : 'Quick reset? Two minutes of box breathing usually takes the edge off.',
        primary: 'Breathe now', secondary: 'Not now',
      };
    case 'routineSwap': {
      const r = P.order.includes('time') ? nearestRoutine(P, h) : null;
      const near = r && hourDiff(h, r.t) <= .5;
      return {
        app: 'Detour', title: near ? routineLead(r.label, P.name) : `Switch it up, ${P.name}`,
        body: near ? 'Before the usual cigarette: three minutes around the block. Yesterday that worked.'
          : 'Instead of a cigarette: three minutes around the block. It works better than you think.',
        primary: 'Start walk', secondary: 'Skip today',
      };
    }
    case 'buddy':
      return {
        app: 'Detour', title: `${day} ${part}, ${P.name}`,
        body: `This is usually when it hits. ${P.buddy.name} quit with you${P.buddy.online ? ' and is online right now' : ''}. Send a quick message?`,
        primary: `Message ${P.buddy.name}`, secondary: "I'm OK",
      };
    case 'healing': {
      const hl = healing(P.days);
      return {
        app: 'Detour', title: `Day ${P.days} smoke-free 🫁`,
        body: `Your lungs are ${hl.lungs}% clearer and circulation is back to ${hl.circ}%. Want to see what's healing?`,
        primary: 'Show me', secondary: 'Later',
      };
    }
    case 'media': {
      const md = pickMedia(P);
      if (md.kind === 'podcast') return { app: 'Spotify', icon: 'headphones', color: '#1DB954', covert: true, media: md, title: 'New episode out now', body: `${md.show} · ${md.ep} (${md.len} min)`, primary: 'Play', secondary: 'Later' };
      if (md.kind === 'news') return { app: 'News', icon: 'newspaper', color: '#E8443A', covert: true, media: md, title: md.headline, body: `${md.source} · ${md.mins} min read`, primary: 'Read', secondary: 'Later' };
      return { app: 'YouTube', icon: 'play', color: '#E62117', covert: true, media: md, title: `${md.channel} uploaded a video`, body: `${md.title} · ${md.len}`, primary: 'Watch', secondary: 'Later' };
    }
    case 'chatbot':
      return {
        app: 'Detour', title: part === 'night' ? `Hey ${P.name}, still up? 🌙` : `Hey ${P.name} 👋`,
        body: "Fancy a quick round of 'guess the year'? I've got a good one.",
        primary: 'Reply', secondary: 'Not now',
      };
  }
}

/* -------------------------------------------------------------------------
   5. RENDERING — persona picker
   ------------------------------------------------------------------------- */
function renderPersonas() {
  $('#personas').innerHTML = PERSONAS.map(p => `
    <button class="persona ${p.id === state.pid ? 'active' : ''}" data-persona="${p.id}" aria-pressed="${p.id === state.pid}">
      <div class="p-head">
        <span class="avatar" style="background:${p.color}">${p.name[0]}</span>
        <div><div class="p-name">${p.name} <span class="p-age">${p.age}</span></div></div>
      </div>
      <p class="p-blurb">${esc(p.blurb)}</p>
      <div class="p-tags"><span class="tag type">${p.type}</span><span class="tag ${p.styleClass}">${p.style}</span></div>
    </button>`).join('');
}

/* inputs card */
function controlHTML(id, P) {
  const m = MODULES[id], v = P.inputs[id];
  if (m.kind === 'range') {
    return `<input type="range" min="${m.min}" max="${m.max}" step="${m.step}" value="${v}" data-input="${id}" aria-label="${esc(m.label)}">`;
  }
  if (m.options.length <= 3) {
    return `<div class="seg" role="group" aria-label="${esc(m.label)}">${m.options.map(o =>
      `<button class="${o.v === v ? 'on' : ''}" data-seg="${id}" data-val="${esc(o.v)}">${esc(o.v)}</button>`).join('')}</div>`;
  }
  return `<select class="sel" data-input="${id}" aria-label="${esc(m.label)}">${m.options.map(o =>
    `<option ${o.v === v ? 'selected' : ''}>${esc(o.v)}</option>`).join('')}</select>`;
}

function renderInputs() {
  const P = persona();
  const unused = Object.keys(MODULES).filter(id => !P.order.includes(id));
  $('#inputs').innerHTML = `
    <div class="card">
      <p class="eyebrow orange">${P.name}'s inputs</p>
      <div class="in-list">
        ${P.order.map(id => `
          <div class="in-row">
            <div class="in-top">
              <span class="dot ${MODULES[id].custom ? 'custom' : ''}"></span>
              <span class="in-label">${esc(MODULES[id].label)}</span>
              <span class="in-val" id="val-${id}">${esc(evalInput(id, P.inputs[id], P).text)}</span>
              <button class="in-x" data-remove="${id}" aria-label="Remove ${esc(MODULES[id].label)}"><i data-lucide="x"></i></button>
            </div>
            <div class="in-ctrl">${controlHTML(id, P)}</div>
          </div>`).join('')}
      </div>
      ${unused.length ? `<select class="add-select" id="addInput" aria-label="Add an input">
        <option value="">+ Add an input signal…</option>
        ${unused.map(id => `<option value="${id}">${esc(MODULES[id].label)}</option>`).join('')}
      </select>` : ''}
      <div class="in-tags"><span class="tag type">${P.type}</span><span class="tag ${P.styleClass}">${P.style}</span></div>
      <p class="in-note">Drag or switch any signal. Each person has their own set of inputs; add or remove them to see how the prediction changes.</p>
    </div>`;
}

/* model panel — skeleton once, then fill */
function renderModelShell() {
  $('#model').innerHTML = `
    <div class="model">
      <p class="eyebrow orange">Our core</p>
      <h2>Detour model</h2>

      <div class="m-step">
        <span class="pill"><b>1</b> Predict the craving</span>
        <div class="gauge-row">
          <div class="gauge" id="mGauge"><div class="g-tick" id="mTick"></div><div class="g-in"><b id="mPct">0%</b><span>craving risk</span></div></div>
          <div class="verdict">
            <div class="v-title" id="mVerdict"></div>
            <div class="v-text" id="mVerdictText"></div>
            <label class="thr">Step-in threshold <input type="range" min="0.3" max="0.9" step="0.05" value="${state.threshold}" id="thr"> <b id="thrVal"></b></label>
          </div>
        </div>
        <div class="contribs" id="mContribs"></div>
        <div class="mix"><div class="mix-bar" id="mMixBar"></div><div class="mix-legend" id="mMixLegend"></div></div>
      </div>

      <div class="m-step">
        <span class="pill"><b>2</b> Choose what &amp; when</span>
        <div class="rank" id="mRank"></div>
        <div id="mWhen"></div>
      </div>

      <div class="m-step">
        <span class="pill"><b>3</b> Learn from every slip</span>
        <ul class="log" id="mLog"></ul>
        <div class="m-actions">
          <button class="m-btn warn" data-act="slipPanel"><i data-lucide="cigarette"></i> "I smoked" report</button>
          <button class="m-btn" data-act="resetLearning"><i data-lucide="rotate-ccw"></i> Reset learning</button>
        </div>
      </div>
    </div>`;
}

function renderModel(P, pred, choice) {
  const pct = Math.round(pred.p * 100);
  const over = pred.p >= state.threshold;
  const col = pred.p >= .75 ? '#E0592A' : pred.p >= state.threshold ? '#E8955F' : '#6FAF92';
  $('#mGauge').style.background = `conic-gradient(${col} ${pred.p * 360}deg, rgba(255,255,255,.08) 0)`;
  $('#mTick').style.transform = `rotate(${state.threshold * 360}deg)`;
  $('#mPct').textContent = `${pct}%`;
  $('#thrVal').textContent = `${Math.round(state.threshold * 100)}%`;
  $('#mVerdict').textContent = over ? (pred.p >= .8 ? 'High risk: step in' : 'Rising risk: step in') : 'Low risk: stay quiet';
  $('#mVerdictText').textContent = over
    ? `Mostly a ${TRIGGERS[pred.dominant].label.toLowerCase()} craving.`
    : 'Below the threshold, so the phone stays silent. No nagging.';

  const maxAbs = 2.2;
  const bar = c => {
    const w = Math.min(50, Math.abs(c) / maxAbs * 50);
    return c >= 0
      ? `<span class="cb-bar" style="left:50%;width:${w}%;background:#E0592A"></span>`
      : `<span class="cb-bar" style="right:50%;width:${w}%;background:#6FAF92"></span>`;
  };
  $('#mContribs').innerHTML = pred.contribs.map(c => `
      <div class="cb" title="${esc(c.text)}"><span class="cb-label">${esc(c.label)}</span><span class="cb-track">${bar(c.c)}</span><span class="cb-num">${c.c >= 0 ? '+' : '−'}${Math.abs(c.c).toFixed(2)}</span></div>`).join('')
    + `<div class="cb cb-bias" title="Personal baseline, shifts with every logged slip"><span class="cb-label">Personal baseline</span><span class="cb-track">${bar(P.bias)}</span><span class="cb-num">${P.bias >= 0 ? '+' : '−'}${Math.abs(P.bias).toFixed(2)}</span></div>`
    + (pred.contribs.length ? '' : '<div class="m-sub">No inputs switched on: the model only knows the baseline.</div>');

  $('#mMixBar').innerHTML = Object.entries(pred.mix).map(([k, v]) => `<span style="width:${v * 100}%;background:${TRIGGERS[k].color}"></span>`).join('');
  $('#mMixLegend').innerHTML = Object.entries(pred.mix).map(([k, v]) =>
    `<span class="${k === pred.dominant ? 'dom' : ''}"><i style="background:${TRIGGERS[k].color}"></i>${TRIGGERS[k].label} ${Math.round(v * 100)}%</span>`).join('');

  const top = Math.max(...choice.ranked.map(r => r.score), .01);
  $('#mRank').innerHTML = choice.ranked.map(r => {
    const o = OUTPUTS[r.id];
    const isChosen = choice.chosen && r.id === choice.chosen.id;
    const note = !r.enabled ? 'switched off by researcher' : r.tried ? 'already tried, did not help' : (r.cx.note || o.kind);
    return `<div class="rk ${isChosen ? 'chosen' : ''} ${!r.enabled || r.tried ? 'off' : ''}" title="preference ${r.pref.toFixed(2)} · trigger fit ${r.fit.toFixed(2)} · context ×${r.cx.f}">
      <span class="rk-ico"><i data-lucide="${o.icon}"></i></span>
      <span class="rk-name">${o.label}<small>${esc(note)}</small></span>
      <span class="rk-track"><span style="width:${r.score / top * 100}%"></span></span>
      <span class="rk-score">${r.score.toFixed(2)}</span>
    </div>`;
  }).join('');

  let when = '';
  if (!choice.chosen) when = `<div class="hold">Every output is switched off. Turn one back on in the researcher panel.</div>`;
  else if (!over) when = `<div class="hold">Holding back: risk ${pct}% is under the ${Math.round(state.threshold * 100)}% threshold. If it rises, ${OUTPUTS[choice.chosen.id].label.toLowerCase()} is next.</div>`;
  else {
    const c = choice.chosen;
    const n = buildNotification(P, pred, c.id);
    const via = n.covert ? `${n.app} notification, no mention of smoking` : OUTPUTS[c.id].kind;
    when = `<div class="when">
      <span><b>What:</b> ${OUTPUTS[c.id].label} (${esc(via)})</span>
      <span><b>When:</b> ${esc(timing(P, pred))}</span>
      <span><b>Why:</b> ${P.name} prefers this (${c.pref.toFixed(2)}) and it fits a ${TRIGGERS[pred.dominant].label.toLowerCase()} craving (${c.fit.toFixed(2)}).</span>
    </div>`;
  }
  $('#mWhen').innerHTML = when;

  $('#mLog').innerHTML = P.log.length
    ? P.log.slice(0, 8).map(l => `<li class="${l.kind}"><time>${l.t}</time><span>${esc(l.text)}</span></li>`).join('')
    : `<li class="empty">Nothing learned yet. Accept, dismiss or report a slip on the phone and the model adjusts ${P.name}'s preferences.</li>`;
}

/* -------------------------------------------------------------------------
   PHONE
   ------------------------------------------------------------------------- */
const SIGNAL = c => `<svg width="17" height="11" viewBox="0 0 17 11"><rect x="0" y="7" width="3" height="4" rx="1" fill="${c}"/><rect x="4.5" y="5" width="3" height="6" rx="1" fill="${c}"/><rect x="9" y="2.5" width="3" height="8.5" rx="1" fill="${c}"/><rect x="13.5" y="0" width="3" height="11" rx="1" fill="${c}"/></svg>`;
const BATTERY = c => `<svg width="25" height="12" viewBox="0 0 25 12"><rect x=".5" y=".5" width="21" height="11" rx="3.5" fill="none" stroke="${c}" opacity=".5"/><rect x="2" y="2" width="16" height="8" rx="2" fill="${c}"/><rect x="23" y="4" width="1.6" height="4" rx=".8" fill="${c}" opacity=".5"/></svg>`;
function statusBar(time, ink = false) {
  const c = ink ? '#15211D' : '#fff';
  return `<div class="sb ${ink ? 'ink' : ''}"><span>${time}</span><div class="island"></div><span class="sb-r">${SIGNAL(c)}${BATTERY(c)}</span></div>`;
}

function notifHTML(n, { enter = false, ctx = false } = {}) {
  const icon = n.app === 'Detour' ? LOGO : `<span class="n-appicon" style="background:${n.color}"><i data-lucide="${n.icon}"></i></span>`;
  const actions = n.primary ? `<div class="n-actions">
      <button class="n-btn primary ${n.covert ? 'neutral' : ''}" data-act="accept">${esc(n.primary)}</button>
      <button class="n-btn" data-act="dismiss">${esc(n.secondary)}</button></div>` : '';
  return `<div class="notif ${ctx ? 'ctx' : ''} ${enter ? 'enter' : ''}">
    <div class="n-head">${icon}<span class="n-app">${esc(n.app.toUpperCase())}</span><span class="n-time">${n.time || 'now'}</span></div>
    <div class="n-title">${esc(n.title)}</div><div class="n-body">${esc(n.body)}</div>${actions}</div>`;
}

const HOME_APPS = [
  ['Mail', 'mail', '#3B82F6'], ['Calendar', 'calendar', '#EF4444'], ['Photos', 'image', '#F59E0B'], ['Camera', 'camera', '#6B7280'],
  ['Maps', 'map', '#10B981'], ['Weather', 'cloud-sun', '#0EA5E9'], ['Clock', 'clock', '#111827'], ['Notes', 'notebook-pen', '#EAB308'],
  ['Music', 'music', '#EC4899'], ['Health', 'heart', '#F43F5E'], ['Detour', null, null], ['Settings', 'settings', '#64748B'],
];
const DOCK = [['phone', '#22C55E'], ['message-circle', '#22C55E'], ['compass', '#3B82F6'], ['camera', '#6B7280']];

function baseScreen(P) {
  const pred = state.pred, choice = state.choice;
  const show = pred.p >= state.threshold && choice.chosen && !state.dismissed;
  let notif = '';
  if (show) {
    const n = buildNotification(P, pred, choice.chosen.id);
    state.activeOutput = choice.chosen.id;
    state.activeNotif = n;
    const key = P.id + choice.chosen.id;
    notif = notifHTML(n, { enter: key !== state.lastNotifKey });
    state.lastNotifKey = key;
  } else {
    state.lastNotifKey = null;
  }
  const time = hhmm(currentHour(P));

  if (P.screen === 'home') {
    const app = ([name, ic, col]) => name === 'Detour'
      ? `<button class="app-ic" data-act="openApp"><span class="ic">${LOGO}</span>${name}</button>`
      : `<div class="app-ic"><span class="ic" style="background:${col}"><i data-lucide="${ic}"></i></span>${name}</div>`;
    return `<div class="wall" style="background:${P.wallpaper}"></div>
      ${statusBar(time)}
      ${notif ? `<div class="home-top">${notif}</div>` : ''}
      <div class="home-grid ${notif ? 'blur' : ''}">${HOME_APPS.map(app).join('')}</div>
      <div class="dock">${DOCK.map(([ic, c]) => `<div class="app-ic"><span class="ic" style="background:${c}"><i data-lucide="${ic}"></i></span></div>`).join('')}</div>
      <div class="home-ind"></div>`;
  }
  return `<div class="wall" style="background:${P.wallpaper}"></div>
    ${statusBar(time)}
    <div class="lock-date">${P.date}</div>
    <div class="lock-time">${time}</div>
    <div class="lock-stack">${P.ctx.map(c => notifHTML(c, { ctx: true })).join('')}${notif}</div>
    <div class="lock-bottom"><span class="lock-btn"><i data-lucide="flashlight"></i></span><button class="lock-btn" data-act="openApp" style="border:0;color:#fff" title="Open Detour"><i data-lucide="camera"></i></button></div>
    <div class="home-ind"></div>`;
}

function sheetHTML() {
  return `<div class="sheet-wrap"><div class="sheet">
    <div class="grab"></div>
    <h3>Did the craving pass?</h3>
    <p>Your answer teaches Detour what works for you.</p>
    <button class="cta" data-act="passed">Yes, it passed 🎉</button>
    <button class="cta ghost" data-act="retry">Still craving, try something else</button>
    <button class="link-btn" data-act="slip">I smoked anyway</button>
  </div></div>`;
}

/* app screens */
function breathingScreen(P) {
  return `<div class="app breathing">${statusBar(hhmm(currentHour(P)))}
    <button class="app-close" data-act="done" aria-label="Close"><i data-lucide="x"></i></button>
    <div class="app-pad">
      <div class="small-cap" style="color:#9BE0BE">Box breathing · 4-4-4-4</div>
      <div class="h-title">Breathe with the circle</div>
      <div class="b-wrap"><div class="b-ring"></div><div class="b-circle" id="bCircle"></div><div class="b-phase" id="bPhase">Breathe in</div></div>
      <div class="b-count" id="bCount">2:00 left</div>
      <button class="cta light" data-act="done">I'm done</button>
    </div><div class="home-ind"></div></div>`;
}

function walkScreen(P) {
  return `<div class="app walk">${statusBar(hhmm(currentHour(P)), true)}
    <button class="app-close" data-act="done" aria-label="Close"><i data-lucide="x"></i></button>
    <div class="app-pad">
      <div class="small-cap" style="color:#B4421B">Routine swap</div>
      <div class="h-title">Three minutes around the block</div>
      <div class="w-ring" id="wRing"><div class="w-in"><b id="wTime">3:00</b><span style="font-size:11px;color:#6A4E44">left</span></div></div>
      <div class="w-stats"><div><b id="wSteps">0</b><span>steps</span></div><div><b id="wDist">0 m</b><span>distance</span></div><div><b>${P.days}</b><span>days free</span></div></div>
      <button class="cta" data-act="done">I'm back</button>
    </div><div class="home-ind ink"></div></div>`;
}

function chatScreen(P) {
  const c = state.chat;
  const isBot = c.kind === 'bot';
  const head = isBot
    ? `${LOGO}<div class="who">Detour<small>here for you</small></div>`
    : `<span class="avatar" style="background:${P.buddy.color}">${P.buddy.name[0]}</span><div class="who">${P.buddy.name}<small class="${P.buddy.online ? '' : 'off'}">${P.buddy.online ? 'online' : 'last seen 1h ago'}</small></div>`;
  const msgs = c.msgs.map(m => m.sep ? `<div class="day-sep">${esc(m.sep)}</div>` : `<div class="msg ${m.from}">${esc(m.text)}</div>`).join('')
    + (c.typing ? '<div class="msg them typing">•••</div>' : '');
  const quick = !c.typing && c.replies.length ? `<div class="quick">${c.replies.map(([label, next]) =>
    `<button data-reply="${esc(next)}" data-label="${esc(label)}">${esc(label)}</button>`).join('')}</div>` : '';
  return `<div class="app chat">${statusBar(hhmm(currentHour(P)), true)}
    <div class="chat-head"><button class="back" data-act="${state.fromNotif ? 'done' : 'home'}" aria-label="Back"><i data-lucide="chevron-left"></i></button>${head}</div>
    <div class="chat-body" id="chatBody">${msgs}</div>
    ${quick}
    <form class="composer" id="composer"><input id="chatInput" autocomplete="off" placeholder="Message" value="${esc(c.draft || '')}"><button aria-label="Send"><i data-lucide="send"></i></button></form>
    <div class="home-ind ink"></div></div>`;
}

function healingScreen(P) {
  const hl = healing(P.days);
  const next = MILESTONES.find(m => m.d > P.days);
  const body = `<svg viewBox="0 0 100 190" width="104" aria-hidden="true">
      <circle cx="50" cy="20" r="14" fill="#2E4A40"/><circle cx="45" cy="18" r="1.6" fill="#9DB2AA"/><circle cx="55" cy="18" r="1.6" fill="#9DB2AA"/>
      <rect x="28" y="38" width="44" height="66" rx="16" fill="#2E4A40"/>
      <rect x="12" y="42" width="13" height="58" rx="6.5" fill="#2E4A40" transform="rotate(8 18 42)"/>
      <rect x="75" y="42" width="13" height="58" rx="6.5" fill="#2E4A40" transform="rotate(-8 82 42)"/>
      <rect x="32" y="100" width="15" height="84" rx="7.5" fill="#2E4A40"/><rect x="53" y="100" width="15" height="84" rx="7.5" fill="#2E4A40"/>
      <ellipse cx="42" cy="64" rx="8" ry="15" fill="#E0592A" opacity="${.45 + hl.lungs / 200}"/>
      <ellipse cx="58" cy="64" rx="8" ry="15" fill="#C9472A" opacity="${.45 + hl.lungs / 200}"/>
      <circle cx="54" cy="74" r="4" fill="#fff"><animate attributeName="r" values="3.4;4.6;3.4" dur="1s" repeatCount="indefinite"/></circle>
    </svg>`;
  return `<div class="app healing">${statusBar(hhmm(currentHour(P)))}
    <button class="app-close" data-act="${state.fromNotif ? 'done' : 'home'}" aria-label="Close"><i data-lucide="x"></i></button>
    <div class="app-pad">
      <div class="small-cap" style="color:#F08A5D">Day ${P.days} smoke-free</div>
      <div class="h-title">Your body is repairing itself</div>
      <div class="h-body">
        <div>${body}</div>
        <div>
          <div class="h-call"><small>Lungs</small><b class="o">clearing · ${hl.lungs}%</b></div>
          <div class="h-call"><small>Heart &amp; blood</small><b>oxygen normal</b></div>
          <div class="h-call"><small>Taste &amp; smell</small><b>${hl.taste >= 100 ? 'fully back' : 'coming back'}</b></div>
        </div>
      </div>
      <div class="h-card">
        <div class="h-bar"><div class="lbl"><span>Lungs</span><b>${hl.lungs}%</b></div><div class="trk"><span class="o" data-w="${hl.lungs}" style="width:0"></span></div></div>
        <div class="h-bar"><div class="lbl"><span>Circulation</span><b>${hl.circ}%</b></div><div class="trk"><span data-w="${hl.circ}" style="width:0"></span></div></div>
        <div class="h-bar"><div class="lbl"><span>Taste &amp; smell</span><b>${hl.taste}%</b></div><div class="trk"><span data-w="${hl.taste}" style="width:0"></span></div></div>
        <div class="h-next">${next ? `Next milestone in ${next.d - P.days} day${next.d - P.days > 1 ? 's' : ''}: ${next.t}` : 'Every milestone reached. Incredible.'}</div>
        <button class="h-slip" data-act="slip">I smoked, log it</button>
      </div>
    </div><div class="home-ind"></div></div>`;
}

function mediaScreen(P) {
  const n = state.activeNotif, md = n.media;
  const close = `<button class="app-close" data-act="closeMedia" aria-label="Close"><i data-lucide="x"></i></button>`;
  if (md.kind === 'podcast') {
    return `<div class="app spotify">${statusBar(hhmm(currentHour(P)))}${close}
      <div class="app-pad">
        <div class="small-cap" style="text-align:center;color:#B3B3B3">Playing from your library</div>
        <div class="sp-cover" style="background:linear-gradient(135deg,${md.colors[0]},${md.colors[1]})"><small>Podcast</small><b>${esc(md.show)}</b></div>
        <div class="sp-title">${esc(md.ep)}</div><div class="sp-show">${esc(md.show)}</div>
        <div class="sp-prog"><span id="mProg"></span></div>
        <div class="sp-times"><span id="mCur">0:00</span><span>${md.len}:00</span></div>
        <div class="sp-ctrl"><button><i data-lucide="skip-back"></i></button><button class="play" data-act="togglePlay" id="mPlay"><i data-lucide="pause"></i></button><button><i data-lucide="skip-forward"></i></button></div>
      </div><div class="home-ind"></div></div>`;
  }
  if (md.kind === 'news') {
    return `<div class="app news">${statusBar(hhmm(currentHour(P)), true)}${close.replace('app-close', 'app-close" style="background:rgba(0,0,0,.06)')}
      <div class="app-pad">
        <div class="nw-brand">${esc(md.source)}</div>
        <div class="nw-img"></div>
        <h4 class="nw-h">${esc(md.headline)}</h4>
        <div class="nw-meta">${md.mins} min read · Science &amp; Nature</div>
        <p>It started as a small experiment by a handful of neighbours. Three years later, the results surprised even the researchers who came to measure them.</p>
        <p>Summer temperatures on the street dropped by almost two degrees, bird counts tripled and, according to residents, people simply talk to each other more.</p>
        <p>"We expected the cooling," says one of the scientists. "We did not expect people to start having dinner on the roofs."</p>
      </div><div class="home-ind ink"></div></div>`;
  }
  return `<div class="app youtube">${statusBar(hhmm(currentHour(P)), true)}${close.replace('app-close', 'app-close" style="background:rgba(0,0,0,.06);top:50px')}
    <div class="yt-bar"><span class="yt-logo"><i data-lucide="play"></i></span>YouTube</div>
    <div class="yt-video"><button class="big" data-act="togglePlay" id="mPlay" style="border:0"><i data-lucide="pause"></i></button><span class="yt-len">${md.len}</span><span class="yt-p" id="mProg"></span></div>
    <div class="yt-meta"><h4>${esc(md.title)}</h4><p>${esc(md.channel)} · ${esc(md.views)}</p></div>
    <div class="yt-next"><div class="small-cap" style="color:#606060">Up next</div>
      <div class="row"><span class="th" style="background:linear-gradient(135deg,#9BC5A8,#3F7A5B)"></span><div><b>Ten tiny habits that actually stick</b><small>Slow Living · 9:12</small></div></div>
      <div class="row"><span class="th" style="background:linear-gradient(135deg,#D9B26F,#8A5A2B)"></span><div><b>I tried every bread recipe in one weekend</b><small>Weeknight Kitchen · 21:40</small></div></div>
    </div><div class="home-ind ink"></div></div>`;
}

function renderPhone() {
  const P = persona();
  const screens = { base: baseScreen, breathing: breathingScreen, walk: walkScreen, chat: chatScreen, healing: healingScreen, media: mediaScreen };
  $('#screen').innerHTML = screens[state.screen](P) + (state.sheet ? sheetHTML() : '');
  icons();
  const cb = $('#chatBody');
  if (cb) cb.scrollTop = cb.scrollHeight;
}

/* -------------------------------------------------------------------------
   APP-SCREEN BEHAVIOUR (timers, chats)
   ------------------------------------------------------------------------- */
function clearTimers() { state.timers.forEach(t => { clearInterval(t); clearTimeout(t); }); state.timers = []; }
const later = (fn, ms) => state.timers.push(setTimeout(fn, ms));
const every = (fn, ms) => state.timers.push(setInterval(fn, ms));

function openScreen(screen) {
  clearTimers();
  state.screen = screen;
  state.sheet = false;
  state.appStart = Date.now();
  renderPhone();
  if (screen === 'breathing') startBreathing();
  if (screen === 'walk') startWalk();
  if (screen === 'media') startMedia();
  if (screen === 'healing') later(() => document.querySelectorAll('.h-bar .trk span').forEach(s => { s.style.width = s.dataset.w + '%'; }), 60);
}

function startBreathing() {
  const phases = ['Breathe in', 'Hold', 'Breathe out', 'Hold'];
  let t = 0;
  const tick = () => {
    const circle = $('#bCircle'); if (!circle) return;
    const ph = Math.floor(t / 4) % 4;
    $('#bPhase').textContent = phases[ph];
    circle.style.transform = ph === 0 || ph === 1 ? 'scale(1)' : 'scale(.55)';
    const left = Math.max(0, 120 - t);
    $('#bCount').textContent = `${Math.floor(left / 60)}:${pad(left % 60)} left`;
    if (left === 0) { clearTimers(); state.sheet = true; renderPhone(); }
    t++;
  };
  later(tick, 50);
  every(tick, 1000);
}

function startWalk() {
  let t = 0;
  const tick = () => {
    if (!$('#wRing')) return;
    const left = Math.max(0, 180 - t);
    $('#wTime').textContent = `${Math.floor(left / 60)}:${pad(left % 60)}`;
    $('#wSteps').textContent = Math.round(t * 1.9);
    $('#wDist').textContent = `${Math.round(t * 1.35)} m`;
    $('#wRing').style.background = `conic-gradient(#2E7D5B ${(t / 180) * 360}deg, rgba(255,255,255,.5) 0)`;
    if (left === 0) { clearTimers(); state.sheet = true; renderPhone(); }
    t++;
  };
  tick();
  every(tick, 1000);
}

function startMedia() {
  state.playing = true;
  let t = 0;
  every(() => {
    if (!state.playing) return;
    t++;
    const prog = $('#mProg'); if (!prog) return;
    const md = state.activeNotif.media;
    const total = md.kind === 'podcast' ? md.len * 60 : 600;
    prog.style.width = `${Math.min(100, (t / total) * 100 * 8)}%`; // sped up so it visibly moves
    const cur = $('#mCur'); if (cur) cur.textContent = `${Math.floor(t / 60)}:${pad(t % 60)}`;
  }, 1000);
}

/* buddy chat */
function openBuddyChat(P) {
  state.chat = {
    kind: 'buddy',
    msgs: [{ sep: 'Yesterday' }, { from: 'them', text: `Day ${Math.max(1, P.days - 1)} for me too 💪` }, { sep: 'Today' }],
    replies: [], draft: "Hey, it's hitting me hard tonight 😅", typing: false, stage: 0,
  };
  openScreen('chat');
}

function buddyReply(P) {
  const c = state.chat;
  c.typing = true; renderPhone();
  later(() => {
    c.typing = false;
    c.msgs.push({ from: 'them', text: `Proud of you for texting instead. Grab a water and give it 5 minutes. Call me if you want 💪` });
    c.replies = [["Thanks, I'm good now", '__done'], ['Can I call you?', 'call']];
    renderPhone();
  }, 1400);
}

/* chatbot */
const BOT = {
  start: P => ({
    say: [`Hey ${P.name}, ${partOfDay(currentHour(P)) === 'night' ? 'still up? 🌙' : 'got a minute? 👋'}`, "Fancy a quick round of 'guess the year'? I've got a good one."],
    replies: [['Sure, go', 'game'], ['Just talk to me', 'talk'], ['Honestly, I want a smoke', 'crave']],
  }),
  game: { say: ["The first text message ever sent said 'Merry Christmas'. Which year?"], replies: [['1985', 'g_wrong'], ['1992', 'g_right'], ['1999', 'g_wrong']] },
  g_right: { say: ['Spot on! 1992, sent from a computer to a phone. 📟', "That's a few minutes gone already. Cravings usually peak and fade within 5 to 10."], replies: [['Another one', 'game2'], ["I'm good now", 'end']] },
  g_wrong: { say: ['Close! It was 1992, sent from a computer to a phone. 📟', "That's a few minutes gone already. Cravings usually peak and fade within 5 to 10."], replies: [['Another one', 'game2'], ["I'm good now", 'end']] },
  game2: { say: ['Which animal has three hearts?'], replies: [['Octopus', 'g2_right'], ['Shark', 'g2_wrong'], ['Frog', 'g2_wrong']] },
  g2_right: { say: ['Yes! 🐙 Two pump blood to the gills, one to the rest of the body.', 'And you just got through the worst of the craving. Proud of you.'], replies: [["Thanks, I'm good", 'end']] },
  g2_wrong: { say: ['Nope, the octopus! 🐙 Two hearts for the gills, one for the body.', 'And you just got through the worst of the craving. Proud of you.'], replies: [["Thanks, I'm good", 'end']] },
  talk: { say: ['Of course. How was today, from 🌧️ to ☀️?'], replies: [['🌧️ Rough', 't_rough'], ['⛅ Meh', 't_meh'], ['☀️ Good', 't_good']] },
  t_rough: { say: ["Sorry it was a heavy one. You don't have to fix it tonight.", 'Want a weird fact to switch your brain to something else?'], replies: [['Weird fact please', 'game2'], ["I'll be fine", 'end']] },
  t_meh: { say: ['Meh days count too. Anything small that went right?'], replies: [['Actually, yes', 't_good'], ['Not really', 't_rough']] },
  t_good: { say: ["Love that. And you're on day {days} without smoking, which makes it even better. 💪"], replies: [['Play a game', 'game'], ["I'm good now", 'end']] },
  crave: { say: ['Thanks for telling me, that takes guts.', "Let's ride it out together: type three things you can see right now."], replies: [], free: 'crave2' },
  crave2: { say: ['Good. That pulls your brain out of autopilot.', "Cravings drop after about 5 minutes and you're already past 2. Glass of water?"], replies: [['Done 💧', 'end'], ['Still craving', 'game']] },
  end: { say: ["Anytime. I'm here if it comes back. 🌙"], replies: [['Close chat', '__done']] },
};
const FALLBACK = ['I hear you.', "Tell me more, I've got time.", "That makes sense. Let's keep your hands and head busy for a few minutes."];

function openBotChat(P) {
  state.chat = { kind: 'bot', msgs: [], replies: [], typing: false, node: null, fb: 0 };
  openScreen('chat');
  botSay(P, BOT.start(P), 'start');
}

function botSay(P, node, key) {
  const c = state.chat;
  c.replies = [];
  c.node = key;
  const lines = node.say.map(s => s.replace('{days}', P.days));
  let i = 0;
  const step = () => {
    c.typing = true; renderPhone();
    later(() => {
      c.typing = false;
      c.msgs.push({ from: 'them', text: lines[i++] });
      if (i < lines.length) step();
      else { c.replies = node.replies; renderPhone(); }
      if (i < lines.length) renderPhone();
    }, 650 + lines[i].length * 12);
  };
  step();
}

function userSends(text, next) {
  const P = persona(), c = state.chat;
  if (!text.trim()) return;
  c.msgs.push({ from: 'me', text });
  c.draft = '';
  if (next === '__done') { renderPhone(); later(() => { state.sheet = true; renderPhone(); }, 400); return; }
  if (c.kind === 'buddy') {
    if (next === 'call') { c.replies = []; renderPhone(); later(() => { c.msgs.push({ from: 'them', text: 'Calling you now 📞' }); c.replies = [["Thanks, that helped", '__done']]; renderPhone(); }, 900); return; }
    c.replies = [];
    buddyReply(P);
    return;
  }
  const node = BOT[c.node];
  const target = next || (node && node.free);
  if (target && BOT[target]) { botSay(P, BOT[target], target); return; }
  botSay(P, { say: [FALLBACK[c.fb++ % FALLBACK.length]], replies: node ? node.replies : [] }, c.node);
}

/* -------------------------------------------------------------------------
   ACTIONS
   ------------------------------------------------------------------------- */
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.h);
  toast.h = setTimeout(() => t.classList.remove('show'), 2800);
}

function goBase() {
  clearTimers();
  state.screen = 'base';
  state.sheet = false;
  state.chat = null;
  update();
}

const ACTIONS = {
  accept() {
    const P = persona(), id = state.activeOutput;
    state.fromNotif = true;
    learn(+.04, 'Opened');
    if (id === 'breathing') openScreen('breathing');
    else if (id === 'routineSwap') openScreen('walk');
    else if (id === 'buddy') openBuddyChat(P);
    else if (id === 'healing') openScreen('healing');
    else if (id === 'media') openScreen('media');
    else if (id === 'chatbot') openBotChat(P);
    update();
  },
  dismiss() {
    learn(-.12, 'Dismissed');
    state.dismissed = true;
    toast('Dismissed. Detour lowers this option a little for next time.');
    update();
  },
  done() { clearTimers(); state.sheet = true; renderPhone(); },
  passed() {
    learn(+.08, 'Craving passed with');
    state.dismissed = true;
    toast('Nice! Detour will use this more often.');
    goBase();
  },
  retry() {
    const id = state.activeOutput;
    learn(-.08, "Didn't help:");
    state.excluded.add(id);
    state.dismissed = false;
    toast(`Trying the next-best option instead of ${OUTPUTS[id].label.toLowerCase()}.`);
    goBase();
  },
  slip() {
    logSlip();
    state.dismissed = true;
    toast('Logged. Slips are data, not failure: the model just got smarter.');
    goBase();
  },
  slipPanel() {
    state.activeOutput = state.choice.chosen && state.pred.p >= state.threshold ? state.choice.chosen.id : null;
    ACTIONS.slip();
  },
  closeMedia() {
    const secs = Math.round((Date.now() - state.appStart) / 1000);
    // covert: no "did it help?" question, the model reads engagement instead
    if (secs >= 8) learn(+.06, `Implicit signal: stayed ${secs}s in`);
    else learn(-.06, `Implicit signal: closed after ${secs}s,`);
    state.dismissed = true;
    toast(secs >= 8 ? 'Engaged long enough to count as a success. No questions asked.' : 'Closed quickly: counted as a weak miss.');
    goBase();
  },
  togglePlay() {
    state.playing = !state.playing;
    const b = $('#mPlay');
    if (b) { b.innerHTML = `<i data-lucide="${state.playing ? 'pause' : 'play'}"></i>`; icons(); }
  },
  openApp() { state.fromNotif = false; state.activeOutput = null; openScreen('healing'); },
  home() { goBase(); },
  replay() {
    state.dismissed = false;
    state.excluded.clear();
    state.lastNotifKey = null;
    goBase();
  },
  resetLearning() {
    const orig = PERSONAS.find(p => p.id === state.pid);
    const P = persona();
    P.prefs = clone(orig.prefs);
    P.bias = orig.bias;
    P.log = [];
    P.slips = 0;
    state.excluded.clear();
    state.dismissed = false;
    toast(`${P.name}'s learned preferences are reset.`);
    goBase();
  },
};

/* -------------------------------------------------------------------------
   RESEARCHER
   ------------------------------------------------------------------------- */
function renderResearcher() {
  const P = persona();
  $('#researcher').innerHTML = `
    <div>
      <div class="r-icon"><i data-lucide="flask-conical"></i></div>
      <h2>Researcher</h2>
      <p>Finds out something helps people stop smoking? Package it as a module and publish it. Every phone can switch it on, and the model starts using it.</p>
    </div>
    <div>
      <p class="eyebrow orange">Input modules</p>
      <div class="chips">
        ${Object.entries(MODULES).map(([id, m]) => `<button class="chip in ${P.order.includes(id) ? '' : 'off'} ${m.custom ? 'custom' : ''}" data-toggle-in="${id}" title="${P.order.includes(id) ? 'Remove from' : 'Add to'} ${P.name}'s phone">${esc(m.label)}</button>`).join('')}
        <button class="chip new" data-act="newInput">+ New input</button>
      </div>
      <p class="r-hint">Filled = switched on for ${P.name}. Click to add or remove.</p>
    </div>
    <div>
      <p class="eyebrow green">Output modules</p>
      <div class="chips">
        ${Object.entries(OUTPUTS).map(([id, o]) => `<button class="chip out ${state.enabledOutputs.has(id) ? '' : 'off'}" data-toggle-out="${id}">${esc(o.label)}</button>`).join('')}
        <button class="chip new" data-act="newOutput">+ New output</button>
      </div>
      <p class="r-hint">Switch an output off to see the model fall back to the next-best one.</p>
    </div>`;
}

function openNewInputModal() {
  const m = $('#modal');
  m.hidden = false;
  m.innerHTML = `<form class="modal" id="newInputForm">
    <p class="eyebrow purple">Publish a module</p>
    <h3>New input signal</h3>
    <p>A researcher found a new predictor. Give it a name and say what kind of craving it hints at; it becomes a 0–10 signal every phone can switch on.</p>
    <label class="field">Name<input type="text" id="niName" placeholder="e.g. Skin temperature, Screen brightness…" required maxlength="28"></label>
    <label class="field">Hints at a craving driven by
      <select id="niTrig">${Object.entries(TRIGGERS).map(([k, t]) => `<option value="${k}">${t.label}</option>`).join('')}</select></label>
    <label class="field">How strong is the evidence? <input type="range" id="niW" min="0.5" max="3" step="0.1" value="1.8"></label>
    <div class="modal-actions"><button type="button" class="btn ghost" data-act="closeModal">Cancel</button><button class="btn primary">Publish &amp; add to ${persona().name}</button></div>
  </form>`;
  $('#niName').focus();
}

function publishInput(name, trig, w) {
  const id = `custom${++state.customCount}`;
  MODULES[id] = {
    label: name, icon: 'sparkles', kind: 'range', min: 0, max: 10, step: 1, def: 5, w, custom: true,
    fmt: v => `${v} / 10`, act: v => v / 10, trig: () => ({ [trig]: 1 }),
  };
  addInput(id);
  toast(`Published "${name}". Every phone can now switch it on.`);
}

/* -------------------------------------------------------------------------
   UPDATE LOOP & EVENTS
   ------------------------------------------------------------------------- */
function update() {
  const P = persona();
  state.pred = predict(P);
  state.choice = choose(P, state.pred);
  renderModel(P, state.pred, state.choice);
  if (state.screen === 'base') renderPhone();
  icons();
}

function renderAll() {
  renderPersonas();
  renderInputs();
  renderResearcher();
  update();
}

function setInput(id, value) {
  const P = persona();
  P.inputs[id] = value;
  const lbl = document.getElementById(`val-${id}`);
  if (lbl) lbl.textContent = evalInput(id, value, P).text;
  state.dismissed = false;
  update();
}

function addInput(id) {
  const P = persona();
  if (P.order.includes(id)) return;
  P.order.push(id);
  P.inputs[id] = MODULES[id].routine ? Math.round(P.clock * 4) / 4 : MODULES[id].def;
  state.dismissed = false;
  renderInputs(); renderResearcher(); update();
}

function removeInput(id) {
  const P = persona();
  P.order = P.order.filter(x => x !== id);
  delete P.inputs[id];
  state.dismissed = false;
  renderInputs(); renderResearcher(); update();
}

function selectPersona(id) {
  clearTimers();
  state.pid = id;
  state.screen = 'base';
  state.sheet = false;
  state.chat = null;
  state.dismissed = false;
  state.excluded.clear();
  state.lastNotifKey = null;
  renderAll();
}

document.addEventListener('click', e => {
  const t = e.target.closest('[data-persona],[data-act],[data-seg],[data-remove],[data-toggle-in],[data-toggle-out],[data-reply]');
  if (!t) return;
  if (t.dataset.persona) return selectPersona(t.dataset.persona);
  if (t.dataset.seg) return (() => {
    t.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === t));
    setInput(t.dataset.seg, t.dataset.val);
  })();
  if (t.dataset.remove) return removeInput(t.dataset.remove);
  if (t.dataset.toggleIn) return persona().order.includes(t.dataset.toggleIn) ? removeInput(t.dataset.toggleIn) : addInput(t.dataset.toggleIn);
  if (t.dataset.toggleOut) {
    const id = t.dataset.toggleOut;
    state.enabledOutputs.has(id) ? state.enabledOutputs.delete(id) : state.enabledOutputs.add(id);
    state.dismissed = false;
    renderResearcher(); update();
    return;
  }
  if (t.dataset.reply) return userSends(t.dataset.label, t.dataset.reply);
  const act = t.dataset.act;
  if (act === 'newInput') return openNewInputModal();
  if (act === 'newOutput') return toast('New outputs (e.g. a guided game or a call with a coach) plug in the same way. Not wired up in this prototype yet.');
  if (act === 'closeModal') { $('#modal').hidden = true; return; }
  if (ACTIONS[act]) ACTIONS[act]();
});

document.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'thr') { state.threshold = +t.value; state.dismissed = false; update(); return; }
  if (t.dataset.input) {
    const m = MODULES[t.dataset.input];
    setInput(t.dataset.input, m.kind === 'range' ? +t.value : t.value);
  }
  if (t.id === 'chatInput' && state.chat) state.chat.draft = t.value;
});

document.addEventListener('change', e => {
  if (e.target.id === 'addInput' && e.target.value) addInput(e.target.value);
});

document.addEventListener('submit', e => {
  e.preventDefault();
  if (e.target.id === 'composer') {
    const inp = $('#chatInput');
    userSends(inp.value, null);
  }
  if (e.target.id === 'newInputForm') {
    const name = $('#niName').value.trim();
    if (!name) return;
    publishInput(name, $('#niTrig').value, +$('#niW').value);
    $('#modal').hidden = true;
  }
});

document.addEventListener('keydown', e => { if (e.key === 'Escape') $('#modal').hidden = true; });
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') e.target.hidden = true; });

$('#brandLogo').innerHTML = LOGO;
renderModelShell();
renderAll();
