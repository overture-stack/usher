import type pg from 'pg';

/** Where the notice reader reads the store: one statement at a time, each within the store timeout. */
export interface NoticeStore {
	/**
	 * Runs one statement on a connection of its own, within the store timeout.
	 *
	 * @param text the statement, every value bound.
	 * @param values the values bound to it.
	 */
	query<Row extends pg.QueryResultRow>(text: string, values?: readonly unknown[]): Promise<pg.QueryResult<Row>>;
}
