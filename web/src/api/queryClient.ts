// The app's one TanStack Query client. A module of its own so code outside React (the editor's completion
// sources) reads the same cache the hooks fill.
import { QueryClient } from '@tanstack/react-query'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
})
