import { describe, expect, it } from 'vitest';
import { spatialStep, type NavRect } from '../../../src/a10/ui/spatialNav';
import { groupControls, keepDesignators, keyCaps } from '../../../src/a10/ui/ControlsReference';
import { hiddenEdges } from '../../../src/a10/ui/TableWrap';

const rect = (left: number, top: number, width = 100, height = 40): NavRect => ({
  left,
  top,
  width,
  height,
});

describe('menu arrow-key navigation', () => {
  // a desktop list: one entry per row
  const list = [rect(0, 0), rect(0, 50), rect(0, 100), rect(0, 150)];

  it('a list: down and up step through it and wrap', () => {
    expect(spatialStep(list, 0, 'ArrowDown')).toBe(1);
    expect(spatialStep(list, 3, 'ArrowDown')).toBe(0);
    expect(spatialStep(list, 0, 'ArrowUp')).toBe(3);
    // left / right in a one-column list walk the order too
    expect(spatialStep(list, 1, 'ArrowRight')).toBe(2);
    expect(spatialStep(list, 1, 'ArrowLeft')).toBe(0);
  });

  it('nothing focused: forward keys land on the first entry, backward on the last', () => {
    expect(spatialStep(list, -1, 'ArrowDown')).toBe(0);
    expect(spatialStep(list, -1, 'ArrowUp')).toBe(3);
    expect(spatialStep([], -1, 'ArrowDown')).toBe(-1);
  });

  // the phone sheet: a wide entry, then two rows of three tiles
  const sheet = [
    rect(0, 0, 330, 50),
    rect(0, 60),
    rect(115, 60),
    rect(230, 60),
    rect(0, 110),
    rect(115, 110),
    rect(230, 110),
  ];

  it('a sheet of tiles: down keeps the column, right walks the row', () => {
    expect(spatialStep(sheet, 0, 'ArrowDown')).toBe(2); // the tile nearest the wide entry's centre
    expect(spatialStep(sheet, 3, 'ArrowDown')).toBe(6);
    expect(spatialStep(sheet, 6, 'ArrowDown')).toBe(0); // wraps to the top row
    expect(spatialStep(sheet, 4, 'ArrowUp')).toBe(1);
    expect(spatialStep(sheet, 1, 'ArrowUp')).toBe(0);
    expect(spatialStep(sheet, 1, 'ArrowRight')).toBe(2);
    expect(spatialStep(sheet, 3, 'ArrowRight')).toBe(4); // end of the row: next in order
    expect(spatialStep(sheet, 4, 'ArrowLeft')).toBe(3);
  });
});

describe('controls reference', () => {
  it('groups rows in order of first appearance', () => {
    const groups = groupControls([
      { group: 'Stick', action: 'a', keyboard: '1', gamepad: '' },
      { group: 'Throttle', action: 'b', keyboard: '2', gamepad: '' },
      { group: 'Stick', action: 'c', keyboard: '3', gamepad: '' },
      { group: '', action: 'd', keyboard: '4', gamepad: '' },
    ]);
    expect(groups.map((g) => g.group)).toEqual(['Stick', 'Throttle', 'Other']);
    expect(groups[0].rows.map((r) => r.action)).toEqual(['a', 'c']);
  });

  it('splits key labels into caps', () => {
    expect(keyCaps('Page Up / Page Down')).toEqual(['Page Up', 'Page Down']);
    expect(keyCaps('1, 2, 3, 4, or click')).toEqual(['1', '2', '3', '4', 'click']);
    expect(keyCaps('Ctrl + arrow keys')).toEqual(['Ctrl + arrow keys']);
    expect(keyCaps('[ / ]')).toEqual(['[', ']']);
    // two keys bound to one control (a rebinding added J): the checklist strip shows two caps
    expect(keyCaps('1 / J')).toEqual(['1', 'J']);
    expect(keyCaps('—')).toEqual([]);
  });

  it('never breaks a line inside a designator such as PAC-1', () => {
    expect(keepDesignators('Trigger: first detent (PAC-1)')).toBe(
      'Trigger: first detent (PAC\u20111)',
    );
    expect(keepDesignators('GBU-12 and AGM-65D')).toBe('GBU\u201112 and AGM\u201165D');
    // ordinary hyphens stay breakable
    expect(keepDesignators('fly-by, look-at-SPI')).toBe('fly-by, look-at-SPI');
  });
});

describe('table scroll hint', () => {
  it('names the edges that hide columns', () => {
    expect(hiddenEdges(0, 300, 300)).toBe(''); // it all fits
    expect(hiddenEdges(0, 300, 520)).toBe('right');
    expect(hiddenEdges(110, 300, 520)).toBe('both');
    expect(hiddenEdges(220, 300, 520)).toBe('left');
    // fractional scroll positions on a zoomed page still count as the end
    expect(hiddenEdges(219.4, 300, 520)).toBe('left');
    expect(hiddenEdges(0.5, 300, 520)).toBe('right');
  });
});
