import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capitalize } from '../src/capitalize.js';

test('capitalize upper-cases the first character only', () => {
  assert.equal(capitalize('hello world'), 'Hello world');
  assert.equal(capitalize('Already'), 'Already');
});

test('capitalize leaves an empty string alone', () => {
  assert.equal(capitalize(''), '');
});

test('capitalize refuses anything but a string', () => {
  assert.throws(() => capitalize(42), TypeError);
});
