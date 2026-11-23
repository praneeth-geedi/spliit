import { GET as exportCsv } from '@/app/groups/[groupId]/expenses/export/csv/route'
import { GET as exportJson } from '@/app/groups/[groupId]/expenses/export/json/route'
import { Prisma } from '@/generated/prisma/client'
import { importExpenses } from './api'
import {
  IMPORT_MAX_ISSUES,
  ImportContext,
  parseCsv,
  ParsedExpense,
  parseImportFile,
  planImport,
} from './import-expenses'
import { prisma } from './prisma'
import { getExpenseShares } from './shares'

// The export routes answer with a NextResponse, which needs the fetch API that
// jsdom lacks. Only the body matters here.
jest.mock('next/server', () => ({
  NextResponse: class {
    body: string
    constructor(body: string) {
      this.body = body
    }
    static json(data: unknown) {
      return { body: JSON.stringify(data) }
    }
  },
}))

// ESM only, which Jest cannot load here; it only names the downloaded file.
jest.mock('content-disposition', () => ({ create: () => 'attachment' }))

jest.mock('./prisma', () => ({
  prisma: {
    $transaction: jest.fn(),
    group: { findUnique: jest.fn() },
    category: { findMany: jest.fn() },
    expense: { findMany: jest.fn(), createMany: jest.fn() },
    expensePaidFor: { createMany: jest.fn() },
    activity: { createMany: jest.fn() },
  },
}))

let idCount = 0
jest.mock('./random', () => ({
  randomId: () => `imported-${String(++idCount).padStart(12, '0')}`,
}))

const categories = [
  { id: 0, grouping: 'Uncategorized', name: 'General' },
  { id: 1, grouping: 'Uncategorized', name: 'Payment' },
  { id: 9, grouping: 'Food and Drink', name: 'Groceries' },
  { id: 32, grouping: 'Transportation', name: 'Hotel' },
]

const participants = [
  { id: 'src-alice', name: 'Alice' },
  { id: 'src-bob', name: 'Bob' },
  { id: 'src-carol', name: 'Carol' },
]

type FixtureExpense = {
  id: string
  title: string
  amount: number
  paidById: string
  splitMode: 'EVENLY' | 'BY_SHARES' | 'BY_PERCENTAGE' | 'BY_AMOUNT'
  paidFor: { participantId: string; shares: number }[]
  categoryId?: number
  isReimbursement?: boolean
  originalAmount?: number | null
  originalCurrency?: string | null
  conversionRate?: Prisma.Decimal | null
  recurrenceRule?: 'NONE' | 'MONTHLY'
  notes?: string | null
  expenseDate?: string
}

// Ids shaped like the app's (21 characters), so the JSON import keeps them.
const sourceId = (n: number) => `source-expense-${String(n).padStart(6, '0')}`

// Ten even splits of £10.00 over three: who gets the extra penny depends on
// the expense id.
const pennySplits: FixtureExpense[] = Array.from({ length: 10 }, (_, i) => ({
  id: sourceId(100 + i),
  title: `Takeaway ${i + 1}`,
  amount: 1000,
  paidById: participants[i % 3].id,
  splitMode: 'EVENLY',
  paidFor: participants.map((p) => ({ participantId: p.id, shares: 100 })),
}))

const fixtureExpenses: FixtureExpense[] = [
  {
    id: sourceId(1),
    title: 'Groceries',
    amount: 1000, // 10.00 over three: someone gets the extra penny
    paidById: 'src-alice',
    splitMode: 'EVENLY',
    categoryId: 9,
    paidFor: participants.map((p) => ({ participantId: p.id, shares: 100 })),
  },
  {
    id: sourceId(2),
    title: 'Hotel, two nights "sea view"\nRoom 4',
    amount: 30001,
    paidById: 'src-bob',
    splitMode: 'BY_SHARES',
    categoryId: 32,
    paidFor: [
      { participantId: 'src-alice', shares: 100 },
      { participantId: 'src-bob', shares: 200 },
    ],
  },
  {
    id: sourceId(3),
    title: 'Taxi',
    amount: 1999,
    paidById: 'src-carol',
    splitMode: 'BY_PERCENTAGE',
    paidFor: [
      { participantId: 'src-alice', shares: 3000 },
      { participantId: 'src-carol', shares: 7000 },
    ],
  },
  {
    id: sourceId(4),
    title: 'Concert tickets',
    amount: 1200,
    paidById: 'src-alice',
    splitMode: 'BY_AMOUNT',
    paidFor: [
      { participantId: 'src-bob', shares: 500 },
      { participantId: 'src-carol', shares: 700 },
    ],
  },
  {
    id: sourceId(5),
    title: '-10% refund',
    amount: -2000, // an income, received by Alice
    paidById: 'src-alice',
    splitMode: 'EVENLY',
    paidFor: [
      { participantId: 'src-alice', shares: 100 },
      { participantId: 'src-bob', shares: 100 },
    ],
  },
  {
    id: sourceId(6),
    title: 'Dinner in Paris',
    amount: 11500,
    paidById: 'src-bob',
    splitMode: 'EVENLY',
    originalAmount: 10000,
    originalCurrency: 'EUR',
    conversionRate: new Prisma.Decimal('1.15'),
    paidFor: participants.map((p) => ({ participantId: p.id, shares: 100 })),
    recurrenceRule: 'MONTHLY',
    notes: 'Booked by Bob',
    expenseDate: '2025-12-31',
  },
]

// Bob pays Carol back. Alice is not involved, so her column and Bob's both
// show 0 in the CSV: it cannot tell which of them paid.
const reimbursement: FixtureExpense = {
  id: sourceId(7),
  title: 'Settling up',
  amount: 2500,
  paidById: 'src-bob',
  splitMode: 'EVENLY',
  categoryId: 1,
  isReimbursement: true,
  paidFor: [{ participantId: 'src-carol', shares: 100 }],
}

function exportedGroup(expenses: FixtureExpense[]) {
  return {
    id: 'source-group',
    name: 'Trip',
    information: null,
    currency: '£',
    currencyCode: 'GBP',
    participants,
    activities: [],
    expenses: expenses.map((e, index) => ({
      id: e.id,
      createdAt: new Date(Date.UTC(2025, 0, 1, 12, 0, index)),
      expenseDate: new Date(`${e.expenseDate ?? '2025-06-01'}T00:00:00.000Z`),
      title: e.title,
      category: categories.find((c) => c.id === (e.categoryId ?? 0)),
      amount: e.amount,
      originalAmount: e.originalAmount ?? null,
      originalCurrency: e.originalCurrency ?? null,
      conversionRate: e.conversionRate ?? null,
      paidById: e.paidById,
      paidFor: e.paidFor,
      isReimbursement: e.isReimbursement ?? false,
      splitMode: e.splitMode,
      recurrenceRule: e.recurrenceRule ?? 'NONE',
      notes: e.notes ?? null,
    })),
  }
}

// The routes never read the request (and jsdom has no Request).
const unusedRequest = {} as Request

async function exportFile(format: 'csv' | 'json', expenses: FixtureExpense[]) {
  jest
    .mocked(prisma.group.findUnique)
    .mockResolvedValue(exportedGroup(expenses) as never)
  const route = format === 'csv' ? exportCsv : exportJson
  const response = (await route(unusedRequest, {
    params: Promise.resolve({ groupId: 'source-group' }),
  })) as unknown as { body: string }
  return response.body
}

/**
 * The importing group: same people and currency, its own ids, which sort the
 * other way round (the order decides who gets a leftover penny).
 */
const targetContext: ImportContext = {
  group: {
    currency: '£',
    currencyCode: 'GBP',
    participants: [
      { id: 'tgt-1-carol', name: 'Carol' },
      { id: 'tgt-3-alice', name: 'Alice' },
      { id: 'tgt-2-bob', name: 'Bob' },
    ],
  },
  categories,
}
const sourceToTarget = new Map([
  ['src-alice', 'tgt-3-alice'],
  ['src-bob', 'tgt-2-bob'],
  ['src-carol', 'tgt-1-carol'],
])

let plannedIdCount = 0
const newId = () => `planned-${String(++plannedIdCount).padStart(13, '0')}`

function plan(expenses: ParsedExpense[], format: 'csv' | 'json') {
  return planImport(
    format,
    expenses,
    {
      groupId: 'target-group',
      groupIdByExpenseId: new Map(),
      groupExpenses: [],
    },
    newId,
  )
}

/** What each participant is charged, by target participant id. */
function chargedInSource(expense: FixtureExpense) {
  return new Map(
    [...getExpenseShares(expense)].map(([id, share]) => [
      sourceToTarget.get(id)!,
      share,
    ]),
  )
}

function expectOk(result: ReturnType<typeof parseImportFile>) {
  if (!result.ok) throw new Error(JSON.stringify(result.issues, null, 2))
  return result.expenses
}

describe.each(['csv', 'json'] as const)(
  'round trip through the %s export',
  (format) => {
    it('imports every expense with the same payer, split and balances', async () => {
      const originals = [...fixtureExpenses, ...pennySplits]
      const file = await exportFile(format, originals)
      const parsed = expectOk(parseImportFile(file, targetContext))
      const { expenses, summary } = plan(parsed, format)

      expect(expenses).toHaveLength(originals.length)
      expect(summary).toMatchObject({
        format,
        imported: originals.length,
        alreadyInGroup: 0,
        possibleDuplicates: 0,
        firstDate: '2025-06-01',
        lastDate: '2025-12-31',
      })

      for (const original of originals) {
        // The CSV export is not sorted, so match on the title.
        const imported = expenses.find((e) => e.title === original.title)!
        expect(imported).toBeDefined()
        expect(imported.amount).toBe(original.amount)
        expect(imported.paidById).toBe(sourceToTarget.get(original.paidById))
        expect(imported.splitMode).toBe(original.splitMode)
        expect(imported.categoryId).toBe(original.categoryId ?? 0)
        expect(imported.isReimbursement).toBe(original.isReimbursement ?? false)
        expect(imported.originalAmount).toBe(original.originalAmount ?? null)
        expect(imported.originalCurrency).toBe(
          original.originalCurrency ?? null,
        )
        expect(imported.conversionRate).toBe(
          original.conversionRate ? original.conversionRate.toString() : null,
        )
        expect(imported.expenseDate.toISOString()).toBe(
          `${original.expenseDate ?? '2025-06-01'}T00:00:00.000Z`,
        )
        // Everyone is charged exactly what they were in the exporting group,
        // leftover penny included.
        expect(getExpenseShares(imported)).toEqual(chargedInSource(original))
      }
    })

    it('reports a currency that differs from the group’s', async () => {
      const file = await exportFile(format, fixtureExpenses)
      const result = parseImportFile(file, {
        ...targetContext,
        group: { ...targetContext.group, currency: '€', currencyCode: 'EUR' },
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.issues).toEqual([
        expect.objectContaining({
          code: 'currencyMismatch',
          values: { file: 'GBP', group: 'EUR' },
        }),
      ])
    })

    it('names the people missing from the group', async () => {
      const file = await exportFile(format, fixtureExpenses)
      const result = parseImportFile(file, {
        ...targetContext,
        group: {
          ...targetContext.group,
          participants: targetContext.group.participants.filter(
            (p) => p.name !== 'Carol',
          ),
        },
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.issues[0]).toEqual({
        code: 'unknownParticipants',
        values: { names: 'Carol' },
      })
    })
  },
)

describe('JSON import', () => {
  it('keeps the notes, and imports recurring expenses as one-off', async () => {
    const file = await exportFile('json', fixtureExpenses)
    const { expenses, summary } = plan(
      expectOk(parseImportFile(file, targetContext)),
      'json',
    )
    const dinner = expenses.find((e) => e.title === 'Dinner in Paris')!
    expect(dinner.notes).toBe('Booked by Bob')
    expect(dinner.wasRecurring).toBe(true)
    expect(summary.recurringAsOneOff).toBe(1)
  })

  it('imports a reimbursement, which the CSV cannot', async () => {
    const file = await exportFile('json', [reimbursement])
    const [imported] = expectOk(parseImportFile(file, targetContext))
    expect(imported.paidById).toBe('tgt-2-bob')
    expect(imported.paidFor).toEqual([
      { participantId: 'tgt-1-carol', shares: 100 },
    ])
  })

  it('skips the expenses already in the group, and keeps the ids of the others', async () => {
    const file = await exportFile('json', fixtureExpenses)
    const parsed = expectOk(
      parseImportFile(file, {
        ...targetContext,
        // Re-importing into the exporting group itself.
        group: { ...targetContext.group, participants },
      }),
    )
    const { expenses, summary } = planImport(
      'json',
      parsed,
      {
        groupId: 'source-group',
        groupIdByExpenseId: new Map([
          [sourceId(1), 'source-group'],
          [sourceId(2), 'another-group'],
        ]),
        groupExpenses: [],
      },
      newId,
    )
    expect(summary.alreadyInGroup).toBe(1)
    expect(expenses.map((e) => e.id)).not.toContain(sourceId(1))
    // Taken by another group: a new id.
    expect(expenses.find((e) => e.sourceId === sourceId(2))!.id).not.toBe(
      sourceId(2),
    )
    expect(expenses.find((e) => e.sourceId === sourceId(3))!.id).toBe(
      sourceId(3),
    )
  })

  it.each([
    ['not JSON at all', '{"expenses": [', 'invalidJson'],
    ['an array', '[]', 'jsonStructure'],
    ['missing participants', '{"currency":"£","expenses":[]}', 'jsonStructure'],
  ])('rejects %s', (_, file, code) => {
    const result = parseImportFile(file, targetContext)
    expect(result).toMatchObject({ ok: false, issues: [{ code }] })
  })

  it('reports each broken expense with its position', async () => {
    const data = JSON.parse(await exportFile('json', fixtureExpenses)) as {
      expenses: Record<string, unknown>[]
    }
    data.expenses[1].amount = 'a lot'
    data.expenses[3].expenseDate = '2025-02-30T00:00:00.000Z'
    data.expenses[4].title = 'x'
    data.expenses[5].paidById = 'nobody'
    const result = parseImportFile(JSON.stringify(data), targetContext)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues).toEqual([
      { code: 'jsonExpenseStructure', row: 2, values: { field: 'amount' } },
      {
        code: 'invalidDate',
        row: 4,
        values: { value: '2025-02-30T00:00:00.000Z' },
      },
      {
        code: 'invalidField',
        row: 5,
        values: { field: 'title', reason: 'min2' },
      },
      { code: 'jsonUnknownParticipantId', row: 6, values: { id: 'nobody' } },
    ])
  })
})

describe('CSV import', () => {
  it('cannot tell who paid when the payer is not part of the split', async () => {
    const file = await exportFile('csv', [...fixtureExpenses, reimbursement])
    const result = parseImportFile(file, targetContext)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues).toEqual([
      { code: 'ambiguousPayer', row: fixtureExpenses.length + 2 },
    ])
  })

  it('finds the payer of a reimbursement between two people', async () => {
    const twoPeople = [
      { id: 'src-bob', name: 'Bob' },
      { id: 'src-carol', name: 'Carol' },
    ]
    jest.mocked(prisma.group.findUnique).mockResolvedValue({
      ...exportedGroup([reimbursement]),
      participants: twoPeople,
    } as never)
    const response = (await exportCsv(unusedRequest, {
      params: Promise.resolve({ groupId: 'source-group' }),
    })) as unknown as { body: string }
    const [imported] = expectOk(parseImportFile(response.body, targetContext))
    expect(imported.paidById).toBe('tgt-2-bob')
    expect(imported.isReimbursement).toBe(true)
    expect(imported.paidFor).toEqual([
      { participantId: 'tgt-1-carol', shares: 100 },
    ])
  })

  const header =
    'Date,Description,Category,Currency,Cost,Original cost,Original currency,Conversion rate,Is Reimbursement,Split mode,Alice,Bob'
  const csvContext: ImportContext = {
    ...targetContext,
    group: {
      ...targetContext.group,
      participants: targetContext.group.participants.filter(
        (p) => p.name !== 'Carol',
      ),
    },
  }

  it('accepts a file saved again by a spreadsheet', () => {
    const file = [
      header.replace('Is Reimbursement', 'is reimbursement'),
      '2025-03-01,Lunch,Groceries,GBP,20,,,,no,Unevenly - By amount,15,-5',
      '',
    ].join('\r\n')
    const [imported] = expectOk(parseImportFile(file, csvContext))
    expect(imported).toMatchObject({
      amount: 2000,
      paidById: 'tgt-3-alice',
      splitMode: 'BY_AMOUNT',
      paidFor: [
        { participantId: 'tgt-3-alice', shares: 1500 },
        { participantId: 'tgt-2-bob', shares: 500 },
      ],
    })
  })

  it('reports every problem with its row, and stops at a limit', () => {
    const rows = [
      '2025-13-01,Lunch,,GBP,20.00,,,,No,Evenly,10,-10',
      '2025-03-01,Lunch,Snacks,GBP,20.00,,,,No,Evenly,10,-10',
      '2025-03-01,Lunch,,GBP,"1,000.00",,,,No,Evenly,10,-10',
      '2025-03-01,Lunch,,GBP,20.005,,,,No,Evenly,10,-10',
      '2025-03-01,Lunch,,GBP,20.00,,,,Maybe,Evenly,10,-10',
      '2025-03-01,Lunch,,GBP,20.00,,,,No,Somehow,10,-10',
      '2025-03-01,Lunch,,GBP,20.00,,,,No,Evenly,10,',
      '2025-03-01,Lunch,,GBP,20.00,,,,No,Evenly,10,-9',
      '2025-03-01,Lunch,,GBP,20.00,,,,No,Evenly,15,-5',
      '2025-03-01,Lunch,,GBP,20.00,,,,No,Evenly,10,10',
      '2025-03-01,Lunch,,GBP,20.00,,,,No,Evenly,10',
    ]
    const result = parseImportFile([header, ...rows].join('\n'), csvContext)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.map((i) => [i.row, i.code])).toEqual([
      [2, 'invalidDate'],
      [3, 'unknownCategory'],
      [4, 'invalidAmount'],
      [5, 'invalidAmount'],
      [6, 'invalidYesNo'],
      [7, 'invalidSplitMode'],
      [8, 'missingValue'],
      [9, 'sharesMismatch'],
      [10, 'unevenSplit'],
      [11, 'multiplePayers'],
      [12, 'columnCount'],
    ])
  })

  it.each([
    ['an unrelated file', 'name,email\nAlice,alice@example.com', 'csvHeader'],
    ['an export without participants', header.split(',Alice')[0], 'csvHeader'],
    ['an unclosed quote', `${header}\n2025-01-01,"Lunch,,GBP`, 'csvSyntax'],
    ['a header only', header, 'noExpenses'],
    ['an empty file', '﻿\n  \n', 'empty'],
  ])('rejects %s', (_, file, code) => {
    const result = parseImportFile(file, csvContext)
    expect(result).toMatchObject({ ok: false, issues: [{ code }] })
  })
})

describe('parseCsv', () => {
  it('reads quoted fields with commas, quotes and line breaks', () => {
    expect(parseCsv('a,"b, ""c""\nd",""\r\n1,2,3\n')).toEqual({
      ok: true,
      records: [
        ['a', 'b, "c"\nd', ''],
        ['1', '2', '3'],
      ],
    })
  })
})

describe('importExpenses', () => {
  const group = {
    id: 'target-group',
    currency: '£',
    currencyCode: 'GBP',
    participants: targetContext.group.participants,
  }

  beforeEach(() => {
    jest.clearAllMocks()
    jest.mocked(prisma.group.findUnique).mockResolvedValue(group as never)
    jest.mocked(prisma.category.findMany).mockResolvedValue(categories as never)
    jest.mocked(prisma.expense.findMany).mockResolvedValue([])
  })

  it('only checks the file in a dry run', async () => {
    const file = await exportFile('json', fixtureExpenses)
    jest.mocked(prisma.group.findUnique).mockResolvedValue(group as never)
    const result = await importExpenses('target-group', file, { dryRun: true })
    expect(result).toMatchObject({
      ok: true,
      dryRun: true,
      summary: { imported: fixtureExpenses.length },
    })
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('saves the expenses, their splits and activities in one transaction', async () => {
    const file = await exportFile('csv', fixtureExpenses)
    jest.mocked(prisma.group.findUnique).mockResolvedValue(group as never)
    jest.mocked(prisma.$transaction).mockResolvedValue([] as never)
    const result = await importExpenses('target-group', file, {
      dryRun: false,
      participantId: 'tgt-3-alice',
    })
    expect(result).toMatchObject({ ok: true, dryRun: false })
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)

    const [expenseRows] = jest.mocked(prisma.expense.createMany).mock.calls
    const rows = (expenseRows[0] as { data: { groupId: string }[] }).data
    expect(rows).toHaveLength(fixtureExpenses.length)
    expect(rows.every((row) => row.groupId === 'target-group')).toBe(true)
    const [activityRows] = jest.mocked(prisma.activity.createMany).mock.calls
    expect(
      (activityRows[0] as { data: { participantId: string }[] }).data,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          activityType: 'CREATE_EXPENSE',
          participantId: 'tgt-3-alice',
        }),
      ]),
    )
  })

  it('reports a failed save, which the transaction rolled back', async () => {
    const file = await exportFile('csv', fixtureExpenses)
    jest.mocked(prisma.group.findUnique).mockResolvedValue(group as never)
    jest
      .mocked(prisma.$transaction)
      .mockRejectedValue(new Error('connection lost'))
    jest.spyOn(console, 'error').mockImplementation(() => {})
    const result = await importExpenses('target-group', file, {
      dryRun: false,
    })
    expect(result).toEqual({
      ok: false,
      format: 'csv',
      issues: [{ code: 'saveFailed' }],
      issueCount: 1,
    })
  })

  it('sends back a limited number of problems', async () => {
    const header =
      'Date,Description,Category,Currency,Cost,Original cost,Original currency,Conversion rate,Is Reimbursement,Split mode,Alice'
    const rows = Array.from(
      { length: 50 },
      () => 'yesterday,Lunch,,GBP,1,,,,No,Evenly,1',
    )
    const result = await importExpenses(
      'target-group',
      [header, ...rows].join('\n'),
      { dryRun: false },
    )
    expect(result).toMatchObject({ ok: false, issueCount: 50 })
    if (result.ok) return
    expect(result.issues).toHaveLength(IMPORT_MAX_ISSUES)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('refuses a group that does not exist', async () => {
    jest.mocked(prisma.group.findUnique).mockResolvedValue(null)
    const result = await importExpenses('missing', 'whatever', {
      dryRun: false,
    })
    expect(result).toMatchObject({
      ok: false,
      issues: [{ code: 'groupNotFound' }],
    })
  })
})
