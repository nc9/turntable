// Whether the suite is running against Postgres (LONGSHORE_TEST_DB), for the few tests that are
// about SQLite itself or that start a second process with its own database.
export const onPostgres = Boolean(process.env.LONGSHORE_TEST_DB);
