// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $apiRequestScope } from '@/api/client'
import { listAllProfileSessions } from '@/api/sessions'
import { deleteSession, setSessionArchived } from '@/hermes'
import { en } from '@/i18n/en'
import { $messagingSessions, $sessions, setMessagingSessions, setSessions } from '@/store/session'
import type { SessionInfo } from '@/types/hermes'

import { SessionsSettings } from './sessions-settings'

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: en }) }))

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  deleteSession: vi.fn().mockResolvedValue(undefined),
  getHermesConfigRecord: vi.fn().mockResolvedValue({ config: {} }),
  setSessionArchived: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('@/store/confirm', () => ({ confirm: vi.fn().mockResolvedValue(true) }))

// Exercise the real archive pagination owner, mocking only its HTTP boundary.
vi.mock('@/api/sessions', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listAllProfileSessions: vi.fn()
}))

const archivedMatrixSession = {
  archived: true,
  ended_at: null,
  id: 'matrix-1',
  input_tokens: 0,
  is_active: false,
  last_active: 1,
  message_count: 2,
  model: null,
  output_tokens: 0,
  preview: null,
  source: 'matrix',
  started_at: 1,
  title: 'archived room',
  tool_call_count: 0
} as SessionInfo

beforeEach(() => {
  setSessions([])
  setMessagingSessions([])
  vi.mocked(setSessionArchived).mockReset().mockResolvedValue({ ok: true })
  vi.mocked(deleteSession).mockReset().mockResolvedValue({ ok: true })
  $apiRequestScope.set({ connectionId: null, profile: null })
  vi.mocked(listAllProfileSessions)
    .mockReset()
    .mockResolvedValue({
      sessions: [archivedMatrixSession],
      total: 1,
      limit: 500,
      offset: 0
    })
})

afterEach(() => {
  cleanup()
})

describe('SessionsSettings archive loading', () => {
  it('renders settings immediately and reads subsequent archive pages only on demand', async () => {
    let resolveFirst!: (value: Awaited<ReturnType<typeof listAllProfileSessions>>) => void
    let resolveNext!: typeof resolveFirst
    vi.mocked(listAllProfileSessions)
      .mockImplementationOnce(() => new Promise(resolve => (resolveFirst = resolve)))
      .mockImplementationOnce(() => new Promise(resolve => (resolveNext = resolve)))

    render(<SessionsSettings subpage="archive" />)

    expect(screen.getByText(en.settings.sessions.archivedTitle)).toBeTruthy()
    expect(screen.queryByText(en.settings.sessions.emptyArchivedTitle)).toBeNull()

    const firstPage = Array.from({ length: 500 }, (_, i) => ({
      ...archivedMatrixSession,
      id: `archived-${i}`,
      title: i === 0 ? 'archived room' : `room ${i}`
    }))

    await act(async () => resolveFirst({ sessions: firstPage, total: 501, limit: 500, offset: 0 }))

    expect(screen.getByText('archived room')).toBeTruthy()
    expect(listAllProfileSessions).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: en.sidebar.loadMore }))
    expect(screen.getAllByRole('button', { name: en.settings.sessions.unarchive })[0].hasAttribute('disabled')).toBe(
      false
    )
    await act(async () =>
      resolveNext({
        sessions: [{ ...archivedMatrixSession, id: 'older', title: 'older room' }],
        total: 501,
        limit: 500,
        offset: 500
      })
    )
    expect(screen.getByText('archived room')).toBeTruthy()
    expect(screen.getByText('older room')).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.sidebar.loadMore })).toBeNull()
    expect(vi.mocked(listAllProfileSessions).mock.calls.map(args => args[6])).toEqual([0, 500])
  })
})

describe('SessionsSettings archive recovery and scope', () => {
  it.each(['transport', 'profile scan'])('shows a retryable %s failure, never an empty archive', async kind => {
    if (kind === 'transport') {
      vi.mocked(listAllProfileSessions).mockRejectedValueOnce(new Error('offline'))
    } else {
      vi.mocked(listAllProfileSessions).mockResolvedValueOnce({
        sessions: [archivedMatrixSession],
        total: 1,
        limit: 500,
        offset: 0,
        errors: [{ profile: 'work', error: 'unavailable' }]
      })
    }

    render(<SessionsSettings subpage="archive" />)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByText(en.settings.sessions.emptyArchivedTitle)).toBeNull()

    if (kind === 'profile scan') {
      expect(screen.getByText('archived room')).toBeTruthy()
    }

    fireEvent.click(screen.getByRole('button', { name: en.common.retry }))
    expect(await screen.findByText('archived room')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not publish a pending archive page from a previous connection', async () => {
    let resolvePrevious!: (value: Awaited<ReturnType<typeof listAllProfileSessions>>) => void
    vi.mocked(listAllProfileSessions)
      .mockImplementationOnce(() => new Promise(resolve => (resolvePrevious = resolve)))
      .mockResolvedValueOnce({
        sessions: [{ ...archivedMatrixSession, id: 'current', title: 'current room' }],
        total: 1,
        limit: 500,
        offset: 0
      })

    render(<SessionsSettings subpage="archive" />)
    act(() => $apiRequestScope.setKey('connectionId', 'other'))
    expect(await screen.findByText('current room')).toBeTruthy()
    await act(async () => resolvePrevious({ sessions: [archivedMatrixSession], total: 501, limit: 500, offset: 0 }))
    expect(screen.queryByText('archived room')).toBeNull()
    expect(listAllProfileSessions).toHaveBeenCalledTimes(2)
  })

  it('finds a deep-linked archive beyond the first page without hiding earlier rows', async () => {
    vi.mocked(listAllProfileSessions)
      .mockResolvedValueOnce({ sessions: [archivedMatrixSession], total: 501, limit: 500, offset: 0 })
      .mockResolvedValueOnce({
        sessions: [{ ...archivedMatrixSession, id: 'target', title: 'target room' }],
        total: 2,
        limit: 500,
        offset: 500
      })
    render(
      <MemoryRouter initialEntries={['/settings/sessions?session=target']}>
        <SessionsSettings subpage="archive" />
      </MemoryRouter>
    )
    expect(await screen.findByText('target room')).toBeTruthy()
    expect(screen.getByText('archived room')).toBeTruthy()
  })
})

describe('SessionsSettings archive membership changes', () => {
  it.each(['unarchive', 'delete'])(
    'keeps the last archived row reachable after %s shifts a paused cursor',
    async action => {
      let archive = Array.from({ length: 501 }, (_, i) => ({
        ...archivedMatrixSession,
        id: `row-${i}`,
        title: `archive row ${i}`
      }))

      vi.mocked(listAllProfileSessions).mockImplementation(
        async (limit = 500, _min, _archived, _order, _profile, _filter, offset = 0) => ({
          sessions: archive.slice(offset, offset + limit),
          total: archive.length,
          limit: limit!,
          offset
        })
      )

      const remove = async (id: string) => {
        archive = archive.filter(row => row.id !== id)

        return { ok: true }
      }

      vi.mocked(setSessionArchived).mockImplementation(remove)
      vi.mocked(deleteSession).mockImplementation(remove)
      render(<SessionsSettings subpage="archive" />)
      await screen.findByText('archive row 0')
      const name = action === 'delete' ? en.settings.sessions.deletePermanently : en.settings.sessions.unarchive
      await act(async () => fireEvent.click(screen.getAllByRole('button', { name })[0]))
      const more = screen.queryByRole('button', { name: en.sidebar.loadMore })

      if (more) {
        await act(async () => fireEvent.click(more))
      }

      expect(await screen.findByText('archive row 500')).toBeTruthy()
      expect(screen.queryByText('archive row 0')).toBeNull()
    }
  )
})

describe('SessionsSettings unarchive', () => {
  it('restores a messaging-source session into $messagingSessions, not $sessions', async () => {
    render(<SessionsSettings />)
    const button = await screen.findByRole('button', { name: en.settings.sessions.unarchive })

    await act(async () => fireEvent.click(button))

    await waitFor(() => expect(setSessionArchived).toHaveBeenCalledWith('matrix-1', false, undefined))
    expect($messagingSessions.get().map(session => session.id)).toEqual(['matrix-1'])
    expect($messagingSessions.get()[0]?.archived).toBe(false)
    expect($sessions.get()).toEqual([])
  })
})
