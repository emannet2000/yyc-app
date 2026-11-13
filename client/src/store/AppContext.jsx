import { createContext, useContext, useReducer, useEffect } from 'react';

// Initial state - data-oriented structure
const initialState = {
  user: null,
  isAuthenticated: false,
  role: null, // 'driver', 'store', 'admin' - locked to account, no switching
  shipments: [],
  loading: false,
  error: null,
  notifications: [],
};

// Action types
export const ACTIONS = {
  SET_USER: 'SET_USER',
  SET_LOADING: 'SET_LOADING',
  SET_ERROR: 'SET_ERROR',
  CLEAR_ERROR: 'CLEAR_ERROR',
  SET_SHIPMENTS: 'SET_SHIPMENTS',
  ADD_SHIPMENT: 'ADD_SHIPMENT',
  UPDATE_SHIPMENT: 'UPDATE_SHIPMENT',
  ADD_NOTIFICATION: 'ADD_NOTIFICATION',
  CLEAR_NOTIFICATIONS: 'CLEAR_NOTIFICATIONS',
  LOGOUT: 'LOGOUT',
};

// Reducer - pure data transformations
function appReducer(state, action) {
  switch (action.type) {
    case ACTIONS.SET_USER:
      return {
        ...state,
        user: action.payload,
        isAuthenticated: !!action.payload,
        role: action.payload?.role || null,
        loading: false,
      };

    case ACTIONS.SET_LOADING:
      return {
        ...state,
        loading: action.payload,
      };

    case ACTIONS.SET_ERROR:
      return {
        ...state,
        error: action.payload,
        loading: false,
      };

    case ACTIONS.CLEAR_ERROR:
      return {
        ...state,
        error: null,
      };

    case ACTIONS.SET_SHIPMENTS:
      return {
        ...state,
        shipments: action.payload,
      };

    case ACTIONS.ADD_SHIPMENT:
      return {
        ...state,
        shipments: [action.payload, ...state.shipments],
      };

    case ACTIONS.UPDATE_SHIPMENT:
      return {
        ...state,
        shipments: state.shipments.map(s =>
          s.id === action.payload.id ? action.payload : s
        ),
      };

    case ACTIONS.ADD_NOTIFICATION:
      return {
        ...state,
        notifications: [action.payload, ...state.notifications],
      };

    case ACTIONS.CLEAR_NOTIFICATIONS:
      return {
        ...state,
        notifications: [],
      };

    case ACTIONS.LOGOUT:
      return {
        ...initialState,
      };

    default:
      return state;
  }
}

// Create context
const AppContext = createContext(null);

// Provider component
export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(appReducer, initialState);

  // Auto-restore session on mount
  useEffect(() => {
    const token = localStorage.getItem('token');
    if (token) {
      // Validate session with server
      fetch('/api/state', {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      })
        .then(res => {
          if (!res.ok) throw new Error('Session expired');
          return res.json();
        })
        .then(data => {
          dispatch({ type: ACTIONS.SET_USER, payload: data.user });
          dispatch({ type: ACTIONS.SET_SHIPMENTS, payload: data.shipments || [] });
        })
        .catch(() => {
          localStorage.removeItem('token');
          localStorage.removeItem('csrf');
        });
    }
  }, []);

  return (
    <AppContext.Provider value={{ state, dispatch }}>
      {children}
    </AppContext.Provider>
  );
}

// Custom hook for using the app context
export function useApp() {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within AppProvider');
  }
  return context;
}
