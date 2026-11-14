import { describe, it, expect } from 'vitest';
import { guarded } from '../../src/util/guard.js';

describe('guarded', () => {
  it('reports a failure to #bot-status instead of throwing', async () => {
    const reports: string[] = [];
    await guarded('📦 reaction', async () => {
      throw new Error('db down');
    }, async (t) => {
      reports.push(t);
    });
    expect(reports).toEqual(['📦 reaction failed: db down']);
  });

  it('survives a reporter that itself fails', async () => {
    await expect(
      guarded('x', async () => Promise.reject(new Error('a')), async () => Promise.reject(new Error('b'))),
    ).resolves.toBeUndefined();
  });

  it('stays quiet on success', async () => {
    const reports: string[] = [];
    await guarded('x', async () => 1, async (t) => {
      reports.push(t);
    });
    expect(reports).toEqual([]);
  });
});
