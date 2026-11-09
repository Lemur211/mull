(function () {
  'use strict';

  const E = window.MullEngine;
  const STORAGE_KEY = 'mull.state.v1';
  const RIGHT_FLASH_MS = 130;
  const LENGTHS = [[60, '1 min'], [120, '2 min'], [180, '3 min'], [300, '5 min']];
  const TARGETS = [[2000, '2 s'], [3000, '3 s'], [4000, '4 s'], [6000, '6 s']];
  const TILE_LABELS = { add: 'Add', sub: 'Subtract', mul: 'Multiply', div: 'Divide' };

  const $ = (selector) => document.querySelector(selector);
  const screens = { home: $('#home'), round: $('#round'), summary: $('#summary') };

  let state = load();
  let round = null;

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? E.hydrate(JSON.parse(raw)) : E.newState();
    } catch {
      return E.newState();
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Practice still works for this visit if storage is unavailable.
    }
  }

  function localDay(date = new Date()) {
    return date.toLocaleDateString('en-CA');
  }

  function showScreen(name) {
    for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
    window.scrollTo(0, 0);
  }

  function opsForMode(mode) {
    return mode === 'mix' ? E.OP_KEYS : [mode];
  }

  /* ---------- Home ---------- */

  function combinedProgress(ops) {
    const sum = { new: 0, learning: 0, fluent: 0, mastered: 0, total: 0 };
    for (const op of ops) {
      const part = E.opProgress(state, op);
      for (const key of Object.keys(sum)) sum[key] += part[key];
    }
    return sum;
  }

  function modeTile(mode, symbol, name) {
    const p = combinedProgress(opsForMode(mode));
    const pct = (n) => (100 * n) / p.total;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mode';
    button.setAttribute('aria-pressed', String(state.settings.mode === mode));
    button.innerHTML = `
      <span class="mode-symbol" aria-hidden="true">${symbol}</span>
      <span class="mode-name">${name}</span>
      <span class="meter" aria-hidden="true">
        <i class="mastered" style="width:${pct(p.mastered)}%"></i>
        <i class="fluent" style="width:${pct(p.fluent)}%"></i>
        <i class="learning" style="width:${pct(p.learning)}%"></i>
      </span>
      <span class="mode-count">${p.fluent + p.mastered} / ${p.total}</span>`;
    button.addEventListener('click', () => {
      state.settings.mode = mode;
      save();
      renderHome();
    });
    return button;
  }

  function renderSegments(host, options, current, onPick) {
    host.replaceChildren(
      ...options.map(([value, label]) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.setAttribute('aria-pressed', String(value === current));
        button.addEventListener('click', () => onPick(value));
        return button;
      }),
    );
  }

  function cell(className, text, title) {
    const el = document.createElement('div');
    el.className = `cell ${className}`;
    el.textContent = text;
    if (title) el.title = title;
    return el;
  }

  function factGrid(op, showTitle) {
    const wrap = document.createElement('div');
    if (showTitle) {
      const title = document.createElement('h3');
      title.className = 'grid-title';
      title.textContent = E.OPS[op].name;
      wrap.append(title);
    }

    const grid = document.createElement('div');
    grid.className = 'fact-grid';
    grid.setAttribute('role', 'img');
    const p = E.opProgress(state, op);
    grid.setAttribute(
      'aria-label',
      `${E.OPS[op].name}: ${p.mastered} mastered, ${p.fluent} fluent, ${p.learning} learning, ${p.new} not yet practiced.`,
    );

    const lookup = new Map(E.allFacts(op).map((f) => [`${f.x}:${f.y}`, f]));
    const firstRow = op === 'div' ? 1 : 0;

    grid.append(cell('axis', E.OPS[op].symbol));
    for (let x = 0; x <= E.MAX; x++) grid.append(cell('axis', x));
    for (let y = firstRow; y <= E.MAX; y++) {
      grid.append(cell('axis', y));
      for (let x = 0; x <= E.MAX; x++) {
        const fact = lookup.get(`${x}:${y}`);
        const status = E.statusOf(state.facts[fact.key]);
        grid.append(cell(status, status === 'new' ? '' : E.answerOf(fact), E.factText(fact)));
      }
    }
    wrap.append(grid);
    return wrap;
  }

  function renderHome() {
    const days = E.streak(state.days, localDay());
    $('#streak').textContent = days > 0 ? `${days} day streak` : '';

    const mode = state.settings.mode;
    $('#modes').replaceChildren(
      ...E.OP_KEYS.map((op) => modeTile(op, E.OPS[op].symbol, TILE_LABELS[op])),
      modeTile('mix', '∗', 'Mixed'),
    );

    renderSegments($('#length'), LENGTHS, state.settings.roundSeconds, (value) => {
      state.settings.roundSeconds = value;
      save();
      renderHome();
    });
    renderSegments($('#target'), TARGETS, state.settings.targetMs, (value) => {
      state.settings.targetMs = value;
      save();
      renderHome();
    });

    const ops = opsForMode(mode);
    $('#grids').replaceChildren(...ops.map((op) => factGrid(op, ops.length > 1)));
  }

  /* ---------- Round ---------- */

  function startRound() {
    const durationMs = state.settings.roundSeconds * 1000;
    round = {
      ops: opsForMode(state.settings.mode),
      durationMs,
      endsAt: Date.now() + durationMs,
      recent: [],
      answers: [],
      gained: new Set(),
      missed: new Set(),
      fact: null,
      phase: 'ask',
      buffer: '',
      locked: false,
      askedAt: 0,
      deadline: 0,
      questionTimer: null,
      hiddenAt: 0,
      rightStreak: 0,
    };
    showScreen('round');
    nextQuestion();
    requestAnimationFrame(tick);
  }

  function armQuestion() {
    clearTimeout(round.questionTimer);
    if (document.hidden) return;
    const timeout = E.timeoutFor(state.settings.targetMs);
    round.askedAt = performance.now();
    round.deadline = round.askedAt + timeout;
    round.questionTimer = setTimeout(onQuestionTimeout, timeout);
  }

  function nextQuestion() {
    const fact = E.pickNext(state, round.ops, round.recent, Date.now());
    round.fact = fact;
    round.recent.push(fact.key);
    if (round.recent.length > E.RECENT_WINDOW) round.recent.shift();
    round.phase = 'ask';
    round.buffer = '';
    round.locked = false;

    const prompt = E.promptOf(fact);
    $('#left').textContent = prompt.left;
    $('#symbol').textContent = prompt.symbol;
    $('#right').textContent = prompt.right;
    $('#equation').className = 'equation';
    $('#hint').className = 'hint';
    $('#hint').textContent = '';
    renderEntry();
    armQuestion();
  }

  function renderEntry() {
    $('#entry').textContent = round.buffer || ' ';
    $('#score').textContent = `${round.answers.filter((a) => a.correct).length} right`;
  }

  function pressDigit(digit) {
    if (!round || round.locked) return;
    round.buffer += digit;
    renderEntry();
    if (round.buffer.length === String(E.answerOf(round.fact)).length) submit();
  }

  function pressBackspace() {
    if (!round || round.locked) return;
    round.buffer = round.buffer.slice(0, -1);
    renderEntry();
  }

  function submit() {
    const isRight = Number(round.buffer) === E.answerOf(round.fact);
    if (round.phase === 'ask') {
      recordResult(isRight, performance.now() - round.askedAt);
    } else if (isRight) {
      flashThenNext();
    } else {
      round.buffer = '';
      renderEntry();
      const equation = $('#equation');
      equation.classList.remove('shake');
      void equation.offsetWidth;
      equation.classList.add('shake');
    }
  }

  function recordResult(correct, ms) {
    clearTimeout(round.questionTimer);
    const { fact } = round;
    const outcome = E.recordAnswer(state, fact.key, { correct, ms }, Date.now());
    round.answers.push({ key: fact.key, correct, ms });
    if (['new', 'learning'].includes(outcome.before) && ['fluent', 'mastered'].includes(outcome.after)) {
      round.gained.add(fact.key);
    }
    if (correct) {
      flashThenNext();
    } else {
      round.missed.add(fact.key);
      round.gained.delete(fact.key);
      beginCorrection('Type the answer to continue');
    }
    save();
  }

  function flashThenNext() {
    const current = round;
    current.locked = true;
    $('#equation').classList.remove('fix', 'shake');
    $('#equation').classList.add('right');
    $('#hint').className = 'hint';
    $('#hint').textContent = '';
    renderEntry();
    setTimeout(() => {
      if (round === current) nextQuestion();
    }, RIGHT_FLASH_MS);
  }

  function beginCorrection(message) {
    const answer = E.answerOf(round.fact);
    round.phase = 'fix';
    round.buffer = '';
    round.deadline = 0;
    $('#equation').classList.add('fix');
    $('#hint').className = 'hint fix';
    $('#hint').textContent = `${E.factText(round.fact)}. ${message}`;
    $('#entry').textContent = answer;
    // Keep the answer visible until the first digit is typed.
    $('#score').textContent = `${round.answers.filter((a) => a.correct).length} right`;
  }

  function onQuestionTimeout() {
    if (!round || round.phase !== 'ask' || round.locked) return;
    recordResult(false, E.timeoutFor(state.settings.targetMs));
  }

  function tick() {
    if (!round) return;
    const remaining = round.endsAt - Date.now();
    if (remaining <= 0 && !round.hiddenAt) {
      finishRound();
      return;
    }

    $('#clock-fill').style.width = `${(100 * Math.max(0, remaining)) / round.durationMs}%`;
    const seconds = Math.ceil(Math.max(0, remaining) / 1000);
    $('#clock-text').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

    const paceFill = $('#pace-fill');
    if (round.phase === 'ask' && round.deadline && !round.locked) {
      const timeout = E.timeoutFor(state.settings.targetMs);
      const elapsed = performance.now() - round.askedAt;
      paceFill.style.width = `${Math.max(0, 100 * (1 - elapsed / timeout))}%`;
      paceFill.classList.toggle('late', elapsed > state.settings.targetMs);
    } else if (round.phase === 'fix') {
      paceFill.style.width = '0%';
    }

    requestAnimationFrame(tick);
  }

  function endRoundEarly() {
    if (round) finishRound();
  }

  function finishRound() {
    clearTimeout(round.questionTimer);
    const finished = round;
    round = null;

    if (!finished.answers.length) {
      renderHome();
      showScreen('home');
      return;
    }

    const result = E.summarizeRound(finished.answers, state.settings.targetMs);
    state.history.push({ at: Date.now(), mode: state.settings.mode, ...result });
    if (state.history.length > 365) state.history.shift();
    E.markPracticed(state, localDay());
    save();
    renderSummary(result, finished);
    showScreen('summary');
  }

  document.addEventListener('visibilitychange', () => {
    if (!round) return;
    if (document.hidden) {
      clearTimeout(round.questionTimer);
      round.hiddenAt = Date.now();
    } else if (round.hiddenAt) {
      // Time away from the tab doesn't count against the round or the question.
      round.endsAt += Date.now() - round.hiddenAt;
      round.hiddenAt = 0;
      if (round.phase === 'ask' && !round.locked) {
        round.buffer = '';
        renderEntry();
        armQuestion();
      }
    }
  });

  /* ---------- Summary ---------- */

  function chipList(heading, kind, keys) {
    const section = document.createElement('section');
    const title = document.createElement('h2');
    title.className = 'label';
    title.textContent = heading;
    const list = document.createElement('ul');
    list.className = `chips ${kind}`;
    for (const key of keys) {
      const item = document.createElement('li');
      item.textContent = E.factText(E.factFromKey(key));
      list.append(item);
    }
    section.append(title, list);
    return section;
  }

  function headline(result) {
    if (result.correct === result.total && result.fast === result.total) return 'Clean round.';
    if (result.correct === result.total) return 'All correct.';
    if (result.correct / result.total >= 0.8) return 'Nicely done.';
    return 'Good reps.';
  }

  function renderSummary(result, finished) {
    $('#summary-title').textContent = headline(result);
    const stats = [
      ['Correct', `${result.correct}/${result.total}`],
      ['Under target', result.fast],
      ['Typical answer', result.correct ? `${(result.medianMs / 1000).toFixed(1)}s` : '–'],
      ['Newly fluent', finished.gained.size],
    ];
    $('#stats').replaceChildren(
      ...stats.map(([label, value]) => {
        const row = document.createElement('div');
        const dt = document.createElement('dt');
        const dd = document.createElement('dd');
        dt.textContent = label;
        dd.textContent = value;
        row.append(dt, dd);
        return row;
      }),
    );

    const lists = [];
    if (finished.missed.size) lists.push(chipList('Keep working on', 'work', finished.missed));
    if (finished.gained.size) lists.push(chipList('Newly fluent', 'good', finished.gained));
    $('#summary-lists').replaceChildren(...lists);
  }

  /* ---------- Input and wiring ---------- */

  function buildKeypad() {
    const keypad = $('#keypad');
    const add = (label, onPress, className) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      if (className) button.className = className;
      button.addEventListener('click', onPress);
      keypad.append(button);
      return button;
    };
    for (let digit = 1; digit <= 9; digit++) add(digit, () => pressDigit(String(digit)));
    add('0', () => pressDigit('0'), 'zero');
    add('⌫', pressBackspace).setAttribute('aria-label', 'Backspace');
  }

  document.addEventListener('keydown', (event) => {
    if (!round || event.ctrlKey || event.metaKey || event.altKey) return;
    if (/^[0-9]$/.test(event.key)) {
      event.preventDefault();
      if (!event.repeat) pressDigit(event.key);
    } else if (event.key === 'Backspace') {
      event.preventDefault();
      pressBackspace();
    } else if (event.key === 'Escape') {
      endRoundEarly();
    }
  });

  function goHome() {
    renderHome();
    showScreen('home');
  }

  $('#start').addEventListener('click', startRound);
  $('#again').addEventListener('click', startRound);
  $('#done').addEventListener('click', goHome);
  $('#end').addEventListener('click', endRoundEarly);
  $('#reset').addEventListener('click', () => {
    if (window.confirm('Erase all of your Mull progress on this device? This cannot be undone.')) {
      const { settings } = state;
      state = { ...E.newState(), settings };
      save();
      renderHome();
    }
  });

  buildKeypad();
  renderHome();
})();
