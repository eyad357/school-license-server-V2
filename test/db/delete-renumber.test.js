'use strict';

// Deleting a record removes it for good and renumbers customers 1..N with no gaps.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool, resetDatabase, closeAll } = require('./helpers/setup');
const { bulkWithSales } = require('./helpers/bulk');
const { deleteRecordAndRenumber } = require('../../src/services/customerService');

before(() => resetDatabase('full'));
beforeEach(async () => {
  await pool.query('TRUNCATE activations, devices, licenses, customers, license_batches CASCADE');
  await pool.query('UPDATE customer_number_counter SET last_number = 0');
});
after(closeAll);

async function snapshot() {
  const { rows } = await pool.query(
    `SELECT c.customer_number::int AS n, l.license_key
       FROM customers c LEFT JOIN licenses l ON l.customer_id = c.id
      ORDER BY c.customer_number`);
  return rows;
}

test('deleting #2 of 5 removes it and shifts 3,4,5 down to 2,3,4', async () => {
  const r = await bulkWithSales({ productId: 'school-accreditation', quantity: 5, maxDevices: 1, duration: 'lifetime', plan: 'pro' });
  const keyOf = (n) => r.items.find((i) => i.customerNumber === n).licenseKey;
  const before = await snapshot();
  assert.deepEqual(before.map((x) => x.n), [1, 2, 3, 4, 5]);

  const lic = await pool.query('SELECT id FROM licenses WHERE license_key = $1', [keyOf(2)]);
  const out = await deleteRecordAndRenumber({ licenseId: lic.rows[0].id });
  assert.equal(out.deletedLicense, true);
  assert.equal(out.deletedCustomer, true);

  const after = await snapshot();
  assert.deepEqual(after.map((x) => x.n), [1, 2, 3, 4]);
  assert.deepEqual(after.map((x) => x.license_key), [keyOf(1), keyOf(3), keyOf(4), keyOf(5)]);
  assert.ok(!after.some((x) => x.license_key === keyOf(2)), 'deleted key is gone');

  // the next new customer continues from the end (5), not from an old counter
  const next = await bulkWithSales({ productId: 'school-accreditation', quantity: 1, maxDevices: 1, duration: 'lifetime', plan: 'pro' });
  assert.equal(next.items[0].customerNumber, 5);
});

test('customer without license can be deleted too; trigger is re-enabled afterwards', async () => {
  await bulkWithSales({ productId: 'school-accreditation', quantity: 3, maxDevices: 1, duration: 'lifetime', plan: 'pro' });
  const c = await pool.query('SELECT id FROM customers WHERE customer_number = 1');
  await pool.query('DELETE FROM licenses WHERE customer_id = $1', [c.rows[0].id]);
  await deleteRecordAndRenumber({ customerId: c.rows[0].id });
  assert.deepEqual((await snapshot()).map((x) => x.n), [1, 2]);

  await assert.rejects(pool.query('UPDATE customers SET customer_number = 99 WHERE customer_number = 1'), /immutable/);
});
