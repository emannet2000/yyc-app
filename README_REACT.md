# YYC Brokers - React Frontend

This is the React-based frontend for the YYC Brokers trucking and delivery platform, rewritten with data-oriented JavaScript principles and proper separation of concerns.

## Features

✅ **Data-Oriented Architecture**: Business logic separated from UI components
✅ **State Management**: Centralized state using Context API with reducers
✅ **Role-Based Access**: Each account is locked to one role (driver, store owner, or broker)
✅ **Email Verification**: Secure email verification for driver and store accounts
✅ **No Role Switching**: Users can only access features for their registered role

## Architecture

### Folder Structure

```
client/
├── src/
│   ├── components/       # Reusable UI components
│   ├── pages/            # Page components (Login, Register, Dashboards)
│   ├── store/            # State management (AppContext, reducers)
│   ├── services/         # Business logic layer (API calls)
│   ├── hooks/            # Custom React hooks
│   ├── utils/            # Utility functions
│   ├── styles/           # CSS files
│   └── assets/           # Static assets
└── index.html            # Entry HTML file
```

### Data-Oriented Design

1. **State Management** (`src/store/AppContext.jsx`):
   - Pure reducers for data transformations
   - Centralized state with no side effects
   - Clear action types and payload structures

2. **Business Logic** (`src/services/api.js`):
   - All API calls isolated in service layer
   - Separated from UI components
   - Reusable across components

3. **UI Components** (`src/pages/`):
   - Presentation logic only
   - No business logic or data fetching
   - Uses hooks to access state and services

## Account Roles

Each account is **permanently locked** to its registered role. No role switching is allowed.

### 🏪 Store Owner
- Request deliveries
- View and accept quotes
- Track shipments
- Manage store profile

### 🚚 Driver
- View and accept job offers
- Track assigned deliveries
- Confirm pickups and deliveries
- Manage truck profile

### ⚙️ Broker (Admin)
- Manage all shipments
- Send quotes to stores
- Offer jobs to drivers
- Approve driver registrations

## Running the Application

### Prerequisites
- Node.js >= 24.0.0
- PostgreSQL database
- Redis instance

### Development Setup

1. **Install dependencies**:
```bash
npm install
```

2. **Set up environment variables** (`.env`):
```env
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/yyc_brokers

# Redis
REDIS_URL=redis://localhost:6379

# Email (optional for development)
RESEND_API_KEY=your_resend_api_key_here
FROM_EMAIL=YYC Brokers <noreply@yycbrokers.com>

# Server
PORT=3000
PUBLIC_ORIGIN=http://localhost:5173
```

3. **Run database migrations**:
```bash
npm run migrate
```

4. **Start the backend server**:
```bash
npm run dev
```

5. **In a new terminal, start the React dev server**:
```bash
npm run client
```

6. **Access the application**:
   - Frontend: http://localhost:5173
   - Backend API: http://localhost:3000

## Email Verification

### Development Mode (No Email Service)

If `RESEND_API_KEY` is not configured:
- Registration will still work
- Verification codes will be **printed to the console**
- Check the terminal running `npm run dev` for the 6-digit code
- Enter this code in the verification screen

### Production Mode (With Email Service)

1. Sign up for a Resend account at https://resend.com
2. Add your API key to `.env`:
   ```env
   RESEND_API_KEY=re_xxxxxxxxxxxxx
   FROM_EMAIL=YYC Brokers <noreply@yourdomain.com>
   ```
3. Verification codes will be sent via email

## User Flows

### Store Owner Registration
1. Click "Create Account"
2. Select "Store Owner"
3. Fill in store details (name, address, contact, email, password)
4. Submit registration
5. Check email (or console) for verification code
6. Enter 6-digit code
7. Access store dashboard

### Driver Registration
1. Click "Create Account"
2. Select "Driver"
3. Fill in personal details
4. Fill in truck details (make, plate, capacity, etc.)
5. Submit registration
6. Check email (or console) for verification code
7. Enter 6-digit code
8. **Wait for broker approval** before accepting jobs
9. Access driver dashboard

### Broker Registration
1. Click "Create Account"
2. Select "YYC Broker"
3. Fill in details and **broker registration code**
4. Submit registration
5. **No email verification required**
6. Access broker dashboard immediately

**Note**: To get a broker registration code, set it in your `.env`:
```env
BROKER_REGISTRATION_CODES=YYC2024BROKER,ANOTHER_CODE
```

Or use the setup script:
```bash
npm run setup-admin
```

## Key Differences from Old Frontend

### Old (Vanilla JS):
- ❌ All code in one large file
- ❌ Global state mixed with UI
- ❌ Role switching/impersonation
- ❌ Business logic in UI code

### New (React):
- ✅ Modular component structure
- ✅ Centralized state management
- ✅ Role-locked accounts (no switching)
- ✅ Business logic in service layer
- ✅ Data-oriented architecture

## Building for Production

```bash
npm run client:build
```

This will create optimized production files in `public/dist/`.

## API Integration

The React frontend communicates with the Node.js backend API:

- **Authentication**: `/api/register`, `/api/login`, `/api/verify-email`
- **State**: `/api/state` (loads user and shipments)
- **Shipments**: `/api/shipments` (CRUD operations)
- **Profile**: `/api/profile` (update user profile)
- **Admin**: `/api/admin/*` (broker-only endpoints)

All API calls are handled through `src/services/api.js`.

## Security Features

- ✅ JWT token-based authentication
- ✅ CSRF protection
- ✅ Email verification for drivers and stores
- ✅ Rate limiting on sensitive endpoints
- ✅ Role-based access control (no role switching)
- ✅ Password minimum length: 12 characters

## Troubleshooting

### "Session expired" on page refresh
- The app auto-restores session from localStorage
- If you see this error, the backend session may have expired
- Just log in again

### Verification code not received
- Check the **console output** of `npm run dev` terminal
- The code is printed there when email service is not configured
- Code format: 6 digits (e.g., 123456)

### Cannot access features after login
- Drivers: Must be **approved by broker** first
- Check `user.approved` in profile
- Contact broker to approve driver account

## License

UNLICENSED - Internal use only
