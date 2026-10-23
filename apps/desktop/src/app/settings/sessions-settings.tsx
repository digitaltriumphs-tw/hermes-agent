import { backendScopeKey } from '@hermes/shared'
import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { $apiRequestScope } from '@/api/client'
import { restoreListedSession } from '@/app/session/hooks/use-session-actions/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tip } from '@/components/ui/tooltip'
import {
  deleteSession,
  getHermesConfigRecord,
  peekConfigReadOrigin,
  retainConfigReadOrigin,
  saveHermesConfig,
  setSessionArchived
} from '@/hermes'
import { useI18n } from '@/i18n'
import { sessionTitle } from '@/lib/chat-runtime'
import { pathLeaf } from '@/lib/display-path'
import { triggerHaptic } from '@/lib/haptics'
import { Archive, ArchiveOff, FolderOpen, Loader2, Trash2 } from '@/lib/icons'
import { purgeInFlightTurnJournals } from '@/lib/inflight-turn-journal'
import { confirm } from '@/store/confirm'
import { notify, notifyError } from '@/store/notifications'
import { applyConfiguredDefaultProjectDir, ensureDefaultWorkspaceCwd } from '@/store/session'
import { untombstoneSessions } from '@/store/session-removal'
import { forgetSessionUnread } from '@/store/session-unread'
import { iterateArchivedSessions } from '@/store/sidebar-archive'
import type { HermesConfigRecord, SessionInfo } from '@/types/hermes'

import { EmptyState, ListRow, SectionHeading, SettingsContent, ToggleRow } from './primitives'
import { SETTING_IDS, settingElementId } from './settings-manifest'
import { useDeepLinkHighlight } from './use-deep-link-highlight'
import { useSettingDeepLink } from './use-setting-deep-link'

const DEFAULT_AUTO_ARCHIVE_DAYS = 3

interface SessionsSettingsProps {
  subpage?: string
}

export function SessionsSettings({ subpage }: SessionsSettingsProps = {}) {
  useSettingDeepLink('sessions', page => subpage === undefined || page === subpage)
  const scope = useStore($apiRequestScope)

  if (subpage === 'default-directory') {
    return (
      <SettingsContent>
        <DefaultProjectDirSetting />
      </SettingsContent>
    )
  }

  return (
    <ArchivedSessionsSettings
      includeDefaultDirectory={subpage === undefined}
      key={backendScopeKey(scope.connectionId, scope.profile)}
    />
  )
}

function ArchivedSessionsSettings({ includeDefaultDirectory }: { includeDefaultDirectory: boolean }) {
  const { t } = useI18n()
  const s = t.settings.sessions
  const [sessions, setLocalSessions] = useState<SessionInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const pages = useRef<{
    iterator: ReturnType<typeof iterateArchivedSessions>
    pending: boolean
    cancelled: boolean
  } | null>(null)

  const load = useCallback(
    async (reset = false) => {
      if (reset && pages.current) {
        // A successful membership change invalidates the old offset window,
        // including an in-flight page. Reuse the existing first-page reload.
        pages.current.cancelled = true
      } else if (pages.current?.pending) {
        return
      }

      const current =
        reset || !pages.current
          ? { iterator: iterateArchivedSessions(), pending: false, cancelled: false }
          : pages.current

      pages.current = current
      current.pending = true

      if (reset) {
        setLocalSessions([])
        setHasMore(false)
        setFailed(false)
      }

      setLoading(true)

      try {
        const page = await current.iterator.next()

        if (current.cancelled) {
          return
        }

        setHasMore(!page.done && page.value.hasMore)

        if (!page.done) {
          setLocalSessions(previous => [...previous, ...page.value.sessions])

          if (page.value.errors?.length) {
            setFailed(true)
          }
        }
      } catch (err) {
        if (!current.cancelled) {
          setFailed(true)
          setHasMore(false)
          notifyError(err, s.failedLoad)
        }
      } finally {
        if (!current.cancelled) {
          current.pending = false
          setLoading(false)
        }
      }
    },
    [s.failedLoad]
  )

  useEffect(() => {
    void load(true)

    return () => {
      if (pages.current) {
        pages.current.cancelled = true
      }
    }
  }, [load])

  const unarchive = useCallback(
    async (session: SessionInfo) => {
      setBusyId(session.id)

      try {
        await setSessionArchived(session.id, false, session.profile)

        if (pages.current?.cancelled) {
          return
        }

        setLocalSessions(prev => prev.filter(s => s.id !== session.id))
        // Surface it again in the sidebar without waiting for a full refresh, and
        // lift any optimistic eviction so the grouped tree shows it again too.
        untombstoneSessions([session.id, session._lineage_root_id])
        restoreListedSession({ ...session, archived: false })
        triggerHaptic('selection')
        notify({ durationMs: 2_000, kind: 'success', message: s.restored })
        void load(true)
      } catch (err) {
        notifyError(err, s.unarchiveFailed)
      } finally {
        setBusyId(null)
      }
    },
    [load, s]
  )

  const remove = useCallback(
    async (session: SessionInfo) => {
      const ok = await confirm({
        confirmLabel: s.deletePermanently,
        destructive: true,
        title: s.deleteConfirm(sessionTitle(session))
      })

      if (!ok || pages.current?.cancelled) {
        return
      }

      setBusyId(session.id)

      try {
        await deleteSession(session.id, session.profile)

        if (pages.current?.cancelled) {
          return
        }

        // Permanent delete bypasses removeSession, so retire the persisted
        // unread state here too rather than leaving it to rot.
        forgetSessionUnread([session.id, session._lineage_root_id], session.profile)
        // Same for the journaled in-flight tail: it holds this session's
        // prompt and tool calls in localStorage, and a deleted session must
        // not leave that copy behind to age out on its own. Both ids — the
        // stored tip and the durable lineage root — the journal keys on the
        // stored id and the row may carry either.
        purgeInFlightTurnJournals([session.id, session._lineage_root_id])
        setLocalSessions(prev => prev.filter(s => s.id !== session.id))
        triggerHaptic('warning')
        void load(true)
      } catch (err) {
        notifyError(err, s.deleteFailed)
      } finally {
        setBusyId(null)
      }
    },
    [load, s]
  )

  const target = useDeepLinkHighlight({
    elementId: id => `archived-session-${id}`,
    param: 'session',
    ready: id => sessions.some(session => session.id === id)
  })

  // An explicit deep link may need older pages; ordinary opens stop after the
  // first page. Keep already loaded rows usable while locating the target.
  useEffect(() => {
    if (target && !loading && hasMore && !sessions.some(session => session.id === target)) {
      void load()
    }
  }, [hasMore, load, loading, sessions, target])

  return (
    <SettingsContent>
      {includeDefaultDirectory && <DefaultProjectDirSetting />}

      <AutoArchiveSetting />

      <SectionHeading
        icon={Archive}
        meta={sessions.length ? String(sessions.length) : undefined}
        title={s.archivedTitle}
      />
      <p className="mb-2 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
        {s.archivedIntro}
      </p>

      {sessions.length === 0 && !loading && !failed ? (
        <EmptyState description={s.emptyArchivedDesc} title={s.emptyArchivedTitle} />
      ) : (
        <div className="grid gap-1">
          {sessions.map(session => {
            const label = pathLeaf(session.cwd)
            const busy = busyId === session.id

            return (
              <div className="scroll-mt-6 rounded-lg" id={`archived-session-${session.id}`} key={session.id}>
                <ListRow
                  action={
                    <div className="flex items-center gap-1.5">
                      <Button
                        disabled={busy}
                        onClick={() => void unarchive(session)}
                        size="sm"
                        type="button"
                        variant="textStrong"
                      >
                        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ArchiveOff className="size-3.5" />}
                        <span>{s.unarchive}</span>
                      </Button>
                      <Tip label={s.deletePermanently}>
                        <Button
                          aria-label={s.deletePermanently}
                          className="text-muted-foreground hover:text-destructive"
                          disabled={busy}
                          onClick={() => void remove(session)}
                          size="icon"
                          type="button"
                          variant="ghost"
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </Tip>
                    </div>
                  }
                  description={session.preview || undefined}
                  hint={label ? `${label} · ${s.messages(session.message_count)}` : s.messages(session.message_count)}
                  title={sessionTitle(session)}
                />
              </div>
            )
          })}
        </div>
      )}
      {loading && (
        <p className="py-3 text-sm text-muted-foreground" role="status">
          {t.common.loading}
        </p>
      )}
      {failed && (
        <p className="py-3 text-sm text-muted-foreground" role="alert">
          {s.failedLoad}
        </p>
      )}
      {hasMore && (
        <Button disabled={loading} onClick={() => void load()} size="sm" variant="textStrong">
          {t.sidebar.loadMore}
        </Button>
      )}
      {failed && (
        <Button disabled={loading} onClick={() => void load(true)} size="sm" variant="textStrong">
          {t.common.retry}
        </Button>
      )}
    </SettingsContent>
  )
}

// Opt-in retention: soft-hide chats untouched for N days. The policy itself
// (last-activity sweep, pin exemption) lives in the backend
// (sessions.auto_archive in config.yaml + SessionDB.maybe_auto_archive); this
// just toggles the config keys, so CLI / gateway / Desktop all honour one
// setting. Pins are exempt on the backend, so pinned chats survive regardless.
function AutoArchiveSetting() {
  const { t } = useI18n()
  const s = t.settings.sessions
  const [config, setConfig] = useState<HermesConfigRecord | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [days, setDays] = useState(DEFAULT_AUTO_ARCHIVE_DAYS)

  useEffect(() => {
    // Config REST is only reachable through the Electron bridge; skip in
    // non-Electron contexts (tests/storybook) rather than throwing.
    if (!window.hermesDesktop) {
      return
    }

    let alive = true

    void getHermesConfigRecord()
      .then(record => {
        if (!alive) {
          return
        }

        const sessions = (record.sessions ?? {}) as Record<string, unknown>
        const parsedDays = Number(sessions.auto_archive_days)
        setConfig(record)
        setEnabled(Boolean(sessions.auto_archive))
        setDays(Number.isFinite(parsedDays) && parsedDays > 0 ? Math.round(parsedDays) : DEFAULT_AUTO_ARCHIVE_DAYS)
      })
      .catch(() => {
        // Leave the control unmounted if config can't be read.
      })

    return () => {
      alive = false
    }
  }, [])

  const persist = useCallback(
    async (autoArchive: boolean, archiveDays: number) => {
      if (!config) {
        return
      }

      const sessions = {
        ...((config.sessions ?? {}) as Record<string, unknown>),
        auto_archive: autoArchive,
        auto_archive_days: archiveDays
      }

      // Read the route at save time from the record itself, and carry it onto
      // the replacement snapshot so the next save still targets the gateway
      // that served the original GET.
      const writeScope = peekConfigReadOrigin(config)

      setConfig(retainConfigReadOrigin({ ...config, sessions }, config))

      try {
        // Sparse patch: PUT /api/config deep-merges, and echoing the cached
        // snapshot would overwrite keys other surfaces changed since it loaded.
        await saveHermesConfig({ sessions: { auto_archive: autoArchive, auto_archive_days: archiveDays } }, writeScope)
      } catch (err) {
        notifyError(err, s.autoArchiveFailed)
      }
    },
    [config, s.autoArchiveFailed]
  )

  if (!config) {
    return null
  }

  return (
    <div className="mb-6">
      <ToggleRow
        checked={enabled}
        description={s.autoArchiveDesc}
        id={settingElementId(SETTING_IDS.sessions.autoArchive)}
        label={s.autoArchiveTitle}
        onChange={on => {
          setEnabled(on)
          void persist(on, days)
        }}
      />
      {enabled && (
        <ListRow
          action={
            <div className="flex items-center gap-2">
              <Input
                aria-label={s.autoArchiveDaysLabel}
                className="w-20"
                min={1}
                onBlur={() => void persist(true, days)}
                onChange={e => setDays(Math.max(1, Math.round(Number(e.target.value) || 1)))}
                type="number"
                value={days}
              />
              <span className="text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
                {s.autoArchiveDaysUnit}
              </span>
            </div>
          }
          title={s.autoArchiveDaysLabel}
        />
      )}
    </div>
  )
}

// Lets the user pin the default cwd for new sessions. Without this, packaged
// builds on Windows used to spawn sessions in the install dir (`win-unpacked`
// / Program Files), which buried any files Hermes wrote there.
function DefaultProjectDirSetting() {
  const { t } = useI18n()
  const s = t.settings.sessions
  const [dir, setDir] = useState<null | string>(null)
  const [fallback, setFallback] = useState<string>('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    // The bridge is only present when running inside Electron. In a Vitest
    // / Storybook / non-Electron context `window.hermesDesktop` is
    // undefined, so guard the WHOLE call chain rather than chaining
    // `?.settings.getDefaultProjectDir().then(...)` (the latter would
    // short-circuit to `undefined.then(...)` and throw at runtime).
    const settings = window.hermesDesktop?.settings

    if (!settings) {
      return
    }

    let alive = true

    void settings.getDefaultProjectDir().then(result => {
      if (!alive) {
        return
      }

      setDir(result.dir)
      setFallback(result.defaultLabel)
      applyConfiguredDefaultProjectDir(result.dir)
    })

    return () => {
      alive = false
    }
  }, [])

  const choose = useCallback(async () => {
    const settings = window.hermesDesktop?.settings

    if (!settings) {
      return
    }

    setBusy(true)

    try {
      const picked = await settings.pickDefaultProjectDir()

      if (picked.canceled || !picked.dir) {
        return
      }

      const result = await settings.setDefaultProjectDir(picked.dir)
      setDir(result.dir)
      applyConfiguredDefaultProjectDir(result.dir)
      notify({ durationMs: 4_000, kind: 'success', message: s.defaultDirUpdated })
    } catch (err) {
      notifyError(err, s.updateDirFailed)
    } finally {
      setBusy(false)
    }
  }, [s])

  const clear = useCallback(async () => {
    const settings = window.hermesDesktop?.settings

    if (!settings) {
      return
    }

    setBusy(true)

    try {
      await settings.setDefaultProjectDir(null)
      setDir(null)
      applyConfiguredDefaultProjectDir(null)
      await ensureDefaultWorkspaceCwd()
    } catch (err) {
      notifyError(err, s.clearDirFailed)
    } finally {
      setBusy(false)
    }
  }, [s])

  return (
    <div className="mb-6">
      <SectionHeading icon={FolderOpen} page title={s.defaultDirTitle} />
      <p className="mb-2 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
        {s.defaultDirDesc}
      </p>
      <ListRow
        action={
          <div className="flex items-center gap-3">
            <Button disabled={busy} onClick={() => void choose()} size="sm" type="button" variant="textStrong">
              <FolderOpen className="size-3.5" />
              <span>{dir ? s.change : s.choose}</span>
            </Button>
            {dir && (
              <Button disabled={busy} onClick={() => void clear()} size="sm" type="button" variant="text">
                {s.clear}
              </Button>
            )}
          </div>
        }
        description={dir || s.defaultsTo(fallback || '~')}
        title={dir ? dir : s.notSet}
      />
    </div>
  )
}
