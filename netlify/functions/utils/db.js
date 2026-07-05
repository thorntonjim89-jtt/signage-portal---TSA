const { Pool } = require('pg');

let pool;

function getPool() {
  if (!pool) {
    const connectionString =
      process.env.DATABASE_URL ||
      process.env.NETLIFY_DATABASE_URL ||
      process.env.NETLIFY_DATABASE_URL_UNPOOLED;

    if (!connectionString) {
      throw new Error(
        'No database connection string found. Set DATABASE_URL locally, or run `netlify db init` to provision Netlify DB.'
      );
    }

    pool = new Pool({
      connectionString,
      ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? false : { rejectUnauthorized: false },
    });
  }
  return pool;
}

function query(text, params) {
  return getPool().query(text, params);
}

module.exports = { query, getPool };
