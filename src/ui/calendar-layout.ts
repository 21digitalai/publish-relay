export interface CalendarBlock<T> {
  item: T;
  top: number;
  column: number;
  columns: number;
}

export function layoutCalendarBlocks<T>(
  items: T[],
  topOf: (item: T) => number,
  minimumHeight: number,
): CalendarBlock<T>[] {
  const sorted = items
    .map((item) => ({ item, top: Math.max(0, topOf(item)), column: 0, columns: 1 }))
    .sort((left, right) => left.top - right.top);
  let group: CalendarBlock<T>[] = [];
  let columnEnds: number[] = [];
  const finishGroup = () => {
    for (const block of group) block.columns = columnEnds.length;
    group = [];
    columnEnds = [];
  };
  for (const block of sorted) {
    if (columnEnds.length > 0 && columnEnds.every((end) => end <= block.top)) finishGroup();
    const freeColumn = columnEnds.findIndex((end) => end <= block.top);
    block.column = freeColumn >= 0 ? freeColumn : columnEnds.length;
    columnEnds[block.column] = block.top + minimumHeight;
    group.push(block);
  }
  finishGroup();
  return sorted;
}
