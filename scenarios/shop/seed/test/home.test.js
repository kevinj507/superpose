import assert from 'node:assert/strict';
import { test } from 'node:test';
import { homePage } from '../src/home.js';

test('the home page is the shop\'s front page', () => {
  const html = homePage();
  assert.match(html, /<title>Tiny Shop<\/title>/);
  assert.match(html, /<h1>Tiny Shop<\/h1>/);
});
