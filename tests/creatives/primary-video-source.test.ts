import { describe, expect, it } from 'vitest';
import { primaryVideoGuidance, primaryVideoDirection, primaryVideoRenderDirection } from '@/lib/creatives/primary-video-source';
import type { PlanningSourceAnalysisState } from '@/lib/creatives/planning-source-packet';

const source = { role: 'TRA_VIDEO', mediaId: `media_${'a'.repeat(32)}`, sha256: 'b'.repeat(64) };
const completed = (person = true): PlanningSourceAnalysisState => ({ version: 1, entries: [{
  source, analyzer: { kind: 'VIDEO_INTELLIGENCE', model: 'fixture', schemaVersion: 1, contextSha256: null },
  evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION', result: { kind: 'VIDEO_INTELLIGENCE', intelligence: {
    observations: [{ timestampMs: 1500, observation: { sceneType: person ? 'PERSON' : 'DOCUMENT',
      summary: 'A spokesperson explains the consultation process.', composition: 'Person seated beside a desk.',
      visibleText: ['Understand your options'], uncertainties: [] } }],
    transcript: { windows: [{ segments: [{ startMs: 1000, endMs: 2000, text: 'We explain the available options.' }] }] },
  } },
}] } as unknown as PlanningSourceAnalysisState);

describe('primary video source evidence', () => {
  it('projects completed Video Intelligence into actual primary analysis rather than no-source guidance', () => {
    const guidance = primaryVideoGuidance(completed())!;
    expect(guidance.analysis.summary).toContain('spokesperson');
    expect(guidance.analysis.hookOrAngle).toContain('1000-2000ms: We explain');
    expect(guidance.analysis.visualStructure).toContain('1500ms: Person seated');
    expect(guidance.analysis.visibleText).toEqual(['Understand your options']);
    expect(guidance.hasHuman).toBe(true);
    const prompt = primaryVideoDirection(guidance);
    expect(prompt).toContain(source.mediaId); expect(prompt).toContain(source.sha256);
    expect(prompt).toContain('Company knowledge supports brand and verified facts');
    expect(prompt).toContain('at least one concept');
    expect(prompt).not.toContain('No source image');
    const render = primaryVideoRenderDirection(guidance);
    expect(render).toContain('spokesperson'); expect(render).toContain(source.mediaId);
    expect(render).not.toContain('We explain the available options.');
    expect(render).not.toContain('Understand your options');
  });
  it('keeps deliberate no-reference input separate and does not invent a person for document-only video', () => {
    expect(primaryVideoGuidance({ version: 1, entries: [] })).toBeNull();
    expect(primaryVideoGuidance(completed(false))!.hasHuman).toBe(false);
    expect(primaryVideoDirection(primaryVideoGuidance(completed(false))!)).not.toContain('at least one concept');
  });
  it('fails visibly on missing or empty video analysis rather than returning a KB-only fallback', () => {
    const pending = completed(); delete pending.entries[0].result;
    expect(() => primaryVideoGuidance(pending)).toThrow('analysis is unavailable');
    const empty = completed(); (empty.entries[0].result as any).intelligence.observations = [];
    expect(() => primaryVideoGuidance(empty)).toThrow('no visual observations');
  });
  it('uses the selected video identity when more than one source is present', () => {
    const state = completed(), selectedId = `media_${'c'.repeat(32)}`;
    const second = structuredClone(state.entries[0]); second.source.mediaId = selectedId;
    (second.result as any).intelligence.observations[0].observation.summary = 'SELECTED VIDEO CONTENT';
    state.entries.push(second);
    expect(primaryVideoGuidance(state, selectedId)!.analysis.summary).toContain('SELECTED VIDEO CONTENT');
  });
});
