const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../engine.js');

const NOW = 1_800_000_000_000;
const FAST = 1000;
const SLOW = 4500;

function seeded(seed = 1) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

test('generates the expected number of unique facts', () => {
  assert.equal(E.allFacts('add').length, 169);
  assert.equal(E.allFacts('sub').length, 169);
  assert.equal(E.allFacts('mul').length, 169);
  assert.equal(E.allFacts('div').length, 156);
  for (const op of E.OP_KEYS) {
    const keys = E.allFacts(op).map((f) => f.key);
    assert.equal(new Set(keys).size, keys.length);
  }
});

test('every displayed fact is arithmetically true', () => {
  for (const op of E.OP_KEYS) {
    for (const fact of E.allFacts(op)) {
      const { left, right } = E.promptOf(fact);
      const answer = E.answerOf(fact);
      assert.ok(Number.isInteger(answer) && answer >= 0, fact.key);
      if (op === 'add') assert.equal(left + right, answer);
      if (op === 'sub') assert.equal(left - right, answer);
      if (op === 'mul') assert.equal(left * right, answer);
      if (op === 'div') assert.equal(left / right, answer);
    }
  }
});

test('key round-trips through factFromKey', () => {
  const fact = E.allFacts('div')[20];
  assert.deepEqual(E.factFromKey(fact.key), fact);
});

test('a new fact answered fast is immediately fluent', () => {
  const s = E.newState();
  const out = E.recordAnswer(s, 'add:3:4', { correct: true, ms: FAST }, NOW);
  assert.deepEqual([out.before, out.after], ['new', 'fluent']);
  assert.equal(s.facts['add:3:4'].dueAt, NOW + E.DAY);
});

test('a new fact answered slowly or wrong goes to learning', () => {
  const s = E.newState();
  E.recordAnswer(s, 'add:3:4', { correct: true, ms: SLOW }, NOW);
  E.recordAnswer(s, 'add:3:5', { correct: false, ms: FAST }, NOW);
  assert.equal(E.statusOf(s.facts['add:3:4']), 'learning');
  assert.equal(E.statusOf(s.facts['add:3:5']), 'learning');
});

test('learning facts graduate after two fast answers', () => {
  const s = E.newState();
  E.recordAnswer(s, 'mul:7:8', { correct: false, ms: FAST }, NOW);
  E.recordAnswer(s, 'mul:7:8', { correct: true, ms: FAST }, NOW + 1);
  assert.equal(E.statusOf(s.facts['mul:7:8']), 'learning');
  const out = E.recordAnswer(s, 'mul:7:8', { correct: true, ms: FAST }, NOW + 2);
  assert.equal(out.after, 'fluent');
});

test('a slow answer does not advance a learning fact', () => {
  const s = E.newState();
  E.recordAnswer(s, 'mul:7:8', { correct: false, ms: FAST }, NOW);
  E.recordAnswer(s, 'mul:7:8', { correct: true, ms: SLOW }, NOW + 1);
  assert.equal(s.facts['mul:7:8'].box, 1);
});

test('a miss demotes a fluent fact by two boxes, never below 1', () => {
  const s = E.newState();
  s.facts.x = { box: 5, seen: 5, correct: 5, misses: 0, lastMs: 0, lastAt: 0, dueAt: 0 };
  E.recordAnswer(s, 'x', { correct: false, ms: FAST }, NOW);
  assert.equal(s.facts.x.box, 3);
  s.facts.y = { box: 2, seen: 2, correct: 2, misses: 0, lastMs: 0, lastAt: 0, dueAt: 0 };
  E.recordAnswer(s, 'y', { correct: false, ms: FAST }, NOW);
  assert.equal(s.facts.y.box, 1);
});

test('answering before a fact is due does not advance it', () => {
  const s = E.newState();
  E.recordAnswer(s, 'add:3:4', { correct: true, ms: FAST }, NOW);
  const { box, dueAt } = s.facts['add:3:4'];
  E.recordAnswer(s, 'add:3:4', { correct: true, ms: FAST }, NOW + 1000);
  assert.equal(s.facts['add:3:4'].box, box);
  assert.equal(s.facts['add:3:4'].dueAt, dueAt);
});

test('mastery requires reviews spread across days', () => {
  const s = E.newState();
  let now = NOW;
  let out = E.recordAnswer(s, 'add:3:4', { correct: true, ms: FAST }, now);
  for (let i = 0; i < 3; i++) {
    now = s.facts['add:3:4'].dueAt;
    out = E.recordAnswer(s, 'add:3:4', { correct: true, ms: FAST }, now);
  }
  assert.equal(out.after, 'mastered');
  assert.ok(now - NOW >= 11 * E.DAY);
});

test('never holds more than the maximum number of learning facts', () => {
  const s = E.newState();
  const recent = [];
  const rng = seeded(7);
  for (let i = 0; i < 300; i++) {
    const fact = E.pickNext(s, ['mul'], recent, NOW + i, rng);
    E.recordAnswer(s, fact.key, { correct: false, ms: FAST }, NOW + i);
    recent.push(fact.key);
    if (recent.length > E.RECENT_WINDOW) recent.shift();
    const learning = Object.values(s.facts).filter((r) => E.statusOf(r) === 'learning');
    assert.ok(learning.length <= E.MAX_ACTIVE, `step ${i}: ${learning.length}`);
  }
});

test('does not repeat a fact within the recent window', () => {
  const s = E.newState();
  const history = [];
  const rng = seeded(11);
  for (let i = 0; i < 400; i++) {
    const fact = E.pickNext(s, ['add'], history.slice(-E.RECENT_WINDOW), NOW + i, rng);
    assert.ok(!history.slice(-E.RECENT_WINDOW).includes(fact.key), `step ${i}`);
    const correct = rng() > 0.25;
    E.recordAnswer(s, fact.key, { correct, ms: rng() > 0.4 ? FAST : SLOW }, NOW + i);
    history.push(fact.key);
  }
});

test('a perfect student reaches every fact in a single pass', () => {
  for (const op of E.OP_KEYS) {
    const s = E.newState();
    const total = E.allFacts(op).length;
    const recent = [];
    const rng = seeded(3);
    for (let i = 0; i < total; i++) {
      const fact = E.pickNext(s, [op], recent, NOW, rng);
      E.recordAnswer(s, fact.key, { correct: true, ms: FAST }, NOW);
      recent.push(fact.key);
      if (recent.length > E.RECENT_WINDOW) recent.shift();
    }
    assert.equal(E.opProgress(s, op).fluent, total, op);
  }
});

test('due reviews get picked', () => {
  const s = E.newState();
  for (const f of E.allFacts('add')) {
    E.recordAnswer(s, f.key, { correct: true, ms: FAST }, NOW);
  }
  const picked = E.pickNext(s, ['add'], [], NOW + 2 * E.DAY, seeded(5));
  assert.ok(E.allFacts('add').some((f) => f.key === picked.key));
  E.recordAnswer(s, picked.key, { correct: true, ms: FAST }, NOW + 2 * E.DAY);
  assert.equal(s.facts[picked.key].box, 4);
});

test('mixed practice can draw from every operation', () => {
  const s = E.newState();
  const rng = seeded(9);
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const f = E.pickNext(s, E.OP_KEYS, [], NOW, rng);
    seen.add(f.op);
    E.recordAnswer(s, f.key, { correct: true, ms: FAST }, NOW);
  }
  assert.equal(seen.size, 4);
});

test('summarizeRound counts results and uses correct answers for the median', () => {
  const result = E.summarizeRound(
    [
      { correct: true, ms: 1000 },
      { correct: true, ms: 2000 },
      { correct: true, ms: 5000 },
      { correct: false, ms: 9000 },
    ],
    3000,
  );
  assert.deepEqual(result, { total: 4, correct: 3, fast: 2, medianMs: 2000 });
});

test('streak counts consecutive days and tolerates not having practiced yet today', () => {
  const days = ['2026-02-27', '2026-02-28', '2026-03-01'];
  assert.equal(E.streak(days, '2026-03-01'), 3);
  assert.equal(E.streak(days, '2026-03-02'), 3);
  assert.equal(E.streak(days, '2026-03-03'), 0);
  assert.equal(E.streak([], '2026-03-03'), 0);
});

test('hydrate tolerates missing or malformed saved data', () => {
  assert.deepEqual(E.hydrate(null), E.newState());
  assert.deepEqual(E.hydrate({ facts: 3, days: 'x' }), E.newState());
  const restored = E.hydrate({ settings: { targetMs: 2000 } });
  assert.equal(restored.settings.targetMs, 2000);
  assert.equal(restored.settings.roundSeconds, 120);
});
