import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const enabled = Boolean(process.env.YYC_INTEGRATION_DATABASE_URL && process.env.YYC_INTEGRATION_REDIS_URL);
test('PostgreSQL and Redis application integration', { skip: !enabled }, async () => {
  process.env.DATABASE_URL = process.env.YYC_INTEGRATION_DATABASE_URL;
  process.env.ADMIN_MFA_OPTIONAL = 'true'; // the HTTP checks below use a broker without an authenticator
  process.env.REDIS_URL = process.env.YYC_INTEGRATION_REDIS_URL;
  const [store, serverModule, redisModule, websocketModule, databaseModule] = await Promise.all([
    import('../src/store.js'), import('../src/server.js'), import('../src/redis.js'), import('../src/websocket/server.js'), import('../src/db/postgres.js')
  ]);
  await store.initStore();
  const { server } = serverModule.createApp({ secure: false, publicOrigin: '' }); // the test serves on a random port
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const password = 'Integration-test-password-2048!';
  const emails = ['broker','store','driver'].map(role => `integration-${role}-${randomUUID()}@example.test`);
  let accountIds = []; let shipmentIds = [];
  try {
    const brokerPublic = await store.createUser({ role: 'admin', name: 'Integration broker', email: emails[0], password }, true);
    const storePublic = await store.createUser({ role: 'store', name: 'Integration store', email: emails[1], password, address: 'Store address', phone: '4030000000', contact: 'Receiver' });
    const driverPublic = await store.createUser({ role: 'driver', name: 'Integration driver', email: emails[2], password, phone: '4030000001', truck: 'Box truck', plate: `T-${randomUUID().slice(0,8)}`, type: 'Box truck', kg: 3000, pallets: 8, area: 'Calgary', liftgate: true });
    accountIds = [brokerPublic.id, storePublic.id, driverPublic.id];
    const broker = await store.login(emails[0], password), customer = await store.login(emails[1], password), driver = await store.login(emails[2], password);
    await store.approve(broker, driver.id);
    driver.approved = true; // the session row was loaded before approval
    const shipment = await store.createShipment(customer, { pickup: 'Warehouse A, Calgary', destination: 'Store B, Calgary', stops: ['Stop A, Calgary | Receiver A | 13:00–16:00'], date: new Date(Date.now()+7*86400000).toISOString().slice(0,10), window: '13:00–16:00', goods: 'Palletized supplies', pallets: 2, kg: 500, type: 'Box truck', unloading: 'Dock', pickupContact: 'Dispatch', receivingContact: 'Store contact', hours: '09:00–17:00' });
    shipmentIds.push(shipment.id);
    let shipmentId = shipment.id;
    let current = await store.act(broker, shipmentId, 'quote', { version: shipment.version, price: 500, rate: 350 });
    current = await store.act(customer, shipmentId, 'acceptQuote', { version: current.version });
    current = await store.act(driver, shipmentId, 'bid', { version: current.version, rate: 325, note: 'Available for the route' });
    assert.equal(current.bids[0].rate, 325);
    current = await store.act(broker, shipmentId, 'acceptBid', { version: current.version, driverId: driver.id });
    current = await store.act(driver, shipmentId, 'acceptJob', { version: current.version });
    current = await store.act(driver, shipmentId, 'pickup', { version: current.version });
    current = await store.act(driver, shipmentId, 'arriveStop', { version: current.version, stopIndex: 0 });
    current = await store.act(driver, shipmentId, 'completeStop', { version: current.version, stopIndex: 0, receipt: 'STOP-1' });
    current = await store.act(driver, shipmentId, 'deliver', { version: current.version, pod: 'POD-1', recipient: 'Receiver' });
    assert.equal(current.status, 'Delivered');
    assert.equal(current.stopProgress[0].receipt, 'STOP-1');
    const expiring = await store.createShipment(customer, { pickup: 'Warehouse C, Calgary', destination: 'Store D, Calgary', date: new Date(Date.now()+8*86400000).toISOString().slice(0,10), window: '09:00–12:00', goods: 'Cartons', pallets: 1, kg: 100, type: 'Box truck', unloading: 'Dock', pickupContact: 'Dispatch', receivingContact: 'Receiver', hours: '09:00–17:00' });
    shipmentIds.push(expiring.id);
    await store.act(broker, expiring.id, 'quote', { version: expiring.version, price: 100, rate: 70 });
    await databaseModule.query("UPDATE shipments SET data=jsonb_set(data, '{quoteExpiresAt}', to_jsonb((NOW()-INTERVAL '1 minute')::text)) WHERE id=$1", [expiring.id]);
    await store.expireStaleDispatch();
    const expired = await databaseModule.query('SELECT status FROM shipments WHERE id=$1', [expiring.id]);
    assert.equal(expired.rows[0].status, 'Awaiting quote');
    const email = emails[0];
    const login = await fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const session = await fetch(origin + '/api/session', { headers: { Cookie: cookie } });
    assert.equal(session.status, 200);
    const sessionData = await session.json();
    assert.equal(sessionData.user.role, 'admin');
    const providerCheck = await fetch(origin + '/api/admin/providers', { headers: { Cookie: cookie } });
    assert.equal(providerCheck.status, 200);
    assert.equal(typeof (await providerCheck.json()).providers.maps, 'boolean');
    const logout = await fetch(origin + '/api/logout', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': sessionData.csrf }, body: '{}' });
    assert.equal(logout.status, 200);
    const afterLogout = await fetch(origin + '/api/session', { headers: { Cookie: cookie } });
    assert.equal((await afterLogout.json()).user, null);
    const health = await fetch(origin + '/healthz');
    assert.equal(health.status, 200);
    assert.equal((await health.json()).database, 'connected');
  } finally {
    await websocketModule.closeWebSocket();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (shipmentIds.length) await databaseModule.query('DELETE FROM shipments WHERE id = ANY($1::text[])', [shipmentIds]);
    // Account-level audit rows (e.g. driver approval) reference the actor with ON DELETE RESTRICT.
    if (accountIds.length) await databaseModule.query('DELETE FROM audit WHERE actor_id = ANY($1::uuid[])', [accountIds]);
    if (accountIds.length) await databaseModule.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [accountIds]);
    await redisModule.close();
    await databaseModule.close();
  }
});
