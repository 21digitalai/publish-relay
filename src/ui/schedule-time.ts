export function localDateTimeValue(value: Date): string {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 16);
}

export function offsetLabel(value: Date): string {
  const minutes = -value.getTimezoneOffset();
  const sign = minutes >= 0 ? '+' : '-';
  const absolute = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(
    absolute % 60,
  ).padStart(2, '0')}`;
}

export function matchingLocalInstants(localValue: string): Date[] {
  const desired = localValue.replace('T', ' ');
  const approximate = new Date(localValue).getTime();
  const matches: Date[] = [];
  for (let minutes = -180; minutes <= 180; minutes += 15) {
    const candidate = new Date(approximate + minutes * 60_000);
    const rendered = `${String(candidate.getFullYear())}-${String(
      candidate.getMonth() + 1,
    ).padStart(2, '0')}-${String(candidate.getDate()).padStart(2, '0')} ${String(
      candidate.getHours(),
    ).padStart(2, '0')}:${String(candidate.getMinutes()).padStart(2, '0')}`;
    if (rendered === desired && !matches.some((match) => match.getTime() === candidate.getTime()))
      matches.push(candidate);
  }
  return matches;
}
