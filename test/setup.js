import '@testing-library/jest-dom';
import { afterEach } from 'vitest';

// happy-dom provides real localStorage and location; reset them between tests
// instead of replacing them (they are getter-only on the window).
afterEach(() => {
  if (typeof window === 'undefined') return;
  window.localStorage.clear();
  window.location.hash = '';
});
