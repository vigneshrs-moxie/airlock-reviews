// What GitHub's Files changed page does to its own diff after it has loaded, acted out on a fixture page (classic or newer
// view) for the tests: a file that loads late, a file whose rows are rendered again, and the switch to the split layout.
// Run in the page itself after the fixture has loaded and before Airlock adds anything, so the copies it keeps are
// GitHub's rows as served. Sets window.githubFixture. Placeholder behaviour, not GitHub's code.
(() => {
  const served = new Map();
  for (const file of document.querySelectorAll('[id^="diff-"]')) served.set(file.id, file.cloneNode(true));
  const placeholders = new Map();
  const isNumber = (cell) => /\b(blob-num|diff-line-number)\b/.test(cell.className);
  const hasNumber = (cell) => cell.hasAttribute('data-line-number') || cell.textContent.trim() !== '';
  const emptyLike = (cell) => {
    const empty = cell.cloneNode(false);
    empty.removeAttribute('id');
    empty.removeAttribute('data-line-number');
    return empty;
  };

  window.githubFixture = {
    /** Takes a file off the page, as GitHub has it before the person scrolls to it. */
    unload(anchor) {
      const file = document.getElementById(anchor);
      const mark = document.createComment(`not loaded: ${anchor}`);
      file.replaceWith(mark);
      placeholders.set(anchor, mark);
    },
    /** Renders a file that was taken off, fresh, where it was. */
    load(anchor) {
      placeholders.get(anchor).replaceWith(served.get(anchor).cloneNode(true));
      placeholders.delete(anchor);
    },
    /** Renders a file's rows again: every row is a new element, and anything else in its table is gone. */
    rerender(anchor) {
      const body = document.getElementById(anchor).querySelector('tbody');
      body.replaceWith(served.get(anchor).querySelector('tbody').cloneNode(true));
    },
    /** Shows every file in the split layout: old number, old code, new number, new code. Rendered anew. */
    split() {
      for (const body of document.querySelectorAll('[id^="diff-"] tbody')) {
        const fresh = body.cloneNode(false);
        for (const row of body.querySelectorAll(':scope > tr')) {
          if (row.hasAttribute('data-airlock-note')) continue;
          const cells = [...row.children];
          const copy = row.cloneNode(false);
          if (cells.length === 3 && isNumber(cells[0]) && isNumber(cells[1])) {
            const [oldNumber, newNumber, code] = cells;
            const side = (number) => (hasNumber(number) ? code.cloneNode(true) : emptyLike(code));
            copy.append(oldNumber.cloneNode(true), side(oldNumber), newNumber.cloneNode(true), side(newNumber));
          } else {
            for (const cell of cells) copy.append(cell.cloneNode(true));
            const last = copy.lastElementChild;
            if (last !== null) last.colSpan += 1;
          }
          fresh.append(copy);
        }
        body.replaceWith(fresh);
      }
    },
  };
})();
