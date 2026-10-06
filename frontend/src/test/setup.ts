/// <reference types="vitest" />
import '@testing-library/jest-dom/vitest';

/**
 * Frontend test setup.
 *
 * jsdom does not implement `matchMedia`, `ResizeObserver` or `IntersectionObserver`,
 * all of which Recharts and the layout code touch. Stubbing them here keeps every
 * test file free of environment boilerplate.
 */
if (typeof window !== 'undefined') {
  window.matchMedia =
    window.matchMedia ??
    ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }));

  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  window.ResizeObserver =
    window.ResizeObserver ?? (ResizeObserverStub as unknown as typeof ResizeObserver);

  class IntersectionObserverStub {
    readonly root = null;
    readonly rootMargin = '';
    readonly thresholds: readonly number[] = [];
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] {
      return [];
    }
  }
  window.IntersectionObserver =
    window.IntersectionObserver ??
    (IntersectionObserverStub as unknown as typeof IntersectionObserver);
}