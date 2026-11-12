import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { initSchema, transaction, query, queryOne, queryAll } from './db/postgres.js';
import { setSession, getSession, deleteSession } from './redis.js';
import { calculateETA, isConfigured as mapsConfigured } from './maps/directions.js';

const scrypt = promisify(scryptCb);
const jsonValue = value => typeof value === 'string' ? JSON.parse(value) : value;

export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function check(ok, status, message) {
  if (!ok) throw new AppError(status, message);
}

export function text(value, label, max = 250, required = true) {
  check(typeof value === 'string', 400, `${label} must be text.`);
  value = value.trim();
  check((!required || value.length > 0) && value.length <= max, 400, `${label} is required and must be at most ${max} characters.`);
  return value;
}

export async function storeOwnerId(u) {
  if (u.role !== 'store') return null;
  const membership = await queryOne('SELECT owner_user_id FROM store_team_memberships WHERE member_user_id = $1', [u.id]);
  return membership?.owner_user_id || u.id;
}

export async function hasStorePermission(u, ownerId, permission = 'shipments.read') {
  if (u.role === 'admin') return true;
  if (u.role !== 'store') return false;
  if (u.id === ownerId) return true;
  const membership = await queryOne('SELECT permissions FROM store_team_memberships WHERE owner_user_id = $1 AND member_user_id = $2', [ownerId, u.id]);
  const permissions = membership?.permissions ? jsonValue(membership.permissions) : {};
  return permissions[permission] === true;
}

function optional(value, label, max = 1000) {
  return value == null ? '' : text(value, label, max, false);
}

function number(value, label, max = 1000000) {
  check(typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= max, 400, `${label} must be a positive number no greater than ${max}.`);
  return value;
}

function amount(value, label) {
  number(value, label, 1000000);
  check(Math.abs(value * 100 - Math.round(value * 100)) < 0.000001, 400, `${label} supports two decimal places.`);
  return Math.round(value * 100) / 100;
}

export function email(value) {
  value = text(value, 'Email', 254).toLowerCase();
  check(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), 400, 'Enter a valid email.');
  return value;
}

export async function hashPassword(value) {
  check(typeof value === 'string' && value.length >= 12 && value.length <= 128, 400, 'Use a password of 12 to 128 characters.');
  let salt = randomBytes(16).toString('hex');
  let hash = await scrypt(value, salt, 64);
  return salt + ':' + hash.toString('hex');
}

export async function verifyPassword(value, stored) {
  let [salt, hash] = stored.split(':');
  let actual = await scrypt(value, salt, 64);
  let expected = Buffer.from(hash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const digest = value => createHash('sha256').update(value).digest('hex');

// Initialize database on startup
export async function initStore() {
  await initSchema();
  console.log('Store initialized with PostgreSQL');
}

// User operations
async function user(id) {
  return await queryOne('SELECT * FROM users WHERE id = $1', [id]);
}

async function truck(driverId) {
  return await queryOne('SELECT * FROM trucks WHERE driver_id = $1', [driverId]);
}

export async function publicUser(row) {
  if (!row) return null;
  let p = jsonValue(row.profile);
  let t = await truck(row.id);
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    approved: row.approved,
    disabled: row.disabled,
    email_verified: row.email_verified,
    profile: p,
    truck: t ? {
      id: t.id,
      plate: t.plate,
      ...jsonValue(t.profile),
      approved: t.approved
    } : null
  };
}

export async function createUser(input, allowAdmin = false) {
  let role = input.role;

  // Validate broker/admin registration code
  if (role === 'admin') {
    const validCodes = (process.env.BROKER_REGISTRATION_CODES || '').split(',').map(c => c.trim()).filter(Boolean);
    const providedCode = (input.brokerCode || '').trim();
    check(allowAdmin || validCodes.length === 0 || validCodes.includes(providedCode), 403, 'Invalid broker registration code. Contact YYC to obtain a valid code.');
  }

  check(['store', 'driver'].includes(role) || role === 'admin', 400, 'Invalid registration role.');

  let name = text(input.name, 'Name', 120);
  let address = optional(input.address, 'Address', 350);
  let phone = optional(input.phone, 'Phone', 50);
  let contact = optional(input.contact, 'Contact', 120);

  if (role === 'store') {
    check(address && contact && phone, 400, 'Store address, receiving contact and phone are required.');
  }

  let em = email(input.email);
  let passwordHash = await hashPassword(input.password);
  let id = randomUUID();
  let tr = null;

  if (role === 'driver') {
    tr = {
      truck: text(input.truck, 'Truck model', 120),
      type: text(input.type, 'Truck type', 30),
      kg: number(Number(input.kg), 'Truck payload', 100000),
      pallets: number(Number(input.pallets), 'Pallet capacity', 100),
      area: text(input.area, 'Service area', 250),
      liftgate: input.liftgate === true
    };
    check(['Box truck', 'Dry van'].includes(tr.type), 400, 'Unsupported truck type.');
    check(Number.isInteger(tr.pallets), 400, 'Pallet capacity must be a whole number.');
    check(phone, 400, 'Driver phone is required.');
  }

  try {
    await transaction(async (client) => {
      await client.query(
        `INSERT INTO users(id, email, password_hash, role, name, profile, approved, created_at)
         VALUES($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [id, em, passwordHash, role, name, JSON.stringify({ address, phone, contact }), role !== 'driver']
      );

      if (tr) {
        await client.query(
          `INSERT INTO trucks(id, driver_id, plate, profile, approved)
           VALUES($1, $2, $3, $4, false)`,
          [randomUUID(), id, text(input.plate, 'Plate', 40).toUpperCase(), JSON.stringify(tr)]
        );
      }
    });
  } catch (e) {
    if (String(e.message).includes('duplicate key') || String(e.message).includes('unique')) {
      throw new AppError(409, 'An account email or truck plate is already registered.');
    }
    throw e;
  }

  return await publicUser(await user(id));
}

export async function login(em, password) {
  check(typeof password === 'string' && password.length <= 128, 400, 'Invalid credentials.');
  let u = await queryOne('SELECT * FROM users WHERE email = $1', [email(em)]);

  if (!u) {
    await scrypt(password, 'yyc-dummy-password-salt', 64);
    throw new AppError(401, 'Email or password is incorrect.');
  }

  check(!u.disabled && await verifyPassword(password, u.password_hash), 401, 'Email or password is incorrect.');
  return u;
}

export async function getUserByEmail(em) {
  return await queryOne('SELECT * FROM users WHERE email = $1', [email(em)]);
}

export async function verifyEmail(em) {
  await query('UPDATE users SET email_verified = true WHERE email = $1', [email(em)]);
}

export async function updatePassword(em, password) {
  const passwordHash = await hashPassword(password);
  await query('UPDATE users SET password_hash = $1 WHERE email = $2', [passwordHash, email(em)]);
}

export async function createSession(uid) {
  let token = randomBytes(32).toString('hex');
  let csrf = randomBytes(24).toString('hex');
  let tokenHash = digest(token);

  // Get user role for WebSocket authentication
  const u = await user(uid);

  // Store session in Redis with 12-hour TTL
  await setSession(tokenHash, {
    user_id: uid,
    user_role: u.role,
    csrf,
    expires_at: Date.now() + 12 * 3600000
  }, 43200);

  return { token, csrf };
}

export async function session(token) {
  if (!token) return null;

  let tokenHash = digest(token);
  let s = await getSession(tokenHash);

  if (!s || s.expires_at < Date.now()) return null;

  let u = await user(s.user_id);
  return u && !u.disabled ? { user: u, csrf: s.csrf } : null;
}

export async function logout(token) {
  if (token) {
    let tokenHash = digest(token);
    await deleteSession(tokenHash);
  }
}

async function audit(uid, id, event) {
  await query(
    'INSERT INTO audit(shipment_id, actor_id, event, created_at) VALUES($1, $2, $3, NOW())',
    [id, uid, event]
  );
}

async function visible(u, row) {
  return u.role === 'admin' ||
         (u.role === 'store' && await hasStorePermission(u, row.store_id, 'shipments.read')) ||
         (u.role === 'driver' && (row.driver_id === u.id || row.offered_to === u.id || row.status === 'Ready to assign'));
}

async function shipment(id, u) {
  let r = await queryOne('SELECT * FROM shipments WHERE id = $1', [id]);
  check(r && await visible(u, r), 404, 'Delivery not found.');
  return r;
}

export async function getShipment(id) {
  let r = await queryOne('SELECT * FROM shipments WHERE id = $1', [id]);
  if (!r) return null;

  return {
    id: r.id,
    store_id: r.store_id,
    driver_id: r.driver_id,
    offered_to: r.offered_to,
    status: r.status,
    version: r.version,
    data: jsonValue(r.data),
    payment_status: r.payment_status,
    payment_amount: r.payment_amount,
    payment_intent_id: r.payment_intent_id,
    payout_status: r.payout_status,
    payout_amount: r.payout_amount,
    created_at: r.created_at,
    updated_at: r.updated_at
  };
}

async function serialize(row, u) {
  let s = jsonValue(row.data);
  let owner = await user(row.store_id);
  let d = row.driver_id ? await user(row.driver_id) : null;

  let events = await queryAll(
    `SELECT audit.event, audit.created_at, users.name
     FROM audit
     JOIN users ON users.id = audit.actor_id
     WHERE shipment_id = $1
     ORDER BY audit.id`,
    [row.id]
  );

  let out = {
    ...s,
    id: row.id,
    status: row.status,
    version: row.version,
    customer: owner.name,
    driver: !!row.driver_id,
    driverId: row.driver_id,
    driverName: d?.name || null,
    paymentStatus: row.payment_status,
    paymentAmount: row.payment_amount,
    payoutStatus: row.payout_status,
    payoutAmount: row.payout_amount,
    offeredTo: row.offered_to,
    events: events.map(e => e.event),
    history: events.map(e => ({ text: e.event, actor: e.name, time: e.created_at, source: 'Server audit' }))
  };

  if (u.role === 'store') {
    delete out.rate;
    delete out.payoutStatus;
    delete out.payoutAmount;
    delete out.payoutBreakdown;
    if (!await hasStorePermission(u, row.store_id, 'billing.read')) {
      delete out.price;
      delete out.paymentStatus;
      delete out.paymentAmount;
    }
    out.quoteArchive = out.quoteArchive?.map(({ rate, ...q }) => q);
  }
  if (u.role === 'driver') {
    delete out.price;
    out.quoteArchive = out.quoteArchive?.map(({ price, ...q }) => q);
    out.bids = out.bids?.filter(b => b.driverId === u.id);
    if (!row.driver_id && !row.offered_to) {
      out.stops = out.stops?.map(({ contact, ...stop }) => stop);
      delete out.rate;
      delete out.pickupContact;
      delete out.receivingContact;
      delete out.appointment;
      delete out.notes;
    }
  }
  if (u.role === 'store') delete out.bids;

  return out;
}

export async function state(u, { limit = 100, after = '' } = {}) {
  await expireStaleDispatch();
  check(Number.isInteger(limit) && limit >= 1 && limit <= 200, 400, 'Page size must be between 1 and 200.');

  let cursor = after ? Number(after.replace(/^YYC-/, 'NaN')) : Number.MAX_SAFE_INTEGER;
  check(Number.isSafeInteger(cursor) && cursor > 0, 400, 'Invalid shipment cursor.');

  let rows;
  if (u.role === 'admin') {
    rows = await queryAll(
      `SELECT * FROM shipments
       WHERE CAST(substr(id, 5) AS INTEGER) < $1
       ORDER BY CAST(substr(id, 5) AS INTEGER) DESC
       LIMIT $2`,
      [cursor, limit]
    );
  } else if (u.role === 'store') {
    rows = await queryAll(
      `SELECT * FROM shipments
       WHERE (store_id = $1 OR store_id IN (SELECT owner_user_id FROM store_team_memberships WHERE member_user_id = $1 AND permissions->>'shipments.read' = 'true')) AND CAST(substr(id, 5) AS INTEGER) < $2
       ORDER BY CAST(substr(id, 5) AS INTEGER) DESC
       LIMIT $3`,
      [u.id, cursor, limit]
    );
  } else {
    rows = await queryAll(
      `SELECT * FROM shipments
       WHERE (driver_id = $1 OR offered_to = $1 OR status = 'Ready to assign') AND CAST(substr(id, 5) AS INTEGER) < $2
       ORDER BY CAST(substr(id, 5) AS INTEGER) DESC
       LIMIT $3`,
      [u.id, cursor, limit]
    );
  }

  let drivers = u.role === 'admin'
    ? await Promise.all(
        (await queryAll("SELECT * FROM users WHERE role='driver' ORDER BY created_at")).map(publicUser)
      )
    : [];

  let shipments = await Promise.all(rows.map(r => serialize(r, u)));

  const stateUser = await publicUser(await user(u.id));
  const teamMembership = u.role === 'store' ? await queryOne('SELECT owner_user_id, permissions FROM store_team_memberships WHERE member_user_id = $1', [u.id]) : null;
  stateUser.team = teamMembership ? { ownerId: teamMembership.owner_user_id, permissions: jsonValue(teamMembership.permissions), isOwner: false } : { ownerId: u.role === 'store' ? u.id : null, permissions: { 'shipments.read': true, 'shipments.write': true, 'billing.read': true, 'team.manage': true }, isOwner: u.role === 'store' };
  return {
    user: stateUser,
    shipments,
    drivers,
    features: { maps: false, phoneGps: false, email: false, uploads: false, livePayments: false },
    next: rows.length === limit ? rows[rows.length - 1].id : null
  };
}

export async function expireStaleDispatch() {
  return await transaction(async client => {
    const admin = await client.query("SELECT id FROM users WHERE role = 'admin' AND disabled = false ORDER BY created_at LIMIT 1");
    if (!admin.rows[0]) return 0;
    const expired = await client.query(`SELECT id, status, data FROM shipments WHERE
      (status = 'Quote ready' AND NULLIF(data->>'quoteExpiresAt','')::timestamptz <= NOW()) OR
      (status = 'Offered' AND NULLIF(data->>'offerExpiresAt','')::timestamptz <= NOW()) OR
      (status = 'Ready to assign' AND NULLIF(data->>'bidsExpiresAt','')::timestamptz <= NOW()) FOR UPDATE SKIP LOCKED`);
    for (const row of expired.rows) {
      const data = jsonValue(row.data);
      const isQuote = row.status === 'Quote ready';
      const isOffer = row.status === 'Offered';
      const isBidWindow = row.status === 'Ready to assign';
      if (isQuote) { data.price = null; data.rate = null; delete data.quoteExpiresAt; data.bids = []; }
      else if (isOffer) delete data.offerExpiresAt;
      else { data.bids = []; delete data.bidsExpiresAt; }
      const nextStatus = isQuote ? 'Awaiting quote' : isOffer ? 'Ready to assign' : row.status;
      if (isOffer) data.driverId = null;
      await client.query('UPDATE shipments SET status=$1, offered_to=NULL, data=$2, version=version+1, updated_at=NOW() WHERE id=$3', [nextStatus, JSON.stringify(data), row.id]);
      const event = isQuote ? 'Quotation expired automatically' : isOffer ? 'Driver offer expired automatically' : 'Driver bidding window closed automatically';
      await client.query('INSERT INTO audit(shipment_id, actor_id, event, created_at) VALUES($1,$2,$3,NOW())', [row.id, admin.rows[0].id, event]);
    }
    return expired.rowCount;
  });
}

export async function createShipment(u, input) {
  check(u.role === 'store', 403, 'Only stores can create delivery requests.');
  const ownerId = await storeOwnerId(u);
  check(await hasStorePermission(u, ownerId, 'shipments.write'), 403, 'Your team account cannot create shipments.');

  let date = text(input.date, 'Pickup date', 10);
  let parsedDate = new Date(date + 'T00:00:00Z');
  check(
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    !Number.isNaN(parsedDate.getTime()) &&
    parsedDate.toISOString().slice(0, 10) === date,
    400,
    'Invalid pickup date.'
  );
  check(date >= new Date().toISOString().slice(0, 10), 400, 'Pickup date cannot be in the past.');

  let s = {
    pickup: text(input.pickup, 'Pickup address', 350),
    destination: text(input.destination, 'Delivery address', 350),
    stops: Array.isArray(input.stops) ? input.stops.slice(0, 9).map((stop, i) => { const bits = typeof stop === 'string' ? stop.split('|').map(x => x.trim()) : [stop?.address, stop?.contact, stop?.window, stop?.serviceMinutes]; return { address: text(bits[0], `Stop ${i + 1} address`, 350), contact: optional(bits[1], 'Stop contact', 150), window: optional(bits[2], 'Stop receiving window', 80), serviceMinutes: bits[3] == null || bits[3] === '' ? 20 : Number(bits[3]) }; }) : [],
    date,
    window: text(input.window, 'Pickup window', 30),
    pickupServiceMinutes: input.pickupServiceMinutes == null ? 30 : Number(input.pickupServiceMinutes),
    deliveryServiceMinutes: input.deliveryServiceMinutes == null ? 30 : Number(input.deliveryServiceMinutes),
    goods: text(input.goods, 'Goods', 500),
    requestedQuantity: input.requestedQuantity == null || input.requestedQuantity === '' ? null : number(Number(input.requestedQuantity), 'Requested quantity', 1000000),
    pallets: number(Number(input.pallets), 'Pallet count', 100),
    kg: number(Number(input.kg), 'Weight', 100000),
    type: text(input.type, 'Vehicle type', 30),
    unloading: text(input.unloading, 'Unloading', 80),
    notes: optional(input.notes, 'Instructions'),
    pickupContact: text(input.pickupContact, 'Pickup contact', 150),
    receivingContact: text(input.receivingContact, 'Receiving contact', 150),
    hours: text(input.hours, 'Receiving hours', 100),
    appointment: optional(input.appointment, 'Appointment', 100),
    cargoNotes: optional(input.cargoNotes, 'Cargo details', 500),
    quoteVersion: 1,
    price: null,
    rate: null
  };

  check(Array.isArray(input.stops) ? input.stops.length <= 8 : true, 400, 'A delivery can have at most 8 intermediate stops.');
  for (const stop of s.stops) check(!stop.window || ['09:00–12:00', '13:00–16:00', 'Flexible'].includes(stop.window), 400, 'Unsupported intermediate stop time window.');
  check([s.pickupServiceMinutes, s.deliveryServiceMinutes, ...s.stops.map(stop => stop.serviceMinutes)].every(minutes => Number.isInteger(minutes) && minutes >= 0 && minutes <= 480), 400, 'Service durations must be whole minutes between 0 and 480.');
  check(s.pickup.toLowerCase() !== s.destination.toLowerCase(), 400, 'Pickup and delivery must differ.');
  check(Number.isInteger(s.pallets), 400, 'Pallet count must be a whole number.');
  check(['Box truck', 'Dry van'].includes(s.type), 400, 'Unsupported vehicle type.');
  check(['09:00–12:00', '13:00–16:00', 'Flexible'].includes(s.window), 400, 'Unsupported pickup window.');

  return await transaction(async (client) => {
    let result = await client.query(
      "UPDATE counters SET value = value + 1 WHERE name = 'shipment' RETURNING value"
    );
    let n = result.rows[0].value;
    let id = 'YYC-' + n;

    await client.query(
      `INSERT INTO shipments(id, store_id, status, data, created_at, updated_at)
       VALUES($1, $2, $3, $4, NOW(), NOW())`,
      [id, ownerId, 'Awaiting quote', JSON.stringify(s)]
    );

    await client.query(
      'INSERT INTO audit(shipment_id, actor_id, event, created_at) VALUES($1, $2, $3, NOW())',
      [id, u.id, 'Delivery request received']
    );

    let row = await client.query('SELECT * FROM shipments WHERE id = $1', [id]);
    return await serialize(row.rows[0], u);
  });
}

async function eligible(uid, s) {
  let d = await user(uid);
  let t = await truck(uid);

  check(d?.role === 'driver' && !d.disabled && d.approved && t?.approved, 409, 'Driver and truck approval is required.');

  let p = jsonValue(t.profile);
  check(
    p.type === s.type &&
    p.kg >= s.kg &&
    p.pallets >= s.pallets &&
    (!s.unloading?.includes('Liftgate') || p.liftgate),
    409,
    'Truck does not meet cargo or equipment requirements.'
  );

  return d;
}

async function checkDriverSchedule(client, driverId, target, currentId) {
  for (const stop of target.stops || []) check(!stop.window || stop.window === 'Flexible' || target.window === 'Flexible' || stop.window === target.window, 409, 'Intermediate stop time window conflicts with the pickup schedule.');
  const driverRow = await client.query('SELECT profile FROM users WHERE id = $1', [driverId]);
  const availability = jsonValue(driverRow.rows[0]?.profile || {}).availability;
  if (availability?.enabled) {
    const weekday = new Date(`${target.date}T12:00:00Z`).getUTCDay();
    check(Array.isArray(availability.days) && availability.days.includes(weekday), 409, 'Driver is not available on the requested delivery day.');
    const starts = target.window === '13:00–16:00' ? '13:00' : target.window === 'Flexible' ? availability.startTime : '09:00';
    const ends = target.window === '09:00–12:00' ? '12:00' : target.window === '13:00–16:00' ? '16:00' : availability.endTime;
    check(starts >= availability.startTime && ends <= availability.endTime, 409, 'Requested delivery window is outside the driver’s working hours.');
    if (availability.breakStart && availability.breakEnd && target.window !== 'Flexible') {
      const overlap = starts < availability.breakEnd && ends > availability.breakStart;
      check(!overlap, 409, 'Requested delivery window overlaps the driver’s scheduled break.');
    }
  }
  if (mapsConfigured()) {
    const points = [target.pickup, ...(target.stops || []).map(stop => stop.address), target.destination];
    let routeSeconds = 0;
    const departAt = calgaryTime(target.date, target.window === '13:00–16:00' ? '13:00' : '09:00');
    let elapsedSeconds = (target.pickupServiceMinutes || 30) * 60;
    for (let i = 0; i < points.length - 1; i++) {
      const epoch = departAt + elapsedSeconds * 1000;
      const departureTime = epoch > Date.now() && epoch < Date.now() + 6 * 86400000 ? Math.floor(epoch / 1000) : 'now';
      const leg = await calculateETA(points[i], points[i + 1], departureTime);
      const duration = leg.durationInTraffic?.seconds || leg.duration.seconds;
      routeSeconds += duration;
      elapsedSeconds += duration + ((target.stops || [])[i]?.serviceMinutes || (i === points.length - 2 ? target.deliveryServiceMinutes || 30 : 0)) * 60;
    }
    const serviceSeconds = ((target.pickupServiceMinutes || 30) + (target.deliveryServiceMinutes || 30) + (target.stops || []).reduce((sum, stop) => sum + (stop.serviceMinutes || 20), 0)) * 60;
    check(target.window === 'Flexible' || routeSeconds + serviceSeconds <= 3 * 3600, 409, 'Estimated drive and loading time exceed the selected delivery window.');
  }
  const result = await client.query("SELECT id, status, data FROM shipments WHERE driver_id = $1 AND status IN ('Assigned', 'In transit') AND id <> $2", [driverId, currentId]);
  for (const row of result.rows) {
    const job = jsonValue(row.data);
    if (row.status === 'In transit') throw new AppError(409, 'Driver is currently completing another delivery.');
    if (job.date !== target.date) continue;
    check(job.window !== 'Flexible' && target.window !== 'Flexible' && job.window !== target.window, 409, 'Driver has an overlapping delivery window.');
    let travelMinutes = 60;
    if (mapsConfigured()) {
      const [origin, destination] = job.window === '09:00–12:00'
        ? [job.destination, target.pickup]
        : [target.destination, job.pickup];
      const gapDeparture = calgaryTime(target.date, '12:00');
      const eta = await calculateETA(origin, destination, gapDeparture > Date.now() && gapDeparture < Date.now() + 6 * 86400000 ? Math.floor(gapDeparture / 1000) : 'now');
      travelMinutes = Math.ceil(eta.duration.seconds / 60);
    }
    check(travelMinutes + 30 <= 60, 409, 'Travel time between scheduled deliveries does not fit the available gap.');
  }
}

function calgaryTime(date, time) {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute);
  const name = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Edmonton', timeZoneName: 'shortOffset' }).formatToParts(new Date(utcGuess)).find(part => part.type === 'timeZoneName')?.value || 'GMT-07:00';
  const match = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  const offset = match ? (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3] || 0)) : -420;
  return utcGuess - offset * 60000;
}

export async function act(u, id, action, input = {}) {
  return await transaction(async (client) => {
    let result = await client.query('SELECT * FROM shipments WHERE id = $1', [id]);
    let r = result.rows[0];
    check(r && await visible(u, r), 404, 'Delivery not found.');
    check(Number.isInteger(input.version) && input.version === r.version, 409, 'This delivery changed. Refresh and try again.');

    let s = jsonValue(r.data);
    let status = r.status;
    let driver = r.driver_id;
    let offered = r.offered_to;
    let eventText = '';

    const admin = () => check(u.role === 'admin', 403, 'Broker access is required.');
    const store = async permission => check(await hasStorePermission(u, r.store_id, permission || 'shipments.write'), 403, 'Your team account cannot perform this shipment action.');
    const assigned = () => check(u.role === 'driver' && driver === u.id, 403, 'Only the current assigned driver can do this.');
    const at = (...states) => check(states.includes(status), 409, 'Action is not available in this delivery state.');

    switch (action) {
      case 'expireQuote':
        admin();
        at('Quote ready');
        check(s.quoteExpiresAt && Date.parse(s.quoteExpiresAt) <= Date.now(), 409, 'Quotation has not expired.');
        s.price = null; s.rate = null; delete s.quoteExpiresAt;
        status = 'Awaiting quote';
        eventText = 'Expired quotation closed; broker may issue a new quote';
        break;

      case 'expireOffer':
        admin();
        at('Offered');
        check(s.offerExpiresAt && Date.parse(s.offerExpiresAt) <= Date.now(), 409, 'Job offer has not expired.');
        offered = null;
        delete s.offerExpiresAt;
        status = 'Ready to assign';
        eventText = 'Expired job offer returned to dispatch';
        break;

      case 'quote':
        admin();
        at('Awaiting quote');
        s.price = amount(input.price, 'Customer quote');
        s.rate = amount(input.rate, 'Driver rate');
        check(s.rate <= s.price, 400, 'Driver rate cannot exceed the customer quote in this starter.');
        status = 'Quote ready';
        s.quoteExpiresAt = new Date(Date.now() + Math.max(1, Math.min(Number(input.expiryHours) || 72, 720)) * 3600000).toISOString();
        s.promisedPickupAt = s.window === 'Flexible' ? null : new Date(calgaryTime(s.date, s.window.startsWith('13:') ? '13:00' : '09:00')).toISOString();
        s.promisedDeliveryAt = s.window === '09:00–12:00' ? new Date(calgaryTime(s.date, '12:00')).toISOString() : s.window === '13:00–16:00' ? new Date(calgaryTime(s.date, '16:00')).toISOString() : null;
        eventText = 'Quotation v' + s.quoteVersion + ' issued for customer review';
        break;

      case 'requestQuoteRevision':
        await store();
        at('Quote ready');
        check(!s.quoteRevisionRequest || s.quoteRevisionRequest.status !== 'open', 409, 'A quotation revision is already awaiting review.');
        s.quoteRevisionRequest = { reason: text(input.reason, 'Revision request', 1000), requestedAt: new Date().toISOString(), status: 'open' };
        eventText = 'Store requested a quotation revision: ' + s.quoteRevisionRequest.reason;
        break;

      case 'reviseQuote':
        admin();
        at('Quote ready');
        check(s.quoteRevisionRequest?.status === 'open', 409, 'There is no open store request for a quotation revision.');
        s.quoteArchive = s.quoteArchive || [];
        s.quoteArchive.push({ version: s.quoteVersion, price: s.price, rate: s.rate, destination: s.destination, kg: s.kg, pallets: s.pallets, status: 'revised', reason: s.quoteRevisionRequest.reason, archivedAt: new Date().toISOString() });
        s.price = amount(input.price, 'Customer quote');
        s.rate = amount(input.rate, 'Driver rate');
        check(s.rate <= s.price, 400, 'Driver rate cannot exceed the customer quote.');
        s.quoteVersion = (s.quoteVersion || 1) + 1;
        s.quoteExpiresAt = new Date(Date.now() + Math.max(1, Math.min(Number(input.expiryHours) || 72, 720)) * 3600000).toISOString();
        s.promisedPickupAt = s.window === 'Flexible' ? null : new Date(calgaryTime(s.date, s.window.startsWith('13:') ? '13:00' : '09:00')).toISOString();
        s.promisedDeliveryAt = s.window === '09:00–12:00' ? new Date(calgaryTime(s.date, '12:00')).toISOString() : s.window === '13:00–16:00' ? new Date(calgaryTime(s.date, '16:00')).toISOString() : null;
        s.quoteRevisionRequest.status = 'revised';
        s.quoteRevisionRequest.completedAt = new Date().toISOString();
        eventText = 'Broker issued revised quotation v' + s.quoteVersion;
        break;

      case 'requestReschedule':
        await store();
        at('Quote ready', 'Ready to assign', 'Offered', 'Assigned');
        check(!s.rescheduleRequest || s.rescheduleRequest.status !== 'open', 409, 'A reschedule request is already awaiting review.');
        {
          const newDate = text(input.date, 'Requested date', 10);
          check(/^\d{4}-\d{2}-\d{2}$/.test(newDate) && !Number.isNaN(Date.parse(newDate)), 400, 'Choose a valid new delivery date.');
          const newWindow = text(input.window, 'Requested delivery window', 30);
          check(['09:00–12:00', '13:00–16:00', 'Flexible'].includes(newWindow), 400, 'Unsupported delivery window.');
          s.rescheduleRequest = { date: newDate, window: newWindow, reason: text(input.reason, 'Reschedule reason', 1000), requestedAt: new Date().toISOString(), status: 'open' };
        }
        eventText = 'Store requested a delivery reschedule to ' + s.rescheduleRequest.date + ' (' + s.rescheduleRequest.window + ')';
        break;

      case 'approveReschedule':
        admin();
        check(s.rescheduleRequest?.status === 'open', 409, 'There is no open reschedule request.');
        at('Quote ready', 'Ready to assign', 'Offered', 'Assigned');
        {
          const revisedSchedule = { ...s, date: s.rescheduleRequest.date, window: s.rescheduleRequest.window };
          if (driver) { await eligible(driver, revisedSchedule); await checkDriverSchedule(client, driver, revisedSchedule, id); }
          s.scheduleArchive = [...(s.scheduleArchive || []), { date: s.date, window: s.window, changedAt: new Date().toISOString(), reason: s.rescheduleRequest.reason }];
          s.date = revisedSchedule.date;
          s.window = revisedSchedule.window;
          s.promisedPickupAt = s.window === 'Flexible' ? null : new Date(calgaryTime(s.date, s.window.startsWith('13:') ? '13:00' : '09:00')).toISOString();
          s.promisedDeliveryAt = s.window === '09:00–12:00' ? new Date(calgaryTime(s.date, '12:00')).toISOString() : s.window === '13:00–16:00' ? new Date(calgaryTime(s.date, '16:00')).toISOString() : null;
          if (status === 'Offered') { offered = null; status = 'Ready to assign'; delete s.offerExpiresAt; }
          if (status === 'Ready to assign') { s.bids = []; s.bidsExpiresAt = new Date(Date.now() + 48 * 3600000).toISOString(); }
          s.rescheduleRequest.status = 'approved';
          s.rescheduleRequest.completedAt = new Date().toISOString();
        }
        eventText = 'Broker approved requested delivery reschedule';
        break;

      case 'acceptQuote':
        await store();
        at('Quote ready');
        check(!s.quoteExpiresAt || Date.parse(s.quoteExpiresAt) > Date.now(), 409, 'This quotation expired. Ask YYC for a revised quote.');
        check(s.price != null && s.rate != null, 409, 'No valid quotation is available.');
        status = 'Ready to assign';
        s.bidsExpiresAt = new Date(Date.now() + 48 * 3600000).toISOString();
        eventText = 'Customer accepted quotation v' + s.quoteVersion;
        break;

      case 'offer':
        admin();
        at('Ready to assign');
        await eligible(input.driverId, s);
        await checkDriverSchedule(client, input.driverId, s, id);
        offered = input.driverId;
        status = 'Offered';
        s.offerExpiresAt = new Date(Date.now() + Math.max(1, Math.min(Number(input.expiryHours) || 24, 168)) * 3600000).toISOString();
        let offeredDriver = await user(offered);
        eventText = 'YYC offered job to ' + offeredDriver.name;
        break;

      case 'bid':
        at('Ready to assign');
        check(u.role === 'driver', 403, 'Only drivers can submit bids.');
        check(!s.bidsExpiresAt || Date.parse(s.bidsExpiresAt) > Date.now(), 409, 'The bidding window is closed.');
        await eligible(u.id, s);
        await checkDriverSchedule(client, u.id, s, id);
        const bidRate = amount(input.rate, 'Bid rate');
        check(bidRate <= s.price, 400, 'Bid cannot exceed the customer quote.');
        s.bids = Array.isArray(s.bids) ? s.bids : [];
        s.bids = s.bids.filter(b => b.driverId !== u.id);
        s.bids.push({ driverId: u.id, rate: bidRate, note: optional(input.note, 'Bid note', 500), createdAt: new Date().toISOString() });
        eventText = 'Driver submitted a delivery bid';
        break;

      case 'withdrawBid':
        check(u.role === 'driver', 403, 'Only drivers can withdraw bids.');
        at('Ready to assign');
        check(!s.bidsExpiresAt || Date.parse(s.bidsExpiresAt) > Date.now(), 409, 'The bidding window is closed.');
        check((s.bids || []).some(b => b.driverId === u.id), 404, 'You have no bid to withdraw.');
        s.bids = (s.bids || []).filter(b => b.driverId !== u.id);
        eventText = 'Driver withdrew bid';
        break;

      case 'acceptBid':
        admin();
        at('Ready to assign');
        check(!s.bidsExpiresAt || Date.parse(s.bidsExpiresAt) > Date.now(), 409, 'The bidding window is closed.');
        const selectedBid = (s.bids || []).find(b => b.driverId === input.driverId);
        check(selectedBid, 404, 'Bid not found.');
        await eligible(selectedBid.driverId, s);
        await checkDriverSchedule(client, selectedBid.driverId, s, id);
        offered = selectedBid.driverId;
        s.rate = selectedBid.rate;
        status = 'Offered';
        s.offerExpiresAt = new Date(Date.now() + 24 * 3600000).toISOString();
        eventText = 'Broker selected a driver bid';
        break;

      case 'acceptJob':
        at('Offered');
        check(!s.offerExpiresAt || Date.parse(s.offerExpiresAt) > Date.now(), 409, 'This job offer expired.');
        check(u.role === 'driver' && offered === u.id, 403, 'This offer belongs to another driver.');
        await eligible(u.id, s);
        await checkDriverSchedule(client, u.id, s, id);
        driver = u.id;
        offered = null;
        status = 'Assigned';
        eventText = 'Driver accepted job';
        break;

      case 'decline':
        at('Offered');
        check(u.role === 'driver' && offered === u.id, 403, 'This offer belongs to another driver.');
        offered = null;
        status = 'Ready to assign';
        eventText = 'Driver declined offer; returned to YYC';
        break;

      case 'pickup':
        assigned();
        at('Assigned');
        await eligible(u.id, s);
        status = 'In transit';
        s.pickedUpAt = new Date().toISOString();
        s.pickupProof = { recipient: optional(input.recipient, 'Pickup contact', 150), reference: optional(input.reference, 'Pickup reference', 150), signatureName: optional(input.signatureName, 'Pickup signatory', 150), photoDocumentId: optional(input.photoDocumentId, 'Pickup photo document', 80) };
        if (s.promisedPickupAt) s.pickupSlaMet = Date.parse(s.pickedUpAt) <= Date.parse(s.promisedPickupAt);
        s.arrivedAt = null;
        eventText = 'Goods picked up';
        break;

      case 'arrival':
        assigned();
        at('Assigned', 'In transit');
        if (status === 'Assigned') { s.pickupArrivalAt = new Date().toISOString(); s.arrivedAt = 'pickup warehouse'; }
        else { s.deliveryArrivalAt = new Date().toISOString(); s.arrivedAt = 'receiving store'; }
        eventText = 'Driver recorded arrival at ' + s.arrivedAt;
        break;

      case 'deliver':
        assigned();
        at('In transit');
        check(!s.stops?.length || (s.stopProgress || []).length === s.stops.length && s.stopProgress.every(stop => stop.completedAt), 409, 'Complete every intermediate stop before final delivery.');
        check(!s.issue || s.issue.resolved, 409, 'YYC must resolve the open exception before completion.');
        s.pod = text(input.pod, 'Receipt reference', 150);
        s.recipient = text(input.recipient, 'Recipient', 150);
        s.deliveredAt = new Date().toISOString();
        const receivedQuantity = input.receivedQuantity == null || input.receivedQuantity === '' ? null : Number(input.receivedQuantity);
        check(receivedQuantity == null || (Number.isFinite(receivedQuantity) && receivedQuantity >= 0 && receivedQuantity <= 1000000), 400, 'Received quantity must be zero or a positive quantity.');
        s.deliveryProof = { signatureName: optional(input.signatureName, 'Recipient signature name', 150), photoDocumentId: optional(input.photoDocumentId, 'Delivery photo document', 80), receivedQuantity, shortage: optional(input.shortage, 'Shortage details', 1000), damage: optional(input.damage, 'Damage details', 1000), refused: optional(input.refused, 'Refused items', 1000), note: optional(input.proofNote, 'Delivery proof note', 1000) };
        s.deliveryOutcome = s.deliveryProof.shortage || s.deliveryProof.damage || s.deliveryProof.refused || receivedQuantity === 0 || (s.requestedQuantity != null && receivedQuantity != null && receivedQuantity < s.requestedQuantity) ? 'partial_or_damaged' : 'complete';
        if (s.promisedDeliveryAt) s.deliverySlaMet = Date.parse(s.deliveredAt) <= Date.parse(s.promisedDeliveryAt);
        status = 'Delivered';
        eventText = 'Delivery evidence recorded; goods delivered';
        break;

      case 'completeStop':
        assigned();
        at('In transit');
        check(Number.isInteger(input.stopIndex) && input.stopIndex >= 0 && input.stopIndex < (s.stops || []).length, 400, 'Invalid stop.');
        s.stopProgress = s.stopProgress || s.stops.map(() => ({}));
        check(input.stopIndex === s.stopProgress.findIndex(stop => !stop.completedAt), 409, 'Complete stops in route order.');
        check(s.stopProgress[input.stopIndex]?.arrivedAt, 409, 'Record arrival at this stop first.');
        check(!s.stopProgress[input.stopIndex]?.completedAt, 409, 'This stop is already complete.');
        const completedAt = new Date();
        const stopWindow = s.stops[input.stopIndex].window;
        const localTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Edmonton', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(completedAt);
        const [windowStart, windowEnd] = stopWindow.split(/[–-]/);
        const late = Boolean(stopWindow && stopWindow !== 'Flexible' && (localTime < windowStart || localTime > windowEnd));
        const stopReceivedQuantity = input.receivedQuantity == null || input.receivedQuantity === '' ? null : Number(input.receivedQuantity);
        check(stopReceivedQuantity == null || (Number.isFinite(stopReceivedQuantity) && stopReceivedQuantity >= 0 && stopReceivedQuantity <= 1000000), 400, 'Received quantity must be zero or a positive quantity.');
        s.stopProgress[input.stopIndex] = { ...s.stopProgress[input.stopIndex], completedAt: completedAt.toISOString(), note: optional(input.note, 'Stop note', 500), receipt: optional(input.receipt, 'Stop receipt', 150), signatureName: optional(input.signatureName, 'Recipient signature name', 150), photoDocumentId: optional(input.photoDocumentId, 'Stop photo document', 80), receivedQuantity: stopReceivedQuantity, shortage: optional(input.shortage, 'Shortage details', 1000), damage: optional(input.damage, 'Damage details', 1000), refused: optional(input.refused, 'Refused items', 1000), late };
        eventText = 'Intermediate stop ' + (input.stopIndex + 1) + ' completed' + (late ? ' outside its receiving window' : '') + (stopReceivedQuantity != null ? `; ${stopReceivedQuantity} received` : '');
        break;

      case 'arriveStop':
        assigned();
        at('In transit');
        check(Number.isInteger(input.stopIndex) && input.stopIndex >= 0 && input.stopIndex < (s.stops || []).length, 400, 'Invalid stop.');
        s.stopProgress = s.stopProgress || s.stops.map(() => ({}));
        check(input.stopIndex === s.stopProgress.findIndex(stop => !stop.completedAt), 409, 'Visit stops in route order.');
        check(!s.stopProgress[input.stopIndex]?.arrivedAt, 409, 'Arrival is already recorded for this stop.');
        s.stopProgress[input.stopIndex] = { ...s.stopProgress[input.stopIndex], arrivedAt: new Date().toISOString() };
        eventText = 'Driver arrived at intermediate stop ' + (input.stopIndex + 1);
        break;

      case 'issue':
        assigned();
        at('Assigned', 'In transit');
        check(!s.issue || s.issue.resolved, 409, 'An unresolved exception already exists.');
        {
          let dueAt = null;
          if (input.dueAt) {
            const requestedDueAt = text(input.dueAt, 'Resolution due time', 40);
            check(Number.isFinite(Date.parse(requestedDueAt)), 400, 'Resolution due time must be a valid date and time.');
            dueAt = new Date(requestedDueAt).toISOString();
          }
        s.issue = {
          reason: text(input.reason, 'Issue', 150),
          note: text(input.note, 'Issue details', 2000),
          severity: ['low', 'normal', 'high', 'critical'].includes(input.severity) ? input.severity : 'normal',
          dueAt,
          assignedTo: null,
          reportedAt: new Date().toISOString(),
          resolved: false
        };
        eventText = 'Delivery exception: ' + s.issue.reason;
        }
        break;

      case 'claim':
        await store();
        at('Delivered');
        check(!s.claim || s.claim.status !== 'open', 409, 'A claim is already open for this delivery.');
        s.claim = { type: ['shortage', 'damage', 'late', 'other'].includes(input.type) ? input.type : 'other', details: text(input.details, 'Claim details', 2000), status: 'open', openedAt: new Date().toISOString() };
        eventText = 'Customer opened a delivery claim: ' + s.claim.type;
        break;

      case 'resolveClaim':
        admin();
        check(s.claim?.status === 'open', 409, 'There is no open claim to resolve.');
        s.claim.status = 'resolved';
        s.claim.decision = ['accepted', 'declined', 'credit', 'replacement'].includes(input.decision) ? input.decision : 'declined';
        s.claim.resolution = text(input.resolution, 'Claim decision notes', 2000);
        s.claim.resolvedAt = new Date().toISOString();
        eventText = 'Broker resolved customer claim: ' + s.claim.decision;
        break;

      case 'resolve':
        admin();
        check(s.issue && !s.issue.resolved, 409, 'No unresolved exception.');
        s.issue.resolution = text(input.resolution, 'Resolution', 2000);
        s.issue.resolutionOutcome = ['resolved', 'follow_up', 'credit', 'cancelled'].includes(input.outcome) ? input.outcome : 'resolved';
        s.issue.resolvedAt = new Date().toISOString();
        s.issue.resolved = true;
        eventText = 'YYC resolved exception: ' + s.issue.resolution;
        break;

      case 'assignIssue':
        admin();
        check(s.issue && !s.issue.resolved, 409, 'No unresolved exception to assign.');
        {
          const assigneeId = text(input.assigneeId, 'Assigned broker', 80);
          const assignee = await client.query("SELECT id FROM users WHERE id = $1 AND role = 'admin' AND disabled = false", [assigneeId]);
          check(assignee.rowCount === 1, 404, 'Active broker account not found.');
          s.issue.assignedTo = assigneeId;
          eventText = 'Exception assigned to broker ' + assigneeId;
        }
        break;

      case 'change':
        admin();
        at('Awaiting quote', 'Quote ready', 'Ready to assign', 'Offered', 'Assigned');
        {
          let dest = text(input.destination, 'Destination', 350);
          let kg = number(Number(input.kg), 'Weight', 100000);
          let pallets = number(Number(input.pallets), 'Pallets', 100);
          let reason = text(input.reason, 'Reason', 1000);
          check(Number.isInteger(pallets), 400, 'Pallet count must be a whole number.');
          check(dest !== s.destination || kg !== s.kg || pallets !== s.pallets, 400, 'No material change was supplied.');

          s.quoteArchive = s.quoteArchive || [];
          s.quoteArchive.push({
            version: s.quoteVersion,
            price: s.price,
            rate: s.rate,
            destination: s.destination,
            kg: s.kg,
            pallets: s.pallets,
            status,
            reason
          });

          Object.assign(s, {
            destination: dest,
            kg,
            pallets,
            quoteVersion: s.quoteVersion + 1,
            price: null,
            rate: null,
            arrivedAt: null
          });

          driver = null;
          offered = null;
          status = 'Awaiting quote';
          eventText = 'Shipment revised to v' + s.quoteVersion + '; quote and assignment invalidated. Reason: ' + reason;
        }
        break;

      case 'cancel':
        if (u.role === 'store') {
          await store();
          at('Awaiting quote', 'Quote ready');
        } else {
          admin();
          at('Awaiting quote', 'Quote ready', 'Ready to assign', 'Offered', 'Assigned');
          const reason = text(input.reason, 'Cancellation reason', 500);
          eventText = 'Broker cancelled delivery: ' + reason;
        }
        status = 'Cancelled';
        driver = null;
        offered = null;
        s.bids = [];
        delete s.bidsExpiresAt;
        delete s.offerExpiresAt;
        delete s.quoteExpiresAt;
        if (!eventText) eventText = 'Delivery cancelled by store';
        break;

      case 'withdrawAssignment':
        assigned();
        at('Assigned');
        const withdrawalReason = text(input.reason, 'Withdrawal reason', 500);
        driver = null;
        status = 'Ready to assign';
        offered = null;
        eventText = 'Driver withdrew before pickup: ' + withdrawalReason;
        break;

      default:
        throw new AppError(400, 'Unsupported delivery action.');
    }

    await client.query(
      `UPDATE shipments
       SET status = $1, driver_id = $2, offered_to = $3, data = $4, version = version + 1, updated_at = NOW()
       WHERE id = $5`,
      [status, driver, offered, JSON.stringify(s), id]
    );

    await client.query(
      'INSERT INTO audit(shipment_id, actor_id, event, created_at) VALUES($1, $2, $3, NOW())',
      [id, u.id, eventText]
    );

    let updated = await client.query('SELECT * FROM shipments WHERE id = $1', [id]);
    return await serialize(updated.rows[0], u);
  });
}

export async function approve(u, uid) {
  check(u.role === 'admin', 403, 'Broker access is required.');

  return await transaction(async (client) => {
    let d = await user(uid);
    let t = await truck(uid);
    check(d?.role === 'driver' && t, 404, 'Driver/truck not found.');

    await client.query('UPDATE users SET approved = true WHERE id = $1', [uid]);
    await client.query('UPDATE trucks SET approved = true WHERE driver_id = $1', [uid]);
    await client.query(
      'INSERT INTO audit(shipment_id, actor_id, event, created_at) VALUES(null, $1, $2, NOW())',
      [u.id, 'Broker manually approved driver and truck: ' + d.name]
    );

    return await publicUser(await user(uid));
  });
}

export async function updateProfile(u, input) {
  let name = text(input.name, 'Name', 120);
  let p = jsonValue(u.profile);

  if (u.role === 'store') {
    p.address = text(input.address, 'Store address', 350);
    p.contact = text(input.contact, 'Receiving contact', 120);
  }
  if (input.phone != null) {
    p.phone = text(input.phone, 'Phone', 50);
  }
  if (u.role === 'driver' && input.availability != null) {
    const a = input.availability;
    check(a && typeof a === 'object' && !Array.isArray(a), 400, 'Availability settings are invalid.');
    const days = [...new Set((Array.isArray(a.days) ? a.days : []).map(Number))];
    check(days.length > 0 && days.every(day => Number.isInteger(day) && day >= 0 && day <= 6), 400, 'Select at least one valid working day.');
    const time = value => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
    check(time(a.startTime) && time(a.endTime) && a.startTime < a.endTime, 400, 'Working hours must be valid and finish after they start.');
    if (a.breakStart || a.breakEnd) check(time(a.breakStart) && time(a.breakEnd) && a.breakStart < a.breakEnd && a.breakStart >= a.startTime && a.breakEnd <= a.endTime, 400, 'Break must fall within the working day.');
    p.availability = { enabled: true, days, startTime: a.startTime, endTime: a.endTime, breakStart: a.breakStart || '', breakEnd: a.breakEnd || '' };
  }

  await query(
    'UPDATE users SET name = $1, profile = $2 WHERE id = $3',
    [name, JSON.stringify(p), u.id]
  );

  return await publicUser(await user(u.id));
}
