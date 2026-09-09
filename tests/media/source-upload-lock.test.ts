import { describe, expect, it } from 'vitest';
import {
  getCreativeSourceUploadInFlight,
  releaseCreativeSourceUpload,
  subscribeCreativeSourceUploadInFlight,
  tryAcquireCreativeSourceUpload,
} from '@/lib/media/source-upload-lock';

describe('creative source upload lock', () => {
  it('survives a composer remount and blocks a replacement batch until release', () => {
    const snapshots: boolean[] = [];
    const unsubscribe = subscribeCreativeSourceUploadInFlight(() => {
      snapshots.push(getCreativeSourceUploadInFlight());
    });

    expect(getCreativeSourceUploadInFlight()).toBe(false);
    expect(tryAcquireCreativeSourceUpload()).toBe(true);
    expect(getCreativeSourceUploadInFlight()).toBe(true);

    // A replacement composer instance sees the same shared lease and cannot
    // admit a second upload while the original async batch is still pending.
    expect(tryAcquireCreativeSourceUpload()).toBe(false);

    releaseCreativeSourceUpload();
    expect(getCreativeSourceUploadInFlight()).toBe(false);
    expect(snapshots).toEqual([true, false]);

    expect(tryAcquireCreativeSourceUpload()).toBe(true);
    releaseCreativeSourceUpload();
    unsubscribe();
  });
});
