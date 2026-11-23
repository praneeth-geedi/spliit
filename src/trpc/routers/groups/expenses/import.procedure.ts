import { importExpenses } from '@/lib/api'
import { IMPORT_MAX_FILE_SIZE } from '@/lib/import-expenses'
import { baseProcedure } from '@/trpc/init'
import { z } from 'zod'

export const importGroupExpensesProcedure = baseProcedure
  .input(
    z.object({
      groupId: z.string().min(1),
      // The file's text, as exported by expenses/export/{json,csv}.
      content: z.string().max(IMPORT_MAX_FILE_SIZE),
      // Only check the file and describe what importing it would do.
      dryRun: z.boolean(),
      participantId: z.string().max(64).optional(),
    }),
  )
  .mutation(({ input: { groupId, content, dryRun, participantId } }) =>
    importExpenses(groupId, content, { dryRun, participantId }),
  )
