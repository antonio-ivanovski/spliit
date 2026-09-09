import type { LinkProps } from '@tanstack/react-router'

type FocusedRouteMeta = {
  title: string
  to: LinkProps['to']
  params?: LinkProps['params']
}

const groupIdFromPath = (pathname: string) =>
  pathname.match(/^\/groups\/bulk-categorize\/([^/]+)/)?.[1] ??
  pathname.match(/^\/groups\/([^/]+)/)?.[1]

export function isFocusedMobilePath(pathname: string) {
  return (
    pathname === '/groups/create' ||
    pathname === '/groups/import' ||
    pathname === '/friends/create' ||
    pathname === '/expenses' ||
    pathname === '/account/settings' ||
    pathname.startsWith('/groups/bulk-categorize/') ||
    /^\/groups\/[^/]+\/edit$/.test(pathname) ||
    /^\/groups\/[^/]+\/budgets\/create$/.test(pathname) ||
    /^\/groups\/[^/]+\/budgets\/[^/]+$/.test(pathname) ||
    /^\/groups\/[^/]+\/budgets\/[^/]+\/edit$/.test(pathname) ||
    /^\/groups\/[^/]+\/expenses\/create$/.test(pathname) ||
    /^\/groups\/[^/]+\/expenses\/[^/]+\/edit$/.test(pathname)
  )
}

export function isMobileGroupNavPath(pathname: string) {
  return /^\/groups\/[^/]+\/(expenses|balances|budgets|activity|stats|members|tools|edit)\/?$/.test(
    pathname,
  )
}

/**
 * Main group tabs own the mobile group-context app bar. Group editing remains a
 * focused workflow and keeps the focused route title/back affordance.
 */
export function isMobileGroupTabPath(pathname: string) {
  return /^\/groups\/[^/]+\/(expenses|balances|budgets|activity|stats|members|tools)\/?$/.test(
    pathname,
  )
}

export function shouldHideMobileGroupTabs(pathname: string) {
  return (
    isMobileGroupNavPath(pathname) ||
    isFocusedMobilePath(pathname) ||
    /^\/groups\/[^/]+\/expenses\/[^/]+\/?$/.test(pathname)
  )
}

export function getFocusedRouteMeta(
  pathname: string,
  t: (key: string) => string,
): FocusedRouteMeta | null {
  const groupId = groupIdFromPath(pathname)
  if (pathname === '/groups/create') {
    return { title: t('Groups.createGroupCard.title'), to: '/' }
  }
  if (pathname === '/groups/import') {
    return { title: t('Groups.Import.StepHeader.title'), to: '/' }
  }
  if (pathname === '/friends/create') {
    return { title: t('Groups.createFriendLedgerCard.title'), to: '/' }
  }
  if (pathname === '/expenses') {
    return { title: t('Expenses.globalTitle'), to: '/' }
  }
  if (pathname === '/account/settings') {
    return { title: t('AccountSettings.title'), to: '/' }
  }
  if (pathname.startsWith('/groups/bulk-categorize/') && groupId) {
    return {
      title: t('BulkCategorize.title'),
      to: '/groups/$groupId/expenses',
      params: { groupId },
    }
  }
  if (groupId && /^\/groups\/[^/]+\/edit$/.test(pathname)) {
    return {
      title: t('Settings.title'),
      to: '/groups/$groupId/expenses',
      params: { groupId },
    }
  }
  if (groupId && pathname === `/groups/${groupId}/budgets/create`) {
    return {
      title: t('Budgets.create'),
      to: '/groups/$groupId/budgets',
      params: { groupId },
    }
  }
  if (groupId && /^\/groups\/[^/]+\/budgets\/[^/]+\/edit$/.test(pathname)) {
    return {
      title: t('Budgets.edit'),
      to: '/groups/$groupId/budgets',
      params: { groupId },
    }
  }
  if (groupId && /^\/groups\/[^/]+\/budgets\/[^/]+$/.test(pathname)) {
    return {
      title: t('Budgets.detailTitle'),
      to: '/groups/$groupId/budgets',
      params: { groupId },
    }
  }
  if (groupId && /^\/groups\/[^/]+\/expenses\/create$/.test(pathname)) {
    return {
      title: t('Expenses.create'),
      to: '/groups/$groupId/expenses',
      params: { groupId },
    }
  }
  if (groupId && /^\/groups\/[^/]+\/expenses\/[^/]+\/edit$/.test(pathname)) {
    return {
      title: t('ExpensePreview.edit'),
      to: '/groups/$groupId/expenses',
      params: { groupId },
    }
  }
  return null
}
