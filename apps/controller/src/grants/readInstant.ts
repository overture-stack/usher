// An RFC 3339 instant with an offset: a date, `T`, a time with whole seconds and any fraction, and
// `Z` or an offset in hours and minutes.
const INSTANT = new RegExp(
	[
		String.raw`^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})`,
		String.raw`T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.\d+)?`,
		String.raw`(?:Z|[+-](?<offsetHour>\d{2}):(?<offsetMinute>\d{2}))$`,
	].join(''),
	'u',
);

/**
 * The instant a text names as an RFC 3339 instant with an offset, `Z` or `±hh:mm`, such as
 * `2026-11-03T15:04:05Z`.
 *
 * @param text the text sent.
 * @returns the instant, or `undefined` for text in no such form, or naming a day, an hour or an
 *   offset there is not.
 */
export const instantOf = (text: string): Date | undefined => {
	const groups = INSTANT.exec(text)?.groups;
	if (groups === undefined) {
		return undefined;
	}
	const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = [
		groups['year'],
		groups['month'],
		groups['day'],
		groups['hour'],
		groups['minute'],
		groups['second'],
		groups['offsetHour'],
		groups['offsetMinute'],
	].map((part) => Number(part ?? '0'));
	const written = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day ?? 0, hour ?? 0, minute ?? 0));
	const holdsDay =
		written.getUTCFullYear() === year && written.getUTCMonth() === (month ?? 0) - 1 && written.getUTCDate() === day;
	const inRange = [
		[hour, 24],
		[minute, 60],
		[second, 60],
		[offsetHour, 24],
		[offsetMinute, 60],
	].every(([value = 0, bound = 0]) => value < bound);
	return holdsDay && inRange ? new Date(Date.parse(text)) : undefined;
};
