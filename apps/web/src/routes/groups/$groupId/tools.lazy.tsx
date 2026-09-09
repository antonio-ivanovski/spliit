import { createLazyFileRoute, Outlet } from '@tanstack/react-router'

/**
 * Parent layout for the Tools tab. The Tools page itself lives on the index
 * route so child tools (e.g. the expense importer) replace it via the outlet
 * instead of rendering underneath it.
 */
function ToolsLayout() {
  return <Outlet />
}

export const Route = createLazyFileRoute('/groups/$groupId/tools')({
  component: ToolsLayout,
})
