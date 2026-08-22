import type { StateCreator } from 'zustand'
import type { Source, AddSourceInput } from '@shared/types/source'
import type { PluginMeta, ConfigField } from '@shared/types/plugin'
import type { DisplayItem, RefreshProgress } from '@shared/types/item'

export interface SourceSlice {
  // Sources
  sources: Source[]
  sourcesLoading: boolean
  loadSources: () => Promise<void>
  addSource: (input: AddSourceInput) => Promise<Source>
  removeSource: (id: string) => Promise<void>
  toggleSource: (id: string) => Promise<void>
  renameSource: (id: string, name: string) => Promise<void>

  // Selected source (null = aggregated view of all sources)
  selectedSourceId: string | null
  selectSource: (sourceId: string | null) => void

  // Plugins
  plugins: PluginMeta[]
  pluginsLoading: boolean
  loadPlugins: () => Promise<void>
  getPluginConfigSchema: (pluginId: string) => Promise<ConfigField[]>
  installPlugin: () => Promise<PluginMeta>
  removePlugin: (pluginId: string) => Promise<void>

  // Timeline
  items: DisplayItem[]
  hasMore: boolean
  hasOlderItems: boolean
  nextCursor: string | null
  timelineLoading: boolean
  loadItems: () => Promise<void>
  loadMoreItems: () => Promise<void>

  // Read/unread
  unreadCount: number
  loadUnreadCount: () => Promise<void>
  markItemAsRead: (itemId: string) => Promise<void>
  markAllAsRead: () => Promise<void>

  // Search
  searchQuery: string
  searchResults: DisplayItem[]
  isSearching: boolean
  search: (query: string) => Promise<void>
  clearSearch: () => void

  // Refresh
  isRefreshing: boolean
  refreshProgress: RefreshProgress[]
  refreshAll: () => Promise<void>
  refreshSource: (sourceId: string) => Promise<void>
  loadOlderItems: (sourceId: string, maxId: string) => Promise<void>
}

export const createSourceSlice: StateCreator<SourceSlice, [], [], SourceSlice> = (set, get) => ({
  sources: [],
  sourcesLoading: false,
  selectedSourceId: null,
  plugins: [],
  pluginsLoading: false,
  items: [],
  hasMore: false,
  hasOlderItems: true,
  nextCursor: null,
  timelineLoading: false,
  isRefreshing: false,
  refreshProgress: [],
  unreadCount: 0,
  searchQuery: '',
  searchResults: [],
  isSearching: false,

  selectSource: (sourceId: string | null) => {
    set({
      selectedSourceId: sourceId,
      items: [],
      hasMore: false,
      hasOlderItems: true,
      nextCursor: null
    })
    get().loadItems()
  },

  loadSources: async () => {
    set({ sourcesLoading: true })
    const sources = await window.api.listSources()
    set({ sources: sources as Source[], sourcesLoading: false })

    // 为微博群聊来源设置图片 Cookie
    for (const source of sources as Source[]) {
      if (source.pluginId === 'feedflow-plugin-weibo-group-chat' && source.config) {
        try {
          const config = typeof source.config === 'string' ? JSON.parse(source.config) : source.config
          if (config.cookie) {
            const subMatch = config.cookie.match(/SUB=([^;]+)/)
            if (subMatch) {
              window.api.setWeiboCookie(subMatch[1])
            }
          }
        } catch { /* ignore */ }
      }
    }
  },

  addSource: async (input: AddSourceInput) => {
    const source = await window.api.addSource(input)
    await get().loadSources()
    return source as Source
  },

  removeSource: async (id: string) => {
    await window.api.removeSource(id)
    // 如果删除的是当前选中的信息源，回到聚合流
    if (get().selectedSourceId === id) {
      set({ selectedSourceId: null })
    }
    await get().loadSources()
  },

  toggleSource: async (id: string) => {
    await window.api.toggleSource(id)
    await get().loadSources()
  },

  renameSource: async (id: string, name: string) => {
    const trimmed = name.trim()
    if (!trimmed) return
    await window.api.updateSource(id, { name: trimmed })
    await get().loadSources()
  },

  loadPlugins: async () => {
    set({ pluginsLoading: true })
    const plugins = await window.api.listPlugins()
    set({ plugins: plugins as PluginMeta[], pluginsLoading: false })
  },

  getPluginConfigSchema: async (pluginId: string) => {
    return (await window.api.getPluginConfigSchema(pluginId)) as ConfigField[]
  },

  installPlugin: async () => {
    const meta = await window.api.installPlugin()
    await get().loadPlugins()
    return meta as PluginMeta
  },

  removePlugin: async (pluginId: string) => {
    await window.api.removePlugin(pluginId)
    await get().loadPlugins()
  },

  loadItems: async () => {
    set({ timelineLoading: true })
    const { selectedSourceId } = get()
    const params = selectedSourceId
      ? { limit: 20, sourceIds: [selectedSourceId] }
      : { limit: 20 }
    const result = (await window.api.listItems(params)) as {
      items: DisplayItem[]
      hasMore: boolean
      nextCursor: string | null
    }
    // Ignore a response for a source that is no longer selected.
    if (get().selectedSourceId !== selectedSourceId) return
    set({
      items: result.items,
      hasMore: result.hasMore,
      nextCursor: result.nextCursor,
      timelineLoading: false
    })
    // 刷新未读计数
    get().loadUnreadCount()
  },

  loadUnreadCount: async () => {
    const { selectedSourceId } = get()
    const sourceIds = selectedSourceId ? [selectedSourceId] : undefined
    const result = (await window.api.getUnreadCount(sourceIds)) as { count: number }
    set({ unreadCount: result.count })
  },

  markItemAsRead: async (itemId: string) => {
    // 乐观更新：先改本地状态，再调用后端
    set((state) => ({
      items: state.items.map((item) =>
        item.id === itemId ? { ...item, read: true } : item
      ),
      unreadCount: Math.max(0, state.unreadCount - 1)
    }))
    await window.api.markItemAsRead(itemId)
  },

  markAllAsRead: async () => {
    const { selectedSourceId } = get()
    const sourceIds = selectedSourceId ? [selectedSourceId] : undefined
    // 乐观更新
    set((state) => ({
      items: state.items.map((item) => ({ ...item, read: true })),
      unreadCount: 0
    }))
    await window.api.markAllAsRead(sourceIds)
  },

  search: async (query: string) => {
    const trimmed = query.trim()
    if (!trimmed) {
      set({ searchQuery: '', searchResults: [], isSearching: false })
      return
    }
    set({ searchQuery: trimmed, isSearching: true })
    try {
      const { selectedSourceId } = get()
      const sourceIds = selectedSourceId ? [selectedSourceId] : undefined
      const result = (await window.api.searchItems(trimmed, sourceIds)) as { items: DisplayItem[] }
      set({ searchResults: result.items, isSearching: false })
    } catch {
      set({ searchResults: [], isSearching: false })
    }
  },

  clearSearch: () => {
    set({ searchQuery: '', searchResults: [], isSearching: false })
  },

  loadMoreItems: async () => {
    const {
      nextCursor, hasMore, hasOlderItems, timelineLoading, isRefreshing,
      items, sources, selectedSourceId
    } = get()
    if (timelineLoading || isRefreshing) return

    // 如果 DB 中还有更多，先从 DB 加载
    if (hasMore) {
      set({ timelineLoading: true })
      const params = selectedSourceId
        ? { limit: 20, cursor: nextCursor, sourceIds: [selectedSourceId] }
        : { limit: 20, cursor: nextCursor }
      const result = (await window.api.listItems(params)) as {
        items: DisplayItem[]
        hasMore: boolean
        nextCursor: string | null
      }
      if (get().selectedSourceId !== selectedSourceId) return
      set((state) => ({
        items: [
          ...state.items,
          ...result.items.filter((item) => !state.items.some((current) => current.id === item.id))
        ],
        hasMore: result.hasMore,
        nextCursor: result.nextCursor,
        timelineLoading: false
      }))
      return
    }

    if (!hasOlderItems) return

    // DB 中没有更多了，尝试从源加载更早的内容
    // 聚合视图下找任意启用的微博源；单源视图下仅当该源是微博或群聊时才加载
    const weiboSource = selectedSourceId
      ? sources.find((s) => s.id === selectedSourceId && s.pluginId === 'feedflow-plugin-weibo' && s.enabled)
      : sources.find((s) => s.pluginId === 'feedflow-plugin-weibo' && s.enabled)
    if (weiboSource && items.length > 0) {
      // 找到最旧的微博条目的 externalId 作为 maxId
      const oldestItem = items[items.length - 1]
      const maxId = oldestItem.externalId
      if (maxId) {
        await get().loadOlderItems(weiboSource.id, maxId)
      }
      return
    }

    // 群聊源：从群聊 API 加载更早的消息
    const groupChatSource = selectedSourceId
      ? sources.find((s) => s.id === selectedSourceId && s.feedType === 'group-chat' && s.enabled)
      : null
    if (groupChatSource && items.length > 0) {
      // items 按 published_at DESC 排列，最后一项是最旧的消息
      const oldestItem = items[items.length - 1]
      const maxId = oldestItem.externalId
      if (maxId) {
        await get().loadOlderItems(groupChatSource.id, maxId)
      }
    }
  },

  refreshAll: async () => {
    set({ isRefreshing: true, refreshProgress: [] })

    // Listen for progress events
    const unsubProgress = window.api.onRefreshProgress((data: unknown) => {
      const progress = data as RefreshProgress
      set((state) => ({
        refreshProgress: [...state.refreshProgress.filter((p) => p.sourceId !== progress.sourceId), progress]
      }))
    })

    const unsubAllComplete = window.api.onRefreshAllComplete(() => {
      set({ isRefreshing: false })
      unsubProgress()
      unsubAllComplete()
      // Reload timeline
      get().loadItems()
    })

    await window.api.refresh()
  },

  refreshSource: async (sourceId: string) => {
    set({ isRefreshing: true, refreshProgress: [] })

    const unsubProgress = window.api.onRefreshProgress((data: unknown) => {
      const progress = data as RefreshProgress
      set((state) => ({
        refreshProgress: [...state.refreshProgress.filter((p) => p.sourceId !== progress.sourceId), progress]
      }))
    })

    const unsubAllComplete = window.api.onRefreshAllComplete(() => {
      set({ isRefreshing: false })
      unsubProgress()
      unsubAllComplete()
      get().loadItems()
    })

    await window.api.refresh([sourceId])
  },

  loadOlderItems: async (sourceId: string, maxId: string) => {
    if (!maxId) return
    set({ isRefreshing: true })

    try {
      const result = await window.api.loadOlderItems(sourceId, maxId) as {
        items: DisplayItem[]
        totalFetched: number
        nextMaxId: string
        hasMore: boolean
      }
      if (get().selectedSourceId !== sourceId) return
      set((state) => {
        const existingIds = new Set(state.items.map((item) => item.id))
        const olderItems = result.items.filter((item) => !existingIds.has(item.id))
        return {
          items: [...state.items, ...olderItems].sort(
            (a, b) => b.publishedAt.localeCompare(a.publishedAt)
          ),
          hasOlderItems: result.hasMore
        }
      })
    } finally {
      set({ isRefreshing: false })
    }
  }
})
