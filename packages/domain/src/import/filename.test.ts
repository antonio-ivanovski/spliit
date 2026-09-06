import { describe, expect, it } from 'vitest'

import { guessGroupNameFromFilename } from './filename'

describe('guessGroupNameFromFilename', () => {
  it('derives a name from a personal Splitwise filename', () => {
    expect(
      guessGroupNameFromFilename('john-d-and-jane-d_2026-06-30_export.csv'),
    ).toBe('John D. and Jane D.')
  })

  it('capitalizes all parts of a personal segment', () => {
    expect(
      guessGroupNameFromFilename(
        'mary-jane-and-peter-parker_2025-01-01_export.csv',
      ),
    ).toBe('Mary Jane. and Peter Parker.')
  })

  it('handles three participants in a personal Splitwise export', () => {
    expect(
      guessGroupNameFromFilename('a-b-and-c-d-and-e-f_2025-01-01_export.csv'),
    ).toBe('A B. and C D. and E F.')
  })

  it('returns null for a numeric-only group export prefix', () => {
    expect(guessGroupNameFromFilename('2026_2026-06-30_export.csv')).toBeNull()
  })

  it('returns null for an empty-prefix group export', () => {
    expect(guessGroupNameFromFilename('_2026-06-30_export.csv')).toBeNull()
  })

  it('derives a name from a Splitwise group export filename', () => {
    expect(guessGroupNameFromFilename('test_2026-07-01_export.csv')).toBe(
      'Test',
    )
  })

  it('keeps years that are part of a Splitwise group name', () => {
    expect(
      guessGroupNameFromFilename('london_2022_2026-07-01_export.csv'),
    ).toBe('London 2022')
  })

  it('returns null for an unrecognized filename', () => {
    expect(guessGroupNameFromFilename('export.csv')).toBeNull()
    expect(guessGroupNameFromFilename('random.json')).toBeNull()
    expect(guessGroupNameFromFilename('group-name.csv')).toBeNull()
  })

  it('strips the file extension before matching', () => {
    expect(
      guessGroupNameFromFilename('john-d-and-jane-d_2026-06-30_export.json'),
    ).toBe('John D. and Jane D.')
  })

  it('humanizes Cospend dated project slugs', () => {
    expect(guessGroupNameFromFilename('family-zu-besuch_2026-09-06.csv')).toBe(
      'Family Zu Besuch',
    )
    expect(guessGroupNameFromFilename('osterreich-2026_2026-09-06.csv')).toBe(
      'Osterreich 2026',
    )
  })
})
