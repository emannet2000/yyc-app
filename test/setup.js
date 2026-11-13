import '@testing-library/jest-dom';

// Mock localStorage for tests
global.localStorage = {
  getItem: (key) => global.localStorage[key] || null,
  setItem: (key, value) => { global.localStorage[key] = value; },
  removeItem: (key) => { delete global.localStorage[key]; },
  clear: () => {
    Object.keys(global.localStorage).forEach(key => {
      if (typeof global.localStorage[key] !== 'function') {
        delete global.localStorage[key];
      }
    });
  },
};

// Mock window.location.hash
delete window.location;
window.location = { hash: '' };
