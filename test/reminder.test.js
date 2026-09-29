'use strict';

const test = require('node:test');
const assert = require('node:assert');

const reminder = require('../src/reminder.js');

const at = (y, m, d, h, min) => new Date(y, m - 1, d, h, min, 0, 0);

test('times are read as HH:MM and nothing else', () => {
  assert.deepStrictEqual(reminder.parseTime('22:00'), { hour: 22, minute: 0 });
  assert.deepStrictEqual(reminder.parseTime('00:05'), { hour: 0, minute: 5 });
  for (const bad of ['24:00', '22:60', '9:05', '', null, 'bedtime', '22:00:00']) {
    assert.strictEqual(reminder.parseTime(bad), null, String(bad));
  }
});

test('a hand-edited time is tidied, and a broken one falls back', () => {
  assert.strictEqual(reminder.normaliseTime('9:05'), '09:05');
  assert.strictEqual(reminder.normaliseTime(' 21:30 '), '21:30');
  assert.strictEqual(reminder.normaliseTime('25:00', '21:00'), '21:00');
  assert.strictEqual(reminder.normaliseTime(undefined), reminder.DEFAULT_TIME);
});

test('the next reminder is later today until it has passed, then tomorrow', () => {
  assert.deepStrictEqual(reminder.nextAt(at(2026, 9, 28, 18, 0), '22:00'), at(2026, 9, 28, 22, 0));
  assert.deepStrictEqual(reminder.nextAt(at(2026, 9, 28, 22, 0), '22:00'), at(2026, 9, 29, 22, 0));
  assert.deepStrictEqual(reminder.nextAt(at(2026, 9, 28, 23, 10), '22:00'), at(2026, 9, 29, 22, 0));
});

test('upcoming reminders run one per evening across a month end', () => {
  const list = reminder.upcoming(at(2026, 9, 29, 23, 0), '21:45', 3);
  assert.deepStrictEqual(list, [at(2026, 9, 30, 21, 45), at(2026, 10, 1, 21, 45), at(2026, 10, 2, 21, 45)]);
});

test('a reminder after midnight is about the evening before', () => {
  assert.strictEqual(reminder.dayFor(at(2026, 9, 29, 1, 0), 4), '2026-09-28');
  assert.strictEqual(reminder.dayFor(at(2026, 9, 29, 1, 0), 0), '2026-09-29');
  assert.strictEqual(reminder.dayFor(at(2026, 9, 28, 22, 0), 4), '2026-09-28');
});
