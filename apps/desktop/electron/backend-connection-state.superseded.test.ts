import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  createBackendConnectionState,
  isSupersededStartError,
  SupersededStartError
} from './backend-connection-state'

type Child = { pid: number }

// The two call sites that must survive a superseded attempt: the renderer's
// hermes:connection detachment (`connectDesktopProfileRoute` -> ensureBackend)
// and `runPrimaryRecoverySpawn`'s .catch. Both adopt the CURRENT generation's
// promise instead of surfacing the loser's superseded rejection.

test('assertCurrentAttempt throws the typed superseded error, not a bare Error', () => {
  const state = createBackendConnectionState<Child, string>()
  const attempt = state.startAttempt()

  state.invalidate()

  assert.throws(() => state.assertCurrentAttempt(attempt), isSupersededStartError)
  assert.throws(() => state.assertCurrentAttempt(attempt), SupersededStartError)
})

test('a superseded loser adopts the current generation and resolves with it', async () => {
  const state = createBackendConnectionState<Child, string>()

  // The loser: a start whose resolution is overtaken by an invalidate().
  const attempt = state.startAttempt()
  let rejectLoser!: (error: unknown) => void
  const loser = new Promise<string>((_resolve, reject) => {
    rejectLoser = reject
  })
  state.setPromise(attempt, loser)

  // The newer connection attempt is already in flight and becomes ready.
  state.invalidate()
  const newer = state.startAttempt()
  const newerPromise = Promise.resolve('https://new.example')
  state.setPromise(newer, newerPromise)

  // Mirrors both consumers: the loser's failure path must not fail its caller
  // when a newer attempt owns the slot.
  const outcome = loser.catch((error: unknown) => {
    if (isSupersededStartError(error) || !state.isCurrentAttempt(attempt)) {
      const current = state.getPendingPromise() ?? state.getPromise()

      if (current) {
        return current
      }
    }

    throw error
  })

  rejectLoser(new SupersededStartError())
  assert.equal(await outcome, 'https://new.example')
})

test('a superseded loser with no newer generation keeps failing with the real error', async () => {
  const state = createBackendConnectionState<Child, string>()
  const attempt = state.startAttempt()
  let rejectLoser!: (error: unknown) => void
  const loser = new Promise<string>((_resolve, reject) => {
    rejectLoser = reject
  })
  state.setPromise(attempt, loser)

  const outcome = loser.catch((error: unknown) => {
    if (isSupersededStartError(error) || !state.isCurrentAttempt(attempt)) {
      const current = state.getPendingPromise() ?? state.getPromise()

      if (current) {
        return current
      }
    }

    throw error
  })

  // invalidate() only, no newer attempt published: nothing to adopt.
  state.invalidate()
  rejectLoser(new SupersededStartError())
  await assert.rejects(outcome, isSupersededStartError)
})

test('a real failure (not superseded) is surfaced as-is', async () => {
  const state = createBackendConnectionState<Child, string>()
  const attempt = state.startAttempt()
  const realFailure = new Error('Hermes backend exited before it became ready (1).')
  const loser = Promise.reject(realFailure)

  state.setPromise(attempt, loser)

  const outcome = loser.catch((error: unknown) => {
    if (isSupersededStartError(error) || !state.isCurrentAttempt(attempt)) {
      const current = state.getPendingPromise() ?? state.getPromise()

      if (current) {
        return current
      }
    }

    throw error
  })

  await assert.rejects(outcome, error => error === realFailure)
})

test('a superseded loser must not clear the newer attempt\u2019s published promise', () => {
  const state = createBackendConnectionState<Child, string>()
  const loser = state.startAttempt()
  state.setPromise(loser, Promise.resolve('old'))
  state.invalidate()

  const newer = state.startAttempt()
  const newerPromise = Promise.resolve('new')
  state.setPromise(newer, newerPromise)

  // runHermesStart's .catch calls clearPromiseForAttempt; a stale attempt must
  // be refused so the newer connection stays published.
  assert.equal(state.clearPromiseForAttempt(loser), false)
  assert.equal(state.getPromise(), newerPromise)
})
