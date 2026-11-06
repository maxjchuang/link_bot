import { describe, expect, it } from 'vitest';
import { SemanticProjectClassifier } from '../../src/projects/SemanticProjectClassifier.js';

const projects = [
  { id: 'store-web', name: 'Store Web', path: '/web', description: 'frontend React web UI', codexArgs: [] },
  { id: 'store-api', name: 'Store API', path: '/api', description: 'backend Go service', codexArgs: [] },
];
describe('SemanticProjectClassifier', () => {
  it('ranks configured frontend responsibilities without a product-specific boost', () => {
    const result = new SemanticProjectClassifier().classify({ requestText: '前端页面样式没有对齐', projects });
    expect(result[0]).toMatchObject({ projectId: 'store-web', confidence: 0.38 });
    expect(result[0]!.confidence).toBeLessThan(0.85);
  });
  it('gives high confidence to an explicitly named authorized project', () => {
    const result = new SemanticProjectClassifier().classify({ requestText: 'Store Web 的页面样式没有对齐', projects });
    expect(result[0]).toMatchObject({ projectId: 'store-web', confidence: 0.99 });
  });
  it('does not invent candidates outside the configured catalog', () => {
    expect(new SemanticProjectClassifier().classify({ requestText: 'inspect another product', projects: [] })).toEqual([]);
  });
});
