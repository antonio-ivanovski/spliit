-- Expense file import: ExpenseFileImportSource side table + Activity feed flag.
--
-- Hash-only bank identity: raw bank transaction ids and account namespaces
-- are never stored on ExpenseFileImportSource. Only `externalIdentityHash`
-- (sha256 over normalized components, computed at the API boundary) is kept
-- for exact re-import matching.
-- AlterTable
ALTER TABLE "Activity" ADD COLUMN     "visibleInGroupFeed" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "ExpenseFileImportSource" (
    "expenseId" TEXT NOT NULL,
    "ledgerId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'GENERIC_CSV',
    "importKey" TEXT NOT NULL,
    "externalIdentityHash" TEXT,
    "semanticHash" TEXT NOT NULL,
    "rawHash" TEXT NOT NULL,
    "meta" JSONB,
    "importedByAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpenseFileImportSource_pkey" PRIMARY KEY ("expenseId")
);

-- CreateIndex
CREATE INDEX "ExpenseFileImportSource_ledgerId_importKey_idx" ON "ExpenseFileImportSource"("ledgerId", "importKey");

-- CreateIndex
CREATE INDEX "ExpenseFileImportSource_ledgerId_provider_extIdHash_idx" ON "ExpenseFileImportSource"("ledgerId", "provider", "externalIdentityHash");

-- CreateIndex
CREATE INDEX "Activity_ledgerId_visibleInGroupFeed_time_idx" ON "Activity"("ledgerId", "visibleInGroupFeed", "time");

-- CreateIndex
CREATE INDEX "Expense_ledgerId_expenseDate_amount_idx" ON "Expense"("ledgerId", "expenseDate", "amount");

-- CreateIndex
CREATE INDEX "Expense_ledgerId_originalCurrency_originalAmount_idx" ON "Expense"("ledgerId", "originalCurrency", "originalAmount");

-- AddForeignKey
ALTER TABLE "ExpenseFileImportSource" ADD CONSTRAINT "ExpenseFileImportSource_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "NotificationDelivery_eventKey_recipientAccountId_channel_target" RENAME TO "NotificationDelivery_eventKey_recipientAccountId_channel_ta_key";
