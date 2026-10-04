import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  createBackendConnectionState,
  isSupersededStartError,
  SupersededStartError
} from './backend-connection-state'

type Child = { pid: number }

// Mirrors the connectDesktopProfileRoute bounded-redial seam (main.ts): a
// superseded dial re-enters the SAME ensure closure so ensureBackend applies
// its profile descriptor to whichever generation is current. The redial loop
// is bounded; exhausting it surfaces the real error.

function adoptLoop(
  state: ReturnType<typeof createBackendConnectionState<Child, string>>,
  dial: (round: number) => Promise<string>,
  maxRedials = 4
) {
  let round = 0

  return async (): Promise<string> => {
    for (; ; round++) {
      try {
        return await dial(round)
      } catch (error) {
        if (!isSupersededStartError(error) || round >= maxRedials) {
          throw error
        }
      }
    }
  }
}

test('bounded redial: each superseded round re-dials and the descriptor survive (F1+F2)', async () => {
  const state = createBackendConnectionState<Child, string>()
  const descriptors: string[] = []

  // Round 0: own dial superseded by B; round 1 (adopt B) superseded by C.
  const supersede = new Map<number, Error>()
  supersede.set(0, new SupersededStartError())
  supersede.set(1, new SupersededStartError())

  const result = await adoptLoop(state, async round => {
    descriptors.push(`profile-descriptor-${round}`)

    if (supersede.has(round)) {
      throw supersede.get(round)!
    }

    return 'https://c.example'
  })()

  assert.equal(result, 'https://c.example')
  // The descriptor work ran on EVERY round: F1 fixed (no promise bypass).
  assert.deepEqual(descriptors, ['profile-descriptor-0', 'profile-descriptor-1', 'profile-descriptor-2'])
})

test('real failure (not superseded) is surfaced from the first dial, no redial', async () => {
  const state = createBackendConnectionState<Child, string>()
  let calls = 0
  const realFailure = new Error('Hermes backend: exited before port announcement (SIGTERM)')

  await assert.rejects(
    adoptLoop(state, async () => {
      calls++

      throw realFailure
    })(),
    error => error === realFailure
  )
  assert.equal(calls, 1)
})

test('exhausting the redial bound surfaces the superseded error (fail closed)', async () => {
  const state = createBackendConnectionState<Child, string>()
  let calls = 0

  await assert.rejects(
    adoptLoop(state, async () => {
      calls++

      throw new SupersededStartError()
    })(),
    isSupersededStartError
  )
  assert.equal(calls, 5)
})
