import { describe, expect, it } from 'vitest';

import { experimentalFeatureSourceLabel, localizeExperimentalFeature } from './experimental-features';

describe('experimental feature localization', () => {
  it('presents every known Desktop feature in Chinese', () => {
    for (const id of [
      'secondary-model',
      'team_collaboration',
      'tool-select',
      'persistence_minidb_readmodel',
    ]) {
      const copy = localizeExperimentalFeature(id);
      expect(copy.title).toMatch(/[\u4E00-\u9FFF]/);
      expect(copy.description).toMatch(/[\u4E00-\u9FFF]/);
    }
  });

  it('uses a Chinese fallback without exposing an unknown technical id as copy', () => {
    expect(localizeExperimentalFeature('future_internal_flag')).toEqual({
      title: '未命名实验功能',
      description: '由当前运行时提供的实验功能。',
    });
    expect(experimentalFeatureSourceLabel('future-source')).toBe('运行时');
  });
});
