// capitalize(text): the text with its first character in upper case.
export function capitalize(text) {
  if (typeof text !== 'string') throw new TypeError('capitalize expects a string');
  return text.length ? text[0].toUpperCase() + text.slice(1) : text;
}
