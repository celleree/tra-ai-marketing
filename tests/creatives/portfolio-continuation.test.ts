import { afterEach, describe, expect, it, vi } from 'vitest';
import { readPortfolioPause, writePortfolioContinuation, type PortfolioPauseReason } from '@/lib/creatives/portfolio-continuation';

afterEach(() => vi.unstubAllGlobals());
describe('browser-local portfolio continuation explanation', () => {
  it.each(['hidden', 'pagehide', 'navigation', 'explicit-stop', 'error', 'unknown'] as PortfolioPauseReason[])(
    'retains %s per portfolio across reopening without server authority', reason => {
      const values = new Map<string, string>();
      vi.stubGlobal('window', { localStorage: { getItem: (key: string) => values.get(key),
        setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } });
      writePortfolioContinuation('portfolio-a', reason);
      expect(readPortfolioPause('portfolio-a')).toBe(reason);
      expect(readPortfolioPause('portfolio-b')).toBeNull();
      writePortfolioContinuation('portfolio-a', 'active');
      expect(readPortfolioPause('portfolio-a')).toBe('unknown');
      writePortfolioContinuation('portfolio-a', null);
      expect(readPortfolioPause('portfolio-a')).toBeNull();
    });
  it('fails safely when local storage is unavailable or has an unknown value', () => {
    vi.stubGlobal('window', { get localStorage() { throw new Error('Storage disabled'); } });
    expect(() => writePortfolioContinuation('portfolio-a', 'hidden')).not.toThrow();
    expect(readPortfolioPause('portfolio-a')).toBeNull();
    vi.stubGlobal('window', { localStorage: { getItem: () => 'invented-event' } });
    expect(readPortfolioPause('portfolio-a')).toBeNull();
  });
});
