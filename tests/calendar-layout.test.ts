import { expect, it } from 'vitest';

import { layoutCalendarBlocks } from '../src/ui/calendar-layout.js';

it('keeps near-time calendar cards separately clickable and restores full width later', () => {
  const blocks = layoutCalendarBlocks([0, 20, 90], (minute) => minute, 62);
  expect(blocks.map(({ top, column, columns }) => ({ top, column, columns }))).toEqual([
    { top: 0, column: 0, columns: 2 },
    { top: 20, column: 1, columns: 2 },
    { top: 90, column: 0, columns: 1 },
  ]);
});
