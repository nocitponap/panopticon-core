import mysql from 'mysql2/promise';

let pool = null;

/**
 * The connection pool, created on first use from the environment.
 *
 * Always the LOCAL mirror. The remote source of truth is read by an external
 * service and is off-limits to everything in this package.
 */
export function getPool() {
    if (pool) return pool;

    pool = mysql.createPool({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_DATABASE,
        waitForConnections: true,
        connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
        queueLimit: 0,
        enableKeepAlive: true,
        keepAliveInitialDelay: 0,
        connectTimeout: 10000,
        // Driver-side only: parse DATETIME/TIMESTAMP strings from the server as UTC.
        timezone: 'Z'
    });

    // The option above only changes how the driver PARSES what the server sends.
    // The server still renders TIMESTAMP columns in its own session time zone, so
    // without this the same row yields a different instant depending on which host
    // answered. Pinning the session to UTC makes output host-independent — which
    // matters because this deployment is expected to move off the Pi.
    pool.on('connection', (conn) => {
        conn.query("SET time_zone = '+00:00'");
    });

    return pool;
}

/** Run a query and return the rows. */
export async function query(sql, params = []) {
    const [rows] = await getPool().query(sql, params);
    return rows;
}

/** Run a query expected to return at most one row. */
export async function queryOne(sql, params = []) {
    const rows = await query(sql, params);
    return rows.length ? rows[0] : null;
}

/** Run several independent queries concurrently. */
export function queryAll(specs) {
    return Promise.all(specs.map(([sql, params]) => query(sql, params)));
}

export async function closePool() {
    if (!pool) return;
    await pool.end();
    pool = null;
}
