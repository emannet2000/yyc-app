-- YYC Brokers PostgreSQL Schema
-- Migrated from SQLite to PostgreSQL for production scalability

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table (stores, drivers, admins)
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('store', 'driver', 'admin')),
  name TEXT NOT NULL,
  profile JSONB NOT NULL DEFAULT '{}',
  approved BOOLEAN NOT NULL DEFAULT false,
  disabled BOOLEAN NOT NULL DEFAULT false,
  email_verified BOOLEAN NOT NULL DEFAULT false,
  stripe_account_id TEXT,
  stripe_onboarded BOOLEAN NOT NULL DEFAULT false,
  mfa_enabled BOOLEAN NOT NULL DEFAULT false,
  mfa_secret TEXT,
  backup_codes TEXT,
  notification_preferences JSONB NOT NULL DEFAULT '{"email":true,"sms":false,"push":true}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_preferences JSONB NOT NULL DEFAULT '{"email":true,"sms":false,"push":true}'::jsonb;

CREATE TABLE IF NOT EXISTS store_team_memberships (
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permissions JSONB NOT NULL DEFAULT '{"shipments.read":true}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(owner_user_id, member_user_id),
  CHECK(owner_user_id <> member_user_id)
);
CREATE INDEX IF NOT EXISTS idx_store_team_member ON store_team_memberships(member_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_store_team_member_unique ON store_team_memberships(member_user_id);

CREATE TABLE IF NOT EXISTS account_deletion_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_by UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  decision_notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_account_deletion_pending ON account_deletion_requests(status, requested_at);

-- Trucks table (one truck per driver)
CREATE TABLE IF NOT EXISTS trucks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  driver_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  plate TEXT NOT NULL UNIQUE,
  profile JSONB NOT NULL DEFAULT '{}',
  approved BOOLEAN NOT NULL DEFAULT false
);

-- Sessions table (Redis will handle this in production, but keep for local dev)
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);

-- Shipments table
CREATE TABLE IF NOT EXISTS shipments (
  id TEXT PRIMARY KEY,
  store_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  driver_id UUID REFERENCES users(id) ON DELETE SET NULL,
  offered_to UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  data JSONB NOT NULL,
  payment_intent_id TEXT,
  payment_status TEXT DEFAULT 'pending' CHECK(payment_status IN ('pending', 'processing', 'succeeded', 'failed', 'refunded')),
  payment_amount DECIMAL(10, 2),
  payout_transfer_id TEXT,
  payout_status TEXT DEFAULT 'pending' CHECK(payout_status IN ('pending', 'processing', 'paid', 'failed')),
  payout_amount DECIMAL(10, 2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Audit log table
CREATE TABLE IF NOT EXISTS audit (
  id SERIAL PRIMARY KEY,
  shipment_id TEXT REFERENCES shipments(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  event TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Counters table (for shipment ID generation)
CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

-- Initialize shipment counter
INSERT INTO counters(name, value) VALUES('shipment', 1000) ON CONFLICT DO NOTHING;

-- Documents table (driver licenses, insurance, POD, invoices)
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shipment_id TEXT REFERENCES shipments(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('license', 'insurance', 'registration', 'pod', 'invoice', 'receipt')),
  s3_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  file_size INTEGER,
  content_type TEXT,
  expiry_date DATE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'expired')),
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- GPS Locations table (real-time driver tracking)
CREATE TABLE IF NOT EXISTS gps_locations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shipment_id TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  driver_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  latitude DECIMAL(10, 8) NOT NULL,
  longitude DECIMAL(11, 8) NOT NULL,
  accuracy DECIMAL(8, 2),
  speed DECIMAL(6, 2),
  heading DECIMAL(5, 2),
  altitude DECIMAL(8, 2),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Notification Tokens table (push notifications)
CREATE TABLE IF NOT EXISTS notification_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  platform TEXT NOT NULL CHECK(platform IN ('ios', 'android', 'web')),
  device_info JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, token)
);

CREATE TABLE IF NOT EXISTS user_notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shipment_id TEXT REFERENCES shipments(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_notifications_unread ON user_notifications(user_id, created_at DESC) WHERE read_at IS NULL;

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_trucks_driver ON trucks(driver_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_shipments_store ON shipments(store_id);
CREATE INDEX IF NOT EXISTS idx_shipments_driver ON shipments(driver_id);
CREATE INDEX IF NOT EXISTS idx_shipments_offered ON shipments(offered_to);
CREATE INDEX IF NOT EXISTS idx_shipments_status ON shipments(status);
CREATE INDEX IF NOT EXISTS idx_shipments_store_status ON shipments(store_id, status);
CREATE INDEX IF NOT EXISTS idx_shipments_driver_status ON shipments(driver_id, status);
CREATE INDEX IF NOT EXISTS idx_audit_shipment ON audit(shipment_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit(created_at);
CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id);
CREATE INDEX IF NOT EXISTS idx_documents_shipment ON documents(shipment_id);
CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(type);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
CREATE INDEX IF NOT EXISTS idx_documents_expiry ON documents(expiry_date);
CREATE INDEX IF NOT EXISTS idx_gps_shipment ON gps_locations(shipment_id);
CREATE INDEX IF NOT EXISTS idx_gps_driver ON gps_locations(driver_id);
CREATE INDEX IF NOT EXISTS idx_gps_recorded ON gps_locations(recorded_at);
CREATE INDEX IF NOT EXISTS idx_gps_shipment_recorded ON gps_locations(shipment_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_tokens_user ON notification_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_notification_tokens_platform ON notification_tokens(platform);
