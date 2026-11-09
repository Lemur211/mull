// Mull's practice engine: fact generation, scheduling, and progress.
// No DOM access, so it can be unit tested in Node. Loaded as a classic script
// in the browser so index.html also works when opened directly from disk.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MullEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DAY = 24 * 60 * 60 * 1000;
  const MAX = 12;

  // A fact moves up one box each time it is answered quickly when due.
  // Boxes 1-2 repeat within a round; higher boxes wait for a later day.
  const INTERVALS = [0, 0, 0, DAY, 3 * DAY, 7 * DAY, 21 * DAY];
  const TOP_BOX = INTERVALS.length - 1;
  const FIRST_FLUENT_BOX = 3;

  const MAX_ACTIVE = 4; // facts being learned at once
  const RECENT_WINDOW = 3; // questions before a fact may repeat

  const OPS = {
    add: { symbol: '+', name: 'Addition' },
    sub: { symbol: '−', name: 'Subtraction' },
    mul: { symbol: '×', name: 'Multiplication' },
    div: { symbol: '÷', name: 'Division' },
  };
  const OP_KEYS = Object.keys(OPS);

  // Teaching order for times tables, easiest first.
  const TABLE_ORDER = [1, 0, 2, 10, 5, 11, 3, 4, 9, 6, 8, 7, 12];

  function easeScore(op, x, y) {
    const a = op === 'add' || op === 'sub' ? x : TABLE_ORDER.indexOf(x);
    const b = op === 'add' || op === 'sub' ? y : TABLE_ORDER.indexOf(y);
    return Math.min(a, b) * 100 + Math.max(a, b);
  }

  const factCache = {};

  // Every fact is stored as (op, x, y). x and y are the grid axes:
  //   add  x + y          sub  (x + y) - y
  //   mul  x * y          div  (x * y) / y
  function allFacts(op) {
    if (factCache[op]) return factCache[op];
    const facts = [];
    const minY = op === 'div' ? 1 : 0;
    for (let y = minY; y <= MAX; y++) {
      for (let x = 0; x <= MAX; x++) {
        facts.push({ key: `${op}:${x}:${y}`, op, x, y });
      }
    }
    facts.sort((p, q) => easeScore(op, p.x, p.y) - easeScore(op, q.x, q.y));
    factCache[op] = facts;
    return facts;
  }

  function answerOf(fact) {
    switch (fact.op) {
      case 'add': return fact.x + fact.y;
      case 'sub': return fact.x;
      case 'mul': return fact.x * fact.y;
      case 'div': return fact.x;
      default: throw new Error(`Unknown op: ${fact.op}`);
    }
  }

  function promptOf(fact) {
    const { op, x, y } = fact;
    const left = op === 'sub' ? x + y : op === 'div' ? x * y : x;
    return { left, symbol: OPS[op].symbol, right: y };
  }

  function factText(fact) {
    const p = promptOf(fact);
    return `${p.left} ${p.symbol} ${p.right} = ${answerOf(fact)}`;
  }

  function factFromKey(key) {
    const [op, x, y] = key.split(':');
    return { key, op, x: Number(x), y: Number(y) };
  }

  function newState() {
    return {
      version: 1,
      facts: {},
      history: [],
      days: [],
      settings: { mode: 'add', roundSeconds: 120, targetMs: 3000 },
    };
  }

  function hydrate(raw) {
    const base = newState();
    if (!raw || typeof raw !== 'object') return base;
    return {
      ...base,
      facts: raw.facts && typeof raw.facts === 'object' ? raw.facts : {},
      history: Array.isArray(raw.history) ? raw.history : [],
      days: Array.isArray(raw.days) ? raw.days : [],
      settings: { ...base.settings, ...raw.settings },
    };
  }

  function statusOf(rec) {
    if (!rec || rec.seen === 0) return 'new';
    if (rec.box < FIRST_FLUENT_BOX) return 'learning';
    if (rec.box < TOP_BOX) return 'fluent';
    return 'mastered';
  }

  function timeoutFor(targetMs) {
    return Math.max(5000, targetMs * 2.5);
  }

  function recordAnswer(state, key, { correct, ms }, now) {
    const prev = state.facts[key] || {
      box: 0, seen: 0, correct: 0, misses: 0, lastMs: 0, lastAt: 0, dueAt: 0,
    };
    const before = statusOf(prev);
    const isNew = prev.seen === 0;
    const wasDue = now >= prev.dueAt;
    const fast = correct && ms <= state.settings.targetMs;
    const rec = { ...prev, seen: prev.seen + 1, lastAt: now, lastMs: ms };

    if (!correct) {
      rec.misses += 1;
      rec.box = isNew ? 1 : Math.max(1, prev.box - 2);
      rec.dueAt = now;
    } else {
      rec.correct += 1;
      if (isNew) {
        // Already-known facts skip the learning stage.
        rec.box = fast ? FIRST_FLUENT_BOX : 1;
        rec.dueAt = now + INTERVALS[rec.box];
      } else if (wasDue) {
        if (fast) rec.box = Math.min(TOP_BOX, prev.box + 1);
        else if (prev.box > 2) rec.box = prev.box - 1;
        rec.dueAt = now + INTERVALS[rec.box];
      }
      // Extra practice before a fact is due leaves its schedule alone.
    }

    state.facts[key] = rec;
    return { before, after: statusOf(rec), fast };
  }

  function oldestFirst(state) {
    return (p, q) => state.facts[p.key].lastAt - state.facts[q.key].lastAt;
  }

  function pickNext(state, ops, recent = [], now = Date.now(), rng = Math.random) {
    const recentKeys = new Set(recent);
    const fresh = [];
    const learning = [];
    const reviews = [];
    const waiting = [];

    for (const op of ops) {
      for (const fact of allFacts(op)) {
        const rec = state.facts[fact.key];
        if (!rec || rec.seen === 0) fresh.push(fact);
        else if (rec.box < FIRST_FLUENT_BOX) learning.push(fact);
        else if (now >= rec.dueAt) reviews.push(fact);
        else waiting.push(fact);
      }
    }

    const notRecent = (f) => !recentKeys.has(f.key);
    const openLearning = learning.filter(notRecent).sort((p, q) => {
      const boxGap = state.facts[p.key].box - state.facts[q.key].box;
      return boxGap || oldestFirst(state)(p, q);
    });
    const openReviews = reviews.filter(notRecent).sort(oldestFirst(state));
    const nextReview = () =>
      openReviews[Math.floor(rng() * Math.min(8, openReviews.length))];
    const nextFresh = () => {
      const heads = ops
        .map((op) => fresh.find((f) => f.op === op))
        .filter(Boolean);
      return heads[Math.floor(rng() * heads.length)];
    };

    if (learning.length >= MAX_ACTIVE) {
      if (openLearning.length && (!openReviews.length || rng() < 0.75)) {
        return openLearning[0];
      }
      if (openReviews.length) return nextReview();
    } else {
      if (openReviews.length && (!fresh.length || rng() < 0.5)) return nextReview();
      if (fresh.length) return nextFresh();
      if (openLearning.length) return openLearning[0];
    }

    // Nothing is due, so keep practicing whatever comes up soonest.
    const soonest = waiting
      .filter(notRecent)
      .sort((p, q) => state.facts[p.key].dueAt - state.facts[q.key].dueAt);
    if (soonest.length) return soonest[0];

    const pool = ops.flatMap(allFacts);
    const anyOpen = pool.filter(notRecent);
    const choices = anyOpen.length ? anyOpen : pool;
    return choices[Math.floor(rng() * choices.length)];
  }

  function opProgress(state, op) {
    const counts = { new: 0, learning: 0, fluent: 0, mastered: 0, total: 0 };
    for (const fact of allFacts(op)) {
      counts[statusOf(state.facts[fact.key])] += 1;
      counts.total += 1;
    }
    return counts;
  }

  function median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function summarizeRound(answers, targetMs) {
    const right = answers.filter((a) => a.correct);
    return {
      total: answers.length,
      correct: right.length,
      fast: right.filter((a) => a.ms <= targetMs).length,
      medianMs: median(right.map((a) => a.ms)),
    };
  }

  function toDayNumber(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return Math.round(Date.UTC(y, m - 1, d) / DAY);
  }

  function markPracticed(state, today) {
    if (!state.days.includes(today)) state.days.push(today);
  }

  // A streak survives until a full day is missed, so it still shows
  // in the morning before today's practice.
  function streak(days, today) {
    const practiced = new Set(days.map(toDayNumber));
    let day = toDayNumber(today);
    if (!practiced.has(day)) day -= 1;
    let count = 0;
    while (practiced.has(day)) {
      count += 1;
      day -= 1;
    }
    return count;
  }

  return {
    OPS, OP_KEYS, MAX, DAY, INTERVALS, TOP_BOX, MAX_ACTIVE, RECENT_WINDOW,
    allFacts, answerOf, promptOf, factText, factFromKey,
    newState, hydrate, statusOf, timeoutFor, recordAnswer, pickNext,
    opProgress, summarizeRound, markPracticed, streak,
  };
});
