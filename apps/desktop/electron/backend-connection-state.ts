export type BackendConnectionAttempt<TConnection> = {
  generation: number
  promise: Promise<TConnection> | null
}

export type BackendProcessOwner<TProcess> = {
  generation: number
  process: TProcess
}

interface PendingBackendStop<TProcess> {
  process: TProcess
  completion: Promise<void>
  failed: boolean
}

/**
 * "This attempt lost the race to a newer connection attempt." Replacing a
 * backend is normal (skew retirement + respawn, a renderer dial while the
 * supervisor recovers), so a loser must not surface as a startup failure.
 * Callers branch on this type instead of matching the message string.
 */
export class SupersededStartError extends Error {
  readonly superseded = true

  constructor() {
    super('Hermes backend start was superseded by a newer connection attempt.')
    this.name = 'SupersededStartError'
  }
}

export function isSupersededStartError(error: unknown): error is SupersededStartError {
  return Boolean(
    error &&
      typeof error === 'object' &&
      (error as { name?: unknown }).name === 'SupersededStartError' &&
      (error as { superseded?: unknown }).superseded === true
  )
}

export interface BackendConnectionState<TProcess, TConnection> {
  startAttempt(): BackendConnectionAttempt<TConnection>
  setPromise(attempt: BackendConnectionAttempt<TConnection>, promise: Promise<TConnection>): boolean
  isCurrentAttempt(attempt: BackendConnectionAttempt<TConnection>): boolean
  assertCurrentAttempt(attempt: BackendConnectionAttempt<TConnection>): void
  attachProcess(attempt: BackendConnectionAttempt<TConnection>, process: TProcess): BackendProcessOwner<TProcess> | null
  claimProcess(
    attempt: BackendConnectionAttempt<TConnection>,
    process: TProcess,
    claim: (current: TProcess) => Promise<unknown>
  ): Promise<BackendProcessOwner<TProcess> | null>
  clearForCurrentProcess(owner: BackendProcessOwner<TProcess>): boolean
  clearPromiseForAttempt(attempt: BackendConnectionAttempt<TConnection>): boolean
  getProcess(): TProcess | null
  getPromise(): Promise<TConnection> | null
  getPendingPromise(): Promise<TConnection> | null
  invalidate(): TProcess | null
  stopProcess(stop: (current: TProcess) => Promise<void>): Promise<void>
}

export function createBackendConnectionState<TProcess, TConnection>(): BackendConnectionState<TProcess, TConnection> {
  let generation = 0
  let process: TProcess | null = null
  let promise: Promise<TConnection> | null = null
  let pendingPromise: Promise<TConnection> | null = null
  let stopping: PendingBackendStop<TProcess> | null = null

  function invalidate(): TProcess | null {
    const currentProcess = process
    generation += 1
    process = null
    promise = null
    pendingPromise = null

    return currentProcess
  }

  function assertCurrentAttempt(attempt: BackendConnectionAttempt<TConnection>): void {
    if (attempt.generation !== generation) {
      throw new SupersededStartError()
    }
  }

  return {
    startAttempt(): BackendConnectionAttempt<TConnection> {
      if (stopping) {
        throw new Error('The previous backend has not stopped. Retry its shutdown before starting a replacement.')
      }

      return { generation, promise: null }
    },

    setPromise(attempt: BackendConnectionAttempt<TConnection>, nextPromise: Promise<TConnection>): boolean {
      if (attempt.generation !== generation) {
        return false
      }

      attempt.promise = nextPromise
      promise = nextPromise
      pendingPromise = nextPromise

      void nextPromise.then(
        () => {
          if (attempt.generation === generation && promise === nextPromise) {
            pendingPromise = null
          }
        },
        () => {
          if (attempt.generation === generation && promise === nextPromise) {
            pendingPromise = null
          }
        }
      )

      return true
    },

    isCurrentAttempt(attempt: BackendConnectionAttempt<TConnection>): boolean {
      return attempt.generation === generation
    },

    assertCurrentAttempt,

    attachProcess(
      attempt: BackendConnectionAttempt<TConnection>,
      nextProcess: TProcess
    ): BackendProcessOwner<TProcess> | null {
      if (attempt.generation !== generation) {
        return null
      }

      process = nextProcess

      return { generation, process: nextProcess }
    },

    async claimProcess(
      attempt: BackendConnectionAttempt<TConnection>,
      nextProcess: TProcess,
      claim: (current: TProcess) => Promise<unknown>
    ): Promise<BackendProcessOwner<TProcess> | null> {
      const owner = this.attachProcess(attempt, nextProcess)

      if (!owner) {
        return null
      }

      await claim(nextProcess)

      return owner.generation === generation && process === nextProcess ? owner : null
    },

    clearForCurrentProcess(owner: BackendProcessOwner<TProcess>): boolean {
      if (owner.generation !== generation || owner.process !== process) {
        return false
      }

      process = null
      promise = null
      pendingPromise = null

      return true
    },

    clearPromiseForAttempt(attempt: BackendConnectionAttempt<TConnection>): boolean {
      if (attempt.generation !== generation || (promise !== null && attempt.promise !== promise)) {
        return false
      }

      promise = null
      pendingPromise = null

      return true
    },

    getProcess(): TProcess | null {
      return process
    },

    getPromise(): Promise<TConnection> | null {
      return promise
    },

    getPendingPromise(): Promise<TConnection> | null {
      return pendingPromise
    },

    invalidate,

    stopProcess(stop: (current: TProcess) => Promise<void>): Promise<void> {
      if (stopping && !stopping.failed) {
        return stopping.completion
      }

      const current = stopping?.process ?? invalidate()

      if (current === null) {
        return Promise.resolve()
      }

      const completion = Promise.resolve()
        .then((): Promise<void> => stop(current))
        .then(
          (): void => {
            stopping = null
          },
          (error: unknown): never => {
            pending.failed = true
            throw error
          }
        )

      const pending: PendingBackendStop<TProcess> = { process: current, completion, failed: false }
      stopping = pending

      return completion
    }
  }
}
