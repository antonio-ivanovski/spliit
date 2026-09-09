import { TRPCError } from '@trpc/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  describeCleanupFailure,
  logImportOutcome,
  type PreparedExpenseFileImport,
} from './csv-import'

const SECRET = 'X-Amz-Signature=TOPSECRET123'

function preparedStub(): PreparedExpenseFileImport {
  return {
    rows: [],
    notificationBoss: null,
    summaryActivityId: 'summary',
    ledgerCurrencyCode: 'USD',
    ledgerId: 'ledger',
    attemptKey: 'attempt',
    commitTimings: null,
  } as unknown as PreparedExpenseFileImport
}

function s3LikeError() {
  return Object.assign(new Error(`NoSuchKey: tmp/attempt/doc.pdf?${SECRET}`), {
    name: 'NoSuchKey',
    $metadata: { httpStatusCode: 404 },
  })
}

describe('describeCleanupFailure', () => {
  it('excludes the secret-bearing message, keeping only kind', () => {
    const result = describeCleanupFailure(
      new Error(`DeleteFailed: https://bucket/tmp/x?${SECRET}`),
    )
    expect(result).toEqual({ kind: 'Error' })
    expect(JSON.stringify(result)).not.toContain('TOPSECRET')
  })

  it('extracts the allowlisted name and numeric status', () => {
    const result = describeCleanupFailure(s3LikeError())
    expect(result).toEqual({ kind: 'NoSuchKey', status: 404 })
    expect(JSON.stringify(result)).not.toContain('TOPSECRET')
  })

  it('degrades malformed names, non-errors, and wild statuses to unknown', () => {
    expect(
      describeCleanupFailure(
        Object.assign(new Error('x'), { name: 'evil\nname' }),
      ),
    ).toEqual({ kind: 'unknown' })
    expect(describeCleanupFailure('raw string throw')).toEqual({
      kind: 'unknown',
    })
    expect(
      describeCleanupFailure(
        Object.assign(new Error('x'), {
          name: 'Weird',
          $metadata: { httpStatusCode: 99 },
        }),
      ),
    ).toEqual({ kind: 'unknown' })
  })

  it('rejects secret-bearing names even when they look like error codes', () => {
    const error = Object.assign(new Error('ignored'), {
      name: 'TOPSECRET123',
    })
    expect(describeCleanupFailure(error)).toEqual({ kind: 'unknown' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      logImportOutcome(preparedStub(), { committed: false, error })
      expect(String(warn.mock.calls[0]?.[0])).not.toContain('TOPSECRET123')
    } finally {
      warn.mockRestore()
    }
  })
})

describe('logImportOutcome', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('logs committed at info level with timings', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const prepared = preparedStub()
    prepared.commitTimings = {
      lockWaitMs: 1,
      duplicatesMs: 2,
      duplicateWindows: 1,
      candidatesScanned: 3,
      validationMs: 4,
      writesMs: 5,
      recurringMs: 6,
      summaryMs: 7,
    }
    logImportOutcome(prepared, { committed: true })
    expect(info).toHaveBeenCalledTimes(1)
    const line = String(info.mock.calls[0]?.[0])
    expect(line).toContain('"phase":"committed"')
    expect(line).toContain('"lockWaitMs":1')
    expect(line).toContain('"candidatesScanned":3')
    expect(line).toContain('"summaryMs":7')
  })

  it('logs routine failures at info level with codes, never messages', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    logImportOutcome(preparedStub(), {
      committed: false,
      error: new TRPCError({ code: 'CONFLICT', message: 'rows 1, 2' }),
    })
    expect(warn).not.toHaveBeenCalled()
    const line = String(info.mock.calls[0]?.[0])
    expect(line).toContain('"phase":"failed"')
    expect(line).toContain('"errorCode":"CONFLICT"')
    expect(line).not.toContain('rows 1, 2')
  })

  it('logs unexpected failures at warn level without the raw error', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    logImportOutcome(preparedStub(), {
      committed: false,
      error: s3LikeError(),
    })
    expect(info).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    const line = String(warn.mock.calls[0]?.[0])
    expect(line).not.toContain('TOPSECRET')
    expect(line).toContain('"phase":"failed"')
    expect(line).toContain('"errorCode":"NoSuchKey"')
  })

  it('renders partial timings without implying unfinished phases ran', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const prepared = preparedStub()
    // Duplicate conflict after the scan: completed phases only.
    prepared.commitTimings = {
      lockWaitMs: 1,
      duplicatesMs: 2,
      duplicateWindows: 1,
      candidatesScanned: 3,
    }
    logImportOutcome(prepared, {
      committed: false,
      error: new TRPCError({ code: 'CONFLICT', message: 'rows 1, 2' }),
    })
    const line = String(info.mock.calls[0]?.[0])
    expect(line).toContain('"lockWaitMs":1')
    expect(line).toContain('"duplicatesMs":2')
    expect(line).not.toContain('"writesMs"')
    expect(line).not.toContain('"failedPhase"')
  })

  it('renders the interrupted phase with elapsed time, values stay numeric', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const prepared = preparedStub()
    prepared.commitTimings = {
      lockWaitMs: 1,
      duplicatesMs: 2,
      duplicateWindows: 1,
      candidatesScanned: 3,
      validationMs: 4,
      failedPhase: 'writes',
      failedPhaseElapsedMs: 5,
    }
    logImportOutcome(prepared, {
      committed: false,
      error: new Error('boom-chunk-2'),
    })
    const line = String(warn.mock.calls[0]?.[0])
    expect(line).toContain('"failedPhase":"writes"')
    expect(line).toContain('"failedPhaseElapsedMs":5')
    expect(line).toContain('"validationMs":4')
    expect(line).not.toContain('boom-chunk-2')
    expect(line).not.toContain('"writesMs"')
  })
})
