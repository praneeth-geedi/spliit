import { RecurrenceRule, SplitMode } from '@/generated/prisma/browser'
import { getCurrency } from '@/lib/currency'
import { expenseFormSchema } from '@/lib/schemas'
import { getExpenseShares } from '@/lib/shares'
import { formatAmountAsDecimal, getCurrencyFromGroup } from '@/lib/utils'
import Decimal from 'decimal.js'
import * as z from 'zod'

/**
 * Importing expenses from the files the export routes produce
 * (`expenses/export/json` and `expenses/export/csv`).
 *
 * Everything in this module is pure. `parseImportFile` turns a file into
 * expenses ready to save, or into the list of problems that stop it from being
 * imported. `planImport` then picks ids and decides what to skip, given what
 * the group already holds. `importExpenses` in api.ts does the database work,
 * in a single transaction, so an import is either saved whole or not at all.
 */

export const IMPORT_MAX_FILE_SIZE = 10 * 1024 ** 2
export const IMPORT_MAX_EXPENSES = 5_000
/** How many problems are sent back; the dialog says how many more there are. */
export const IMPORT_MAX_ISSUES = 20

export type ImportFormat = 'csv' | 'json'

export type ImportIssueCode =
  // The file as a whole
  | 'empty'
  | 'invalidJson'
  | 'jsonStructure'
  | 'csvSyntax'
  | 'csvHeader'
  | 'csvDuplicateColumn'
  | 'noExpenses'
  | 'tooManyExpenses'
  | 'currencyMismatch'
  | 'unknownParticipants'
  // One expense (`row`)
  | 'jsonExpenseStructure'
  | 'jsonUnknownParticipantId'
  | 'columnCount'
  | 'invalidDate'
  | 'invalidAmount'
  | 'missingValue'
  | 'unknownCategory'
  | 'invalidSplitMode'
  | 'invalidYesNo'
  | 'invalidCurrencyCode'
  | 'payerNotFound'
  | 'multiplePayers'
  | 'ambiguousPayer'
  | 'sharesMismatch'
  | 'unevenSplit'
  | 'duplicateParticipant'
  | 'invalidField'
  // Raised by api.ts
  | 'groupNotFound'
  | 'saveFailed'

export type ImportIssue = {
  code: ImportIssueCode
  /**
   * CSV: the spreadsheet row, counting the header as row 1.
   * JSON: the expense's position in the file's `expenses`, from 1.
   */
  row?: number
  values?: Record<string, string | number>
}

export type ImportContext = {
  group: {
    currency: string
    currencyCode: string | null
    participants: { id: string; name: string }[]
  }
  categories: { id: number; grouping: string; name: string }[]
}

export type ParsedExpense = {
  /** The id the expense had in the exported group (JSON only). */
  sourceId: string | null
  createdAt: Date | null
  expenseDate: Date
  title: string
  categoryId: number
  amount: number
  originalAmount: number | null
  originalCurrency: string | null
  conversionRate: string | null
  paidById: string
  paidFor: { participantId: string; shares: number }[]
  isReimbursement: boolean
  splitMode: SplitMode
  notes: string | null
  /**
   * Recurring expenses are imported as one-off expenses: an export holds every
   * occurrence already created, and re-arming each of them would make every
   * one start its own series.
   */
  wasRecurring: boolean
  /**
   * What each participant is charged in the exported group, in minor units.
   * Uneven leftovers go to a participant picked from the expense id (see
   * `getExpenseShares`), so `planImport` uses this to pick an id that charges
   * everyone exactly what the file says.
   */
  expectedShares: Map<string, number>
}

export type ParseResult =
  | { ok: true; format: ImportFormat; expenses: ParsedExpense[] }
  | { ok: false; format: ImportFormat | null; issues: ImportIssue[] }

export type ImportSummary = {
  format: ImportFormat
  /** Expenses that are (or, for a dry run, would be) added. */
  imported: number
  /** In the file, but already in this group with the same id: skipped. */
  alreadyInGroup: number
  /** Same date, title, amount and payer as an expense already in the group. */
  possibleDuplicates: number
  recurringAsOneOff: number
  /** YYYY-MM-DD */
  firstDate: string | null
  lastDate: string | null
  /** Sum of the imported expenses that are not reimbursements, minor units. */
  totalAmount: number
}

export type ImportResult =
  | { ok: true; dryRun: boolean; summary: ImportSummary }
  | {
      ok: false
      format: ImportFormat | null
      /** At most IMPORT_MAX_ISSUES of them. */
      issues: ImportIssue[]
      issueCount: number
    }

export function importFailure(
  format: ImportFormat | null,
  issues: ImportIssue[],
): ImportResult {
  return {
    ok: false,
    format,
    issues: issues.slice(0, IMPORT_MAX_ISSUES),
    issueCount: issues.length,
  }
}

export function parseImportFile(
  content: string,
  context: ImportContext,
): ParseResult {
  // The CSV export starts with a byte order mark.
  const text = content.replace(/^﻿/, '')
  if (text.trim() === '')
    return { ok: false, format: null, issues: [{ code: 'empty' }] }
  const firstCharacter = text.trimStart()[0]
  return firstCharacter === '{' || firstCharacter === '['
    ? parseJsonExport(text, context)
    : parseCsvExport(text, context)
}

// ---------------------------------------------------------------------------
// Shared helpers

const MAX_AMOUNT = 10_000_000_00 // Same bound as expenseFormSchema, both signs.
const INT32_MAX = 2 ** 31 - 1
const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/
const EXPENSE_ID_PATTERN = /^[A-Za-z0-9_-]{21}$/

/** `12.50` in a currency with 2 decimals => 1250. Null if not exact. */
function parseMinorUnits(value: string, decimalDigits: number): number | null {
  if (!DECIMAL_PATTERN.test(value)) return null
  const minorUnits = new Decimal(value).times(
    new Decimal(10).pow(decimalDigits),
  )
  if (!minorUnits.isInteger()) return null
  const result = minorUnits.toNumber()
  return Number.isSafeInteger(result) ? result : null
}

/** A positive decimal, normalised; null if it is not one. */
function parseRate(value: string): string | null {
  if (!DECIMAL_PATTERN.test(value)) return null
  const rate = new Decimal(value)
  return rate.greaterThan(0) ? rate.toString() : null
}

/**
 * The date of an expense, as the DATE column carries it: UTC midnight. Takes
 * `YYYY-MM-DD` (CSV) or the UTC-midnight timestamp the JSON export writes.
 */
function parseDateOnly(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.0+)?Z)?$/.exec(value)
  if (!match) return null
  const [year, month, day] = match.slice(1).map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? date
    : null
}

export function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10)
}

/** Finds a participant by exact name, or by name ignoring case if unique. */
function findByName<T extends { name: string }>(items: T[], name: string) {
  const exact = items.find((item) => item.name === name)
  if (exact) return exact
  const folded = name.trim().toLocaleLowerCase()
  const matches = items.filter(
    (item) => item.name.trim().toLocaleLowerCase() === folded,
  )
  return matches.length === 1 ? matches[0] : undefined
}

function sameCurrency(
  file: { currency: string; currencyCode?: string | null },
  group: ImportContext['group'],
) {
  const fileCode = file.currencyCode || null
  const groupCode = group.currencyCode || null
  if (fileCode || groupCode) return fileCode === groupCode
  return file.currency === group.currency
}

function groupCurrencyLabel(group: ImportContext['group']) {
  return group.currencyCode || group.currency
}

/**
 * The last word on whether an expense can be saved: the same schema the
 * expense form and the create procedure validate against.
 */
function checkWithExpenseSchema(
  expense: Omit<ParsedExpense, 'expectedShares'>,
  row: number,
  issues: ImportIssue[],
) {
  const reasons = new Map<string, string>()
  for (const [field, value] of [
    ['amount', expense.amount],
    ['originalAmount', expense.originalAmount],
  ] as const) {
    if (value !== null && Math.abs(value) > MAX_AMOUNT)
      reasons.set(`${field}:amountTenMillion`, field)
  }
  const result = expenseFormSchema.safeParse({
    expenseDate: expense.expenseDate,
    title: expense.title,
    category: expense.categoryId,
    amount: expense.amount,
    originalAmount: expense.originalAmount ?? undefined,
    originalCurrency: expense.originalCurrency,
    conversionRate:
      expense.conversionRate === null
        ? undefined
        : Number(expense.conversionRate),
    paidBy: expense.paidById,
    paidFor: expense.paidFor.map(({ participantId, shares }) => ({
      participant: participantId,
      shares,
    })),
    splitMode: expense.splitMode,
    saveDefaultSplittingOptions: false,
    isReimbursement: expense.isReimbursement,
    documents: [],
    notes: expense.notes ?? undefined,
    recurrenceRule: RecurrenceRule.NONE,
  })
  if (!result.success) {
    for (const issue of result.error.issues) {
      const field = String(issue.path[0] ?? '')
      reasons.set(`${field}:${issue.message}`, field)
    }
  }
  for (const [key, field] of reasons) {
    issues.push({
      code: 'invalidField',
      row,
      values: { field, reason: key.slice(field.length + 1) },
    })
  }
  return reasons.size === 0
}

function finish(
  format: ImportFormat,
  expenses: ParsedExpense[],
  issues: ImportIssue[],
  unknownNames: Set<string>,
): ParseResult {
  if (unknownNames.size > 0) {
    issues.unshift({
      code: 'unknownParticipants',
      values: { names: [...unknownNames].join(', ') },
    })
  }
  if (issues.length > 0) return { ok: false, format, issues }
  return { ok: true, format, expenses }
}

function checkExpenseCount(format: ImportFormat, count: number) {
  if (count === 0)
    return {
      ok: false as const,
      format,
      issues: [{ code: 'noExpenses' as const }],
    }
  if (count > IMPORT_MAX_EXPENSES)
    return {
      ok: false as const,
      format,
      issues: [
        {
          code: 'tooManyExpenses' as const,
          values: { count, max: IMPORT_MAX_EXPENSES },
        },
      ],
    }
  return null
}

// ---------------------------------------------------------------------------
// JSON: the export of `prisma.group.findUnique` (see export/json/route.ts)

const int32 = z
  .number()
  .int()
  .min(-INT32_MAX - 1)
  .max(INT32_MAX)

const jsonFileSchema = z.object({
  currency: z.string(),
  currencyCode: z.string().nullish(),
  participants: z.array(z.object({ id: z.string(), name: z.string() })),
  expenses: z.array(z.unknown()),
})

const jsonExpenseSchema = z.object({
  id: z.string().nullish(),
  createdAt: z.string().nullish(),
  expenseDate: z.string(),
  title: z.string(),
  category: z.object({ grouping: z.string(), name: z.string() }).nullish(),
  amount: int32,
  originalAmount: int32.nullish(),
  originalCurrency: z.string().nullish(),
  conversionRate: z.union([z.string(), z.number()]).nullish(),
  paidById: z.string(),
  paidFor: z.array(z.object({ participantId: z.string(), shares: int32 })),
  isReimbursement: z.boolean(),
  splitMode: z.enum(SplitMode),
  recurrenceRule: z.enum(RecurrenceRule).nullish(),
  notes: z.string().nullish(),
})

function zodPath(error: z.ZodError) {
  return error.issues[0]?.path.join('.') ?? ''
}

function parseJsonExport(text: string, context: ImportContext): ParseResult {
  const { group, categories } = context
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, format: 'json', issues: [{ code: 'invalidJson' }] }
  }

  const file = jsonFileSchema.safeParse(data)
  if (!file.success) {
    return {
      ok: false,
      format: 'json',
      issues: [
        { code: 'jsonStructure', values: { field: zodPath(file.error) } },
      ],
    }
  }
  const countIssue = checkExpenseCount('json', file.data.expenses.length)
  if (countIssue) return countIssue
  if (!sameCurrency(file.data, group)) {
    return {
      ok: false,
      format: 'json',
      issues: [
        {
          code: 'currencyMismatch',
          values: {
            file: file.data.currencyCode || file.data.currency,
            group: groupCurrencyLabel(group),
          },
        },
      ],
    }
  }

  // A participant keeps their id when the file comes from this very group;
  // otherwise they are matched by name.
  const fileParticipants = new Map(
    file.data.participants.map((participant) => [participant.id, participant]),
  )
  const unknownNames = new Set<string>()
  const resolveParticipant = (fileId: string) => {
    const sameId = group.participants.find((p) => p.id === fileId)
    if (sameId) return sameId.id
    const fileParticipant = fileParticipants.get(fileId)
    if (!fileParticipant) return { unknownId: fileId }
    const byName = findByName(group.participants, fileParticipant.name)
    if (byName) return byName.id
    unknownNames.add(fileParticipant.name)
    return null
  }

  const issues: ImportIssue[] = []
  const expenses: ParsedExpense[] = []
  file.data.expenses.forEach((rawExpense, index) => {
    const row = index + 1
    const parsed = jsonExpenseSchema.safeParse(rawExpense)
    if (!parsed.success) {
      issues.push({
        code: 'jsonExpenseStructure',
        row,
        values: { field: zodPath(parsed.error) },
      })
      return
    }
    const expense = parsed.data
    const rowIssueCount = issues.length

    const expenseDate = parseDateOnly(expense.expenseDate)
    if (!expenseDate)
      issues.push({
        code: 'invalidDate',
        row,
        values: { value: expense.expenseDate },
      })

    let categoryId = 0
    if (expense.category) {
      const { grouping, name } = expense.category
      const category =
        categories.find((c) => c.grouping === grouping && c.name === name) ??
        findByName(categories, name)
      if (category) categoryId = category.id
      else
        issues.push({
          code: 'unknownCategory',
          row,
          values: { value: `${grouping} › ${name}` },
        })
    }

    let conversionRate: string | null = null
    if (
      expense.conversionRate !== null &&
      expense.conversionRate !== undefined
    ) {
      conversionRate = parseRate(String(expense.conversionRate))
      if (conversionRate === null)
        issues.push({
          code: 'invalidAmount',
          row,
          values: {
            column: 'conversionRate',
            value: String(expense.conversionRate),
          },
        })
    }

    const participantIds = [
      expense.paidById,
      ...expense.paidFor.map((p) => p.participantId),
    ]
    const resolved = new Map<string, string | null>()
    for (const fileId of participantIds) {
      const result = resolveParticipant(fileId)
      if (result !== null && typeof result === 'object') {
        issues.push({
          code: 'jsonUnknownParticipantId',
          row,
          values: { id: result.unknownId },
        })
        resolved.set(fileId, null)
      } else {
        resolved.set(fileId, result)
      }
    }
    const paidById = resolved.get(expense.paidById)
    const paidFor = expense.paidFor.map(({ participantId, shares }) => ({
      participantId: resolved.get(participantId) ?? null,
      shares,
    }))
    const mappedIds = paidFor.map((p) => p.participantId)
    const knownIds = mappedIds.filter((id) => id !== null)
    if (new Set(knownIds).size !== knownIds.length)
      issues.push({ code: 'duplicateParticipant', row })

    if (
      issues.length > rowIssueCount ||
      !expenseDate ||
      !paidById ||
      mappedIds.some((id) => id === null)
    )
      return

    const sourceId =
      expense.id && EXPENSE_ID_PATTERN.test(expense.id) ? expense.id : null
    const createdAt = expense.createdAt ? new Date(expense.createdAt) : null
    const candidate = {
      sourceId,
      createdAt:
        createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : null,
      expenseDate,
      title: expense.title,
      categoryId,
      amount: expense.amount,
      originalAmount: expense.originalAmount ?? null,
      originalCurrency: expense.originalCurrency || null,
      conversionRate,
      paidById,
      paidFor: paidFor as ParsedExpense['paidFor'],
      isReimbursement: expense.isReimbursement,
      splitMode: expense.splitMode,
      notes: expense.notes || null,
      wasRecurring:
        !!expense.recurrenceRule &&
        expense.recurrenceRule !== RecurrenceRule.NONE,
    }
    if (!checkWithExpenseSchema(candidate, row, issues)) return

    // The split as the exporting group computed it: with the file's own
    // participant ids, which decide the order leftovers are handed out in.
    const fileShares = getExpenseShares({
      id: expense.id,
      amount: expense.amount,
      splitMode: expense.splitMode,
      paidFor: expense.paidFor,
    })
    expenses.push({
      ...candidate,
      expectedShares: new Map(
        [...fileShares].map(([fileId, share]) => [
          resolved.get(fileId)!,
          share,
        ]),
      ),
    })
  })

  return finish('json', expenses, issues, unknownNames)
}

// ---------------------------------------------------------------------------
// CSV (see export/csv/route.ts)

export const CSV_COLUMNS = [
  'Date',
  'Description',
  'Category',
  'Currency',
  'Cost',
  'Original cost',
  'Original currency',
  'Conversion rate',
  'Is Reimbursement',
  'Split mode',
] as const

const SPLIT_MODE_BY_LABEL = new Map<string, SplitMode>([
  ['evenly', SplitMode.EVENLY],
  ['unevenly - by shares', SplitMode.BY_SHARES],
  ['unevenly - by percentage', SplitMode.BY_PERCENTAGE],
  ['unevenly - by amount', SplitMode.BY_AMOUNT],
  ...Object.values(SplitMode).map(
    (mode) => [mode.toLowerCase(), mode] as [string, SplitMode],
  ),
])

function parseSplitMode(label: string) {
  const normalized = label
    .trim()
    .toLowerCase()
    .replace(/[‒-―−]/g, '-') // the export writes an en dash
    .replace(/\s+/g, ' ')
  return SPLIT_MODE_BY_LABEL.get(normalized) ?? null
}

/**
 * The export prefixes text that a spreadsheet could run as a formula with a
 * quote (`escapeCsvFormula`). Undo that.
 */
function unescapeCsvFormula(value: string) {
  return /^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value
}

/**
 * RFC 4180: comma-separated, records separated by CRLF or LF, fields
 * optionally quoted with `"`, a quote inside a quoted field doubled.
 */
export function parseCsv(
  text: string,
): { ok: true; records: string[][] } | { ok: false; row: number } {
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let i = 0
  const endField = () => {
    record.push(field)
    field = ''
  }
  const endRecord = () => {
    endField()
    records.push(record)
    record = []
  }
  while (i < text.length) {
    const char = text[i]
    if (char === '"' && field === '') {
      // Quoted field: runs to the next quote that is not doubled.
      i++
      for (;;) {
        if (i >= text.length) return { ok: false, row: records.length + 1 }
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            field += '"'
            i += 2
            continue
          }
          i++
          break
        }
        field += text[i++]
      }
      const next = text[i]
      if (next !== undefined && next !== ',' && next !== '\n' && next !== '\r')
        return { ok: false, row: records.length + 1 }
      // An empty quoted field ("") must still count as a field: mark it.
      if (field === '') field = '\u0000'
      continue
    }
    if (char === ',') {
      endField()
      i++
    } else if (char === '\r' || char === '\n') {
      endRecord()
      i += char === '\r' && text[i + 1] === '\n' ? 2 : 1
    } else {
      field += char
      i++
    }
  }
  if (field !== '' || record.length > 0) endRecord()
  return {
    ok: true,
    records: records.map((r) => r.map((f) => (f === '\u0000' ? '' : f))),
  }
}

function sameLabel(a: string, b: string) {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b]
  return a
}

/** Largest remainder: splits `total` in proportion to `weights`, exactly. */
function apportionByWeight(total: number, weights: number[]) {
  const sum = weights.reduce((s, w) => s + w, 0)
  const exact = weights.map((w) => (total * w) / sum)
  const result = exact.map(Math.floor)
  let left = total - result.reduce((s, v) => s + v, 0)
  const order = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder)
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--)
    result[order[k].index]++
  return result
}

function parseCsvExport(text: string, context: ImportContext): ParseResult {
  const { group, categories } = context
  const csv = parseCsv(text)
  if (!csv.ok)
    return {
      ok: false,
      format: 'csv',
      issues: [{ code: 'csvSyntax', row: csv.row }],
    }

  const [header = [], ...records] = csv.records
  const expectedHeader = CSV_COLUMNS.join(', ')
  if (
    header.length <= CSV_COLUMNS.length ||
    CSV_COLUMNS.some((column, index) => !sameLabel(header[index], column))
  ) {
    return {
      ok: false,
      format: 'csv',
      issues: [{ code: 'csvHeader', values: { expected: expectedHeader } }],
    }
  }

  // One column per participant of the exported group, after the fixed ones.
  const participantColumns = header
    .slice(CSV_COLUMNS.length)
    .map((label) => unescapeCsvFormula(label).trim())
    .map((name) => ({
      name,
      participant: findByName(group.participants, name),
    }))
  const seen = new Set<string>()
  for (const { name, participant } of participantColumns) {
    const key = participant?.id ?? `name:${name.toLowerCase()}`
    if (seen.has(key))
      return {
        ok: false,
        format: 'csv',
        issues: [{ code: 'csvDuplicateColumn', values: { name } }],
      }
    seen.add(key)
  }

  const rows = records
    .map((cells, index) => ({ cells, row: index + 2 }))
    .filter(({ cells }) => !cells.every((cell) => cell.trim() === ''))
  const countIssue = checkExpenseCount('csv', rows.length)
  if (countIssue) return countIssue

  const groupCurrency = getCurrencyFromGroup(group)
  const acceptedCurrencies = new Set(
    [
      group.currencyCode ?? group.currency,
      group.currencyCode || group.currency,
    ].map((c) => c.trim()),
  )
  const format = (minorUnits: number) =>
    formatAmountAsDecimal(minorUnits, groupCurrency)

  const issues: ImportIssue[] = []
  const expenses: ParsedExpense[] = []
  const unknownNames = new Set<string>()

  for (const { cells, row } of rows) {
    if (cells.length !== header.length) {
      issues.push({
        code: 'columnCount',
        row,
        values: { expected: header.length, actual: cells.length },
      })
      continue
    }
    const rowIssueCount = issues.length
    const cell = (index: number) => unescapeCsvFormula(cells[index]).trim()
    const [
      dateCell,
      ,
      categoryCell,
      currencyCell,
      costCell,
      originalCostCell,
      originalCurrencyCell,
      rateCell,
      reimbursementCell,
      splitModeCell,
    ] = CSV_COLUMNS.map((_, index) => cell(index))

    const expenseDate = parseDateOnly(dateCell)
    if (!expenseDate)
      issues.push({ code: 'invalidDate', row, values: { value: dateCell } })

    let categoryId = 0
    if (categoryCell !== '') {
      const category = findByName(categories, categoryCell)
      if (category) categoryId = category.id
      else
        issues.push({
          code: 'unknownCategory',
          row,
          values: { value: categoryCell },
        })
    }

    if (!acceptedCurrencies.has(currencyCell)) {
      // The same for every row of an export: once is enough.
      if (!issues.some((issue) => issue.code === 'currencyMismatch'))
        issues.push({
          code: 'currencyMismatch',
          row,
          values: { file: currencyCell, group: groupCurrencyLabel(group) },
        })
      continue
    }

    const amount = parseMinorUnits(costCell, groupCurrency.decimal_digits)
    if (amount === null)
      issues.push({
        code: 'invalidAmount',
        row,
        values: { column: 'Cost', value: costCell },
      })

    let originalCurrency: string | null = null
    if (originalCurrencyCell !== '') {
      if (/^[A-Z]{3}$/.test(originalCurrencyCell))
        originalCurrency = originalCurrencyCell
      else
        issues.push({
          code: 'invalidCurrencyCode',
          row,
          values: { value: originalCurrencyCell },
        })
    }
    let originalAmount: number | null = null
    if (originalCostCell !== '') {
      originalAmount = parseMinorUnits(
        originalCostCell,
        getCurrency(originalCurrency).decimal_digits,
      )
      if (originalAmount === null)
        issues.push({
          code: 'invalidAmount',
          row,
          values: { column: 'Original cost', value: originalCostCell },
        })
    }
    let conversionRate: string | null = null
    if (rateCell !== '') {
      conversionRate = parseRate(rateCell)
      if (conversionRate === null)
        issues.push({
          code: 'invalidAmount',
          row,
          values: { column: 'Conversion rate', value: rateCell },
        })
    }

    const yesNo = reimbursementCell.toLowerCase()
    const isReimbursement = yesNo === 'yes' || yesNo === 'true'
    if (!isReimbursement && yesNo !== 'no' && yesNo !== 'false')
      issues.push({
        code: 'invalidYesNo',
        row,
        values: { column: 'Is Reimbursement', value: reimbursementCell },
      })

    const splitMode = parseSplitMode(splitModeCell)
    if (!splitMode)
      issues.push({
        code: 'invalidSplitMode',
        row,
        values: { value: splitModeCell },
      })

    // The participant columns: what the payer is charged themselves as a
    // positive number, what everyone else is charged as a negative one.
    const values: number[] = []
    participantColumns.forEach(({ name }, index) => {
      const value = cell(CSV_COLUMNS.length + index)
      if (value === '') {
        issues.push({ code: 'missingValue', row, values: { column: name } })
        return
      }
      const minorUnits = parseMinorUnits(value, groupCurrency.decimal_digits)
      if (minorUnits === null)
        issues.push({
          code: 'invalidAmount',
          row,
          values: { column: name, value },
        })
      else values[index] = minorUnits
    })

    if (issues.length > rowIssueCount || amount === null || !splitMode) continue

    // Signs are reversed for an income (negative amount).
    const sign = Math.sign(amount)
    const charged = participantColumns.map((_, index) => values[index])
    const payerCandidates = charged
      .map((value, index) => ({ value, index }))
      .filter(({ value }) => Math.sign(value) === sign)
    let payerIndex: number
    if (payerCandidates.length > 1) {
      issues.push({ code: 'multiplePayers', row })
      continue
    } else if (payerCandidates.length === 1) {
      payerIndex = payerCandidates[0].index
    } else {
      // The payer is not part of the split, so their column shows 0, like
      // everyone else who is not involved. Only decidable if there is just one.
      const zeros = charged.flatMap((value, index) =>
        value === 0 ? [index] : [],
      )
      if (zeros.length === 0) {
        issues.push({ code: 'payerNotFound', row })
        continue
      }
      if (zeros.length > 1) {
        issues.push({ code: 'ambiguousPayer', row })
        continue
      }
      payerIndex = zeros[0]
    }
    const shares = charged.map((value, index) =>
      index === payerIndex ? value : -value,
    )
    const sum = shares.reduce((s, v) => s + v, 0)
    if (sum !== amount) {
      issues.push({
        code: 'sharesMismatch',
        row,
        values: { sum: format(sum), amount: format(amount) },
      })
      continue
    }

    const involved = shares
      .map((share, index) => ({ share, index }))
      .filter(({ share }) => share !== 0)
    for (const index of [payerIndex, ...involved.map((i) => i.index)]) {
      const { name, participant } = participantColumns[index]
      if (!participant) unknownNames.add(name)
    }
    if (involved.some(({ index }) => !participantColumns[index].participant))
      continue
    const payer = participantColumns[payerIndex].participant
    if (!payer) continue

    const magnitudes = involved.map(({ share }) => Math.abs(share))
    let paidForShares: number[]
    switch (splitMode) {
      case SplitMode.EVENLY:
        if (Math.max(...magnitudes) - Math.min(...magnitudes) > 1) {
          issues.push({ code: 'unevenSplit', row })
          continue
        }
        paidForShares = involved.map(() => 100) // what the form saves for "1"
        break
      case SplitMode.BY_AMOUNT:
        paidForShares = involved.map(({ share }) => share)
        break
      case SplitMode.BY_SHARES: {
        // The share counts themselves are not exported, only the amounts
        // they produce: use the amounts, in lowest terms, as the shares.
        const divisor = magnitudes.reduce(gcd)
        const reduced = magnitudes.map((m) => m / divisor)
        paidForShares =
          Math.max(...reduced) * 100 <= INT32_MAX
            ? reduced.map((r) => r * 100)
            : reduced
        break
      }
      case SplitMode.BY_PERCENTAGE:
        // Percentages are stored in hundredths of a percent, adding up to 100%.
        paidForShares = apportionByWeight(10_000, magnitudes)
        break
    }

    const candidate = {
      sourceId: null,
      createdAt: null,
      expenseDate: expenseDate!,
      title: unescapeCsvFormula(cells[1]),
      categoryId,
      amount,
      originalAmount,
      originalCurrency,
      conversionRate,
      paidById: payer.id,
      paidFor: involved.map(({ index }, k) => ({
        participantId: participantColumns[index].participant!.id,
        shares: paidForShares[k],
      })),
      isReimbursement,
      splitMode,
      notes: null,
      wasRecurring: false,
    }
    if (!checkWithExpenseSchema(candidate, row, issues)) continue
    expenses.push({
      ...candidate,
      expectedShares: new Map(
        involved.map(({ index, share }) => [
          participantColumns[index].participant!.id,
          share,
        ]),
      ),
    })
  }

  return finish('csv', expenses, issues, unknownNames)
}

// ---------------------------------------------------------------------------
// Planning: ids, duplicates, summary

export type PlannedExpense = ParsedExpense & { id: string }

function contentKey(expense: {
  expenseDate: Date
  title: string
  amount: number
  paidById: string
}) {
  return JSON.stringify([
    formatDateOnly(expense.expenseDate),
    expense.title.trim().toLowerCase(),
    expense.amount,
    expense.paidById,
  ])
}

function chargesAsExpected(expense: ParsedExpense, id: string) {
  const shares = getExpenseShares({ ...expense, id })
  if (shares.size !== expense.expectedShares.size) return false
  for (const [participantId, share] of expense.expectedShares)
    if ((shares.get(participantId) ?? 0) !== share) return false
  return true
}

/**
 * Each attempt has at least a 1-in-(participants) chance, so this finds one
 * for any group of a reasonable size. Past it, the split may differ from the
 * file by one minor unit.
 */
const ID_ATTEMPTS = 100

export function planImport(
  format: ImportFormat,
  expenses: ParsedExpense[],
  existing: {
    groupId: string
    /** Group of every expense, in any group, whose id the file reuses. */
    groupIdByExpenseId: Map<string, string>
    /** The expenses already in the group. */
    groupExpenses: {
      expenseDate: Date
      title: string
      amount: number
      paidById: string
    }[]
  },
  newId: () => string,
): { expenses: PlannedExpense[]; summary: ImportSummary } {
  const existingContent = new Set(existing.groupExpenses.map(contentKey))
  const usedIds = new Set<string>()
  const planned: PlannedExpense[] = []
  let alreadyInGroup = 0
  let possibleDuplicates = 0

  for (const expense of expenses) {
    const { sourceId } = expense
    if (
      sourceId &&
      existing.groupIdByExpenseId.get(sourceId) === existing.groupId
    ) {
      alreadyInGroup++
      continue
    }
    if (existingContent.has(contentKey(expense))) possibleDuplicates++

    // Keep the exported id when it is free and still splits the same way:
    // importing the same file again then skips the expense.
    let id =
      sourceId &&
      !existing.groupIdByExpenseId.has(sourceId) &&
      !usedIds.has(sourceId) &&
      chargesAsExpected(expense, sourceId)
        ? sourceId
        : null
    for (let attempt = 0; !id; attempt++) {
      const candidate = newId()
      if (
        !usedIds.has(candidate) &&
        (attempt >= ID_ATTEMPTS || chargesAsExpected(expense, candidate))
      )
        id = candidate
    }
    usedIds.add(id)
    planned.push({ ...expense, id })
  }

  const dates = planned.map((e) => formatDateOnly(e.expenseDate)).sort()
  return {
    expenses: planned,
    summary: {
      format,
      imported: planned.length,
      alreadyInGroup,
      possibleDuplicates,
      recurringAsOneOff: planned.filter((e) => e.wasRecurring).length,
      firstDate: dates[0] ?? null,
      lastDate: dates[dates.length - 1] ?? null,
      totalAmount: planned
        .filter((e) => !e.isReimbursement)
        .reduce((sum, e) => sum + e.amount, 0),
    },
  }
}
