import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppProvider } from '../client/src/store/AppContext';
import Login from '../client/src/pages/Login';
import Register from '../client/src/pages/Register';

// Mock API module
vi.mock('../client/src/services/api.js', () => ({
  default: {
    login: vi.fn(),
    register: vi.fn(),
    verifyEmail: vi.fn(),
    fetchState: vi.fn(),
  },
}));

import api from '../client/src/services/api.js';

describe('Login Component', () => {
  it('renders login form', () => {
    render(
      <AppProvider>
        <Login />
      </AppProvider>
    );

    expect(screen.getByText('Welcome Back')).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('displays error on failed login', async () => {
    api.login.mockRejectedValueOnce(new Error('Invalid credentials'));

    render(
      <AppProvider>
        <Login />
      </AppProvider>
    );

    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/email/i), 'wrong@example.com');
    await user.type(screen.getByLabelText(/password/i), 'wrongpassword');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getByText(/invalid credentials/i)).toBeInTheDocument();
    });
  });

  it('submits login form successfully', async () => {
    const mockUser = {
      id: '123',
      name: 'Test User',
      email: 'test@example.com',
      role: 'store',
    };

    api.login.mockResolvedValueOnce(mockUser);
    api.fetchState.mockResolvedValueOnce({
      user: mockUser,
      shipments: [],
    });

    render(
      <AppProvider>
        <Login />
      </AppProvider>
    );

    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.type(screen.getByLabelText(/password/i), 'password123456');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(api.login).toHaveBeenCalledWith('test@example.com', 'password123456');
    });
  });
});

describe('Register Component', () => {
  it('renders role selection on step 1', () => {
    render(
      <AppProvider>
        <Register />
      </AppProvider>
    );

    expect(screen.getByText('Join YYC Brokers')).toBeInTheDocument();
    expect(screen.getByText('Store Owner')).toBeInTheDocument();
    expect(screen.getByText('Driver')).toBeInTheDocument();
    expect(screen.getByText('YYC Broker')).toBeInTheDocument();
  });

  it('navigates to store registration form when role selected', async () => {
    render(
      <AppProvider>
        <Register />
      </AppProvider>
    );

    const user = userEvent.setup();

    const storeButton = screen.getByRole('button', { name: /store owner/i });
    await user.click(storeButton);

    await waitFor(() => {
      expect(screen.getByText(/create store owner account/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/store.*business name/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/store delivery address/i)).toBeInTheDocument();
    });
  });

  it('navigates to driver registration form when role selected', async () => {
    render(
      <AppProvider>
        <Register />
      </AppProvider>
    );

    const user = userEvent.setup();

    const driverButton = screen.getByRole('button', { name: /driver/i });
    await user.click(driverButton);

    await waitFor(() => {
      expect(screen.getByText(/create driver account/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/truck make.*model/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/license plate/i)).toBeInTheDocument();
    });
  });

  it('validates password match', async () => {
    render(
      <AppProvider>
        <Register />
      </AppProvider>
    );

    const user = userEvent.setup();

    // Select store role
    await user.click(screen.getByRole('button', { name: /store owner/i }));

    // Fill in form with mismatched passwords
    await user.type(screen.getByLabelText(/store.*business name/i), 'Test Store');
    await user.type(screen.getByLabelText(/email/i), 'store@example.com');
    await user.type(screen.getByLabelText(/phone/i), '123-456-7890');
    await user.type(screen.getByLabelText(/^password/i), 'password123456');
    await user.type(screen.getByLabelText(/confirm password/i), 'different');
    await user.type(screen.getByLabelText(/store delivery address/i), '123 Main St');
    await user.type(screen.getByLabelText(/receiving contact/i), 'John Doe');

    await user.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => {
      expect(screen.getByText(/passwords do not match/i)).toBeInTheDocument();
    });
  });

  it('validates minimum password length', async () => {
    render(
      <AppProvider>
        <Register />
      </AppProvider>
    );

    const user = userEvent.setup();

    // Select store role
    await user.click(screen.getByRole('button', { name: /store owner/i }));

    // Fill in form with short password
    await user.type(screen.getByLabelText(/store.*business name/i), 'Test Store');
    await user.type(screen.getByLabelText(/email/i), 'store@example.com');
    await user.type(screen.getByLabelText(/phone/i), '123-456-7890');
    await user.type(screen.getByLabelText(/^password/i), 'short');
    await user.type(screen.getByLabelText(/confirm password/i), 'short');
    await user.type(screen.getByLabelText(/store delivery address/i), '123 Main St');
    await user.type(screen.getByLabelText(/receiving contact/i), 'John Doe');

    await user.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => {
      expect(screen.getByText(/password must be at least 12 characters/i)).toBeInTheDocument();
    });
  });
});

describe('AppContext', () => {
  it('provides initial state', () => {
    const TestComponent = () => {
      const { state } = require('../client/src/store/AppContext').useApp();
      return (
        <div>
          <span data-testid="auth">{String(state.isAuthenticated)}</span>
          <span data-testid="role">{state.role || 'none'}</span>
        </div>
      );
    };

    render(
      <AppProvider>
        <TestComponent />
      </AppProvider>
    );

    expect(screen.getByTestId('auth').textContent).toBe('false');
    expect(screen.getByTestId('role').textContent).toBe('none');
  });
});
