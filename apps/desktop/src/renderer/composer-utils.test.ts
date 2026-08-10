import { describe, expect, it } from 'vitest';

import {
  cacheMetrics,
  clampComposerHeight,
  composerMaxHeight,
  contextPercentage,
  contextProgress,
  DEFAULT_COMPOSER_HEIGHT,
  formatTokenCount,
  imageFileError,
  MAX_INLINE_IMAGE_BYTES,
  modelImageInputSupport,
  parseComposerHeight,
} from './composer-utils';

describe('composer usage metrics', () => {
  it('keeps context overflow visible while clamping progress', () => {
    expect(contextPercentage(0.37)).toBe(37);
    expect(contextPercentage(1.2)).toBe(120);
    expect(contextProgress(1.2)).toBe(100);
    expect(contextPercentage(Number.NaN)).toBe(0);
  });

  it('calculates cumulative cache hits from all input token classes', () => {
    expect(cacheMetrics({
      total: { inputOther: 300, output: 20, inputCacheRead: 600, inputCacheCreation: 100 },
    })).toEqual({
      cacheRead: 600,
      cacheCreation: 100,
      inputOther: 300,
      inputTotal: 1_000,
      hitRate: 60,
    });
    expect(cacheMetrics(undefined)).toBeUndefined();
    expect(cacheMetrics({ total: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } })?.hitRate).toBe(0);
  });

  it('formats token counts in compact binary units', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(1_536)).toBe('1.5k');
    expect(formatTokenCount(262_144)).toBe('256k');
    expect(formatTokenCount(1_572_864)).toBe('1.5M');
  });
});

describe('composer height', () => {
  it('clamps persisted and dragged values to viewport bounds', () => {
    expect(composerMaxHeight(760)).toBe(342);
    expect(clampComposerHeight(500, 760)).toBe(342);
    expect(clampComposerHeight(20, 1_040)).toBe(64);
    expect(parseComposerHeight('180', 1_040)).toBe(180);
    expect(parseComposerHeight('invalid', 1_040)).toBe(DEFAULT_COMPOSER_HEIGHT);
    expect(parseComposerHeight(null, 1_040)).toBe(DEFAULT_COMPOSER_HEIGHT);
  });
});

describe('composer images', () => {
  it('accepts supported images and rejects invalid type and size', () => {
    expect(imageFileError({ name: 'image.png', type: 'image/png', size: 10 })).toBeUndefined();
    expect(imageFileError({ name: 'notes.txt', type: 'text/plain', size: 10 })).toMatchObject({ code: 'media.unsupported_type' });
    expect(imageFileError({ name: 'empty.png', type: 'image/png', size: 0 })).toMatchObject({ code: 'media.invalid_size' });
    expect(imageFileError({ name: 'large.png', type: 'image/png', size: MAX_INLINE_IMAGE_BYTES + 1 })).toMatchObject({ code: 'media.invalid_size' });
  });

  it('distinguishes declared image support from unsupported and unknown models', () => {
    expect(modelImageInputSupport({ capabilities: ['image_in', 'tool_use'] })).toBe('supported');
    expect(modelImageInputSupport({ capabilities: ['thinking', 'tool_use'] })).toBe('unsupported');
    expect(modelImageInputSupport({ provider: 'local' })).toBe('unknown');
    expect(modelImageInputSupport({
      capabilities: ['image_in'],
      overrides: { capabilities: ['tool_use'] },
    })).toBe('unsupported');
    expect(modelImageInputSupport({
      capabilities: ['tool_use'],
      overrides: { capabilities: ['image_in'] },
    })).toBe('supported');
  });
});
