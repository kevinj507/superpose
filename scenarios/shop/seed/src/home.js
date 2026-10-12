// The home page: homePage() is the shop's front page.
import { layout } from './render.js';

export function homePage() {
  return layout('Tiny Shop', '<h1>Tiny Shop</h1>\n<p>Welcome! Our products will be listed here soon.</p>');
}
