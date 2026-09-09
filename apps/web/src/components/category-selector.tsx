/* oxlint-disable jsx-a11y/prefer-tag-over-role, jsx-a11y/role-has-required-aria-props -- popover triggers expose combobox semantics; popup IDs are managed by the UI primitive. */
import { Combobox } from '@base-ui/react/combobox'
import {
  Search,
  Check,
  ChevronDown,
  ChevronsUpDown,
  Loader2,
  Sparkles,
} from 'lucide-react'
import { forwardRef, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CategoryIcon } from '@/app/groups/[groupId]/expenses/category-icon'
import { categoryLabel } from '@/app/groups/[groupId]/stats/category-utils'
import type { ButtonProps } from '@/components/ui/button'
import { Button } from '@/components/ui/button'
import {
  Drawer,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '@/components/ui/drawer'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { useLocale } from '@/i18n/react'
import { useMediaQuery } from '@/lib/hooks'
import { useLocaleCategoryDictionary } from '@/lib/use-locale-category-dictionary'
import { cn } from '@/lib/utils'
import {
  type DEFAULT_CATEGORIES,
  type Category,
  type CategoryId,
  DEFAULT_CATEGORY_ID,
  categorySelectionDisplayCount,
  createCategorySearchDocument,
  getCategoryById,
  getChildCategories,
  isParentCategory,
  rankCategories,
} from '@spliit/domain'

type Props = {
  categories: ReadonlyArray<Category>
  onValueChange: (categoryId: CategoryId) => void
  /**
   * Category ID to be selected by default. Overwriting this value will update
   * current selection, too.
   */
  defaultValue: CategoryId
  isLoading: boolean
  /**
   * Sparkles when an AI fallback may still run; a generic spinner otherwise.
   * Ignored when `isLoading` is false.
   */
  loadingAppearance?: 'ai' | 'spinner'
  disabled?: boolean
  /** Render an icon-only trigger for embedding beside a title input. */
  compact?: boolean
  /** Multi-select mode for filter panels. Defaults to 'single'. */
  mode?: 'single' | 'multi'
  /** IDs currently selected (multi mode only). */
  selectedValues?: CategoryId[]
  /**
   * Toggle a category ID in multi mode (apply toggleCategorySelection at the
   * call site).
   */
  onValueToggle?: (categoryId: CategoryId) => void
  /** Trigger text when nothing selected in multi mode. */
  multiPlaceholder?: string
  /** Title and action label shown by the mobile multi-select drawer. */
  mobileTitle?: string
  mobileDoneLabel?: string
}

export function CategorySelector({
  categories,
  onValueChange,
  defaultValue,
  isLoading,
  loadingAppearance = 'spinner',
  disabled = false,
  compact = false,
  mode = 'single',
  selectedValues = [],
  onValueToggle,
  multiPlaceholder,
  mobileTitle,
  mobileDoneLabel,
}: Props) {
  const [open, setOpen] = useState(false)
  const commandInputRef = useRef<HTMLInputElement>(null)
  const isDesktop = useMediaQuery('(min-width: 768px)')
  const { t } = useTranslation()

  const selectedCategory =
    categories.find((category) => category.id === defaultValue) ??
    categories.find((category) => category.id === DEFAULT_CATEGORY_ID) ??
    getCategoryById(DEFAULT_CATEGORY_ID)!

  const hierarchy = useMemo(() => buildHierarchy(categories), [categories])
  const multiCount = categorySelectionDisplayCount(selectedValues, categories)

  if (mode === 'multi') {
    const command = (
      <CategoryOptions
        hierarchy={hierarchy}
        mode="multi"
        selectedValues={selectedValues}
        onValueToggle={onValueToggle}
        inputRef={commandInputRef}
      />
    )

    if (!isDesktop) {
      return (
        <Drawer open={open} onOpenChange={setOpen}>
          <DrawerTrigger
            render={
              <Button
                type="button"
                variant="outline"
                role="combobox"
                aria-haspopup="listbox"
                aria-expanded={open}
                disabled={disabled}
                className="h-9 w-full justify-between px-3 text-sm font-normal"
              >
                <span className="truncate">
                  {multiCount > 0
                    ? t('Expenses.filters.nSelected', {
                        count: multiCount,
                      })
                    : (multiPlaceholder ?? 'Select')}
                </span>
                <ChevronsUpDown className="ms-2 h-4 w-4 shrink-0 opacity-50" />
              </Button>
            }
          />
          <DrawerContent className="p-0" initialFocus={commandInputRef}>
            <DrawerHeader className="pb-2 text-start">
              <DrawerTitle>
                {mobileTitle ?? t('Expenses.filters.category')}
              </DrawerTitle>
            </DrawerHeader>
            <div className="min-h-0 overflow-y-auto px-1">{command}</div>
            <DrawerFooter className="border-t bg-background pt-3">
              <Button type="button" onClick={() => setOpen(false)}>
                {mobileDoneLabel ?? t('Groups.Import.StepHeader.done')}
              </Button>
            </DrawerFooter>
          </DrawerContent>
        </Drawer>
      )
    }

    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="outline"
              role="combobox"
              aria-haspopup="listbox"
              aria-expanded={open}
              disabled={disabled}
              className="h-9 w-full justify-between px-3 text-sm font-normal"
            />
          }
        >
          <span className="truncate">
            {multiCount > 0
              ? t('Expenses.filters.nSelected', { count: multiCount })
              : (multiPlaceholder ?? 'Select')}
          </span>
          <ChevronsUpDown className="ms-2 h-4 w-4 shrink-0 opacity-50" />
        </PopoverTrigger>
        <PopoverContent
          className="max-h-[var(--available-height)] overflow-hidden p-0"
          align="start"
          positionMethod="fixed"
          initialFocus={commandInputRef}
        >
          {command}
        </PopoverContent>
      </Popover>
    )
  }

  if (isDesktop) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <CategoryButton
              category={selectedCategory}
              open={open}
              isLoading={isLoading}
              loadingAppearance={loadingAppearance}
              disabled={disabled}
              compact={compact}
            />
          }
        />
        <PopoverContent
          className="max-h-[var(--available-height)] overflow-hidden p-0"
          align="start"
          positionMethod="fixed"
          initialFocus={commandInputRef}
        >
          <CategoryOptions
            hierarchy={hierarchy}
            mode="single"
            selectedValues={[selectedCategory.id]}
            onValueChange={(id) => {
              onValueChange(id)
              setOpen(false)
            }}
            inputRef={commandInputRef}
          />
        </PopoverContent>
      </Popover>
    )
  }

  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger
        render={
          <CategoryButton
            category={selectedCategory}
            open={open}
            isLoading={isLoading}
            loadingAppearance={loadingAppearance}
            disabled={disabled}
            compact={compact}
          />
        }
      />
      <DrawerContent className="p-0" initialFocus={commandInputRef}>
        <CategoryOptions
          hierarchy={hierarchy}
          mode="single"
          selectedValues={[selectedCategory.id]}
          onValueChange={(id) => {
            onValueChange(id)
            setOpen(false)
          }}
          inputRef={commandInputRef}
        />
      </DrawerContent>
    </Drawer>
  )
}

function CategoryOptions({
  hierarchy,
  onValueChange,
  mode = 'single',
  selectedValues = [],
  onValueToggle,
  inputRef,
}: {
  hierarchy: Hierarchy
  onValueChange?: (categoryId: CategoryId) => void
  mode?: 'single' | 'multi'
  selectedValues?: CategoryId[]
  onValueToggle?: (categoryId: CategoryId) => void
  inputRef?: React.Ref<HTMLInputElement>
}) {
  const { t } = useTranslation(undefined, { keyPrefix: 'Categories' })
  const locale = useLocale()
  const localeDictionary = useLocaleCategoryDictionary(locale)
  const [search, setSearch] = useState('')
  const selectedSet = new Set(selectedValues)
  const isEffectivelySelected = (category: Category) =>
    selectedSet.has(category.id) ||
    (category.parentId !== null && selectedSet.has(category.parentId))

  const documents = useMemo(
    () =>
      hierarchy.flatMap(({ parent, children }) => {
        const grouping = String(
          t(
            CATEGORY_GROUPING_HEADINGS[
              parent.grouping as keyof typeof CATEGORY_GROUPING_HEADINGS
            ],
          ),
        )
        return [parent, ...children].map((category) =>
          createCategorySearchDocument(category, {
            label:
              category.parentId === null
                ? grouping
                : categoryLabel(t, category.id),
            grouping,
            locale,
            localeDictionary,
          }),
        )
      }),
    [hierarchy, locale, localeDictionary, t],
  )

  const categoryById = useMemo(() => {
    const map = new Map<CategoryId, Category>()
    for (const { parent, children } of hierarchy) {
      map.set(parent.id, parent)
      for (const child of children) map.set(child.id, child)
    }
    return map
  }, [hierarchy])

  const documentById = useMemo(
    () => new Map(documents.map((document) => [document.id, document])),
    [documents],
  )

  const ranked = useMemo(() => {
    const query = search.trim()
    if (!query) return null
    return rankCategories(query, documents)
  }, [documents, search])

  const items = ranked
    ? ranked.map((hit) => hit.id)
    : documents.map((document) => document.id)
  const selectCategory = (id: CategoryId) => {
    if (mode === 'multi') onValueToggle?.(id)
    else onValueChange?.(id)
  }

  return (
    <Combobox.Root<CategoryId, boolean>
      inline
      open
      autoHighlight
      items={items}
      filter={null}
      multiple={mode === 'multi'}
      value={mode === 'multi' ? selectedValues : (selectedValues[0] ?? null)}
      inputValue={search}
      onInputValueChange={(value, details) => {
        if (
          details.reason === 'input-change' ||
          details.reason === 'input-clear'
        )
          setSearch(value)
      }}
    >
      <div className="flex min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <Combobox.Input
            ref={inputRef}
            aria-label={t('search')}
            placeholder={t('search')}
            render={
              <Input className="h-11 border-0 bg-transparent px-0 text-base shadow-none focus-visible:ring-0" />
            }
          />
        </div>
        <Combobox.List className="max-h-[min(300px,calc(var(--available-height,80dvh)-3rem))] min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain p-1">
          {ranked && ranked.length === 0 ? (
            <div className="py-6 text-center text-sm">{t('noCategory')}</div>
          ) : ranked ? (
            <Combobox.Group>
              {ranked.map((hit) => {
                const category = categoryById.get(hit.id)
                if (!category) return null
                const document = documentById.get(hit.id)
                if (!document) return null
                return (
                  <CategoryOptionsRow
                    key={hit.id}
                    category={category}
                    label={document.label}
                    grouping={document.grouping}
                    mode={mode}
                    selected={
                      mode === 'multi'
                        ? isEffectivelySelected(category)
                        : selectedSet.has(category.id)
                    }
                    ranked
                    onSelect={() => selectCategory(hit.id)}
                  />
                )
              })}
            </Combobox.Group>
          ) : (
            hierarchy.map(({ parent, children }) => {
              const groupLabel = String(
                t(
                  CATEGORY_GROUPING_HEADINGS[
                    parent.grouping as keyof typeof CATEGORY_GROUPING_HEADINGS
                  ],
                ),
              )
              const parentSelected =
                mode === 'multi'
                  ? isEffectivelySelected(parent)
                  : selectedSet.has(parent.id)

              return (
                <Combobox.Group key={parent.id}>
                  <CategoryOptionsRow
                    category={parent}
                    label={groupLabel}
                    grouping={groupLabel}
                    mode={mode}
                    selected={parentSelected}
                    parentRow
                    hasChildren={children.length > 0}
                    onSelect={() => selectCategory(parent.id)}
                  />
                  {children.map((category) => {
                    const childSelected =
                      mode === 'multi'
                        ? isEffectivelySelected(category)
                        : selectedSet.has(category.id)
                    return (
                      <CategoryOptionsRow
                        key={category.id}
                        category={category}
                        label={categoryLabel(t, category.id)}
                        grouping={groupLabel}
                        mode={mode}
                        selected={childSelected}
                        indented
                        onSelect={() => selectCategory(category.id)}
                      />
                    )
                  })}
                </Combobox.Group>
              )
            })
          )}
        </Combobox.List>
      </div>
    </Combobox.Root>
  )
}

function CategoryOptionsRow({
  category,
  label,
  grouping,
  mode,
  selected,
  onSelect,
  parentRow = false,
  hasChildren = false,
  indented = false,
  ranked = false,
}: {
  category: Category
  label: string
  grouping: string
  mode: 'single' | 'multi'
  selected: boolean
  onSelect: () => void
  parentRow?: boolean
  hasChildren?: boolean
  indented?: boolean
  ranked?: boolean
}) {
  const isGroupHeader = parentRow && hasChildren
  return (
    <Combobox.Item
      value={category.id}
      onClick={onSelect}
      aria-selected={selected}
      aria-label={label}
      className={cn(
        'relative flex w-full cursor-pointer items-center rounded-sm px-2 py-1.5 text-sm outline-none select-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground',
        isGroupHeader && 'bg-muted/40 font-semibold',
      )}
    >
      {mode === 'multi' && (
        <Check
          className={cn('me-2 h-4 w-4 shrink-0', selected ? '' : 'invisible')}
        />
      )}
      {indented ? (
        <span className="ps-8">
          <CategoryLabel category={category} />
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate">
          <CategoryLabel category={category} />
        </span>
      )}
      {ranked && grouping !== label ? (
        <span className="ms-auto ps-2 text-xs text-muted-foreground">
          {grouping}
        </span>
      ) : null}
    </Combobox.Item>
  )
}

type Hierarchy = Array<{ parent: Category; children: Category[] }>

function buildHierarchy(categories: ReadonlyArray<Category>): Hierarchy {
  const parents = categories.filter((category) => isParentCategory(category))
  return parents.map((parent) => ({
    parent,
    children: getChildCategories(parent.id, categories),
  }))
}

const CATEGORY_GROUPING_HEADINGS = {
  Uncategorized: 'Uncategorized.heading',
  Income: 'Income.heading',
  Settlement: 'Settlement.heading',
  Entertainment: 'Entertainment.heading',
  'Food and Drink': 'Food and Drink.heading',
  Home: 'Home.heading',
  Life: 'Life.heading',
  Transportation: 'Transportation.heading',
  Utilities: 'Utilities.heading',
  'Social and Activities': 'Social and Activities.heading',
  'Subscriptions and Memberships': 'Subscriptions and Memberships.heading',
  'Personal Care and Wellness': 'Personal Care and Wellness.heading',
} as const satisfies Record<
  (typeof DEFAULT_CATEGORIES)[number]['grouping'],
  string
>

type CategoryButtonProps = {
  category: Category
  open: boolean
  isLoading: boolean
  loadingAppearance?: 'ai' | 'spinner'
  disabled?: boolean
  compact?: boolean
}
const CategoryButton = forwardRef<HTMLButtonElement, CategoryButtonProps>(
  (
    {
      category,
      open,
      isLoading,
      loadingAppearance = 'spinner',
      compact = false,
      className,
      ...props
    }: ButtonProps & CategoryButtonProps,
    ref,
  ) => {
    const { t } = useTranslation(undefined, { keyPrefix: 'Categories' })
    const iconClassName = 'h-4 w-4 shrink-0 opacity-50'
    const label = categoryLabel(t, category.id)
    return (
      <Button
        variant="outline"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-busy={isLoading}
        aria-label={label}
        className={cn(
          compact
            ? 'h-10 w-16 shrink-0 gap-2 rounded-none border-0 px-3'
            : 'flex w-full',
          typeof className === 'string' ? className : undefined,
        )}
        ref={ref}
        {...props}
      >
        <span
          className={
            compact ? 'flex items-center justify-center' : 'flex-1 text-start'
          }
        >
          <CategoryLabel category={category} compact={compact} />
        </span>
        {isLoading ? (
          loadingAppearance === 'ai' ? (
            <Sparkles
              data-icon="category-loading-ai"
              aria-hidden="true"
              className="h-4 w-4 shrink-0 animate-sparkle-pulse text-primary motion-reduce:animate-none"
            />
          ) : (
            <Loader2
              data-icon="category-loading-spinner"
              aria-hidden="true"
              className="h-4 w-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
            />
          )
        ) : (
          <ChevronDown className={iconClassName} />
        )}
      </Button>
    )
  },
)
CategoryButton.displayName = 'CategoryButton'

function CategoryLabel({
  category,
  compact = false,
}: {
  category: Category
  compact?: boolean
}) {
  const { t } = useTranslation(undefined, { keyPrefix: 'Categories' })
  return (
    <div className="flex items-center gap-3">
      <CategoryIcon category={category} className="h-4 w-4" />
      {!compact && categoryLabel(t, category.id)}
    </div>
  )
}
