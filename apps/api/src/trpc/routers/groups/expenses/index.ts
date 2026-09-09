import { createTRPCRouter } from '../../../init'
import { bulkUpdateExpenseCategoriesProcedure } from './bulkUpdateCategories.procedure'
import { categoryMemoryProcedure } from './category-memory.procedure'
import { expenseCommentsRouter } from './comments'
import { commonCurrenciesProcedure } from './common-currencies.procedure'
import { createGroupExpenseProcedure } from './create.procedure'
import { deleteGroupExpenseProcedure } from './delete.procedure'
import { getGroupExpenseProcedure } from './get.procedure'
import {
  importExpenseFileProcedure,
  previewExpenseFileImportDuplicatesProcedure,
} from './import-csv.procedure'
import { listGroupExpensesProcedure } from './list.procedure'
import { listRecurringExpenseSeriesProcedure } from './series-list.procedure'
import { seriesProgressProcedure } from './series-progress.procedure'
import { stopRecurrenceProcedure } from './stopRecurrence.procedure'
import { suggestCategoryProcedure } from './suggest-category.procedure'
import { updateGroupExpenseProcedure } from './update.procedure'

export const groupExpensesRouter = createTRPCRouter({
  comments: expenseCommentsRouter,
  list: listGroupExpensesProcedure,
  series: listRecurringExpenseSeriesProcedure,
  /**
   * Per-series progress used by the web client to poll after creating a
   * past-dated series. Returns null when the series is not in the group.
   */
  seriesProgress: seriesProgressProcedure,
  get: getGroupExpenseProcedure,
  /**
   * Currencies actually used by the group's expenses, for driving the UI
   * filter.
   */
  commonCurrencies: commonCurrenciesProcedure,
  /**
   * Recent title→category pairs for local category suggestion. Not an AI
   * feature — available whenever the caller can list expenses.
   */
  categoryMemory: categoryMemoryProcedure,
  /**
   * Suggest a category from an expense title. Dictionaries and similar past
   * titles run first; the LLM is only used when those are weak, the client
   * asked for AI, and PUBLIC_ENABLE_CATEGORY_EXTRACT is on.
   */
  suggestCategory: suggestCategoryProcedure,
  /**
   * Create an expense in a group. Rejects if the group is archived. May fetch
   * an FX rate when `conversion.type` is 'exchange'.
   */
  create: createGroupExpenseProcedure,
  /** Preview likely duplicate rows before committing a file import batch. */
  previewImportDuplicates: previewExpenseFileImportDuplicatesProcedure,
  /** Import reviewed expense-file rows atomically with idempotency. */
  importFile: importExpenseFileProcedure,
  /** Update an existing expense. Same conversion rules as create. */
  update: updateGroupExpenseProcedure,
  delete: deleteGroupExpenseProcedure,
  stopRecurrence: stopRecurrenceProcedure,
  /**
   * Recategorize up to 2000 expenses in one transaction. Only expenses still on
   * `fromCategoryId` are eligible.
   */
  bulkUpdateCategories: bulkUpdateExpenseCategoriesProcedure,
})
