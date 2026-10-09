import mysql from 'mysql2/promise';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required. Load the backend .env or set it in the server environment.');
}

const connection = await mysql.createConnection(databaseUrl);

async function columns(table) {
  const [rows] = await connection.execute(
    `SELECT COLUMN_NAME AS name
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table],
  );
  return new Set(rows.map((row) => row.name));
}

async function ensureColumn(table, name, definition) {
  const existing = await columns(table);
  if (existing.has(name)) {
    console.log(`Verified ${table}.${name}`);
    return;
  }
  await connection.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${name}\` ${definition}`);
  console.log(`Added ${table}.${name}`);
}

async function ensureCouponTable() {
  const [rows] = await connection.execute(
    `SELECT TABLE_NAME AS name
     FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'coupons'`,
  );
  if (rows.length) {
    console.log('Verified coupons table');
    return;
  }
  await connection.query(`
    CREATE TABLE coupons (
      id int NOT NULL AUTO_INCREMENT,
      code varchar(64) NOT NULL,
      discount_type enum('percent', 'fixed') NOT NULL,
      discount_value int NOT NULL,
      starts_at datetime NULL,
      ends_at datetime NULL,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY coupons_code_unique (code)
    )
  `);
  console.log('Created missing coupons table');
}

async function ensureCouponForeignKey() {
  const [rows] = await connection.execute(
    `SELECT CONSTRAINT_NAME AS name
     FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'transactions'
       AND COLUMN_NAME = 'coupon_id'
       AND REFERENCED_TABLE_NAME = 'coupons'`,
  );
  if (rows.length) {
    console.log('Verified transactions.coupon_id foreign key');
    return;
  }

  const [orphans] = await connection.execute(
    `SELECT COUNT(*) AS total
     FROM transactions t
     LEFT JOIN coupons c ON c.id = t.coupon_id
     WHERE t.coupon_id IS NOT NULL AND c.id IS NULL`,
  );
  if (Number(orphans[0]?.total || 0) > 0) {
    throw new Error('Cannot add coupon foreign key: transactions contain coupon IDs not present in coupons. No rows were changed.');
  }

  await connection.query(`
    ALTER TABLE transactions
    ADD CONSTRAINT transactions_coupon_id_coupons_id_fk
    FOREIGN KEY (coupon_id) REFERENCES coupons(id)
    ON DELETE SET NULL ON UPDATE NO ACTION
  `);
  console.log('Added transactions.coupon_id foreign key');
}

try {
  const [databaseRows] = await connection.query('SELECT DATABASE() AS name');
  console.log(`Checking schema for database: ${databaseRows[0]?.name || '(unknown)'}`);

  const [otpTables] = await connection.execute(
    `SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'otps'`,
  );
  const [planTables] = await connection.execute(
    `SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'plans'`,
  );
  const [transactionTables] = await connection.execute(
    `SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions'`,
  );
  if (!otpTables.length || !planTables.length || !transactionTables.length) {
    throw new Error('Expected otps, plans, and transactions tables. Check DATABASE_URL; no schema changes were made.');
  }

  const otpColumns = await columns('otps');
  if (otpColumns.has('email')) {
    await connection.query('ALTER TABLE otps MODIFY COLUMN email varchar(191) NULL');
    console.log('Widened otps.email to varchar(191) without deleting OTP rows');
  } else {
    await ensureColumn('otps', 'email', 'varchar(191) NULL');
  }

  await ensureColumn('plans', 'duration_days', 'int NOT NULL DEFAULT 30');
  await ensureColumn('plans', 'is_active', 'boolean NOT NULL DEFAULT true');
  await ensureCouponTable();
  await ensureColumn('transactions', 'coupon_id', 'int NULL');
  await ensureColumn('transactions', 'discount_amount', 'int NOT NULL DEFAULT 0');
  await ensureCouponForeignKey();

  console.log('Schema repair complete. Existing user, plan, subscription, OTP, and transaction rows were retained.');
} finally {
  await connection.end();
}
