import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  createBackendConnectionState,
  isSupersededStartError,
  SupersededStartError
} from './backend-connection-state'
import { createBackendExitRecoveryLatch } from './backend-exit-recovery'

type Child = { pid: number }

// Shared consumer logic under test: what `connectDesktopProfileRoute` and
// `runPrimaryRecoverySpawn` do with a rejected start that lost the race.
function adoptCurrentGeneration(
  state: ReturnType<typeof createBackendConnectionState<Child, string>>,
  error: unknown
): Promise<string> | undefined {
  if (!isSupersededStartError(error)) {
    throw error
  }

  return state.getPendingPromise() ?? state.getPromise() ?? undefined
}

// Reproduces the desktop.log 08:47 incident at the seams main.ts actually
// composes: a ready primary child exits 0 (skew retirement), the supervisor
// schedules runPrimaryRecoverySpawn -> startHermes({ supervisorRecovery: true
// }), and the renderer's hermes:connection dials ensureBackend concurrently.
// One of the two start attempts is superseded; that must NOT end as "respawn
// failed" / "Hermes couldn't start", and the crash-loop budget must survive.

test('supervisor respawn loses to the renderer dial: renderer gets a working connection, no respawn-failed handling, no crash-loop spend', async () => {
  const state = createBackendConnectionState<Child, string>()
  const latch = createBackendExitRecoveryLatch({ now: () => 1_000 })

  // Generation 1: the skew-retired child. Ready, then exit 0; the exit
  // handler's clearForCurrentProcess + the supervisor's claim mirror
  // scheduleUnexpectedPrimaryRecovery.
  const g1 = state.startAttempt()
  state.setPromise(g1, Promise.resolve('https://ready.example'))
  const owner = state.attachProcess(g1, { pid: 100 })!
  assert.ok(state.clearForCurrentProcess(owner), 'current child exited')

  // Slot empty, no start in flight -> supervisor claims the respawn (#112344).
  assert.equal(latch.claim({ hasCurrentOwner: false, hasPendingStart: false, intentionalTeardown: false }), true)

  // Generation 2: the supervisor respawn starts and publishes. While it is
  // still resolving, a NEWER attempt (the app re-driving start after the skew
  // update) invalidates it.
  const respawn = state.startAttempt()
  let rejectRespawn!: (error: unknown) => void
  const respawnPromise = new Promise<string>((_resolve, reject) => {
    rejectRespawn = reject
  })
  state.setPromise(respawn, respawnPromise)

  state.invalidate()
  const newer = state.startAttempt()
  const newerPromise = Promise.resolve('https://newer.example')
  state.setPromise(newer, newerPromise)

  // The respawn attempt loses: its next step() throws the typed error
  // (previously a bare Error nothing could branch on).
  assert.throws(() => state.assertCurrentAttempt(respawn), isSupersededStartError)

  // Supervisor .catch: superseded is NOT a failure — no "respawn failed" log,
  // no retryAfterFailedStart, no crash-loop budget.
  let supervisorLoggedRespawnFailed = false
  const respawnOutcome = respawnPromise.catch(error => {
    if (isSupersededStartError(error)) {
      return undefined
    }

    supervisorLoggedRespawnFailed = true

    return undefined
  })
  rejectRespawn(new SupersededStartError())
  assert.equal(await respawnOutcome, undefined)
  assert.equal(supervisorLoggedRespawnFailed, false)
  assert.equal(latch.isCrashLooping(), false, 'no crash-loop budget consumed')

  // Renderer consumer (`connectDesktopProfileRoute`): the superseded error is
  // never ITS error here — the newer generation is what callers adopt. Its
  // attempt is unaffected; assert the newer promise is what the slot holds.
  assert.equal(state.getPromise(), newerPromise)
})

test('renderer dial loses to the newer attempt: hermes:connection adopts the current generation and succeeds', async () => {
  const state = createBackendConnectionState<Child, string>()

  const rendererAttempt = state.startAttempt()
  let rejectRenderer!: (error: unknown) => void
  const rendererPromise = new Promise<string>((_resolve, reject) => {
    rejectRenderer = reject
  })
  state.setPromise(rendererAttempt, rendererPromise)

  state.invalidate()
  const newer = state.startAttempt()
  const newerPromise = new Promise<string>(() => {})
  state.setPromise(newer, newerPromise)

  const connection = rendererPromise.then(
    value => value,
    error => adoptCurrentGeneration(state, error) ?? Promise.reject(error)
  )

  rejectRenderer(new SupersededStartError())

  // The adopted promise is still pending here — it resolves when the newer
  // attempt publishes. Simulate its success.
  state.clearPromiseForAttempt(newer)
  state.setPromise(newer, Promise.resolve('https://newer.example'))

  const settled = await connection
  assert.equal(settled, 'https://newer.example')
})

test('the adopted newer attempt itself failing surfaces the REAL error, not superseded noise', async () => {
  const state = createBackendConnectionState<Child, string>()

  const rendererAttempt = state.startAttempt()
  let rejectRenderer!: (error: unknown) => void
  const rendererPromise = new Promise<string>((_resolve, reject) => {
    rejectRenderer = reject
  })
  state.setPromise(rendererAttempt, rendererPromise)

  state.invalidate()
  const newer = state.startAttempt()
  const realFailure = new Error('Hermes backend exited before it became ready (1).')
  state.setPromise(newer, Promise.reject(realFailure))

  const connection = rendererPromise.then(
    value => value,
    error => adoptCurrentGeneration(state, error) ?? Promise.reject(error)
  )

  rejectRenderer(new SupersededStartError())
  await assert.rejects(connection, error => error === realFailure)
})

test('a superseded loser with nothing newer to adopt keeps failing (true dead end)', async () => {
  const state = createBackendConnectionState<Child, string>()

  const attempt = state.startAttempt()
  let rejectLoser!: (error: unknown) => void
  const loser = new Promise<string>((_resolve, reject) => {
    rejectLoser = reject
  })
  state.setPromise(attempt, loser)

  const connection = loser.then(
    value => value,
    error => adoptCurrentGeneration(state, error) ?? Promise.reject(error)
  )

  state.invalidate()
  rejectLoser(new SupersededStartError())
  await assert.rejects(connection, isSupersededStartError)
})
