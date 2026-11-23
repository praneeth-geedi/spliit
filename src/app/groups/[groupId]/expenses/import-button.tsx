'use client'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '@/components/ui/drawer'
import { useToast } from '@/components/ui/use-toast'
import { useActiveUser, useMediaQuery } from '@/lib/hooks'
import {
  IMPORT_MAX_FILE_SIZE,
  ImportFormat,
  ImportIssue,
  ImportSummary,
} from '@/lib/import-expenses'
import {
  formatCurrency,
  formatDate,
  formatFileSize,
  getCurrencyFromGroup,
} from '@/lib/utils'
import { trpc } from '@/trpc/client'
import { TRPCClientError } from '@trpc/client'
import { AlertCircle, FileUp, FolderOpen, Info, Loader2 } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import { PropsWithChildren, ReactNode, useRef, useState } from 'react'
import { useCurrentGroup } from '../current-group-context'

type ClientIssueCode = 'fileTooLarge' | 'unreadable'
type Issue = Omit<ImportIssue, 'code'> & {
  code: ImportIssue['code'] | ClientIssueCode
}

type State =
  | { step: 'idle' }
  | { step: 'checking'; fileName: string }
  | { step: 'checkFailed'; fileName: string }
  | {
      step: 'invalid'
      fileName: string
      format: ImportFormat | null
      issues: Issue[]
      issueCount: number
    }
  | {
      step: 'preview' | 'importing'
      fileName: string
      content: string
      summary: ImportSummary
    }
  | {
      step: 'importFailed'
      fileName: string
      format: ImportFormat | null
      issues: Issue[]
      issueCount: number
    }
  | { step: 'importUnconfirmed'; fileName: string }

export function ImportButton() {
  const t = useTranslations('ImportExpenses')
  const isDesktop = useMediaQuery('(min-width: 640px)')
  const [open, setOpen] = useState(false)
  // Remounted on every opening, so the dialog never shows a stale file.
  const [session, setSession] = useState(0)

  const DialogOrDrawer = isDesktop ? ImportDialog : ImportDrawer
  return (
    <DialogOrDrawer
      open={open}
      onOpenChange={(value) => {
        setOpen(value)
        if (value) setSession((s) => s + 1)
      }}
      trigger={
        <Button size="icon" variant="secondary" title={t('triggerTitle')}>
          <FileUp className="w-4 h-4" />
        </Button>
      }
      title={t('title')}
      description={t('description')}
    >
      <ImportDialogContent key={session} onImported={() => setOpen(false)} />
    </DialogOrDrawer>
  )
}

function ImportDialogContent({ onImported }: { onImported: () => void }) {
  const t = useTranslations('ImportExpenses')
  const locale = useLocale()
  const { groupId, group } = useCurrentGroup()
  const activeUser = useActiveUser(groupId)
  const { toast } = useToast()
  const utils = trpc.useUtils()
  const { mutateAsync: importMutateAsync } =
    trpc.groups.expenses.import.useMutation()
  const inputRef = useRef<HTMLInputElement>(null)
  const [state, setState] = useState<State>({ step: 'idle' })

  const participantId =
    activeUser && activeUser !== 'None' ? activeUser : undefined
  const busy = state.step === 'checking' || state.step === 'importing'

  const checkFile = async (file: File) => {
    const fileName = file.name
    if (file.size > IMPORT_MAX_FILE_SIZE) {
      setState({
        step: 'invalid',
        fileName,
        format: null,
        issueCount: 1,
        issues: [
          {
            code: 'fileTooLarge',
            values: {
              size: formatFileSize(file.size, locale),
              max: formatFileSize(IMPORT_MAX_FILE_SIZE, locale),
            },
          },
        ],
      })
      return
    }

    setState({ step: 'checking', fileName })
    let content: string
    try {
      content = await file.text()
    } catch (error) {
      console.error(error)
      setState({
        step: 'invalid',
        fileName,
        format: null,
        issueCount: 1,
        issues: [{ code: 'unreadable' }],
      })
      return
    }

    try {
      // A dry run: the server checks the file and writes nothing.
      const result = await importMutateAsync({
        groupId,
        content,
        dryRun: true,
        participantId,
      })
      setState(
        result.ok
          ? { step: 'preview', fileName, content, summary: result.summary }
          : { step: 'invalid', fileName, ...result },
      )
    } catch (error) {
      console.error(error)
      setState({ step: 'checkFailed', fileName })
    }
  }

  const runImport = async () => {
    if (state.step !== 'preview') return
    const { fileName, content } = state
    setState({ ...state, step: 'importing' })
    try {
      const result = await importMutateAsync({
        groupId,
        content,
        dryRun: false,
        participantId,
      })
      if (!result.ok) {
        // Checked again on the server and rejected, or the transaction was
        // rolled back: either way, nothing was saved.
        setState({ step: 'importFailed', fileName, ...result })
        return
      }
      await Promise.all([
        utils.groups.expenses.invalidate(),
        utils.groups.stats.invalidate(),
        utils.groups.balances.invalidate(),
        utils.groups.activities.invalidate(),
      ])
      toast({
        title: t('SuccessToast.title'),
        description: t('SuccessToast.description', {
          count: result.summary.imported,
        }),
      })
      onImported()
    } catch (error) {
      console.error(error)
      // The server answered with an error before saving anything; without an
      // answer, the import may or may not have gone through.
      const serverAnswered = error instanceof TRPCClientError && !!error.data
      setState(
        serverAnswered
          ? {
              step: 'importFailed',
              fileName,
              format: null,
              issueCount: 0,
              issues: [],
            }
          : { step: 'importUnconfirmed', fileName },
      )
    }
  }

  const chooseFileButton = (
    <Button
      variant={state.step === 'idle' ? 'default' : 'secondary'}
      disabled={busy}
      onClick={() => inputRef.current?.click()}
    >
      <FolderOpen className="w-4 h-4 mr-2" />
      {state.step === 'idle' ? t('chooseFile') : t('chooseAnother')}
    </Button>
  )

  return (
    <div className="flex flex-col gap-4 text-sm">
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        accept=".json,.csv,application/json,text/csv"
        onChange={(event) => {
          const file = event.target.files?.[0]
          // Cleared so that choosing the same file again (once fixed) fires.
          event.target.value = ''
          if (file) checkFile(file)
        }}
      />

      {state.step === 'idle' && (
        <div className="flex flex-col gap-2 text-muted-foreground">
          <p>{t('body')}</p>
          <p>{t('requirements')}</p>
          <p>{t('formats')}</p>
        </div>
      )}

      {state.step !== 'idle' && (
        <p className="truncate">
          <span className="text-muted-foreground">{t('file')}</span>{' '}
          <strong>{state.fileName}</strong>
        </p>
      )}

      {state.step === 'checking' && (
        <p className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />
          {t('checking')}
        </p>
      )}

      {state.step === 'checkFailed' && (
        <Alert variant="destructive">
          <AlertCircle className="w-4 h-4" />
          <AlertTitle>{t('CheckFailed.title')}</AlertTitle>
          <AlertDescription>{t('CheckFailed.description')}</AlertDescription>
        </Alert>
      )}

      {state.step === 'invalid' && (
        <Alert variant="destructive">
          <AlertCircle className="w-4 h-4" />
          <AlertTitle>{t('Invalid.title')}</AlertTitle>
          <AlertDescription>
            <p>{t('Invalid.description')}</p>
            <IssueList
              format={state.format}
              issues={state.issues}
              issueCount={state.issueCount}
            />
          </AlertDescription>
        </Alert>
      )}

      {state.step === 'importFailed' && (
        <Alert variant="destructive">
          <AlertCircle className="w-4 h-4" />
          <AlertTitle>{t('Failed.title')}</AlertTitle>
          <AlertDescription>
            <p>{t('Failed.description')}</p>
            <IssueList
              format={state.format}
              issues={state.issues}
              issueCount={state.issueCount}
            />
          </AlertDescription>
        </Alert>
      )}

      {state.step === 'importUnconfirmed' && (
        <Alert variant="destructive">
          <AlertCircle className="w-4 h-4" />
          <AlertTitle>{t('Unconfirmed.title')}</AlertTitle>
          <AlertDescription>{t('Unconfirmed.description')}</AlertDescription>
        </Alert>
      )}

      {(state.step === 'preview' || state.step === 'importing') && (
        <ImportPreview
          summary={state.summary}
          currency={group ? getCurrencyFromGroup(group) : null}
        />
      )}

      <div className="flex flex-wrap justify-end gap-2">
        {chooseFileButton}
        {(state.step === 'preview' || state.step === 'importing') &&
          state.summary.imported > 0 && (
            <Button disabled={busy} onClick={runImport}>
              {state.step === 'importing' ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  {t('Preview.importing')}
                </>
              ) : (
                t('Preview.import', { count: state.summary.imported })
              )}
            </Button>
          )}
      </div>
    </div>
  )
}

function ImportPreview({
  summary,
  currency,
}: {
  summary: ImportSummary
  currency: ReturnType<typeof getCurrencyFromGroup> | null
}) {
  const t = useTranslations('ImportExpenses.Preview')
  const locale = useLocale()
  const formatDay = (date: string) =>
    formatDate(new Date(`${date}T12:00:00.000Z`), locale, {
      dateStyle: 'medium',
    })

  if (summary.imported === 0) {
    return (
      <Alert>
        <Info className="w-4 h-4" />
        <AlertDescription>{t('nothingToImport')}</AlertDescription>
      </Alert>
    )
  }

  const notes = [
    summary.alreadyInGroup > 0 &&
      t('alreadyInGroup', { count: summary.alreadyInGroup }),
    summary.possibleDuplicates > 0 &&
      t('possibleDuplicates', { count: summary.possibleDuplicates }),
    summary.recurringAsOneOff > 0 &&
      t('recurring', { count: summary.recurringAsOneOff }),
  ].filter(Boolean)

  return (
    <>
      <div className="rounded-lg border p-4 flex flex-col gap-1">
        <strong>
          {t('ready', {
            count: summary.imported,
            format: summary.format.toUpperCase(),
          })}
        </strong>
        {summary.firstDate && summary.lastDate && (
          <span className="text-muted-foreground">
            {summary.firstDate === summary.lastDate
              ? t('oneDay', { date: formatDay(summary.firstDate) })
              : t('dates', {
                  first: formatDay(summary.firstDate),
                  last: formatDay(summary.lastDate),
                })}
          </span>
        )}
        {currency && (
          <span className="text-muted-foreground">
            {t('total', {
              total: formatCurrency(currency, summary.totalAmount, locale),
            })}
          </span>
        )}
      </div>
      {notes.length > 0 && (
        <Alert>
          <Info className="w-4 h-4" />
          <AlertDescription>
            <ul className="list-disc pl-4 flex flex-col gap-1">
              {notes.map((note) => (
                <li key={String(note)}>{note}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
    </>
  )
}

function IssueList({
  format,
  issues,
  issueCount,
}: {
  format: ImportFormat | null
  issues: Issue[]
  issueCount: number
}) {
  const t = useTranslations('ImportExpenses')
  const tSchema = useTranslations('SchemaErrors')
  if (issues.length === 0) return null

  const message = (issue: Issue) => {
    const values = { ...issue.values }
    if (issue.code === 'invalidField') {
      const field = String(values.field)
      const reason = String(values.reason)
      values.field = t.has(`Fields.${field}`) ? t(`Fields.${field}`) : field
      // Reasons are the expense form's own messages; the few that expect
      // values the import cannot provide have their own wording.
      values.reason = t.has(`Reasons.${reason}`)
        ? t(`Reasons.${reason}`)
        : tSchema.has(reason)
          ? tSchema(reason)
          : t('Reasons.other')
    }
    const text = t(`Issues.${issue.code}`, values)
    if (issue.row === undefined) return text
    return format === 'json'
      ? t('rowJson', { row: issue.row, message: text })
      : t('rowCsv', { row: issue.row, message: text })
  }

  return (
    <>
      <ul className="list-disc pl-4 mt-2 flex flex-col gap-1 max-h-[40vh] overflow-y-auto">
        {issues.map((issue, index) => (
          <li key={index}>{message(issue)}</li>
        ))}
      </ul>
      {issueCount > issues.length && (
        <p className="mt-2">
          {t('Invalid.more', { count: issueCount - issues.length })}
        </p>
      )}
    </>
  )
}

type WrapperProps = PropsWithChildren<{
  open: boolean
  onOpenChange: (open: boolean) => void
  trigger: ReactNode
  title: ReactNode
  description: ReactNode
}>

function ImportDialog({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  children,
}: WrapperProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="text-left">
            {description}
          </DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  )
}

function ImportDrawer({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  children,
}: WrapperProps) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerTrigger asChild>{trigger}</DrawerTrigger>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{title}</DrawerTitle>
          <DrawerDescription className="text-left">
            {description}
          </DrawerDescription>
        </DrawerHeader>
        <div className="px-4 pb-4">{children}</div>
      </DrawerContent>
    </Drawer>
  )
}
