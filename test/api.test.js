import { describe, it, expect, beforeEach, vi } from 'vitest';
import api from '../client/src/services/api.js';

// Mock fetch globally
global.fetch = vi.fn();

beforeEach(() => {
  // Clear all mocks before each test
  vi.clearAllMocks();
  // Clear localStorage
  localStorage.clear();
});

describe('API Service', () => {
  describe('login', () => {
    it('should store token on successful login', async () => {
      const mockUser = {
        id: '123',
        name: 'Test User',
        email: 'test@example.com',
        role: 'store',
      };

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token: 'test-token',
          csrf: 'test-csrf',
          user: mockUser,
        }),
      });

      const user = await api.login('test@example.com', 'password123');

      expect(user).toEqual(mockUser);
      expect(localStorage.getItem('token')).toBe('test-token');
      expect(localStorage.getItem('csrf')).toBe('test-csrf');
    });

    it('should throw error on failed login', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'Invalid credentials' }),
      });

      await expect(api.login('wrong@example.com', 'wrong')).rejects.toThrow('Invalid credentials');
    });
  });

  describe('register', () => {
    it('should register a new store owner', async () => {
      const userData = {
        role: 'store',
        name: 'Test Store',
        email: 'store@example.com',
        password: 'password123456',
        phone: '123-456-7890',
        address: '123 Main St',
        contact: 'John Doe',
      };

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          user: { ...userData, id: '123' },
          emailSent: true,
          message: 'Check your email for verification code',
        }),
      });

      const response = await api.register(userData);

      expect(response.user.email).toBe('store@example.com');
      expect(response.emailSent).toBe(true);
    });

    it('should register a new driver', async () => {
      const userData = {
        role: 'driver',
        name: 'Test Driver',
        email: 'driver@example.com',
        password: 'password123456',
        phone: '123-456-7890',
        truck: 'Freightliner M2',
        plate: 'ABC-123',
        type: 'Box truck',
        kg: 3500,
        pallets: 8,
        area: 'Calgary',
        liftgate: true,
      };

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          user: { ...userData, id: '456', approved: false },
          emailSent: true,
        }),
      });

      const response = await api.register(userData);

      expect(response.user.role).toBe('driver');
      expect(response.user.approved).toBe(false);
    });
  });

  describe('verifyEmail', () => {
    it('should verify email with correct code', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      const result = await api.verifyEmail('test@example.com', '123456');

      expect(result.success).toBe(true);
    });

    it('should reject invalid verification code', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'Invalid or expired verification code' }),
      });

      await expect(api.verifyEmail('test@example.com', '000000')).rejects.toThrow('Invalid or expired');
    });
  });

  describe('logout', () => {
    it('should clear tokens on logout', async () => {
      localStorage.setItem('token', 'test-token');
      localStorage.setItem('csrf', 'test-csrf');

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      await api.logout();

      expect(localStorage.getItem('token')).toBeNull();
      expect(localStorage.getItem('csrf')).toBeNull();
    });
  });

  describe('createShipment', () => {
    it('should create a new shipment', async () => {
      const shipmentData = {
        pickup: 'Calgary warehouse',
        destination: 'Store location',
        date: '2026-11-20',
        window: '09:00–12:00',
        goods: 'Household supplies',
        pallets: 4,
        kg: 900,
        type: 'Box truck',
        unloading: 'Store has a loading dock',
        pickupContact: 'Warehouse manager',
        receivingContact: 'Store manager',
      };

      const mockShipment = {
        id: 'YYC-1043',
        ...shipmentData,
        status: 'Awaiting quote',
      };

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockShipment,
      });

      const result = await api.createShipment(shipmentData);

      expect(result.id).toBe('YYC-1043');
      expect(result.status).toBe('Awaiting quote');
    });
  });

  describe('API authentication headers', () => {
    it('should include Authorization header when token exists', async () => {
      localStorage.setItem('token', 'test-token');
      localStorage.setItem('csrf', 'test-csrf');

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ user: {}, shipments: [] }),
      });

      await api.fetchState();

      expect(global.fetch).toHaveBeenCalledWith(
        '/api/state',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-token',
            'X-CSRF-Token': 'test-csrf',
          }),
        })
      );
    });
  });
});
