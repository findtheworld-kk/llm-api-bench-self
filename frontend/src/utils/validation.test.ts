import { describe, it, expect } from 'vitest';
import { validateProviderName, validateModelId, validateDisplayName } from './validation';

describe('validateProviderName', () => {
  it('accepts valid names', () => {
    expect(validateProviderName('OpenAI')).toBeNull();
    expect(validateProviderName('ZAI-CN-OpenAI')).toBeNull();
    expect(validateProviderName('my_provider')).toBeNull();
    expect(validateProviderName('a')).toBeNull();
    expect(validateProviderName('A'.repeat(64))).toBeNull();
  });

  it('rejects empty', () => {
    expect(validateProviderName('')).not.toBeNull();
  });

  it('rejects spaces', () => {
    expect(validateProviderName('My Provider')).not.toBeNull();
  });

  it('rejects dots', () => {
    expect(validateProviderName('provider.name')).not.toBeNull();
  });

  it('rejects over 64 chars', () => {
    expect(validateProviderName('A'.repeat(65))).not.toBeNull();
  });

  it('rejects starting with non-alphanumeric', () => {
    expect(validateProviderName('-provider')).not.toBeNull();
    expect(validateProviderName('_provider')).not.toBeNull();
  });
});

describe('validateModelId', () => {
  it('accepts valid IDs', () => {
    expect(validateModelId('gpt-4o')).toBeNull();
    expect(validateModelId('glm-5.1')).toBeNull();
    expect(validateModelId('z-ai/glm-4.7')).toBeNull();
    expect(validateModelId('claude-3.5-sonnet')).toBeNull();
    expect(validateModelId('a'.repeat(128))).toBeNull();
  });

  it('accepts the id shapes model discovery returns', () => {
    expect(validateModelId('qwen/qwen3-235b-a22b:free')).toBeNull();
    expect(validateModelId('gemini-2.5-flash@001')).toBeNull();
    expect(validateModelId('meta/llama-4+vision')).toBeNull();
    expect(validateModelId('~anthropic/claude-opus-latest')).toBeNull();
  });

  it('rejects empty', () => {
    expect(validateModelId('')).not.toBeNull();
  });

  it('rejects spaces', () => {
    expect(validateModelId('gpt 4o')).not.toBeNull();
  });

  it('rejects over 128 chars', () => {
    expect(validateModelId('a'.repeat(129))).not.toBeNull();
  });

  it('rejects starting with non-alphanumeric', () => {
    expect(validateModelId('/vendor/model')).not.toBeNull();
    expect(validateModelId('.hidden')).not.toBeNull();
  });
});

describe('validateDisplayName', () => {
  it('returns null for empty (optional)', () => {
    expect(validateDisplayName('')).toBeNull();
  });

  it('accepts valid display names', () => {
    expect(validateDisplayName('GLM 5.1')).toBeNull();
    expect(validateDisplayName('Gemini 2.5 Flash-Lite')).toBeNull();
    expect(validateDisplayName('DeepSeek-V3.2')).toBeNull();
    expect(validateDisplayName('A'.repeat(96))).toBeNull();
  });

  it('accepts the display names upstreams hand back', () => {
    expect(validateDisplayName('OpenAI: GPT-6 Astra')).toBeNull();
    expect(validateDisplayName('Claude Opus 5 (batch)')).toBeNull();
    expect(validateDisplayName('Qwen3 235B A22B')).toBeNull();
  });

  it('rejects special characters', () => {
    expect(validateDisplayName('name@test')).not.toBeNull();
    expect(validateDisplayName('name<script>')).not.toBeNull();
  });

  it('rejects over 96 chars', () => {
    expect(validateDisplayName('A'.repeat(97))).not.toBeNull();
  });

  it('rejects starting with non-alphanumeric', () => {
    expect(validateDisplayName(' GLM 5')).not.toBeNull();
    expect(validateDisplayName('-Model')).not.toBeNull();
  });
});
