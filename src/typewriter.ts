/**
 * Reveals text one character at a time into `target`, with a caret that stops
 * blinking once the line is finished.
 *
 * @param target     element to type into
 * @param text       the full string
 * @param speed      ms per character
 * @param startDelay ms before the first character
 */
export function typewriter(target: HTMLElement, text: string, speed = 38, startDelay = 600) {
  const caret = document.createElement('span');
  caret.className = 'caret';
  caret.setAttribute('aria-hidden', 'true');

  const output = document.createElement('span');

  // The full string is in the DOM for assistive tech and for anyone with
  // reduced motion; only the visible span is revealed gradually.
  target.setAttribute('aria-label', text);
  target.replaceChildren(output, caret);

  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    output.textContent = text;
    caret.remove();
    return;
  }

  let index = 0;
  window.setTimeout(() => {
    const id = window.setInterval(() => {
      index += 1;
      output.textContent = text.slice(0, index);
      if (index >= text.length) {
        window.clearInterval(id);
        caret.classList.add('is-done');
      }
    }, speed);
  }, startDelay);
}
